#!/usr/bin/env python3
"""Build every figure of the paper from paper/data/*.json into paper/figures/*.pdf.

    python3 paper/plots.py            all figures whose data exists
    python3 paper/plots.py op delay   only these
"""
import glob
import os
import sys

import matplotlib
import matplotlib.pyplot as plt
import numpy as np

from plotlib import C, ENGINE_STYLE, SINGLE, DOUBLE, boot_ci, brier, load, paired_boot_diff, panel_label, reliability, roc_pr, save, style

style()
SETS = [("real", "Real benches (62 faults)"), ("test", "Synthetic held-out (178 faults)")]
FIGS = {}


def figure(f):
    FIGS[f.__name__.replace("fig_", "")] = f
    return f


def have(*names):
    return all(os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", n)) for n in names)


# ------------------------------------------------------------------ operating curves
@figure
def fig_op():
    d = load("curves.json")
    fig, axes = plt.subplots(2, 2, figsize=(DOUBLE, 4.1), sharey="row")
    for j, (s, title) in enumerate(SETS):
        for en in ["rules", "ml", "hybrid"]:
            st = ENGINE_STYLE[en]
            pts = sorted(d["sets"][s]["op"][en], key=lambda p: p["fa"])
            fa = np.array([p["fa"] for p in pts]); det = np.array([p["det"] for p in pts]) * 100; cn = np.array([p["cn"] for p in pts]) * 100
            for i, y in enumerate([det, cn]):
                ax = axes[i, j]
                ax.plot(fa, y, color=st["color"], ls=st["ls"], marker=st["marker"], label=st["label"], markevery=1, markerfacecolor="white" if en != "hybrid" else st["color"])
                p1 = [p for p in d["sets"][s]["op"][en] if abs(p["th"] - 1) < 1e-9][0]
                ax.scatter([p1["fa"]], [(p1["det"] if i == 0 else p1["cn"]) * 100], s=46, marker="*", color=st["color"], edgecolor="black", linewidth=0.5, zorder=5)
        axes[0, j].set_title(title)
        axes[1, j].set_xlabel("False-alarm episodes per fault-free hour")
        for i in range(2):
            axes[i, j].set_xscale("symlog", linthresh=1.0); axes[i, j].set_xlim(-0.05, 30)
            axes[i, j].set_xticks([0, 0.5, 1, 2, 5, 10, 20]); axes[i, j].set_xticklabels(["0", "0.5", "1", "2", "5", "10", "20"])
            axes[i, j].set_ylim((55, 100) if i == 0 else (40, 80))
    axes[0, 0].set_ylabel("Faults detected (%)"); axes[1, 0].set_ylabel("Caught and named first (%)")
    for ax, t in zip(axes.flat, "abcd"):
        panel_label(ax, f"({t})", dx=-0.2 if t in "ac" else -0.08)
    axes[0, 0].legend(loc="lower right", title="star = default threshold", title_fontsize=6)
    axes[0, 1].text(0.98, 0.04, "curves cropped below\nthe axis (alarm threshold too high)", transform=axes[0, 1].transAxes, fontsize=5.5, ha="right", color=C["grey"])
    fig.tight_layout(w_pad=1.0, h_pad=0.8)
    save(fig, "fig_op")


# ------------------------------------------------------------------ delay CDF
@figure
def fig_delay():
    d = load("curves.json")
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.2), sharey=True)
    for j, (s, title) in enumerate(SETS):
        ax = axes[j]
        for en in ["rules", "ml", "hybrid", "hybrid + change-point"]:
            st = ENGINE_STYLE[en]
            v = np.sort([r["delay"] for r in d["sets"][s]["ranks"][en] if r["detected"]])
            y = np.arange(1, len(v) + 1) / len(d["sets"][s]["ranks"][en])
            ax.step(np.r_[0, v], np.r_[0, y], where="post", color=st["color"], ls=st["ls"], label=f"{st['label']} (median {np.median(v):.0f} s)")
        ax.set_xscale("symlog", linthresh=10); ax.set_xlim(0, 100); ax.set_ylim(0, 1.02)
        ax.set_xticks([0, 5, 10, 20, 40, 80]); ax.set_xticklabels(["0", "5", "10", "20", "40", "80"])
        ax.set_xlabel("Detection delay after fault onset (s)"); ax.set_title(title)
        ax.legend(loc="lower right", fontsize=6)
        panel_label(ax, f"({'ab'[j]})", dx=-0.1 if j else -0.16)
    axes[0].set_ylabel("Fraction of faults detected by t")
    fig.tight_layout(w_pad=1.0)
    save(fig, "fig_delay")


# ------------------------------------------------------------------ A@k with bootstrap bands
def top_k(ranks, k):
    return np.array([1.0 if (r["detected"] and r["rank"] is not None and r["rank"] <= k) else 0.0 for r in ranks])


@figure
def fig_atk():
    d = load("curves.json")
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.35), sharey=True)
    ks = [1, 2, 3, 5]
    for j, (s, title) in enumerate(SETS):
        ax = axes[j]
        for en in ["rules", "severity", "ml", "hybrid", "hybrid + learned directions"]:
            st = ENGINE_STYLE[en]
            m, lo, hi = [], [], []
            for k in ks:
                v = top_k(d["sets"][s]["ranks"][en], k)
                m.append(v.mean() * 100); a, b = boot_ci(v, n=2000); lo.append(a * 100); hi.append(b * 100)
            off = (list(ENGINE_STYLE).index(en) - 2) * 0.045
            ax.errorbar(np.array(ks) + off, m, yerr=[np.array(m) - lo, np.array(hi) - m], color=st["color"], ls=st["ls"], marker=st["marker"], capsize=1.5, elinewidth=0.6,
                        markerfacecolor="white" if en not in ("hybrid",) else st["color"], label=st["label"])
        ax.set_xticks(ks); ax.set_xlabel("k"); ax.set_title(title)
        panel_label(ax, f"({'ab'[j]})", dx=-0.1 if j else -0.16)
    axes[0].set_ylabel("Faults caught with the true cause in top-k (%)")
    axes[1].legend(loc="lower right", fontsize=6)
    fig.tight_layout(w_pad=1.0)
    save(fig, "fig_atk")


