"""Anomaly detector: is this service behaving abnormally right now?

Question answered: "compared with its OWN recent past, is any metric of this
service far enough off, for two samples in a row, to call it an anomaly?"

Mirrors: server/algorithms/detection/AnomalyDetector.ts

Idea (robust z-score):
  1. Baseline = the service's earlier samples (never the 2 samples being judged).
     Use median and MAD instead of mean and std, so past spikes do not distort it.
  2. Positive quantities (cpu, latency...) are compared as ratios, using log(x+unit).
  3. Only the bad direction counts (latency up, request rate down).
  4. Self-healing: if the baseline holds a run of 2+ very high samples, that was an
     old incident, so drop it - otherwise a long fault would become "normal".
  5. Noisy series are shrunk so their normal extreme sits at z = 3.
  6. Both of the last 2 samples must exceed z_score_anomaly (persistence).
Separate checks: hard container facts, restarts, absolute cpu/memory limits, and
SILENCE (a usually-busy service that suddenly does nothing is frozen).

Data: history = list of snapshot dicts (oldest first) with optional keys cpu,
memory_percent, cpu_throttled_pct, network_rx_rate, network_tx_rate, request_rate,
error_rate, p95_latency, latency, request_count, restart_delta, timestamp.
A missing value is unknown, never 0.

Left out: ids, the per-anomaly onset memory (first-seen timestamps), the metric
store and target filtering. Output records are plain dicts.
"""
import math
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from datetime import datetime, timezone

from detection.container_facts import container_fact
from detection.thresholds import DEFAULT_THRESHOLDS

PARAMS = {
    "mad_to_std": 1.4826,        # 1.4826 * MAD = std for normal data
    "tail_quantile": 0.9, "tail_z": 1.645,   # spread is at least (90% deviation / 1.645): tail aware
    "self_heal_z": 4.0,          # past runs above this z are old incidents, dropped from baseline
    "healthy_quantile": 0.995, "healthy_z": 3,   # noise normalisation target
    "z_cap": 50,                 # largest z reported
    "min_requests": 5,           # a p95 or error share needs this many requests per judged sample
    "silence_history_factor": 3, "silence_min_expected": 5, "silence_gap_factor": 2,
}


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def round_to(v, digits):
    """Round half up (JavaScript style) so results match the TypeScript."""
    k = 10 ** digits
    return math.floor(v * k + 0.5) / k


def median(xs):
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def quantile(xs, q):
    if not xs:
        return 0
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, math.floor(q * (len(s) - 1))))]


def timestamp_ms(value):
    """Epoch milliseconds from a number (already ms) or an ISO-8601 string."""
    if finite(value):
        return value
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return math.nan
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp() * 1000


def _get(key):
    return lambda h: h.get(key)


def _p95_or_latency(h):
    return h["p95_latency"] if h.get("p95_latency") is not None else h.get("latency")


def _spec(metric, pick, direction, scale, unit, floor, kind, min_delta=None, min_requests=None):
    # unit = smallest change worth noticing (log(x + unit)); floor = smallest spread allowed
    return dict(metric=metric, pick=pick, direction=direction, scale=scale, unit=unit, floor=floor,
                kind=kind, min_delta=min_delta, min_requests=min_requests)


MR = PARAMS["min_requests"]
# kind "own" = evidence about the service itself; "symptom" = may be inherited from a broken dependency
SPECS = [
    _spec("cpu", _get("cpu"), 1, "log", 0.5, 0.15, "own", min_delta=0),
    _spec("cpuThrottledPct", _get("cpu_throttled_pct"), 1, "lin", 0, 3, "own", min_delta=0),
    _spec("memoryPercent", _get("memory_percent"), 1, "log", 1, 0.15, "own", min_delta=0),
    _spec("latency", _p95_or_latency, 1, "log", 1, 0.15, "symptom", min_requests=MR),
    _spec("errorRate", _get("error_rate"), 1, "lin", 0, 0.02, "symptom", min_requests=MR),
    _spec("requestRate", _get("request_rate"), -1, "log", 0.1, 0.15, "symptom"),
    _spec("networkRxRate", _get("network_rx_rate"), 1, "log", 2000, 0.15, "symptom"),
    _spec("networkTxRate", _get("network_tx_rate"), 1, "log", 2000, 0.15, "symptom"),
]


