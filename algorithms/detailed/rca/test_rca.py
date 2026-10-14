"""Tests for the root-cause analysis files. Run: python3 algorithms/detailed/rca/test_rca.py"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from rca.rca_engine import Thresholds, analyze_incident, container_fact, dependency_reach  # noqa: E402
from rca.temporal_analyzer import build_timeline, find_earliest_nodes  # noqa: E402
from rca.explanation_engine import generate_explanation  # noqa: E402

T0 = "2026-01-01T10:00:00Z"


def node(i, status="healthy", **extra):
    base = {"id": i, "name": i, "status": status, "metrics": {"cpu": 10}}
    base.update(extra)
    return base


def call(a, b, observed=True):
    return {"id": f"{a}>{b}", "source": a, "target": b, "observed": observed, "evidence_sources": ["http-log"]}


def anomaly(i, metric, z, kind, ts=T0):
    return {"node_id": i, "metric": metric, "z": z, "severity": "HIGH", "evidence": kind,
            "timestamp": ts, "observed": 10.0, "baseline": 1.0}


def top(result):
    return result["root_cause"]["service_id"]


class RootCauseTests(unittest.TestCase):
    chain_nodes = [node("web"), node("orders"), node("db")]
    chain_edges = [call("web", "orders"), call("orders", "db")]

    def test_victim_is_not_blamed(self):
        # the db is most abnormal; orders and web only show inherited symptoms
        anoms = [anomaly("db", "memory", 9, "own"), anomaly("orders", "error-rate", 7, "symptom"),
                 anomaly("web", "latency", 6, "symptom")]
        r = analyze_incident("shop", self.chain_nodes, self.chain_edges, anoms)
        self.assertEqual(top(r), "db")
        orders = next(c for c in r["candidates"] if c["service_id"] == "orders")
        self.assertEqual(orders["explained"], 9)          # gamma x db evidence
        self.assertTrue(r["propagation_path"] == ["db", "orders", "web"])

    def test_gamma_zero_is_plain_most_abnormal(self):
        anoms = [anomaly("db", "memory", 5, "own"), anomaly("orders", "error-rate", 8, "symptom")]
        normal = analyze_incident("shop", self.chain_nodes, self.chain_edges, anoms)
        plain = analyze_incident("shop", self.chain_nodes, self.chain_edges, anoms, Thresholds(explain_away_gamma=0))
        self.assertEqual(top(normal), "db")
        self.assertEqual(top(plain), "orders")

    def test_hard_fact_beats_bigger_statistic(self):
        nodes = [node("web"), node("api"), node("cache", "critical", state="exited (137)")]
        edges = [call("web", "api"), call("api", "cache")]
        anoms = [anomaly("api", "cpu", 12, "own"), anomaly("cache", "container-health", None, "hard")]
        r = analyze_incident("shop", nodes, edges, anoms)
        self.assertEqual(top(r), "cache")
        self.assertEqual(r["confidence"], "HIGH")          # the only stopped container
        self.assertGreaterEqual(r["root_cause"]["score"], 0.9)

    def test_clean_exit_and_load_generator_are_not_failures(self):
        self.assertEqual(container_fact({"name": "migrate", "state": "exited (0)"}), "benign")
        self.assertEqual(container_fact({"name": "locust", "state": "exited (1)"}), "benign")
        self.assertEqual(container_fact({"name": "api", "state": "exited (137)"}), "down")
        self.assertEqual(container_fact({"name": "api", "state": "Running"}), None)
        self.assertEqual(container_fact({"name": "api", "state": "paused"}), "paused")

    def test_blind_spot_needs_two_callers(self):
        nodes = [node("a"), node("b"), node("ghost", metrics=None)]
        edges = [call("a", "ghost"), call("b", "ghost")]
        two = [anomaly("a", "error-rate", 4, "symptom"), anomaly("b", "error-rate", 4, "symptom")]
        r = analyze_incident("shop", nodes, edges, two)
        self.assertEqual(top(r), "ghost")
        self.assertEqual(r["root_cause"]["breakdown"][-1]["factor"], "blind_spot")
        # one caller past anomaly but below HIGH is not enough corroboration
        one = analyze_incident("shop", nodes, edges, [anomaly("a", "error-rate", 4, "symptom")])
        self.assertNotEqual(top(one), "ghost")
        # one caller past HIGH is enough
        strong = analyze_incident("shop", nodes, edges, [anomaly("a", "error-rate", 6, "symptom")])
        self.assertEqual(top(strong), "ghost")

    def test_monitoring_outage_blames_nobody(self):
        nodes = [node(i) for i in "abcde"]
        anoms = [anomaly(i, "silence", 8, "own") for i in "abcde"]
        r = analyze_incident("shop", nodes, [], anoms)
        self.assertTrue(r["monitoring_gap"])
        self.assertIsNone(r["root_cause"])
        self.assertEqual(r["confidence"], "UNKNOWN")
        self.assertIn("Monitoring outage", r["explanation"]["likely_root_cause"])

    def test_two_silent_of_five_is_not_an_outage(self):
        nodes = [node(i) for i in "abcde"]
        anoms = [anomaly("a", "silence", 8, "own"), anomaly("b", "silence", 8, "own")]
        r = analyze_incident("shop", nodes, [], anoms)
        self.assertFalse(r["monitoring_gap"])

    def test_host_silent_blames_nobody(self):
        r = analyze_incident("shop", [node("a"), node("b")], [], [anomaly("a", "cpu", 9, "own")], host_silent=True)
        self.assertTrue(r["monitoring_gap"])
        self.assertIsNone(r["root_cause"])

    def test_nothing_wrong_means_no_incident(self):
        r = analyze_incident("shop", self.chain_nodes, self.chain_edges, [])
        self.assertFalse(r["incident_detected"])

    def test_silence_is_inherited_from_a_loud_callee(self):
        # orders went quiet because its db is hard down; the silence must not make orders the cause
        nodes = [node("orders"), node("db", "critical", state="dead")]
        anoms = [anomaly("orders", "silence", 8, "own"), anomaly("db", "container-health", None, "hard")]
        r = analyze_incident("shop", nodes, [call("orders", "db")], anoms)
        self.assertEqual(top(r), "db")

    def test_hysteresis_keeps_incumbent_unless_beaten_clearly(self):
        nodes = [node("a"), node("b")]
        near = [anomaly("a", "cpu", 5.0, "own"), anomaly("b", "cpu", 5.5, "own")]
        self.assertEqual(top(analyze_incident("shop", nodes, [], near)), "b")
        self.assertEqual(top(analyze_incident("shop", nodes, [], near, incumbent="a")), "a")   # 5.0 x 1.15 > 5.5
        clear = [anomaly("a", "cpu", 5.0, "own"), anomaly("b", "cpu", 8.0, "own")]
        self.assertEqual(top(analyze_incident("shop", nodes, [], clear, incumbent="a")), "b")  # 5.75 < 8

    def test_independent_problems_get_low_confidence(self):
        nodes = [node("a"), node("b")]
        anoms = [anomaly("a", "cpu", 9, "own"), anomaly("b", "cpu", 6, "own")]
        r = analyze_incident("shop", nodes, [], anoms)
        self.assertEqual(r["confidence"], "LOW")
        self.assertIn("independent problems", r["explanation"]["why"])

    def test_coverage_bonus_breaks_ties(self):
        # a and b equally abnormal; web depends on a, so a explains more of the trouble
        nodes = [node("web"), node("a"), node("b")]
        anoms = [anomaly("a", "cpu", 6, "own"), anomaly("b", "cpu", 6, "own"), anomaly("web", "latency", 4, "symptom")]
        r = analyze_incident("shop", nodes, [call("web", "a")], anoms)
        self.assertEqual(top(r), "a")

    def test_at_risk_uses_noisy_or(self):
        nodes = [node("web"), node("db", "critical", state="exited (1)")]
        r = analyze_incident("shop", nodes, [call("web", "db")], [anomaly("db", "container-health", None, "hard")])
        # evidence(db) = 50 -> min(1, 50/7) = 1 ; risk = 1 - (1 - 1 x 0.5) = 0.5
        self.assertEqual(r["at_risk"], [{"service_id": "web", "service_name": "web", "risk": 0.5, "via": ["db"]}])

    def test_telemetry_edges_do_not_make_a_dashboard_the_cause(self):
        # many services export to grafana-like tools; the weak link (0.1) is not a material dependency
        nodes = [node("api"), node("grafana")]
        anoms = [anomaly("grafana", "cpu", 6, "own"), anomaly("api", "latency", 6, "symptom")]
        r = analyze_incident("shop", nodes, [call("api", "grafana")], anoms)
        reach = dependency_reach("grafana", [call("api", "grafana")], lambda e: 0.1)
        self.assertAlmostEqual(reach["api"], 0.1)
        self.assertTrue(r["incident_detected"])

    def test_reverse_datastore_edge_is_ignored(self):
        # cart-store -> cart is the reverse view of cart -> cart-store, it must not make the store a "caller"
        nodes = [node("cart"), node("cart-store")]
        edges = [call("cart", "cart-store"), call("cart-store", "cart")]
        anoms = [anomaly("cart-store", "memory", 9, "own"), anomaly("cart", "error-rate", 6, "symptom")]
        r = analyze_incident("shop", nodes, edges, anoms)
        self.assertEqual(top(r), "cart-store")

    def test_learning_mode_ignores_soft_evidence(self):
        anoms = [anomaly("db", "memory", 9, "own")]
        r = analyze_incident("shop", self.chain_nodes, self.chain_edges, anoms, learning=True)
        self.assertFalse(r["incident_detected"])


class SmallPiecesTests(unittest.TestCase):
    def test_reach_is_product_of_weights_and_keeps_strongest_path(self):
        edges = [{"source": "a", "target": "b"}, {"source": "b", "target": "c"}, {"source": "a", "target": "c"}]
        w = {("a", "b"): 0.8, ("b", "c"): 0.5, ("a", "c"): 0.3}
        reach = dependency_reach("c", edges, lambda e: w[(e["source"], e["target"])])
        self.assertAlmostEqual(reach["b"], 0.5)
        self.assertAlmostEqual(reach["a"], 0.4)          # 0.8 x 0.5 beats the direct 0.3

    def test_reach_terminates_on_cycles(self):
        edges = [{"source": "a", "target": "b"}, {"source": "b", "target": "a"}]
        reach = dependency_reach("a", edges, lambda e: 0.9)
        self.assertEqual(reach["a"], 1.0)

    def test_timeline_reports_ties(self):
        anoms = [anomaly("x", "cpu", 5, "own", "2026-01-01T10:00:00Z"), anomaly("y", "cpu", 5, "own", "2026-01-01T10:00:00.5Z"),
                 anomaly("z", "cpu", 5, "own", "2026-01-01T10:00:30Z")]
        self.assertEqual(find_earliest_nodes(anoms), {"x", "y"})
        self.assertEqual([p["node_id"] for p in build_timeline(anoms)], ["x", "y", "z"])
        self.assertEqual(build_timeline([]), [])

    def test_explanation_for_unknown_says_so(self):
        e = generate_explanation("shop", T0, None, [], [], [], [], "UNKNOWN")
        self.assertEqual(e["likely_root_cause"], "UNKNOWN")

    def test_explanation_uses_real_counts(self):
        root = {"service_id": "s", "service_name": "sock-shop-db", "score": 0.5, "confidence": "MEDIUM",
                "breakdown": [{"factor": "explains_failures", "reason": "r"}]}
        e = generate_explanation("shop", T0, root, [root], ["sock-shop-db"], ["sock-shop-db"], [], "MEDIUM",
                                 explains={"count": 1, "of": 8})
        self.assertIn("1 of the 8 other affected services depend on it", e["why"])
        self.assertEqual(e["likely_root_cause"], "db")


if __name__ == "__main__":
    unittest.main(verbosity=1)