# ------------------------------------------------------------------ per-class heatmaps
CLASS_ORDER = ["crash", "stop", "pause", "crash-loop", "flap", "memory", "brownout", "latency", "partition"]


@figure
def fig_class():
    d = load("curves.json")
    engines = ["rules", "severity", "ml", "hybrid"]
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.7))
    for j, (s, title) in enumerate(SETS):
        classes = [c for c in CLASS_ORDER if any(r["cls"] == c for r in d["sets"][s]["ranks"]["hybrid"])]
        M = np.zeros((len(classes), len(engines))); N = np.zeros(len(classes), int)
        for i, c in enumerate(classes):
            for k, en in enumerate(engines):
                rs = [r for r in d["sets"][s]["ranks"][en] if r["cls"] == c]
                N[i] = len(rs); M[i, k] = np.mean([1.0 if (r["detected"] and r["rank"] == 1) else 0.0 for r in rs])
        ax = axes[j]
        im = ax.imshow(M * 100, cmap="Blues", vmin=0, vmax=100, aspect="auto")
        for i in range(len(classes)):
            for k in range(len(engines)):
                ax.text(k, i, f"{M[i, k] * 100:.0f}", ha="center", va="center", fontsize=6.5, color="white" if M[i, k] > 0.6 else "black")
        ax.set_xticks(range(len(engines))); ax.set_xticklabels(["Rules", "Severity", "ML", "Hybrid"], rotation=0)
        ax.set_yticks(range(len(classes))); ax.set_yticklabels([f"{c} (n={n})" for c, n in zip(classes, N)])
        ax.set_title(title); ax.grid(False)
        for sp in ax.spines.values():
            sp.set_visible(False)
        panel_label(ax, f"({'ab'[j]})", dx=-0.5 if j == 0 else -0.5)
    cb = fig.colorbar(im, ax=axes, fraction=0.025, pad=0.02); cb.set_label("Caught and named first (%)", fontsize=7)
    save(fig, "fig_class")


# ------------------------------------------------------------------ forest plot of paired differences
@figure
def fig_forest():
    d = load("curves.json")
    contrasts = [("hybrid", "rules", "Hybrid vs rules"), ("hybrid", "severity", "Hybrid vs severity ranking"), ("ml", "rules", "ML vs rules"),
                 ("hybrid", "ml", "Hybrid vs ML"), ("hybrid + change-point", "hybrid", "Change-point alarm vs hybrid"), ("hybrid + learned directions", "hybrid", "Learned directions vs name rule")]
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.2), sharey=True)
    rows = []
    for j, (s, title) in enumerate(SETS):
        ax = axes[j]
        for i, (a, b, lab) in enumerate(contrasts):
            va = np.array([1.0 if (r["detected"] and r["rank"] == 1) else 0.0 for r in d["sets"][s]["ranks"][a]])
            vb = np.array([1.0 if (r["detected"] and r["rank"] == 1) else 0.0 for r in d["sets"][s]["ranks"][b]])
            m, lo, hi, p = paired_boot_diff(va, vb)
            rows.append((s, lab, m * 100, lo * 100, hi * 100, p))
            sig = lo > 0 or hi < 0
            ax.errorbar(m * 100, len(contrasts) - 1 - i, xerr=[[m * 100 - lo * 100], [hi * 100 - m * 100]], fmt="o" if sig else "s", color=C["blue"] if sig else C["grey"], capsize=2, markersize=4.2, elinewidth=1.0,
                        markerfacecolor=C["blue"] if sig else "white")
            ax.text(1.02, len(contrasts) - 1 - i, f"{m * 100:+.1f}", transform=ax.get_yaxis_transform(), fontsize=6.3, va="center")
        ax.axvline(0, color="black", lw=0.7)
        ax.set_yticks(range(len(contrasts))); ax.set_yticklabels([c[2] for c in contrasts][::-1])
        ax.set_xlabel("Difference in caught-and-named rate (percentage points)"); ax.set_title(title)
        ax.set_xlim(-16, 24 if s == "real" else 12)
        panel_label(ax, f"({'ab'[j]})", dx=-0.04 if j else -0.5)
    fig.tight_layout(w_pad=2.0)
    save(fig, "fig_forest")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "paired_tests.txt"), "w") as f:
        for r in rows:
            f.write(f"{r[0]:5s} {r[1]:36s} diff {r[2]:+6.1f} pp  95% CI [{r[3]:+6.1f}, {r[4]:+6.1f}]  p={r[5]:.3f}\n")


# ------------------------------------------------------------------ ablation
ABL_NAMES = [("- docker-stop fact", "no docker-stop fact"), ("- crash-loop fact", "no crash-loop fact"), ("- range guard", "no range guard"), ("- random walk", "no random walk (rank by anomaly)"),
             ("- one-sided features", "two-sided features"), ("- two-speed drift", "no two-speed drift"), ("- alarm at level 2 (alarm at 1)", "alarm at level 1 (not 2)")]


