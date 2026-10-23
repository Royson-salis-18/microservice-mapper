# Rules vs. the old ML vs. the new ML

This page puts the three detection engines of the mapper next to each other on the same recordings and explains, in plain words, what changed and why. It was written after the ML correction (branch `ml-correction`), when we replaced the Isolation Forest baseline with the load-aware residual model. Every number below comes from `npm run ml:levels` (`run/cli/ml/levels.ts`), which replays each recording through each engine in exactly the same way, so the three rows are comparable.

## 1. Why we had to redo the ML engine

The complaint that started this was simple. We ran the Fault Lab with the rule engine, stopped the Fault Lab, switched to ML, and the page said every service was 100% anomalous. Nothing was broken. The traffic had just stopped.

The old ML engine learned one Isolation Forest per service on the last few minutes of readings. A forest only knows "the shapes it has seen". When the injector stopped, request rates and network fell to almost zero on every service at once, which is a shape none of the forests had seen, so every service scored as an outlier. The same happens the other way round when traffic starts again, or when a load test doubles the rate. In other words the old model could not tell *the whole project got busier or quieter* from *one service went wrong*. On our two fault-free workload recordings it was in alarm for 23% and 52% of the time.

## 2. The three engines in one paragraph each

**Rules.** Every metric of a service is compared with its own recent history as a robust z-score (median and MAD). A service alarms when its score passes 3. For the source, services with a container fact (stopped, paused, crash-looping) come first, then the highest rule score. Nothing is learned, so it is easy to explain, but every change of traffic looks like a deviation, and when there is no container fact the loudest service (often a victim of the real fault) gets the blame.

**Old ML (Isolation Forest).** One forest per service, trained on a sliding window of its own readings, two forests per service (own resources and symptoms). The anomaly score feeds a random walk over the call graph, which spreads the blame so a service that only suffers because of a dependency scores low. Good at naming the source of a fault; poor at telling a fault from a change of workload.

**New ML (load-aware residual).** Before any service is judged, the model estimates how much the whole project's workload moved in this reading, as the median shift of the signals that carry traffic (network, requests, CPU) over all busy services. A fault in one or two services cannot move a median, but a real traffic change moves all of them. Each service then learns, without labels, how strongly each of its signals follows that shared load (a small ridge regression with a sensible prior). A reading is unusual only if it is far from what the load predicts, measured in robust spreads with an upper-tail allowance for bursty signals. The same random walk names the source.

## 3. Results on the same recordings

C+N = the fault was caught **and** the right service was named first. FA/h = false alarms per hour of fault-free time. "Alarm time" on the workload sets is the share of a fault-free recording during which the engine was in alarm; ideally 0%.

### 3.1 Injected faults

| Engine | Real (62 faults) C+N | FA/h | Live, auto-restart on/off (84) C+N | FA/h | Synthetic (125) C+N | FA/h |
|---|---|---|---|---|---|---|
| Rules | 63% | 9.2 | 45% | 16.3 | 75% | 2.6 |
| Old ML (forest) | 69% | 4.6 | 46% | 40.9 | 76% | 0.2 |
| **New ML (load-aware)** | **71%** | **2.3** | **48%** | **0.0** | **78%** | **0.2** |

Detection rate alone (caught, whoever was named): rules 90% / 96% / 83%, old ML 87% / 99% / 87%, new ML 90% / 99% / 88% (real / live / synthetic). Median delay from injection to alarm: rules 15 s, old ML 12 s, new ML 12 s on the real run.

### 3.2 Workload changes with no fault at all

| Engine | Organic traffic on/off: FA/h | alarm time | Concurrency steps 2→8→2→0→20→2: FA/h | alarm time |
|---|---|---|---|---|
| Rules | 9.2 | 12% | 7.7 | 35% |
| Old ML (forest) | 27.7 | 23% | 21.3 | 52% |
| **New ML (load-aware)** | **0.0** | **0%** | **1.0** | **0%** |

This is the table that matters for the original bug. The old ML spent about half of the step recording in alarm; the new one spends none of it in alarm.

### 3.3 Ranking quality per reading (ROC)

Area under the ROC curve and average precision when every (service, reading) pair is scored and the faulty service during a fault counts as positive. Real = runC, test = held-out synthetic campaigns.

