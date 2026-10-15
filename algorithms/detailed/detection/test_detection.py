"""Tests for the detection folder. Run: python3 algorithms/detailed/detection/test_detection.py"""
import math
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import random
import unittest

from detection.anomaly_detector import (SPECS, calculate_z_score, check_silence, detect_anomalies, median,
                                        quantile, robust_score, timestamp_ms)
from detection.container_facts import container_fact, exit_code_of, is_load_generator
from detection.features import FEATURE_NAMES, feature_vectors, node_signals
from detection.request_stats import (merge_windows, parse_request_lines, summarize, throttled_percent)
from detection.scoring import learned_score, make_scorer, moment_scores, rules_score, sigmoid
from detection.thresholds import DEFAULT_THRESHOLDS, LIMITS, merge_thresholds, to_number

RUNNING = {"id": "svc", "name": "svc", "state": "running"}
T0 = 1_700_000_000_000


def steady(n, value=10.0, noise=1.0, seed=1, **extra):
    """n snapshots around `value` (5 s apart)."""
    rng = random.Random(seed)
    return [dict(timestamp=T0 + i * 5000, cpu=value + rng.uniform(-noise, noise), **extra) for i in range(n)]


class ThresholdTests(unittest.TestCase):
    def test_to_number(self):
        self.assertEqual(to_number("4.5"), 4.5)
        for bad in (None, True, "", "abc", float("nan"), float("inf"), [], {}):
            self.assertIsNone(to_number(bad))

    def test_merge_clamps_and_ignores_bad_values(self):
        out = merge_thresholds(DEFAULT_THRESHOLDS, {"z_score_high": 999, "silence_samples": None, "min_delta_percent": "x"})
        self.assertEqual(out["z_score_high"], LIMITS["z_score_high"][1])
        self.assertEqual(out["silence_samples"], 3)
        self.assertEqual(out["min_delta_percent"], 5)

    def test_merge_does_not_change_base_and_handles_no_patch(self):
        merge_thresholds(DEFAULT_THRESHOLDS, {"z_score_anomaly": 1})
        self.assertEqual(DEFAULT_THRESHOLDS["z_score_anomaly"], 3.5)
        self.assertEqual(merge_thresholds(DEFAULT_THRESHOLDS, None), DEFAULT_THRESHOLDS)

    def test_defaults_inside_limits(self):
        for key, (lo, hi) in LIMITS.items():
            self.assertTrue(lo <= DEFAULT_THRESHOLDS[key] <= hi, key)


class ContainerFactTests(unittest.TestCase):
    def fact(self, **kw):
        return container_fact({"name": "svc", **kw})

    def test_basic_states(self):
        self.assertIsNone(self.fact(state="running"))
        self.assertEqual(self.fact(state="paused"), "paused")
        self.assertEqual(self.fact(state="restarting"), "restarting")
        self.assertEqual(self.fact(state="running", network_detached=True), "detached")

    def test_crash_vs_clean_exit(self):
        self.assertEqual(self.fact(state="exited (137)"), "down")
        self.assertEqual(self.fact(state="Exited (0) 2 minutes ago"), "benign")
        self.assertEqual(self.fact(state="exited", exit_code=0), "benign")
        self.assertEqual(self.fact(state="exited", exit_code=1), "down")

    def test_vanished_and_missing_state(self):
        self.assertEqual(self.fact(state="not found"), "down")
        self.assertEqual(self.fact(state="running", vanished=True), "down")
        self.assertEqual(self.fact(state="", health="critical"), "down")
        self.assertIsNone(self.fact())             # nothing known

    def test_load_generator_and_created_are_benign(self):
        self.assertEqual(container_fact({"name": "locust-master", "state": "exited (1)"}), "benign")
        self.assertEqual(self.fact(state="created"), "benign")
        self.assertTrue(is_load_generator("traffic"))
        self.assertFalse(is_load_generator("trafficker-api"))
        self.assertFalse(is_load_generator(None))

    def test_exit_code_parsing(self):
        self.assertEqual(exit_code_of({"status_text": "Exited (3) 1 hour ago"}), 3)
        self.assertIsNone(exit_code_of({"state": "running"}))


