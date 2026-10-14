"""python3 algorithms/test_preprocessing_and_ml.py"""
import random
import unittest

from ml_model import blocked_folds, cross_validate, predict, train
from preprocessing import features, request_stats


class PreprocessingTests(unittest.TestCase):
    def test_request_stats(self):
        lines = ['{"msg":"request","status":200,"ms":10}', '{"msg":"request","status":503,"ms":30}', "not json"]
        s = request_stats(lines)
        self.assertEqual((s["count"], s["error_rate"]), (2, 0.5))

    def test_empty_window_is_unknown_not_zero(self):
        s = request_stats([])
        self.assertEqual(s["count"], 0)
        self.assertIsNone(s["error_rate"])

    def test_features_of_a_quiet_service_are_zero(self):
        rnd = random.Random(1)
        h = {"cpu": [10 + rnd.gauss(0, 0.5) for _ in range(40)]}
        f = features(h, False, [], [])
        self.assertEqual((f["own"], f["symptom"], f["down"]), (0.0, 0.0, 0.0))


class MlTests(unittest.TestCase):
    def data(self):
        rnd = random.Random(2)
        rows, labels = [], []
        for _ in range(300):
            y = rnd.random() < 0.15
            rows.append([rnd.gauss(2 if y else 0, 0.7), rnd.gauss(0, 1)])
            labels.append(int(y))
        return rows, labels

    def test_learns_a_simple_pattern(self):
        rows, labels = self.data()
        m = train(rows, labels)
        self.assertGreater(predict(m, [2.5, 0]), predict(m, [0, 0]))
        self.assertGreater(m["w"][0], abs(m["w"][1]))     # the informative feature gets the big weight

    def test_stronger_penalty_shrinks_weights(self):
        rows, labels = self.data()
        self.assertLess(max(abs(w) for w in train(rows, labels, 50)["w"]), max(abs(w) for w in train(rows, labels, 0.01)["w"]))

    def test_folds_are_consecutive_and_cover_everything(self):
        folds = blocked_folds(10, 5)
        self.assertEqual(folds, [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]])

    def test_cross_validation_catches_most(self):
        rows, labels = self.data()
        self.assertGreater(cross_validate(rows, labels)["catch_rate"], 0.6)


if __name__ == "__main__":
    unittest.main()
