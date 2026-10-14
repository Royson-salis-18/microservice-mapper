# The ML engine (the Rules / ML switch)

The top bar has a small **Rules · ML** switch. It decides which engine raises incidents and ranks the root cause. The setting is saved on the server, in `server/data/engine_mode.json`; `MAPPER_ENGINE=ml` or `rules` overrides it. The default is ML.

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
  facts first: down, paused, restarting, detached, stopped (exit 0 after running), crash loop (2 outages in 3 min)
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

### 2. Facts first: stopped and crash-looping containers

A container that is down, paused, restarting or cut off from the network is a fact, not a guess, and it is ranked first. Bench testing found two cases where the plain container state hides the fact:

- **`docker stop` exits with code 0.** Code 0 normally means a one-shot job finished, so it was ignored, and every stopped service in the recorded runs (8 of 8) went unnamed by both engines. Now a service that had been running for at least a minute and then exits counts as stopped, whatever the code.
- **A crash loop looks healthy between kills.** Two separate outages within 3 minutes make it a crash loop; it stays first for a minute after the last outage. The same rule covers a flapping container.

Memory also got a finer floor (5% instead of 15%): memory hardly moves on a healthy service, so a leak is visible much earlier.

### 3. Find the source: random walk on the call graph

This is MonitorRank (Kim, Sumbaly and Shah, SIGMETRICS 2013), a personalised PageRank. A walker starts on anomalous services and keeps stepping:

| Move | Weight | Meaning |
|---|---|---|
| to a service it calls | `w × anomaly(callee)` | follow the trouble towards its source |
| back to a caller | `0.2 × anomaly(caller)` | do not get stuck at a dead end |
| stay | `max(0, anomaly(self) − worst callee, own(self))` | its trouble is not explained by anything it calls, or its own CPU and memory are off |

With probability 0.15 it jumps back to an anomalous service (the restart). The share of time spent on each service is its root-cause score.

**Directions.** Connections are seen from both ends, so in the recordings almost every link appears in both directions (15 of 32 pairs in ShopFlow, 18 of 36 in LedgerLine). The engine keeps the direction a call normally takes, from entry point to service to data store or external provider. A pair between two ordinary services keeps both directions, marked "direction unknown"; such a pair can move the walker but cannot explain a service away.

## Results

### On the recorded bench runs

Both engines are scored on the same recorded runs: 2 benches, 217 minutes, 34 injected faults. The scoring is event-level, as before. The ML engine never sees a label: every moment is scored from the past only. Run it yourself with `npm run ml:compare`; the results are in `graphs/output/ml-vs-rules.json`.

| Engine | Faults detected | Right service first (of detected) | False alarms per hour |
|---|---|---|---|
| Rules (live, as recorded) | 97% | 58% | 12.4 |
| Rules (re-scored, threshold 3) | 97% | 55% | 16.2 |
| ML, first version | 99 ± 1% | 57 ± 2% | 7.8 ± 1.0 |
| ML now, forests only (rank by anomaly) | 100 ± 0% | 68 ± 0% | 2.6 ± 0.4 |
| **ML now, forests + random walk (default)** | **95 ± 1%** | **77 ± 1%** | **2.6 ± 0.4** |

ML rows are the mean ± standard deviation over 5 random seeds.

- Against the live rules, the ML engine names the right service first 19 points more often and raises about a fifth of the false alarms. It misses one or two faults more (95% against 97%).
- The random walk adds 9 points to "right service first" over ranking by anomaly alone.
- Where the gain comes from (faults caught and named first, seed 0):

  | Class | Faults | Rules (live) | ML first version | ML now |
  |---|---|---|---|---|
  | stop | 8 | 0 | 0 | **8** |
  | crash | 10 | 10 | 10 | 9 |
  | memory | 6 | 5 | 5 | 3 |
  | brownout | 6 | 0 | 1 | 2 |
  | crash-loop | 2 | 2 | 2 | 1 |
  | pause | 2 | 2 | 2 | 2 |

  Most of the gain is the stop fix. Memory got worse on these runs (5 → 3 of 6), even though it improved on the synthetic bench. With 6 faults that difference could be noise, but it is listed rather than hidden.

**Cross-system check.** Settings were chosen on one bench and tested untouched on the other:

