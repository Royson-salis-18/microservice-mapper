"""Root-cause analysis engine: when several services look sick, which one is the cause?

Question answered: "given the call graph and the anomalies found on each service,
which service most likely started the incident, how sure are we, how did it spread,
and who is at risk next?"

Mirrors: server/algorithms/rca/RCAEngine.ts (+ the container-fact rule of
server/algorithms/detection/containerFacts.ts, copied below so this file stands alone).

Idea: failures travel against the direction of calls (if A calls B and B breaks, A
starts failing too). So for every service we separate
  own        strongest evidence about the service ITSELF (cpu, memory, silence)
  symptoms   strongest evidence that can be INHERITED (latency, errors, traffic drop)
  explained  gamma x strongest evidence of any service it CALLS (a broken callee excuses its symptoms)
  score      max(own, symptoms - explained)  + 100 if the container is stopped/paused/crash-looping
A caller whose errors are explained by a broken callee sinks in the ranking. On top:
a service with no telemetry whose callers have unexplained symptoms is inferred
(blind spot); a small coverage bonus goes to services many troubled ones depend on;
the open incident's cause keeps a 15% hysteresis bonus; and if most services go
silent together we report a monitoring outage and blame nobody.

Data shapes (plain dicts):
  node    {"id","name","type","status": healthy|degraded|critical|unknown, "state","exit_code",
           "vanished","network_detached","metrics": dict or None}
  edge    {"id","source","target","observed", + the fields used by graph/edge_weights.py}  (caller -> callee)
  anomaly {"node_id","metric","z" (or None),"severity","evidence": own|symptom|hard,"timestamp",
           "observed","baseline","source"}   (evidence defaults to hard for 'container-health', else own)

Left out compared with the TypeScript: the optional learned-model ranking path, project
filtering (pass one project's nodes/edges), record ids and Date.now() bookkeeping.
Evidence items and the propagation steps are kept in a smaller form.
"""
import math
import pathlib
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from graph.edge_weights import compute_edge_weights, edge_id, js_round  # noqa: E402
from rca.explanation_engine import generate_explanation  # noqa: E402
from rca.temporal_analyzer import build_timeline  # noqa: E402


@dataclass
class Thresholds:
    """Same values as DEFAULT_THRESHOLDS in server/algorithms/detection/thresholds.ts (only those RCA uses)."""
    z_anomaly: float = 3.5               # |z| from here on is an anomaly
    z_high: float = 5.0
    z_critical: float = 8.0
    monitoring_gap_share: float = 0.8    # this share of services silent together = monitoring outage
    explain_away_gamma: float = 1.0      # 0 = plain "most abnormal", 1 = a broken callee fully excuses callers
    cascade_edge_probability: float = 0.5


EXPLAINS_WEIGHT = 0.25    # largest contribution of the coverage factor (only shown in the breakdown)
VICTIM_WEIGHT = 0.25      # shown deduction for a candidate whose dependencies fail at least as badly
MATERIAL_REACH = 0.1      # a dependency path weaker than this does not count as "explains/depends on"
INCUMBENT_BONUS = 1.15    # the open incident's cause is kept unless beaten by 15%
HARD_BONUS = 100          # a stopped container is a fact, it outranks any statistic
HARD_STRENGTH = 50        # how strongly a hard-failed service excuses its callers

# datastores and queues answer calls, they do not make them (see _split_edges)
STORE_NAME = re.compile(r"(^|[-_])(db|store|cache|redis|memcached|mongo|mongodb|postgres|mysql|queue|bus|kafka|nats|rabbitmq)([-_]|$)", re.I)
LOAD_GENERATOR = re.compile(r"(^|[-_])(traffic|user-sim|usersim|load-?gen|loadgenerator|locust|k6|jmeter|gatling|stress|wrk2?|siege|vegeta|artillery)([-_]|$)", re.I)


def round2(x):
    return js_round(x, 2)


# ---------------------------------------------------------------- container facts
def exit_code_of(node):
    """Exit code from the explicit field, or parsed from text like 'exited (137)'."""
    if isinstance(node.get("exit_code"), int):
        return node["exit_code"]
    hit = re.search(r"exited \((\d+)\)", f"{node.get('state') or ''} {node.get('status_text') or ''}", re.I)
    return int(hit.group(1)) if hit else None