@figure
def fig_ablation():
    real = {r["name"]: r for r in load("abl_real.json")["rows"]}
    test = {r["name"]: r for r in load("abl_test.json")["rows"]}
    fig, axes = plt.subplots(1, 3, figsize=(DOUBLE, 2.5), sharey=True, gridspec_kw={"width_ratios": [1, 1, 1]})
    labels = [n[1] for n in ABL_NAMES][::-1]
    y = np.arange(len(labels))
    for ax, (src, title) in zip(axes[:2], [(real, "Real benches"), (test, "Synthetic held-out")]):
        full = src["full (default)"]["caughtAndNamed"] * 100
        dv = [src[n]["caughtAndNamed"] * 100 - full for n, _ in ABL_NAMES][::-1]
        ax.barh(y, dv, color=[C["orange"] if v < 0 else C["green"] for v in dv], height=0.62)
        for yi, v in zip(y, dv):
            ax.text(v + (0.6 if v >= 0 else -0.6), yi, f"{v:+.0f}", va="center", ha="left" if v >= 0 else "right", fontsize=6.3)
        ax.axvline(0, color="black", lw=0.7); ax.set_xlim(-26, 9); ax.set_xlabel("Change in caught-and-named (pp)"); ax.set_title(title)
    ax = axes[2]
    full_t = real["full (default)"]["alarmShare"] * 100
    at = [real[n]["alarmShare"] * 100 for n, _ in ABL_NAMES][::-1]
    ax.barh(y, at, color=C["sky"], height=0.62); ax.axvline(full_t, color="black", lw=0.8, ls="--")
    for yi, v in zip(y, at):
        ax.text(v + 0.6, yi, f"{v:.0f}", va="center", fontsize=6.3)
    ax.text(full_t + 0.5, len(labels) - 0.35, "full", fontsize=6, va="bottom")
    ax.set_xlim(0, 37); ax.set_xlabel("Time in alarm, fault-free (%)"); ax.set_title("Real benches")
    axes[0].set_yticks(y); axes[0].set_yticklabels(labels)
    for a, t in zip(axes, "abc"):
        panel_label(a, f"({t})", dx=-0.06 if t != "a" else -0.02)
    fig.tight_layout(w_pad=0.8)
    save(fig, "fig_ablation")


# ------------------------------------------------------------------ cascade calibration
@figure
def fig_calibration():
    d = load("cascade.json")["sets"]["test"]["rows"]
    y = np.array([r["y"] for r in d])
    preds = {"learned": ("Learned (Beta-Binomial)", C["blue"], "o", "-"), "fixed": ("Fixed edge probability", C["grey"], "s", "--")}
    fig, axes = plt.subplots(1, 3, figsize=(DOUBLE, 2.45), gridspec_kw={"width_ratios": [1, 1, 1]})
    ax = axes[0]
    ax.plot([0, 1], [0, 1], color="black", lw=0.7, ls=":", label="perfect")
    stats = {}
    for k, (lab, col, mk, ls) in preds.items():
        p = np.array([r[k] for r in d])
        mids, freq, cnt, ece = reliability(p, y, bins=8, quantile=False)
        ax.plot(mids, freq, color=col, ls=ls, lw=0.9)
        ax.scatter(mids, freq, s=8 + 30 * np.log10(cnt + 1), color=col, marker=mk, facecolor="white" if k == "fixed" else col, edgecolor=col, linewidth=0.8, zorder=4, label=f"{lab}, ECE {ece:.3f}")
        fpr, tpr, rec, prec, auc, ap = roc_pr(p, y)
        stats[k] = (fpr, tpr, auc, brier(p, y), ece)
    ax.set_xlabel("Predicted probability"); ax.set_ylabel("Observed frequency"); ax.set_xlim(-0.02, 1.02); ax.set_ylim(-0.02, 1.02); ax.legend(loc="upper left", fontsize=5.8)
    ax.set_title("Reliability (marker area ~ log count)", fontsize=7); panel_label(ax, "(a)", dx=-0.2)
    ax = axes[1]
    for k, (lab, col, mk, ls) in preds.items():
        fpr, tpr, auc, br, ece = stats[k]
        ax.plot(fpr, tpr, color=col, ls=ls, label=f"{lab}, AUROC {auc:.3f}")
    ax.plot([0, 1], [0, 1], color="black", lw=0.7, ls=":")
    ax.set_xlabel("False-positive rate"); ax.set_ylabel("True-positive rate"); ax.legend(loc="lower right", fontsize=5.8); ax.set_title("ROC"); panel_label(ax, "(b)", dx=-0.2)
    ax = axes[2]
    p = np.array([r["learned"] for r in d])
    bins = np.linspace(0, 1, 11)
    ax.hist([p[y == 0], p[y == 1]], bins=bins, color=[C["grey"], C["orange"]], label=["did not cascade", "cascaded"], stacked=True)
    ax.set_yscale("log"); ax.set_xlabel("Predicted probability (learned)"); ax.set_ylabel("Predictions"); ax.legend(loc="upper right", fontsize=6); ax.set_title("Score distribution")
    panel_label(ax, "(c)", dx=-0.2)
    fig.tight_layout(w_pad=1.0)
    save(fig, "fig_calibration")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "calibration_stats.txt"), "w") as f:
        for k, (fpr, tpr, auc, br, ece) in stats.items():
            f.write(f"{k}: AUROC {auc:.3f} Brier {br:.3f} ECE {ece:.3f} n={len(y)} positives={int(y.sum())}\n")
        rr = load("cascade.json")["sets"]["real"]["rows"]
        yr = np.array([r["y"] for r in rr]); f.write(f"real: n={len(yr)} positives={int(yr.sum())}\n")
        for k in ["learned", "fixed"]:
            pr = np.array([r[k] for r in rr]); _, _, _, _, a, ap = roc_pr(pr, yr); f.write(f"real {k}: AUROC {a:.3f} Brier {brier(pr, yr):.3f}\n")
        lv = [(r["live"], r["y"]) for r in rr if r["live"] is not None]
        if lv:
            _, _, _, _, a, ap = roc_pr([x[0] for x in lv], [x[1] for x in lv]); f.write(f"real live mapper: AUROC {a:.3f} Brier {brier([x[0] for x in lv], [x[1] for x in lv]):.3f} n={len(lv)}\n")

