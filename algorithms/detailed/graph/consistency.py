"""Consistency checks: do the numbers the mapper publishes agree with each other?

Question answered: "given the graph (services, links) and the incidents, which
rules between the numbers are broken?" Each rule was found broken at least once
in live output (shares that summed to 183%, a cumulative byte count shown as a
rate...), so it was written down as a check.

Mirrors: server/algorithms/graph/consistency.ts

Idea: this is a validator, not a predictor. It is a pure function: give it
nodes, edges and incidents, get back a list of violations (rule name, subject,
detail). An empty list means every one of the 12 rules holds. The rules are:
 1 edge-endpoints            links join two known services
 2 health-breakdown-sum      health factors add up to the health score
 3 score-range               probabilities and scores are within 0..1
 4 inherited-within-total    inherited risk is never more than total risk
 5 cascade-via-is-dependency "risk arrives through X" means X is really a callee
 6 metric-range              measurements are physically possible
 7 rate-not-total            a rate above 10 GB/s is really a total
 8 weight-formula            weight = confidence x dependency (x 0.1 for telemetry)
 9 reliance-sums-to-one      a caller's shares per kind sum to 100%
10 activity-range            connection figures are not negative
11 incident-references       incidents point at known services of their own target
12 root-cause-is-candidate   (and incident root-cause score within 0..1)

Left out compared with the TypeScript: the types and the timestamp/count fields
of the report. Keys are snake_case plain dicts (health_score, cascade_via ...).
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from graph.edge_weights import TELEMETRY_FACTOR, edge_id  # noqa: E402

TOL = 0.011  # a rounded number may differ from the exact one by up to 0.01


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def _present(v):
    return v is not None


def check_consistency(nodes, edges, incidents=()):
    """Return {"rules_checked": 12, "violations": [{"rule", "subject", "detail"}, ...]}."""
    violations = []

    def add(rule, subject, detail):
        violations.append({"rule": rule, "subject": subject, "detail": detail})

    by_id = {n["id"]: n for n in nodes}

    # 1. Every link joins two known services.
    for e in edges:
        if e["source"] not in by_id:
            add("edge-endpoints", edge_id(e), f"source {e['source']} is not a known service")
        if e["target"] not in by_id:
            add("edge-endpoints", edge_id(e), f"target {e['target']} is not a known service")

    for n in nodes:
        a = n.get("analytics") or {}
        m = n.get("metrics") or {}

        # 2. The health breakdown adds up to the score it explains.
        breakdown = a.get("health_breakdown")
        if breakdown and is_num(a.get("health_score")):
            total = sum(f["score"] for f in breakdown)
            if abs(total - a["health_score"]) > TOL:
                add("health-breakdown-sum", n["id"], f"factors sum to {total:.3f}, score is {a['health_score']}")

        # 3. Scores are probabilities (0..1); the inherited part cannot exceed the whole.
        for key in ("failure_probability", "affected_probability", "risk_score", "health_score",
                    "criticality", "centrality", "anomaly_score"):
            v = a.get(key)
            if _present(v) and (not is_num(v) or v < 0 or v > 1):
                add("score-range", n["id"], f"{key} = {v}")
        if is_num(a.get("affected_probability")) and is_num(a.get("failure_probability")) \
                and a["affected_probability"] > a["failure_probability"] + 1e-9:
            add("inherited-within-total", n["id"],
                f"inherited {a['affected_probability']} exceeds total {a['failure_probability']}")

        # 4. The dependency that risk "arrives through" must be one this service calls.
        via = a.get("cascade_via")
        if via and not any(e["source"] == n["id"] and e["target"] == via for e in edges):
            add("cascade-via-is-dependency", n["id"], f"cascade_via {via} is not a service it calls")

        # 5. Measurements are physically possible.
        for key in ("cpu_of_allowance", "memory_percent"):
            v = m.get(key)
            if _present(v) and (not is_num(v) or v < 0 or v > 100.0001):
                add("metric-range", n["id"], f"{key} = {v}")
        if _present(m.get("cpu")) and (not is_num(m["cpu"]) or m["cpu"] < 0):
            add("metric-range", n["id"], f"cpu = {m['cpu']}")
        for key in ("network_rx_rate", "network_tx_rate", "network_rx", "network_tx", "memory"):
            v = m.get(key)
            if _present(v) and (not is_num(v) or v < 0):
                add("metric-range", n["id"], f"{key} = {v}")

        # 6. 10 GB/s is above any container network, so a bigger "rate" is a total shown as a rate.
        for key in ("network_rx_rate", "network_tx_rate"):
            v = m.get(key)
            if is_num(v) and v > 1e10:
                add("rate-not-total", n["id"], f"{key} = {v} bytes/s")

    # 7. weight = confidence x dependency (x telemetry factor).  8. shares per caller and kind sum to 1.
    shares = {}
    for e in edges:
        w = e.get("weight")
        if not w:
            continue
        expected = w["confidence"] * w["dependency"] * (TELEMETRY_FACTOR if w["kind"] == "telemetry" else 1)
        if abs(expected - w["value"]) > TOL:
            add("weight-formula", edge_id(e), f"weight {w['value']} but confidence x dependency = {expected:.3f}")
        if w["confidence"] > 0:
            key = (e["source"], w["kind"])
            shares[key] = shares.get(key, 0) + w["dependency"]
    for (source, kind), total in shares.items():
        if abs(total - 1) > 0.02:
            add("reliance-sums-to-one", source, f"{kind} shares sum to {total * 100:.0f}%")

    # 9. Connection figures are never negative.
    for e in edges:
        for key in ("samples_per_min", "open_connections", "new_connections_per_min"):
            v = (e.get("activity") or {}).get(key)
            if v is not None and (not is_num(v) or v < 0):
                add("activity-range", edge_id(e), f"{key} = {v}")

    # 10-12. Open incidents refer to real services of their own target, with a sane score,
    #        and the named root cause is one of the listed candidates.
    for inc in incidents:
        if inc.get("status") == "RESOLVED":
            continue
        refs = [r for r in [inc.get("root_cause_service_id"), *(inc.get("affected_services") or [])] if r]
        for ref in refs:
            node = by_id.get(ref)
            if node is None:
                add("incident-references", inc["id"], f"refers to {ref}, which is not a known service id")
            elif node.get("project") != inc.get("target_id"):
                add("incident-references", inc["id"], f"{ref} belongs to {node.get('project')}, not {inc.get('target_id')}")
        score = inc.get("root_cause_score")
        if not is_num(score) or score < 0 or score > 1:
            add("score-range", inc["id"], f"root_cause_score = {score}")
        root = inc.get("root_cause_service_id")
        if root and not any(c.get("service_id") == root for c in inc.get("candidate_causes") or []):
            add("root-cause-is-candidate", inc["id"], f"root cause {root} is not among its candidates")

    return {"rules_checked": 12, "violations": violations}


if __name__ == "__main__":
    nodes = [
        {"id": "shop:web", "project": "shop", "analytics": {"risk_score": 0.4, "cascade_via": "shop:orders"}},
        {"id": "shop:orders", "project": "shop", "analytics": {"failure_probability": 0.3, "affected_probability": 0.5},
         "metrics": {"network_rx_rate": 5e11, "memory_percent": 120}},
    ]
    edges = [
        {"id": "e1", "source": "shop:web", "target": "shop:orders",
         "weight": {"value": 0.9, "confidence": 1.0, "dependency": 0.5, "kind": "request"}},
        {"id": "e2", "source": "shop:web", "target": "shop:ghost"},
    ]
    report = check_consistency(nodes, edges)
    print(f"{len(report['violations'])} violation(s) found by {report['rules_checked']} rules:")
    for v in report["violations"]:
        print(f"  [{v['rule']}] {v['subject']}: {v['detail']}")