def container_fact(node):
    """What the container runtime says as one fact: down / paused / restarting / detached / benign / None."""
    state = str(node.get("state") or "").lower()
    base = re.split(r"[\s(]", state)[0]
    if node.get("network_detached") and base == "running":
        return "detached"
    if base in ("paused", "restarting"):
        return base
    if base == "created":
        return "benign"      # never started: not a failure
    if base in ("exited", "dead", "removing") or state == "not found" or node.get("vanished"):
        if LOAD_GENERATOR.search(node.get("name") or ""):
            return "benign"  # people start and stop load, faults do not
        if base == "exited" and exit_code_of(node) == 0:
            return "benign"  # finished cleanly
        return "down"
    if not base and node.get("status") == "critical":
        return "down"
    return None


# ---------------------------------------------------------------- reach (who depends on whom)
def dependency_reach(root_id, edges, weight_of):
    """Strongest dependency path from every service up to root_id, as the product of edge weights (root = 1).

    Edges read caller -> callee, so a service depends on root if a chain of calls leads from it down to root.
    Max-product path by repeated relaxation; graphs have tens of nodes so this is fast enough."""
    reach = {root_id: 1.0}
    for _ in range(len(edges) + 1):
        changed = False
        for e in edges:
            if e["target"] not in reach:
                continue
            candidate = reach[e["target"]] * weight_of(e)
            if candidate > reach.get(e["source"], 0.0) + 1e-12:
                reach[e["source"]] = candidate
                changed = True
        if not changed:
            break
    return reach


def _split_edges(nodes, edges):
    """Drop self-loops and reverse views of datastore connections; return (all_edges, call_edges, callees, callers).

    Edges inferred from TCP sockets are seen from both ends (cart -> cart-store AND cart-store -> cart);
    an edge whose caller is a datastore is the reverse view of a real call and must not be used."""
    by_id = {n["id"]: n for n in nodes}

    def is_store(i):
        n = by_id.get(i)
        return bool(n) and (n.get("type") in ("database", "queue") or bool(STORE_NAME.search(n["name"])))

    ids = set(by_id)
    all_edges = [e for e in edges if e["source"] in ids and e["target"] in ids and e["source"] != e["target"]]
    call_edges = [e for e in all_edges if not (is_store(e["source"]) and not is_store(e["target"]))]
    callees, callers = {}, {}
    for e in call_edges:
        callees.setdefault(e["source"], []).append(e["target"])
        callers.setdefault(e["target"], []).append(e["source"])
    return all_edges, call_edges, callees, callers


