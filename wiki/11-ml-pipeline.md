# ML Anomaly Detection Pipeline

**Directory:** `ml/`

---

## What It Is

A standalone Python sidecar. It learns what "normal" looks like for **each service separately**, from that service's own history of CPU, memory and network rates. It then scores live samples against four different detectors and combines them by vote. Scores are written to `ml/data/latest_scores.json`, which the Node server reads. The two programs never call each other.

**It is entirely optional.** Without it the mapper works as before; nodes simply have no `anomalyScore`, and the health score renormalises without that factor. It never raises incidents: those are rule-based (see [Two opinions, kept apart](17-findings-vs-incidents.md)). Its output appears as **Findings** and as the ANOMALY badge.

---

## Why four detectors, and why per service

- **Unsupervised, because there are no labels.** Nobody has marked which past minutes were anomalous, so the models learn the shape of normal and flag what falls outside it.
- **Per service.** `catalogue-db` at 500 MB is normal, and `front-end` at 500 MB is not. One shared model would confuse the two.
- **Four families that can disagree:**

| Detector | Family | Catches |
|---|---|---|
| Isolation Forest | partitioning | points that are easy to isolate |
| Local Outlier Factor | local density | points normal globally but odd among their neighbours |
| One-class SVM | boundary | points outside a fitted frontier around normal |
| z-score (max \|z\|) | statistical | the plain, interpretable baseline |

Agreement between detectors only carries information when they *could* have disagreed. That is why they come from different families, and why the verdict is a vote.

---

## Pipeline Stages

### Stage 1 — `collector.py`

Polls `GET /api/graph` every 10 seconds. Extracts `node.metrics` for all nodes and appends rows to `data/metrics_raw.csv`.

```python
# Output columns:
# timestamp, service_id, cpu, memory_percent, network_rx, network_tx
```

**Why not use MetricStore?** `MetricStore` is a ring buffer that holds ~1 hour. Training requires days or weeks of baseline data to learn "normal" behavior. The collector writes an append-only CSV that grows with time.

**When to start:** As soon as possible, during **normal operation** (no active stress tests or incidents). The more baseline data before training, the better the models.

### Stage 2 — `preprocess.py`

```python
# 1. Load metrics_raw.csv
# 2. Convert cumulative networkRx/networkTx counters → rates (Δ bytes/second)
#    (The mapper reports cumulative bytes, not rates)
# 3. Per-service z-score normalization
#    (Each feature normalized independently per service)
# 4. Output: data/features.csv + data/normalization_stats.json
```

**Why z-score normalization?** `catalogue-db` might use 500MB of memory normally; `front-end` uses 80MB. Without per-service normalization, `catalogue-db` would always look "anomalous" relative to the fleet average.

**Why convert to rates?** `networkRx` as a cumulative counter always grows. An `IsolationForest` trained on cumulative values would flag new deployments (where counts reset) as anomalous. Rates (Δ per second) are stationary.

### Stage 3 — `train.py`

For every service with at least `min_training_samples` (30) feature rows, all four detectors are fitted on the earlier part of its series (the chronological tail, 20% by default, is held out), and each is saved with its own score statistics in `models/<service>.meta.json`:

```python
CONTAMINATION = 0.01          # explicit, never 'auto' — must be reproducible
IsolationForest(n_estimators=200, contamination=0.01, ...)
LocalOutlierFactor(n_neighbors=..., contamination=0.01, novelty=True)   # fitted on DISTINCT rows
OneClassSVM(kernel="rbf", gamma="scale", nu=0.01)                         # nu ≈ expected outlier fraction
ZScoreDetector(feature_columns)                                           # max |z|, no fitting
```

Each detector's metadata records `threshold_p99` (the 99th percentile of its training scores, oriented so higher means more anomalous), `train_score_median` and `train_score_mean`. Scoring needs nothing else.

**LOF fits on distinct rows.** The collector samples every 10 s while `docker stats` updates less often, so one service had 1,568 rows with only 6 distinct values. Each point's 20 nearest neighbours were copies of itself at distance 0, and the LOF threshold blew up to 3.37 × 10⁹. LOF needs at least 20 distinct rows or it is skipped for that service.

