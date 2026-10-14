"""Cascade engine: who fails next, and how far would one failure spread?

Questions answered:
  1. predict_cascade     - given what is failing now, which services are likely to fail next
                           and through which dependency?
  2. simulate_failure    - if this one service failed, how far would it spread (what-if)?
  3. structural_criticality - how much of the project's traffic would be disrupted if
                           each service failed alone, from a healthy start?

Mirrors: server/algorithms/graph/CascadeEngine.ts

Idea: every service gets an own failure probability p0 from what is measured (status,
anomaly score). Then risk flows along dependencies from callee to caller. A service
survives only if it survives on its own AND survives every dependency (noisy-OR):

    P(n) = 1 - (1 - p0(n)) * product over callees c of (1 - tau * w(n->c) * P(c))

tau (0.7) is the share of a dependency's failure that really reaches its caller; it is
below 1 because of retries, timeouts and caches. P(n) appears on both sides, and services
may call each other in a loop, so we iterate until nothing changes. P only rises from p0
and never exceeds 1, so it always converges. These are model estimates, not calibrated
frequencies.

Data shapes: node {"id","name","status","status_reason","anomaly_score","anomaly_persistent"};
edge {"source","target","weight": {"value": 0..1}} (if an edge has no "weight" the
weights from edge_weights.py are computed for it).

Left out compared with the TypeScript: timestamps, the project name, "model" labels,
and the type declarations. The route text (via, path, depth) is kept.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from graph.edge_weights import compute_edge_weights, edge_id, js_round  # noqa: E402

DEFAULT_TRANSMISSION = 0.7
STATUS_PROBABILITY = {"critical": 1.0, "degraded": 0.5, "healthy": 0.0, "unknown": 0.0}
# "unknown" is 0 on purpose: counting never-measured services as half failed would
# create phantom cascades.
ANOMALY_WEIGHT = 0.3             # one abnormal window counts for little (often noise)
PERSISTENT_ANOMALY_WEIGHT = 0.8  # a sustained one counts for a lot
MAX_ITERATIONS = 200
TOLERANCE = 1e-6
MEANINGFUL_INHERITED = 0.15      # inherited risk below this does not deserve a "via"


def band_for(p):
    if p >= 0.7:
        return "high"
    if p >= 0.4:
        return "elevated"
    if p >= 0.15:
        return "low"
    return "minimal"


def round3(x):
    return js_round(x, 3)


def intrinsic_probability(node):
    """p0: chance the service is failing on its own, from status and anomaly score. Returns (p, reasons)."""
    reasons, survive = [], 1.0
    s = STATUS_PROBABILITY.get(node.get("status"), 0.0)
    if s > 0:
        survive *= 1 - s
        why = f" ({node['status_reason']})" if node.get("status_reason") else ""
        reasons.append(f"status {node['status']}{why}")
    a = node.get("anomaly_score")
    if isinstance(a, (int, float)) and a > 0:
        w = PERSISTENT_ANOMALY_WEIGHT if node.get("anomaly_persistent") else ANOMALY_WEIGHT
        survive *= 1 - min(max(a, 0), 1) * w
        reasons.append(f"anomaly score {round3(a)}" + (" (persistent)" if node.get("anomaly_persistent") else ""))
    return 1 - survive, reasons


def build_graph(nodes, edges):
    """Out-edges per caller, keeping only usable ones: both ends known, not a self-loop, weight > 0."""
    ids = {n["id"] for n in nodes}
    computed = None
    out = {}
    for e in edges:
        if e["source"] not in ids or e["target"] not in ids or e["source"] == e["target"]:
            continue
        w = e.get("weight")
        if w is None:
            computed = computed or compute_edge_weights(edges)
            w = computed[edge_id(e)]
        if w["value"] <= 0:
            continue
        out.setdefault(e["source"], []).append((e["target"], w["value"]))
    return {"nodes": nodes, "out": out, "name": {n["id"]: n["name"] for n in nodes}}


def solve(graph, p0, tau):
    """Repeat the noisy-OR formula until the biggest change is below TOLERANCE. Returns (P, iterations, converged)."""
    P = dict(p0)
    for i in range(MAX_ITERATIONS):
        new, biggest = {}, 0.0
        for n in graph["nodes"]:
            survive = 1 - p0.get(n["id"], 0)
            for target, w in graph["out"].get(n["id"], []):
                survive *= 1 - tau * w * P.get(target, 0)
            new[n["id"]] = 1 - survive
            biggest = max(biggest, abs(new[n["id"]] - P.get(n["id"], 0)))
        P = new
        if biggest < TOLERANCE:
            return P, i + 1, True
    return P, MAX_ITERATIONS, False


def describe(graph, P, p0, reasons, tau):
    """Explain each service: own part, inherited part, strongest route (via) and the path back to the origin."""
    best_via, inherited = {}, {}
    for n in graph["nodes"]:
        survive, best = 1.0, None
        for target, w in graph["out"].get(n["id"], []):
            contribution = tau * w * P.get(target, 0)
            survive *= 1 - contribution
            if contribution > 0 and (best is None or contribution > best[1]):
                best = (target, contribution)
        inherited[n["id"]] = 1 - survive
        if best:
            best_via[n["id"]] = best

    def has_route(i):
        # a degraded service can have its own problems AND inherit risk, so keep the route
        # whenever the inherited part is meaningful, not only when it is the larger part
        return inherited.get(i, 0) >= MEANINGFUL_INHERITED or inherited.get(i, 0) > p0.get(i, 0)

    out = []
    for n in graph["nodes"]:
        path, seen, cur = [n["name"]], {n["id"]}, n["id"]
        while has_route(cur):
            via = best_via.get(cur)
            if not via or via[0] in seen:
                break
            seen.add(via[0])
            path.append(graph["name"].get(via[0], via[0]))
            cur = via[0]
        via = best_via.get(n["id"])
        routed = has_route(n["id"]) and via is not None
        out.append({
            "id": n["id"], "name": n["name"],
            "probability": round3(P.get(n["id"], 0)),
            "intrinsic": round3(p0.get(n["id"], 0)),
            "inherited": round3(inherited.get(n["id"], 0)),
            "band": band_for(P.get(n["id"], 0)),
            "via": {"id": via[0], "name": graph["name"].get(via[0], via[0]), "contribution": round3(via[1])} if routed else None,
            "path": path if routed else [n["name"]],
            "depth": len(path) - 1 if routed else 0,
            "reasons": reasons.get(n["id"], []),
        })
    return out


def _start_probabilities(nodes):
    p0, reasons = {}, {}
    for n in nodes:
        p0[n["id"]], reasons[n["id"]] = intrinsic_probability(n)
    return p0, reasons


def predict_cascade(nodes, edges, tau=DEFAULT_TRANSMISSION):
    """Failure probability for every service from its current state."""
    graph = build_graph(nodes, edges)
    p0, reasons = _start_probabilities(nodes)
    P, iterations, converged = solve(graph, p0, tau)
    described = describe(graph, P, p0, reasons, tau)
    # "at risk" = fine by its own measurements, but expected to be pulled down through a dependency
    at_risk = sorted((d for d in described if d["intrinsic"] < 0.15 and d["probability"] >= 0.15),
                     key=lambda d: (-d["probability"], d["depth"]))
    return {
        "transmission": tau, "iterations": iterations, "converged": converged,
        "expected_failures": round3(sum(d["probability"] for d in described)),
        "at_risk": at_risk,
        "nodes": sorted(described, key=lambda d: -d["probability"]),
    }


def structural_criticality(nodes, edges, traffic_of, tau=DEFAULT_TRANSMISSION):
    """Share of the project's traffic disrupted if each service failed alone, from a healthy start.

    An edge's traffic is disrupted with probability 1 - (1 - P(caller)) * (1 - P(callee)): calls into a
    failed callee fail and a failed caller stops calling. Plain reachability overstated this badly
    (66% for a queue that only shipping uses; the weighted model gives about 8%).
    Returns {id: 0..1 or None when the project has no traffic at all}.
    """
    graph = build_graph(nodes, edges)
    ids = {n["id"] for n in nodes}
    counted = [e for e in edges if e["source"] in ids and e["target"] in ids and e["source"] != e["target"]]
    total = sum(traffic_of(e) for e in counted)
    result = {}
    for n in nodes:
        if total <= 0:
            result[n["id"]] = None
            continue
        p0 = {x["id"]: (1.0 if x["id"] == n["id"] else 0.0) for x in nodes}
        P, _, _ = solve(graph, p0, tau)
        disrupted = sum(traffic_of(e) * (1 - (1 - P[e["source"]]) * (1 - P[e["target"]])) for e in counted)
        result[n["id"]] = js_round(min(disrupted / total, 1), 2)
    return result


def simulate_failure(origin_id, nodes, edges, tau=DEFAULT_TRANSMISSION):
    """What if origin_id failed outright? Everything else keeps its measured state.

    Reports only services whose probability rises by at least 0.005 versus the baseline."""
    origin = next((n for n in nodes if n["id"] == origin_id), None)
    if origin is None:
        return None
    graph = build_graph(nodes, edges)
    p0, reasons = _start_probabilities(nodes)
    baseline, _, _ = solve(graph, p0, tau)

    forced = dict(p0)
    forced[origin_id] = 1.0
    reasons[origin_id] = ["assumed failed for this simulation"]
    P, _, _ = solve(graph, forced, tau)

    affected = []
    for d in describe(graph, P, forced, reasons, tau):
        if d["id"] == origin_id:
            continue
        base = baseline.get(d["id"], 0)
        d["baseline"], d["delta"] = round3(base), round3(d["probability"] - base)
        if d["delta"] >= 0.005:
            affected.append(d)
    affected.sort(key=lambda d: (-d["delta"], d["depth"]))
    return {"origin": origin["name"], "expected_additional_failures": round3(sum(d["delta"] for d in affected)),
            "affected": affected}


if __name__ == "__main__":
    def edge(a, b, w):
        return {"source": a, "target": b, "weight": {"value": w}}

    demo_nodes = [
        {"id": "web", "name": "web", "status": "healthy"},
        {"id": "orders", "name": "orders", "status": "degraded", "status_reason": "memory 88%"},
        {"id": "db", "name": "db", "status": "critical", "status_reason": "container exited"},
        {"id": "mail", "name": "mail", "status": "healthy"},
    ]
    demo_edges = [edge("web", "orders", 0.8), edge("orders", "db", 0.9), edge("web", "mail", 0.2)]

    result = predict_cascade(demo_nodes, demo_edges)
    print(f"converged={result['converged']} after {result['iterations']} rounds, expected failures {result['expected_failures']}")
    for d in result["nodes"]:
        print(f"  {d['name']:7} P={d['probability']:<6} own={d['intrinsic']:<6} band={d['band']:9} path={' <- '.join(d['path'])}")
    print("at risk:", [(d["name"], d["probability"]) for d in result["at_risk"]])

    what_if = simulate_failure("db", [dict(n, status="healthy") for n in demo_nodes], demo_edges)
    print("what if db failed from a healthy system:", [(d["name"], d["delta"]) for d in what_if["affected"]])
    print("criticality:", structural_criticality(demo_nodes, demo_edges, lambda e: 10))
