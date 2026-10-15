# Model algorithm: the per-target alarm threshold

One file, one algorithm: `target_model.py`, a short version of `server/algorithms/model/TargetModel.ts`.
It answers: **"on this system's own healthy history, how high does the score normally go, so that anything above that is unprecedented for this system?"**

Python 3 standard library only. It reuses `detection/scoring.py` (which in turn uses `detection/features.py`).

## Target model (calibrating the threshold)

**Purpose.** A scorer (learned weights or hand rules) gives each service a number. Whether that number is "high" depends on the system: a noisy architecture normally produces bigger scores than a quiet one. So the model replays the system's recent fault-free history and learns where the alarm line must sit for *this* architecture.

Two parts, as in the original design:
- **Shared weights / prior:** learned offline on several systems, give the scorer and a starting threshold (the `prior`). Optional; with no weights the hand rules are used and there is no prior.
- **Local calibration:** trained here, on this target's own baseline, every time it is trained.

**Inputs.**
| Name | Meaning |
|---|---|
| `nodes` | list of services `{id, name, state}` |
| `history(id)` | snapshots of that service, oldest first, each with a `timestamp` (epoch ms number or ISO string) |
| `edges` | `(caller, callee)` pairs |
| `weights` | `None` (use rules) or `{mean, std, w, b, threshold}` |
| `need_sec` | seconds of clean baseline needed before the model is trusted |
| `exclude(ts_ms)` | optional, true for moments that must not count (an incident was open, so the system was not healthy) |

**Outputs.** A dict: `state` (`learning` or `ready`), `baseline_sec`, `need_sec`, `moments`, `services`, `scorer` (`learned` or `rules`), `threshold`, `noise_ceiling`, `prior`.

**Steps.**
1. Choose the scorer: learned if weights exist, else rules. `prior = weights.threshold` or `None`.
2. Collect every distinct timestamp across all services, sorted. These are the "moments".
3. If there are more than 150 moments, keep every `stride`-th one: `stride = ceil(moments / 150)`. This bounds the training cost.
4. For each kept moment `t` (skipping those where `exclude(t)` is true): count how many samples each service had at `t`. If even the best-covered service has fewer than 14, skip it (warm-up: nobody has a past yet).
5. Score every service at `t` using only the history up to `t` (no peeking at the future). Keep the **highest** score of the moment, `max_score[t]`.
6. If fewer than 3 moments were kept, return the model still in `learning` with `threshold = prior or 0`.
7. **Baseline span.** Take the gaps between consecutive kept moments. The typical gap is the median gap. Add up only the gaps that are at most `3 *` typical (bigger gaps are outages, not healthy time). Divide by 1000 and round: `baseline_sec`.
8. **Persistence.** `persistent[i] = min(max_score[i], max_score[i-1])`. Sort the list.
9. **Ceiling.** If there are at least 100 persistent values, take the value at index `floor(0.99 * (n - 1))` (this trims the top 1%); otherwise take the largest.
10. `threshold = max(prior or 0, noise_ceiling)`.
11. `state = "ready"` if `baseline_sec >= need_sec`, else `"learning"`.

**Formulas.**
```
stride          = max(1, ceil(n_moments / 150))
typical_gap     = median(gaps)
baseline_sec    = round( sum(gap for gap in gaps if gap <= 3 * typical_gap) / 1000 )
persistent[i]   = min(max_score[i], max_score[i-1])
noise_ceiling   = sorted(persistent)[ floor(0.99 * (n-1)) ]   if n >= 100
                = max(persistent)                              otherwise
threshold       = max(prior, noise_ceiling)
```

**Worked example** (computed by running the code). Two services, `web` calls `db`, 80 healthy samples each, 5 seconds apart, small random noise on cpu and network. Rules scorer, no weights, `need_sec = 300`:
```
state          ready
baseline_sec   330
moments        67
scorer         rules
threshold      0.35719402407311607
noise_ceiling  0.35719402407311607
prior          None
```
Why 67 moments: 80 samples minus the first 13 (a service needs 14 samples before it can be judged, so scoring starts at the 14th sample, at 65 s). The 67 moments span 65 s to 395 s, which is 66 gaps of 5 s = 330 s, so `baseline_sec = 330 >= 300` and the model is `ready`.

The first few moment scores (highest score among the services at that moment) were:
```
t = 65 s: 0.0411   70 s: 0.1795   75 s: 0.1532   80 s: 0.0729   85 s: 0.0313   90 s: 0.0
```
Their persistent values are `min(this, previous)`: `0.0411, 0.1532, 0.0729, 0.0313, 0.0` (for 70 s to 90 s). A one-moment bump such as the 0.1795 does not count by itself, because the previous moment was only 0.0411. Over all 66 persistent values (fewer than 100, so no trimming) the largest is 0.3572, the noise ceiling and, with no prior, the threshold.

