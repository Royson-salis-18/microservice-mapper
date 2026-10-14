"""python3 algorithms/test_cascading_failure.py"""
import unittest

from cascading_failure import at_risk, predict, what_if

CALLS = [("web", "orders", 0.8), ("orders", "db", 0.9)]


class CascadingFailureTests(unittest.TestCase):
    def test_numbers_from_the_page(self):
        p = predict({"web": "healthy", "orders": "degraded", "db": "critical"}, CALLS)
        self.assertAlmostEqual(p["orders"], 0.815, places=3)
        self.assertAlmostEqual(p["web"], 0.456, places=3)

    def test_healthy_system_has_no_risk(self):
        self.assertEqual(set(predict({"web": "healthy", "orders": "healthy", "db": "healthy"}, CALLS).values()), {0.0})

    def test_only_healthy_looking_services_are_at_risk(self):
        r = at_risk({"web": "healthy", "orders": "degraded", "db": "critical"}, CALLS)
        self.assertEqual(list(r), ["web"])

    def test_what_if(self):
        r = what_if("db", {"web": "healthy", "orders": "healthy", "db": "healthy"}, CALLS)
        self.assertEqual(set(r), {"orders", "web"})
        self.assertGreater(r["orders"], r["web"])

    def test_loop_settles(self):
        p = predict({"a": "critical", "b": "healthy"}, [("a", "b", 1.0), ("b", "a", 1.0)])
        self.assertLessEqual(max(p.values()), 1.0)


if __name__ == "__main__":
    unittest.main()
