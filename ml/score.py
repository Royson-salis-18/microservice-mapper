#!/usr/bin/env python3
"""
Live anomaly scoring loop. For each service with trained models:
  1. Pull its latest sample from the Node app's API.
  2. Normalize it using the SAME per-service mean/std saved at training time
     (never recomputed from live data - that would silently drift the
     definition of "normal" every cycle).
  3. Score it with every detector trained for that service - Isolation
     Forest, LOF, one-class SVM and z-score - and combine them by vote
     (see ensemble.py). This used to use the Isolation Forest alone; the
     other three were trained and then never consulted.
  4. Track consecutive windows the ensemble calls anomalous; only declare a
     persistent anomaly after PERSISTENCE_WINDOWS in a row, so a single
     noisy sample doesn't fire an alert.

Writes data/latest_scores.json every cycle:
  { "<service_id>": {
      "anomaly_score": 0..1  (median across detectors; ~0.5 = at threshold),
      "above_threshold": bool (at least half the usable detectors agree),
      "votes": int, "detectors_used": int,
      "detectors": { "<name>": {score, raw, threshold, above}, ... },
      "consecutive_windows": int, "persistent": bool,
      "scored_at": iso timestamp
  }, ... }

Node reads this file directly - no second HTTP server to run/coordinate.
A service with no model yet (not enough training data) is simply absent
from the output, not defaulted to a fake score.
"""

import csv
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import joblib
import numpy as np

from mlconfig import load_config
from ensemble import detector_score, combine

MAPPER_URL = os.environ.get("MAPPER_URL", "http://localhost:3001")

# How each detector turns a feature vector into "higher = more anomalous",
# matching train.py exactly. The z-score detector is computed directly: it
# is max|z| and nothing more, and its pickled object was saved from
# train.py running as __main__, so it cannot be unpickled anywhere else.
SCORERS = {
    "iforest": lambda m, X: -m.decision_function(X),
    "lof": lambda m, X: -m.score_samples(X),
    "ocsvm": lambda m, X: -m.decision_function(X),
    "zscore": lambda _m, X: np.max(np.abs(np.asarray(X, dtype=float)), axis=1),
}
ARTIFACT_SUFFIX = {"iforest": "", "lof": ".lof", "ocsvm": ".ocsvm"}

BASE_DIR = os.path.dirname(__file__)
MODELS_DIR = os.path.join(BASE_DIR, "models")
STATS_PATH = os.path.join(BASE_DIR, "data", "normalization_stats.json")
OUT_PATH = os.path.join(BASE_DIR, "data", "latest_scores.json")
SUMMARY_PATH = os.path.join(BASE_DIR, "data", "scoring_summary.json")
HISTORY_PATH = os.path.join(BASE_DIR, "data", "score_history.csv")
HISTORY_MAX_ROWS = 50_000  # trimmed, not left to grow forever

FEATURE_RAW_COLUMNS = ["cpu_percent", "memory_percent", "network_rx_rate", "network_tx_rate"]


def load_models():
    """Every usable detector per service, with the statistics to score it.

    A detector is included only if its metadata says it trained successfully
    and (except for z-score) its artifact is on disk. One that train.py
    refused - LOF on data with too few distinct rows, for instance - is left
    out rather than scored with a stale artifact.
    """
    models = {}
    if not os.path.isdir(MODELS_DIR):
        return models
    for fname in os.listdir(MODELS_DIR):
        if not fname.endswith(".meta.json"):
            continue
        with open(os.path.join(MODELS_DIR, fname)) as f:
            meta = json.load(f)
        safe_name = fname[: -len(".meta.json")]

        algos = meta.get("algorithms")
        if not isinstance(algos, dict):
            # Metadata from before per-detector training: Isolation Forest only.
            algos = {"iforest": {
                "threshold_p99": meta.get("threshold_p99"),
                "train_score_mean": meta.get("train_score_mean"),
            }}

        detectors = {}
        for name, stats in algos.items():
            if name not in SCORERS or not isinstance(stats, dict) or stats.get("error"):
                continue
            model = None
            if name in ARTIFACT_SUFFIX:
                path = os.path.join(MODELS_DIR, f"{safe_name}{ARTIFACT_SUFFIX[name]}.joblib")
                if not os.path.exists(path):
                    continue
                try:
                    model = joblib.load(path)
                except Exception as e:
                    print(f"[score] could not load {name} for {meta['service_id']}: {e}", file=sys.stderr, flush=True)
                    continue
            detectors[name] = {"model": model, "stats": stats}

        if detectors:
            models[meta["service_id"]] = {"detectors": detectors, "meta": meta}
    return models


