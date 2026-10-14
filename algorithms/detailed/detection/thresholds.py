"""Incident thresholds: the fixed numbers that decide what counts as an incident.

Question answered: "how far must a metric move before we raise an alarm, and how
bad is it?"  Also: "how do we safely let a user edit those numbers?"

Mirrors: server/algorithms/detection/thresholds.ts

Idea: the rules are plain numbers kept in one dictionary (DEFAULT_THRESHOLDS), so
nobody has to edit source code to tune them. A user can send overrides, and
merge_thresholds() applies them, but every value is clamped to a safe range, and
anything that is not a real number is ignored (the old value stays). That last
part matters: a bad edit like null must never become "most sensitive setting",
because that would turn a typo into an alert storm.

Names are snake_case here (z_score_anomaly) instead of camelCase (zScoreAnomaly).

Left out: reading/writing the overrides JSON file (thresholdsStore.ts) and the
THRESHOLD_DOCS text shown in the UI (the comments below say the same thing).
"""
import math

DEFAULT_THRESHOLDS = {
    "min_history_samples": 12,        # samples needed before a service is judged at all (cold start guard)
    "z_score_anomaly": 3.5,           # |z| at or above = anomaly (healthy series peak around 3, so alarm above that)
    "z_score_high": 5.0,              # z at or above = HIGH
    "z_score_critical": 8.0,          # z at or above = CRITICAL
    "min_delta_percent": 5,           # z only counts if the metric also moved this many points from baseline
    "absolute_high_percent": 70,      # cpu/memory above this is HIGH whatever the baseline says
    "absolute_critical_percent": 85,  # cpu/memory above this is CRITICAL whatever the baseline says
    "flatline_std_dev": 0.001,        # baseline spread below this = flat, z would divide by ~0
    "flatline_delta_percent": 30,     # on a flat baseline a jump of this many points is the anomaly
    "flatline_critical_percent": 80,  # ...and CRITICAL if the value itself is above this
    "critical_services_for_critical": 2,  # critical services needed for a CRITICAL incident (used by the incident layer)
    "silence_samples": 3,             # quiet samples in a row before a usually-active service counts as frozen
    "monitoring_gap_share": 0.8,      # this share of services vanishing together = monitoring outage, not N faults
    "explain_away_gamma": 1.0,        # how much a broken dependency explains its callers' symptoms (0 = ignore graph)
    "cascade_edge_probability": 0.5,  # assumed chance a failure crosses one call edge (a ranking weight)
}

# (low, high) allowed for each value, so an edited number cannot produce nonsense.
LIMITS = {
    "min_history_samples": (2, 1000),
    "z_score_anomaly": (0.5, 10),
    "z_score_high": (0.5, 15),
    "z_score_critical": (0.5, 20),
    "min_delta_percent": (0, 100),
    "absolute_high_percent": (1, 100),
    "absolute_critical_percent": (1, 100),
    "flatline_std_dev": (0.0000001, 10),
    "flatline_delta_percent": (1, 100),
    "flatline_critical_percent": (1, 100),
    "critical_services_for_critical": (1, 1000),
    "silence_samples": (2, 60),
    "monitoring_gap_share": (0.3, 1),
    "explain_away_gamma": (0, 2),
    "cascade_edge_probability": (0.05, 1),
}


def to_number(value):
    """Return value as a float if it is genuinely numeric, else None.

    Plain float(None) fails and bool is a subclass of int in Python, so we check
    types by hand. Numeric strings like "4.5" are accepted, "" and "abc" are not.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str) and value.strip() != "":
        try:
            n = float(value)
        except ValueError:
            return None
        return n if math.isfinite(n) else None
    return None


def merge_thresholds(base, patch):
    """Apply overrides to `base`, clamped to LIMITS. Bad or missing entries are ignored.

    Returns a new dict; `base` is not modified. A malformed override must never
    stop incident detection, so nothing here raises.
    """
    merged = dict(base)
    if not isinstance(patch, dict):
        return merged
    for key in DEFAULT_THRESHOLDS:
        value = to_number(patch.get(key))
        if value is None:
            continue                      # not a number: keep the previous value
        low, high = LIMITS[key]
        merged[key] = min(max(value, low), high)
    return merged


if __name__ == "__main__":
    edited = merge_thresholds(DEFAULT_THRESHOLDS, {
        "z_score_anomaly": "4.2",    # numeric string: accepted
        "z_score_high": 999,         # too big: clamped to 15
        "silence_samples": None,     # null: ignored, stays 3
        "min_delta_percent": True,   # bool is not a number: ignored
    })
    for key in ("z_score_anomaly", "z_score_high", "silence_samples", "min_delta_percent"):
        print(f"{key:20} default={DEFAULT_THRESHOLDS[key]!s:6} edited={edited[key]}")
