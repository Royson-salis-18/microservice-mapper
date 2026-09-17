#!/usr/bin/env python3
"""
Trains one Isolation Forest per service on that service's own normalized
features, on the assumption that most of the collected window is normal
behavior and true anomalies are rare (contamination is set explicitly, not
'auto', so it's reproducible and reportable).

This is unsupervised: there's no "normal" label to filter on, so if you ran
stress/failure experiments while the collector was running, that traffic is
mixed into the training data and will teach the model that stress looks
normal. Best practice, and what --since is for: point training at a time
range you know was baseline-only.

Persists, per service:
  models/<service_id>.joblib        the fitted IsolationForest
  models/<service_id>.meta.json     feature column order + threshold (99th
                                     percentile of this service's own
                                     training scores) — both required to
                                     score new data consistently later.
"""

import argparse
import json
import os
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from mlconfig import ALL_FEATURE_COLUMNS, load_config

FEATURES_PATH = os.path.join(os.path.dirname(__file__), "data", "features.csv")
MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

_cfg = load_config()
MIN_TRAINING_SAMPLES = _cfg["min_training_samples"]
CONTAMINATION = _cfg["contamination"]  # explicit, not 'auto' — must be reproducible for the paper
FEATURE_COLUMNS = [c for c in _cfg["feature_columns"] if c in ALL_FEATURE_COLUMNS] or list(ALL_FEATURE_COLUMNS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", help="ISO timestamp; only train on rows at or after this time (use to exclude known stress/failure windows)")
    parser.add_argument("--until", help="ISO timestamp; only train on rows at or before this time")
    parser.add_argument("--contamination", type=float, default=CONTAMINATION)
    parser.add_argument("--min-samples", type=int, default=MIN_TRAINING_SAMPLES)
    args = parser.parse_args()
    min_training_samples = args.min_samples
    n_estimators = int(_cfg["n_estimators"])
    max_samples_fraction = float(_cfg["max_samples_fraction"])
    holdout_fraction = float(_cfg["holdout_fraction"])

    if not os.path.exists(FEATURES_PATH):
        print(f"[train] no features at {FEATURES_PATH} — run preprocess.py first", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(FEATURES_PATH, parse_dates=["timestamp"])
    if args.since:
        since = pd.Timestamp(args.since, tz="UTC")
        df = df[df["timestamp"] >= since]
    if args.until:
        until = pd.Timestamp(args.until, tz="UTC")
        df = df[df["timestamp"] <= until]

    os.makedirs(MODELS_DIR, exist_ok=True)

    trained, skipped = [], []

    for service_id, group in df.groupby("service_id"):
        clean = group.dropna(subset=FEATURE_COLUMNS).sort_values("timestamp")
        if len(clean) < min_training_samples:
            skipped.append((service_id, len(clean)))
            continue

        # Chronological (not random) split: the tail is held out so the
        # evaluation answers "how does this model behave on data collected
        # after it was fitted", which is how it's actually used at scoring
        # time. A random split would leak adjacent samples across the
        # boundary and make the number look better than it is.
        n_holdout = int(len(clean) * holdout_fraction)
        if n_holdout < 1 or len(clean) - n_holdout < min_training_samples:
            n_holdout = 0  # not enough data to spare; train on everything
        fit_rows = clean.iloc[: len(clean) - n_holdout] if n_holdout else clean
        holdout_rows = clean.iloc[len(clean) - n_holdout :] if n_holdout else None

        X = fit_rows[FEATURE_COLUMNS].to_numpy()
        max_samples = "auto" if max_samples_fraction >= 1.0 else max(1, int(len(X) * max_samples_fraction))
        model = IsolationForest(
            n_estimators=n_estimators,
            max_samples=max_samples,
            contamination=args.contamination,
            random_state=42,
        )
        model.fit(X)

        # map decision_function (higher = more normal) to a 0..1 anomaly
        # score (higher = more anomalous) so the UI/threshold logic is
        # intuitive; derive the alert threshold from this training set's
        # own 99th percentile rather than hard-coding a guess
        raw_scores = -model.decision_function(X)
        threshold_99 = float(np.percentile(raw_scores, 99))

        holdout_eval = None
        if holdout_rows is not None and len(holdout_rows) > 0:
            holdout_scores = -model.decision_function(holdout_rows[FEATURE_COLUMNS].to_numpy())
            holdout_eval = {
                "samples": int(len(holdout_rows)),
                # Unlabelled data, so this is a firing rate, not accuracy.
                "flag_rate": float(np.mean(holdout_scores >= threshold_99)),
                "mean_score": float(np.mean(holdout_scores)),
                "max_score": float(np.max(holdout_scores)),
                "from": holdout_rows["timestamp"].iloc[0].isoformat(),
                "to": holdout_rows["timestamp"].iloc[-1].isoformat(),
            }

        safe_name = service_id.replace("/", "_").replace(":", "_")
        joblib.dump(model, os.path.join(MODELS_DIR, f"{safe_name}.joblib"))
        with open(os.path.join(MODELS_DIR, f"{safe_name}.meta.json"), "w") as f:
            json.dump({
                "service_id": service_id,
                "feature_columns": FEATURE_COLUMNS,
                "trained_on_samples": int(len(fit_rows)),
                "trained_at": pd.Timestamp.now('UTC').isoformat(),
                "contamination": args.contamination,
                "n_estimators": n_estimators,
                "max_samples": max_samples,
                "threshold_p99": threshold_99,
                "train_score_mean": float(np.mean(raw_scores)),
                "train_score_max": float(np.max(raw_scores)),
                "holdout": holdout_eval,
                "training_window": {
                    "since": args.since,
                    "until": args.until,
                },
            }, f, indent=2)

        trained.append((service_id, int(len(fit_rows)), threshold_99, holdout_eval))

    print(f"[train] trained {len(trained)} models on features: {', '.join(FEATURE_COLUMNS)}")
    print(f"[train] n_estimators={n_estimators} max_samples_fraction={max_samples_fraction} holdout_fraction={holdout_fraction}")
    for sid, n, thr, hold in trained:
        extra = f", holdout {hold['samples']} rows flagged {hold['flag_rate'] * 100:.1f}%" if hold else ", no holdout (too few rows)"
        print(f"  {sid}: {n} samples, threshold_p99={thr:.4f}{extra}")

    if skipped:
        print(f"[train] skipped {len(skipped)} services with < {min_training_samples} samples:")
        for sid, n in skipped:
            print(f"  {sid}: {n} samples")

    summary = {
        "generated_at": pd.Timestamp.now('UTC').isoformat(),
        "min_training_samples": min_training_samples,
        "contamination": args.contamination,
        "n_estimators": n_estimators,
        "max_samples_fraction": max_samples_fraction,
        "holdout_fraction": holdout_fraction,
        "feature_columns": FEATURE_COLUMNS,
        "training_window": {"since": args.since, "until": args.until},
        "trained": {
            sid: {"samples": n, "threshold_p99": thr, "holdout": hold}
            for sid, n, thr, hold in trained
        },
        "skipped": {sid: {"samples": n} for sid, n in skipped},
    }
    with open(os.path.join(MODELS_DIR, "training_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    if not trained:
        print("[train] nothing trained — need more data or a wider --since/--until window", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