**Excluding incident windows:**
```bash
# Exclude a known stress test from training data:
python3 train.py --since 2026-09-17T00:00:00Z --until 2026-09-17T02:00:00Z
```
The `--since`/`--until` range is **excluded** from training. Data outside it is used.

### Stage 4 — `score.py` + `ensemble.py`

Every `score_interval_sec` (10 s), for each service with models:

1. Read its latest metrics from `GET /api/graph`, and turn the cumulative network totals into bytes/s from the previous sample. A counter reset gives 0, not a fake spike.
2. Normalise with the **training-time** mean and standard deviation, never recomputed from live data, because that would quietly move the definition of normal every cycle.
3. Score with each detector, then put every detector on the same scale (`detector_score()`):

```
r     = (raw − centre) / (threshold_p99 − centre)        centre = training median (else mean)
score = clamp(r / 2, 0, 1)        typical → 0 · at its threshold → 0.5 · twice as far out → 1.0
```

4. Combine (`combine()`): the sample is **anomalous when at least half of the usable detectors are above their own threshold**, and its score is the **median** of their scores. A detector with missing statistics or a degenerate distribution is left out, never guessed.
5. Count consecutive anomalous windows; at `persistence_windows` (3) in a row the anomaly is **persistent**. Only persistent anomalies get the ANOMALY badge, and they weigh 0.8 instead of 0.3 in the cascade model.

`latest_scores.json` per service:

```json
"sock-shop:carts": {
  "anomaly_score": 0.31, "above_threshold": false,
  "votes": 1, "votes_needed": 2, "detectors_used": 4,
  "detectors": { "iforest": {"score": 0.42, "raw": 0.012, "threshold": 0.021, "above": false}, "...": {} },
  "consecutive_windows": 0, "persistent": false, "scored_at": "…"
}
```

**What this replaced.** The old scorer used the Isolation Forest alone, and the other three were trained and never consulted. It also divided the raw score by the threshold. An Isolation Forest's threshold is about 0 by construction (all 24 trained models had \|threshold\| < 0.001), so the score was either forced to 0 or flipped to 1.0 on the slightest deviation, while `above_threshold` could still be true. The vote over thresholds on a common scale fixes both.

---

## Running It From the UI

The two long-running stages (`collector.py`, `score.py`) are supervised from
the **ML Pipeline** page rather than only from a shell:

| Control | Endpoint | Notes |
|---|---|---|
| Start / Stop collector | `POST /api/ml/processes/collector/{start,stop}` | Writes to `ml/logs/collector.log` |
| Start / Stop scorer | `POST /api/ml/processes/scorer/{start,stop}` | Writes to `ml/logs/scorer.log` |
| Status | `GET /api/ml/processes` | Running, pid, uptime, log tail |
| Retrain | `POST /api/ml/retrain` | Runs `preprocess.py` then `train.py`, streaming the log |

This exists because the numbers on the page are only meaningful if you know
whether anything is still producing them. A stopped collector leaves every
figure frozen at its last write, which is indistinguishable from "the system
is quiet" unless the process state is visible.

**Externally-started processes are detected too.** `GET /api/ml/processes`
falls back to an anchored `pgrep` (`^python3 collector\.py$`), so a run
launched from a terminal is reported honestly and can still be stopped from
the UI. The anchor matters: without it the match also hits shell wrappers
whose command line merely *contains* `python3 collector.py`, and stopping the
wrapper would leave the interpreter running.

---

## Tuning Knobs

All editable from the page, all genuinely wired into the Python — see
[14-configuration](14-configuration.md) for the full table.

- `contamination` → all four detectors (`nu` for the one-class SVM); must be below 0.5
- `n_estimators`, `max_samples_fraction` → passed to `IsolationForest`
- `persistence_windows` → how many anomalous windows in a row make an anomaly persistent (read live by `score.py`)
- `feature_columns` → which `z_*` features are fitted. `score.py` reads each
  model's own recorded `feature_columns` from its `meta.json`, so a
  subset-trained model is scored with the vector it was fitted on rather
  than silently mismatched
