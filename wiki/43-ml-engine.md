# The ML engine (the Rules / ML switch)

The top bar has a small **Rules · ML** switch. It decides which engine raises incidents and ranks the root cause. The setting is saved on the server, in `server/data/engine_mode.json`; `MAPPER_ENGINE=ml` overrides it.

| | Rules | ML |
|---|---|---|
| Is a service abnormal? | robust z-score per metric (median, MAD), two samples in a row | **Isolation Forest** per service, trained on a sliding window of that service's normal readings |
| Which service is the cause? | `max(own, symptom − explained)` + 100 for a stopped container | **random walk (personalised PageRank)** on the call graph, driven by the forests' anomaly scores |
| Code | `server/algorithms/detection`, `server/algorithms/rca` | `server/algorithms/ml` |
| Short Python version | `algorithms/detector.py`, `root_cause.py` | `algorithms/ml_engine.py` |

Both engines feed the same incident page, cascade forecast and at-risk list. Container facts (stopped, paused, restarting) count in both: they are facts, not guesses.

## How it works, step by step

```
every 5 s, for every service
  reading ──► scored by the forest built from the PREVIOUS window ──► level (0 typical, 1 = alarm line)
                 │
                 ├── level < 1  → reading joins the training window  (normal: learn from it)
                 └── level ≥ 1  → reading is NOT learned            (a fault never becomes "normal")
  every 10 new normal readings: rebuild the forest on the newest 120 normal readings

then, for the whole project
  anomaly per service (0..1) + call graph ──► random walk ──► root-cause ranking
  alarm when some service is above its line for two cycles in a row (or a container fact)
```

### 1. Learn normal: two Isolation Forests per service

Each reading becomes 8 numbers: CPU, memory, throttling, network in, network out, request rate, error share and p95 latency. Positive quantities are on a log scale. They are split into two groups, each with its own forest:

- **own**: CPU, memory, throttling. A broken dependency cannot cause these.
- **symptom**: traffic, errors, latency, network. These can be inherited from a broken dependency.

**Isolation Forest.** 100 random trees each keep cutting the data at random values until every point is alone. An unusual reading gets isolated after only a few cuts.

```
s(x) = 2 ^ ( −E[h(x)] / c(ψ) )         E[h(x)] = average number of cuts,  c(ψ) = 2·(ln(ψ−1) + 0.5772) − 2(ψ−1)/ψ
level = (s − typical) / (line − typical)
line  = typical + 3 × 1.4826 × MAD(training scores)      (robust, does not jump around with the random trees)
```

**Two fixes, both found by testing:**

1. **Constant features.** A feature that never moved in the window (error share always 0) gives the trees nothing to cut on, so a later jump in it went unseen. Training copies therefore get a little noise at each feature's smallest meaningful change (its *floor*, the same floors the rules use).
2. **Range guard.** A forest scores a value far outside anything it has seen (CPU 60 when it has always been about 10) no higher than its most extreme training point, so the score saturates. In a real tree such a value would be cut off at the root. The engine therefore also counts how many floors a value is beyond the training range: 5 floors beyond counts as level 1.

**The gate (your rule).** A reading is learned only if it is under the line. A service that stays above its line for 360 readings (about half an hour) with nothing broken is treated as having a new normal, for example after a deploy.

### 2. Find the source: random walk on the call graph

This is MonitorRank (Kim, Sumbaly and Shah, SIGMETRICS 2013), a personalised PageRank. A walker starts on anomalous services and keeps stepping:

| Move | Weight | Meaning |
|---|---|---|
| to a service it calls | `w × anomaly(callee)` | follow the trouble towards its source |
| back to a caller | `0.2 × anomaly(caller)` | do not get stuck at a dead end |
| stay | `max(0, anomaly(self) − worst callee, own(self))` | its trouble is not explained by anything it calls, or its own CPU and memory are off |

With probability 0.15 it jumps back to an anomalous service (the restart). The share of time spent on each service is its root-cause score.

**Directions.** Connections are seen from both ends, so in the recordings almost every link appears in both directions (15 of 32 pairs in ShopFlow, 18 of 36 in LedgerLine). The engine keeps the direction a call normally takes, from entry point to service to data store or external provider. A pair between two ordinary services keeps both directions, marked "direction unknown"; such a pair can move the walker but cannot explain a service away.

## Results

Both engines are scored on the same recorded runs: 2 benches, 217 minutes, 34 injected faults. The scoring is the same event-level scoring as before. The ML engine never sees a label: every moment is scored from the past only. Run it yourself with `npm run ml:compare`; the results are in `graphs/output/ml-vs-rules.json`.

| Engine | Faults detected | Right service first (of detected) | False alarms per hour |
|---|---|---|---|
| Rules (live, as recorded) | 97% | 58% | 12.4 |
| Rules (re-scored, threshold 3) | 97% | 55% | 16.2 |
| ML, one forest, no range guard | 99 ± 1% | 49 ± 2% | 11.8 ± 1.7 |
| ML, forests only (rank by anomaly) | 100 ± 0% | 50 ± 0% | 7.8 ± 1.0 |
| **ML, forests + random walk (default)** | **99 ± 1%** | **57 ± 2%** | **7.8 ± 1.0** |

ML rows are the mean ± standard deviation over 5 random seeds: the forests are random, and a single seed varied by up to 15 points before the robust line was added.

What each part contributes:
- The two-forest split, robust line and range guard bring false alarms from about 18 per hour down to 7.8.
- The random walk adds 7 points to "right service first" over ranking by anomaly alone (57% against 50%).

**Cross-system check.** Settings were chosen on one bench and tested untouched on the other:

| Test bench | ML: detected / right first / false alarms per hour | Rules: detected / right first / false alarms per hour |
|---|---|---|
| ShopFlow (settings from LedgerLine) | 100% / 58% / 4.2 | 100% / 59% / 11.3 |
| LedgerLine (settings from ShopFlow) | 100% / 46% / 6.9 | 94% / 56% / 13.6 |

**Conclusion.**
- **Detection:** the ML engine finds as many faults as the rules or more.
- **False alarms:** it raises about half as many.
- **Root cause:** it names the right service first about as often on ShopFlow, but less often on LedgerLine (46% against 56%).

The default engine stays **Rules**; ML is one click away in the top bar.

## Limits (say these first)

- 34 faults is a small sample; differences of a few points are noise.
- Most faults overlapped with another fault (16 of 17 per bench), which makes "right service first" hard for both engines.
- The settings were chosen on these runs. The cross-system check is the fair estimate.
- The tier rule that recovers call directions uses service names (gateway, db, cache, provider...). On a system with unusual names it falls back to "direction unknown".
- A new project needs about 30 readings per service (2 to 3 minutes) before the forests exist. Until then only container facts can raise an incident.

## Files

```
server/algorithms/ml/isolationForest.ts   the forest (seeded, no dependencies)
server/algorithms/ml/serviceBaseline.ts   sliding window, gate, two forests, alarm line, range guard
server/algorithms/ml/randomWalk.ts        personalised PageRank root cause
server/algorithms/ml/mlEngine.ts          ties it together per project; direction recovery
server/algorithms/ml/replay.ts            replays a recorded run moment by moment for the experiment
server/rca/engineMode.ts                  the saved Rules / ML choice
run/cli/ml/compare.ts                     npm run ml:compare
run/tests/ml-engine.test.ts               12 tests
algorithms/ml_engine.py                   the same logic in about 170 lines of Python
```
