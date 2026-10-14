# Learning folder: can a trained model beat the hand-written rules?

Python files in this folder: `logreg.py`, `dataset.py`, `evaluate.py`, `experiment.py`. Run any of
them with `python3 algorithms/learning/<file>.py` for a small demo, and the tests with
`python3 algorithms/learning/test_learning.py`.

The story in one paragraph. The live mapper decides "which service is broken?" with hand-written
rules. We asked: if we record runs where we inject known faults, can a statistical model learn the
rule from the data and do better? We built a small logistic regression (`logreg.py`), turned the
recorded runs into labelled rows (`dataset.py`), judged scorers the way an operator would
(`evaluate.py`), and ran a careful experiment (`experiment.py`). The answer on the recorded data
was no, so the model was not installed (section "Why the learned model was not installed").

Before the algorithms, two ideas used everywhere.

**Feature vector.** For every service at every moment the detector computes 18 numbers
(`own`, `symptom`, `cpu`, `memory`, `throttle`, `netDrop`, `reqDrop`, `errRise`, `latRise`, `down`,
`paused`, `restarting`, `detached`, `callersSymptomMax`, `callersSymptomMean`,
`calleesEvidenceMax`, `hasRequests`, `noData`). The real code that makes them is
`server/algorithms/detection/features.ts`. In Python we only copy the names (`FEATURE_NAMES` in
`dataset.py`) and take finished vectors as input.

**Event-level metrics.** A naive evaluation counts each row (one service at one moment) as right
or wrong. An operator does not care about rows. They care about events: was this fault caught,
was the right service named, how long did it take, and how many times did the pager ring for
nothing? So `evaluate.py` counts per fault ("detected", "top-1", "delay") and per alarm episode
("false alarms per hour"). Row-level accuracy can look great while the event-level result is bad,
because 99% of rows are healthy.

---

## 1. Logistic regression (`logreg.py`)

**Purpose.** Turn the 18 numbers of a service into one probability: "how likely is it that this
service is the faulted one right now?" with weights a human can read.

**Inputs.** `X` (list of rows, each a list of numbers), `y` (list of 0/1 labels), `lam` (the
penalty strength, default 1), number of iterations (30).

**Outputs.** A model dict: `mean`, `std` (for standardising), `w` (one weight per feature), `b`
(intercept), `lambda`. `predict(model, x)` gives a probability. `contributions(model, x)` lists how
much each feature pushed the log-odds, used for "why this score" in the UI.

**Steps (Newton's method, also called IRLS).**
1. Standardise each feature: `z = (value - mean) / std`. Add a constant 1 column for the intercept.
2. Give each row a class weight so both classes have the same total weight: positives get
   `n / (2 * positives)`, negatives get `n / (2 * negatives)`.
3. Start with all coefficients `beta = 0`.
4. For each row compute `p = sigmoid(z . beta)`, its curvature `w = cw * p * (1 - p)` and its
   residual `e = cw * (y - p)`.
5. Add up the gradient `g = sum(e * z)` and the Hessian `H = sum(w * z * z^T)`.
6. Add the penalty: `g_j -= lam * beta_j` and `H_jj += lam` for every coefficient except the
   intercept. Add 1e-9 to the diagonal so `H` can always be inverted.
7. Solve `H * step = g` with Gaussian elimination (`solve`, about 19 x 19, no libraries needed).
8. `beta += step`. Stop when the biggest step is below 1e-7 or after 30 rounds.

**Formulas.**
- `sigmoid(z) = 1 / (1 + e^-z)`; the code uses `e^z / (1 + e^z)` for negative `z` so it never overflows.
- Objective being maximised: `sum_i cw_i * [y_i log p_i + (1 - y_i) log(1 - p_i)] - (lam / 2) * sum_j beta_j^2`
  (j over the weights, not the intercept).
- `predict = sigmoid(b + sum_j w_j * (x_j - mean_j) / std_j)`.

**Worked example** (8 rows, one feature called `load`, only the last two rows are faulty;
output of running the code):

```
X = 1,2,3,4,5,6,7,8   y = 0,0,0,0,0,0,1,1      (mean 4.5, std 2.29)
lambda=0.1  weight=3.434  intercept=-2.299  p(load=2)=0.002  p(6)=0.487  p(8)=0.950
lambda=1    weight=1.305  intercept=-0.666  p(load=2)=0.110  p(6)=0.547  p(8)=0.790
lambda=10   weight=0.289  intercept=-0.127  p(load=2)=0.391  p(6)=0.515  p(8)=0.578
lambda=100  weight=0.034  intercept=-0.015  p(load=2)=0.487  p(6)=0.502  p(8)=0.509
```

Read it like this: with a weak penalty (0.1) the model is confident (0.95 for the faulty-looking
value, 0.002 for a calm one). With a huge penalty (100) the weight is squeezed to almost zero and
every probability sits near 0.5, meaning "I know nothing". Class balance explains why `p(6)` is
about 0.5 even though six of eight rows are healthy: the two faulty rows count as much as the six
healthy ones together.

**Parameters.**
- `lam`: bigger means smaller weights, smoother and more stable model, but less sharp. The
  experiment tries 0.1, 1, 10, 100.
- `iters` (30) and tolerance (1e-7): Newton usually converges in under 10 rounds; the limit is a safety net.
- Class balance is always on. Turning it off makes the model learn "never a fault" because faults are rare.

**Edge cases.**
- A feature that never changes has std 0; it is replaced by 1 so we never divide by zero.
- A pivot of exactly 0 in the elimination is replaced by 1e-12 (and the penalty already keeps `H` healthy).
- One class missing: `max(1, count)` avoids dividing by zero.
- The intercept is not penalised, otherwise the base rate of faults would be pulled to 0.5.

**Mirrors:** `server/algorithms/learning/logreg.ts`.

---

## 2. Dataset (`dataset.py`)

**Purpose.** Turn one recorded run into labelled rows: which (service, moment) pairs are "faulty",
which are "fine", and which to throw away.

**Inputs.** A `Run`: a list of `Fault`s from the injector's ledger (target service, applied time
`a`, healed time `b`, services that depend on the target) and a list of `Moment`s (timestamp,
services, one feature vector per service, what the live rules said). Times are in milliseconds.