# ------------------------------------------------------------------ learned directions
@figure
def fig_dirs():
    d = load("causal.json")["directions"]
    conds = [("real", "Real\nnames"), ("real, name-blind", "Real\nhidden"), ("test (held out)", "Synth.\nnames"), ("test (held out), name-blind", "Synth.\nhidden")]
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.5), gridspec_kw={"width_ratios": [1.15, 1]})
    ax = axes[0]
    w = 0.36
    for k, (key, lab, dx) in enumerate([("v1 name rule", "Name rule (v1)", -w / 2 - 0.02), ("learned", "Learned (ours)", w / 2 + 0.02)]):
        for i, (cond, _) in enumerate(conds):
            e = d[cond]["all"][key]["end"]; tot = e["right"] + e["wrong"] + e["unknown"]
            r, wr, u = e["right"] / tot * 100, e["wrong"] / tot * 100, e["unknown"] / tot * 100
            x = i + dx
            ax.bar(x, r, w, color=C["blue"] if k else C["amber"], edgecolor="black", linewidth=0.4, label=lab if i == 0 else None)
            ax.bar(x, wr, w, bottom=r, color=C["orange"], edgecolor="black", linewidth=0.4, hatch="////", label="wrong" if (i == 0 and k == 0) else None)
            ax.bar(x, u, w, bottom=r + wr, color="#d9d9d9", edgecolor="black", linewidth=0.4, label="unresolved" if (i == 0 and k == 0) else None)
            ax.text(x, r / 2, f"{r:.0f}", ha="center", va="center", fontsize=6.2, color="white" if k else "black")
    ax.set_xticks(range(len(conds))); ax.set_xticklabels([c[1] for c in conds]); ax.set_ylabel("Observed call pairs (%)"); ax.set_ylim(0, 100)
    ax.legend(loc="upper center", ncol=4, fontsize=6, bbox_to_anchor=(0.5, 1.16)); panel_label(ax, "(a)", dx=-0.13, dy=1.1)
    ax = axes[1]
    sc = d["test (held out), name-blind"]["all"]
    meths = [(k, v) for k, v in sc.items() if k.startswith("method: ")]
    rows = [("name rule (v1)", sc["v1 name rule"]), ("learned (ours)", sc["learned"])] + [(k.replace("method: ", ""), v) for k, v in meths]
    vals = [(n, v["end"]["right"] / (v["end"]["right"] + v["end"]["wrong"] + v["end"]["unknown"]) * 100) for n, v in rows]
    vals = sorted(vals, key=lambda x: x[1])
    cols = [C["blue"] if n.startswith("learned") else (C["amber"] if n.startswith("name") else C["sky"]) for n, _ in vals]
    ax.barh(range(len(vals)), [v for _, v in vals], color=cols, edgecolor="black", linewidth=0.4, height=0.7)
    ax.set_yticks(range(len(vals))); ax.set_yticklabels([n for n, _ in vals], fontsize=6.2); ax.set_xlim(0, 100)
    for i, (_, v) in enumerate(vals):
        ax.text(v + 1, i, f"{v:.0f}", va="center", fontsize=6)
    ax.set_xlabel("Correct directions, synthetic, names hidden (%)"); panel_label(ax, "(b)", dx=-0.38, dy=1.04)
    fig.tight_layout(w_pad=1.2)
    save(fig, "fig_dirs")


# ------------------------------------------------------------------ fault-type diagnosis
@figure
def fig_diag():
    d = load("diagnose.json")
    t = d["test"]["12"]["forest"]["pipeline"]
    labels, cm = t["labels"], np.array(t["confusion"], float)
    cmn = cm / np.maximum(cm.sum(axis=1, keepdims=True), 1)
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.7), gridspec_kw={"width_ratios": [1.25, 1]})
    ax = axes[0]
    im = ax.imshow(cmn * 100, cmap="Blues", vmin=0, vmax=100)
    for i in range(len(labels)):
        for j in range(len(labels)):
            if cm[i, j] > 0:
                ax.text(j, i, f"{int(cm[i, j])}", ha="center", va="center", fontsize=6.2, color="white" if cmn[i, j] > 0.55 else "black")
    ax.set_xticks(range(len(labels))); ax.set_xticklabels(labels, rotation=40, ha="right"); ax.set_yticks(range(len(labels))); ax.set_yticklabels(labels)
    ax.set_xlabel("Predicted fault type"); ax.set_ylabel("True fault type"); ax.grid(False)
    ax.set_title(f"Forest, engine's suspect, +60 s (acc. {t['accuracy'] * 100:.0f}%)", fontsize=7)
    cb = fig.colorbar(im, ax=ax, fraction=0.045, pad=0.02); cb.set_label("Row-normalised (%)", fontsize=6.5); panel_label(ax, "(a)", dx=-0.3, dy=1.06)
    ax = axes[1]
    ns = [0, 6, 12]; secs = [n * 5 for n in ns]
    def acc(split, model, kind):
        return [d[split][str(n)][model][kind]["accuracy"] * 100 for n in ns]
    ax.plot(secs, acc("test", "forest", "oracle"), color=C["green"], marker="o", label="Forest, true service (synth.)")
    ax.plot(secs, acc("test", "forest", "pipeline"), color=C["blue"], marker="s", label="Forest, engine's suspect (synth.)")
    ax.plot(secs, acc("test", "rules", "pipeline"), color=C["grey"], marker="^", ls="--", label="Decision list, suspect (synth.)")
    ax.plot(secs, acc("real", "rules", "pipeline"), color=C["orange"], marker="v", ls="--", label="Decision list, suspect (real)")
    ax.plot(secs, acc("real", "forest", "pipeline"), color=C["pink"], marker="D", ls=":", label="Forest, suspect (real)")
    ax.set_xlabel("Seconds of telemetry after the alarm"); ax.set_ylabel("Fault-type accuracy (%)"); ax.set_xticks(secs); ax.set_ylim(30, 102)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.24), ncol=2, fontsize=5.8); panel_label(ax, "(b)", dx=-0.16, dy=1.06)
    fig.tight_layout(w_pad=1.0)
    save(fig, "fig_diag")