class RequestStatsTests(unittest.TestCase):
    def test_both_formats_and_garbage(self):
        w = parse_request_lines(['{"msg":"request","status":200,"ms":10}', '{"msg":"request","status":500,"ms":30}',
                                 '{"status":"200","request_time":"0.002"}', "garbage", '{"msg":"other"}', '{bad json}'])
        self.assertEqual((w["count"], w["errors"]), (3, 1))
        self.assertEqual(sorted(w["ms"]), [2.0, 10.0, 30.0])

    def test_summary_values(self):
        w = {"count": 5, "errors": 1, "ms": [10, 20, 30, 40, 50]}
        s = summarize(w, 10)
        self.assertEqual((s["request_rate"], s["error_rate"], s["latency"]), (0.5, 0.2, 30.0))
        self.assertEqual((s["p50"], s["p95"], s["p99"]), (30.0, 40.0, 40.0))   # floor(p*(n-1)) index rule

    def test_empty_window_is_zero_not_unknown_for_rate(self):
        s = summarize(parse_request_lines([]), 60)
        self.assertEqual(s["request_rate"], 0)
        self.assertIsNone(s["error_rate"])
        self.assertIsNone(s["p95"])

    def test_missing_latency_still_counts_request(self):
        w = parse_request_lines(['{"msg":"request","status":200}'])
        self.assertEqual((w["count"], w["ms"]), (1, []))

    def test_merge_and_throttle(self):
        m = merge_windows([{"count": 1, "errors": 0, "ms": [1]}, {"count": 2, "errors": 1, "ms": [2, 3]}])
        self.assertEqual((m["count"], m["errors"], m["ms"]), (3, 1, [1, 2, 3]))
        self.assertEqual(throttled_percent({"periods": 200, "throttled": 50}, {"periods": 100, "throttled": 20}), 30.0)
        self.assertIsNone(throttled_percent(None, {"periods": 1, "throttled": 0}))
        self.assertIsNone(throttled_percent({"periods": 5, "throttled": 1}, {"periods": 10, "throttled": 1}))  # reset
        self.assertEqual(throttled_percent({"periods": 10, "throttled": 1}, {"periods": 10, "throttled": 1}), 0)


class RobustScoreTests(unittest.TestCase):
    CPU = SPECS[0]

    def test_median_and_quantile(self):
        self.assertEqual(median([3, 1, 2]), 2)
        self.assertEqual(median([4, 1, 3, 2]), 2.5)
        self.assertEqual(quantile([], 0.5), 0)
        self.assertEqual(quantile([1, 2, 3, 4, 5], 0.9), 4)

    def test_too_little_history_gives_none(self):
        self.assertIsNone(robust_score([1.0] * 5, [1, 1], self.CPU, 12))
        self.assertIsNone(robust_score([1.0] * 20, [], self.CPU, 12))

    def test_normal_values_score_low_and_jump_scores_high(self):
        base = [h["cpu"] for h in steady(30)]
        low = robust_score(base, [10.2, 9.8], self.CPU, 12)
        high = robust_score(base, [60, 60], self.CPU, 12)
        self.assertLess(max(low["z"]), 2)
        self.assertGreater(min(high["z"]), 8)
        self.assertAlmostEqual(high["center"], 10, delta=1)

    def test_one_sided(self):
        # request rate: only a DROP is bad (direction -1)
        spec = [s for s in SPECS if s["metric"] == "requestRate"][0]
        base = [5 + 0.1 * (i % 3) for i in range(30)]
        self.assertEqual(max(robust_score(base, [50, 50], spec, 12)["z"]), 0)
        self.assertGreater(min(robust_score(base, [0, 0], spec, 12)["z"]), 5)

    def test_missing_recent_value_is_nan_not_zero(self):
        r = robust_score([10.0 + (i % 3) for i in range(30)], [None, 50], self.CPU, 12)
        self.assertTrue(math.isnan(r["z"][0]))

    def test_noisy_series_is_shrunk(self):
        rng = random.Random(4)
        noisy = [10 + rng.choice([0, 0, 0, 40]) for _ in range(60)]
        self.assertGreater(robust_score(noisy, [10, 10], self.CPU, 12)["noise_shrink"], 1)

    def test_self_healing_drops_old_incident(self):
        old_fault = [10.0 + (i % 3) * 0.2 for i in range(30)] + [80.0] * 6 + [10.0 + (i % 3) * 0.2 for i in range(10)]
        r = robust_score(old_fault, [80, 80], self.CPU, 12)
        self.assertLess(r["center"], 15)            # the 80% run did not pull the baseline up
        self.assertGreater(min(r["z"]), 8)          # so a new 80% is still anomalous


