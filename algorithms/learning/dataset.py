"""Turn one recorded run into labelled rows (one row per service per moment).

Question answered: which rows are "faulty" (label 1) and which are "fine" (label 0), and
which rows must be thrown away because the label would be unfair?

Mirrors: server/algorithms/learning/dataset.ts

Idea: a run is a list of moments. A moment has a timestamp, the services seen, one feature
vector per service, and what the live rule-based mapper said at that time. A row is positive
when its service is the target of a fault that is active at that moment. We skip the first
warm-up minutes (baselines are still forming) and the minute after each fault ends (the
service is recovering, neither clearly faulty nor fine). Times are in milliseconds.

Left out: parsing the ledger/observer text files and building the features from raw metrics
(buildRun in the TS). Here the caller gives already computed feature vectors. The real
feature list lives in server/algorithms/detection/features.ts; its names are copied below.
"""
from dataclasses import dataclass, field, replace

FEATURE_NAMES = [
    "own", "symptom", "cpu", "memory", "throttle", "netDrop", "reqDrop", "errRise", "latRise",
    "down", "paused", "restarting", "detached",
    "callersSymptomMax", "callersSymptomMean", "calleesEvidenceMax", "hasRequests", "noData",
]

DEFAULT_HISTORY = 120      # samples kept per service when features are built (~15 min); used only upstream
DEFAULT_MIN_HISTORY = 12


@dataclass
class Fault:
    id: str
    cls: str                 # fault class, e.g. "crash", "brownout"
    target: str              # service the fault is applied to
    a: int                   # applied at (ms)
    b: int                   # healed at (ms)
    expected_affected: list = field(default_factory=list)   # services that depend on the target


@dataclass
class Moment:
    ts: int
    services: list
    X: list                  # one feature row per service, same order as `services`
    live_alarm: bool = False  # what the live rules said (the baseline to beat)
    live_root: str = None
    live_top3: list = field(default_factory=list)


@dataclass
class Run:
    name: str
    subject: str             # which system/bench this run came from
    faults: list
    moments: list
    t0: int = 0
    t1: int = 0


def make_run(name, subject, faults, moments):
    """Build a Run and fill t0/t1 from the first and last moment."""
    t0 = moments[0].ts if moments else 0
    t1 = moments[-1].ts if moments else 0
    return Run(name, subject, faults, moments, t0, t1)


def labelled_rows(run, warmup_sec=300, recovery_sec=60, keep=None):
    """Return (X, y, ts). `keep(ts)` can restrict to some times (used by cross-validation)."""
    warm = run.t0 + warmup_sec * 1000
    rec = recovery_sec * 1000
    X, y, ts = [], [], []
    for m in run.moments:
        if m.ts < warm or (keep and not keep(m.ts)):
            continue
        # recovering window: leave the whole moment out
        if any(f.b < m.ts <= f.b + rec for f in run.faults):
            continue
        active = [f for f in run.faults if f.a <= m.ts <= f.b]
        for i, sid in enumerate(m.services):
            X.append(m.X[i])
            y.append(1 if any(f.target == sid for f in active) else 0)
            ts.append(m.ts)
    return X, y, ts


def slice_run(run, start, end):
    """The part of a run in [start, end), for blocked cross-validation.
    Features were already computed from the full past, so nothing is recomputed."""
    return replace(run,
                   moments=[m for m in run.moments if start <= m.ts < end],
                   faults=[f for f in run.faults if start <= f.a < end])


def synthetic_run(name="demo", subject="benchA", minutes=40, seed=0, faults=None):
    """Small fake run for demos and tests: 3 services, 5 s apart, 18 features each."""
    import random
    rng = random.Random(seed)
    services = ["api", "db", "cache"]
    faults = faults if faults is not None else [Fault("f1", "crash", "db", 15 * 60000, 20 * 60000, ["api"]),
                                                Fault("f2", "brownout", "cache", 28 * 60000, 33 * 60000, ["api"])]
    moments = []
    for k in range(minutes * 12):
        ts = k * 5000
        rows = []
        for s in services:
            row = [abs(rng.gauss(0, 0.3)) for _ in FEATURE_NAMES]
            if any(f.a <= ts <= f.b and f.target == s for f in faults):
                row[0] += 3          # "own"
                row[2] += 2          # "cpu"
            rows.append(row)
        alarm = any(f.a <= ts <= f.b for f in faults)
        moments.append(Moment(ts, services, rows, alarm, None, []))
    return make_run(name, subject, faults, moments)


if __name__ == "__main__":
    run = synthetic_run()
    X, y, ts = labelled_rows(run)
    print(f"moments={len(run.moments)}  rows kept={len(X)}  positives={sum(y)}  features per row={len(X[0])}")
    first = slice_run(run, run.t0, run.t0 + 20 * 60000)
    print(f"first 20 minutes: {len(first.moments)} moments, {len(first.faults)} fault(s) starting inside")