**Outputs.** `labelled_rows(run)` returns `(X, y, ts)`. `slice_run(run, start, end)` returns the
part of a run in a time range.

**Steps for `labelled_rows`.**
1. Skip every moment in the first `warmup_sec` (300 s): baselines are still forming.
2. Skip every moment in the `recovery_sec` (60 s) after a fault healed: the service is recovering,
   neither clearly faulty nor clearly fine.
3. For each remaining moment, find the faults active now (`a <= ts <= b`).
4. For each service, label 1 if it is the target of an active fault, else 0.

**Worked example** (synthetic run, 3 services, one sample every 5 s, 40 minutes, two faults; real output):

```
moments=480  rows kept=1188  positives=122  features per row=18
first 20 minutes: 240 moments, 1 fault(s) starting inside
```

480 moments x 3 services = 1440 rows. The warm-up removes 60 moments, the two recovery minutes
remove 24, leaving 396 moments = 1188 rows, 122 of them positive (about 10%). That imbalance is
why `logreg.py` uses class weights.

**Parameters.** `warmup_sec` (300) and `recovery_sec` (60): shorter warm-up keeps more data but
includes unstable baselines; a shorter recovery window adds ambiguous rows that blur the labels.

**Edge cases.** A fault that starts inside a slice belongs to that slice (`slice_run` filters by start
time). Features are not recomputed on a slice because they were built from the full causal past
(each moment only saw earlier data), exactly as the live server would.

**Left out compared with the TS:** building features from raw metrics, loading the ledger and observer files.

**Mirrors:** `server/algorithms/learning/dataset.ts`.

---

## 3. Event-level evaluation (`evaluate.py`)

**Purpose.** Judge a scorer per fault and per alarm, as an operator would feel it.

**Inputs.** Runs, a `scores(run_index, moment_index)` function giving one score per service, a
threshold, and options `grace_sec` (60), `warmup_sec` (300), `persistence` (2).

**Outputs.** Per-fault outcomes plus: `detected` and `top1` (proportion with Wilson interval),
`false_alarms`, `fp_hours`, `per_hour`, `median_delay`.

**Steps.**
1. At each moment take the highest score. "Hot" means it is at or above the threshold.
2. Alarm at moment `i` = hot for `persistence` consecutive moments ending at `i`
   (a single spike does not count).
3. For every fault look at moments from `a` to `b + grace`. The fault is **detected** at the first
   alarming moment whose top three services include the target or a service that depends on it.