# ------------------------------------------------------------------ early warning
@figure
def fig_early():
    t, r = load("pred_test.json")["early"], load("pred_real.json")["early"]
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.2), gridspec_kw={"width_ratios": [1.3, 1]})
    ax = axes[0]
    classes = [c for c in CLASS_ORDER if c in t["byClass"]]
    x = np.arange(len(classes))
    ax.bar(x - 0.2, [t["byClass"][c]["before"] / max(t["byClass"][c]["n"], 1) * 100 for c in classes], 0.4, color=C["blue"], edgecolor="black", linewidth=0.4, label="Synthetic (178)")
    ax.bar(x + 0.2, [r["byClass"].get(c, {"before": 0, "n": 0})["before"] / max(r["byClass"].get(c, {"n": 1})["n"], 1) * 100 if c in r["byClass"] else 0 for c in classes], 0.4, color=C["amber"], edgecolor="black", linewidth=0.4, label="Real (62)")
    for i, c in enumerate(classes):
        ax.text(i - 0.2, t["byClass"][c]["before"] / max(t["byClass"][c]["n"], 1) * 100 + 1, f"{t['byClass'][c]['before']}/{t['byClass'][c]['n']}", ha="center", fontsize=5.6)
    ax.set_xticks(x); ax.set_xticklabels(classes, rotation=25, ha="right"); ax.set_ylabel("Warned before the alarm (%)"); ax.legend(fontsize=6); panel_label(ax, "(a)", dx=-0.12)
    ax = axes[1]
    for name, e, col, mk in [("Synthetic", t, C["blue"], "o"), ("Real", r, C["amber"], "s")]:
        v = np.sort(e["leads"])
        if len(v):
            ax.step(np.r_[0, v], np.r_[0, np.arange(1, len(v) + 1) / len(v)], where="post", color=col, label=f"{name} (n={len(v)}, median {np.median(v):.0f} s)")
    ax.set_xlabel("Lead time of the warning over the alarm (s)"); ax.set_ylabel("Fraction of warned faults"); ax.legend(fontsize=6, loc="lower right"); ax.set_ylim(0, 1.02); panel_label(ax, "(b)", dx=-0.16)
    fig.tight_layout(w_pad=1.0)
    save(fig, "fig_early")


