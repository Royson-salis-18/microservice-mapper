"""Tests for the graph files. Run: python3 algorithms/graph/test_graph.py"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from graph.cascade_engine import (band_for, intrinsic_probability, predict_cascade,  # noqa: E402
                                  simulate_failure, structural_criticality)
from graph.consistency import check_consistency  # noqa: E402
from graph.edge_weights import compute_edge_weights, edge_confidence, is_telemetry_edge  # noqa: E402
from graph.link_thresholds import link_status  # noqa: E402
from graph.service_roles import is_observability_service  # noqa: E402


def edge(a, b, w=None, **extra):
    e = {"id": f"{a}>{b}", "source": a, "target": b}
    if w is not None:
        e["weight"] = {"value": w}
    e.update(extra)
    return e


def node(i, status="healthy", **extra):
    return {"id": i, "name": i, "status": status, **extra}


class EdgeWeightTests(unittest.TestCase):
    def test_confidence_levels(self):
        self.assertEqual(edge_confidence({"observed": True, "evidence_sources": ["http-log"]})[0], 1.0)
        self.assertEqual(edge_confidence({"observed": True, "evidence_sources": ["direction:ephemeral-port"]})[0], 0.85)
        self.assertEqual(edge_confidence({"observed": True, "evidence_sources": ["direction:unresolved"]})[0], 0.5)
        self.assertEqual(edge_confidence({"observed": True})[0], 0.7)
        self.assertEqual(edge_confidence({"declared": True})[0], 0.4)
        self.assertEqual(edge_confidence({})[0], 0)

    def test_request_shares_and_weight_formula(self):
        edges = [edge("a", "b", observed=True, evidence_sources=["http-log"], metrics={"request_rate": 75}),
                 edge("a", "c", observed=True, evidence_sources=["direction:ephemeral-port"], metrics={"request_rate": 25})]
        w = compute_edge_weights(edges)
        self.assertEqual(w["a>b"]["dependency"], 0.75)
        self.assertEqual(w["a>b"]["value"], 0.75)                 # confidence 1.0
        self.assertEqual(w["a>c"]["value"], 0.213)                # 0.85 x 0.25 = 0.2125, rounded half up
        self.assertEqual(w["a>b"]["basis"], "requests")

    def test_shares_sum_to_one_with_unmeasured_edge(self):
        edges = [edge("a", "b", observed=True, evidence_sources=["http-log"], activity={"samples_per_min": 30}),
                 edge("a", "c", observed=True, evidence_sources=["http-log"], activity={"samples_per_min": 10}),
                 edge("a", "d", observed=True, evidence_sources=["http-log"])]          # no traffic figure
        w = compute_edge_weights(edges)
        total = sum(w[k]["dependency"] for k in w)
        self.assertAlmostEqual(total, 1.0, places=2)
        self.assertEqual(w["a>d"]["dependency"], 0.333)

    def test_uniform_split_when_no_traffic(self):
        w = compute_edge_weights([edge("a", "b", declared=True), edge("a", "c", declared=True)])
        self.assertEqual(w["a>b"]["dependency"], 0.5)
        self.assertEqual(w["a>b"]["value"], 0.2)                  # 0.4 x 0.5
        self.assertEqual(w["a>b"]["basis"], "uniform")

    def test_telemetry_is_scaled_and_grouped_separately(self):
        edges = [edge("api", "db", observed=True, evidence_sources=["http-log"], metrics={"request_rate": 10}),
                 edge("api", "otel-collector", observed=True, evidence_sources=["http-log"], metrics={"request_rate": 50})]
        self.assertTrue(is_telemetry_edge(edges[1]))
        w = compute_edge_weights(edges)
        self.assertEqual(w["api>db"]["value"], 1.0)               # depends on its db completely, not 17%
        self.assertEqual(w["api>otel-collector"]["value"], 0.1)

    def test_candidate_edges_get_zero_and_do_not_dilute(self):
        edges = [edge("a", "b", observed=True, evidence_sources=["http-log"]), edge("a", "c")]
        w = compute_edge_weights(edges)
        self.assertEqual(w["a>c"]["value"], 0)
        self.assertEqual(w["a>b"]["dependency"], 1.0)

    def test_stress(self):
        e = edge("a", "b", observed=True, metrics={"error_rate": 0.025, "p95_latency": 200})
        self.assertEqual(compute_edge_weights([e])["a>b"]["stress"], 0.5)


class RolesAndLinksTests(unittest.TestCase):
    def test_roles(self):
        self.assertTrue(is_observability_service("shop:grafana"))
        self.assertTrue(is_observability_service("otelcollector"))
        self.assertFalse(is_observability_service("elasticsearch"))
        self.assertFalse(is_observability_service("shop:orders"))

    def test_link_status(self):
        self.assertEqual(link_status(0, 100), "active")
        self.assertEqual(link_status(0.01, 100), "degraded")
        self.assertEqual(link_status(0, 300), "degraded")
        self.assertEqual(link_status(0.05, 0), "failed")
        self.assertEqual(link_status(None, 1000), "failed")
        self.assertEqual(link_status(None, None), "active")


class CascadeTests(unittest.TestCase):
    def test_intrinsic_probability(self):
        self.assertEqual(intrinsic_probability(node("a", "critical"))[0], 1.0)
        self.assertEqual(intrinsic_probability(node("a", "unknown"))[0], 0.0)
        p, why = intrinsic_probability(node("a", "degraded", anomaly_score=0.5, anomaly_persistent=True))
        self.assertAlmostEqual(p, 1 - 0.5 * (1 - 0.5 * 0.8))   # 0.7
        self.assertEqual(len(why), 2)
        self.assertEqual(band_for(0.7), "high")
        self.assertEqual(band_for(0.15), "low")
        self.assertEqual(band_for(0.14), "minimal")

    def test_risk_flows_from_callee_to_caller(self):
        nodes = [node("web"), node("orders"), node("db", "critical")]
        r = predict_cascade(nodes, [edge("web", "orders", 0.8), edge("orders", "db", 0.9)])
        p = {d["id"]: d["probability"] for d in r["nodes"]}
        self.assertEqual(p["db"], 1.0)
        self.assertAlmostEqual(p["orders"], 0.63, places=3)           # 1 - (1 - 0.7 x 0.9)
        self.assertAlmostEqual(p["web"], 0.353, places=3)             # 0.7 x 0.8 x 0.63
        self.assertEqual([d["id"] for d in r["at_risk"]], ["orders", "web"])
        web = next(d for d in r["nodes"] if d["id"] == "web")
        self.assertEqual(web["path"], ["web", "orders", "db"])
        self.assertEqual(web["depth"], 2)

    def test_cycle_converges(self):
        nodes = [node("a", "degraded"), node("b"), node("c")]
        edges = [edge("a", "b", 0.9), edge("b", "c", 0.9), edge("c", "a", 0.9)]
        r = predict_cascade(nodes, edges)
        self.assertTrue(r["converged"])
        self.assertLess(r["iterations"], 200)
        for d in r["nodes"]:
            self.assertTrue(0 <= d["probability"] <= 1)
        # every probability is at least its own p0 (risk only adds)
        self.assertGreaterEqual(next(d for d in r["nodes"] if d["id"] == "a")["probability"], 0.5)

    def test_unknown_status_creates_no_phantom_cascade(self):
        r = predict_cascade([node("a", "unknown"), node("b", "unknown")], [edge("a", "b", 1.0)])
        self.assertEqual(r["expected_failures"], 0)

    def test_tau_scales_transmission(self):
        nodes, edges = [node("a"), node("b", "critical")], [edge("a", "b", 1.0)]
        self.assertEqual(predict_cascade(nodes, edges, tau=0.5)["nodes"][1]["probability"], 0.5)
        self.assertEqual(predict_cascade(nodes, edges, tau=0.0)["nodes"][1]["probability"], 0.0)

    def test_what_if_ignores_current_state_of_origin_but_keeps_others(self):
        nodes = [node("web"), node("orders"), node("db"), node("mail", "degraded")]
        edges = [edge("web", "orders", 0.8), edge("orders", "db", 0.9), edge("web", "mail", 0.2)]
        r = simulate_failure("db", nodes, edges)
        self.assertEqual(r["origin"], "db")
        self.assertEqual([d["id"] for d in r["affected"]], ["orders", "web"])
        self.assertEqual(r["affected"][0]["delta"], 0.63)
        # web was already at risk through the degraded mail, so its extra risk is below the 0.353 of a clean start
        self.assertLess(r["affected"][1]["delta"], 0.353)
        self.assertAlmostEqual(r["expected_additional_failures"], sum(d["delta"] for d in r["affected"]), places=3)
        self.assertIsNone(simulate_failure("nope", nodes, edges))

    def test_structural_criticality(self):
        nodes = [node("web"), node("orders"), node("db")]
        edges = [edge("web", "orders", 0.8), edge("orders", "db", 0.9)]
        crit = structural_criticality(nodes, edges, lambda e: 10)
        self.assertTrue(all(0 <= v <= 1 for v in crit.values()))
        self.assertGreater(crit["orders"], crit["web"])               # the middle service touches both links
        self.assertEqual(structural_criticality(nodes, edges, lambda e: 0), {"web": None, "orders": None, "db": None})

    def test_weights_are_computed_when_missing(self):
        nodes = [node("a"), node("b", "critical")]
        r = predict_cascade(nodes, [{"id": "e", "source": "a", "target": "b", "observed": True, "evidence_sources": ["http-log"]}])
        self.assertEqual(next(d for d in r["nodes"] if d["id"] == "a")["probability"], 0.7)


class ConsistencyTests(unittest.TestCase):
    def rules(self, nodes, edges, incidents=()):
        return {v["rule"] for v in check_consistency(nodes, edges, incidents)["violations"]}

    def test_clean_graph_has_no_violations(self):
        nodes = [{"id": "p:a", "project": "p", "analytics": {"risk_score": 0.5}}, {"id": "p:b", "project": "p"}]
        edges = [{"id": "e", "source": "p:a", "target": "p:b",
                  "weight": {"value": 0.8, "confidence": 1.0, "dependency": 0.8, "kind": "request"}}]
        # one edge whose dependency is 0.8 does not sum to 100%: that is a violation, so use 1.0
        edges[0]["weight"].update(value=1.0, dependency=1.0)
        self.assertEqual(check_consistency(nodes, edges)["violations"], [])

    def test_unknown_endpoint_and_ranges(self):
        nodes = [{"id": "a", "analytics": {"risk_score": 1.5}, "metrics": {"memory_percent": 140, "cpu": -1, "network_rx_rate": 2e10}}]
        found = self.rules(nodes, [{"id": "e", "source": "a", "target": "ghost"}])
        self.assertTrue({"edge-endpoints", "score-range", "metric-range", "rate-not-total"} <= found)

    def test_inherited_and_via_and_health_sum(self):
        nodes = [{"id": "a", "analytics": {"failure_probability": 0.2, "affected_probability": 0.4, "cascade_via": "z",
                                           "health_score": 0.8, "health_breakdown": [{"score": 0.5}, {"score": 0.1}]}}]
        found = self.rules(nodes, [])
        self.assertTrue({"inherited-within-total", "cascade-via-is-dependency", "health-breakdown-sum"} <= found)

    def test_weight_formula_and_share_sum(self):
        nodes = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
        edges = [{"id": "e1", "source": "a", "target": "b", "weight": {"value": 0.9, "confidence": 1.0, "dependency": 0.5, "kind": "request"}},
                 {"id": "e2", "source": "a", "target": "c", "weight": {"value": 0.5, "confidence": 1.0, "dependency": 0.5, "kind": "request"}}]
        self.assertEqual(self.rules(nodes, edges), {"weight-formula"})        # shares sum to 100%, weight e1 is wrong
        edges[0]["weight"]["value"] = 0.5
        edges[1]["weight"]["dependency"] = 0.9
        self.assertIn("reliance-sums-to-one", self.rules(nodes, edges))
        telemetry = [{"id": "t", "source": "a", "target": "b", "weight": {"value": 0.1, "confidence": 1.0, "dependency": 1.0, "kind": "telemetry"}}]
        self.assertEqual(self.rules(nodes, telemetry), set())                 # 1.0 x 1.0 x 0.1

    def test_incident_rules(self):
        nodes = [{"id": "p:a", "project": "p"}, {"id": "q:b", "project": "q"}]
        inc = {"id": "i1", "status": "OPEN", "target_id": "p", "root_cause_service_id": "q:b", "affected_services": ["p:zz"],
               "root_cause_score": 1.7, "candidate_causes": [{"service_id": "p:a"}]}
        found = self.rules(nodes, [], [inc])
        self.assertTrue({"incident-references", "score-range", "root-cause-is-candidate"} <= found)
        inc["status"] = "RESOLVED"
        self.assertEqual(self.rules(nodes, [], [inc]), set())

    def test_negative_activity(self):
        e = {"id": "e", "source": "a", "target": "a", "activity": {"open_connections": -2}}
        self.assertIn("activity-range", self.rules([{"id": "a"}], [e]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