# ---------------------------------------------------------------- the engine
def analyze_incident(target_id, nodes, edges, anomalies, thresholds=None, incumbent=None,
                     host_silent=False, learning=False, now=None):
    """Rank root causes. Returns a dict with root_cause, candidates, propagation, at_risk, confidence, explanation..."""
    t = thresholds or Thresholds()
    now = now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    by_id = {n["id"]: n for n in nodes}
    name_of = lambda i: by_id[i]["name"] if i in by_id else i  # noqa: E731

    def kind_of(a):
        return a.get("evidence") or ("hard" if a["metric"] == "container-health" else "own")

    def z_of(a):
        z = a.get("z")
        if z is not None and math.isfinite(z):
            return abs(z)
        return {"CRITICAL": t.z_critical, "HIGH": t.z_high}.get(a.get("severity"), t.z_anomaly)

    # While the baseline is still being learned only container facts count.
    anomalies = [a for a in anomalies if not learning or kind_of(a) == "hard"]
    by_node = {}
    for a in anomalies:
        by_node.setdefault(a["node_id"], []).append(a)
    recs_of = lambda i: by_node.get(i, [])  # noqa: E731

    all_edges, call_edges, callees, callers = _split_edges(nodes, edges)
    computed = compute_edge_weights(all_edges)
    weight_of = lambda e: (e.get("weight") or computed.get(edge_id(e)) or {"value": 0.5})["value"]  # noqa: E731

    # ---- per-service evidence: own / symptoms / hard
    def is_hard(n):
        # A 'critical' status on a container that still runs is not a fact about it; it counts as a symptom instead.
        fact = container_fact(n)
        return fact in ("down", "paused", "restarting", "detached") or \
            (fact != "benign" and any(kind_of(a) == "hard" for a in recs_of(n["id"])))

    own, sym, hard = {}, {}, {}
    for n in nodes:
        i = n["id"]
        own[i] = max([0.0] + [z_of(a) for a in recs_of(i) if kind_of(a) == "own"])
        if n["status"] == "degraded":
            own[i] = max(own[i], t.z_anomaly)            # collector saw cpu/memory above 80%
        hard[i] = is_hard(n)
        sym[i] = max([0.0] + [z_of(a) for a in recs_of(i) if kind_of(a) == "symptom"])
        if n["status"] == "critical" and not hard[i]:
            sym[i] = max(sym[i], t.z_critical)

    # Quiet is inherited: my silence is not my fault if a service I call broke loudly (my requests fail fast).
    for n in nodes:
        i = n["id"]
        silent = next((a for a in recs_of(i) if a["metric"] == "silence"), None)
        if silent is None:
            continue
        if any(hard[c] or sym[c] >= t.z_anomaly for c in callees.get(i, [])):
            own[i] = max([0.0] + [z_of(a) for a in recs_of(i) if kind_of(a) == "own" and a["metric"] != "silence"])
            sym[i] = max(sym[i], z_of(silent))

    def evidence(i):
        return HARD_STRENGTH if hard[i] else max(own[i], sym[i])

    # ---- monitoring outage: most services silent or vanished together
    quiet = [n["id"] for n in nodes if n.get("vanished") or any(a["metric"] == "silence" for a in recs_of(n["id"]))]
    gap = host_silent or (len(nodes) >= 3 and len(quiet) >= max(3, math.ceil(t.monitoring_gap_share * len(nodes))))
    nothing = (not any(hard.values())) if learning else \
        (not anomalies and not any(hard[n["id"]] or n["status"] == "degraded" for n in nodes))
    if nothing or gap:
        return _no_verdict(target_id, nodes, quiet, gap, host_silent, now)

    # ---- attribution: score = max(own, symptoms - explained) + hard bonus
    timeline = build_timeline(anomalies)
    raw, parts = {}, {}
    for n in nodes:
        i = n["id"]
        x = t.explain_away_gamma * max([0.0] + [evidence(c) for c in callees.get(i, [])])
        raw[i] = max(own[i], max(0.0, sym[i] - x)) + (HARD_BONUS if hard[i] else 0)
        parts[i] = {"o": own[i], "s": sym[i], "x": x, "blind": False}

    # blind spot: no telemetry at all, but its callers show symptoms nothing else explains
    for n in nodes:
        i = n["id"]
        no_data = not n.get("metrics") or all(v is None for v in n["metrics"].values())
        if not no_data or raw[i] > 0:
            continue
        # Needs corroboration: two callers past the anomaly line, or one past HIGH. One noisy caller is not enough.
        ups = [max(0.0, sym[c] - parts[c]["x"]) for c in callers.get(i, [])]
        strong = [u for u in ups if u >= t.z_anomaly]
        if len(strong) >= 2 or any(u >= t.z_high for u in ups):
            raw[i] = 0.9 * max(ups)
            parts[i]["blind"] = True

    affected = [n for n in nodes if raw[n["id"]] > 0 or sym[n["id"]] > 0]
    sort_key = lambda n: (-raw[n["id"]], n["name"].lower(), n["name"])  # noqa: E731

    # "Troubled" = visibly unwell. Coverage asks how many OTHER troubled services depend on a candidate.
    troubled = [n["id"] for n in nodes if hard[n["id"]] or n["status"] in ("critical", "degraded")
                or raw[n["id"]] >= t.z_anomaly or sym[n["id"]] >= t.z_anomaly]
    reach_cache = {}

    def reach(i):
        if i not in reach_cache:
            reach_cache[i] = dependency_reach(i, call_edges, weight_of)
        return reach_cache[i]

    coverage, depends_on_worse = {}, {}
    for n in affected:
        i = n["id"]
        coverage[i] = [o for o in troubled if o != i and reach(i).get(o, 0) >= MATERIAL_REACH]
        depends_on_worse[i] = [o for o in troubled if o != i and reach(o).get(i, 0) >= MATERIAL_REACH
                               and raw[o] >= raw[i]]
    others = max(0, len(troubled) - 1)
    for n in affected:
        share = len(coverage[n["id"]]) / others if others else 0
        # breaks ties between comparably abnormal services; never outweighs hard evidence; gamma = 0 switches it off
        raw[n["id"]] += share * t.z_anomaly * min(1, t.explain_away_gamma)

    # Hysteresis: the open incident's cause stays on top unless beaten by a clear margin.
    if incumbent and incumbent in raw and not hard[incumbent]:
        raw[incumbent] *= INCUMBENT_BONUS
    ranked = sorted(affected, key=sort_key)
    if not ranked:
        return _no_verdict(target_id, nodes, quiet, False, host_silent, now)

    top, second = ranked[0], (ranked[1] if len(ranked) > 1 else None)
    raw_top = raw[top["id"]]
    margin = 1 - (raw[second["id"]] if second else 0) / raw_top if raw_top > 0 else 0

    def to01(r):  # 0..1 display score; hard facts live in 0.9..1, statistics are capped at 0.89
        return min(1, 0.9 + (r - 100) / 500) if r >= 100 else min(0.89, r / (r + 2 * t.z_anomaly))

    candidates, evidence_items = [], []
    hard_count = sum(1 for n in ranked if hard[n["id"]])
    for n in ranked:
        i, p, r = n["id"], parts[n["id"]], raw[n["id"]]
        recs = recs_of(i)
        by_z = sorted(recs, key=lambda a: -z_of(a))
        bd = _breakdown(n, p, r, hard[i], recs, kind_of, coverage[i], depends_on_worse[i], others, name_of, z_of)

        confidence = "LOW"
        if i == top["id"]:
            observed = any((e["source"] == i or e["target"] == i) and e.get("observed") for e in all_edges)
            if (hard[i] and hard_count == 1) or (margin >= 0.5 and observed):
                confidence = "HIGH"
            elif margin >= 0.2:
                confidence = "MEDIUM"
            if others > 0 and not coverage[i]:
                confidence = "LOW"        # explains none of the others: independent problems
        elif r < 0.5 * raw_top:
            confidence = "UNKNOWN"

        candidates.append({
            "service_id": i, "service_name": n["name"], "score": round2(to01(r)), "confidence": confidence,
            "breakdown": bd, "own": round2(p["o"]), "symptoms": round2(p["s"]), "explained": round2(p["x"]),
            "primary_metric": by_z[0]["metric"] if by_z else ("container-state" if hard[i] else "inferred"),
        })
        evidence_items.append(_evidence_item(n, by_z[0] if by_z else None))

    root = candidates[0]
    overall = root["confidence"]

    # ---- propagation: root -> its callers (failures travel callee -> caller), at most 3 hops
    path, steps = [root["service_name"]], []
    frontier, visited = [root["service_id"]], {root["service_id"]}
    for _ in range(3):
        if not frontier:
            break
        nxt = []
        for cur in frontier:
            for caller_id in callers.get(cur, []):
                if caller_id in visited:
                    continue
                e = next((x for x in all_edges if x["source"] == caller_id and x["target"] == cur), None)
                # a real chain only: the caller is itself troubled and leans on this callee materially
                if e is None or caller_id not in troubled or weight_of(e) < MATERIAL_REACH:
                    continue
                visited.add(caller_id)
                path.append(name_of(caller_id))
                nxt.append(caller_id)
                steps.append({"from": cur, "to": caller_id, "edge": edge_id(e),
                              "confidence": "HIGH" if e.get("observed") else "MEDIUM"})
        frontier = nxt

    # ---- at risk: healthy services calling failing ones (noisy-OR)
    failing = {n["id"] for n in ranked if hard[n["id"]] or raw[n["id"]] >= t.z_anomaly}
    at_risk = []
    for n in nodes:
        i = n["id"]
        if i in failing:
            continue
        via = [c for c in callees.get(i, []) if c in failing]
        if not via:
            continue
        survive = 1.0
        for c in via:
            survive *= 1 - min(1, evidence(c) / (2 * t.z_anomaly)) * t.cascade_edge_probability
        at_risk.append({"service_id": i, "service_name": n["name"], "risk": round2(1 - survive),
                        "via": [name_of(c) for c in via]})
    at_risk.sort(key=lambda a: -a["risk"])

    started = timeline[0]["timestamp"] if timeline else now
    explanation = generate_explanation(target_id, started, root, candidates, [n["name"] for n in affected],
                                       path, evidence_items, overall)
    explanation["why"] = _why(root, parts[root["service_id"]], hard[root["service_id"]], by_id[root["service_id"]],
                              coverage[root["service_id"]], others)
    if at_risk:
        explanation["recommended_investigation"].append(
            "Watch next: " + ", ".join(f"{a['service_name']} ({round(a['risk'] * 100)}%)" for a in at_risk[:3]))

    return {"incident_detected": True, "root_cause": root, "candidates": candidates, "propagation": steps,
            "propagation_path": path, "affected_services": [n["id"] for n in affected], "evidence": evidence_items,
            "confidence": overall, "explanation": explanation, "at_risk": at_risk, "monitoring_gap": False}