Same data with learned weights whose prior threshold is 0.4:
```
scorer         learned
threshold      0.4
noise_ceiling  0.05701209228075431
prior          0.4
```
The system is quiet (ceiling 0.057), so the cross-system prior 0.4 stays as the threshold.

Same data with `need_sec = 3600`: still 330 s of baseline, so `state = learning` (the threshold is computed but not yet trusted). With only 12 samples per service: `moments = 0`, `state = learning`, `threshold = 0`.

**Parameters (`PARAMS`).**
| Name | Value | What changing it does |
|---|---|---|
| `min_history` | 14 | A service needs this many samples before it is judged: 12 for its own baseline plus the 2 judged samples. Lower = earlier scores but noisier. |
| `max_moments` | 150 | Cap on how many moments are scored. Lower = faster training, coarser threshold. |
| `trim_min_moments` | 100 | Trimming only happens with at least this many persistent values. |
| `trim_quantile` | 0.99 | Share kept. 0.99 tolerates a baseline that is up to 1% faulty. Lower trims more and makes the threshold lower. |
| `outage_gap_factor` | 3 | A gap above 3 typical gaps is an outage (collector or SSH down) and is not counted as baseline time. |
| `need_sec` (input) | e.g. 300 | Longer = a more trustworthy threshold, but the model stays `learning` for longer. |

**Edge cases and why.**
- *Warm-up moments are skipped,* because with fewer than 14 samples no z-score can be computed and every score would be an artificial 0.
- *Fewer than 3 usable moments:* return `learning` with the prior (or 0) rather than guess a threshold from almost nothing.
- *Persistence (`min` with the previous moment)* copies how real alarms are raised (two consecutive cycles must agree), so the baseline is measured the same way alarms are judged.
- *A fault must last 3 samples to matter in the baseline:* two samples to fire the detector, then two moments in a row to survive the `min`. A single bad sample leaves the ceiling unchanged.
- *Trimming the top 1%* (with 100+ moments) stops one unnoticed fault inside the baseline from setting the bar.
- *The prior is a floor,* so a quiet architecture keeps the threshold learned across systems, and a noisy one raises it, never lowers it.
- *Outage gaps are not baseline time,* so a collector that was down for hours cannot make a short baseline look long.
- *`exclude`* removes moments while an incident was open and during its recovery, because the system was not healthy then.
- *No history at all:* `moments = 0`, `state = learning`.
- Moments are thinned by a stride on long histories, so training cost stays bounded.

**Left out of the Python version:** the `trainedAt` timestamp and the record/type plumbing. The per-moment "no peeking" slicing is done with a binary search (`bisect`), as in the original.

**Mirrors:** `server/algorithms/model/TargetModel.ts`

---

## Questions an evaluator may ask

**1. Why not use one fixed threshold for every system?**
Systems differ. A noisy architecture produces larger scores even when healthy, so one fixed line would give constant false alarms there and miss faults on a quiet system. We measure how high the score goes on the system's own healthy history and put the line above that.

**2. What does "unprecedented" mean here?**
The threshold is the highest persistent score the system produced while healthy (after trimming 1% on long baselines). A score above that is, by construction, higher than anything seen in the baseline.

**3. What is the shared prior, and why use `max(prior, ceiling)`?**
The prior is a threshold learned offline across several systems. It is the floor: a quiet system keeps it, a noisy system can only raise it. This prevents a very calm baseline from producing a tiny threshold that then fires on normal behaviour.

**4. What if the baseline already contains a fault?**
Two protections. First, `exclude` can remove moments where an incident was open. Second, with 100 or more moments the top 1% of persistent scores is trimmed, so one unnoticed fault does not set the bar. A short baseline (under 100 moments) is not trimmed, so a sustained fault there would raise the threshold.

**5. Why `min(score now, score before)`?**
Alarms need two consecutive cycles to agree. Calibrating on the same "persistent" score means the threshold is set for exactly the quantity the alarm later compares against it.

**6. When is the model trusted?**
When the clean baseline (gaps added up, outages ignored) spans at least `need_sec`. Until then the state is `learning` and, in the original system, only container facts raise incidents.

**7. Why score only up to 150 moments?**
Each moment re-scores every service, which is the expensive part. Thinning a long history with a stride keeps training time bounded and loses little, because neighbouring moments are almost identical.

**8. Does it look into the future when it replays history?**
No. At each moment only the samples with a timestamp at or before that moment are given to the scorer, found with a binary search. That mirrors what the live system could have known then.