def robust_score(baseline, recent, spec, min_history, exclude_z=PARAMS["self_heal_z"]):
    """z of each `recent` sample against `baseline`. None if there is not enough history.

    Returns {'z': [...], 'center': median in original units, 'spread', 'noise_shrink'}.
    """
    direction, floor = spec["direction"], spec["floor"]

    def tf(v):  # log scale compares ratios: 100->200 ms is the same jump as 1->2 s
        return math.log(max(v, 0) + (spec["unit"] or 1)) if spec["scale"] == "log" else v

    B = [tf(v) for v in baseline if finite(v)]
    if len(B) < min_history or not recent:
        return None

    def fit(xs, tail=True):
        c = median(xs)
        dev = [abs(v - c) for v in xs]
        tail_spread = quantile(dev, PARAMS["tail_quantile"]) / PARAMS["tail_z"] if tail else 0
        return c, max(median(dev) * PARAMS["mad_to_std"], tail_spread, floor)

    # Decide exclusions with the plain MAD spread: a tail-aware spread would absorb
    # an old fault that fills more than ~10% of the window and nothing would be dropped.
    c, s = fit(B, tail=False)
    hot = [direction * (v - c) / s >= exclude_z for v in B]
    in_run = [h and ((i > 0 and hot[i - 1]) or (i + 1 < len(hot) and hot[i + 1])) for i, h in enumerate(hot)]
    kept = [v for v, r in zip(B, in_run) if not r]
    if min_history <= len(kept) < len(B):
        B = kept                              # isolated spikes stay: they are this series' normal noise
    c, s = fit(B)

    healthy = [max(0, direction * (v - c) / s) for v in B]
    shrink = max(1, quantile(healthy, PARAMS["healthy_quantile"]) / PARAMS["healthy_z"])
    z = [min(PARAMS["z_cap"], max(0, direction * (tf(v) - c) / s) / shrink) if finite(v) else math.nan
         for v in recent]
    center = math.exp(c) - (spec["unit"] or 1) if spec["scale"] == "log" else c
    return {"z": z, "center": center, "spread": s, "noise_shrink": shrink}


def _record(metric, observed, baseline, spread, z, reason, severity, source, evidence):
    return dict(metric=metric, observed=observed, baseline=baseline, spread=spread, z=z,
                reason=reason, severity=severity, source=source, evidence=evidence)


def _is_zero_rate(h):
    return finite(h.get("request_rate")) and h["request_rate"] == 0


