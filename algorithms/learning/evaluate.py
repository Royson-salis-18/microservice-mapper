"""Judge a scorer the way an operator would feel it: per fault and per alarm, not per row.

Question answered: if this scorer were running live, how many faults would it catch, would
it name the right service, how late, and how often would it page someone for nothing?

Mirrors: server/algorithms/learning/evaluate.ts

Idea: a scorer gives one number per service per moment. The top score of a moment is the
"alarm level". An alarm needs the level to stay at or above the threshold for `persistence`
consecutive moments (one spike pages nobody). A fault is "detected" if an alarm happens
during it (or within grace seconds after) and the top three services include the faulted
one or something that depends on it. "Top-1" means that at the last alarming moment before
the fault healed, the best-scored service really was the faulted one. A false alarm is an
alarm episode that touches no fault window, counted per hour of fault-free time after warm-up.
Threshold choice: try quantiles of the observed top scores and keep the best F-score-like
objective (training data only).

Left out: TS types. 'live' mode (the rule-based mapper as recorded) is kept: it uses the
recorded alarm flag instead of a score and has no persistence rule. Note the TS calls it with
threshold 0, which makes every moment count as hot there; pass 0.5 for the intended meaning.
"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from evaluation.stats import wilson
from learning.dataset import synthetic_run


def median(xs):
    """Upper median, like the TS: sorted[len // 2]."""
    if not xs:
        return float("nan")
    return sorted(xs)[len(xs) // 2]


def prepare(runs, scores):
    """Sort services once per moment so many thresholds can be tried cheaply.
    `scores(run_index, moment_index)` returns one score per service of that moment."""
    top = []
    for ri, run in enumerate(runs):
        per_run = []
        for mi, m in enumerate(run.moments):
            sc = scores(ri, mi)
            order = sorted(zip(m.services, sc), key=lambda t: -t[1])   # stable, like JS sort
            per_run.append({"max": order[0][1] if order else 0, "ranked": [o[0] for o in order]})
        top.append(per_run)
    return {"runs": runs, "top": top}


def live_top(runs):
    """The recorded rule-based mapper: max is 1 when it alarmed, ranking is root then its top3."""
    out = []
    for run in runs:
        per_run = []
        for m in run.moments:
            ranked = [m.live_root] + [x for x in m.live_top3 if x != m.live_root] if m.live_root else list(m.live_top3)
            per_run.append({"max": 1 if m.live_alarm else 0, "ranked": ranked})
        out.append(per_run)
    return out


def evaluate_prepared(prep, threshold, grace_sec=60, warmup_sec=300, persistence=2, live_runs=None):
    live = prep == "live"
    runs = live_runs if live else prep["runs"]
    top = live_top(runs) if live else prep["top"]
    grace, warmup = grace_sec * 1000, warmup_sec * 1000
    K = max(1, persistence)
    outcomes, false_alarms, fp_ms = [], 0, 0

    for ri, run in enumerate(runs):
        n, t = len(run.moments), top[ri]
        hot = [x["max"] >= threshold for x in t]
        # persistence: this and the K-1 previous moments must all be hot
        alarm = [h if live else (h and i >= K - 1 and all(hot[i - K + 1:i])) for i, h in enumerate(hot)]
        windows = [(f.a, f.b + grace) for f in run.faults]

        for f in run.faults:
            touches = {f.target, *f.expected_affected}
            first, settled = None, None
            for i in range(n):
                ts = run.moments[i].ts
                if ts < f.a or ts > f.b + grace or not alarm[i]:
                    continue
                if not any(x in touches for x in t[i]["ranked"][:3]):
                    continue                      # alarm is about something else
                if first is None:
                    first = ts
                if ts <= f.b:                     # keep the LAST ranking before healing
                    settled = t[i]["ranked"][0] if t[i]["ranked"] else None
            isolated = not any(o is not f and o.a < f.b + 30000 and o.b > f.a for o in run.faults)
            outcomes.append({"run": run.name, "id": f.id, "class": f.cls, "target": f.target,
                             "detected": first is not None, "top1": settled == f.target,
                             "delay_sec": None if first is None else max(0, (first - f.a) / 1000),
                             "predicted": settled, "isolated": isolated})

        # alarm episodes = runs of consecutive alarming moments
        i = 0
        while i < n:
            if not alarm[i]:
                i += 1
                continue
            j = i
            while j + 1 < n and alarm[j + 1]:
                j += 1
            s, e = run.moments[i].ts, run.moments[j].ts
            if s >= run.t0 + warmup and not any(s <= b and e >= a for a, b in windows):
                false_alarms += 1
            i = j + 1
        # fault-free time after warm-up, the denominator of false alarms per hour
        for k in range(1, n):
            ts = run.moments[k].ts
            if ts < run.t0 + warmup:
                continue
            if not any(a <= ts <= b for a, b in windows):
                fp_ms += ts - run.moments[k - 1].ts

    det = [o for o in outcomes if o["detected"]]
    fp_hours = fp_ms / 3.6e6
    return {"faults": outcomes,
            "detected": wilson(len(det), len(outcomes)),
            "top1": wilson(sum(o["top1"] for o in det), len(det)),
            "top1_all": wilson(sum(o["top1"] for o in outcomes), len(outcomes)),
            "false_alarms": false_alarms, "fp_hours": fp_hours,
            "per_hour": false_alarms / fp_hours if fp_hours else 0,
            "median_delay": median([o["delay_sec"] for o in det])}


def evaluate(runs, scores, threshold, **opts):
    if scores == "live":
        return evaluate_prepared("live", threshold, live_runs=runs, **opts)
    return evaluate_prepared(prepare(runs, scores), threshold, **opts)


def objective(r):
    """Harmonic mean of 'caught with the right service first' and 'alarms that were real'."""
    nf = len(r["faults"])
    caught = sum(1 for f in r["faults"] if f["detected"] and f["top1"]) / nf if nf else 0
    detected = sum(1 for f in r["faults"] if f["detected"])
    episodes = detected + r["false_alarms"]
    precision = detected / episodes if episodes else 0
    return 2 * caught * precision / (caught + precision) if caught + precision else 0


def tune_threshold(runs, scores, candidates=60, **opts):
    """Choose the alarm threshold on TRAINING runs only. Candidates are quantiles (50%..100%)
    of the top scores seen, because lower thresholds would alarm almost all the time."""
    prep = prepare(runs, scores)
    allmax = sorted(x["max"] for t in prep["top"] for x in t)
    if not allmax:
        return {"threshold": 0.5, "objective": -1, "curve": []}
    last = len(allmax) - 1
    cands = []
    for k in range(candidates):
        v = allmax[min(last, int((0.5 + 0.5 * k / (candidates - 1)) * last))]
        if v not in cands:
            cands.append(v)
    best = {"threshold": cands[-1], "objective": -1}
    curve = []
    for th in cands:
        r = evaluate_prepared(prep, th, **opts)
        obj = objective(r)
        curve.append({"threshold": th, "objective": obj, "detected": r["detected"]["p"],
                      "top1": r["top1"]["p"], "per_hour": r["per_hour"]})
        if obj > best["objective"] + 1e-9:       # strictly better only: ties keep the lower threshold
            best = {"threshold": th, "objective": obj}
    return {**best, "curve": curve}


if __name__ == "__main__":
    run = synthetic_run(minutes=40)
    # a hand-made scorer: 'own' feature plus a bit of 'cpu'
    scorer = lambda ri, mi: [r[0] + 0.5 * r[2] for r in run.moments[mi].X]
    tuned = tune_threshold([run], scorer)
    res = evaluate([run], scorer, tuned["threshold"])
    print(f"chosen threshold {tuned['threshold']:.2f} (objective {tuned['objective']:.2f})")
    d, t = res["detected"], res["top1"]
    print(f"detected {d['p']:.0%} of {d['n']} faults (95% interval {d['lo']:.2f}-{d['hi']:.2f}), top-1 {t['p']:.0%}")
    print(f"false alarms: {res['false_alarms']} in {res['fp_hours']:.2f} h; median delay {res['median_delay']} s")
    print("live rules for comparison:", evaluate([run], "live", 0.5)["detected"]["p"])
