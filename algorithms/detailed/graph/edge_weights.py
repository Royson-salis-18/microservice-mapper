"""Edge weights: how much does service A depend on service B?

Question answered: "for the link A -> B (A calls B), if B fails, how badly is A
hit?" Root-cause scoring and cascade prediction both need this number.

Mirrors: server/algorithms/graph/EdgeWeights.ts

Idea: the weight is the product of two independent parts.
  dependency  - the share of A's outbound work that goes to B. It is measured from
                request rates if every edge of A has one, else from socket activity,
                else (no traffic figure at all) split evenly among A's edges.
  confidence  - how sure we are the link really exists and points this way. A link
                seen in request logs is certain (1.0), one only declared in a compose
                file and never seen carrying traffic is a claim (0.4).
Links to monitoring tools (telemetry export) are multiplied by 0.1 because a
service keeps working when its collector dies.

Data shapes (plain dicts, snake_case keys): an edge is
  {"id", "source", "target", "observed", "declared", "evidence_sources": [...],
   "metrics": {"request_rate", "error_rate", "p95_latency", "latency"},
   "activity": {"samples_per_min", "baseline_per_min"}}

Left out compared with the TypeScript: the types, and the "volume" field (only
used to draw the link thickness in the UI). Weights are returned in a dict
instead of being written back onto the edges.
"""
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from graph.service_roles import is_observability_service  # noqa: E402

CONFIDENCE = {
    "listen_port": 1.0,
    "http_log": 1.0,
    "ephemeral_port": 0.85,
    "observed_legacy": 0.7,
    "unresolved_direction": 0.5,
    "declared_only": 0.4,
    "candidate": 0.0,
}
TELEMETRY_FACTOR = 0.1
STRESS_ERROR_RATE = 0.05   # error rate at which a link counts as fully stressed
STRESS_LATENCY_MS = 1000   # latency at which a link counts as fully stressed


def js_round(x, digits):
    """Round half up, like JavaScript's Math.round (Python's round() rounds half to even)."""
    scale = 10 ** digits
    return math.floor(x * scale + 0.5) / scale


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def edge_id(edge):
    return edge.get("id") or f"{edge['source']}->{edge['target']}"


def is_telemetry_edge(edge):
    """Monitoring traffic in either direction."""
    return is_observability_service(edge["target"]) or is_observability_service(edge["source"])


def edge_confidence(edge):
    """How sure we are that the dependency exists and points this way. Returns (value, why)."""
    ev = edge.get("evidence_sources") or []
    if edge.get("observed"):
        if "http-log" in ev:
            return CONFIDENCE["http_log"], "seen in request logs"
        if "direction:listen-port" in ev:
            return CONFIDENCE["listen_port"], "observed; direction from listening port"
        if "direction:ephemeral-port" in ev:
            return CONFIDENCE["ephemeral_port"], "observed; direction from ephemeral port range"
        if "direction:unresolved" in ev:
            return CONFIDENCE["unresolved_direction"], "observed, but direction could not be determined"
        return CONFIDENCE["observed_legacy"], "observed (no direction evidence recorded)"
    if edge.get("declared"):
        return CONFIDENCE["declared_only"], "declared in config, never seen carrying traffic"
    return CONFIDENCE["candidate"], "candidate only (shared network), not evidence of a dependency"


def edge_stress(edge):
    """0..1: how strained the link looks (worst of error rate and latency), or None if unmeasured."""
    m = edge.get("metrics") or {}
    parts = []
    if is_number(m.get("error_rate")):
        parts.append(min(max(m["error_rate"], 0) / STRESS_ERROR_RATE, 1))
    latency = m.get("p95_latency") if m.get("p95_latency") is not None else m.get("latency")
    if is_number(latency):
        parts.append(min(max(latency, 0) / STRESS_LATENCY_MS, 1))
    return js_round(max(parts), 3) if parts else None


def _reference_traffic(edge):
    """Slow baseline if known, else the live rate. A link goes quiet exactly when its callee dies,
    so weighting on the live rate would make a crashed dependency look less and less important."""
    act = edge.get("activity") or {}
    if act.get("baseline_per_min") is not None:
        return act["baseline_per_min"]
    return act.get("samples_per_min") or 0


def _dependency_share(edge, siblings):
    """Share (0..1) of the caller's outbound work that goes through this edge, plus how it was measured."""
    rates = [(s.get("metrics") or {}).get("request_rate") for s in siblings]
    all_have_requests = all(is_number(r) for r in rates)
    total_requests = sum(rates) if all_have_requests else 0
    total_activity = sum(_reference_traffic(s) for s in siblings)

    # Edges with no traffic figure get an even slice 1/N each; measured edges split what is left.
    # (Giving unmeasured edges 1/N ON TOP of a full split once made a caller's shares sum to 183%.)
    unmeasured = sum(1 for s in siblings if _reference_traffic(s) <= 0)
    measured_pool = 1 - unmeasured / len(siblings)

    if all_have_requests and total_requests > 0:
        return edge["metrics"]["request_rate"] / total_requests, "requests"
    if total_activity > 0 and _reference_traffic(edge) > 0:
        return _reference_traffic(edge) / total_activity * measured_pool, "activity"
    return 1 / len(siblings), "uniform"


def compute_edge_weights(edges):
    """Return {edge_id: {"value", "dependency", "basis", "kind", "confidence", "confidence_basis", "stress"}}."""
    conf = {edge_id(e): edge_confidence(e) for e in edges}

    # Only edges that are evidence of a dependency share a caller's 100%. Functional calls are compared
    # with functional calls and telemetry with telemetry: 50 trace exports/min and 10 DB calls/min
    # means the DB is depended on completely, not 17%.
    groups = {}
    for e in edges:
        if conf[edge_id(e)][0] <= 0:
            continue
        key = (e["source"], is_telemetry_edge(e))
        groups.setdefault(key, []).append(e)

    result = {}
    for e in edges:
        confidence, why = conf[edge_id(e)]
        telemetry = is_telemetry_edge(e)
        siblings = groups.get((e["source"], telemetry), [])
        dependency, basis = 0.0, "uniform"
        if confidence > 0 and siblings:
            dependency, basis = _dependency_share(e, siblings)
        factor = TELEMETRY_FACTOR if telemetry else 1
        result[edge_id(e)] = {
            "value": js_round(min(max(confidence * dependency * factor, 0), 1), 3),
            "dependency": js_round(dependency, 3),
            "basis": basis,
            "kind": "telemetry" if telemetry else "request",
            "confidence": confidence,
            "confidence_basis": why,
            "stress": edge_stress(e),
        }
    return result


if __name__ == "__main__":
    demo_edges = [
        {"id": "e1", "source": "orders", "target": "db", "observed": True, "evidence_sources": ["http-log"],
         "metrics": {"request_rate": 90}},
        {"id": "e2", "source": "orders", "target": "cache", "observed": True, "evidence_sources": ["direction:ephemeral-port"],
         "metrics": {"request_rate": 10, "error_rate": 0.02}},
        {"id": "e3", "source": "orders", "target": "otel-collector", "observed": True, "evidence_sources": ["http-log"],
         "metrics": {"request_rate": 500}},
        {"id": "e4", "source": "web", "target": "orders", "declared": True},
    ]
    for eid, w in compute_edge_weights(demo_edges).items():
        print(eid, w)