def check_silence(history, t):
    """A usually-active service that now does nothing. Two methods depending on what we can see."""
    k = t["silence_samples"]
    counted = [h for h in history if finite(h.get("request_rate"))]
    need = PARAMS["silence_history_factor"] * t["min_history_samples"] + k
    if counted and len(counted) < need:
        return None                           # gaps need a longer past than levels do
    if len(counted) >= need:                  # method 1: requests counted, treat quiet time as a Poisson event
        if not all(_is_zero_rate(h) for h in history[-k:]):
            return None
        stamps = [x for x in (timestamp_ms(h.get("timestamp")) for h in history) if finite(x)]
        spacing = (stamps[-1] - stamps[0]) / 1000 / (len(stamps) - 1) if len(stamps) > 1 else 5
        lam = median([h["request_rate"] for h in counted[:-k]])      # usual requests per second
        expected = lam * spacing * k          # requests we would normally see in the quiet stretch
        if expected < PARAMS["silence_min_expected"]:
            return None                       # P(no requests) too high to mean anything
        now_run = 0
        while now_run < len(history) and _is_zero_rate(history[len(history) - 1 - now_run]):
            now_run += 1
        longest = run = 0                     # bursty traffic: silence must outlast the longest past gap
        for h in history[:len(history) - now_run]:
            run = run + 1 if _is_zero_rate(h) else 0
            longest = max(longest, run)
        if now_run < PARAMS["silence_gap_factor"] * longest:
            return None
        return _record("silence", 0, round_to(lam, 2), 0, round_to(expected, 2), "service-went-silent",
                       "CRITICAL" if expected >= 20 else "HIGH", "activity", "own")
    # method 2: activity = cpu above 0.5% or any network bytes. Binomial z of recent vs usual.
    act = []
    for h in history:
        if not finite(h.get("cpu")) and not finite(h.get("network_rx_rate")):
            continue                          # no reading at all: unknown, not silent
        net = (h.get("network_rx_rate") or 0) + (h.get("network_tx_rate") or 0)
        act.append(1 if (h.get("cpu") or 0) > 0.5 or net > 0 else 0)
    if len(act) < t["min_history_samples"] + k:
        return None
    past, recent = act[:-k], act[-k:]
    q = sum(past) / len(past)                 # share of past samples that were active
    if q < 0.6:
        return None                           # mostly idle service going quiet is just idle
    observed, expected = sum(recent), k * q
    z = min(50, (expected - observed) / math.sqrt(max(expected * (1 - q), 1e-6)))
    if observed > 0 or z < t["z_score_anomaly"]:
        return None
    return _record("silence", 0, round_to(q, 2), 0, round_to(z, 2), "service-went-silent",
                   "CRITICAL" if z >= t["z_score_critical"] else "HIGH", "activity", "own")


def _severity(z, current, metric, t):
    resource = metric in ("cpu", "memoryPercent")
    if z >= t["z_score_critical"] or (resource and current > t["absolute_critical_percent"]):
        return "CRITICAL"
    if z >= t["z_score_high"] or (resource and current > t["absolute_high_percent"]):
        return "HIGH"
    return "MEDIUM"


def judge(baseline, recent, spec, t):
    """Statistical check of one metric. Needs BOTH recent samples above z_score_anomaly."""
    r = robust_score(baseline, recent, spec, t["min_history_samples"])
    if not r or any(not math.isfinite(z) or z < t["z_score_anomaly"] for z in r["z"]):
        return None
    current = recent[-1]
    if spec["min_delta"] is not None and abs(current - r["center"]) < max(spec["min_delta"], t["min_delta_percent"]):
        return None                           # big z but tiny absolute move (idle 0.05% -> 2% cpu)
    z = r["z"][-1]
    return _record(spec["metric"], current, round_to(r["center"], 2), round_to(r["spread"], 3), round_to(z, 2),
                   "robust-zscore-persistent" + (" (noise-normalised)" if r["noise_shrink"] > 1 else ""),
                   _severity(z, current, spec["metric"], t), "dynamic-zscore", spec["kind"])


def absolute_limit(recent, baseline, spec, t):
    """cpu/memory/throttle above the critical limit is an anomaly even if it has always been that high."""
    if spec["metric"] not in ("cpu", "memoryPercent", "cpuThrottledPct"):
        return None
    if not all(finite(v) and v > t["absolute_critical_percent"] for v in recent):
        return None
    return _record(spec["metric"], recent[-1], round_to(median(baseline), 2), 0, None,
                   "over-absolute-limit", "CRITICAL", "absolute-threshold", "own")