- `holdout_fraction` → chronological train/test split (see below)
- Training window (`--since` / `--until`) → restrict training to a period you
  know was baseline-only

### Holdout evaluation

With `holdout_fraction > 0`, `train.py` fits on the earlier part of each
service's series and scores the held-out tail, recording in `meta.json`:

```json
"holdout": {
  "samples": 392,
  "flag_rate": 0.0,
  "mean_score": -0.328,
  "max_score": -0.328,
  "from": "…", "to": "…"
}
```

The split is chronological, not random — a random split leaks adjacent
samples across the boundary and flatters the result. The tail is unlabelled,
so `flag_rate` is a **firing rate, not an accuracy**: how often the model
fires on data it never saw. Compare it against `contamination`; much higher
suggests drift or a tail that was not actually normal.

---

## Server Integration

`GraphStore.readAnomalyScores()` — called inside `getGraph()` before each response:

```typescript
private readAnomalyScores(): Record<string, any> {
  const scoresPath = path.join('..', 'ml', 'data', 'latest_scores.json');
  try {
    const stat = fs.statSync(scoresPath);
    if (this.anomalyScoresCache?.mtimeMs === stat.mtimeMs) {
      return this.anomalyScoresCache.data;  // Unchanged — return cache
    }
    const data = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
    this.anomalyScoresCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return {};  // File missing or invalid = no scores
  }
}
```

The mtime check costs ~0.1ms. JSON parsing costs ~1–10ms. Scores are written every 10 seconds → ~7200 mtime checks per day, ~720 actual parses. Negligible overhead.

The server uses two fields from each entry: `anomaly_score` (0–1, about 0.5 at threshold) and `persistent`.

**Only fresh scores count.** A score is applied only if its `scored_at` is within the last two minutes (`ANOMALY_SCORE_MAX_AGE_MS`, `freshAnomalyScore()` in `GraphStore.ts`); otherwise the node carries no anomaly score at all. The scorer writes every 10 s, so an older file means it has stopped. Before this rule, a restart with the scorer off applied the previous day's verdicts as current: six services at "anomaly 100%", cascade risk of 0.8–0.9, red rings and ML-flagged alerts, all before anything had been measured. To see ML flags, start the scorer from the ML Pipeline page.

Scores are applied to nodes in `getGraph()`:
```typescript
const s = scores[node.id];
if (s) {
  node.analytics = {
    ...node.analytics,
    anomalyScore:       s.anomaly_score,
    anomalyPersistent:  s.persistent,
  };
}
```

---

## Known Limitations (Honest)

These are stated in the source code comments and `ml/README.md`, not hidden.

**1. Unsupervised — no labeled data**
Training on data that includes an incident teaches the model that the incident is "normal." The `--since/--until` exclusion is the manual workaround. The system does not auto-detect incident windows.

**2. Minimum samples**
A service needs at least 30 samples after preprocessing (`MIN_TRAINING_SAMPLES` in `train.py`) before it gets a model. New targets won't have anomaly scores until they've been observed for several minutes.

**3. Feature set is limited**
Only CPU (Docker's % of one core, as at training time), memory, and network rates are used. HTTP latency and error rate fields are `null` almost everywhere in current telemetry — Docker stats don't include HTTP metrics, and most services' logs aren't parsed. Adding these as features before they're populated would mean training on fabricated zeros.

**4. No auto-retraining**
Must manually re-run `preprocess.py` + `train.py` as data accumulates. A cron job like `0 3 * * * cd /path/to/ml && python3 preprocess.py && python3 train.py` handles this.

**5. The holdout is not accuracy**
`flag_rate` says how often a model fires on unseen data. Without labels there
is no way to call those firings right or wrong. It is useful as a relative
signal (compare to `contamination`, or across services), not as a score.

**6. `collector.py` and MetricStore overlap**
Both read `/api/graph`. The collector is standalone — it doesn't hook into MetricStore. This means there's some redundant API polling. The separation exists because the ML pipeline needs to be independently deployable (possibly on a different machine).
