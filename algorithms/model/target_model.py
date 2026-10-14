"""Target model: calibrate the alarm threshold for ONE architecture.

Question answered: "on this system's own healthy history, how high does the score
normally go, so that anything above that is unprecedented here?"

Mirrors: server/algorithms/model/TargetModel.ts

Idea: replay the recent fault-free history moment by moment. At each moment, score
every service (detection/scoring.py) and keep the highest score. That gives one
"max score" per moment. An alarm needs two consecutive agreeing cycles, so the
"persistent" score of a moment is min(its score, previous moment's score). The
noise ceiling is the top persistent score of the baseline; with 100+ moments the top
1% is trimmed first, so one unnoticed fault in the baseline cannot set the bar.
The threshold is max(shared prior, noise ceiling): a quiet system keeps the
cross-system prior, a noisy one raises the bar. The model is "ready" only once the
clean baseline spans need_sec seconds, otherwise it is still "learning".

Inputs are plain data: nodes [{'id','name',...}], history(id) -> snapshots with a
'timestamp' (epoch ms number or ISO string), edges [(caller, callee)], optional
weights {'mean','std','w','b','threshold'}, optional exclude(ts_ms) -> bool.

Left out: trainedAt stamp and the record/type plumbing. Result is a plain dict.
"""
import bisect
import math
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from detection.anomaly_detector import timestamp_ms
from detection.scoring import make_scorer, moment_scores

PARAMS = {
    "min_history": 14,       # a service needs 12 past samples plus the 2 being judged
    "max_moments": 150,      # cap on training cost: at most this many moments are scored
    "trim_min_moments": 100, "trim_quantile": 0.99,   # with >= 100 moments, drop the top 1%
    "outage_gap_factor": 3,  # a gap > 3x the typical gap is an outage, not baseline time
}


def round_half_up(v):
    return math.floor(v + 0.5)


def train_target(target, nodes, history, edges, weights, need_sec, exclude=None):
    scorer = make_scorer(weights)
    prior = weights["threshold"] if weights else None
    series = {n["id"]: history(n["id"]) for n in nodes}
    stamps = {i: [timestamp_ms(s.get("timestamp")) for s in h] for i, h in series.items()}
    all_times = sorted({t for ts in stamps.values() for t in ts if math.isfinite(t)})
    stride = max(1, math.ceil(len(all_times) / PARAMS["max_moments"]))   # thin out long histories

    model = {"target": target, "state": "learning", "baseline_sec": 0, "need_sec": need_sec, "moments": 0,
             "services": len(nodes), "scorer": scorer[0], "threshold": prior or 0, "noise_ceiling": 0, "prior": prior}

    times, max_scores = [], []
    for t in all_times[::stride]:
        if exclude and exclude(t):
            continue                                       # an incident was open: system not healthy
        lens = [bisect.bisect_right(stamps[n["id"]], t) for n in nodes]   # samples known at moment t
        if max(lens, default=0) < PARAMS["min_history"]:
            continue                                       # warm-up: nobody has a past yet
        past = {n["id"]: series[n["id"]][:k] for n, k in zip(nodes, lens)}
        scores = moment_scores(nodes, lambda i: past.get(i, []), edges, scorer)
        if not scores:
            continue
        times.append(t)
        max_scores.append(max(scores.values()))
    model["moments"] = len(times)
    if len(times) < 3:
        return model                                       # too little data: stay in learning

    # clean span = sum of gaps between kept moments, ignoring outages
    gaps = sorted(b - a for a, b in zip(times, times[1:]))
    typical = gaps[len(gaps) // 2] or 1
    clean_ms = sum(g for g in gaps if g <= PARAMS["outage_gap_factor"] * typical)
    model["baseline_sec"] = round_half_up(clean_ms / 1000)

    persistent = sorted(min(s, prev) for s, prev in zip(max_scores[1:], max_scores))
    if len(persistent) >= PARAMS["trim_min_moments"]:
        pick = math.floor(PARAMS["trim_quantile"] * (len(persistent) - 1))
    else:
        pick = len(persistent) - 1                         # too few moments to trim: take the max
    model["noise_ceiling"] = persistent[pick]
    model["threshold"] = max(prior or 0, model["noise_ceiling"])   # prior is the floor
    model["state"] = "ready" if model["baseline_sec"] >= need_sec else "learning"
    return model


if __name__ == "__main__":
    import random
    rng = random.Random(11)
    nodes = [{"id": "web", "name": "web", "state": "running"}, {"id": "db", "name": "db", "state": "running"}]

    def healthy(i):   # 5 s apart, small noise
        return {"timestamp": 1_700_000_000_000 + i * 5000, "cpu": 10 + rng.uniform(-1, 1),
                "network_rx_rate": 5000 + rng.uniform(-300, 300)}

    data = {n["id"]: [healthy(i) for i in range(80)] for n in nodes}
    m = train_target("demo", nodes, lambda i: data[i], [("web", "db")], None, need_sec=300)
    for k, v in m.items():
        print(f"{k:14} {v}")