# ------------------------------------------------------------------ case studies
@figure
def fig_case():
    cases = load("curves.json")["cases"]
    n = len(cases)
    fig, axes = plt.subplots(2 * n, 1, figsize=(DOUBLE, 1.62 * n + 0.3), gridspec_kw={"height_ratios": [1, 0.13] * n, "hspace": 0.22})
    for k, c in enumerate(cases):
        ax, st = axes[2 * k], axes[2 * k + 1]
        a0 = c["fault"]["a"]
        L = np.array(c["level"]); ts = (np.array(c["ts"]) - a0) / 1000
        tgt = c["fault"]["target"]
        keep = set(np.argsort(-L.max(axis=1))[:7])
        if tgt in c["services"]: keep.add(c["services"].index(tgt))
        for o in c["others"]:
            if o["target"] in c["services"]: keep.add(c["services"].index(o["target"]))
        order = sorted(keep, key=lambda i: (c["services"][i] != tgt, -L[i].max()))
        names = [c["services"][i] for i in order]
        im = ax.imshow(np.clip(L[order], 0, 4), aspect="auto", cmap="YlOrRd", vmin=0, vmax=4, extent=[ts[0], ts[-1], len(order), 0], interpolation="nearest")
        H = np.array(c["hard"])[order]
        for i in range(len(order)):
            xs = np.where(H[i] == 1)[0]
            if len(xs): ax.scatter(ts[xs], np.full(len(xs), i + 0.5), s=2.5, color="black", marker="s", linewidths=0, zorder=4)
        def box(o, col, ls, lw, lab=None):
            if o["target"] in names:
                r = names.index(o["target"]); ax.add_patch(plt.Rectangle(((o["a"] - a0) / 1000, r), (o["b"] - o["a"]) / 1000, 1, fill=False, edgecolor=col, linewidth=lw, ls=ls, zorder=5))
        box(c["fault"], C["blue"], "-", 1.5)
        for o in c["others"]: box(o, C["grey"], "--", 0.9)
        al = np.where(np.array(c["alarm"]) == 1)[0]
        if len(al): ax.axvline(ts[al[0]], color=C["green"], lw=1.2)
        ax.set_yticks(np.arange(len(order)) + 0.5); ax.set_yticklabels(names, fontsize=6); ax.grid(False); ax.set_xticks([]); ax.set_xlim(ts[0], ts[-1])
        ax.set_title(f"({'abc'[k]}) {c['label']} on {tgt}, {c['run']}.  Blue box: the fault.  Grey dashed boxes: other faults running at the same time.", fontsize=6.8, loc="left", pad=3)
        top = np.array(c["top1"]); alarm = np.array(c["alarm"]) == 1
        right = np.array([t == tgt for t in top])
        strip = np.where(alarm, np.where(right, 2, 1), 0)[None, :]
        st.imshow(strip, aspect="auto", cmap=matplotlib.colors.ListedColormap(["#f2f2f2", C["orange"], C["green"]]), vmin=0, vmax=2, extent=[ts[0], ts[-1], 1, 0], interpolation="nearest")
        st.set_yticks([0.5]); st.set_yticklabels(["top-1"], fontsize=6); st.grid(False); st.set_xlim(ts[0], ts[-1])
        if k < n - 1: st.set_xticks([])
        for sp in st.spines.values(): sp.set_visible(False)
    axes[-1].set_xlabel("Seconds since fault onset")
    import matplotlib.patches as mp
    fig.legend(handles=[mp.Patch(color=C["green"], label="alarm, top-1 = true cause"), mp.Patch(color=C["orange"], label="alarm, top-1 = another service"), mp.Patch(color="#f2f2f2", label="no alarm"),
                        plt.Line2D([0], [0], color=C["green"], lw=1.2, label="first alarm"), plt.Line2D([0], [0], marker="s", color="black", lw=0, markersize=3, label="container fact")],
               loc="lower center", ncol=5, fontsize=6, bbox_to_anchor=(0.5, -0.03))
    cb = fig.colorbar(im, ax=list(axes), fraction=0.012, pad=0.01); cb.set_label("ML level (1 = own line)", fontsize=6.5)
    save(fig, "fig_case")

# ------------------------------------------------------------------ amplification regime
@figure
def fig_amp():
    d = load("amplify.json")
    key = lambda a: str(int(a)) if float(a).is_integer() else str(a)
    levels = [a for a in d["levels"] if key(a) in d["byLevel"]]
    names = [("rule decomposition", "Rule decomposition", C["green"], "D", "-"), ("hybrid (walk)", "Hybrid walk", C["blue"], "o", "-"),
             ("walk, learned directions", "Walk, learned dir.", C["pink"], "P", "--"), ("severity (anomaly only)", "Severity", C["amber"], "v", "-.")]
    hit = lambda a, n: np.array([1.0 if (r["detected"] and r["rank"] == 1) else 0.0 for r in d["byLevel"][key(a)]["engines"][n]])
    fig, axes = plt.subplots(1, 3, figsize=(DOUBLE, 2.35), gridspec_kw={"width_ratios": [1.1, 1.1, 0.9]})
    ax = axes[0]
    for n, lab, col, mk, ls in names:
        ax.plot(levels, [hit(a, n).mean() * 100 for a in levels], color=col, marker=mk, ls=ls, label=lab, markerfacecolor="white" if n.startswith("sev") else col)
    ax.set_xlabel("Amplification factor"); ax.set_ylabel("Caught and named first (%)"); ax.set_xticks(levels); ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.27), ncol=2, fontsize=5.8); ax.set_title("Soft faults, 106 per level", fontsize=7.5); panel_label(ax, "(a)", dx=-0.2)
    ax = axes[1]
    ax.axhline(0, color="black", lw=0.7)
    for k, (n, lab, col, mk, ls) in enumerate([x for x in names if not x[0].startswith("sev")]):
        m, lo, hi = [], [], []
        for a in levels:
            dm, l, h, _ = paired_boot_diff(hit(a, n), hit(a, "severity (anomaly only)"), n=3000); m.append(dm * 100); lo.append(l * 100); hi.append(h * 100)
        x = np.array(range(len(levels))) + (k - 1) * 0.16
        ax.errorbar(x, m, yerr=[np.array(m) - lo, np.array(hi) - m], color=col, marker=mk, ls="none", capsize=2, elinewidth=0.8, label=lab, markersize=3.8)
    ax.set_xticks(range(len(levels))); ax.set_xticklabels([f"{a:g}" for a in levels]); ax.set_xlabel("Amplification factor"); ax.set_ylabel("Gain over severity ranking (pp, 95% CI)")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.27), ncol=2, fontsize=5.8); ax.set_title("Paired difference", fontsize=7.5); panel_label(ax, "(b)", dx=-0.2)
    ax = axes[2]
    ax.plot(levels, [d["byLevel"][key(a)]["louderShare"] * 100 for a in levels], color=C["orange"], marker="s")
    ax.set_xlabel("Amplification factor"); ax.set_ylabel("A victim is louder than the cause (%)"); ax.set_xticks(levels); ax.set_ylim(0, 40); ax.set_title("Regime hardness", fontsize=7.5); panel_label(ax, "(c)", dx=-0.2)
    fig.tight_layout(w_pad=1.1)
    save(fig, "fig_amp")


# ------------------------------------------------------------------ detector ROC / PR
DET = [("rules", "Rule z-score", C["grey"], "--"), ("iforest", "Isolation Forest", C["blue"], "-"), ("knn", "k-NN", C["orange"], "-."), ("mahalanobis", "Mahalanobis", C["green"], ":"),
       ("hbos", "HBOS", C["pink"], "--"), ("ensemble", "Ensemble of four", C["amber"], "-")]