def detect_anomalies(node, history, current=None, t=DEFAULT_THRESHOLDS):
    """All anomaly records for one service. `current` optionally holds live metric values by spec
    name (e.g. {'cpu': 91.0}) that replace the newest history value, like the live node reading in the original."""
    found = []
    fact = container_fact(node)
    if fact == "benign":
        return found                          # finished job / never started / load generator
    if fact in ("down", "paused", "detached"):
        reason = {"paused": "container-paused", "detached": "container-network-detached"}.get(
            fact, "container-vanished" if node.get("vanished") else "container-exited-or-critical")
        found.append(_record("container-health", 0, 1, 0, None, reason, "CRITICAL", "container-runtime", "hard"))
    elif fact == "restarting":
        found.append(_record("container-health", 0, 1, 0, None, "container-restarting", "HIGH", "container-runtime", "hard"))

    last_two = history[-2:]
    if any((h.get("restart_delta") or 0) > 0 for h in last_two):     # crash loop
        found.append(_record("restarts", sum(h.get("restart_delta") or 0 for h in last_two), 0, 0, None,
                             "container-restarted", "HIGH", "container-runtime", "hard"))

    silence = check_silence(history, t)
    if silence:
        found.append(silence)

    for spec in SPECS:
        if spec["min_requests"] and any(finite(h.get("request_count")) and h["request_count"] < spec["min_requests"]
                                        for h in last_two):
            continue                          # a few requests make a p95 / error share meaningless
        series = [v for v in map(spec["pick"], history) if finite(v)]
        live = (current or {}).get(spec["metric"])
        tail = series[:-1] + [live] if finite(live) else series
        if len(tail) < t["min_history_samples"] + 2:
            continue                          # cold start: say nothing rather than guess
        baseline, recent = tail[:-2], tail[-2:]
        hit = judge(baseline, recent, spec, t) or absolute_limit(recent, baseline, spec, t)
        if hit:
            found.append(hit)
    return found


def calculate_z_score(baseline, recent, metric, t=DEFAULT_THRESHOLDS):
    """Plain two-sided median/MAD check (no log, no self-healing) incl. the flat-baseline rule."""
    if not baseline or not recent:
        return None
    current = recent[-1]
    center = median(baseline)
    spread = median([abs(v - center) for v in baseline]) * PARAMS["mad_to_std"]
    if spread < t["flatline_std_dev"]:        # flat baseline: dividing by ~0 explodes, use absolute movement
        if not all(abs(v - center) > t["flatline_delta_percent"] for v in recent):
            return None
        sev = "CRITICAL" if current > t["flatline_critical_percent"] else "HIGH"
        return _record(metric, current, center, 0, None, "flat-baseline-jump", sev, "dynamic-baseline", "own")
    zs = [(v - center) / spread for v in recent]
    same_side = all(z > 0 for z in zs) or all(z < 0 for z in zs)
    if not same_side or min(abs(z) for z in zs) < t["z_score_anomaly"]:
        return None
    if abs(current - center) < t["min_delta_percent"]:
        return None
    z = zs[-1]
    if abs(z) >= t["z_score_critical"] or current > t["absolute_critical_percent"]:
        sev = "CRITICAL"
    elif abs(z) >= t["z_score_high"] or current > t["absolute_high_percent"]:
        sev = "HIGH"
    else:
        sev = "MEDIUM"
    return _record(metric, current, round_to(center, 1), round_to(spread, 1), round_to(z, 2),
                   "robust-zscore-persistent", sev, "dynamic-zscore", "own")


if __name__ == "__main__":
    import random
    rng = random.Random(7)
    # 30 normal samples around 10% cpu, then 2 samples at 60%
    cpu = [10 + rng.uniform(-1.5, 1.5) for _ in range(30)] + [60, 61]
    history = [{"cpu": v, "timestamp": 1_700_000_000_000 + i * 5000} for i, v in enumerate(cpu)]
    for a in detect_anomalies({"name": "api", "state": "running"}, history):
        print(a["metric"], a["severity"], "observed", a["observed"], "baseline", a["baseline"], "z", a["z"])
    print("healthy history ->", detect_anomalies({"name": "api", "state": "running"}, history[:30]))
