# 26 — ML Pipeline Deep Dive (Code-Level)

## Overview

The ML pipeline (`ml/`) is a Python sidecar system that provides unsupervised anomaly detection for microservices. It runs alongside the Node.js server, communicates via the filesystem and HTTP, and uses per-service Isolation Forest models as the primary detector.

## Pipeline Architecture

```
┌─────────────┐     HTTP         ┌──────────────┐
│ collector.py │ ────────────► │ Node Server   │
│ (continuous) │ ◄──── /api/graph │ (port 3001)  │
│              │                  └──────────────┘
│ metrics_raw  │
│    .csv      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ preprocess.py │  → features.csv + normalization_stats.json
│ (batch)       │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  train.py    │  → models/*.joblib + models/*.meta.json
│  (batch)     │
└──────┬───────┘
       │
       ▼
┌──────────────┐     File I/O    ┌──────────────┐
│  score.py    │ ──────────────► │ latest_scores│
│ (continuous) │                  │   .json      │
│              │ ◄──── /api/graph │              │
└──────────────┘                  └──────────────┘
                                       ↑
                                 Node reads this
                                 on each cycle
```

## Stage 1: Collection (collector.py)

Polls `/api/graph` and appends one CSV row per service per poll.

### Why a Separate Collector?

> The mapper's own MetricStore only keeps a rolling ~1h window in memory (720 samples), built for the live dashboard, not for accumulating a growing training set. This is the actual growing dataset.

### Honesty Rules
- **Never fabricates a value**: if `node.metrics` is null, that row is skipped entirely
- Missing fields produce empty CSV cells, not zeros
- A failed poll cycle leaves a visible timestamp gap in the CSV

### Collection Summary

Writes `data/collection_summary.json` after every cycle:
```json
{
  "started_at": "...",
  "total_rows": 42000,
  "services_seen": 15,
  "poll_interval_sec": 10,
  "consecutive_failures": 0,
  "per_service": {
    "sock-shop:carts": { "samples": 3200, "first_seen": "..." }
  }
}
```

## Stage 2: Preprocessing (preprocess.py)

Transforms raw metrics into ML features.

### Processing Steps

1. **Parse timestamps, sort per service**
2. **Convert cumulative network counters to rates**:
   - Negative delta = container restarted (counter reset) → rate = 0, flagged as `restarted`
   - **Never** a fake spike
3. **Per-service z-score normalization** (never global):
   - "40% CPU is normal for one service, anomalous for another"
   - Zero-variance features → NaN (not 0 forever)
4. **Persist normalization stats** for consistent scoring later

### Feature Columns

```python
FEATURE_COLUMNS = [
    "z_cpu_percent",
    "z_memory_percent",
    "z_network_rx_rate",
    "z_network_tx_rate",
]
```

### Minimum Samples

Services with fewer than `min_samples_per_service` (default: 10) observations are dropped from training but **logged, not silently swallowed**.

## Stage 3: Training (train.py)

Trains **four** detectors per service, each from a different statistical family:

| Detector | Family | Why |
|----------|--------|-----|
| **IsolationForest** | Partitioning | Cheap, handles mixed scales, the default |
| **LOF** | Local density | Catches points normal globally but odd locally |
| **OneClassSVM** | Boundary | Fits a frontier around the normal region |
| **z-score** | Statistical | No fitting; max|z| — the interpretable baseline |

### Key Design: Agreeing Detectors Must Be Different

> "Agreeing detectors are only informative when they could have disagreed."

Cross-model agreement is meaningful because these are deliberately different families.

### LOF Deduplication

A critical fix: LOF fits on **distinct rows** only.

> "1568 rows with 6 distinct values — the collector polls every 10s while docker stats updates less often, so the same state is recorded over and over. A point's 20 nearest neighbours are then 20 copies of itself at distance 0."

Without deduplication, LOF thresholds exploded to 3.37×10⁹.

### Holdout Evaluation

The chronological tail (default 20%) is held out from training and scored afterwards:

```python
holdout_fraction = 0.2
```

The holdout flag rate is **not** an accuracy figure — it only says how often the model fires on data it never saw. Compare it to `contamination`: much higher means drift or a non-normal tail.