4. **Delay** = first such moment minus `a`.
5. **Top-1** is true when, at the last such alarming moment before the fault healed (`ts <= b`),
   the best-scored service is the target.
6. Alarm episodes are maximal runs of consecutive alarms. An episode that overlaps no
   fault window `[a, b + grace]` and starts after warm-up is a **false alarm**.
7. Fault-free time = sum of the gaps between moments (after warm-up) that lie outside every window.
   `per_hour = false_alarms / fault_free_hours`.

**Formulas.**
- `objective = 2 * caught * precision / (caught + precision)` where
  `caught = faults detected with the right service first / all faults` and
  `precision = faults detected / (faults detected + false alarms)`.
- `tune_threshold` tries up to 60 candidates taken from the 50% to 100% quantiles of the observed
  top scores, and keeps the one with the best objective (only a strictly better value replaces the
  current best). It is only ever run on training data.

**Worked example** (16 moments, 10 s apart; service `db` has a crash from 55 s to 95 s; the scorer
for `db` is `0,0,0,0.1,0,0,0.9,0.95,0.9,0.2,0,0.8,0.85,0,0,0`; threshold 0.5, grace 10 s, no warm-up):

```
persistence=2: false alarms=1  fault-free hours=0.02778  per hour=36.0  delay=15.0 s
persistence=1: false alarms=1  fault-free hours=0.02778  per hour=36.0  delay=5.0 s
```

The score is hot at 60 s, 70 s and 80 s. With persistence 2 the alarm starts at 70 s, so delay is
70 - 55 = 15 s; with persistence 1 it starts at 60 s, delay 5 s. The second burst (110 s and 120 s)
is outside the window that ends at 105 s, so it is one false alarm in 100 s of fault-free time,
which is 36 per hour. Persistence trades speed for fewer silly alarms.

**Parameters.** `threshold` (higher: fewer false alarms but missed faults), `persistence` (higher:
fewer spurious pages, slower detection), `grace_sec` (how late after healing an alarm still counts for that fault).

**Edge cases.** No faults gives `nan` proportions (Wilson with n = 0). Median of an empty list is
`nan`. The "live" mode uses the recorded alarm flag, with no persistence rule, because the live
mapper has its own timing logic. It is called with threshold 0.5, because the flag is 0 or 1. (An earlier
version of the TS passed 0, which made every moment "hot" and gave the live mapper 0 false alarms by accident;
that was fixed and the numbers in this folder come from the fixed run.)

**Mirrors:** `server/algorithms/learning/evaluate.ts`.

---

## 4. Experiment: training, blocked cross-validation, cross-system (`experiment.py`)

