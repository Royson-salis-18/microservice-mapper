"""Step 3: who is likely to fail NEXT?

Every service gets a starting failure probability p0 from what we measure (stopped container = 1.0,
degraded = 0.5, abnormal evidence adds some). Then risk flows from callee to caller:

    P(service) = 1 - (1 - p0) * product over each callee c of (1 - TRANSMISSION * weight * P(c))

Read it as "the service survives only if it survives on its own AND survives every dependency".
TRANSMISSION (0.7) is below 1 because retries, timeouts and caches stop some failures from spreading.
Because services can call each other in loops we repeat the calculation until the numbers stop changing.
"""
import settings as cfg

ANOMALY_WEIGHT = 0.3             # one abnormal reading adds this much to p0
PERSISTENT_ANOMALY_WEIGHT = 0.8  # a sustained one adds more


def starting_probability(service):
    p = cfg.STATUS_PROBABILITY.get(service.get("status", "unknown"), 0.0)
    if service.get("hard"):
        p = 1.0
    if service.get("findings"):
        p = max(p, PERSISTENT_ANOMALY_WEIGHT * min(1.0, max(f["score"] for f in service["findings"]) / (2 * cfg.Z_ALARM)))
    return p


def predict_cascade(services, calls, tau=cfg.TRANSMISSION):
    """Returns {service: probability of failing}, solved by repeating until nothing changes."""
    p0 = {n: starting_probability(s) for n, s in services.items()}
    prob = dict(p0)
    for _ in range(200):
        biggest_change = 0.0
        for name in services:
            survive = 1.0 - p0[name]
            for caller, callee, weight in calls:
                if caller == name:
                    survive *= 1.0 - tau * weight * prob[callee]
            new = 1.0 - survive
            biggest_change = max(biggest_change, abs(new - prob[name]))
            prob[name] = new
        if biggest_change < 1e-6:
            break
    return {n: round(p, 3) for n, p in prob.items()}, p0


def at_risk(services, calls, tau=cfg.TRANSMISSION):
    """Services that look fine themselves but are expected to be dragged down through a dependency."""
    prob, p0 = predict_cascade(services, calls, tau)
    risky = []
    for name in services:
        if p0[name] < cfg.AT_RISK_MIN <= prob[name]:
            via = [callee for caller, callee, _ in calls if caller == name and prob[callee] >= cfg.AT_RISK_MIN]
            risky.append({"service": name, "probability": prob[name], "via": via})
    return sorted(risky, key=lambda r: -r["probability"])


def what_if(service_to_fail, services, calls, tau=cfg.TRANSMISSION):
    """If this one service failed from an otherwise healthy system, who would suffer and how much?"""
    healthy = {n: {"status": "healthy", "findings": [], "hard": False} for n in services}
    healthy[service_to_fail] = {"status": "critical", "findings": [], "hard": True}
    prob, _ = predict_cascade(healthy, calls, tau)
    return {n: p for n, p in prob.items() if n != service_to_fail and p > 0.01}
