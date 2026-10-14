"""Logistic regression with L2 penalty, class balance, fitted by Newton's method (IRLS).

Question answered: given a table of numbers per service (features) and a 0/1 label
("this service is the faulted one"), what weights give the best probability estimate
without the weights blowing up?

Mirrors: server/algorithms/learning/logreg.ts

Idea: standardise every feature, then repeat Newton steps. Each step builds the gradient g
and the Hessian H of the penalised, weighted log-likelihood and solves H * step = g with a
tiny Gaussian elimination. Faults are rare, so every row is weighted so that both classes
count the same in total (otherwise the model just learns "never"). The L2 penalty (lambda)
keeps weights small and stable on a few hundred positive rows; the intercept is not
penalised. A linear model was chosen on purpose, so each weight can be read by a human.

Left out compared with the TS: TypeScript types and the LOGREG_PARAMS printing object.
"""
import math

ITERATIONS = 30
TOLERANCE = 1e-7
DEFAULT_LAMBDA = 1.0


def sigmoid(z):
    # two branches so exp() never overflows for large |z|
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def solve(A, y):
    """Solve A x = y by Gaussian elimination with partial pivoting (A is small, n ~ 19)."""
    n = len(y)
    M = [list(row) + [y[i]] for i, row in enumerate(A)]
    for c in range(n):
        # pick the row with the biggest value in this column: avoids dividing by tiny numbers
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        d = M[c][c] or 1e-12
        for r in range(c + 1, n):
            f = M[r][c] / d
            for k in range(c, n + 1):
                M[r][k] -= f * M[c][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):  # back substitution
        s = M[r][n] - sum(M[r][k] * x[k] for k in range(r + 1, n))
        x[r] = s / (M[r][r] or 1e-12)
    return x


def fit(X, y, features=None, lam=DEFAULT_LAMBDA, iters=ITERATIONS):
    """Return a model dict: mean, std, w, b, lambda, features."""
    n = len(X)
    d = len(X[0]) if n else 0
    mean = [sum(r[j] for r in X) / max(1, n) for j in range(d)]
    std = [math.sqrt(sum((r[j] - mean[j]) ** 2 for r in X) / max(1, n)) or 1.0 for j in range(d)]
    # leading 1 is the intercept column
    Z = [[1.0] + [(v - mean[j]) / std[j] for j, v in enumerate(r)] for r in X]

    pos = sum(1 for v in y if v == 1)
    neg = n - pos
    # each class gets total weight n/2, so rare faults are not drowned out
    cw = [n / (2 * max(1, pos)) if v == 1 else n / (2 * max(1, neg)) for v in y]

    beta = [0.0] * (d + 1)
    for _ in range(iters):
        g = [0.0] * (d + 1)
        H = [[0.0] * (d + 1) for _ in range(d + 1)]
        for i in range(n):
            z = Z[i]
            p = sigmoid(sum(v * b for v, b in zip(z, beta)))
            w = cw[i] * p * (1 - p)      # curvature of this row
            e = cw[i] * (y[i] - p)       # residual of this row
            for j in range(d + 1):
                g[j] += e * z[j]
                for k in range(j, d + 1):
                    H[j][k] += w * z[j] * z[k]
        for j in range(d + 1):
            for k in range(j):           # H is symmetric: copy the upper triangle
                H[j][k] = H[k][j]
            if j > 0:                    # penalty on every weight except the intercept
                g[j] -= lam * beta[j]
                H[j][j] += lam
            H[j][j] += 1e-9              # keeps H invertible
        step = solve(H, g)
        beta = [b + s for b, s in zip(beta, step)]
        if max(abs(s) for s in step) < TOLERANCE:
            break
    return {"mean": mean, "std": std, "w": beta[1:], "b": beta[0], "lambda": lam,
            "features": list(features) if features else [f"x{j}" for j in range(d)]}


def predict(model, x):
    z = model["b"] + sum(w * (v - m) / s for w, v, m, s in zip(model["w"], x, model["mean"], model["std"]))
    return sigmoid(z)


def contributions(model, x):
    """Each feature's push on the log-odds for one row ("why this score"), biggest first."""
    out = [(model["features"][j], model["w"][j] * (v - model["mean"][j]) / model["std"][j]) for j, v in enumerate(x)]
    return sorted(out, key=lambda t: -abs(t[1]))


if __name__ == "__main__":
    import random
    rng = random.Random(1)
    # toy: 2 useful features, 1 noise feature, 10% positives
    X, y = [], []
    for _ in range(300):
        label = 1 if rng.random() < 0.1 else 0
        X.append([rng.gauss(2.0 * label, 1), rng.gauss(1.5 * label, 1), rng.gauss(0, 1)])
        y.append(label)
    for lam in (0.1, 10, 1000):
        m = fit(X, y, ["useful_a", "useful_b", "noise"], lam)
        print(f"lambda={lam:<6} weights={[round(w, 2) for w in m['w']]} intercept={m['b']:.2f}")
    m = fit(X, y, ["useful_a", "useful_b", "noise"], 1)
    row = [2.0, 1.5, 0.0]
    print("probability for a faulty-looking row:", round(predict(m, row), 3))
    print("why:", [(f, round(v, 2)) for f, v in contributions(m, row)])
