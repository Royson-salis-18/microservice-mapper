"""Shared style and statistics for the paper's figures (numpy and matplotlib only)."""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
FIG = os.path.join(ROOT, "figures")
os.makedirs(FIG, exist_ok=True)

# Okabe-Ito colour-blind-safe palette; every series also gets its own marker and line style so figures survive greyscale
C = {"blue": "#0072B2", "orange": "#D55E00", "green": "#009E73", "pink": "#CC79A7", "amber": "#E69F00", "sky": "#56B4E9", "black": "#222222", "grey": "#8c8c8c"}
ENGINE_STYLE = {
    "rules": dict(color=C["grey"], marker="s", ls="--", label="Rules"),
    "severity": dict(color=C["amber"], marker="v", ls="-.", label="Severity (anomaly only)"),
    "ml": dict(color=C["sky"], marker="^", ls=":", label="ML engine"),
    "hybrid": dict(color=C["blue"], marker="o", ls="-", label="Hybrid (ours)"),
    "hybrid + change-point": dict(color=C["green"], marker="D", ls="-", label="Hybrid + change-point"),
    "hybrid + learned directions": dict(color=C["pink"], marker="P", ls="-", label="Hybrid + learned dir."),
}
SINGLE, DOUBLE = 3.45, 7.1


def style():
    plt.rcParams.update({
        "font.family": "serif", "font.serif": ["STIXGeneral", "DejaVu Serif"], "mathtext.fontset": "stix",
        "font.size": 7.5, "axes.titlesize": 8, "axes.labelsize": 7.5, "xtick.labelsize": 7, "ytick.labelsize": 7, "legend.fontsize": 6.5,
        "axes.linewidth": 0.6, "xtick.major.width": 0.6, "ytick.major.width": 0.6, "xtick.major.size": 2.5, "ytick.major.size": 2.5,
        "lines.linewidth": 1.2, "lines.markersize": 3.6, "axes.grid": True, "grid.linewidth": 0.35, "grid.alpha": 0.45, "grid.linestyle": ":",
        "axes.spines.top": False, "axes.spines.right": False, "legend.frameon": False, "figure.dpi": 150, "savefig.dpi": 300,
        "pdf.fonttype": 42, "ps.fonttype": 42, "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
    })


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def save(fig, name):
    fig.savefig(os.path.join(FIG, name + ".pdf"))
    plt.close(fig)
    print("figure", name)


def panel_label(ax, text, dx=-0.14, dy=1.04):
    ax.text(dx, dy, text, transform=ax.transAxes, fontsize=8.5, fontweight="bold", va="bottom", ha="left")


# ---------------------------------------------------------------- statistics
def boot_ci(x, stat=np.mean, n=4000, seed=0, alpha=0.05):
    """Percentile bootstrap interval of a statistic over the rows of x."""
    rng = np.random.default_rng(seed)
    x = np.asarray(x)
    idx = rng.integers(0, len(x), size=(n, len(x)))
    vals = np.array([stat(x[i]) for i in idx]) if x.ndim == 1 else np.array([stat(x[i]) for i in idx])
    return float(np.quantile(vals, alpha / 2)), float(np.quantile(vals, 1 - alpha / 2))


def paired_boot_diff(a, b, n=6000, seed=0):
    """Mean difference a - b of two paired 0/1 (or real) vectors with a 95% bootstrap interval and a two-sided p value."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = a - b
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(n, len(d)))
    m = d[idx].mean(axis=1)
    lo, hi = np.quantile(m, [0.025, 0.975])
    p = 2 * min((m <= 0).mean(), (m >= 0).mean())
    return float(d.mean()), float(lo), float(hi), float(min(1.0, max(p, 1.0 / n)))


def roc_pr(scores, labels):
    """ROC and precision-recall curves, AUROC and average precision."""
    s, y = np.asarray(scores, float), np.asarray(labels, int)
    order = np.argsort(-s, kind="mergesort")
    s, y = s[order], y[order]
    tp, fp = np.cumsum(y), np.cumsum(1 - y)
    P, N = y.sum(), (1 - y).sum()
    distinct = np.r_[np.where(np.diff(s))[0], len(s) - 1]
    tpr, fpr = np.r_[0, tp[distinct] / P], np.r_[0, fp[distinct] / N]
    prec, rec = tp[distinct] / (tp[distinct] + fp[distinct]), tp[distinct] / P
    auroc = float(np.trapezoid(tpr, fpr))
    ap = float(np.sum(np.diff(np.r_[0, rec]) * prec))
    return fpr, tpr, rec, prec, auroc, ap


def reliability(p, y, bins=8, quantile=True):
    p, y = np.asarray(p, float), np.asarray(y, float)
    edges = np.quantile(p, np.linspace(0, 1, bins + 1)) if quantile else np.linspace(0, 1, bins + 1)
    edges = np.unique(edges)
    mids, freq, cnt = [], [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & ((p < hi) if hi < edges[-1] else (p <= hi))
        if m.sum() == 0:
            continue
        mids.append(p[m].mean()); freq.append(y[m].mean()); cnt.append(int(m.sum()))
    mids, freq, cnt = np.array(mids), np.array(freq), np.array(cnt)
    ece = float((cnt / cnt.sum() * np.abs(mids - freq)).sum())
    return mids, freq, cnt, ece


def brier(p, y):
    return float(np.mean((np.asarray(p, float) - np.asarray(y, float)) ** 2))