class DetectAnomaliesTests(unittest.TestCase):
    def test_cpu_jump_is_critical(self):
        hist = steady(30) + [{"timestamp": T0 + (30 + i) * 5000, "cpu": 61} for i in range(2)]
        found = detect_anomalies(RUNNING, hist)
        self.assertEqual([(a["metric"], a["severity"]) for a in found], [("cpu", "CRITICAL")])

    def test_single_spike_is_ignored_persistence(self):
        hist = steady(31) + [{"timestamp": T0 + 31 * 5000, "cpu": 61}]
        hist[-2]["cpu"] = 10
        self.assertEqual(detect_anomalies(RUNNING, hist), [])

    def test_healthy_and_cold_start_are_quiet(self):
        self.assertEqual(detect_anomalies(RUNNING, steady(40)), [])
        short = steady(10) + [{"cpu": 90}, {"cpu": 90}]
        self.assertEqual([a["metric"] for a in detect_anomalies(RUNNING, short)], [])   # 12 samples < 14 needed

    def test_always_high_cpu_hits_absolute_limit(self):
        found = detect_anomalies(RUNNING, steady(32, value=92, noise=0.5))
        self.assertEqual([(a["metric"], a["reason"]) for a in found], [("cpu", "over-absolute-limit")])

    def test_small_move_ignored_by_min_delta(self):
        hist = steady(30, value=0.05, noise=0.01) + [{"cpu": 2.0}, {"cpu": 2.0}]
        self.assertEqual(detect_anomalies(RUNNING, hist), [])

    def test_missing_values_are_unknown_not_zero(self):
        hist = [{"timestamp": T0 + i * 5000} for i in range(40)]
        self.assertEqual(detect_anomalies(RUNNING, hist), [])

    def test_container_facts_and_restarts(self):
        down = detect_anomalies({"name": "x", "state": "exited (137)"}, [])
        self.assertEqual((down[0]["metric"], down[0]["severity"], down[0]["reason"]),
                         ("container-health", "CRITICAL", "container-exited-or-critical"))
        self.assertEqual(detect_anomalies({"name": "job", "state": "exited (0)"}, steady(3)), [])
        gone = detect_anomalies({"name": "x", "state": "not found", "vanished": True}, [])
        self.assertEqual(gone[0]["reason"], "container-vanished")
        hist = steady(5)
        hist[-1]["restart_delta"] = 2
        got = detect_anomalies(RUNNING, hist)
        self.assertEqual((got[0]["metric"], got[0]["observed"], got[0]["severity"]), ("restarts", 2, "HIGH"))

    def test_few_requests_skip_latency_check(self):
        hist = [{"p95_latency": 20.0 + (i % 3), "request_count": 20, "cpu": 5} for i in range(30)]
        hist += [{"p95_latency": 900, "request_count": 2, "cpu": 5}, {"p95_latency": 900, "request_count": 2, "cpu": 5}]
        self.assertEqual(detect_anomalies(RUNNING, hist), [])
        for h in hist[-2:]:
            h["request_count"] = 30
        self.assertEqual([a["metric"] for a in detect_anomalies(RUNNING, hist)], ["latency"])


class SilenceTests(unittest.TestCase):
    def test_busy_service_going_quiet(self):
        hist = [{"cpu": 5 + (i % 3), "network_rx_rate": 2000} for i in range(27)] + [{"cpu": 0, "network_rx_rate": 0}] * 3
        s = check_silence(hist, DEFAULT_THRESHOLDS)
        self.assertEqual((s["metric"], s["severity"]), ("silence", "CRITICAL"))

    def test_mostly_idle_service_is_not_silent(self):
        hist = [{"cpu": 5 if i % 3 == 0 else 0, "network_rx_rate": 0} for i in range(27)] + [{"cpu": 0, "network_rx_rate": 0}] * 3
        self.assertIsNone(check_silence(hist, DEFAULT_THRESHOLDS))

    def test_no_readings_is_unknown(self):
        self.assertIsNone(check_silence([{}] * 40, DEFAULT_THRESHOLDS))

    def test_poisson_silence_and_bursty_exception(self):
        busy = [{"cpu": 5, "request_rate": 4.0 + (i % 2) * 0.1, "timestamp": T0 + i * 5000} for i in range(57)]
        quiet = [{"cpu": 5, "request_rate": 0, "timestamp": T0 + (57 + i) * 5000} for i in range(3)]
        self.assertEqual(check_silence(busy + quiet, DEFAULT_THRESHOLDS)["reason"], "service-went-silent")
        # a service that already had a 3-sample quiet gap before: 3 quiet samples is not unusual
        gappy = busy[:20] + [{"cpu": 5, "request_rate": 0, "timestamp": T0 + 999}] * 3 + busy[23:]
        self.assertIsNone(check_silence(gappy + quiet, DEFAULT_THRESHOLDS))

    def test_low_traffic_service_never_counts_as_silent(self):
        slow = [{"cpu": 5, "request_rate": 0.1, "timestamp": T0 + i * 5000} for i in range(57)]
        quiet = [{"cpu": 5, "request_rate": 0, "timestamp": T0 + (57 + i) * 5000} for i in range(3)]
        self.assertIsNone(check_silence(slow + quiet, DEFAULT_THRESHOLDS))


