# Evaluation folder: how do we know the mapper is any good?

Python files: `score.py`, `stats.py`, `infer.py`. Demos: `python3 algorithms/detailed/evaluation/<file>.py`.
Tests: `python3 algorithms/detailed/evaluation/test_evaluation.py`.

The setting. A fault injector breaks real containers on purpose (crash, pause, brownout, memory
pressure, partition, ...) and writes a private **ledger**: "fault f1 hit service db from time a to
time b". The mapper never sees the ledger. It is only observed through its public API, snapshot
after snapshot. After the run we compare the two. That separation is what makes the numbers
honest: nothing in the scoring can influence what the mapper did.

Times in the code are milliseconds. Data shapes used by `score.py`:
fault = `{id, class, target, a, b, root, expected_affected}`, snapshot = `{ts, incidents, status}`,
incident = `{id, startedAt, endedAt, root, candidates, affected, rootEvidence}`.

**Event-level metrics** (the idea behind everything here): instead of asking "how many snapshots
were right?" we ask per event. Per fault: was it detected, how late, was the real root named
first? Per alarm: did it correspond to a real fault, and how many wrong alarms per hour? A snapshot-level
percentage would be dominated by the long calm periods and would hide what an operator experiences.

---

## 1. Scoring a mapper against the ledger (`score.py`)

**Purpose.** For each injected fault, decide if the mapper noticed it, how fast, whether it named
the right cause, and how many incidents it raised when nothing was wrong.

**Inputs.** List of ledger faults, list of snapshots, `grace_sec` (60), `warmup_sec` (0).

**Outputs.** Per-fault results, and aggregates: `detected`, `top1`, `top3` (proportions with Wilson
intervals), `mrr`, `delay` (median, p90, mean), `structural` (precision/recall/F1 of the affected
set), `false_alarm` (episodes, minutes, per hour), `top1_vs_chance` (binomial p-value).

**Definitions.**
- Fault window `[a, b]`; detection window `[a, b + grace]` (the mapper may be a little late).
- An incident is **localised** on a fault when its top-3 candidates, its affected set, or its root touch
  the true root or any service that depends on it ("an incident that is about this fault").
- **Detected**: some snapshot in the detection window holds a localised incident.
- **Delay**: first such snapshot minus `a`, in seconds (never negative).
- **Preexisting**: the incident started more than 2 s before the fault, so the delay is not meaningful.
- **Settled ranking**: the last snapshot before healing (`ts <= b`) that still has a localised incident.
  If there is none, the first detecting snapshot is used.
- **Top-1 / Top-3**: the true root is first / among the first three candidates of the settled ranking.
- **Reciprocal rank**: `1 / rank` (0 when missing); MRR is the mean over detected faults.

**Steps.**
1. Drop faults whose injection failed (not done in the Python, since the ledger is given clean).
2. For each fault pick the snapshots in its detection window and the localised incidents.
3. Find the first detecting snapshot (delay), the settled snapshot (ranks).
4. Compare the predicted affected set (minus the root) with the services that depend on the root:
   `precision = hits / predicted`, `recall = hits / expected`, `F1 = 2PR / (P + R)`.
5. Guess the fault family from the evidence tokens on the named root (`infer.py`, section 3).
6. False alarms: group incident snapshots into episodes by incident id (start to end). An episode that
   touches no detection window counts as one false alarm. Time of a covered incident that runs past the last
   covering window is added to the false-alarm minutes. `per_hour = episodes / observed hours` after warm-up.
7. Aggregate with Wilson intervals; compare top-1 with random guessing using the exact binomial test.

**Formulas.**
- `top1 rate = top1 hits / detected faults` (not divided by all faults: naming only makes sense once detected).
- Chance level of one fault = `1 / number of candidates`; the test uses the mean chance `p0` over faults:
  `P(X >= k) = sum_{i=k..n} C(n,i) p0^i (1-p0)^(n-i)`.
- Delay quantile: sort, then `s[lo] + (s[hi] - s[lo]) * frac` at position `(n - 1) * q`.

**Worked example** (the hand-made ledger in `_demo_data()`: chain web -> api -> db plus a cache; snapshots every 5 s
for 20 minutes). f1 is a crash of db: the mapper opens an incident 5 s later with db first. f2 is a brownout of api: noticed after 10 s but
web is ranked first and api second. f3 is a pause of cache: never noticed. At minute 15 a stray incident appears with no fault around. Real output:

```
f1 crash     detected=True  delay=5.0 rank=1 top1=True family guess=down
f2 brownout  detected=True  delay=10.0 rank=2 top1=False family guess=None
f3 pause     detected=False delay=None rank=None top1=False family guess=None
detected 67% of 3 (Wilson 0.21-0.94); top-1 50% of detected; median delay 7.5 s
false alarms: 1 episode(s) in 0.33 h = 3.0 per hour
```

Check by hand: 2 of 3 detected = 67%, and with only three faults the 95% interval is wide (21% to 94%).
Of the 2 detected, 1 is top-1 = 50%. Median of 5 s and 10 s is 7.5 s. One false alarm in 1195 s of observed time is about 3 per hour.
f2's family guess is `None` because the evidence is only collected from incidents whose root equals the true root (web is not api).

**Parameters.**
- `grace_sec`: bigger counts later detections as good, but also hides more false alarms inside the windows.
- `warmup_sec`: ignores the start of the run while baselines form (incidents there say "not ready", not "cried wolf").

**Edge cases.**
- No detected faults: ranks, delays and top-1 are `nan` or 0 rather than crashing; Wilson with n = 0 gives `nan`.
- A mapper that raises one huge incident covering the whole run is not counted as a false alarm for the stretch that overlaps a fault window, but any time beyond the last window is still added to `minutes`.
- `preexisting` marks incidents that were already open, so a delay of 0 is not mistaken for a very fast detection.
- Empty prediction versus empty truth gives precision 1, otherwise 0.

**Left out compared with the TS:** parsing the ledger, snapshots and traffic log; user-impact analysis from the traffic generator; observed
cascade and pre-warning; calibration of the at-risk list; confusion matrices; the larger research block.

**Mirrors:** `server/algorithms/evaluation/score.ts`.

---

## 2. Statistics toolbox (`stats.py`)

**Purpose.** Say how much a percentage measured on few faults can be trusted, and whether a result beats luck.

**Wilson interval (the one used most).**
- Inputs: `k` successes out of `n`, `z = 1.96` for 95%. Output: `p`, `lo`, `hi`.
- Formula: `p = k/n`, `d = 1 + z^2/n`, `c = p + z^2/(2n)`, `m = z * sqrt(p(1-p)/n + z^2/(4n^2))`, interval `[(c - m)/d, (c + m)/d]` clipped to `[0, 1]`.
- Why not `p +- z*sqrt(p(1-p)/n)`? At `p = 0` or `1` it collapses to zero width and claims certainty after 10 trials. Wilson does not.
- Worked example (real output):

```
wilson(17, 34) -> p=0.500  95% interval 0.341 to 0.659
wilson(33, 34) -> p=0.971  95% interval 0.851 to 0.995
wilson(0, 10)  -> p=0.000  95% interval 0.000 to 0.278
```

So "50% of 34 faults" really means somewhere between 34% and 66%, while "97% of 34" means at least about 85%. Even
zero out of ten leaves room up to 28%.

**Moments (`moments`).** Mean, sample sd (divides by n - 1), skewness `mean(((x - m)/s)^3)` and excess kurtosis
`mean(((x - m)/s)^4) - 3` with the population `s`. Skew tells whether delays have a long tail; excess kurtosis 0 is a normal curve.
Example for `[1, 2, 3, 4, 10]`: mean 4.0, sd 3.54, skew 1.14, kurtosis -0.21. Skew and kurtosis return `nan` for too few points or zero spread.

**Ranks, Pearson, Spearman, p-value.** `ranks` gives 1-based ranks with ties sharing the average
(`[10, 20, 20, 30] -> [1, 2.5, 2.5, 4]`). Pearson is covariance over the product of spreads. Spearman is the Pearson correlation of
the ranks, so it catches any steadily rising or falling relation and ignores outliers. `corr_p(r, n)` is a two-sided
p-value from `t = r * sqrt((n - 2) / (1 - r^2))` with a normal-tail approximation (fine for n >= 8). Example:
`spearman([1,2,3,4,5], [2,1,4,3,5]) = 0.8`. Demo use: does detection delay grow with fault duration?

**Bootstrap (`bootstrap_ci`).** Resample the outcomes with replacement `iters` (2000) times, take the mean each time, sort, and
read the 2.5% and 97.5% points. No formula assumptions. Example (20 hits, 14 misses): mean 0.588, interval 0.441 to 0.735.
The seed (7) makes it repeatable; the generator is mulberry32, bit-for-bit the same as in the TS.

**Stratified k-fold (`k_fold`).** Splits the per-fault outcomes into k groups, keeping each fault class evenly spread, and reports the
accuracy of each group, its mean and sd. Nothing is trained: the mapper's rules are fixed, so this only shows how much the figure moves between disjoint
subsets of faults. (The Python shuffles with Fisher-Yates; the TS sorts with a random comparator, so group members can differ though sizes match.)

