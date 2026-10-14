"""Temporal analyzer: which anomalies started first?

Question answered: "in what order did the anomalies appear, and which services
were anomalous in the earliest moment?"

Mirrors: server/algorithms/rca/TemporalAnalyzer.ts

Idea: sort the anomalies by time and mark the ones that fall within one second of
the first. Anomaly onsets are measured once per polling cycle, so two problems that
started in the same cycle cannot be put in order. Returning a single "earliest
service" would hand the credit to whichever sorted first, so a tie is reported as a
tie: find_earliest_nodes returns a set.

An anomaly is a dict with at least {"node_id", "metric", "timestamp"}; the
timestamp is an ISO string ("2026-01-01T10:00:05Z") or a number of seconds.
Optional keys: "z", "observed".

Left out compared with the TypeScript: nothing of substance (only types).
"""
from datetime import datetime

SAME_MOMENT_SECONDS = 1.0


def to_seconds(timestamp):
    """ISO string or number -> seconds."""
    if isinstance(timestamp, (int, float)):
        return float(timestamp)
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()


def build_timeline(anomalies):
    """Anomalies sorted by time; each point says whether it is part of the earliest moment."""
    if not anomalies:
        return []
    ordered = sorted(anomalies, key=lambda a: to_seconds(a["timestamp"]))
    first = to_seconds(ordered[0]["timestamp"])
    return [{
        "timestamp": a["timestamp"],
        "node_id": a["node_id"],
        "metric": a["metric"],
        "z": a.get("z"),
        "observed": a.get("observed"),
        "is_earliest": abs(to_seconds(a["timestamp"]) - first) < SAME_MOMENT_SECONDS,
    } for a in ordered]


def find_earliest_node(anomalies):
    """One node from the earliest moment (the first of a tie), or None. Prefer find_earliest_nodes."""
    for point in build_timeline(anomalies):
        if point["is_earliest"]:
            return point["node_id"]
    return None


def find_earliest_nodes(anomalies):
    """All nodes whose anomaly began in the earliest moment."""
    return {p["node_id"] for p in build_timeline(anomalies) if p["is_earliest"]}


if __name__ == "__main__":
    demo = [
        {"node_id": "web", "metric": "latency", "timestamp": "2026-01-01T10:00:09Z", "z": 4.1},
        {"node_id": "db", "metric": "memory", "timestamp": "2026-01-01T10:00:00Z", "z": 9.0},
        {"node_id": "cache", "metric": "cpu", "timestamp": "2026-01-01T10:00:00.4Z", "z": 5.2},
    ]
    for p in build_timeline(demo):
        print(f"{p['timestamp']}  {p['node_id']:6} {p['metric']:8} earliest={p['is_earliest']}")
    print("earliest set:", sorted(find_earliest_nodes(demo)))
