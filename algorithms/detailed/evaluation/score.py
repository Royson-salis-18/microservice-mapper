"""Score a mapper against the fault injector's private ledger.

Question answered: for each fault the injector applied, did the mapper notice, how fast,
did it name the right root cause, and how often did it raise incidents when nothing was wrong?

Mirrors: server/algorithms/evaluation/score.ts (function `score`).

Idea: the ledger says "fault X hit service S from time a to time b". The mapper is only
observed through snapshots (what its API showed every few seconds), read after the run.
Detection window is [a, b + grace]. An incident is "localised" on a fault when its top-3
candidates, its affected set or its root touch the real root or something that depends on it.
- detected: some snapshot in the window has a localised incident; delay = first such snapshot - a.
- top-1 / top-3: the real root is first / within first three candidates of the LAST ranking
  before healing ("settled").
- false alarm: incident time outside every detection window; reported per hour.
- structural precision/recall: predicted affected set vs services that depend on the root.
Proportions get Wilson intervals; top-1 is tested against picking one candidate at random.

Left out (plumbing or too tied to server files): ledger/snapshot/traffic-log parsing, user
impact from the traffic generator, observed cascade and pre-warning, calibration of the
at-risk list, confusion matrices, the research block (moments, Spearman, bootstrap, k-fold)
beyond the chance test. Plain dicts replace the TS interfaces. Times are in milliseconds.

Data shapes:
  fault    {"id", "class", "target", "a", "b", "root", "expected_affected": [..]}
  snapshot {"ts", "incidents": [incident], "status": {service: "healthy"|...}}
  incident {"id", "startedAt", "endedAt" or None, "root", "candidates": [..], "affected": [..],
            "rootEvidence": [..]}
"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from evaluation.stats import wilson, quantile, mean, binom_upper
from evaluation.infer import FAMILY_OF, infer_family


def f1_score(p, r):
    return 0 if p + r == 0 else 2 * p * r / (p + r)


def precision_recall(predicted, truth):
    """Set comparison. Empty prediction is precision 0 if something was expected, else 1."""
    hit = len(predicted & truth)
    precision = hit / len(predicted) if predicted else (0 if truth else 1)
    recall = hit / len(truth) if truth else 1
    return {"precision": precision, "recall": recall, "f1": f1_score(precision, recall)}


def score_fault(f, snaps, grace_ms, all_faults):
    """Everything about one fault: detection, delay, ranks, structural cascade."""
    window = [s for s in snaps if f["a"] <= s["ts"] <= f["b"] + grace_ms]
    touches = {f["root"], *f["expected_affected"]}

    def localised(inc):
        return (any(c in touches for c in inc["candidates"][:3])
                or any(c in touches for c in inc["affected"])
                or (inc["root"] or "") in touches)

    first = next((s for s in window if any(localised(i) for i in s["incidents"])), None)
    # was the incident already open before the fault? then the delay is not meaningful
    preexisting = first is not None and any(localised(i) and i["startedAt"] < f["a"] - 2000 for i in first["incidents"])
    delay = max(0, (first["ts"] - f["a"]) / 1000) if first else None

    # the "settled" picture: last snapshot before healing that still has a localised incident
    in_fault = [s for s in window if s["ts"] <= f["b"] and any(localised(i) for i in s["incidents"])]
    settled_snap = in_fault[-1] if in_fault else first

    def pick(snap):
        # among localised incidents, the one with the longest candidate list (stable on ties)
        if not snap:
            return None
        cands = sorted((i for i in snap["incidents"] if localised(i)), key=lambda i: -len(i["candidates"]))
        return cands[0] if cands else None

    def rank_of(inc):
        if not inc or f["root"] not in inc["candidates"]:
            return None
        return inc["candidates"].index(f["root"]) + 1

    settled, initial = pick(settled_snap), pick(first)
    rank_settled, rank_initial = rank_of(settled), rank_of(initial)

    structural = None
    if settled:
        predicted = {x for x in settled["affected"] if x != f["root"]}
        structural = precision_recall(predicted, set(f["expected_affected"]))

    evidence = sorted({e for s in in_fault for i in s["incidents"] if localised(i) and i["root"] == f["root"]
                       for e in i.get("rootEvidence", [])})
    inferred = infer_family(evidence) if first else None
    true_family = FAMILY_OF.get(f["class"], f["class"])
    return {"id": f["id"], "class": f["class"], "target": f["target"],
            "detected": first is not None, "preexisting": preexisting, "delay_sec": delay,
            "rank_settled": rank_settled, "rank_initial": rank_initial,
            "top1": rank_settled == 1, "top3": rank_settled is not None and rank_settled <= 3,
            "predicted_root": settled["candidates"][0] if settled and settled["candidates"] else None,
            "chance": 1 / len(settled["candidates"]) if settled and settled["candidates"] else None,
            "structural": structural, "inferred_family": inferred, "true_family": true_family,
            "family_match": None if inferred is None else inferred == true_family}


def false_alarms(faults, snaps, grace_ms, warmup_sec=0):
    """Incident episodes that touch no detection window, per hour of observed time after warm-up."""
    windows = [(f["a"], f["b"] + grace_ms) for f in faults]
    warmup_end = (snaps[0]["ts"] if snaps else 0) + warmup_sec * 1000
    episodes = {}
    for s in snaps:
        if s["ts"] < warmup_end:
            continue
        for inc in s["incidents"]:
            start = max(inc["startedAt"], snaps[0]["ts"])
            end = inc["endedAt"] if inc["endedAt"] is not None else s["ts"]
            cur = episodes.get(inc["id"])
            episodes[inc["id"]] = (min(cur[0], start) if cur else start, max(cur[1] if cur else 0, end))
    count, ms = 0, 0
    for start, end in episodes.values():
        hit = [w for w in windows if start < w[1] and end > w[0]]
        if not hit:
            count += 1
            ms += end - start
        else:                                   # time running past the last covering window also counts
            ms += max(0, end - max(w[1] for w in hit))
    span_h = max(0, (snaps[-1]["ts"] - max(warmup_end, snaps[0]["ts"])) / 3.6e6) if len(snaps) > 1 else 0
    return {"episodes": count, "minutes": ms / 60000, "per_hour": count / span_h if span_h else 0, "span_hours": span_h}


def score(faults, snaps, grace_sec=60, warmup_sec=0):
    snaps = sorted(snaps, key=lambda s: s["ts"])
    grace = grace_sec * 1000
    results = [score_fault(f, snaps, grace, faults) for f in sorted(faults, key=lambda f: f["a"])]
    det = [r for r in results if r["detected"]]
    delays = [r["delay_sec"] for r in det]
    n_top1 = sum(r["top1"] for r in det)
    chances = [r["chance"] for r in det if r["chance"] is not None]
    mean_chance = mean(chances) if chances else float("nan")
    sp = [r["structural"] for r in det if r["structural"]]
    return {
        "faults": results,
        "detected": wilson(len(det), len(results)),
        "top1": wilson(n_top1, len(det)),
        "top3": wilson(sum(r["top3"] for r in det), len(det)),
        "mrr": mean([1 / r["rank_settled"] if r["rank_settled"] else 0 for r in det]),
        "delay": {"median": quantile(delays, 0.5), "p90": quantile(delays, 0.9), "mean": mean(delays)},
        "structural": {k: mean([s[k] for s in sp]) for k in ("precision", "recall", "f1")},
        "false_alarm": false_alarms(faults, snaps, grace, warmup_sec),
        "top1_vs_chance": {"chance": mean_chance,
                           "p_value": binom_upper(n_top1, len(det), mean_chance) if chances else float("nan")},
    }


def _demo_data():
    """Three faults on a 4-service chain web -> api -> db, plus one stray incident at the end."""
    faults = [
        {"id": "f1", "class": "crash", "target": "db", "a": 60_000, "b": 120_000, "root": "db", "expected_affected": ["api", "web"]},
        {"id": "f2", "class": "brownout", "target": "api", "a": 300_000, "b": 360_000, "root": "api", "expected_affected": ["web"]},
        {"id": "f3", "class": "pause", "target": "cache", "a": 600_000, "b": 660_000, "root": "cache", "expected_affected": ["api"]},
    ]
    snaps = []
    for k in range(0, 1200, 5):                 # a snapshot every 5 s for 20 minutes
        ts = k * 1000
        incs = []
        if 65_000 <= ts <= 125_000:             # f1: noticed after 5 s, db ranked first
            incs.append({"id": "i1", "startedAt": 65_000, "endedAt": None, "root": "db", "candidates": ["db", "api", "web"], "affected": ["db", "api"], "rootEvidence": ["container-health"]})
        if 310_000 <= ts <= 365_000:            # f2: noticed after 10 s, api ranked second behind web
            incs.append({"id": "i2", "startedAt": 310_000, "endedAt": None, "root": "web", "candidates": ["web", "api", "db"], "affected": ["web", "api"], "rootEvidence": ["latency"]})
        if 900_000 <= ts <= 960_000:            # no fault here: a false alarm. f3 is never noticed.
            incs.append({"id": "i3", "startedAt": 900_000, "endedAt": None, "root": "db", "candidates": ["db"], "affected": ["db"], "rootEvidence": []})
        snaps.append({"ts": ts, "incidents": incs, "status": {}})
    return faults, snaps


if __name__ == "__main__":
    faults, snaps = _demo_data()
    res = score(faults, snaps)
    for r in res["faults"]:
        print(f"{r['id']} {r['class']:<9} detected={r['detected']!s:<5} delay={r['delay_sec']} rank={r['rank_settled']} "
              f"top1={r['top1']} family guess={r['inferred_family']}")
    d = res["detected"]
    print(f"detected {d['p']:.0%} of {d['n']} (Wilson {d['lo']:.2f}-{d['hi']:.2f}); top-1 {res['top1']['p']:.0%} of detected; median delay {res['delay']['median']} s")
    fa = res["false_alarm"]
    print(f"false alarms: {fa['episodes']} episode(s) in {fa['span_hours']:.2f} h = {fa['per_hour']:.1f} per hour")