| Test bench | ML: detected / right first / false alarms per hour | Rules (live): detected / right first / false alarms per hour |
|---|---|---|
| ShopFlow (settings from LedgerLine) | 89% / 82% / 3.0 | 100% / 59% / 11.3 |
| LedgerLine (settings from ShopFlow) | 100% / 60% / 5.3 | 94% / 56% / 13.6 |

On both benches, with settings it was not tuned on, the ML engine now names the right service first more often than the rules, with fewer false alarms. LedgerLine was the weak bench before (46% against 56%); it is now 60%. On ShopFlow it detects fewer faults with those borrowed settings (89%).

### On a synthetic bench (many more faults)

34 faults is a small sample, so a synthetic bench was built: `npm run ml:synth` writes campaigns in exactly the recorded format, and `npm run ml:bench -- <dirs>` scores any set of runs, overall and per fault class.

- **What it simulates.**
  - The two bench topologies, with baselines taken from the recorded runs, plus random topologies.
  - Traffic waves and bursts.
  - Nine fault classes. Effects travel up the call graph (callers see errors and slow calls) and down it (callees see less traffic).
  - Overlapping faults.
  - Things that are not faults and carry no label: noisy neighbours, a deploy that moves one service's memory level for good, and missing readings.
- **How it was used.**
  - The new settings were chosen on one set: seed 1, 16 one-hour campaigns, 170 faults.
  - They were then tested once on a set not used for tuning: seed 2, 16 campaigns, 178 faults.

| Engine (held-out synthetic set, 178 faults) | Detected | Right first (of detected) | Caught and named first | False alarms per hour |
|---|---|---|---|---|
| Rules (re-scored) | 87% | 61% | 53% | 2.5 |
| ML, first version | 87% | 58% | 50% | 3.2 |
| **ML now** | **98%** | **76 ± 1%** | **75%** | **3.2 ± 0.2** |

Caught and named first, by class:

| Class | Faults | Rules | ML first version | ML now |
|---|---|---|---|---|
| stop | 24 | 1 | 0 | 23 |
| flap | 12 | 0 | 0 | 12 |
| crash-loop | 16 | 13 | 2 | 14 |
| memory | 18 | 13 | 10 | 15 |
| crash | 27 | 17 | 25 | 23 |
| partition | 15 | 11 | 15 | 13 |
| pause | 15 | 14 | 15 | 13 |
| brownout | 26 | 21 | 20 | 15 |
| slow network | 25 | 4 | 2 | 5 |

- **Brownouts are the ML engine's weak class.** Most misses are brownouts that overlap a crash or stop elsewhere: the dead container is ranked first by design, and only one service can be first at a time.
- **Slow networks are hard for both engines.** A slow database reports no latency of its own, so only its callers show it. One extra rule was tried for this case (blame a metric-less dependency when all its callers suffer). It gained one fault and was left out.

**Conclusion.**
- On the recorded runs and on the synthetic bench, the ML engine names the right service first clearly more often than the rules.
- It raises fewer false alarms than the rules on the recorded runs, and about the same on the synthetic bench.
- It is the default engine. The rule engine is one click away in the top bar, or set `MAPPER_ENGINE=rules`.
- The incidents page shows, in ML mode:
  - each service's forest levels and its share of the walk, in the "Why ... scores" box;
  - a live table of what every service has learned.

## Limits (say these first)

- 34 faults is a small sample; differences of a few points are noise.
- Most faults overlapped with another fault (16 of 17 per bench), which makes "right service first" hard for both engines.
- The first version's settings were chosen on these runs. The new settings were chosen on the synthetic bench. The stop fix, however, was found by looking at the recorded runs (stopped services never appeared in any ranking). The cross-system check and the held-out synthetic set are the fair estimates.
- The rule engine has the same blind spot for `docker stop`. The fix lives in the ML engine only, so the comparison on stop faults reflects that fix, not a better model.
- The synthetic bench is a simulator. It is cleaner than a real system, so its absolute numbers are higher than on real runs. It is useful for comparing settings and fault classes, not as a claim about production accuracy.
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
run/cli/ml/synth.ts                       npm run ml:synth: synthetic fault campaigns in the recorded format
run/cli/ml/bench.ts                       npm run ml:bench: score both engines on any runs, per fault class
run/tests/ml-engine.test.ts               14 tests
algorithms/ml_engine.py                   the same logic in about 210 lines of Python
client/src/components/MLLivePanel.tsx     the live "What the ML engine sees" table
```