class SimpleZScoreTests(unittest.TestCase):
    def test_flat_baseline_jump(self):
        a = calculate_z_score([5.0] * 20, [40, 90], "cpu")
        self.assertEqual((a["reason"], a["severity"]), ("flat-baseline-jump", "CRITICAL"))
        self.assertIsNone(calculate_z_score([5.0] * 20, [40, 6], "cpu"))      # second sample back to normal

    def test_two_sided_and_empty(self):
        base = [50 + (i % 5) for i in range(30)]
        self.assertIsNotNone(calculate_z_score(base, [20, 18], "m"))           # a drop also counts here
        self.assertIsNone(calculate_z_score(base, [20, 80], "m"))              # different sides
        self.assertIsNone(calculate_z_score([], [1], "m"))


class FeatureAndScoringTests(unittest.TestCase):
    def history(self, slow):
        rng = random.Random(3)
        lat = [20 + rng.uniform(-2, 2) for _ in range(28)] + ([400, 410] if slow else [20, 21])
        return [{"cpu": 10 + rng.uniform(-1, 1), "p95_latency": v, "request_count": 30, "request_rate": 6} for v in lat]

    def test_node_signals_short_history_is_zero(self):
        s = node_signals(RUNNING, steady(5))
        self.assertEqual((s["own"], s["sym"], s["noData"]), (0, 0, 0))
        self.assertEqual(node_signals(RUNNING, [])["noData"], 1)

    def test_latency_rise_is_symptom_not_own(self):
        s = node_signals(RUNNING, self.history(True))
        self.assertGreater(s["sym"], 8)
        self.assertLess(s["own"], 3)

    def test_feature_vector_shape_and_neighbours(self):
        nodes = [{"id": "web", "name": "web", "state": "running"}, {"id": "api", "name": "api", "state": "running"}]
        sigs = [node_signals(nodes[0], self.history(True)), node_signals(nodes[1], self.history(False))]
        v = feature_vectors(sigs, [("web", "api")], lambda i: i)
        self.assertEqual(len(v["api"]), len(FEATURE_NAMES))
        i = FEATURE_NAMES.index("callersSymptomMax")
        self.assertGreater(v["api"][i], 2)       # api's caller is suffering
        self.assertEqual(v["web"][i], 0)

    def test_store_callers_and_self_edges_ignored(self):
        sigs = [node_signals({"id": "db", "name": "db"}, self.history(True)), node_signals({"id": "api", "name": "api"}, self.history(False))]
        v = feature_vectors(sigs, [("db", "api"), ("api", "api")], lambda i: i)
        self.assertEqual(v["api"][FEATURE_NAMES.index("callersSymptomMax")], 0)

    def test_rules_explain_away(self):
        def vec(**kw):
            x = [0.0] * len(FEATURE_NAMES)
            for k, val in kw.items():
                x[FEATURE_NAMES.index(k)] = val
            return x
        z9 = math.log1p(9)
        self.assertAlmostEqual(rules_score(vec(own=z9)), 9)
        self.assertAlmostEqual(rules_score(vec(symptom=z9, calleesEvidenceMax=z9)), 0)
        self.assertAlmostEqual(rules_score(vec(down=1)), 10)

    def test_learned_score_and_sigmoid(self):
        self.assertAlmostEqual(sigmoid(0), 0.5)
        self.assertEqual(sigmoid(-1000), 0.0)
        self.assertEqual(sigmoid(1000), 1.0)
        w = {"mean": [0] * 3, "std": [0, 1, 1], "w": [1, 0, 0], "b": 0}
        self.assertAlmostEqual(learned_score(w, [2, 0, 0]), sigmoid(2))        # std 0 treated as 1

    def test_moment_scores_skip_load_generators_and_pick_cause(self):
        nodes = [{"id": "web", "name": "web", "state": "running"}, {"id": "api", "name": "api", "state": "running"},
                 {"id": "lg", "name": "traffic-gen", "state": "running"}]
        hist = {"web": self.history(True), "api": self.history(False), "lg": self.history(False)}
        scores = moment_scores(nodes, lambda i: hist[i], [("web", "api")], make_scorer(None))
        self.assertNotIn("lg", scores)
        self.assertGreater(scores["web"], scores["api"])
        self.assertEqual(make_scorer(None)[0], "rules")
        self.assertEqual(make_scorer({"mean": [], "std": [], "w": [], "b": 0})[0], "learned")


class TimestampTests(unittest.TestCase):
    def test_iso_and_numbers(self):
        self.assertEqual(timestamp_ms("2023-11-14T22:13:20Z"), 1_700_000_000_000)
        self.assertEqual(timestamp_ms(1234), 1234)
        self.assertTrue(math.isnan(timestamp_ms("nope")))


if __name__ == "__main__":
    unittest.main(verbosity=1)
