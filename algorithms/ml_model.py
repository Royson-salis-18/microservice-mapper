"""The learned model: can a small model combine the signals better than the hand-made rules?

Run it:  python3 algorithms/ml_model.py

What it does
  - Logistic regression: score = sigmoid(w1*x1 + w2*x2 + ... + b), the probability that a
    service is the cause. Weights are learned from rows labelled by the fault injector's
    answer key (1 = this service was the faulted one, 0 = it was not).
  - Class balance: faulted rows are rare, so they are weighted up, otherwise "never alarm" wins.
  - L2 penalty (lambda): keeps weights small so two similar features cannot take huge opposite weights.
  - Blocked cross-validation: rows are kept in time order and cut into consecutive blocks.
    Train on the other blocks, test on this one. Never shuffled, because in real use the model
    is tested on the future, and shuffling would let it peek at neighbours of the test rows.

The real system fits the same model with Newton's method (server/algorithms/learning/logreg.ts) and
tests it on 34 recorded faults. The result there: the learned model found 50% of the faults against
97% for the rules, so the rules are what the mapper uses. This file is the idea, on made-up data.
"""
import math
import random


def sigmoid(z):
    return 1 / (1 + math.exp(-z)) if z >= 0 else math.exp(z) / (1 + math.exp(z))


def standardise(rows):
    """Put every feature on the same scale (mean 0, spread 1), so one big feature cannot dominate."""
    n, k = len(rows), len(rows[0])
    mean = [sum(r[j] for r in rows) / n for j in range(k)]
    std = [math.sqrt(sum((r[j] - mean[j]) ** 2 for r in rows) / n) or 1.0 for j in range(k)]
    return mean, std


def train(rows, labels, lam=1.0, steps=2000, rate=0.1):
    """Gradient descent on the weighted, L2-penalised log loss. Returns the model as a dict."""
    mean, std = standardise(rows)
    x = [[(v - mean[j]) / std[j] for j, v in enumerate(r)] for r in rows]
    positives = sum(labels)
    weight = {1: len(labels) / (2 * positives), 0: len(labels) / (2 * (len(labels) - positives))}   # balance the classes
    rate = min(rate, 0.5 / lam) if lam > 0 else rate     # a strong penalty needs smaller steps or the weights blow up
    w, b = [0.0] * len(x[0]), 0.0
    for _ in range(steps):
        grad_w, grad_b = [lam * wj for wj in w], 0.0
        for xi, yi in zip(x, labels):
            err = (sigmoid(sum(wj * v for wj, v in zip(w, xi)) + b) - yi) * weight[yi] / len(labels)
            grad_b += err
            for j, v in enumerate(xi):
                grad_w[j] += err * v
        w = [wj - rate * g for wj, g in zip(w, grad_w)]
        b -= rate * grad_b
    return {"w": w, "b": b, "mean": mean, "std": std}


def predict(model, row):
    z = model["b"] + sum(wj * (v - m) / s for wj, v, m, s in zip(model["w"], row, model["mean"], model["std"]))
    return sigmoid(z)


def blocked_folds(n, k=5):
    """Consecutive blocks of row numbers: [0..n/k), [n/k..2n/k), ... (no shuffling)."""
    size = n // k
    return [list(range(i * size, n if i == k - 1 else (i + 1) * size)) for i in range(k)]


def cross_validate(rows, labels, k=5, lam=1.0, threshold=0.5):
    """Train on k-1 blocks, test on the held-out one. Returns catch rate and false alarm rate over all blocks."""
    caught = missed = false_alarms = quiet = 0
    for test in blocked_folds(len(rows), k):
        held_out = set(test)
        train_rows = [r for i, r in enumerate(rows) if i not in held_out]
        train_labels = [y for i, y in enumerate(labels) if i not in held_out]
        model = train(train_rows, train_labels, lam)
        for i in test:
            alarm = predict(model, rows[i]) >= threshold
            if labels[i] == 1:
                caught, missed = caught + alarm, missed + (not alarm)
            else:
                false_alarms, quiet = false_alarms + alarm, quiet + (not alarm)
    return {"catch_rate": caught / max(1, caught + missed), "false_alarm_rate": false_alarms / max(1, false_alarms + quiet)}


if __name__ == "__main__":
    # made-up rows in time order: [own, symptom, callers, callees, down]; a faulted service has high own/symptom
    rnd = random.Random(3)
    rows, labels = [], []
    for _ in range(600):
        faulted = rnd.random() < 0.1
        rows.append([rnd.gauss(2.5 if faulted else 0.3, 0.8), rnd.gauss(2.0 if faulted else 0.4, 0.8),
                     rnd.gauss(1.5 if faulted else 0.3, 0.8), rnd.gauss(0.2, 0.3), float(faulted and rnd.random() < 0.3)])
        labels.append(int(faulted))

    model = train(rows, labels)
    print("weights (own, symptom, callers, callees, down):", [round(w, 2) for w in model["w"]])
    print("blocked 5-fold:", {k: round(v, 2) for k, v in cross_validate(rows, labels).items()})
    for lam in (0.01, 1, 100):
        print(f"lambda {lam:>6}: biggest weight", round(max(abs(w) for w in train(rows, labels, lam)["w"]), 2))
