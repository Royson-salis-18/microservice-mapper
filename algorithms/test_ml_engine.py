"""python3 algorithms/test_ml_engine.py"""
import math
import random
import unittest

from ml_engine import Forest, ServiceBaseline, c, root_cause_walk


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


if __name__ == "__main__":
    unittest.main()
