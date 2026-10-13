"""
Tests for ensemble.py, and a check of the live scorer against the real
trained models and real feature rows.

Run: python3 ml/test_ensemble.py
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from ensemble import detector_score, combine  # noqa: E402


def test_centre_and_threshold_map_to_0_and_half():
    stats = {"threshold_p99": 1.0, "train_score_mean": 0.0}
    assert detector_score(0.0, stats)["score"] == 0.0
    assert detector_score(1.0, stats)["score"] == 0.5
    assert detector_score(2.0, stats)["score"] == 1.0
    assert detector_score(1.0, stats)["above"] is True
    assert detector_score(0.9, stats)["above"] is False


def test_isolation_forest_threshold_near_zero_still_scores():
    # The case that made every live score 0: threshold ~0, mean negative.
    stats = {"threshold_p99": -1.35e-16, "train_score_mean": -0.3747}
    typical = detector_score(-0.37, stats)
    outlier = detector_score(0.10, stats)
    assert typical["score"] < 0.05
    assert outlier["score"] > 0.5 and outlier["above"]


def test_median_is_preferred_over_a_skewed_mean():
    # One-class SVM where extreme training scores pulled the mean past p99.
    skewed = {"threshold_p99": 0.000397, "train_score_mean": 0.000428}
    assert detector_score(0.0002, skewed) is None  # unusable on the mean alone
    with_median = dict(skewed, train_score_median=0.0001)
    assert detector_score(0.0002, with_median) is not None


def test_degenerate_or_missing_stats_are_refused_not_guessed():
    assert detector_score(1.0, {"threshold_p99": 0.5, "train_score_mean": 0.5}) is None
    assert detector_score(1.0, {"threshold_p99": 0.5}) is None
    assert detector_score(None, {"threshold_p99": 1, "train_score_mean": 0}) is None
    assert detector_score(float("nan"), {"threshold_p99": 1, "train_score_mean": 0}) is None


def test_combination_needs_at_least_half_and_uses_the_median():
    a = lambda s, above: {"score": s, "raw": 0, "threshold": 0, "above": above}
    # One detector of four firing is noise, not a verdict.
    v = combine({"iforest": a(0.9, True), "lof": a(0.1, False), "ocsvm": a(0.1, False), "zscore": a(0.2, False)})
    assert v["votes"] == 1 and v["above"] is False
    # Two of four is half.
    v = combine({"iforest": a(0.9, True), "lof": a(0.8, True), "ocsvm": a(0.1, False), "zscore": a(0.2, False)})
    assert v["above"] is True
    assert abs(v["score"] - 0.5) < 1e-9  # median of 0.1, 0.2, 0.8, 0.9
    # Unusable detectors are left out of the count, not counted as "no".
    v = combine({"iforest": a(0.9, True), "lof": None, "ocsvm": None, "zscore": a(0.8, True)})
    assert v["detectors_used"] == 2 and v["above"] is True
    assert combine({"iforest": None}) is None


def check_against_real_models():
    """Score real feature rows with the real models through score.py's own
    loader and scorers. Skipped when models or data are absent."""
    import pandas as pd
    import score as live

    models = live.load_models()
    feats_path = os.path.join(os.path.dirname(__file__), "data", "features.csv")
    if not models or not os.path.exists(feats_path):
        print("  (skipped: no trained models or features.csv)")
        return

    df = pd.read_csv(feats_path)
    used_counts = {}
    rows = []
    for service_id, entry in sorted(models.items()):
        cols = entry["meta"]["feature_columns"]
        sdf = df[df["service_id"] == service_id].tail(300)
        if sdf.empty or not all(c in sdf.columns for c in cols):
            continue
        X = sdf[cols].to_numpy(dtype=float)
        verdicts = []
        for x in X:
            per = {}
            for name, det in entry["detectors"].items():
                raw = float(live.SCORERS[name](det["model"], np.array([x]))[0])
                per[name] = detector_score(raw, det["stats"])
            verdicts.append(combine(per))
        verdicts = [v for v in verdicts if v]
        if not verdicts:
            continue
        used = verdicts[0]["detectors_used"]
        used_counts[used] = used_counts.get(used, 0) + 1

        # An obviously abnormal sample: every feature 12 standard deviations out.
        extreme = {}
        for name, det in entry["detectors"].items():
            raw = float(live.SCORERS[name](det["model"], np.array([[12.0] * len(cols)]))[0])
            extreme[name] = detector_score(raw, det["stats"])
        ex = combine(extreme)

        rows.append((service_id, used, np.mean([v["above"] for v in verdicts]),
                     np.median([v["score"] for v in verdicts]), ex["score"] if ex else None, ex["above"] if ex else None))

    print(f"  {'service':<34}{'dets':>5}{'flag%':>8}{'med score':>11}{'extreme':>9}")
    for sid, used, rate, med, ex_s, ex_a in rows:
        print(f"  {sid:<34}{used:>5}{rate*100:>7.1f}%{med:>11.3f}{(ex_s if ex_s is not None else float('nan')):>9.2f} {'FLAGGED' if ex_a else 'missed'}")
    flagged_extreme = sum(1 for r in rows if r[5])
    print(f"  detectors usable per service: {used_counts}")
    print(f"  extreme sample flagged on {flagged_extreme}/{len(rows)} services")
    assert rows, "expected at least one scored service"
    assert flagged_extreme == len(rows), "an obvious 12-sigma outlier must be flagged everywhere"
    assert np.median([r[2] for r in rows]) < 0.10, "normal rows should rarely be flagged"


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok   {t.__name__}")
    print("real models:")
    check_against_real_models()
    print(f"\n{len(tests)} unit tests passed; real-model check passed")
