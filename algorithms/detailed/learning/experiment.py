"""Train, cross-validate in time blocks, and test across systems.

Question answered: is a learned scorer better than the hand-written rules, measured on
faults it has never seen?

Mirrors: server/algorithms/learning/experiment.ts

Idea: training = fit one logistic model per lambda on the allowed rows, tune the alarm
threshold for each, and keep the lambda with the best event objective (strongest
regularisation first, only a strictly better value replaces it, so ties go to the simpler
model). Blocked K-fold: every run is cut into K consecutive time blocks; fold k trains on
the other blocks and tests on block k, so the model never sees the test period. Cross-system:
train on the runs of the other subjects, test on the held-out subject. Four methods are
compared on the same faults: learned, rules with fixed threshold 3, rules with a tuned
threshold, and the live mapper as recorded.

Left out: the TS report plumbing and the out-of-fold ROC/calibration rows. `rules_score`
is copied from server/algorithms/detection/scoring.ts (rulesScore) so this file stands alone.
"""
import math
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from dataclasses import replace
from learning.logreg import fit, predict
from learning.dataset import FEATURE_NAMES, labelled_rows, slice_run, synthetic_run, Fault
from learning.evaluate import evaluate_prepared, prepare, tune_threshold

LAMBDAS = [0.1, 1, 10, 100]
METHODS = ["learned", "rulesFixed", "rulesTuned", "live"]
RULES_FIXED_THRESHOLD = 3     # rule score is in z units; 3 is the usual "three sigma" line

_I = {name: i for i, name in enumerate(FEATURE_NAMES)}


def rules_score(x):
    """Hand-written rule: own evidence, or symptoms no broken dependency explains, plus a big bonus
    when the container itself is down / paused / restarting / detached."""
    facts = max(x[_I["down"]], x[_I["paused"]], x[_I["restarting"]], x[_I["detached"]])
    return max(math.expm1(x[_I["own"]]), math.expm1(x[_I["symptom"]]) - math.expm1(x[_I["calleesEvidenceMax"]])) + 10 * facts


def scorer(runs, f):
    """Turn a per-row function into the (run_index, moment_index) -> scores shape evaluate.py wants."""
    return lambda ri, mi: [f(x) for x in runs[ri].moments[mi].X]


def rows_of(runs, keep=None):
    X, y = [], []
    for r in runs:
        d = labelled_rows(r, keep=(lambda ts, r=r: keep(r, ts)) if keep else None)
        X += d[0]
        y += d[1]
    return X, y


def restrict(runs, keep):
    """Only the moments and faults that pass `keep` (faults by their start time)."""
    return [replace(r, moments=[m for m in r.moments if keep(r, m.ts)], faults=[f for f in r.faults if keep(r, f.a)]) for r in runs]


def train(runs, keep=None, lambdas=LAMBDAS, **opts):
    X, y = rows_of(runs, keep)
    train_runs = restrict(runs, keep) if keep else runs
    best, lambda_curve = None, []
    for lam in sorted(lambdas, reverse=True):
        model = fit(X, y, FEATURE_NAMES, lam)
        t = tune_threshold(train_runs, scorer(train_runs, lambda x: predict(model, x)), **opts)
        lambda_curve.append({"lambda": lam, "objective": t["objective"]})
        if best is None or t["objective"] > best["objective"]:
            best = {"model": model, "threshold": t["threshold"], "objective": t["objective"]}
    best["lambda_curve"] = lambda_curve
    return best


def block_of(run, ts, K):
    """Which of the K consecutive time blocks a timestamp falls in (0..K-1). Never shuffled."""
    return min(K - 1, math.floor((ts - run.t0) / max(1, run.t1 - run.t0 + 1) * K))


