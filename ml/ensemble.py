"""
Scoring a sample against all four trained detectors, and combining them.

Two problems this replaces, both in the old live scorer:

1. Only the Isolation Forest was ever used. LOF, the one-class SVM and the
   z-score detector were trained, saved to models/, and never consulted - so
   the "four detectors" existed only in training reports.

2. The score was raw / threshold, clamped to 0..1. For an Isolation Forest
   (and the one-class SVM) the threshold is ~0 *by construction*: the decision
   function is offset so that exactly the contamination fraction (1%) of
   training points score above 0, which makes the 99th percentile ~0. All 24
   trained models had |threshold| < 0.001. With threshold <= 0 the score was
   forced to 0 for every sample, while `above_threshold` (raw >= -0.0) could
   still be true - contradictory output, and a displayed anomaly score of 0
   for every service. With a threshold a hair above 0, dividing by it made
   the slightest deviation read as 1.0.

Each detector is now scored by where the sample sits relative to that
detector's own training distribution: its distance from the training mean,
in units of the distance from that mean to the p99 threshold.

    r = (raw - mean) / (threshold - mean)
    score = clamp(r / 2, 0, 1)      typical -> 0, at threshold -> 0.5,
                                     twice as far out -> 1.0

That is well defined whatever the detector's sign or scale, needs only
statistics train.py already saved, and makes the four detectors comparable
so they can be combined.

The combination is a vote: a sample counts as anomalous when at least half of
the usable detectors say so, and its score is the median of theirs. Detectors
from different families only carry information when they could disagree, and
the median keeps one misbehaving detector from dragging the score around.
"""

import math

# Below this, threshold and mean are effectively the same point: the
# training data had no spread for this detector to measure against, so
# scoring against it would be dividing by noise.
MIN_SCALE = 1e-9


def detector_score(raw, stats):
    """Score one detector's raw output against its training statistics.

    `stats` needs `threshold_p99` and a centre: `train_score_median` when the
    model was trained recently enough to record it, else `train_score_mean`.
    The median is preferred because these distributions are heavily skewed -
    a one-class SVM had its mean pulled past its own p99 by a few extreme
    training scores, which leaves nothing sensible to measure against.

    Returns None when the detector cannot be used - missing statistics, or a
    degenerate distribution - rather than inventing a score.
    """
    if raw is None or stats is None:
        return None
    thr = stats.get("threshold_p99")
    mean = stats.get("train_score_median", stats.get("train_score_mean"))
    if thr is None or mean is None:
        return None
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (raw, thr, mean)):
        return None
    scale = thr - mean
    if scale <= MIN_SCALE:
        return None
    r = (raw - mean) / scale
    return {
        "score": max(0.0, min(1.0, r / 2.0)),
        "raw": raw,
        "threshold": thr,
        "above": raw >= thr,
    }


def combine(per_detector):
    """Combine usable detector results into one verdict.

    `per_detector` maps detector name -> result of detector_score() or None.
    Returns None when no detector was usable.
    """
    usable = {name: r for name, r in per_detector.items() if r is not None}
    if not usable:
        return None
    scores = sorted(r["score"] for r in usable.values())
    n = len(scores)
    median = scores[n // 2] if n % 2 else (scores[n // 2 - 1] + scores[n // 2]) / 2
    votes = sum(1 for r in usable.values() if r["above"])
    needed = math.ceil(n / 2)
    return {
        "score": median,
        "votes": votes,
        "detectors_used": n,
        "votes_needed": needed,
        "above": votes >= needed,
    }
