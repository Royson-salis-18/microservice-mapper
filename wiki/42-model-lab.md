# The model lab: every chart, every hyperparameter, and where the data lives

**File:** `reports/model-lab.html` (also copied to `wiki visualizer/model-lab.html`). Open it in a browser.
**Generator:** `tools/ml/report.ts`. Rebuild with `npm run ml:report -- ~/.faultlab/<run-dir> --wiki`.

It is built from recorded runs (the injector's ledger plus what the mapper's API showed), so it always describes real data. Re-run it after every new campaign.

## What is in it

| Section | Charts and tables | Question it answers |
|---|---|---|
| 1 Data | run table; skewness and excess kurtosis of every signal, raw against log-transformed; histograms before and after the transform; missing readings; seconds between readings; faults by class; rows for learning | What was recorded, how is it distributed, and why is the detector built on ratios (log scale) and median/MAD? |
| 2 Features | healthy against faulted histograms; separation per feature; correlation matrix | Which features carry the signal, and which say the same thing? |
| 3 Model | learned weights; threshold choice curve; lambda curve; ROC; precision-recall; calibration; scores over time against the injected faults; alarm trade-off against threshold | What did it learn, how was the threshold chosen, and is it honest? |
| 4 Comparison | rules (fixed and tuned threshold), learned model and the live mapper on the same held-out blocks: detected, named first, false alarms per hour, delay; by fault class; who was blamed; cross-bench test; every fault, method by method | Which one is best, and where does each fail? |
| 5 Sensitivity | sliding window of the baseline; minimum history; persistence; lambda; number of cross-validation blocks, each a full retrain and re-evaluation | How much do the hyperparameters change the result? |
| 6 Where the data lives | pipeline diagram, storage table, step-by-step travel of one reading | Where is each piece of data stored and what happens to it? |
| 7 Hyperparameters | every value in use, imported from the code that uses it | What exactly is configured? |

## Where the data lives (summary)

| Stage | Path | Notes |
|---|---|---|
| Collection | in memory | every 5 s; request statistics over a rolling 60 s window |
| Graph | `server/data/graph_db.json` | nodes, edges, targets; saved at most every 2 s after a change |
| Metric history | `server/data/telemetry_db.json` | ring buffer of 720 readings per service; saved every 15 s |
| Connection events | `server/data/traces_<target>.json` | 24 h, at most 100 000 events |
| Saved projects | `server/data/remote_config.json` | hosts, users, key paths |
| Incident rule overrides | `server/data/incident_thresholds.json` | edited in the UI |
| Per-architecture model | `server/data/models/<target>.json` | trained at every start |
| Learned weights | `server/rca/model/learned.json` | only when you install one |
| Recorded runs | `~/.faultlab/<run>/{observed,ledger}-<subject>.jsonl` | what the mapper showed, what was injected |

## How the sliding window matters

The baseline of each signal is the service's own recent past (`DETECTOR_PARAMS.historyRange`, 15 minutes by default; in the learning tools `DEFAULT_HISTORY` samples). Section 5 sweeps it: a short window lets the baseline follow a fault, a long one follows slow drift and old incidents. The collector's own request-statistics window (60 s) and poll interval act at collection time, so they are compared by recording two runs and putting the two reports side by side.

## Reading it honestly

- Distribution and correlation charts use healthy periods and labelled rows from all runs together.
- Comparison and ROC charts are out-of-fold: every row is scored by a model that did not train on its time block.
- The "alarm trade-off against threshold" charts are in-sample; they show the trade-off, not an unbiased estimate.
- Below about 30 faults, differences of one or two faults between methods are noise; the report says so at the top.
