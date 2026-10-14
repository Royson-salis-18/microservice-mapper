"""Tests for the evaluation folder. Run: python3 algorithms/detailed/evaluation/test_evaluation.py"""
import math, pathlib, sys, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from evaluation.stats import (wilson, moments, spearman, pearson, ranks, bootstrap_ci, k_fold, binom_upper,
                              kappa, auc, rng, quantile, corr_p, norm_cdf)
from evaluation.infer import infer_family, FAMILY_OF
from evaluation.score import score, _demo_data


class StatsTests(unittest.TestCase):
    def test_wilson_known_values(self):
        w = wilson(50, 100)
        self.assertAlmostEqual(w["lo"], 0.4038, places=3)
        self.assertAlmostEqual(w["hi"], 0.5962, places=3)
        w = wilson(33, 34)
        self.assertAlmostEqual(w["lo"], 0.851, places=3)
        self.assertAlmostEqual(w["hi"], 0.995, places=3)

    def test_wilson_edges(self):
        self.assertTrue(math.isnan(wilson(0, 0)["p"]))
        w = wilson(0, 10)
        self.assertEqual(w["lo"], 0.0)
        self.assertGreater(w["hi"], 0.2)        # unlike the naive interval, not zero-width

    def test_moments_symmetric(self):
        m = moments([1, 2, 3, 4, 5])
        self.assertAlmostEqual(m["mean"], 3)
        self.assertAlmostEqual(m["skew"], 0)
        self.assertAlmostEqual(m["kurt"], -1.3)

    def test_ranks_ties_share_average(self):
        self.assertEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4])

    def test_spearman_monotone(self):
        self.assertAlmostEqual(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 100]), 1.0)
        self.assertAlmostEqual(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1.0)
        self.assertLess(pearson([1, 2, 3, 4, 5], [1, 4, 9, 16, 100]), 1.0)

    def test_binomial(self):
        self.assertAlmostEqual(binom_upper(0, 10, 0.5), 1.0)
        self.assertAlmostEqual(binom_upper(10, 10, 0.5), 1 / 1024)
        self.assertAlmostEqual(binom_upper(8, 10, 0.5), 56 / 1024)

    def test_kappa_and_auc(self):
        self.assertAlmostEqual(kappa([[5, 0], [0, 5]]), 1.0)
        self.assertAlmostEqual(kappa([[5, 5], [5, 5]]), 0.0)
        self.assertAlmostEqual(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75)

    def test_rng_matches_reference_and_is_seeded(self):
        r = rng(7)
        first = [r(), r(), r()]
        self.assertAlmostEqual(first[0], 0.011704753153026104)   # value from the TypeScript generator
        r2 = rng(7)
        self.assertEqual(first, [r2(), r2(), r2()])

    def test_bootstrap_contains_mean_and_is_repeatable(self):
        xs = [1] * 20 + [0] * 14
        a, b = bootstrap_ci(xs), bootstrap_ci(xs)
        self.assertEqual(a, b)
        self.assertLess(a["lo"], a["mean"])
        self.assertGreater(a["hi"], a["mean"])

    def test_kfold_partitions_everything(self):
        out = [1, 0] * 10
        res = k_fold(out, ["a"] * 10 + ["b"] * 10, k=5)
        self.assertEqual(sum(f["n"] for f in res["folds"]), 20)
        self.assertEqual(len(res["folds"]), 5)

    def test_quantile_and_normal(self):
        self.assertEqual(quantile([1, 2, 3, 4], 0.5), 2.5)
        self.assertAlmostEqual(norm_cdf(1.96), 0.975, places=3)
        self.assertAlmostEqual(corr_p(0.0, 20), 1.0, places=3)


class InferTests(unittest.TestCase):
    def test_families(self):
        self.assertEqual(infer_family([]), None)
        self.assertEqual(infer_family(["container-health:container-paused"]), "frozen")
        self.assertEqual(infer_family(["restarts"]), "down")
        self.assertEqual(infer_family(["latency", "cpu"]), "slow")
        self.assertEqual(infer_family(["silence", "requestRate"]), "isolated")
        self.assertEqual(infer_family(["silence"]), "frozen")
        self.assertEqual(FAMILY_OF["flap"], "slow")


class ScoreTests(unittest.TestCase):
    def test_hand_made_ledger(self):
        faults, snaps = _demo_data()
        r = score(faults, snaps)
        by = {x["id"]: x for x in r["faults"]}
        self.assertTrue(by["f1"]["detected"] and by["f1"]["top1"])
        self.assertEqual(by["f1"]["delay_sec"], 5)
        self.assertTrue(by["f2"]["detected"])
        self.assertFalse(by["f2"]["top1"])
        self.assertEqual(by["f2"]["rank_settled"], 2)
        self.assertTrue(by["f2"]["top3"])
        self.assertFalse(by["f3"]["detected"])
        self.assertAlmostEqual(r["detected"]["p"], 2 / 3)
        self.assertAlmostEqual(r["top1"]["p"], 0.5)
        self.assertAlmostEqual(r["mrr"], 0.75)
        self.assertEqual(r["delay"]["median"], 7.5)
        self.assertEqual(r["false_alarm"]["episodes"], 1)
        self.assertAlmostEqual(r["false_alarm"]["per_hour"], 3.0, places=1)   # 1 episode in about 20 minutes

    def test_no_incidents_means_nothing_detected(self):
        faults, snaps = _demo_data()
        for s in snaps:
            s["incidents"] = []
        r = score(faults, snaps)
        self.assertEqual(r["detected"]["p"], 0)
        self.assertEqual(r["false_alarm"]["episodes"], 0)

    def test_grace_period_counts_late_detection(self):
        faults, snaps = _demo_data()
        # an incident that first shows 30 s after f1 healed is still inside the 60 s grace
        for s in snaps:
            s["incidents"] = [i for i in s["incidents"] if i["id"] != "i1"]
            if 150_000 <= s["ts"] <= 170_000:
                s["incidents"].append({"id": "late", "startedAt": 150_000, "endedAt": None, "root": "db",
                                       "candidates": ["db"], "affected": ["db"], "rootEvidence": []})
        r = score(faults, snaps, grace_sec=60)
        self.assertTrue({x["id"]: x for x in r["faults"]}["f1"]["detected"])
        r0 = score(faults, snaps, grace_sec=10)
        self.assertFalse({x["id"]: x for x in r0["faults"]}["f1"]["detected"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