@figure
def fig_roc():
    fig, axes = plt.subplots(2, 2, figsize=(DOUBLE, 4.3))
    stats = []
    for j, (s, title) in enumerate(SETS):
        for key, lab, col, ls in DET:
            try:
                r = load(f"roc_{key}_{s}.json")
            except FileNotFoundError:
                continue
            roc, pr = np.array(r["roc"]), np.array(r["pr"])
            axes[0, j].plot(roc[:, 0], roc[:, 1], color=col, ls=ls, label=f"{lab} ({r['auroc']:.2f})")
            axes[1, j].plot(pr[:, 0], pr[:, 1], color=col, ls=ls, label=f"{lab} ({r['ap']:.2f})")
            stats.append((s, key, r["auroc"], r["aurocSd"], r["ap"], r["apSd"]))
        axes[0, j].plot([0, 1], [0, 1], color="black", lw=0.6, ls=":"); axes[0, j].set_xlabel("False-positive rate"); axes[0, j].set_title(title)
        axes[1, j].set_xlabel("Recall"); axes[1, j].set_ylim(0, 1.02)
        axes[0, j].legend(loc="lower right", fontsize=5.8, title="AUROC", title_fontsize=6); axes[1, j].legend(loc="upper right", fontsize=5.8, title="average precision", title_fontsize=6)
    axes[0, 0].set_ylabel("True-positive rate"); axes[1, 0].set_ylabel("Precision")
    for ax, t in zip(axes.flat, "abcd"):
        panel_label(ax, f"({t})", dx=-0.2 if t in "ac" else -0.1)
    fig.tight_layout(w_pad=1.0, h_pad=0.9)
    save(fig, "fig_roc")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "roc_stats.json"), "w") as f:
        import json; json.dump(stats, f)


# ------------------------------------------------------------------ sensitivity sweeps
SWEEPS = [("lineK", "alarm-line width $\\kappa$", 3), ("window", "window (readings)", 120), ("alarmLevel", "project alarm level", 2), ("rangeK", "range guard (floors)", 5), ("trees", "trees per forest", 100), ("mildDriftAfter", "mild-drift acceptance (readings)", 24)]


@figure
def fig_sweep():
    fig, axes = plt.subplots(2, 3, figsize=(DOUBLE, 3.9))
    for ax, (p, lab, default) in zip(axes.flat, SWEEPS):
        ax2 = ax.twinx(); ax2.spines["right"].set_visible(True); ax2.grid(False)
        for s, col, mk, ls, name in [("real", C["blue"], "o", "-", "real"), ("test", C["orange"], "s", "--", "synthetic (8 campaigns)")]:
            try:
                rows = [r for r in load(f"sweep_{s}_{p}.json")["rows"] if not r["name"].startswith("Rules")]
            except FileNotFoundError:
                continue
            x = np.arange(len(rows)); vals = [float(r["name"]) for r in rows]
            ax.plot(x, [r["caughtAndNamed"] * 100 for r in rows], color=col, marker=mk, ls=ls, label=name)
            ax2.plot(x, [r["alarmShare"] * 100 for r in rows], color=col, marker=mk, ls=":", markerfacecolor="white", alpha=0.6, markersize=3)
            ax.set_xticks(x); ax.set_xticklabels([f"{v:g}" for v in vals])
            if default in vals: ax.axvline(vals.index(default), color="black", lw=0.7, ls=":")
        ax.set_xlabel(lab); ax.set_ylim(40, 85); ax2.set_ylim(0, 40)
    for ax in axes[:, 0]: ax.set_ylabel("Caught and named (%), solid")
    for ax in axes[:, 2]: ax.twinx  # noqa
    axes[0, 2].legend(loc="lower right", fontsize=6)
    for ax, t in zip(axes.flat, "abcdef"): panel_label(ax, f"({t})", dx=-0.2)
    fig.text(0.995, 0.5, "Time in alarm when fault-free (%), dotted", rotation=90, va="center", ha="right", fontsize=7)
    fig.tight_layout(w_pad=1.4, h_pad=1.0, rect=(0, 0, 0.985, 1))
    save(fig, "fig_sweep")


