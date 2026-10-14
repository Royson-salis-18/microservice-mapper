"""The ML engine in one file: learn each service's normal with an Isolation Forest, find the source with a random walk.

Run it:  python3 algorithms/ml_engine.py

The real code the app runs is server/algorithms/ml/ (TypeScript). This is the same logic, shortened.

STEP 1  Learn normal, per service, on a sliding window
  - Keep the last WINDOW readings of the service that were judged NORMAL.
  - Every RETRAIN_EVERY new normal readings, rebuild an Isolation Forest on that window.
  - A new reading is scored by the forest built BEFORE it arrived (it never judges itself).
  - If the reading is above the service's alarm line it is NOT added to the window,
    so a fault never becomes the new normal.

STEP 2  Isolation Forest score
  Random trees keep cutting the data at random values until each point is alone.
  Odd points get isolated after few cuts.   score = 2 ** (-average_cuts / c(n))
  level = (score - typical) / (line - typical): 0 = typical, 1 = on the alarm line.
  A range guard adds: how far the value is outside anything seen in training.

STEP 3  Facts before guesses
  A container that is down, paused, restarting or cut off from the network is a fact, not a guess: it goes first.
  Two cases the plain state misses, both found by testing:
    - `docker stop` exits with code 0, which looks like a finished one-shot job. A service that had been
      running and then exits is stopped.
    - A crash loop looks healthy between kills. Two outages within 3 minutes make it a crash loop, and it
      stays the prime suspect for a minute after the last one.

STEP 4  Find the source: random walk (personalised PageRank, MonitorRank style)
  A walker starts on anomalous services and keeps moving:
    to a service it calls      with weight  anomaly(callee)          (follow the trouble down)
    back to a caller           with weight  0.2 * anomaly(caller)    (do not get stuck)
    stays where it is          with weight  anomaly(self) - worst anomaly of what it calls
  The service where the walker spends most time is the root cause.
"""
import math
import random

WINDOW, MIN_TRAIN, RETRAIN_EVERY = 120, 30, 10
TREES, SAMPLE = 100, 64
LINE_K, RANGE_K, FLOOR = 3.0, 3.0, 0.15      # alarm line = typical + 3 robust spreads; range guard in floors


# ---------------------------------------------------------------- Isolation Forest
def c(n):
    """Average number of cuts to isolate a point among n (the normaliser)."""
    if n <= 1:
        return 0.0
    if n == 2:
        return 1.0
    return 2 * (math.log(n - 1) + 0.5772156649) - 2 * (n - 1) / n


def grow(points, depth, limit, rnd):
    if depth >= limit or len(points) <= 1:
        return {"size": len(points)}
    dims = [d for d in range(len(points[0])) if max(p[d] for p in points) > min(p[d] for p in points)]
    if not dims:
        return {"size": len(points)}
    d = rnd.choice(dims)
    lo, hi = min(p[d] for p in points), max(p[d] for p in points)
    cut = rnd.uniform(lo, hi)
    return {"d": d, "cut": cut,
            "left": grow([p for p in points if p[d] < cut], depth + 1, limit, rnd),
            "right": grow([p for p in points if p[d] >= cut], depth + 1, limit, rnd)}


def path_length(x, node, depth=0):
    if "size" in node:
        return depth + c(node["size"])
    return path_length(x, node["left"] if x[node["d"]] < node["cut"] else node["right"], depth + 1)


class Forest:
    def __init__(self, points, seed=7):
        rnd = random.Random(seed)
        self.n = min(SAMPLE, len(points))
        limit = math.ceil(math.log2(max(2, self.n)))
        self.trees = [grow(rnd.sample(points, self.n), 0, limit, rnd) for _ in range(TREES)]

    def score(self, x):
        avg = sum(path_length(x, t) for t in self.trees) / len(self.trees)
        return 2 ** (-avg / c(self.n))


# ---------------------------------------------------------------- one service's learned baseline
def median(xs):
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


