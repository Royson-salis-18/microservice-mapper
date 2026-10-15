"""Explanation engine: turn a ranking into a readable incident summary.

Question answered: "what happened, what is the likely root cause, why do we think
so, and what should an operator check?"

Mirrors: server/algorithms/rca/ExplanationEngine.ts

Idea: the ranking already holds the facts (score breakdown per candidate, affected
services, propagation path). This module only words them. It says only what the
score really rests on: the sentence lists the factors that appear in the root
cause's breakdown, and "N of M other services depend on it" uses the real count
instead of a blanket claim. If the top cause is unknown or the confidence is
UNKNOWN, it says so instead of guessing. If the problems look independent (the top
candidate explains none of the others) the text says that too.

A candidate is a dict {"service_id", "service_name", "score" (0..1), "confidence",
"breakdown": [{"factor", "reason"}]}. Evidence items are {"source", "description",
"before", "after"}.

Left out compared with the TypeScript: ids and UI links. The "sock-shop-" /
"vertikal-" prefix stripping of service names is kept.
"""
import re
from datetime import datetime

PREFIX = re.compile(r"^(sock-shop|vertikal)-")


def clean(name):
    return PREFIX.sub("", name)


def _clock(iso):
    """Time of day for the 'open its logs around ...' hint."""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%H:%M:%S")
    except (ValueError, AttributeError):
        return str(iso)


def _lead(factors, explains):
    """The part of the sentence after the service name; each clause only appears if its factor does."""
    if "critical_status" in factors:
        first = "is down or crash-looping"
    elif "degraded_status" in factors:
        first = "is degraded"
    else:
        first = "shows a metric anomaly"
    parts = [first]
    if "temporal_precedence" in factors:
        parts.append("its problem began first")
    if "explains_failures" in factors and explains and explains["count"] > 0:
        count, of = explains["count"], explains["of"]
        if count == of:
            parts.append("the other affected service depends on it" if of == 1
                         else f"all {of} other affected services depend on it")
        else:
            parts.append(f"{count} of the {of} other affected services depend on it")
    return ", ".join(parts)


def generate_explanation(target_id, started_at, root, alternatives, affected, propagation_path,
                         evidence, confidence, independent=False, explains=None):
    if root is None or confidence == "UNKNOWN":
        return {
            "what_happened": f"Anomalous activity detected in target '{target_id}'.",
            "when_started": started_at,
            "likely_root_cause": "UNKNOWN",
            "why": "Insufficient runtime telemetry or conflicting evidence. "
                   "Unable to confirm primary root cause without further runtime metrics.",
            "propagation_path": [], "affected_services": affected, "confidence": "UNKNOWN",
            "alternatives": [], "evidence_summary": [e["description"] for e in evidence],
            "recommended_investigation": [
                "Verify container logs and stdout/stderr streams",
                "Ensure network telemetry access logging is enabled",
                "Check system resource allocations and kernel logs"],
        }

    name = clean(root["service_name"])
    affected_clean = [clean(s) for s in affected]
    path_clean = [clean(s) for s in propagation_path]
    reasons = "; ".join(b["reason"] for b in root["breakdown"])
    factors = {b["factor"] for b in root["breakdown"]}
    pct = f"{root['score'] * 100:.0f}%"

    if independent:
        why = (f"Several services are misbehaving, but none of them explains the others through its dependencies - "
               f"these look like independent problems rather than one cascade. '{name}' ranks highest ({pct}) "
               f"but is not shown to cause the rest. Key factors: {reasons}.")
        steps = [f"Investigate '{s}' on its own - nothing measured links it to the others" for s in affected_clean]
    else:
        why = f"'{name}' {_lead(factors, explains)} (score {pct}). Key factors: {reasons}."
        steps = [
            f"Check why '{name}' stopped: container logs and exit code (137 usually means it was killed for memory)"
            if "critical_status" in factors else f"Check resource limits and recent load on '{name}'",
        ]
        if len(path_clean) > 1:
            steps.append(f"Once '{name}' recovers, confirm {', '.join(path_clean[1:])} recover with it")
        steps.append(f"Open its logs from the service card for the moments around {_clock(started_at)}")

    return {
        "what_happened": f"Incident detected on '{target_id}': {len(affected_clean)} service(s) affected ({', '.join(affected_clean)}).",
        "when_started": started_at,
        "likely_root_cause": name,
        "why": why,
        "propagation_path": path_clean,
        "affected_services": affected_clean,
        "confidence": confidence,
        "alternatives": [{"name": clean(c["service_name"]), "score": round(c["score"], 2), "confidence": c["confidence"]}
                         for c in alternatives if c["service_id"] != root["service_id"]],
        "evidence_summary": [f"{e['source']}: {e['description']} ({e['before']} -> {e['after']})" for e in evidence],
        "recommended_investigation": steps,
    }


if __name__ == "__main__":
    root = {"service_id": "s1", "service_name": "sock-shop-orders-db", "score": 0.93, "confidence": "HIGH",
            "breakdown": [{"factor": "hard_evidence", "reason": "container exited: a fact, not a degree"},
                          {"factor": "explains_failures", "reason": "2 of the 2 other affected services depend on it"}]}
    other = {"service_id": "s2", "service_name": "sock-shop-orders", "score": 0.4, "confidence": "UNKNOWN", "breakdown": []}
    result = generate_explanation(
        "sock-shop", "2026-01-01T10:00:00Z", root, [root, other], ["sock-shop-orders-db", "sock-shop-orders"],
        ["sock-shop-orders-db", "sock-shop-orders"], [], "HIGH", explains={"count": 2, "of": 2})
    for key in ("what_happened", "likely_root_cause", "why", "recommended_investigation"):
        print(f"{key}: {result[key]}")
