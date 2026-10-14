"""Cascading failure in one small file: who is likely to fail next?

Run it:  python3 algorithms/cascading_failure.py
Explained in cascading_failure.md. The longer version is detailed/graph/cascade_engine.py.

The idea
  - Every service has a starting failure chance p0 from what we measure right now.
  - A service that CALLS a failing service is at risk, because its calls will fail.
  - How much risk passes along a call depends on:
        weight   how much the caller depends on that service (0 to 1)
        TAU      the share of a failure that really gets through (retries, timeouts
                 and caches stop some of it), 0.7 here

    chance(service) = 1 - (1 - p0) * product of (1 - TAU * weight * chance(callee))

  Read it as: the service survives only if it survives on its own AND survives every
  service it calls. Services can call each other in a loop, so we repeat the sum until
  the numbers stop changing.
"""

TAU = 0.7

# starting chance of failure by status; no data (unknown) is not evidence, so 0
START = {"critical": 1.0, "degraded": 0.5, "healthy": 0.0, "unknown": 0.0}


def predict(status, calls):
    """status: {service: "healthy" | "degraded" | "critical"}
    calls:  list of (caller, callee, weight)
    returns {service: chance of failing, 0 to 1}"""
    p0 = {name: START[s] for name, s in status.items()}
    chance = dict(p0)
    for _ in range(200):                     # repeat until nothing changes
        biggest_change = 0.0
        for name in status:
            survive = 1 - p0[name]
            for caller, callee, weight in calls:
                if caller == name:
                    survive *= 1 - TAU * weight * chance[callee]
            new = 1 - survive
            biggest_change = max(biggest_change, abs(new - chance[name]))
            chance[name] = new
        if biggest_change < 1e-6:
            break
    return chance


def at_risk(status, calls):
    """Services that look fine themselves (p0 below 0.15) but are likely to be dragged down."""
    chance = predict(status, calls)
    return {n: round(c, 3) for n, c in chance.items() if START[status[n]] < 0.15 <= c}


def what_if(failed, status, calls):
    """Pretend everything is healthy except `failed`. Who suffers, and how much?"""
    pretend = {name: "healthy" for name in status}
    pretend[failed] = "critical"
    chance = predict(pretend, calls)
    return {n: round(c, 3) for n, c in chance.items() if n != failed and c > 0.01}


if __name__ == "__main__":
    # web calls orders (weight 0.8) and mail (0.2); orders calls db (0.9)
    calls = [("web", "orders", 0.8), ("orders", "db", 0.9), ("web", "mail", 0.2)]
    status = {"web": "healthy", "orders": "degraded", "db": "critical", "mail": "healthy"}

    print("chance of failing:", {n: round(c, 3) for n, c in predict(status, calls).items()})
    print("at risk (look fine, but exposed):", at_risk(status, calls))
    print("what if db alone failed:", what_if("db", status, calls))