class ServiceBaseline:
    def __init__(self, seed=1):
        self.window, self.forest, self.since, self.seed = [], None, 0, seed

    def fit(self):
        rnd = random.Random(self.seed)
        train = [[v + rnd.gauss(0, FLOOR / 2) for v in x] for x in self.window]   # small noise: constant features still get a range
        self.forest = Forest(train, seed=self.seed)
        scores = [self.forest.score(x) for x in train]
        self.typical = median(scores)
        spread = 1.4826 * median([abs(s - self.typical) for s in scores])
        self.line = max(self.typical + LINE_K * spread, self.typical + 0.02)
        self.lo = [min(x[d] for x in self.window) for d in range(len(self.window[0]))]
        self.hi = [max(x[d] for x in self.window) for d in range(len(self.window[0]))]
        self.since = 0

    def observe(self, x):
        """Score x against the model built before it, then learn from it only if it is normal."""
        level = 0.0
        if self.forest:
            level = max(0.0, (self.forest.score(x) - self.typical) / (self.line - self.typical))
            beyond = max(max(0.0, v - h, l - v) for v, l, h in zip(x, self.lo, self.hi))
            level = max(level, beyond / (FLOOR * RANGE_K))          # range guard
        if not self.forest or level < 1:                            # the gate: only normal readings are learned
            self.window = (self.window + [x])[-WINDOW:]
            self.since += 1
            if (not self.forest and len(self.window) >= MIN_TRAIN) or (self.forest and self.since >= RETRAIN_EVERY):
                self.fit()
        return level


# ---------------------------------------------------------------- facts: stopped and crash-looping containers
LOOP_WINDOW, LOOP_HOLD, RAN_FOR = 36, 12, 12          # in readings of 5 s: 3 minutes, 1 minute, 1 minute


class ContainerFacts:
    def __init__(self):
        self.running_for, self.outages, self.since_down, self.was_down, self.clock = {}, {}, {}, {}, 0

    def tick(self):
        self.clock += 1

    def judge(self, name, state, exit_code=None):
        """Returns None (no fact), 'down', 'stopped' or 'crash loop'. Call tick() once per reading round first."""
        if state == "running":
            self.running_for[name] = self.running_for.get(name, 0) + 1
        down = state in ("exited", "dead", "paused", "restarting")
        label = None
        if down:
            label = "down"
            if state == "exited" and exit_code == 0:      # docker stop, or a one-shot job that finished
                label = "stopped" if self.running_for.get(name, 0) >= RAN_FOR else None
                down = label is not None
        recent = [t for t in self.outages.get(name, []) if self.clock - t <= LOOP_WINDOW]
        if down and not self.was_down.get(name):
            recent.append(self.clock)
        self.outages[name], self.was_down[name] = recent, down
        self.since_down[name] = 0 if down else self.since_down.get(name, 10 ** 9) + 1
        if not down and len(recent) >= 2 and self.since_down[name] <= LOOP_HOLD:
            label = "crash loop"
        return label


# ---------------------------------------------------------------- random walk for the root cause
def root_cause_walk(anomaly, calls, alpha=0.15, rho=0.2, steps=60):
    """anomaly: {service: 0..1}; calls: [(caller, callee)]. Returns {service: share of the walk}."""
    names = list(anomaly)
    total = sum(anomaly.values())
    if total == 0:
        return {n: 0.0 for n in names}
    rows = {}
    for u in names:
        moves = {}
        callees = [v for a, v in calls if a == u]
        for v in callees:
            moves[v] = moves.get(v, 0) + anomaly[v]
        for a, v in calls:
            if v == u:
                moves[a] = moves.get(a, 0) + rho * anomaly[a]
        moves[u] = moves.get(u, 0) + max(0.0, anomaly[u] - max([anomaly[v] for v in callees], default=0.0))
        s = sum(moves.values())
        rows[u] = {k: w / s for k, w in moves.items()} if s > 0 else {u: 1.0}
    restart = {n: anomaly[n] / total for n in names}
    pi = dict(restart)
    for _ in range(steps):
        nxt = {n: alpha * restart[n] for n in names}
        for u in names:
            for v, p in rows[u].items():
                nxt[v] += (1 - alpha) * pi[u] * p
        pi = nxt
    return pi


if __name__ == "__main__":
    rnd = random.Random(3)
    services = ["web", "orders", "db"]
    models = {s: ServiceBaseline(seed=i) for i, s in enumerate(services)}
    reading = lambda s, broken: [math.log(10.5 + rnd.gauss(0, 0.3)) + (1.5 if broken and s == "db" else 0),
                                 math.log(41 + rnd.gauss(0, 0.5)) + (1.0 if broken and s != "db" else 0)]
    for t in range(80):                                     # 80 normal readings: the forests learn
        for s in services:
            models[s].observe(reading(s, broken=False))
    levels = {s: models[s].observe(reading(s, broken=True)) for s in services}   # db breaks, callers feel it
    anomaly = {s: (0.0 if lv < 0.5 else min(1.0, lv / 2)) for s, lv in levels.items()}
    ranking = root_cause_walk(anomaly, [("web", "orders"), ("orders", "db")])
    print("levels (1 = alarm line):", {s: round(v, 2) for s, v in levels.items()})
    print("root-cause ranking:", sorted(((round(p, 3), s) for s, p in ranking.items()), reverse=True))