# ---------------------------------------------------------------- wording helpers
def _no_verdict(target_id, nodes, quiet, gap, host_silent, now):
    """No root cause: either all quiet, or monitoring itself is broken (then blame no service)."""
    exp = generate_explanation(target_id, now, None, [], [], [], [], "UNKNOWN")
    if gap and host_silent:
        exp["what_happened"] = "No telemetry has arrived from this host for over two minutes. The readings on screen are the last ones received."
        exp["likely_root_cause"] = "The host is unreachable (SSH, network, stopped instance) or its collector stopped. Not a fault in the services."
        exp["why"] = "Without new data there is nothing to judge; blaming a service on frozen readings would be a guess."
    elif gap:
        exp["what_happened"] = f"{len(quiet)} of {len(nodes)} services stopped reporting at the same moment."
        exp["likely_root_cause"] = "Monitoring outage (collector, SSH session or Docker daemon), not a fault in the services."
        exp["why"] = "Independent services do not all freeze in the same few seconds; a broken telemetry path does. No service is blamed."
    names = [n["name"] for n in nodes if n["id"] in quiet] if gap and not host_silent else []
    return {"incident_detected": gap, "root_cause": None, "candidates": [], "propagation": [], "propagation_path": [],
            "affected_services": names, "evidence": [], "confidence": "UNKNOWN", "explanation": exp,
            "at_risk": [], "monitoring_gap": gap}