# ------------------------------------------------------------------ scalability
@figure
def fig_scale():
    d = load("scale.json")
    fig, axes = plt.subplots(1, 2, figsize=(DOUBLE, 2.45))
    ax = axes[0]
    for key, lab, col, mk, ls in [("iforest", "Isolation Forest (default)", C["blue"], "o", "-"), ("knn", "k-NN", C["orange"], "^", "-."), ("mahalanobis", "Mahalanobis", C["green"], "s", ":"), ("hbos", "HBOS", C["pink"], "D", "--"), ("ensemble", "Ensemble", C["amber"], "v", "-")]:
        if key not in d["detectors"]: continue
        ns = [n for n in d["sizes"] if str(n) in d["detectors"][key]]
        ax.plot(ns, [d["detectors"][key][str(n)]["mean"] for n in ns], color=col, marker=mk, ls=ls, label=lab)
    ax.plot(d["sizes"], [d["walk"][str(n)]["mean"] for n in d["sizes"]], color="black", marker="x", ls="-", lw=0.9, label="random walk alone")
    ax.plot(d["sizes"], [d["cascade"][str(n)]["mean"] for n in d["sizes"]], color=C["grey"], marker="+", ls="-", lw=0.9, label="cascade risk alone")
    ns = np.array(d["sizes"], float); ref = d["detectors"]["iforest"][str(d["sizes"][0])]["mean"] * ns / ns[0]
    ax.plot(ns, ref, color="black", lw=0.5, ls=":", label="linear in N")
    ax.axhline(5000, color=C["orange"], lw=0.8, ls="--"); ax.text(ns[0], 5000 * 0.62, "5 s collection period", fontsize=6, color=C["orange"])
    ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlabel("Services N"); ax.set_ylabel("Milliseconds per decision window (single core)")
    ax.set_xticks(d["sizes"]); ax.set_xticklabels([str(n) for n in d["sizes"]]); ax.legend(fontsize=5.8, loc="upper left", ncol=1); panel_label(ax, "(a)", dx=-0.16)
    ax = axes[1]
    ns2 = [n for n in d["sizes"]]
    ax.plot(ns2, [d["detectors"]["iforest"][str(n)]["mean"] / n for n in ns2], color=C["blue"], marker="o", label="Isolation Forest, per service")
    for key, col, mk in [("knn", C["orange"], "^"), ("mahalanobis", C["green"], "s")]:
        if key in d["detectors"]:
            nn = [n for n in d["sizes"] if str(n) in d["detectors"][key]]
            ax.plot(nn, [d["detectors"][key][str(n)]["mean"] / n for n in nn], color=col, marker=mk, ls="--", label=f"{key}, per service")
    ax.set_xscale("log"); ax.set_xlabel("Services N"); ax.set_ylabel("Milliseconds per service per window"); ax.set_xticks(ns2); ax.set_xticklabels([str(n) for n in ns2]); ax.legend(fontsize=6, loc="upper left")
    panel_label(ax, "(b)", dx=-0.18)
    fig.tight_layout(w_pad=1.2)
    save(fig, "fig_scale")

# ------------------------------------------------------------------ LaTeX tables generated from the data
def fmt_ci(v, lo, hi, d=0):
    return f"{v:.{d}f} [{lo:.{d}f}, {hi:.{d}f}]"


@figure
def tab_main():
    d = load("curves.json")
    names = [("rules", "Rules"), ("severity", "Severity ranking"), ("ml", "ML engine"), ("hybrid", "\\textbf{Hybrid}"), ("hybrid + change-point", "Hybrid + change-point"), ("hybrid + learned directions", "Hybrid + learned dir.")]
    rows = []
    for s, label in [("real", "Real benches (62 faults, 217 min)"), ("test", "Synthetic held-out (178 faults, 16 topologies)")]:
        rows.append(f"\\multicolumn{{7}}{{l}}{{\\textit{{{label}}}}} \\\\")
        for key, nm in names:
            rk = d["sets"][s]["ranks"][key]; sm = d["sets"][s]["summary"][key]
            det = np.array([1.0 if r["detected"] else 0.0 for r in rk]); cn = np.array([1.0 if (r["detected"] and r["rank"] == 1) else 0.0 for r in rk])
            a1 = np.array([1.0 if r["rank"] == 1 else 0.0 for r in rk if r["detected"]]); a3 = np.array([1.0 if (r["rank"] or 99) <= 3 else 0.0 for r in rk if r["detected"]])
            dl, dh = boot_ci(det, n=2000); cl, ch = boot_ci(cn, n=2000)
            med = np.median([r["delay"] for r in rk if r["detected"]])
            rows.append(f"{nm} & {det.mean() * 100:.0f} [{dl * 100:.0f}, {dh * 100:.0f}] & {a1.mean() * 100:.0f} & {a3.mean() * 100:.0f} & {cn.mean() * 100:.0f} [{cl * 100:.0f}, {ch * 100:.0f}] & {sm['falseAlarmsPerHour']:.1f} & {sm['alarmShare'] * 100:.0f} \\\\")
        rows.append("\\midrule")
    rows = rows[:-1]
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tab_main.tex"), "w") as f:
        f.write("\n".join(rows) + "\n")
    print("table tab_main")


@figure
def tab_paired():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "paired_tests.txt")).read().strip().split("\n")
    out = []
    for ln in src:
        parts = ln.split()
        s = parts[0]; lab = ln[6:42].strip(); import re
        m = re.search(r"diff\s+([+-][\d.]+) pp\s+95% CI \[\s*([+-][\d.]+),\s*([+-][\d.]+)\]\s+p=([\d.]+)", ln)
        out.append(f"{'Real' if s == 'real' else 'Synth.'} & {lab} & {m.group(1)} & [{m.group(2)}, {m.group(3)}] & {m.group(4)} \\\\")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tab_paired.tex"), "w") as f:
        f.write("\n".join(out) + "\n")
    print("table tab_paired")


@figure
def tab_roc():
    import json
    st = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "roc_stats.json")))
    names = dict((k, l) for k, l, _, _ in DET)
    by = {}
    for s, k, a, asd, ap, apsd in st: by.setdefault(k, {})[s] = (a, asd, ap, apsd)
    rows = []
    for k, _, _, _ in DET:
        if k not in by: continue
        c = by[k]
        cell = lambda s: f"{c[s][0]:.3f}$\\pm${c[s][1]:.3f} & {c[s][2]:.3f}$\\pm${c[s][3]:.3f}" if s in c else "-- & --"
        rows.append(f"{names[k]} & {cell('real')} & {cell('test')} \\\\")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tab_roc.tex"), "w") as f:
        f.write("\n".join(rows) + "\n")
    print("table tab_roc")


if __name__ == "__main__":
    want = sys.argv[1:] or list(FIGS)
    for name in want:
        try:
            FIGS[name]()
        except FileNotFoundError as e:
            print("skip", name, "(missing data:", e.filename, ")")
