"""Tests for the learning folder. Run: python3 algorithms/learning/test_learning.py"""
import pathlib, sys, unittest, random
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from learning.logreg import fit, predict, solve, sigmoid, contributions
from learning.dataset import labelled_rows, slice_run, synthetic_run, Fault, FEATURE_NAMES
from learning.evaluate import evaluate, objective, tune_threshold
from learning.experiment import block_of, train, rules_score, cross_validate, summarise


def toy(n=200, seed=0):
    rng = random.Random(seed)
    X, y = [], []
    for _ in range(n):
        label = 1 if rng.random() < 0.2 else 0
        X.append([rng.gauss(3 * label, 1), rng.gauss(0, 1)])
        y.append(label)
    return X, y


class LogregTests(unittest.TestCase):
    def test_solve_small_system(self):
        x = solve([[2, 1], [1, 3]], [3, 5])
        self.assertAlmostEqual(x[0], 0.8)
        self.assertAlmostEqual(x[1], 1.4)

    def test_sigmoid_is_stable(self):
        self.assertAlmostEqual(sigmoid(0), 0.5)
        self.assertEqual(sigmoid(-800), 0.0)
        self.assertEqual(sigmoid(800), 1.0)

    def test_learns_separable_problem(self):
        X, y = toy()
        m = fit(X, y, ["signal", "noise"], lam=1)
        acc = sum((predict(m, x) > 0.5) == (t == 1) for x, t in zip(X, y)) / len(y)
        self.assertGreater(acc, 0.9)
        self.assertGreater(abs(m["w"][0]), 5 * abs(m["w"][1]))   # signal matters, noise does not

    def test_regularisation_shrinks_weights(self):
        X, y = toy()
        small = fit(X, y, lam=0.1)["w"]
        big = fit(X, y, lam=100)["w"]
        self.assertLess(sum(w * w for w in big), sum(w * w for w in small))

    def test_class_balance_lifts_rare_class(self):
        X, y = toy()
        m = fit(X, y, lam=1)
        pos_scores = [predict(m, x) for x, t in zip(X, y) if t == 1]
        self.assertGreater(sum(pos_scores) / len(pos_scores), 0.5)   # rare faults still get high scores

    def test_contributions_sorted_by_size(self):
        X, y = toy()
        m = fit(X, y, ["signal", "noise"])
        c = contributions(m, [3.0, 0.0])
        self.assertEqual(c[0][0], "signal")


class DatasetTests(unittest.TestCase):
    def test_labels_and_exclusions(self):
        f = Fault("f", "crash", "db", 600_000, 660_000, ["api"])
        run = synthetic_run(minutes=20, faults=[f])
        X, y, ts = labelled_rows(run, warmup_sec=300, recovery_sec=60)
        self.assertTrue(all(t >= 300_000 for t in ts))                       # warm-up dropped
        self.assertFalse(any(660_000 < t <= 720_000 for t in ts))            # recovery minute dropped
        self.assertEqual(len(X[0]), len(FEATURE_NAMES))
        positives = [t for t, l in zip(ts, y) if l == 1]
        self.assertTrue(all(600_000 <= t <= 660_000 for t in positives))
        self.assertEqual(len(positives), 13)                                 # 60 s / 5 s + 1, one service

    def test_slice_keeps_faults_that_start_inside(self):
        run = synthetic_run(minutes=40)
        part = slice_run(run, 0, 20 * 60000)
        self.assertEqual([f.id for f in part.faults], ["f1"])
        self.assertTrue(all(m.ts < 20 * 60000 for m in part.moments))


class EvaluateAndExperimentTests(unittest.TestCase):
    def test_perfect_scorer_is_detected(self):
        run = synthetic_run(minutes=40)
        scorer = lambda ri, mi: [r[0] for r in run.moments[mi].X]
        res = evaluate([run], scorer, 1.5)
        self.assertEqual(res["detected"]["p"], 1.0)
        self.assertEqual(res["top1"]["p"], 1.0)
        self.assertEqual(res["false_alarms"], 0)

    def test_always_on_scorer_gets_false_alarms(self):
        run = synthetic_run(minutes=40, faults=[])        # nothing is wrong, yet the scorer shouts
        res = evaluate([run], lambda ri, mi: [9.0 if mi > 200 else 0.0] * 3, 1.0)   # after warm-up
        self.assertGreaterEqual(res["false_alarms"], 1)

    def test_persistence_ignores_single_spike(self):
        run = synthetic_run(minutes=40, faults=[])
        spike = lambda ri, mi: [9.0 if mi == 200 else 0.0, 0, 0]
        self.assertEqual(evaluate([run], spike, 1.0)["false_alarms"], 0)
        self.assertEqual(evaluate([run], spike, 1.0, persistence=1)["false_alarms"], 1)

    def test_objective_and_threshold(self):
        run = synthetic_run(minutes=40)
        scorer = lambda ri, mi: [r[0] for r in run.moments[mi].X]
        t = tune_threshold([run], scorer)
        self.assertGreater(t["objective"], 0.9)

    def test_blocked_blocks_are_consecutive(self):
        run = synthetic_run(minutes=30)
        blocks = [block_of(run, m.ts, 5) for m in run.moments]
        self.assertEqual(blocks, sorted(blocks))                  # never shuffled
        self.assertEqual(set(blocks), {0, 1, 2, 3, 4})
        self.assertEqual(blocks[0], 0)
        self.assertEqual(blocks[-1], 4)

    def test_fold_never_trains_on_test_block(self):
        run = synthetic_run(minutes=30)
        K, k = 5, 2
        test = slice_run(run, run.t0 + (run.t1 - run.t0 + 1) * k / K, run.t0 + (run.t1 - run.t0 + 1) * (k + 1) / K)
        self.assertTrue(all(block_of(run, m.ts, K) == k for m in test.moments))

    def test_train_prefers_stronger_lambda_on_ties(self):
        run = synthetic_run(minutes=30, step_ms=15000)
        t = train([run], lambdas=[1, 100])
        self.assertIn(t["model"]["lambda"], (1, 100))
        self.assertEqual([c["lambda"] for c in t["lambda_curve"]], [100, 1])

    def test_rules_score_container_fact_bonus(self):
        x = [0.0] * len(FEATURE_NAMES)
        base = rules_score(x)
        x[FEATURE_NAMES.index("down")] = 1
        self.assertEqual(rules_score(x), base + 10)

    def test_cross_validate_runs(self):
        run = synthetic_run(minutes=40, step_ms=15000)
        cv = cross_validate([run], 2, lambdas=[10])
        self.assertTrue(cv["folds"])
        self.assertEqual(summarise(cv["pooled"]["live"])["faults"], sum(f["faults"] for f in cv["folds"]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
