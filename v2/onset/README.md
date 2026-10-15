# v2/onset: change-point onset for earlier detection and root cause

This module asks whether knowing WHEN each service changed helps. In a cascade the source changes first and its callers
follow seconds later, so an accurate onset time carries causal information. We test two uses: ranking the root cause by
temporal precedence, and detecting faults earlier with change-point alarms on the raw metrics.

Everything is causal: a decision at a moment uses only readings up to that moment. Settings were chosen on the synthetic
tuning runs (`tune`, `tune2`); the held-out synthetic runs (`test`) and the real recorded runs (`real`) are each scored
once, with the v1 event-level evaluation from `server/algorithms/learning/evaluate.ts` so the numbers are comparable with v1.

## Methods

### Change-point detectors (`changepoint.ts`)

Per service and per metric (positive metrics on a log scale), run online, one value at a time:

1. **Two-sided CUSUM.** Keep running sums of how far each reading sits above and below a robust baseline (median and MAD of
   the recent past). `S+ = max(0, S+ + (x - mu) - k)` and `S- = max(0, S- - (x - mu) - k)`, with slack `k` in MAD units.
   A change is declared when `S+` or `S-` passes a threshold `h`; the onset is back-dated to where the sum left zero.
2. **Page-Hinkley.** The one-sided cumulative deviation from the running mean minus a drift term, with the running minimum
   tracked; a change is declared when the gap `PH - min` passes `lambda`. Cheaper than CUSUM and it was the chosen detector.
3. **Bayesian online change-point detection** (Adams and MacKay 2007). A run-length posterior updated with a Normal model
   and a constant hazard `1/H`; a change is the run length collapsing to zero. The most principled, the most expensive, and
   on this data no more accurate than Page-Hinkley.

Each detector reports, per service: whether it is currently changed, the onset step, the magnitude in MAD units, and which
metric moved.

### Onset ranking (`rca.ts`)

Keep the v1 hybrid alarm, then re-rank: container facts first, then, among services that are currently anomalous and
connected in the observed edge graph, weight earlier onsets higher. Forms tried: multiplicative decay by onset delay,
onset-rank fusion with the walk, and "earliest onset in each connected anomalous component". The chosen form is the
earliest-onset rule with an age cap, filtered to services the v1 engine already calls anomalous.

### Earlier detection

An engine whose alarm is the v1 hybrid alarm OR a persistent change-point alarm (magnitude over a threshold, held for two
readings). We measure detection rate, the paired change in median detection delay, false alarms per hour and alarm time.

## Results

### Earlier detection (the real win)

| Set | Engine | Detected | Median delay | False alarms/h |
|---|---|---|---|---|
| real (62 faults) | v1 hybrid | 90% | 10.5 s | 6.2 |
| real | v1 ranking + change-point alarm | 95% | 4.9 s | 7.7 |
| test (178) | v1 hybrid | 92% | 8.2 s | 0.8 |
| test | v1 ranking + change-point alarm | 93% | 8.2 s | 0.6 |

On the real benches the change-point alarm roughly halves the median detection delay (10.5 s to 4.9 s, paired over 56
faults) and lifts detection from 90% to 95%, for about 1.5 extra false alarms per hour. On the synthetic benches the gain
is tiny, because the synthetic faults are abrupt and v1 already catches them within one window; the real benches contain
gradual brownouts and memory leaks where an early change-point helps.

### Onset ranking (net neutral)

Re-ranking by onset precedence trades fault classes rather than winning overall, which matches the v1 finding that onset
ordering did not beat the random walk:

| Set | Ranking flips vs v1 (fixed / broken) |
|---|---|
| tune | 6 fixed (memory, latency, brownout), 1 broken |
| test | 3 fixed (brownout, latency), 3 broken (brownout) |
| real | 0 / 0 |

Precedence helps on gradual faults where the cascade is visible in the timing, and hurts when onset estimates on quiet
services are noisy. We therefore keep the random walk as the ranker and report onset precedence as a studied alternative.

## Files

```
changepoint.ts   online CUSUM, Page-Hinkley and Bayesian online change-point detection
rca.ts           onset-precedence rankers and the change-point detection engine
run.ts           picks settings on tune, scores test and real once, writes results.json
onset.test.ts    unit tests (a step change is found near its true point; a flat series raises nothing; earliest onset wins)
results.json     the full grids and the chosen settings
```

## Run

```
node server/node_modules/tsx/dist/cli.mjs v2/onset/run.ts
node server/node_modules/tsx/dist/cli.mjs --test v2/onset/onset.test.ts
```

## Limits

- The delay improvement is measured on 56 alarmed real faults; it is a strong signal but a small sample.
- Change-point alarms add false alarms; the budget-calibrated detector from v1 still decides the alarm in the shipped engine.
- Onset estimates on near-idle services are noisy, which is why precedence ranking is net neutral.