def cross_validate(runs, K, lambdas=LAMBDAS, **opts):
    pooled = {m: {"faults": [], "false_alarms": 0, "fp_hours": 0.0} for m in METHODS}
    folds = []
    for k in range(K):
        keep_train = lambda r, ts, k=k: block_of(r, ts, K) != k
        test = []
        for r in runs:
            lo = r.t0 + (r.t1 - r.t0 + 1) * k / K
            hi = r.t0 + (r.t1 - r.t0 + 1) * (k + 1) / K
            s = slice_run(r, lo, hi)
            if s.moments:
                test.append(s)
        if not any(r.faults for r in test):
            continue                         # nothing to judge in this block
        tr = train(runs, keep_train, lambdas, **opts)
        train_runs = restrict(runs, keep_train)
        h_tuned = tune_threshold(train_runs, scorer(train_runs, rules_score), **opts)["threshold"]
        learned_prep = prepare(test, scorer(test, lambda x: predict(tr["model"], x)))
        rules_prep = prepare(test, scorer(test, rules_score))
        res = {"learned": evaluate_prepared(learned_prep, tr["threshold"], **opts),
               "rulesFixed": evaluate_prepared(rules_prep, RULES_FIXED_THRESHOLD, **opts),
               "rulesTuned": evaluate_prepared(rules_prep, h_tuned, **opts),
               "live": evaluate_prepared("live", 0.5, live_runs=test, **opts)}
        for m in METHODS:
            pooled[m]["faults"] += res[m]["faults"]
            pooled[m]["false_alarms"] += res[m]["false_alarms"]
            pooled[m]["fp_hours"] += res[m]["fp_hours"]
        folds.append({"k": k, "threshold": tr["threshold"], "rules_tuned": h_tuned, "faults": sum(len(r.faults) for r in test)})
    return {"pooled": pooled, "folds": folds}


def summarise(p):
    det = [f for f in p["faults"] if f["detected"]]
    delays = sorted(f["delay_sec"] for f in det)
    nf = max(1, len(p["faults"]))
    return {"faults": len(p["faults"]), "detected": len(det) / nf, "detected_n": len(det),
            "top1_of_detected": sum(f["top1"] for f in det) / max(1, len(det)),
            "caught_and_named": sum(f["top1"] for f in p["faults"]) / nf,
            "false_alarms_per_hour": p["false_alarms"] / p["fp_hours"] if p["fp_hours"] else 0,
            "false_alarms": p["false_alarms"],
            "median_delay_sec": delays[len(delays) // 2] if delays else None}


def cross_system(runs, **opts):
    """Train on every other subject, test on this one: does it work on a system it never saw?"""
    subjects = list(dict.fromkeys(r.subject for r in runs))
    out = []
    if len(subjects) < 2:
        return out
    pool = lambda e: {"faults": e["faults"], "false_alarms": e["false_alarms"], "fp_hours": e["fp_hours"]}
    for s in subjects:
        tr = [r for r in runs if r.subject != s]
        te = [r for r in runs if r.subject == s]
        t = train(tr, **opts)
        h = tune_threshold(tr, scorer(tr, rules_score), **opts)["threshold"]
        learned = evaluate_prepared(prepare(te, scorer(te, lambda x: predict(t["model"], x))), t["threshold"], **opts)
        rules = evaluate_prepared(prepare(te, scorer(te, rules_score)), h, **opts)
        live = evaluate_prepared("live", 0.5, live_runs=te, **opts)
        out.append({"label": f"train on others -> test {s}", "learned": summarise(pool(learned)),
                    "rules": summarise(pool(rules)), "live": summarise(pool(live))})
    return out


def _demo_runs():
    def fl(i, cls, target, a_min):
        return Fault(f"f{i}", cls, target, a_min * 60000, (a_min + 3) * 60000, ["api"])
    a = synthetic_run("A1", "benchA", minutes=60, seed=1, step_ms=15000,
                      faults=[fl(1, "crash", "db", 10), fl(2, "brownout", "cache", 25), fl(3, "crash", "db", 40), fl(4, "brownout", "cache", 52)])
    b = synthetic_run("B1", "benchB", minutes=60, seed=2, step_ms=15000,
                      faults=[fl(5, "crash", "cache", 12), fl(6, "brownout", "db", 28), fl(7, "crash", "cache", 43), fl(8, "brownout", "db", 53)])
    return [a, b]


if __name__ == "__main__":
    runs = _demo_runs()
    opts = {"warmup_sec": 300}
    cv = cross_validate(runs, K=3, lambdas=[1, 100], **opts)
    print("blocked 3-fold, pooled over all folds")
    for m in METHODS:
        s = summarise(cv["pooled"][m])
        print(f"  {m:<11} detected {s['detected']:.0%} of {s['faults']}, top-1 of detected {s['top1_of_detected']:.0%}, "
              f"false alarms/h {s['false_alarms_per_hour']:.1f}")
    for row in cross_system(runs, **opts):
        print(row["label"], "| learned detected", f"{row['learned']['detected']:.0%}", "| live detected", f"{row['live']['detected']:.0%}")