### Contamination

Set explicitly at 0.01 (1%), never 'auto':

> "Explicit, not 'auto' — must be reproducible for the paper."

### Per-Model Metadata

Each trained model saves:
```json
{
  "service_id": "sock-shop:carts",
  "feature_columns": ["z_cpu_percent", "z_memory_percent", "z_network_rx_rate", "z_network_tx_rate"],
  "threshold_p99": 0.0234,
  "n_samples": 1568,
  "training_window": "2026-09-15T00:00:00Z to 2026-09-18T12:00:00Z",
  "detector": "iforest",
  "holdout_flag_rate": 0.015,
  "contamination": 0.01
}
```

## Stage 4: Live Scoring (score.py)

Continuously scores services against their trained models.

### Scoring Process

For each service with a trained model:
1. Pull latest metrics from `/api/graph`
2. Compute network rates from cumulative counters (same logic as preprocess)
3. Normalize using the **same** per-service mean/std from training time
4. Score with the model
5. Track consecutive windows above threshold

### Persistence Windows

A single noisy sample doesn't fire an alert. An anomaly is only declared **persistent** after N consecutive above-threshold windows:

```python
consecutive_above[service_id] = consecutive_above[service_id] + 1 if above else 0
persistent = consecutive_above[service_id] >= persistence_windows  # default: 3
```

### Score Normalization and the Vote

Each detector's raw output is placed on a common scale relative to **its own training distribution** (`ml/ensemble.py`, `detector_score`):

```python
centre = stats.get("train_score_median", stats.get("train_score_mean"))
r = (raw - centre) / (stats["threshold_p99"] - centre)
score = max(0.0, min(1.0, r / 2.0))     # typical → 0, at threshold → 0.5, twice as far → 1.0
above = raw >= stats["threshold_p99"]
```

A detector whose threshold and centre coincide (spread below `1e-9`) is unusable and returns `None` instead of dividing by noise. The median is preferred as the centre: a one-class SVM's mean was dragged past its own p99 by a few extreme training scores.

`combine()` then takes a **majority vote** (`votes >= ceil(n/2)` of the usable detectors) and uses the **median** score, so one misbehaving detector cannot drag the result. `tests` for this live in `ml/test_ensemble.py`.

The old formula, `raw / threshold`, broke because an Isolation Forest's threshold is about 0 by construction: the score was pinned at 0, or at 1.0 for the faintest deviation.

### Score History

Append-only CSV (`data/score_history.csv`) trimmed at 50,000 rows for the UI to chart trends over time.

### Output Format

`data/latest_scores.json`:
```json
{
  "sock-shop:carts": {
    "anomaly_score": 0.4523,
    "raw_score": 0.0106,
    "threshold": 0.0234,
    "above_threshold": false,
    "votes": 1,
    "votes_needed": 2,
    "detectors_used": 4,
    "detectors": { "iforest": { "score": 0.45, "raw": 0.0106, "threshold": 0.0234, "above": false } },
    "consecutive_windows": 0,
    "persistent": false,
    "scored_at": "2026-09-18T14:32:00Z"
  }
}
```

## Hot-Reloadable Config (mlconfig.py)

All pipeline scripts re-read `ml/config.json` each cycle, so UI tweaks take effect immediately:

```python
DEFAULTS = {
    "collect_interval_sec": 10,
    "min_samples_per_service": 10,
    "min_training_samples": 30,
    "contamination": 0.01,
    "score_interval_sec": 10,
    "persistence_windows": 3,
    "n_estimators": 200,
    "max_samples_fraction": 1.0,
    "holdout_fraction": 0.2,
    "feature_columns": ["z_cpu_percent", "z_memory_percent", "z_network_rx_rate", "z_network_tx_rate"],
}
```

## Communication with Node Server

The pipeline communicates via:
1. **HTTP** — `collector.py` and `score.py` poll `/api/graph`
2. **Filesystem** — `score.py` writes `latest_scores.json`, Node reads it on each poll cycle
3. **REST** — Node exposes `/api/ml/*` endpoints for the UI to trigger pipeline stages
