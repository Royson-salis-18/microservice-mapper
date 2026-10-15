# v2 diagnose: what kind of fault is it?

The mapper raises an incident and names a suspect service. It does not say what went wrong with it.
This module adds that step. Once the v1 hybrid engine alarms, we read the suspect's telemetry and guess the fault class.
Then we attach a short runbook: two to four first checks.

Classes: crash, stop, pause, crash-loop, flap, memory (leak), brownout (CPU throttling), latency (slow network),
partition (network detached).

## How to run

From the repo root:

```
node server/node_modules/tsx/dist/cli.mjs v2/diagnose/run.ts                      # about 4.5 min on one core, writes v2/diagnose/results.json
node server/node_modules/tsx/dist/cli.mjs --test v2/diagnose/diagnose.test.ts     # unit tests, under 1 s
```

Files:

| file | what it does |
|---|---|
| `features.ts` | finds the alarm moment and suspect, builds the feature vector |
| `models.ts` | decision list, kNN, Gaussian naive Bayes, CART tree, random forest, metrics |
| `runbook.ts` | class to first checks (docker and compose commands, what to look for) |
| `run.ts` | model selection by cross-validation, then one report on test and real |
| `diagnose.test.ts` | unit tests on toy data and a tiny handmade trace |
| `results.json` | every number below, plus all CV scores and confusion matrices |

## Method

### When and who

For each fault we replay the v1 hybrid engine and take the first alarm inside `[a, b + 60 s]`.
An alarm is two moments in a row with `max >= 1`. The alarm moment is the second one, since that is when it would page.
The suspect is `ranked[0]` at that moment.

Faults with no alarm are left out of the classification numbers. There is nothing to diagnose.
They are counted in the end-to-end numbers.

The features read only moments up to `alarm + N`. We try N = 0, 6 and 12 readings (0, 30 and 60 s after the alarm).
Nothing about the fault's true start, end or label is read. The baseline is also placed relative to the alarm,
not to the true start, so the same code would run live.

### Windows

All windows are relative to the alarm moment. Moments are 5 s apart.

- baseline: `[alarm - 300 s, alarm - 120 s]`. Medians of the suspect's metrics.
- recent: `[alarm - 120 s, alarm + N]`. State history, counts, slopes, maxima.
- tail: the last 4 readings of the recent window. "What it looks like now".

Ratios are logs against the baseline median, with a small floor so zeros do not explode:

```
ratio(x) = ln( (tail median + eps) / (baseline median + eps) )
```

### Features (35)

| group | features |
|---|---|
| container state | share of recent moments exited, paused, restarting; down right now; number of separate outages (a restart seen while "running" counts as one); longest outage (log) |
| exit and restarts | share of down moments with a non-zero exit code, with exit code 0; restart events (log); largest restartDelta |
| memory | log ratio vs baseline; slope in percent points per minute (least squares over the recent window); max memory percent; jump over baseline |
| CPU | CPU log ratio; throttling now minus baseline; max throttling |
| own traffic | p95 latency log ratio; error rate change; request rate log ratio |
| network | rx+tx log ratio; share of running moments with zero traffic; share of moments flagged networkDetached |
| neighbours | number of callers (from edges seen); share of callers over the ML line; largest caller p95 log ratio; largest caller error rate change; share of all services over the line |
| v1 engine view | ML level, own level, symptom level, hard flag, anomaly, walk share, rule score (max over the tail) |

Missing readings fall back to neutral values, so every vector is finite.

### Models

All are hand-written in `models.ts`, with no dependencies.

**Decision list (baseline).** Rules of thumb in a fixed order. Detached or silent network: partition. Paused: pause.
Memory up: memory. Down or restarted: two or more outages means flap (clean exits) or crash-loop (error exits);
one outage means stop (clean exit, or still down after 40 s) or crash. Throttled: brownout. Otherwise: latency.
It has no training.

**k nearest neighbours.** Features are z-scored with the training mean and standard deviation.
Euclidean distance; the k nearest vote with weight `1 / (d + 1e-6)`.

