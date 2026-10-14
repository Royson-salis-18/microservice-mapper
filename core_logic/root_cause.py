"""Step 2: several services look unhealthy. Which one is the cause?

Failures travel against the direction of calls: if `checkout` calls `payments` and payments breaks,
checkout starts to fail too. So a service whose symptoms are explained by a broken dependency is a victim.

For every service we collect:
  own      worst abnormal score of things about the service itself (cpu, memory)
  symptom  worst abnormal score of things it can inherit (latency, errors, dropping traffic)
  explained  how broken the services it calls are (they excuse its symptoms)
  hard     the container is stopped / paused / crash-looping (a fact, not a statistic)

  score = max(own, symptom - explained) + 100 if hard

The highest score is the likely root cause. A tiny bonus goes to services that many other troubled
services depend on, and the incumbent verdict is kept unless beaten clearly (so the answer does not flicker).
"""
import settings as cfg

MATERIAL_REACH = 0.1     # a path weaker than this does not count as "depends on"


def evidence_of_service(service):
    """Split a service's findings into own / symptom strength."""
    own = max([f["score"] for f in service["findings"] if f["kind"] == "own"], default=0.0)
    symptom = max([f["score"] for f in service["findings"] if f["kind"] == "symptom"], default=0.0)
    if service.get("status") == "degraded":
        own = max(own, cfg.Z_ALARM)               # the collector saw CPU/memory above its absolute limit
    return own, symptom


def reach_from(root, calls):
    """How strongly a failure at `root` can reach every service that (indirectly) calls it.

    calls: list of (caller, callee, weight). The strength of a chain is the product of its weights;
    we keep the strongest chain per service. 1.0 means the service itself.
    """
    reach = {root: 1.0}
    for _ in range(len(calls) + 1):
        changed = False
        for caller, callee, weight in calls:
            if callee in reach and reach[callee] * weight > reach.get(caller, 0.0) + 1e-12:
                reach[caller] = reach[callee] * weight
                changed = True
        if not changed:
            break
    return reach


def rank_root_causes(services, calls, incumbent=None):
    """services: {name: {"status", "hard", "has_data", "findings": [...]}}; calls: [(caller, callee, weight)].

    Returns a list of {"service", "score", "own", "symptom", "explained", "hard"} best first.
    """
    callees = {}
    callers = {}
    for caller, callee, _ in calls:
        callees.setdefault(caller, []).append(callee)
        callers.setdefault(callee, []).append(caller)

    own, symptom, hard = {}, {}, {}
    for name, svc in services.items():
        own[name], symptom[name] = evidence_of_service(svc)
        hard[name] = bool(svc.get("hard"))

    def strength(name):
        return 50.0 if hard[name] else max(own[name], symptom[name])

    # 1. base score: own evidence, or symptoms that no dependency explains
    explained, score = {}, {}
    for name in services:
        explained[name] = cfg.EXPLAIN_AWAY * max([strength(c) for c in callees.get(name, [])], default=0.0)
        base = max(own[name], max(0.0, symptom[name] - explained[name]))
        score[name] = base + (cfg.HARD_FACT_BONUS if hard[name] else 0)

    # 2. blind spot: no data at all, but at least two callers have symptoms nothing else explains
    for name, svc in services.items():
        if svc.get("has_data", True) or score[name] > 0:
            continue
        unexplained = [max(0.0, symptom[c] - explained[c]) for c in callers.get(name, [])]
        if len([u for u in unexplained if u >= cfg.Z_ALARM]) >= 2 or any(u >= cfg.Z_HIGH for u in unexplained):
            score[name] = 0.9 * max(unexplained)

    # 3. coverage bonus: how many other troubled services depend on this one?
    troubled = [n for n in services if hard[n] or score[n] >= cfg.Z_ALARM or services[n].get("status") in ("critical", "degraded")]
    others = max(0, len(troubled) - 1)
    for name in services:
        if score[name] <= 0 or not others:
            continue
        reach = reach_from(name, calls)
        covered = [t for t in troubled if t != name and reach.get(t, 0.0) >= MATERIAL_REACH]
        score[name] += len(covered) / others * cfg.Z_ALARM * min(1.0, cfg.EXPLAIN_AWAY)

    # 4. keep the current verdict unless something beats it clearly
    if incumbent in score and not hard[incumbent]:
        score[incumbent] *= cfg.INCUMBENT_BONUS

    ranked = [{"service": n, "score": round(score[n], 2), "own": round(own[n], 2), "symptom": round(symptom[n], 2),
               "explained": round(explained[n], 2), "hard": hard[n]} for n in services if score[n] > 0]
    ranked.sort(key=lambda r: (-r["score"], r["service"]))
    return ranked


def confidence(ranked):
    """HIGH when the winner is far ahead (or the only stopped container), MEDIUM when ahead, else LOW."""
    if not ranked:
        return "UNKNOWN"
    top = ranked[0]
    if top["hard"] and sum(1 for r in ranked if r["hard"]) == 1:
        return "HIGH"
    second = ranked[1]["score"] if len(ranked) > 1 else 0.0
    margin = 1 - second / top["score"] if top["score"] > 0 else 0.0
    return "HIGH" if margin >= 0.5 else "MEDIUM" if margin >= 0.2 else "LOW"


def monitoring_outage(services, silent_share=0.8):
    """If most services go quiet at the same moment, our monitoring broke. Blame nobody."""
    quiet = [n for n, s in services.items() if any(f["metric"] == "silence" for f in s["findings"])]
    return len(services) >= 3 and len(quiet) >= max(3, silent_share * len(services))
