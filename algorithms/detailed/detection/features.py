"""Features: turn raw metrics into one number-vector per service.

Question answered: "for each service at this moment, how abnormal is each of its
signals, what does the container runtime say, and what are its neighbours
(callers and callees) suffering?"

Mirrors: server/algorithms/detection/features.ts

Idea: two layers. First, every signal (cpu, memory, throttling, network drop/rise,
request drop, error rise, latency rise) is compared with that service's own past
using robust_score from anomaly_detector, giving a z that is 0 when normal. The
smaller z of the last two samples is used, so both must agree. Second, signals are
grouped into "own" evidence (cpu, memory, throttle) and "symptom" evidence
(everything else, which a broken dependency can cause). The vector also carries
container facts and neighbour features: what the callers suffer (victims point at
the cause) and the strongest evidence among the callees (a broken callee explains
this service's symptoms away). Values are squashed with log(1 + min(z, 50)).

Left out: the TypeScript Signal/ServiceNode types and the learning code that uses
these vectors. Nodes are dicts {'id','name',...}; edges are (caller, callee) pairs.
"""
import math
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import re

from detection.anomaly_detector import robust_score, PARAMS
from detection.container_facts import container_fact

MIN_REQUESTS = PARAMS["min_requests"]


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def network_total(h):
    """rx + tx bytes/s. Unknown only if BOTH are missing; one missing counts as 0."""
    rx, tx = num(h.get("network_rx_rate")), num(h.get("network_tx_rate"))
    return None if rx is None and tx is None else (rx or 0) + (tx or 0)


def _signal(name, pick, direction, scale, unit, floor, own, min_requests=None):
    return dict(name=name, pick=pick, direction=direction, scale=scale, unit=unit, floor=floor,
                own=own, min_requests=min_requests)


# direction: +1 = rising is bad, -1 = falling is bad. unit/floor as in anomaly_detector.
# These are measurement resolution (smallest change worth noticing), not decision thresholds.
SIGNALS = [
    _signal("cpu", lambda h: h.get("cpu"), 1, "log", 0.5, 0.15, True),
    _signal("memory", lambda h: h.get("memory_percent"), 1, "log", 1, 0.15, True),
    _signal("throttle", lambda h: h.get("cpu_throttled_pct"), 1, "lin", 0, 3, True),
    _signal("netDrop", network_total, -1, "log", 2000, 0.15, False),
    _signal("netRise", network_total, 1, "log", 2000, 0.15, False),
    _signal("reqDrop", lambda h: h.get("request_rate"), -1, "log", 0.1, 0.15, False),
    _signal("errRise", lambda h: h.get("error_rate"), 1, "lin", 0, 0.02, False, MIN_REQUESTS),
    _signal("latRise", lambda h: h["p95_latency"] if h.get("p95_latency") is not None else h.get("latency"),
            1, "log", 1, 0.15, False, MIN_REQUESTS),
]

FEATURE_NAMES = [
    "own", "symptom", "cpu", "memory", "throttle", "netDrop", "reqDrop", "errRise", "latRise",
    "down", "paused", "restarting", "detached",
    "callersSymptomMax", "callersSymptomMean", "calleesEvidenceMax", "hasRequests", "noData",
]

# Datastores answer calls, they do not make them. An edge "store -> service" is just the
# reverse view of a TCP connection, so it is ignored.
STORE = re.compile(r"(^|[-_])(db|store|cache|redis|memcached|mongo|mongodb|postgres|mysql|queue|bus|kafka|nats|rabbitmq)([-_]|$)", re.I)


def signal_z(history, sig, min_history=12):
    """Persistent deviation: the smaller z of the last two samples. 0 when it cannot be told."""
    if sig["min_requests"] and any(
            (num(h.get("request_count")) if num(h.get("request_count")) is not None else math.inf) < sig["min_requests"]
            for h in history[-2:]):
        return 0                                  # too few requests: a rate or percentile is one request, not a trend
    series = [v for v in (num(sig["pick"](h)) for h in history) if v is not None]
    if len(series) < min_history + 2:
        return 0
    r = robust_score(series[:-2], series[-2:], sig, min_history)
    if not r or any(math.isnan(z) for z in r["z"]):
        return 0
    return max(0, min(r["z"]))