def fetch_graph():
    with urllib.request.urlopen(f"{MAPPER_URL}/api/graph", timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def append_history(results: dict):
    """Append-only log of every score, for the UI to chart trends over time.
    Trimmed to the last HISTORY_MAX_ROWS when it grows past ~2x that, so it
    doesn't grow forever, but trimming isn't attempted every single cycle."""
    is_new = not os.path.exists(HISTORY_PATH)
    with open(HISTORY_PATH, "a", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["timestamp", "service_id", "anomaly_score", "above_threshold", "persistent"])
        for sid, r in results.items():
            writer.writerow([r["scored_at"], sid, r["anomaly_score"], r["above_threshold"], r["persistent"]])

    if is_new:
        return
    try:
        if os.path.getsize(HISTORY_PATH) > 8_000_000:  # ~8MB, well past HISTORY_MAX_ROWS worth of short rows
            with open(HISTORY_PATH) as f:
                lines = f.readlines()
            if len(lines) > HISTORY_MAX_ROWS + 1:
                header, rows = lines[0], lines[1:]
                trimmed = [header] + rows[-HISTORY_MAX_ROWS:]
                tmp = HISTORY_PATH + ".tmp"
                with open(tmp, "w") as f:
                    f.writelines(trimmed)
                os.replace(tmp, HISTORY_PATH)
    except Exception as e:
        print(f"[score] history trim failed (non-fatal): {e}", file=sys.stderr, flush=True)


def main():
    if not os.path.exists(STATS_PATH):
        print(f"[score] no normalization stats at {STATS_PATH} - run preprocess.py + train.py first", file=sys.stderr)
        sys.exit(1)

    with open(STATS_PATH) as f:
        stats = json.load(f)

    models = load_models()
    if not models:
        print(f"[score] no trained models in {MODELS_DIR} - run train.py first", file=sys.stderr)
        sys.exit(1)

    cfg = load_config()
    print(f"[score] loaded {len(models)} models, scoring every {cfg['score_interval_sec']}s, persistence={cfg['persistence_windows']}", flush=True)
    started_at = datetime.now(timezone.utc).isoformat()

    # prev cumulative network counters, to compute the same rate features
    # used in training (mirrors preprocess.py's diff logic, per service)
    prev_network = {}
    consecutive_above = {sid: 0 for sid in models}

    while True:
        cfg = load_config()  # re-read each cycle so a UI tweak (e.g. persistence window) applies live
        score_interval_sec = cfg["score_interval_sec"]
        persistence_windows = cfg["persistence_windows"]
        cycle_start = time.time()
        try:
            graph = fetch_graph()
            nodes_by_id = {n["id"]: n for n in graph.get("nodes", [])}
        except Exception as e:
            print(f"[score] fetch failed: {e}", file=sys.stderr, flush=True)
            time.sleep(score_interval_sec)
            continue

        now_ts = time.time()
        results = {}

        for service_id, entry in models.items():
            node = nodes_by_id.get(service_id)
            if not node or not node.get("metrics"):
                continue

            m = node["metrics"]
            rx, tx = m.get("networkRx"), m.get("networkTx")
            prev = prev_network.get(service_id)
            prev_network[service_id] = (now_ts, rx, tx)

            if prev is None or rx is None or tx is None:
                continue  # need a prior sample to compute a rate
            prev_ts, prev_rx, prev_tx = prev
            dt = now_ts - prev_ts
            if dt <= 0:
                continue
            rx_delta, tx_delta = rx - prev_rx, tx - prev_tx
            rx_rate = 0.0 if rx_delta < 0 else rx_delta / dt  # restart -> 0, not a fake spike
            tx_rate = 0.0 if tx_delta < 0 else tx_delta / dt

            raw = {
                "cpu_percent": m.get("cpu"),
                "memory_percent": m.get("memoryPercent"),
                "network_rx_rate": rx_rate,
                "network_tx_rate": tx_rate,
            }
            if any(v is None for v in raw.values()):
                continue

            service_stats = stats.get(service_id)
            if not service_stats:
                continue

            meta = entry["meta"]

            # Follow this model's own recorded feature list and order -
            # training can be configured to use a subset, and scoring a
            # model with a different vector than it was fitted on would be
            # silently wrong rather than an error.
            z = []
            skip = False
            for z_col in meta["feature_columns"]:
                col = z_col[2:] if z_col.startswith("z_") else z_col
                col_stats = service_stats.get(col)
                if col not in raw or not col_stats or col_stats["std"] <= 0:
                    skip = True
                    break
                z.append((raw[col] - col_stats["mean"]) / col_stats["std"])
            if skip:
                continue
            X = np.array([z])

            per_detector = {}
            for name, det in entry["detectors"].items():
                try:
                    raw_val = float(SCORERS[name](det["model"], X)[0])
                except Exception as e:
                    print(f"[score] {name} failed for {service_id}: {e}", file=sys.stderr, flush=True)
                    per_detector[name] = None
                    continue
                per_detector[name] = detector_score(raw_val, det["stats"])

            verdict = combine(per_detector)
            if verdict is None:
                continue  # no usable detector for this service - absent, not a fake score

            above = verdict["above"]
            consecutive_above[service_id] = consecutive_above.get(service_id, 0) + 1 if above else 0
            persistent = consecutive_above[service_id] >= persistence_windows

            # raw_score/threshold kept for the existing UI: the Isolation
            # Forest's when available, else the first usable detector's.
            usable = {k: v for k, v in per_detector.items() if v is not None}
            primary = usable.get("iforest") or next(iter(usable.values()))

            results[service_id] = {
                "anomaly_score": round(verdict["score"], 4),
                "raw_score": round(primary["raw"], 4),
                "threshold": round(primary["threshold"], 4),
                "above_threshold": above,
                "votes": verdict["votes"],
                "votes_needed": verdict["votes_needed"],
                "detectors_used": verdict["detectors_used"],
                "detectors": {
                    k: {"score": round(v["score"], 4), "raw": round(v["raw"], 4), "threshold": round(v["threshold"], 4), "above": v["above"]}
                    for k, v in usable.items()
                },
                "consecutive_windows": consecutive_above[service_id],
                "persistent": persistent,
                "scored_at": datetime.now(timezone.utc).isoformat(),
            }

        with open(OUT_PATH, "w") as f:
            json.dump(results, f, indent=2)
        if results:
            append_history(results)

        persistent_now = [sid for sid, r in results.items() if r["persistent"]]
        summary = {
            "started_at": started_at,
            "last_cycle_at": datetime.now(timezone.utc).isoformat(),
            "models_loaded": len(models),
            "services_scored_this_cycle": len(results),
            "persistence_windows_required": persistence_windows,
            "score_interval_sec": score_interval_sec,
            "persistent_anomalies_now": persistent_now,
        }
        tmp = SUMMARY_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(summary, f, indent=2)
        os.replace(tmp, SUMMARY_PATH)

        elapsed = time.time() - cycle_start
        print(f"[score] scored {len(results)}/{len(models)} services in {elapsed:.2f}s", flush=True)
        time.sleep(max(0.0, score_interval_sec - elapsed))


if __name__ == "__main__":
    main()
