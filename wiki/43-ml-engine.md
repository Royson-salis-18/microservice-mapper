# The ML and hybrid engines (the Rules / Hybrid / ML switch)

The top bar has a small **Rules · Hybrid · ML** switch. It decides which engine raises incidents and names the root cause.

- The choice is saved on the server in `server/data/engine_mode.json`; `MAPPER_ENGINE=rules|hybrid|ml` overrides it.
- **Hybrid is the default.**

| | Rules | ML | Hybrid (default) |
|---|---|---|---|
| Is a service abnormal? | robust z-score per metric (median, MAD) | two **Isolation Forests** per service, trained on a sliding window of its normal readings | both: either engine can raise the alarm |
| Which service is the cause? | `max(own, symptom − explained)` | **random walk** (personalised PageRank) on the call graph | the ML engine's ranking |
| What comes next? | callers of the root | **learned cascade**: how often trouble moved along each call edge before | the learned cascade, plus a **trend forecast** (early warning) |
| Code | `server/algorithms/detection`, `rca` | `server/algorithms/ml` | `server/algorithms/ml/hybrid.ts` |

All three feed the same incident page, cascade forecast and at-risk list.

Container facts count in every mode:
- down, paused, restarting, detached;
- stopped (`docker stop`, exit code 0, after the service had been running);
- crash-looping.

They are facts, not guesses, and are always named first.

## How it works, step by step

```
every 5 s, for every service
  reading ──► scored by the models built from the PREVIOUS window ──► level (0 typical, 1 = this service's line)
                 │
                 ├── under the line   → learned (joins the window)
                 ├── a small steady shift (under level 3 for 2 minutes)  → learned: it is the new normal
                 └── a big shift      → NOT learned (for 30 minutes), so a fault never becomes normal
  every 10 learned readings: rebuild the models on the newest 120 learned readings
  trend: straight line through the last 24 readings of memory, CPU, throttling, errors, latency

then, for the whole project
  facts first: down, paused, restarting, detached, stopped, crash loop (2 outages in 3 minutes)
  ML alarm:     some service at level 2 or more, two cycles in a row
  rules alarm:  some service at 1.25 x the rule line (z = 3.75)
  hybrid:       alarm if either says so;  ranking by the random walk;  early warning from the trend;  likely-next from the learned cascade
```

### 1. Learn normal: two models per service

Each reading becomes 8 numbers: CPU, memory, throttling, network in, network out, request rate, error share and p95 latency. Positive quantities are on a log scale. They are split into two groups, each with its own model:

- **own**: CPU, memory, throttling. A broken dependency cannot cause these.
- **symptom**: traffic, errors, latency, network. These can be inherited from a broken dependency.

**Isolation Forest** (the default). 100 random trees each keep cutting the data at random values until every point is alone. An unusual reading gets isolated after only a few cuts.

```
s(x) = 2 ^ ( −E[h(x)] / c(ψ) )       E[h(x)] = average number of cuts,  c(ψ) = 2·(ln(ψ−1) + 0.5772) − 2(ψ−1)/ψ
level = (s − typical) / (line − typical),     line = typical + 3 × 1.4826 × MAD(training scores)
```

**Fixes found by bench testing:**

1. **Constant features.** Training copies get a little noise at each feature's smallest meaningful change (its floor), so a feature that never moved can still show a jump.
2. **Range guard.** A forest scores a value far outside anything it has seen no higher than its most extreme training point. The engine also counts how many floors a value is beyond the training range (5 floors = level 1).
3. **One-sided features.** Less CPU, memory, throttling, errors or latency than usual is never a fault of the service itself. It happens after every restart: memory starts low again. These features only count when they rise. Traffic and network count both ways, because a drop matters.
4. **Two-speed drift.**
   - A small steady shift (level under 3 for 2 minutes) is learned as the new normal: a restart that settled at a new memory level, a deploy.
   - A big shift is only accepted after 30 minutes, so a real fault is not learned.
5. **Alarm at level 2.** A project of a dozen services always has one hovering near its own line. The project alarms when some service reaches twice its line.

### 2. Other detectors that were tried

All plug into the same window, line and range guard (`server/algorithms/ml/detectors.ts`, setting `baseline.detector`):