def node_signals(node, history, min_history=12):
    """Per-service signals from its own history and container state."""
    z = {s["name"]: signal_z(history, s, min_history) for s in SIGNALS}
    fact = container_fact(node)
    restarting = fact == "restarting" or any((num(h.get("restart_delta")) or 0) > 0 for h in history[-2:])
    return {
        "id": node["id"], "z": z,
        "own": max(z[s["name"]] for s in SIGNALS if s["own"]),         # strongest evidence about itself
        "sym": max(z[s["name"]] for s in SIGNALS if not s["own"]),     # strongest inheritable symptom
        "down": int(fact == "down"), "paused": int(fact == "paused"),
        "restarting": int(restarting), "detached": int(fact == "detached"),
        "hasRequests": int(any((num(h.get("request_count")) or 0) > 0 for h in history)),
        "noData": int(not history or all(num(h.get("cpu")) is None and network_total(h) is None for h in history)),
    }


def lz(v):
    """Squash a z: log(1 + z) with z clipped to [0, 50], so one huge value cannot dominate."""
    return math.log1p(min(max(v, 0), 50))


def feature_vectors(signals, edges, name_of):
    """{id: [18 numbers in FEATURE_NAMES order]} for every service of one target at one moment."""
    by_id = {s["id"]: s for s in signals}
    callers, callees = {}, {}
    for a, b in edges:
        if a not in by_id or b not in by_id or a == b:
            continue
        if STORE.search(name_of(a)) and not STORE.search(name_of(b)):
            continue
        callers.setdefault(b, []).append(a)
        callees.setdefault(a, []).append(b)

    def evidence(s):  # a container fact counts as very strong evidence (10)
        return max(s["own"], s["sym"], 10 * max(s["down"], s["paused"], s["restarting"], s["detached"]))

    out = {}
    for s in signals:
        caller_sym = [by_id[c]["sym"] for c in callers.get(s["id"], [])]
        callee_ev = [evidence(by_id[c]) for c in callees.get(s["id"], [])]
        out[s["id"]] = [
            lz(s["own"]), lz(s["sym"]),
            lz(s["z"]["cpu"]), lz(s["z"]["memory"]), lz(s["z"]["throttle"]), lz(s["z"]["netDrop"]),
            lz(s["z"]["reqDrop"]), lz(s["z"]["errRise"]), lz(s["z"]["latRise"]),
            s["down"], s["paused"], s["restarting"], s["detached"],
            lz(max(caller_sym) if caller_sym else 0),
            lz(sum(caller_sym) / len(caller_sym) if caller_sym else 0),
            lz(max(callee_ev) if callee_ev else 0),
            s["hasRequests"], s["noData"],
        ]
    return out


if __name__ == "__main__":
    import random
    rng = random.Random(3)

    def history(slow):
        # latency ~20 ms, then (if slow) 2 samples at 400 ms; 30 requests per sample
        lat = [20 + rng.uniform(-2, 2) for _ in range(28)] + ([400, 410] if slow else [20, 21])
        return [{"cpu": 10 + rng.uniform(-1, 1), "p95_latency": v, "request_count": 30, "request_rate": 6} for v in lat]

    nodes = [{"id": "web", "name": "web", "state": "running"}, {"id": "api", "name": "api", "state": "running"}]
    sigs = [node_signals(nodes[0], history(True)), node_signals(nodes[1], history(False))]
    vecs = feature_vectors(sigs, [("web", "api")], lambda i: i)
    for sid, vec in vecs.items():
        print(sid, {n: round(v, 2) for n, v in zip(FEATURE_NAMES, vec) if v})