| Engine | AUROC real | AP real | AUROC test | AP test |
|---|---|---|---|---|
| Rules | 0.69 | 0.34 | 0.87 | 0.67 |
| Old ML (forest) | 0.63 | 0.29 | 0.86 | 0.53 |
| New ML (load-aware) | 0.66 | 0.31 | 0.84 | 0.66 |

We report this honestly: per reading, the rule z-score ranks best on both sets. That is not a contradiction with the tables above. A single high reading is cheap; what the user sees is an alarm (two cycles in a row over the line) and a named source, and there the rule engine falls behind because it fires on traffic swings and blames the loudest service. Between the two ML models, the new one has clearly higher average precision on the held-out set (0.66 against 0.53) and a slightly lower AUROC there.

### 3.4 Cost

Mean time for one full decision window on one core: old ML 8.9 ms for 10 services and 296 ms for 320; new ML 4.0 ms and 119 ms. Both are far below the 5-second collection period, but the new model is about 2.5 times cheaper at 320 services and has much smaller spikes, because it refreshes a few medians instead of refitting every forest at once.

## 4. What exactly is different, and why it is better

1. **It knows about the workload.** The old model had one notion of normal per service. The new one has a notion of normal *given the current load*. Traffic going to zero, doubling, or coming back is explained away before anything is judged. This is the direct fix for "all services 100% anomalous".
2. **It still sees a fault that happens during a load change.** The load is a median over services, so the faulty service cannot drag it. And each signal is tested two ways (ignoring the load and following it with the learned slope); it counts as unusual only if neither explains it. A CPU spike on one service during a traffic surge is still a spike against what the surge predicts.
3. **It treats bursty signals fairly.** Network and request counts are spiky even when healthy. The spread now has a floor at the distance to the 90th percentile, so a burst that happens every few minutes is not scored as a five-sigma event. Without this (the "MAD spread" rows in `ml-levels.json`) the false alarms come back.
4. **It does not learn from its own alarms.** Only readings below the line join the training window, so a long fault does not slowly become "normal". A small shift is accepted as the new normal after two minutes, a large one only after thirty, so a deploy that changes a service's footprint settles down instead of alarming forever.
5. **It explains itself.** Each alarm says which signal moved and by how much ("cpu 10.3 spreads from what the load predicts"), and the engines page shows a chip when the workload moved and was taken out. The forest gave a single score with no reason.
6. **Same rules of the mapper.** No labels, no training data, nothing installed on the hosts. It only reads the telemetry the mapper already collects over SSH and Docker, one reading every five seconds, and it runs inside the server.

## 5. Where it is not better

- On injected faults the gain over the old ML is small (one or two points of C+N). The forest was already good at naming the source; that part comes from the random walk, which we kept.
- A slow fault that stays mildly above the line for more than two minutes is accepted as the new normal. In the slow-payment simulation the new ML alarmed after 5 s, named `payment`, and then went quiet after about 48 s of sim time. We tried four and six minutes; the real-run alarm time doubled with no gain in C+N, so we kept two minutes and list this as a limitation.
- The load factor needs at least two busy services. In a project with a single service it falls back to a plain control chart (which is what the "control chart, tail spread" row measures).
- Per-reading ROC is not better than the rule score on the real run.

## 6. Where the numbers come from

- `run/cli/ml/levels.ts`: the harness. `ML_LEVELS_OUT=... npx tsx run/cli/ml/levels.ts --variants rules` for the rules row; the default run for the rest. Output: `paper/data/ml-levels.json`.
- `paper/exp/detroc.ts {rules|iforest|load} {real|test}`: ROC. Output: `paper/data/roc_*.json`.
- `paper/exp/scale.ts`: cost. Output: `paper/data/scale.json`.
- Recordings: `run/recorded-runs/runC` (real), `run/recorded-runs/autorestart/*` (live), `run/recorded-runs/workload/*` and `run/recorded-runs/steps/*` (fault-free workload changes), `run/synthetic-runs/c*` (synthetic).
- Model code: `server/algorithms/ml/loadModel.ts`; the engine picks it with `levels: 'load'` (the default) in `server/algorithms/ml/mlEngine.ts`.

The full write-up, with the equations and every alternative we tried (kNN, Mahalanobis, HBOS, a forest ensemble, control charts and a PCA subspace model), is in Chapter 4 and Chapter 6 of the project report (`report/main.pdf`).