**Exact binomial test (`binom_upper`).** `P(X >= k)` for `X ~ Bin(n, p)`, summed term by term with logarithms to avoid overflow. Used as: if the
mapper picked one candidate at random, how likely is it to get at least this many top-1 hits? Example: 20 hits of 34 with chance 1/3 gives p = 0.002, very unlikely by luck.

**Cohen's kappa (`kappa`).** `(po - pe) / (1 - pe)` on a square confusion matrix: observed agreement beyond what the marginals alone would give by chance.
`[[8,2],[1,9]]` gives 0.70. A perfect diagonal gives 1, an independent matrix gives 0.

**AUC (`auc`).** Area under the ROC curve via the rank-sum identity: `(sum of positive ranks - n_pos(n_pos+1)/2) / (n_pos * n_neg)`. The probability that a random
positive scores above a random negative. Example `auc([.1,.4,.35,.8],[0,0,1,1]) = 0.75`.

**Parameters and edge cases.** `iters`, `seed`, `k`, `z`. Empty input gives `nan`; fewer than 3 points gives `nan` for correlation; `p` is clamped
at 1e-12 inside logarithms so p = 0 or 1 does not crash.

**Mirrors:** `server/algorithms/evaluation/stats.ts` (and `wilson`, `quantile`, `auc` from `score.ts`).

---

## 3. Inferring the fault family (`infer.py`)

**Purpose.** The "output matches input" check: the injector applied a fault class; the mapper never knew. Does the evidence the mapper collected
on its named root look like the evidence that class leaves behind?

**Inputs.** A list of evidence tokens like `"latency"` or `"container-health:container-paused"`. **Output.** One of
`down`, `frozen`, `slow`, `memory`, `isolated`, or `None`.

**Families.** crash, stop, crash-loop -> down; pause -> frozen; brownout, flap -> slow; memory -> memory; partition -> isolated.

**Steps.** Checked in this order, first match wins (most specific first):
1. no evidence -> `None`
2. `container-health:container-paused` -> frozen
3. `container-health:container-network-detached` -> isolated
4. `container-health` or `restarts` -> down
5. `memoryPercent` -> memory
6. `silence` -> isolated if there is also `requestRate` or `networkRxRate`, else frozen
7. `requestRate` with network traffic but no `latency` and no `errorRate` -> isolated
8. `latency`, `errorRate`, `cpu` or `cpuThrottledPct` -> slow
9. any traffic signal -> isolated, otherwise `None`

**Worked example (real output):**

```
['container-health:container-paused']              -> frozen
['restarts', 'container-health']                   -> down
['memoryPercent']                                  -> memory
['latency', 'errorRate', 'cpu']                    -> slow
['requestRate', 'networkRxRate']                   -> isolated
['silence']                                        -> frozen
[]                                                 -> None
```

**Edge cases.** A token matches `name` exactly or `name:reason`, never a longer name that merely starts with it. Priority order matters: a crashed container
also loses traffic, but the container fact wins, so it is called `down`, not `isolated`.

**Mirrors:** `server/algorithms/evaluation/infer.ts`.

---

## Questions an evaluator may ask

**1. Why score against a ledger the mapper never sees?**
So the mapper cannot be tuned to the test, and the truth does not depend on the mapper's opinion. The ledger is read only after the run.

**2. What counts as "detected"?**
An incident in the window `[a, b + grace]` whose top-3 candidates, affected set or root include the faulted service or something that
depends on it. Grace (60 s) allows for a slightly late but still relevant alarm.

**3. Why is top-1 computed only over detected faults?**
Naming the root only makes sense when something was raised. We also report the version over all faults, so nothing is hidden.

**4. Why Wilson and not the textbook interval?**
Our counts are small (34 faults) and often near 0 or 100%. The textbook interval collapses at the extremes; Wilson stays honest.

**5. How do you know top-1 is not luck?**
The exact binomial test compares the hit count with random picking among the mapper's candidates (chance is `1 / candidates`).

**6. What is a false alarm and why per hour?**
An incident episode that overlaps no fault window. Per hour of observed time lets runs of different length be compared and matches how an operator feels noise.

**7. Why Spearman instead of Pearson for delay vs duration?**
Delays are skewed with outliers and the relation need not be a straight line. Ranks make it robust.

**8. Is the bootstrap reproducible?**
Yes. A seeded generator (mulberry32, seed 7) drives the resampling, so the same data always gives the same interval.