| Detector | Idea | Caught and named first, recorded runs | Same, synthetic tuning set |
|---|---|---|---|
| **Isolation Forest** (default) | few random cuts isolate an odd point (Liu, Ting and Zhou 2008) | 74% | 72% |
| Mahalanobis (Hotelling T²) | distance from the mean in units of the covariance, shrunk to stay invertible | 71% | 75% |
| k-nearest neighbours | mean distance to the 5 nearest normal readings (Ramaswamy et al. 2000) | 68% | 72% (but 3× the false alarms) |
| HBOS | how rare each feature's histogram bin is (Goldstein and Dengel 2012) | 68% | 72% (but 4× the false alarms) |
| Ensemble of all four | mean of the four levels | 71% | 76% |
| Isolation Forest + Mahalanobis | mean of the two levels | 71% | 76% |

On the recorded faults one fault is a few points, so the top four are a tie. Isolation Forest stays the default because it had the fewest false alarms on the recorded runs. The others are one setting away.

These numbers were measured before fixes 3 to 5 above, and before the ledger correction below (on 34 of the 62 recorded faults).

### 3. Facts first: stopped and crash-looping containers

- **`docker stop` exits with code 0**, which normally means a one-shot job finished. A service that had been running for a minute and then exits counts as stopped.
- **A crash loop looks healthy between kills.** Two outages within 3 minutes make it a crash loop, and it stays first for a minute after the last one.

### 4. Find the source: random walk on the call graph

This is MonitorRank (Kim, Sumbaly and Shah, SIGMETRICS 2013), a personalised PageRank. A walker starts on anomalous services and keeps stepping:

| Move | Weight | Meaning |
|---|---|---|
| to a service it calls | `w × anomaly(callee)` | follow the trouble towards its source |
| back to a caller | `0.2 × anomaly(caller)` | do not get stuck at a dead end |
| stay | `max(0, anomaly(self) − worst callee, own(self))` | its trouble is not explained by anything it calls, or its own CPU and memory are off |

With probability 0.15 it jumps back to an anomalous service. The share of time spent on each service is its root-cause score.

**Directions.** Connections are seen from both ends. The engine keeps the direction a call normally takes, from entry point to service to data store or external provider. A pair between two ordinary services keeps both directions, marked "direction unknown".

**Other root-cause methods that were tried** (setting `rca`; measured on 34 of the 62 recorded faults, before the ledger correction):

| Method | Idea | Recorded runs | Synthetic |
|---|---|---|---|
| **MonitorRank walk** (default) | above | 74% | 72% |
| PageRank (MicroRCA style) | follow calls to anomalous callees, no "stay", no explaining away | 74% | 71% |
| Onset order | the service that turned abnormal first is weighted up (half weight per 30 s later) | 65% | 71% |
| Deepest anomalous | prefer anomalous services with no anomalous callee | 68% | 73% |

### 5. The hybrid

The rule engine and the ML engine judge the same moment (`server/algorithms/ml/hybrid.ts`). Every way of combining them was scored on the recorded runs and on the synthetic tuning set (`npm run ml:hybrid`):

- **When to alarm.** The options were:
  - one engine alone;
  - either engine;
  - both engines;
  - both on the same service;
  - ML, or the rules well over their own line ("or-strict").
- **Who is first.** The options were:
  - one engine's order;
  - a weighted blend of the walk share and the rule score;
  - reciprocal rank fusion.

The chosen hybrid: **alarm when the ML engine says so, or when the rules are at 1.25 × their line on their own; rank with the ML engine.**
- Plain "either engine" catches one or two faults more, but brings almost all of the rules' false alarms.
- The blends did not beat the ML ranking on the recorded runs.

### 6. Predictions

- **Early warning (trend forecast).**
  - A straight line is fitted through the last 24 readings (2 minutes) of each rising-only feature: memory, CPU, throttling, errors, latency.
  - It must be clearly rising (R² ≥ 0.6, and a change worth at least two floors).
  - It is projected 2 minutes ahead and judged with the range guard.
  - It warns when a service not yet at the alarm level is heading there.
- **Likely next (learned cascade).**
  - **Learning.** Every time a service turns abnormal, each healthy caller is a trial: did it turn abnormal within a minute?
  - **Probability per call edge.** The success rate per call edge, with a Beta prior worth 2 trials at 0.5, is that edge's propagation probability.
  - **Spreading the risk.** Risk travels up from the suspect by noisy-OR, as in the independent-cascade model (Kempe, Kleinberg and Tardos 2003).
  - **What is shown.** Services with risk ≥ 0.5 are shown as likely next.

## Results