**Gaussian naive Bayes.** On z-scored features, per class c:

```
log P(c | x) = log P(c) + sum_j [ -0.5 log(2 pi v_cj) - (x_j - mu_cj)^2 / (2 v_cj) ] + const
v_cj = class variance of feature j + s       (s is the smoothing, picked by CV)
```

**CART tree.** Binary splits `x_j <= t`. At each node we pick the split that minimises the weighted Gini impurity of the two children:

```
Gini(S) = 1 - sum_c p_c^2            score = (n_L Gini(L) + n_R Gini(R)) / n
```

It stops at the depth limit, below 2 x minLeaf samples, at a pure node, or when no split lowers the impurity.

**Random forest.** 150 CART trees. Each is trained on a bootstrap sample. Each split looks at a random subset of
mtry features. Prediction is the majority vote. The PRNG is seeded (mulberry32), so results repeat exactly.

### Training and selection

- train: `tune.json` + `tune2.json`, 16 synthetic campaigns, 170 faults (159 alarmed).
- test: `test.json`, synthetic, held out, 178 faults (163 alarmed). Reported once.
- real: `real.json`, 2 recorded bench runs, 62 faults (56 alarmed). Reported once, as a cross-domain test.

Each model's settings are picked by leave-one-campaign-out cross-validation (LOCO) on the training set.
The score is macro-F1 on the pipeline rows of the held-out campaign. The settings are the hyperparameters
(k; smoothing; depth and minLeaf; forest depth and mtry) and which rows to train on:

- pipeline: the hybrid's own suspect, labelled with the fault's class (what the model will see live)
- oracle: the true target at the same alarm moment (the clean signature of each class)
- both: the two together

We then fit once on all training rows and score on test and real.

Each set is scored two ways:

- **pipeline**: the hybrid's suspect. This is what an operator would get.
- **oracle**: the true target at the same alarm moment. This separates "wrong class" from "wrong suspect".

Macro-F1 averages F1 over every class that appears in the truth OR in the predictions.
On real, a class that never occurs but is predicted (latency, partition) adds an F1 of 0.
This pulls real macro-F1 down a lot, so read it next to accuracy.

## Results

Accuracy / macro-F1 in percent, on alarmed faults.
CV = LOCO on train. LORO = leave-one-run-out inside real (the 2 runs), using the settings from the synthetic CV.

### N = 0 (at the alarm)

| model | setting (picked by CV) | CV | test | test oracle | real | real oracle | LORO real only | LORO synth + other run |
|---|---|---|---|---|---|---|---|---|
| rules | fixed | 73.0 / 68.5 | 71.8 / 65.8 | 81.0 / 76.9 | 48.2 / 33.8 | 50.0 / 34.0 | 48.2 / 33.8 | 48.2 / 33.8 |
| knn | k=3, both | 74.2 / 72.9 | 73.6 / 69.4 | 89.6 / 88.9 | 28.6 / 18.8 | 30.4 / 20.4 | 51.8 / 49.5 | 42.9 / 35.7 |
| nb | s=0.1, oracle | 73.6 / 69.6 | 71.2 / 65.0 | 90.8 / 90.3 | 30.4 / 19.8 | 32.1 / 23.1 | 46.4 / 51.9 | 32.1 / 23.3 |
| tree | depth 8, leaf 1, both | 72.3 / 70.7 | 75.5 / 71.8 | 91.4 / 88.9 | 35.7 / 20.8 | 37.5 / 27.1 | 42.9 / 33.0 | 46.4 / 37.3 |
| forest | depth 10, mtry 6, pipeline | 77.4 / 76.8 | 78.5 / 74.7 | 79.8 / 77.2 | 39.3 / 26.4 | 37.5 / 29.5 | 48.2 / 35.4 | 50.0 / 37.6 |

### N = 6 (30 s after the alarm)

