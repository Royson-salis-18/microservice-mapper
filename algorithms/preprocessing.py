"""Preprocessing: from raw log lines and readings to the numbers the logic uses.

Run it:  python3 algorithms/preprocessing.py

Two steps, both done before any detection:
  1. request_stats: a service prints one JSON line per request. Count them over a
     time window and turn them into request count, error share and latency (p95).
  2. features: for one service at one moment, build a short list of numbers:
        own          how abnormal its own cpu / memory is
        symptom      how abnormal its latency / errors / traffic is
        callers      the worst symptom among the services that call it (victims point at the cause)
        callees      the worst evidence among the services it calls (a broken callee explains it away)
        down         1 if its container is stopped
     These are the same ideas as the real feature list in server/algorithms/detection/features.ts
     (that one has 18 numbers; this one keeps the five that matter most).
"""
import json
import math

from detector import detect_service


def request_stats(lines):
    """lines: raw log lines. Returns count, error share and p95 latency (ms) for the window."""
    count = errors = 0
    latencies = []
    for line in lines:
        try:
            row = json.loads(line[line.index("{"):line.rindex("}") + 1])
        except ValueError:
            continue                                  # not a JSON line, skip it
        if row.get("msg") != "request":
            continue
        count += 1
        errors += row["status"] >= 500                # 5xx counts as an error
        latencies.append(row["ms"])
    if count == 0:                                    # no requests: traffic is 0, the rest is unknown (not 0)
        return {"count": 0, "error_rate": None, "p95": None}
    latencies.sort()
    return {"count": count, "error_rate": round(errors / count, 3), "p95": latencies[int(0.95 * (count - 1))]}


def strongest(findings, kind):
    return max([f["score"] for f in findings if f["kind"] == kind], default=0.0)


def log_squash(z):
    """Large scores are squashed so one huge number cannot dominate: log(1 + min(z, 50))."""
    return math.log(1 + min(z, 50))


def features(history, down, caller_histories, callee_histories):
    """history: {metric: [values]} for the service; the others are the same for its neighbours."""
    own_findings = detect_service(history)
    callers = [strongest(detect_service(h), "symptom") for h in caller_histories]
    callees = [max(strongest(detect_service(h), "own"), strongest(detect_service(h), "symptom")) for h in callee_histories]
    return {
        "own": log_squash(strongest(own_findings, "own")),
        "symptom": log_squash(strongest(own_findings, "symptom")),
        "callers": log_squash(max(callers, default=0.0)),
        "callees": log_squash(max(callees, default=0.0)),
        "down": 1.0 if down else 0.0,
    }


if __name__ == "__main__":
    lines = ['2024-01-01 {"msg":"request","status":200,"ms":12}', '{"msg":"request","status":500,"ms":340}',
             "starting up...", '{"msg":"request","status":200,"ms":15}', '{"msg":"request","status":200,"ms":11}']
    print("request stats:", request_stats(lines))
    print("empty window: ", request_stats([]))