All numbers come from the same event-level scoring.
- A fault is **detected** when an alarm during it has the right services near the top.
- It is **caught and named** when, in addition, the faulted service is first.
- **False alarms per hour** counts alarm episodes outside every fault window.
- **Alarm time** is the share of fault-free time spent in alarm.

No engine ever sees a label: every moment is judged from the past only.

> **Corrections.**
> 1. Earlier versions of this page reported the ML engine with about a fifth of the rules' false alarms. That number counted alarm *episodes* only. Measuring alarm *time* showed the previous engine was alarming for most of the fault-free time (86% on the recorded runs): one long alarm counts as one episode. Fixes 3 to 5 above bring it to 5%. Every table below includes alarm time.
> 2. Each recorded run holds two fault campaigns, and both number their faults from f001. The ledger reader kept only the second campaign, so 14 of the 31 faults per bench were missing from every earlier table (for all engines), and their outages were counted as false alarms. The reader is fixed (`server/algorithms/evaluation/score.ts`, with a test), and all numbers below use all 62 faults.

### On the recorded bench runs (2 benches, 217 minutes, 62 faults)

`npm run ml:compare` (ML over 5 seeds) and `npm run ml:hybrid`:

| Engine | Detected | Right service first (of detected) | Caught and named first | False alarms per hour | Alarm time |
|---|---|---|---|---|---|
| Rules (live, as recorded) | 89% | 60% | 53% | 4.6 | 11% |
| Rules (re-scored, with the same container facts) | 90% | 71% | 65% | 9.2 | 9% |
| ML, previous version (two-sided, alarm at the line) | 96 ± 1% | 77 ± 1% | 74% | 2.5 | **86%** |
| ML now (5 seeds) | 88 ± 1% | 81 ± 1% | 71% | 2.0 | 5% |
| **Hybrid (default)** | **90%** | **82%** | **74%** | 6.2 | 7% |

- **Root cause.** The ML and hybrid engines name the right service first far more often than the rules (81 to 82% against 60 to 71%).
- **Detection.** The hybrid gets back the faults the ML engine alone misses (90% against 88%).
- **Alarms.** It alarms less than the live rules (7% of fault-free time against 11%).
- **The walk.** It adds 2 points over ranking by anomaly alone (81% against 79%).

**Cross-system check** (ML settings chosen on one bench, tested untouched on the other, 5 seeds):

| Test bench | ML: detected / right first / false alarms per hour / alarm time | Rules (live) |
|---|---|---|
| ShopFlow | 87% / 85% / 2.2 / 5% | 90% / 64% / 1.5 / 6% |
| LedgerLine | 87% / 78% / 1.5 / 2% | 87% / 56% / 7.7 / 15% |

By class (caught and named first, recorded runs):

| Class | Faults | Rules | ML | Hybrid |
|---|---|---|---|---|
| stop | 16 | 9 | 16 | 16 |
| crash | 16 | 16 | 16 | 16 |
| brownout | 14 | 1 | 0 | 1 |
| memory | 6 | 4 | 4 | 4 |
| crash-loop | 4 | 4 | 3 | 3 |
| pause | 4 | 4 | 4 | 4 |
| flap | 2 | 2 | 2 | 2 |

Brownouts are the open problem on the real benches: every engine misses almost all of them. Many hit near-idle services, where throttling barely shows.

### On a synthetic bench (held-out set, 178 faults)

- `npm run ml:synth` writes synthetic campaigns in the recorded format.
- **What it simulates.**
  - The two bench topologies with their measured baselines, plus random ones.
  - Traffic waves and bursts.
  - Nine fault classes that spread up and down the call graph.
  - Overlapping faults.
  - Unlabelled noise: noisy neighbours, deploys, missing readings.
- **How it was used.** Settings were chosen on one set (seed 1, 170 faults) and tested once on another (seed 2, 178 faults).

| Engine | Detected | Right first (of detected) | Caught and named first | False alarms per hour | Alarm time |
|---|---|---|---|---|---|
| Rules (with the same container facts) | 89% | 78% | 70% | 1.3 to 3.7 | 1 to 2% |
| ML | 89% | 78% | 70% | 0 | 1 to 10% |
| **Hybrid (default)** | **92%** | **79%** | **72%** | 0 to 1.6 | 2 to 10% |

(Ranges are over the two halves of the set.)

Caught and named first, by class:

| Class | Faults | Rules | ML | Hybrid |
|---|---|---|---|---|
| flap | 12 | 2 | 12 | 12 |
| stop | 24 | 21 | 23 | 23 |
| crash-loop | 16 | 14 | 14 | 14 |
| brownout | 26 | 18 | 16 | 18 |
| crash | 27 | 23 | 21 | 21 |
| memory | 18 | 13 | 12 | 12 |
| partition | 15 | 15 | 13 | 13 |
| pause | 15 | 14 | 13 | 13 |
| slow network | 25 | 4 | 0 | 2 |

- **Where the hybrid wins.** It catches more faults than either engine alone (92% against 89%).
- **Where each engine is better.**
  - The ML engine is clearly better on flapping containers.
  - The rules are a little better on brownouts and crashes.
  - The hybrid takes the rules' brownouts back.
- **Slow network.** Faults on a database or cache with no request metrics of its own stay hard for every engine.

### Predictions (`npm run ml:predict`)

| | Recorded runs (62 faults) | Synthetic held-out (178 faults) |
|---|---|---|
| Faults warned before the first alarm | 1 | 16 (memory 7 of 18, brownout 5 of 26, slow network 4 of 25) |
| Median lead over the alarm | 90 s | 30 s |
| False warnings per fault-free hour | 7.7 | 0.9 |
| Likely next, learned cascade: precision / recall / F1 | 10% / 55% / 0.17 | 40% / 47% / 0.43 |
| Likely next, everything upstream: precision / recall / F1 | 8% / 75% / 0.14 | 32% / 73% / 0.45 |
| Likely next, the live mapper's own at-risk list | 15% / 45% / 0.23 | (not recorded) |

- **Early warning.** It works for faults that build up: memory leaks, throttling, slowly rising latency. On sudden faults (crash, stop, pause) there is nothing to forecast. The recorded runs have almost no slow faults, so it rarely fires there.
- **Learned cascade.** It is more precise than "everything upstream" and misses more, with about the same F1. The live mapper's own at-risk list is the best predictor on the recorded runs. Predicting who is hit next is hard for all three, and the margins are small.

## Limits (say these first)

- 62 recorded faults is a small sample: one fault is about 2 points.
- Most faults overlapped with another fault, which makes "right service first" hard for every engine.
- Settings were chosen on the recorded runs and the synthetic tuning set. The held-out synthetic set is the fair estimate. It is a simulator: cleaner than a real system, useful for comparing engines and fault classes, not a claim about production accuracy.
- The `docker stop` and crash-loop facts were found by looking at the recorded runs. Both are given to every engine in the comparisons, but the live rule engine alone does not have them.
- The tier rule that recovers call directions uses service names (gateway, db, cache, provider...). On a system with unusual names it falls back to "direction unknown".
- A new project needs about 30 readings per service (2 to 3 minutes) before the models exist. Until then only container facts and the rules can raise an incident.

## Files

```
server/algorithms/ml/isolationForest.ts   the forest (seeded, no dependencies)
server/algorithms/ml/detectors.ts         Isolation Forest, k-nearest neighbours, Mahalanobis, HBOS
server/algorithms/ml/serviceBaseline.ts   sliding window, gate, two-speed drift, one-sided features, range guard, trend forecast
server/algorithms/ml/randomWalk.ts        MonitorRank walk and plain PageRank
server/algorithms/ml/propagation.ts       learned cascade (independent-cascade model with learned edge probabilities)
server/algorithms/ml/mlEngine.ts          ties it together per project; facts; direction recovery; warnings; likely next
server/algorithms/ml/hybrid.ts            combining the rule engine and the ML engine
server/algorithms/ml/replay.ts            replays a recorded run moment by moment for the experiments
server/rca/engineMode.ts                  the saved Rules / Hybrid / ML choice
run/cli/ml/compare.ts                     npm run ml:compare   ML against the rules, sweeps, cross-system check
run/cli/ml/hybrid.ts                      npm run ml:hybrid    every way of combining the two engines
run/cli/ml/predict.ts                     npm run ml:predict   early warning and likely-next accuracy
run/cli/ml/synth.ts                       npm run ml:synth     synthetic fault campaigns in the recorded format
run/cli/ml/bench.ts                       npm run ml:bench     both engines on any runs, per fault class
run/tests/ml-engine.test.ts               19 tests
algorithms/ml_engine.py                   the same ideas in about 250 lines of Python
client/src/components/MLLivePanel.tsx     the live "What the engine sees" table, warnings and likely next
```