def _breakdown(n, p, r, is_hard_node, recs, kind_of, covered, worse, others, name_of, z_of):
    """Score contributions of one candidate, each with a plain reason (what the explanation quotes)."""
    bd = []
    if is_hard_node:
        bd.append({"factor": "hard_evidence", "score": 100,
                   "reason": f"container {n.get('state') or n['status']}: a fact, not a degree"})
    if p["o"] > 0:
        metrics = ", ".join(a["metric"] for a in recs if kind_of(a) == "own") or "resource pressure"
        bd.append({"factor": "own_evidence", "score": round2(p["o"]),
                   "reason": f"its own signals are {round2(p['o'])}x their normal wobble ({metrics})"})
    if p["s"] > 0:
        metrics = ", ".join(a["metric"] for a in recs if kind_of(a) == "symptom")
        bd.append({"factor": "symptoms", "score": round2(p["s"]),
                   "reason": f"errors / latency / traffic {round2(p['s'])}x normal ({metrics})"})
    if p["x"] > 0 and p["s"] > 0:
        excused = round2(min(p["x"], p["s"]))
        bd.append({"factor": "likely_victim", "score": -excused,
                   "reason": f"a service it calls is broken and explains {excused} of those symptoms"})
    if covered and others:
        sc = round2(EXPLAINS_WEIGHT * len(covered) / others)
        if sc >= 0.01:
            bd.append({"factor": "explains_failures", "score": sc,
                       "reason": f"{len(covered)} of the {others} other affected services depend on it ({', '.join(name_of(c) for c in covered)})"})
    if worse:
        bd.append({"factor": "dependency_failing", "score": -VICTIM_WEIGHT,
                   "reason": f"it depends on {', '.join(name_of(w) for w in worse)}, which {'are' if len(worse) > 1 else 'is'} failing at least as badly"})
    if p["blind"]:
        bd.append({"factor": "blind_spot", "score": round2(r),
                   "reason": "no telemetry from it, while the services calling it show errors nothing else explains"})
    return bd