**Purpose.** Compare four methods on faults none of them were trained on:
`learned` (logistic model), `rulesFixed` (hand rules, threshold 3 = "three sigma"),
`rulesTuned` (hand rules, threshold tuned like the model's) and `live` (the live mapper as recorded).

**Inputs.** A list of runs (each tagged with the subject system it came from), `K` folds, the lambda grid `[0.1, 1, 10, 100]`.

**Outputs.** Pooled per-fault outcomes for each method, a summary (`summarise`): proportion
detected, top-1 of detected, false alarms per hour, median delay.

**What blocked cross-validation is, and why it is not shuffled.** Ordinary K-fold shuffles rows
at random and tests on a random fifth. Here that would be cheating. Consecutive moments look
almost identical (a service stays broken for minutes) so a shuffled test row has a near-twin in the training
set. The model would score well by memorising the neighbours, not by learning the pattern. In blocked
cross-validation each run is cut into K consecutive time blocks, fold `k` trains on the other blocks and
tests on block `k`, and nothing is shuffled. The test block is a stretch of time with its own faults that the model never saw. This is also how it
would be used live: trained on the past, judged on the future.

**Steps of `train`.**
1. Collect the allowed labelled rows.
2. For each lambda, strongest first (100, 10, 1, 0.1): fit the model, tune the threshold on the training runs, record the objective.
3. Keep the lambda with the best objective; a later lambda replaces it only if strictly better, so on ties the more shrunk (simpler) model wins.

**Steps of `cross_validate`.**
1. For fold `k` in `0..K-1`: block of a timestamp = `min(K-1, floor((ts - t0) / (t1 - t0 + 1) * K))`.
2. Test = the moments of block `k` (via `slice_run`); skip the fold if it holds no fault.
3. Train on all other blocks (lambda and threshold chosen only there). Also tune the rules' threshold there.
4. Evaluate the four methods on the test block and pool the faults and alarms of all folds.

**Steps of `cross_system`.** For each subject system, train on the runs of all other subjects and
test on this one: does it work on an architecture it never saw?

**Worked example** (synthetic: two systems, 60 minutes each, four faults each, 3-fold; real output.
The data is easy on purpose so everything scores 100%, the point is the plumbing):

```
blocked 3-fold, pooled over all folds
  learned     detected 100% of 8, top-1 of detected 100%, false alarms/h 0.8
  rulesFixed  detected 100% of 8, top-1 of detected 100%, false alarms/h 1.6
  rulesTuned  detected 100% of 8, top-1 of detected 100%, false alarms/h 0.8
  live        detected 100% of 8, top-1 of detected 100%, false alarms/h 0.0
train on others -> test benchA | learned detected 100% | live detected 100%
train on others -> test benchB | learned detected 100% | live detected 100%
```

Block numbers for a 10-minute run with one sample a minute and K = 5 (each block is two moments, in
order, never mixed): `[0, 0, 1, 1, 2, 2, 3, 3, 4, 4]`.

**Parameters.** `K` (more folds: more training data per fold but fewer faults per test block),
lambda grid, `RULES_FIXED_THRESHOLD = 3`, plus the evaluation options of section 3.

**Edge cases.** Folds without any fault are skipped. With fewer than two subjects `cross_system` returns
nothing. Threshold and lambda are always picked on training data only, never on the test block (otherwise the test would be flattered).

**Left out:** the out-of-fold ROC and calibration rows used by the TS report. `rules_score` is copied from
`server/algorithms/detection/scoring.ts` so the file stands alone:
`max(expm1(own), expm1(symptom) - expm1(calleesEvidenceMax)) + 10 * max(down, paused, restarting, detached)`.

**Mirrors:** `server/algorithms/learning/experiment.ts`.

---

## Why the learned model was not installed

On the recorded data (two benches, 217 minutes, 34 injected faults of six kinds), with blocked
five-fold cross-validation by time plus train-on-one-bench-test-on-the-other (see
`wiki/41-learning-and-calibration.md`):

| Method | Faults detected | Top-1 of detected | False alarms per hour |
|---|---|---|---|
| Live mapper (rules, as recorded) | 97% (33/34) | 58% (19/33) | 5.9 |
| Rules, fixed threshold | 97% | 55% | 8.9 |
| Learned model | 50% | 53% | 3.0 |

The learned model found half as many faults as the live rules and was not clearly better on naming the
right service. With only 34 faults the weights were unstable: strongly related features such as
`own` and `cpu` got large opposite weights, and lambda was pushed to the top of its grid.
So the rules stay and the `learned.json` weights file is not installed. The code stays as an experiment that can
be repeated once more labelled faults exist.

## Questions an evaluator may ask

**1. Why logistic regression and not something stronger?**
Only about 18 features and a few thousand rows, and 34 faults. A bigger model would overfit. A linear
model also lets us show each weight ("a paused container counts this much") and explain a score.

**2. What is the point of the class weights?**
Only about 10% of rows are faulty. Without weights the cheapest way to be accurate is to always say
"fine". Weighting makes both classes count equally in total.

**3. What does lambda do and how was it chosen?**
It is the L2 penalty: it shrinks weights so the model does not chase noise. We tried 0.1, 1, 10, 100
and kept the one with the best event objective on the training data, preferring the larger lambda on ties.

**4. Why blocked, unshuffled cross-validation?**
Neighbouring moments are near-duplicates. Shuffling lets the model peek at the twin of every test row
and inflates the score. Blocks by time give an honest "train on past, test on future" estimate.

**5. Why event-level metrics rather than accuracy per row?**
Rows are 90% healthy and strongly correlated. What matters to an operator is: fault caught, right
service named, how late, how many false pages per hour.

**6. The learned model detected only 50%. Is it a bug?**
The same code, same folds and same metrics give 97% for the rules, so the pipeline works. The cause is
too few faults for 18 correlated features. It is a data limit, which is why the decision was to keep the rules.

**7. What is the cross-system test for?**
To check generalisation to an architecture never seen in training. A model that only works on the
system it was trained on is of little use for a monitoring tool.

**8. Where is the threshold chosen, and can it leak test information?**
Inside `train` and `tune_threshold`, on training blocks only. The test block is touched once, for scoring.
