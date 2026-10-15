"""Tests for the model folder. Run: python3 algorithms/detailed/model/test_model.py"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import random
import unittest

from model.target_model import PARAMS, train_target

T0 = 1_700_000_000_000
NODES = [{"id": "web", "name": "web", "state": "running"}, {"id": "db", "name": "db", "state": "running"}]
EDGES = [("web", "db")]
WEIGHTS = {"mean": [0.0] * 18, "std": [1.0] * 18, "w": [1.0] * 18, "b": -3.0, "threshold": 0.4}


def make_history(n, seed=11, step=5000, start=0, noise=1.0, spike_at=None):
    rng = random.Random(seed)
    out = []
    for i in range(start, start + n):
        cpu = 10 + rng.uniform(-noise, noise)
        if i == spike_at or (spike_at is not None and i == spike_at + 1):
            cpu = 90
        out.append({"timestamp": T0 + i * step, "cpu": cpu, "network_rx_rate": 5000 + rng.uniform(-300, 300)})
    return out


def train(data, weights=None, need_sec=300, nodes=NODES, exclude=None):
    return train_target("t", nodes, lambda i: data.get(i, []), EDGES, weights, need_sec, exclude)


class TrainTargetTests(unittest.TestCase):
    def data(self, n=80, **kw):
        return {"web": make_history(n, seed=1, **kw), "db": make_history(n, seed=2, **kw)}

    def test_enough_clean_history_is_ready(self):
        m = train(self.data(80))
        self.assertEqual(m["state"], "ready")
        self.assertEqual(m["moments"], 80 - (PARAMS["min_history"] - 1))
        self.assertGreaterEqual(m["baseline_sec"], 300)
        self.assertEqual(m["scorer"], "rules")
        self.assertEqual(m["threshold"], m["noise_ceiling"])      # no prior: ceiling alone

    def test_short_baseline_stays_learning(self):
        m = train(self.data(30), need_sec=3600)
        self.assertEqual(m["state"], "learning")
        self.assertGreater(m["moments"], 3)

    def test_warm_up_only_returns_learning_with_defaults(self):
        m = train(self.data(10))
        self.assertEqual((m["state"], m["moments"], m["threshold"]), ("learning", 0, 0))
        m2 = train(self.data(10), weights=WEIGHTS)
        self.assertEqual(m2["threshold"], 0.4)                    # still the prior

    def test_no_history_at_all(self):
        m = train({})
        self.assertEqual((m["state"], m["moments"]), ("learning", 0))

    def test_prior_is_the_floor_for_a_quiet_system(self):
        m = train(self.data(80), weights=WEIGHTS)
        self.assertEqual(m["scorer"], "learned")
        self.assertEqual(m["prior"], 0.4)
        self.assertGreaterEqual(m["threshold"], 0.4)
        self.assertEqual(m["threshold"], max(0.4, m["noise_ceiling"]))

    def test_noisy_system_raises_the_bar_over_the_prior(self):
        # A near-zero prior; a jumpy baseline produces larger persistent scores than the quiet one.
        w = dict(WEIGHTS, threshold=0.0)
        quiet = train(self.data(120), weights=None)
        jumpy = train({"web": self.data(120)["web"][:100] + make_history(20, seed=5, start=100, noise=1.0, spike_at=105),
                       "db": self.data(120)["db"]}, weights=None)
        self.assertGreater(jumpy["noise_ceiling"], quiet["noise_ceiling"])
        self.assertEqual(train(self.data(80), weights=w)["threshold"], train(self.data(80), weights=w)["noise_ceiling"])

    def test_exclude_removes_moments(self):
        data = self.data(80)
        cut = T0 + 60 * 5000
        m_all, m_cut = train(data), train(data, exclude=lambda t: t > cut)
        self.assertLess(m_cut["moments"], m_all["moments"])

    def test_one_isolated_fault_is_ignored_by_persistence(self):
        # a single bad moment cannot set the bar: persistent = min(score, previous score)
        base = train(self.data(80))
        one = self.data(80)
        one["web"][50] = dict(one["web"][50], cpu=95)
        self.assertEqual(train(one)["noise_ceiling"], base["noise_ceiling"])

    def test_sustained_fault_in_a_short_baseline_sets_the_bar(self):
        # a fault must last 3 samples: 2 to fire the detector, then 2 moments in a row to survive
        # "min with previous". With < 100 moments nothing is trimmed.
        base = train(self.data(80))
        two = self.data(80)
        for i in (50, 51, 52):
            two["web"][i] = dict(two["web"][i], cpu=95)
        self.assertGreater(train(two)["noise_ceiling"], base["noise_ceiling"] * 3)

    def test_outage_gap_does_not_count_as_baseline_time(self):
        a = make_history(40, seed=1)
        b = make_history(40, seed=1, start=40 + 2000)             # 10 000 s hole
        c = {"web": a + b, "db": make_history(40, seed=2) + make_history(40, seed=2, start=2040)}
        m = train(c, need_sec=10)
        self.assertLess(m["baseline_sec"], 1000)                  # the hole was not added

    def test_long_history_is_thinned_to_max_moments(self):
        m = train({"web": make_history(500, seed=1), "db": make_history(500, seed=2)})
        self.assertLessEqual(m["moments"], PARAMS["max_moments"])

    def test_trimming_with_many_moments(self):
        # >= 100 moments: the top 1% is trimmed, so the same fault no longer sets the ceiling
        clean = self.data(150)
        faulty = {k: list(v) for k, v in clean.items()}
        for i in (100, 101, 102):
            faulty["web"][i] = dict(faulty["web"][i], cpu=95)
        a, b = train(clean), train(faulty)
        self.assertGreaterEqual(a["moments"], PARAMS["trim_min_moments"])
        self.assertLess(b["noise_ceiling"], 1.0)          # a fault would give ~9; trimmed, only noise is left
        self.assertAlmostEqual(a["noise_ceiling"], b["noise_ceiling"], delta=0.2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
