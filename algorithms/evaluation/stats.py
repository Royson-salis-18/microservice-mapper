"""Small statistics toolbox for the results section (standard library only).

Question answered: how sure can we be about a percentage measured on a few dozen faults,
and is a result better than luck?

Mirrors: server/algorithms/evaluation/stats.ts (plus wilson, quantile and auc, which live
in score.ts in the TS).

Idea: with 34 faults, "50% detected" is a fuzzy number, so we always attach an interval.
Wilson gives a closed-form interval for a proportion; the bootstrap gets one by resampling;
the binomial test asks whether top-1 hits beat picking a candidate at random; Spearman asks
whether two things move together without assuming a straight line; Cohen's kappa measures
agreement beyond chance. Randomness comes from a tiny seeded generator (mulberry32, same bit
tricks as the TS) so the same input always gives the same output.

Differences from the TS: k_fold shuffles with a Fisher-Yates using the same generator,
because the TS sorts with a random comparator whose result depends on the JS engine; the
fold sizes are the same but the exact members can differ.
"""
import math

MASK = 0xFFFFFFFF


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def sd(xs):
    """Sample standard deviation (n - 1)."""
    if len(xs) < 2:
        return float("nan")
    m = mean(xs)
    return math.sqrt(sum((v - m) ** 2 for v in xs) / (len(xs) - 1))


def quantile(xs, q):
    """Linear interpolation between the two closest sorted values."""
    if not xs:
        return float("nan")
    s = sorted(xs)
    i = (len(s) - 1) * q
    lo = math.floor(i)
    hi = math.ceil(i)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


def wilson(k, n, z=1.96):
    """Wilson score interval for k successes out of n. Behaves for small n and for p near 0 or 1
    (the plain p +- z*sqrt(p(1-p)/n) interval gives 0-width at p=0 or 1)."""
    if n == 0:
        return {"p": float("nan"), "lo": float("nan"), "hi": float("nan"), "n": 0}
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return {"p": p, "lo": max(0.0, (c - m) / d), "hi": min(1.0, (c + m) / d), "n": n}


def moments(xs):
    """n, mean, sd, skewness and excess kurtosis (population formulas for the last two)."""
    n = len(xs)
    m = mean(xs)
    s = math.sqrt(sum((v - m) ** 2 for v in xs) / (n or 1))
    skew = sum(((v - m) / s) ** 3 for v in xs) / n if n > 2 and s > 0 else float("nan")
    kurt = sum(((v - m) / s) ** 4 for v in xs) / n - 3 if n > 3 and s > 0 else float("nan")
    return {"n": n, "mean": m, "sd": sd(xs), "skew": skew, "kurt": kurt}