| model | setting (picked by CV) | CV | test | test oracle | real | real oracle | LORO real only | LORO synth + other run |
|---|---|---|---|---|---|---|---|---|
| rules | fixed | 74.8 / 71.9 | 73.0 / 67.0 | 95.7 / 94.7 | 53.6 / 40.9 | 76.8 / 51.4 | 53.6 / 40.9 | 53.6 / 40.9 |
| knn | k=3, both | 79.9 / 80.7 | 78.5 / 73.8 | 93.3 / 92.4 | 35.7 / 23.5 | 48.2 / 30.7 | 62.5 / 60.5 | 51.8 / 44.6 |
| nb | s=1, oracle | 76.7 / 73.4 | 73.6 / 67.7 | 97.5 / 97.4 | 39.3 / 32.0 | 48.2 / 40.1 | 55.4 / 54.4 | 53.6 / 39.8 |
| tree | depth 8, leaf 1, both | 76.7 / 77.1 | 73.0 / 69.6 | 89.0 / 88.5 | 42.9 / 40.2 | 58.9 / 44.9 | 62.5 / 58.1 | 57.1 / 52.3 |
| forest | depth 10, mtry 12, both | 78.6 / 78.6 | 79.8 / 75.6 | 98.2 / 97.8 | 50.0 / 37.2 | 67.9 / 43.6 | 69.6 / 67.6 | 67.9 / 58.7 |

### N = 12 (60 s after the alarm)

| model | setting (picked by CV) | CV | test | test oracle | real | real oracle | LORO real only | LORO synth + other run |
|---|---|---|---|---|---|---|---|---|
| rules | fixed | 74.2 / 71.5 | 72.4 / 66.3 | 96.3 / 95.6 | 58.9 / 43.8 | 83.9 / 57.1 | 58.9 / 43.8 | 58.9 / 43.8 |
| knn | k=7, both | 79.2 / 79.4 | 77.3 / 72.5 | 96.3 / 96.0 | 58.9 / 47.4 | 75.0 / 59.1 | 64.3 / 51.0 | 64.3 / 46.1 |
| nb | s=0.1, oracle | 73.6 / 70.8 | 71.8 / 65.8 | 94.5 / 94.1 | 44.6 / 32.2 | 53.6 / 38.6 | 58.9 / 48.9 | 58.9 / 43.4 |
| tree | depth 8, leaf 1, both | 74.8 / 76.4 | 72.4 / 67.3 | 92.6 / 91.8 | 42.9 / 20.7 | 58.9 / 28.2 | 66.1 / 67.6 | 57.1 / 48.6 |
| forest | depth 10, mtry 6, both | 81.1 / 80.5 | 77.3 / 72.8 | 98.8 / 98.6 | 55.4 / 39.9 | 73.2 / 43.0 | 67.9 / 66.2 | 69.6 / 59.9 |

### What the numbers say

**Waiting helps, mostly between 0 and 30 s.** With the true target, test accuracy goes from 80 to 91% at the alarm
up to 89 to 98% at 30 s and 93 to 99% at 60 s. At the alarm, many faults are only 5 to 10 s old.
A crash and a stop look the same until the container comes back or does not.
By CV, N = 6 and N = 12 are close for every model (forest 78.6 vs 81.1 macro-F1). We suggest N = 12
(classify 1 minute after the alarm), with a provisional label at the alarm.

**Once the suspect is right, the class is nearly always right on synthetic data.**
The forest at N = 12 scores 98.8% on test with the true target, and 99.2% on the pipeline rows whose suspect was right.
The remaining errors on test come from the suspect: v1 named the right service for 119 of 163 alarmed test faults.
When the suspect is wrong, the predicted class is right only 7 to 27% of the time (it is reading the wrong container).
End to end, right suspect AND right class: 66% of all 178 test faults for the forest at N = 12, against 65% for the rules.

**The forest is best on synthetic data, but only by a few points over the rules.**
On test pipeline rows at N = 12: forest 77.3 / 72.8, kNN 77.3 / 72.5, rules 72.4 / 66.3, tree 72.4 / 67.3, NB 71.8 / 65.8.
The single tree overfits (CV chose depth 8). Naive Bayes suffers from correlated features (the state features move together).