def _evidence_item(n, strongest):
    if strongest is None:
        state = f" ({n['state']})" if n.get("state") else ""
        return {"metric": "container-state", "source": "container-runtime", "before": "running",
                "after": f"{n['status']}{state}", "description": f"'{n['name']}': {n['status']}{state}"}
    one = lambda v: js_round(v, 1)  # noqa: E731
    desc = f"{strongest['metric']} at {one(strongest['observed'])} against a baseline of {one(strongest['baseline'])}"
    return {"metric": strongest["metric"], "source": strongest.get("source", "unknown"),
            "before": f"baseline {one(strongest['baseline'])}", "after": f"{one(strongest['observed'])}", "description": desc}


def _why(root, p, is_hard_node, node, covered, others):
    name = root["service_name"]
    if is_hard_node:
        base = f"{name} is {node.get('state') or 'down'}: hard evidence."
    elif p["blind"]:
        base = f"{name} sends no telemetry while the services calling it fail with nothing else to explain it."
    else:
        base = (f"{name} has the strongest evidence that is not explained by anything it depends on "
                f"(own {round2(p['o'])}, unexplained symptoms {round2(max(0, p['s'] - p['x']))}).")
    if others == 0:
        return base
    if not covered:
        plural = others > 1
        return (f"{base} None of the {others} other affected service{'s' if plural else ''} depend{'' if plural else 's'} on {name}, "
                f"so these look like independent problems; treat the ranking with care.")
    return f"{base} {len(covered)} of the {others} other affected services depend on it."


if __name__ == "__main__":
    # web -> orders -> orders-db. The db container died; orders and web show errors as a consequence.
    demo_nodes = [
        {"id": "web", "name": "web", "status": "degraded", "metrics": {"cpu": 12}},
        {"id": "orders", "name": "orders", "status": "healthy", "metrics": {"cpu": 30}},
        {"id": "orders-db", "name": "orders-db", "status": "critical", "state": "exited (137)", "metrics": {"cpu": 0}},
        {"id": "mail", "name": "mail", "status": "healthy", "metrics": {"cpu": 2}},
    ]
    demo_edges = [{"id": "e1", "source": "web", "target": "orders", "observed": True, "evidence_sources": ["http-log"]},
                  {"id": "e2", "source": "orders", "target": "orders-db", "observed": True, "evidence_sources": ["http-log"]},
                  {"id": "e3", "source": "web", "target": "mail", "observed": True, "evidence_sources": ["http-log"]}]
    demo_anoms = [
        {"node_id": "orders", "metric": "error-rate", "z": 7.0, "severity": "HIGH", "evidence": "symptom",
         "timestamp": "2026-01-01T10:00:05Z", "observed": 22.0, "baseline": 0.5},
        {"node_id": "web", "metric": "latency", "z": 4.0, "severity": "MEDIUM", "evidence": "symptom",
         "timestamp": "2026-01-01T10:00:10Z", "observed": 900, "baseline": 120},
        {"node_id": "orders-db", "metric": "container-health", "z": None, "severity": "CRITICAL",
         "timestamp": "2026-01-01T10:00:00Z", "observed": 0, "baseline": 1},
    ]
    out = analyze_incident("shop", demo_nodes, demo_edges, demo_anoms, now="2026-01-01T10:01:00Z")
    print("confidence:", out["confidence"], "| path:", " -> ".join(out["propagation_path"]))
    for c in out["candidates"]:
        print(f"  {c['service_name']:10} score={c['score']:<5} {c['confidence']:8} own={c['own']} sym={c['symptoms']} explained={c['explained']}")
    print("at risk:", out["at_risk"])
    print("why:", out["explanation"]["why"])
