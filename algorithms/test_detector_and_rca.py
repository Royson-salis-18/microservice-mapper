"""Checks for the detector and the root cause ranking. Run:  python3 algorithms/test_detector_and_rca.py"""
import random
import unittest

from detector import abnormal_scores, detect_service, went_silent
from root_cause import confidence, monitoring_outage, rank_root_causes, reach_from


def steady(n=40, level=10.0, wobble=0.5, seed=1):
    rnd = random.Random(seed)
    return [max(0.0, rnd.gauss(level, wobble)) for _ in range(n)]


def svc(findings=(), status="healthy", hard=False, has_data=True):
    return {"status": status, "hard": hard, "has_data": has_data, "findings": list(findings)}


def finding(metric, score, kind):
    return {"metric": metric, "score": score, "kind": kind, "severity": "HIGH"}


class DetectorTests(unittest.TestCase):
    def test_normal_series_is_not_abnormal(self):
        s = steady()
        self.assertEqual(detect_service({"cpu": s}), [])

    def test_one_odd_sample_is_ignored(self):
        s = steady(); s[-1] = 80.0
        self.assertEqual(detect_service({"cpu": s}), [])

    def test_two_high_samples_are_reported(self):
        s = steady(); s[-2:] = [60.0, 70.0]
        self.assertEqual([f["metric"] for f in detect_service({"cpu": s})], ["cpu"])

    def test_only_the_bad_direction_counts(self):
        s = steady(); s[-2:] = [1.0, 0.5]
        self.assertEqual(detect_service({"cpu": s}), [])      # CPU falling is not a problem
        r = steady(level=50, wobble=2); r[-2:] = [5.0, 4.0]
        self.assertEqual([f["metric"] for f in detect_service({"request_rate": r})], ["request_rate"])

    def test_short_history_says_nothing(self):
        self.assertIsNone(abnormal_scores([1, 2, 3], [100, 100]))

    def test_old_fault_does_not_become_normal(self):
        s = steady(60); s[20:35] = [90.0] * 15; s[-2:] = [90.0, 90.0]
        self.assertTrue(detect_service({"cpu": s}))

    def test_silence(self):
        busy = steady(60, level=20, wobble=2)
        self.assertFalse(went_silent(busy))
        self.assertTrue(went_silent(busy[:-3] + [0.0, 0.0, 0.0]))


class RootCauseTests(unittest.TestCase):
    calls = [("web", "api", 1.0), ("api", "db", 1.0)]

    def test_callee_explains_away_its_callers(self):
        s = {"web": svc([finding("error_rate", 9, "symptom")]), "api": svc([finding("latency", 9, "symptom")]),
             "db": svc([finding("cpu", 12, "own")])}
        ranked = rank_root_causes(s, self.calls)
        self.assertEqual(ranked[0]["service"], "db")

    def test_stopped_container_wins(self):
        s = {"web": svc([finding("error_rate", 30, "symptom")]), "api": svc(status="critical", hard=True), "db": svc()}
        self.assertEqual(rank_root_causes(s, self.calls)[0]["service"], "api")
        self.assertEqual(confidence(rank_root_causes(s, self.calls)), "HIGH")

    def test_nothing_wrong_means_no_candidates(self):
        self.assertEqual(rank_root_causes({"web": svc(), "api": svc(), "db": svc()}, self.calls), [])

    def test_incumbent_is_kept_on_a_near_tie(self):
        s = {"a": svc([finding("cpu", 10.0, "own")]), "b": svc([finding("cpu", 10.5, "own")])}
        self.assertEqual(rank_root_causes(s, [], incumbent="a")[0]["service"], "a")
        self.assertEqual(rank_root_causes(s, [])[0]["service"], "b")

    def test_blind_spot_needs_two_callers(self):
        s = {"w1": svc([finding("error_rate", 6, "symptom")]), "w2": svc([finding("error_rate", 6, "symptom")]),
             "ghost": svc(has_data=False)}
        calls = [("w1", "ghost", 1.0), ("w2", "ghost", 1.0)]
        self.assertEqual(rank_root_causes(s, calls)[0]["service"], "ghost")

    def test_monitoring_outage(self):
        quiet = {n: svc([finding("silence", 9, "own")]) for n in "abcd"}
        self.assertTrue(monitoring_outage(quiet))
        self.assertFalse(monitoring_outage({**quiet, "a": svc(), "b": svc()}))

    def test_reach_multiplies_weights(self):
        reach = reach_from("db", [("api", "db", 0.5), ("web", "api", 0.5)])
        self.assertAlmostEqual(reach["web"], 0.25)


if __name__ == "__main__":
    unittest.main()