**On real runs the hand-made rules win.** At N = 12, real pipeline accuracy: rules 58.9, kNN 58.9, forest 55.4,
NB 44.6, tree 42.9. With the true target: rules 83.9, kNN 75.0, forest 73.2.
The learned models copy synthetic quirks that the real benches do not share. The rules only encode what the
classes mean, so they move across better. Training on the other real run helps the learned models (forest
LORO 67.9 to 69.6% accuracy), but there are only 56 real rows, so treat those numbers as rough.

### Confusion highlights (N = 12)

Test, forest, true target: 2 errors out of 163. One memory leak read as stop, one latency read as crash-loop.
Every crash, stop, pause, crash-loop, flap, brownout and partition is right.

Test, forest, pipeline suspect: most errors are crash-loops and latency faults. For a crash-loop the hybrid often names
a caller, and the caller looks like latency (7 of 16 right). For a latency fault the slow service looks healthy, so
v1 often names a neighbour (3 of 13 right).

Real, rules, true target (47 right of 56):

```
truth \ pred  crash   stop  pause c-loop   flap    mem  brown  laten partit
crash            16      .      .      .      .      .      .      .      .
stop              .     15      .      .      1      .      .      .      .
pause             .      .      4      .      .      .      .      .      .
c-loop            .      .      .      4      .      .      .      .      .
flap              .      .      2      .      .      .      .      .      .
mem               .      .      .      .      .      6      .      .      .
brown             1      .      .      .      .      .      2      2      3
```

Real, forest, true target: crash 16/16, memory 6/6, stop 14/16, but brownout 1/8, flap 0/2, crash-loop 2/4, pause 2/4.

## Honest limits

- **Synthetic vs real.** The real benches differ from the generator in ways that matter here:
  - Real "flap" is pause and unpause cycles: paused states, no exit codes. Synthetic flap is stop and start with exit 0.
    So every model calls real flaps "pause". It is a label definition gap, not a learning problem.
  - Real brownouts on idle services (fx-provider, psp-sandbox, event-bus) show no throttling at all, because a
    service that uses little CPU does not hit a lower limit. Nothing in container metrics shows these.
    Some real brownouts also show silent network, which the rules read as partition.
  - Real memory leaks jump to about 90% at once and get OOM-killed (restarts, exit 137). Synthetic leaks grow slowly
    and never hit the limit. The forest still gets all 6 real leaks with the true target.
  - Real exit codes are sticky: the last exit code is still reported while the container runs. Synthetic only reports
    it while down. The features read exit codes only from down moments for this reason.
- **The real set is small**: 56 alarmed faults, 2 to 16 per class, no latency or partition faults. One fault moves
  accuracy by almost 2 points. Real macro-F1 is also pulled down by classes that are predicted but never occur.
- **Overlapping faults.** Some real faults overlap. The suspect can then be the other fault's target, which caps
  pipeline accuracy.
- **The suspect is the bottleneck.** On test, about 27% of alarmed faults have the wrong suspect, and those are
  rarely classified right. Better ranking will help diagnosis more than a better classifier.
- **What we looked at.** Before writing the features we looked at a few raw traces from tune and real, to learn the
  field formats (for example the sticky exit codes). After that, nothing was tuned on test or real: all settings come
  from the synthetic CV, and test and real were each scored once per N in a single run of `run.ts`.
  The real-data notes above were read after the results, to explain them, and were not fed back.
- The runbooks in `runbook.ts` are generic docker and compose checks. They were written by hand, not learned.

## Runbook example

`runbookFor('memory', 'cart')` gives:

- `docker stats --no-stream cart`: MEM USAGE close to LIMIT, and rising between two runs.
- `docker inspect -f "{{.State.OOMKilled}} {{.RestartCount}}" cart`: OOMKilled=true or a rising restart count.
- `docker compose logs --since 30m cart`: cache or queue growth, "out of memory", GC warnings.
- `docker compose restart cart`: buys time only. Find the leak before it fills up again.
