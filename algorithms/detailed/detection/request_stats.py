"""Request statistics from a service's log lines.

Question answered: "in this time window, how many requests did the service
handle, what share failed, and how slow were they (average, p50, p95, p99)?"

Mirrors: server/algorithms/detection/requestStats.ts

Idea: services print one JSON line per request. We read two shapes: the service
format {"msg":"request","status":200,"ms":4} and the nginx access format
{"status":"200","request_time":"0.002"} (seconds, converted to ms). Lines that
are not JSON are skipped. A status of 500 or more counts as an error. A window
with no request lines is a real zero (traffic stopped), so the rate is 0 but the
error rate and latencies are None (unknown, not 0). Percentiles use the simple
"index = floor(p * (n - 1))" rule on the sorted latencies.

Left out: COLLECTOR_PARAMS (polling interval, 60 s window) which is just wiring.
"""
import json
import math


def round2(v):
    """Round half up to 2 decimals, like JavaScript's Math.round (Python's round() is banker's)."""
    return math.floor(v * 100 + 0.5) / 100


def to_num(v):
    """Like JavaScript Number(): numbers and numeric strings work, anything else is NaN."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return math.nan


def parse_request_lines(lines):
    """Turn raw log lines into a window: {'count', 'errors', 'ms': [latencies]}."""
    window = {"count": 0, "errors": 0, "ms": []}
    for raw in lines:
        i, j = raw.find("{"), raw.rfind("}")
        if i < 0 or j < i:
            continue                                    # no JSON object on this line
        try:
            obj = json.loads(raw[i:j + 1])
        except ValueError:
            continue
        if not isinstance(obj, dict) or "status" not in obj:
            continue
        if obj.get("msg") == "request":                 # service format
            status, ms = to_num(obj["status"]), to_num(obj.get("ms", math.nan))
        elif "request_time" in obj:                     # nginx format, seconds -> ms
            status, ms = to_num(obj["status"]), to_num(obj["request_time"]) * 1000
        else:
            continue
        if not math.isfinite(status):
            continue
        window["count"] += 1
        if status >= 500:
            window["errors"] += 1
        if math.isfinite(ms):
            window["ms"].append(ms)
    return window


def percentile(sorted_values, p):
    return sorted_values[min(len(sorted_values) - 1, math.floor(p * (len(sorted_values) - 1)))]


def summarize(window, window_sec):
    """Counts, rates and latency percentiles for one window (None where unknown)."""
    ms = sorted(window["ms"])
    n = window["count"]
    return {
        "request_count": n,
        "request_rate": round2(n / max(1, window_sec)),
        "error_count": window["errors"],
        "error_rate": round2(window["errors"] / n) if n else None,
        "latency": round2(sum(ms) / len(ms)) if ms else None,
        "p50": round2(percentile(ms, 0.5)) if ms else None,
        "p95": round2(percentile(ms, 0.95)) if ms else None,
        "p99": round2(percentile(ms, 0.99)) if ms else None,
    }


def merge_windows(windows):
    """Combine several windows into one so a rolling window has enough requests for a stable p95."""
    return {
        "count": sum(w["count"] for w in windows),
        "errors": sum(w["errors"] for w in windows),
        "ms": [v for w in windows for v in w["ms"]],
    }


def throttled_percent(current, previous):
    """Share (%) of CPU scheduler periods in which the container was held back by its limit.

    Takes two docker stats readings {'periods', 'throttled'}. Returns None when
    either reading is missing or the counters went backwards (container restarted).
    """
    keys = ("periods", "throttled")
    if not current or not previous or any(current.get(k) is None or previous.get(k) is None for k in keys):
        return None
    d_periods = current["periods"] - previous["periods"]
    d_throttled = current["throttled"] - previous["throttled"]
    if d_periods <= 0 or d_throttled < 0:
        return 0 if d_periods == 0 else None
    return math.floor(d_throttled / d_periods * 1000 + 0.5) / 10


if __name__ == "__main__":
    lines = [
        '{"msg":"request","status":200,"ms":4}',
        '{"msg":"request","status":200,"ms":6}',
        '2026-01-01 10:00:00 {"msg":"request","status":503,"ms":120}',   # prefix before the JSON is fine
        '{"status":"200","request_time":"0.002"}',                        # nginx style, 2 ms
        "not json at all",
    ]
    w = parse_request_lines(lines)
    print("window :", w)
    print("summary:", summarize(w, 60))
    print("empty  :", summarize(parse_request_lines([]), 60))
    print("throttled %:", throttled_percent({"periods": 200, "throttled": 50}, {"periods": 100, "throttled": 20}))