def ranks(xs):
    """1-based ranks; ties share the average rank."""
    idx = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and xs[idx[j + 1]] == xs[idx[i]]:
            j += 1
        for k in range(i, j + 1):
            r[idx[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def pearson(a, b):
    n = len(a)
    if n < 3:
        return float("nan")
    ma, mb = mean(a), mean(b)
    sab = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    saa = sum((x - ma) ** 2 for x in a)
    sbb = sum((y - mb) ** 2 for y in b)
    return sab / math.sqrt(saa * sbb) if saa and sbb else float("nan")


def spearman(a, b):
    """Pearson correlation of the ranks: catches any monotone relation, robust to outliers."""
    return pearson(ranks(a), ranks(b))


def erf(x):
    """Abramowitz-Stegun approximation (error about 1e-7), same constants as the TS."""
    s = 1 if x >= 0 else -1
    x = abs(x)
    t = 1 / (1 + 0.3275911 * x)
    poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    return s * (1 - poly * math.exp(-x * x))


def norm_cdf(z):
    return 0.5 * (1 + erf(z / math.sqrt(2)))


def corr_p(r, n):
    """Two-sided p-value of a correlation r over n pairs (t statistic, normal tail; fine for n >= 8)."""
    if math.isnan(r) or n < 4:
        return float("nan")
    t = r * math.sqrt((n - 2) / max(1e-12, 1 - r * r))
    z = abs(t) * (1 - 1 / (4 * (n - 2))) / math.sqrt(1 + t * t / (2 * (n - 2)))
    return min(1.0, 2 * (1 - norm_cdf(z)))


def imul(a, b):
    return (a * b) & MASK


def rng(seed):
    """mulberry32: returns a function giving floats in [0, 1)."""
    state = [seed & MASK]

    def nxt():
        state[0] = (state[0] + 0x6D2B79F5) & MASK
        t = state[0]
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296
    return nxt


def bootstrap_ci(xs, iters=2000, seed=7):
    """Percentile bootstrap 95% interval for the mean: resample with replacement, take the
    2.5% and 97.5% points of the resampled means."""
    if not xs:
        return {"mean": float("nan"), "lo": float("nan"), "hi": float("nan"), "n": 0}
    r = rng(seed)
    n = len(xs)
    ms = sorted(sum(xs[int(r() * n)] for _ in range(n)) / n for _ in range(iters))
    return {"mean": mean(xs), "lo": ms[int(0.025 * iters)], "hi": ms[int(0.975 * iters)], "n": n}


def k_fold(outcomes, strata, k=5, seed=11):
    """Stratified k-fold of per-fault outcomes (0/1): how much does the accuracy move between
    disjoint groups of faults? Nothing is trained here, it only shows how stable the figure is."""
    r = rng(seed)
    by_stratum = {}
    for i in range(len(outcomes)):
        by_stratum.setdefault(strata[i], []).append(i)
    folds = [[] for _ in range(k)]
    c = 0
    for idxs in by_stratum.values():
        for i in range(len(idxs) - 1, 0, -1):          # Fisher-Yates shuffle
            j = int(r() * (i + 1))
            idxs[i], idxs[j] = idxs[j], idxs[i]
        for i in idxs:
            folds[c % k].append(i)
            c += 1
    out = [{"n": len(f), "acc": mean([outcomes[i] for i in f])} for f in folds if f]
    accs = [f["acc"] for f in out]
    return {"folds": out, "mean": mean(accs), "sd": sd(accs)}


def binom_upper(k, n, p):
    """Exact one-sided binomial test P(X >= k), X ~ Bin(n, p), summed term by term in logs."""
    if n == 0:
        return float("nan")
    lg = lambda m: math.lgamma(m + 1)       # log(m!)
    total = 0.0
    for i in range(k, n + 1):
        log_c = lg(n) - lg(i) - lg(n - i)
        total += math.exp(log_c + i * math.log(max(p, 1e-12)) + (n - i) * math.log(max(1 - p, 1e-12)))
    return min(1.0, total)


def kappa(counts):
    """Cohen's kappa for a square confusion matrix: (observed - expected agreement) / (1 - expected)."""
    n = sum(sum(row) for row in counts)
    if not n:
        return float("nan")
    po = sum(row[i] for i, row in enumerate(counts)) / n
    rows = [sum(r) for r in counts]
    cols = [sum(r[j] for r in counts) for j in range(len(counts[0]))]
    pe = sum(rows[i] * cols[i] / (n * n) for i in range(len(rows)))
    return float("nan") if pe == 1 else (po - pe) / (1 - pe)


def auc(scores, labels):
    """Area under the ROC curve through the rank-sum (Mann-Whitney) identity."""
    pos = sum(1 for l in labels if l == 1)
    neg = len(labels) - pos
    if not pos or not neg:
        return float("nan")
    rk = ranks(scores)
    sum_pos = sum(r for r, l in zip(rk, labels) if l == 1)
    return (sum_pos - pos * (pos + 1) / 2) / (pos * neg)


if __name__ == "__main__":
    import random
    print("Wilson 33/34:", {k: round(v, 3) for k, v in wilson(33, 34).items()})
    print("Wilson 17/34:", {k: round(v, 3) for k, v in wilson(17, 34).items()})
    g = random.Random(3)
    x = [g.expovariate(1 / 10) for _ in range(40)]            # skewed, like detection delays
    y = [v + g.gauss(0, 5) for v in x]
    print("moments:", {k: round(v, 2) for k, v in moments(x).items()})
    rho = spearman(x, y)
    print(f"spearman rho={rho:.2f}  p={corr_p(rho, len(x)):.4f}")
    hits = [1] * 20 + [0] * 14
    print("bootstrap 20/34:", {k: round(v, 3) for k, v in bootstrap_ci(hits).items()})
    print("binomial P(X>=20) when chance is 0.33:", round(binom_upper(20, 34, 1 / 3), 5))
    print("kappa [[8,2],[1,9]]:", round(kappa([[8, 2], [1, 9]]), 3), " auc:", auc([.1, .4, .35, .8], [0, 0, 1, 1]))
