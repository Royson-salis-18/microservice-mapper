"""Step 1: is this service behaving abnormally right now?

Idea: every service is compared with ITS OWN recent past, not with a fixed limit.
A database that always uses 60% CPU is fine at 60%; a web server that normally uses 2% is not.

For one series of numbers (say CPU every 5 seconds):
  1. baseline  = the older samples (never the ones being judged)
  2. centre    = median of the baseline
  3. spread    = median absolute deviation (MAD) of the baseline, scaled to a standard deviation
  4. score     = how many spreads the newest sample is away from the centre, only in the bad direction
  5. the score only counts if the last TWO samples are both abnormal (one odd sample is noise)
"""
import math

import settings as cfg


def median(values):
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def quantile(values, q):
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(q * (len(s) - 1))))]


def centre_and_spread(values, floor, use_tail=True):
    """Median and a robust spread. `floor` stops the spread from collapsing on a perfectly flat series."""
    centre = median(values)
    deviations = [abs(v - centre) for v in values]
    spread = median(deviations) * cfg.MAD_TO_STD
    if use_tail:
        # a series with heavy tails: also respect its 90% deviation (1.645 = the 90% point of a bell curve)
        spread = max(spread, quantile(deviations, 0.9) / 1.645)
    return centre, max(spread, floor)


def abnormal_scores(baseline, recent, bad_direction=1, use_log=True, unit=1.0, floor=0.15):
    """Score each recent sample. 0 = normal, bigger = more abnormal. Returns None if the history is too short.

    bad_direction: +1 when a rise is bad (CPU, latency, errors), -1 when a drop is bad (request rate).
    use_log:       compare as ratios, so 100 ms -> 200 ms counts the same as 1 s -> 2 s.
    """
    to_scale = (lambda v: math.log(max(v, 0) + unit)) if use_log else (lambda v: v)
    base = [to_scale(v) for v in baseline if v is not None]
    if len(base) < cfg.MIN_HISTORY or not recent:
        return None

    # self-healing: drop old stretches that were already abnormal, so a long fault never becomes "normal"
    centre, spread = centre_and_spread(base, floor, use_tail=False)
    hot = [bad_direction * (v - centre) / spread >= cfg.SELF_HEAL_Z for v in base]
    in_run = [hot[i] and ((i > 0 and hot[i - 1]) or (i + 1 < len(hot) and hot[i + 1])) for i in range(len(base))]
    kept = [v for v, bad in zip(base, in_run) if not bad]
    if len(kept) >= cfg.MIN_HISTORY:
        base = kept
    centre, spread = centre_and_spread(base, floor)

    # noise control: a series that is jumpy even when healthy is turned down so it does not cry wolf
    healthy = [max(0.0, bad_direction * (v - centre) / spread) for v in base]
    shrink = max(1.0, quantile(healthy, cfg.HEALTHY_QUANTILE) / cfg.HEALTHY_Z)

    scores = []
    for v in recent:
        if v is None:
            scores.append(float("nan"))      # a missing reading is unknown, never zero
        else:
            z = max(0.0, bad_direction * (to_scale(v) - centre) / spread) / shrink
            scores.append(min(cfg.Z_CAP, z))
    return scores


# What we watch per service. kind = "own" (about the service itself) or "symptom" (can be inherited from a dependency).
METRICS = {
    "cpu":          dict(bad_direction=+1, use_log=True,  unit=0.5, floor=0.15, kind="own"),
    "memory":       dict(bad_direction=+1, use_log=True,  unit=1.0, floor=0.15, kind="own"),
    "latency":      dict(bad_direction=+1, use_log=True,  unit=1.0, floor=0.15, kind="symptom"),
    "error_rate":   dict(bad_direction=+1, use_log=False, unit=0.0, floor=0.02, kind="symptom"),
    "request_rate": dict(bad_direction=-1, use_log=True,  unit=0.1, floor=0.15, kind="symptom"),
}


def severity(score):
    if score >= cfg.Z_CRITICAL:
        return "CRITICAL"
    if score >= cfg.Z_HIGH:
        return "HIGH"
    return "MEDIUM"


def detect_service(history):
    """history: {metric_name: [oldest ... newest]}. Returns a list of findings for one service."""
    findings = []
    for name, spec in METRICS.items():
        series = history.get(name)
        if not series or len(series) < cfg.MIN_HISTORY + cfg.JUDGED:
            continue                                   # cold start: say nothing rather than guess
        if name in ("latency", "error_rate") and any(
                r is not None and r < cfg.MIN_REQUESTS for r in history.get("request_count", [])[-cfg.JUDGED:]):
            continue                                   # too few requests for a percentile or a share
        baseline, recent = series[:-cfg.JUDGED], series[-cfg.JUDGED:]
        options = {k: v for k, v in spec.items() if k != "kind"}
        scores = abnormal_scores(baseline, recent, **options)
        if scores is None:
            continue
        if any(math.isnan(z) or z < cfg.Z_ALARM for z in scores):
            continue                                   # persistence: both newest samples must agree
        findings.append({"metric": name, "score": round(scores[-1], 2), "kind": spec["kind"],
                         "severity": severity(scores[-1])})
    return findings


def went_silent(request_rates, quiet_samples=3):
    """A service that normally gets traffic and suddenly gets none at all is frozen or dead."""
    known = [r for r in request_rates if r is not None]
    if len(known) < 3 * cfg.MIN_HISTORY or any(r != 0 for r in known[-quiet_samples:]):
        return False
    usual = median(known[:-quiet_samples])
    return usual * quiet_samples * 5 >= 5      # expecting at least 5 requests in the quiet stretch (5 s samples)
