"""python3 algorithms/test_ml_engine.py"""
import math
import random
import unittest

from ml_engine import Cascade, ContainerFacts, Forest, ServiceBaseline, c, hybrid_alarm, root_cause_walk, trend_forecast


class MlEngineTests(unittest.TestCase):
    def test_outlier_scores_higher(self):
        rnd = random.Random(1)
        pts = [[rnd.gauss(10, 0.5), rnd.gauss(5, 0.5)] for _ in range(200)]
        f = Forest(pts, seed=2)
        self.assertGreater(f.score([30, 5]), f.score([10, 5]) + 0.1)

    def test_c_normaliser(self):
        self.assertEqual(c(2), 1.0)
        self.assertAlmostEqual(c(6), 2.707, places=2)

    def test_jump_is_flagged_and_not_learned(self):
        rnd = random.Random(2)
        b = ServiceBaseline(seed=3)
        for _ in range(60):
            b.observe([math.log(10.5 + rnd.gauss(0, 0.3))])
        size = len(b.window)
        self.assertGreaterEqual(b.observe([math.log(60.5)]), 1)
        self.assertEqual(len(b.window), size)          # the fault was not learned as normal

    def test_walk_finds_the_source_of_a_chain(self):
        r = root_cause_walk({"web": 0.6, "orders": 0.7, "db": 0.9}, [("web", "orders"), ("orders", "db")])
        self.assertEqual(max(r, key=r.get), "db")

    def test_docker_stop_counts_as_down(self):
        f = ContainerFacts()
        for _ in range(15):
            f.tick(); f.judge("db", "running")
        f.tick()
        self.assertEqual(f.judge("db", "exited", exit_code=0), "stopped")
        g = ContainerFacts(); g.tick()
        self.assertIsNone(g.judge("migrate", "exited", exit_code=0))     # a one-shot job that finished

    def test_crash_loop_between_kills(self):
        f = ContainerFacts()
        for state in ["running", "exited", "running", "exited", "running"]:
            f.tick(); last = f.judge("api", state, exit_code=137)
        self.assertEqual(last, "crash loop")

    def test_hybrid_alarm_either_engine(self):
        self.assertTrue(hybrid_alarm(2.5, 0))          # the forests alone
        self.assertTrue(hybrid_alarm(0.5, 4.0))        # the rules alone, well over their line
        self.assertFalse(hybrid_alarm(0.5, 3.3))       # the rules only just over: not enough alone

    def test_trend_forecast_sees_a_climb(self):
        self.assertGreater(trend_forecast([20 + 0.4 * i for i in range(12)], hi=21, unit=2), 1)
        self.assertEqual(trend_forecast([20] * 12, hi=21, unit=2), 0)

    def test_cascade_learns_edges(self):
        m = Cascade()
        for _ in range(8):
            m.record("api", "db", True)
            m.record("web", "api", False)
        self.assertGreater(m.prob("api", "db"), 0.8)
        self.assertLess(m.prob("web", "api"), 0.2)


if __name__ == "__main__":
    unittest.main()
