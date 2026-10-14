# Detection algorithms

This folder answers one question: **"is a service behaving abnormally right now, and how likely is it to be the cause?"**
Everything here is plain Python 3 (standard library only). Each file is a short version of a TypeScript file in `server/algorithms/detection/` with the same numbers and the same results on the same input.

How the pieces fit together:

```
log lines ---> request_stats ---+
docker state -> container_facts +--> features (z-score per signal, uses anomaly_detector)
metric history -------------------+          |
                                             v
                                   scoring (learned or rules) --> per-service score
thresholds (alarm rules) ----> anomaly_detector (incident rules, separate from the scoring path)
```

Important design point: the **incident rules** (`thresholds` + `anomaly_detector`) are fixed rules on live metrics. They need no training, so they work on a service that started five minutes ago. The **scoring** path (`features` + `scoring`) is the learned/ranking path used to find the root cause.

Data used everywhere: a *snapshot* is a dict like `{"cpu": 12.0, "memory_percent": 40, "request_rate": 5, "p95_latency": 20, "request_count": 30, "timestamp": ...}`. A *history* is a list of snapshots, oldest first. A missing key means "unknown", never 0.

---

## 1. Thresholds (`thresholds.py`)

**Purpose.** Keep every tunable number of the incident rules in one dictionary, and let a user override them safely.

**Inputs.** `DEFAULT_THRESHOLDS` (15 numbers) and an optional `patch` dict of overrides.
**Outputs.** A new dict with the overrides applied.

**Steps.**
1. For each known key, read the patch value with `to_number` (accepts numbers and numeric strings; rejects `None`, `True`, `""`, `"abc"`, NaN, infinity).
2. If it is not numeric, skip it: the old value stays.
3. Clamp the number into `[low, high]` from `LIMITS`.
4. Return the merged copy (the base dict is never changed).

**Formula.** `new = min(max(value, low), high)`

**Worked example** (actual output of `python3 algorithms/detection/thresholds.py`):
```
z_score_anomaly      default=3.5    edited=4.2
z_score_high         default=5.0    edited=15
silence_samples      default=3      edited=3
min_delta_percent    default=5      edited=5
```
`"4.2"` was a numeric string so it was accepted. `999` for `z_score_high` was clamped to 15. `None` and `True` were ignored.

**Main parameters (defaults).**
| Name | Default | Effect of raising it |
|---|---|---|
| `min_history_samples` | 12 | judge a service later (safer cold start) |
| `z_score_anomaly` | 3.5 | fewer alarms, slower detection |
| `z_score_high` / `z_score_critical` | 5.0 / 8.0 | harder to reach HIGH / CRITICAL |
| `min_delta_percent` | 5 | ignores bigger z-scores that moved only a few points |
| `absolute_high_percent` / `absolute_critical_percent` | 70 / 85 | cpu/memory limit before it is HIGH / CRITICAL by itself |
| `flatline_std_dev` | 0.001 | what counts as a "flat" baseline |
| `flatline_delta_percent` / `flatline_critical_percent` | 30 / 80 | jump size on a flat baseline / value that makes it CRITICAL |
| `silence_samples` | 3 | how many quiet samples before "frozen" |

(`critical_services_for_critical`, `monitoring_gap_share`, `explain_away_gamma`, `cascade_edge_probability` belong to the incident and root-cause layers and are only stored here.)

**Edge cases.** A `None` override must not become the lowest limit, because that would be the most sensitive setting and raise an alert storm, so it is ignored. `bool` is a subclass of `int` in Python, so it is rejected explicitly. A `patch` that is not a dict is ignored.

**Mirrors:** `server/algorithms/detection/thresholds.ts`

---

## 2. Container facts (`container_facts.py`)

**Purpose.** Reduce the messy docker state of a container to one fact.

**Inputs.** A node dict: `name`, `state`, `status_text`, `exit_code`, `network_detached`, `vanished`, `health`.
**Outputs.** `"down"`, `"paused"`, `"restarting"`, `"detached"`, `"benign"` or `None` (running fine or unknown).

**Steps.**
1. Lowercase the state and keep its first word (`"exited (137)"` becomes `"exited"`).
2. Running but attached to no network: `detached`.
3. `paused` / `restarting`: same name.
4. `created` (never started): `benign`.
5. `exited`, `dead`, `removing`, `not found` or vanished: `benign` if it is a load generator or exited with code 0, otherwise `down`.
6. No state at all but the source marked it critical: `down`.
7. Anything else: `None`.

**Formula.** The exit code is the explicit number if present, else the digits in `exited \((\d+)\)`.

**Worked example** (output of the demo):
```
api          state='running'                    -> None
api          state='exited (137)'               -> down
migrate      state='Exited (0) 2 minutes ago'   -> benign
traffic-gen  state='exited'                     -> benign
db           state='paused'                     -> paused
cache        state='running'                    -> detached
web          state=''                           -> down
web          state='created'                    -> benign
```

**Parameters.** The `LOAD_GENERATOR` name pattern (traffic, locust, k6, jmeter...). Adding a word makes more containers "not part of the judged system".

**Edge cases.** Exit code 0 is a finished job, not a crash. A load generator that is switched off is not a fault. A name like `trafficker-api` does not match, because the pattern needs `-`/`_` or string edges around the word.

**Mirrors:** `server/algorithms/detection/containerFacts.ts`

---

## 3. Request statistics (`request_stats.py`)

**Purpose.** Compute request count, error share and latency percentiles from a service's JSON log lines.

**Inputs.** A list of log lines; the window length in seconds.
**Outputs.** `request_count, request_rate, error_count, error_rate, latency, p50, p95, p99`.

**Steps.**
1. For each line, take the text from the first `{` to the last `}` and parse it as JSON; skip lines that fail.
2. Accept the service format `{"msg":"request","status":200,"ms":4}` or the nginx format `{"status":"200","request_time":"0.002"}` (seconds times 1000).
3. Count the request; if `status >= 500` it is an error; keep the latency if it is a number.
4. `summarize` sorts latencies and computes the statistics. `merge_windows` adds several windows together.

**Formulas.**
- `request_rate = count / max(1, window_sec)`
- `error_rate = errors / count` (None when `count = 0`)
- `latency = mean(ms)`
- percentile `p`: `sorted_ms[min(n-1, floor(p * (n-1)))]`
- throttled percent = `throttled_delta / periods_delta * 100`

**Worked example** (demo output; 5 lines, one is not JSON, so 4 requests in 60 s):
```
window : {'count': 4, 'errors': 1, 'ms': [4.0, 6.0, 120.0, 2.0]}
summary: {'request_count': 4, 'request_rate': 0.07, 'error_count': 1, 'error_rate': 0.25, 'latency': 33.0, 'p50': 4.0, 'p95': 6.0, 'p99': 6.0}
empty  : {'request_count': 0, 'request_rate': 0.0, 'error_count': 0, 'error_rate': None, 'latency': None, 'p50': None, 'p95': None, 'p99': None}
throttled %: 30.0
```
Sorted latencies are `[2, 4, 6, 120]`, so p50 is index `floor(0.5*3) = 1` giving 4, p95 is index `floor(0.95*3) = 2` giving 6, mean = 132/4 = 33. Throttled: (50-20)/(200-100) = 30%.

**Parameters.** The error line is `status >= 500` (client errors like 404 are not service faults). The window length changes the rate denominator; a longer rolling window gives enough requests for a stable p95.

**Edge cases.** An empty window is a real zero for the rate (traffic stopped) but unknown (`None`) for error rate and latency, so we never invent a "0 ms". A request with no latency still counts. Counters that go backwards (container restart) give `None` for throttling; no new periods gives 0.

**Mirrors:** `server/algorithms/detection/requestStats.ts`

---

## 4. Anomaly detector (`anomaly_detector.py`)

**Purpose.** Decide whether a service has an anomaly by comparing each metric with that service's own recent past, using a robust z-score. Also covers hard container evidence, restarts, absolute cpu/memory limits and silence.

**Inputs.** A node dict, its history, optional live values, thresholds.
**Outputs.** A list of records `{metric, observed, baseline, spread, z, reason, severity, source, evidence}`. `evidence` is `"own"` (about the service itself), `"symptom"` (can be inherited from a broken dependency) or `"hard"` (container fact).

**Steps for each metric.**
1. Skip if the metric needs requests (latency, error rate) and either of the last 2 samples has fewer than 5 requests.
2. Build the series, drop unknown values. Need at least `min_history_samples + 2 = 14` values, else say nothing.
3. Baseline = all but the last 2; recent = the last 2. The judged samples are never in the baseline.
4. Transform positive metrics: `x' = ln(max(x,0) + unit)` (so only ratios matter).
5. Centre `c` = median of the baseline. Spread `s` = the largest of `1.4826 * MAD`, `(90% deviation) / 1.645`, and the metric's `floor`.
6. Self-healing: samples that are part of a run of 2+ with `z >= 4` are removed from the baseline, then `c` and `s` are recomputed.
7. Noise shrink: `shrink = max(1, q99.5(healthy z) / 3)`.
8. `z = max(0, direction * (x' - c) / s) / shrink`, capped at 50. `direction` is +1 when rising is bad, -1 when falling is bad.
9. Anomaly only if **both** recent z are `>= 3.5`, and (for cpu/memory/throttle) the value moved at least `max(0, 5)` points from the baseline centre.
10. Severity: CRITICAL if `z >= 8` or (cpu/memory and value `> 85`); HIGH if `z >= 5` or (cpu/memory and value `> 70`); otherwise MEDIUM.
11. If the statistical test found nothing, the **absolute rule**: cpu, memory or throttle `> 85` in both recent samples is CRITICAL (a service always at 90% cpu has no headroom).

**Other checks.**
- Container fact: `benign` stops everything for that node; `down/paused/detached` give a CRITICAL record, `restarting` a HIGH one.
- Restart: `restart_delta > 0` in the last 2 samples gives a HIGH record.
- Silence, method A (requests are counted): the last `k=3` samples all have rate 0; `lambda` = median past rate; `expected = lambda * spacing_sec * k`. Needs `expected >= 5` and the quiet run at least `2 *` the longest earlier quiet run. HIGH, or CRITICAL when `expected >= 20`.
- Silence, method B (no request counts): activity = cpu `> 0.5` or any network bytes. `q` = share of active past samples; needs `q >= 0.6`. `z = (k*q - observed) / sqrt(max(k*q*(1-q), 1e-6))`, capped at 50. Fires when the service is completely quiet and `z >= 3.5`; CRITICAL if `z >= 8`.
- `calculate_z_score`: a plain two-sided median/MAD check with the flat-baseline rule (if the spread is under 0.001, a jump above 30 points in both samples is the anomaly; CRITICAL above 80).

**Worked example** (computed by running the code). Baseline cpu = `[10,11,10,12,10,11,10,9,10,11,10,12,10,11]`, then recent = `[40, 42]`.
```
centre c = 2.3514 (median of ln(x + 0.5))  -> exp(c) - 0.5 = 10.0 (in original units)
1.4826 * MAD = 0.0674 ; tail term = 0.0608 ; floor = 0.15  -> spread s = 0.15 (floor wins)
ln(40 + 0.5) = 3.7013 ; (3.7013 - 2.3514) / 0.15 = 9.0
robust_score z = [8.9995, 9.3209], noise_shrink = 1
detect_anomalies -> cpu CRITICAL, observed 42, baseline 10.0, z 9.32
```
Other runs on the same series: recent `[40, 10]` (one spike, second sample normal) gives `[]` because of persistence; only 10 baseline samples before `[40, 42]` gives `[]` (cold start).

Silence examples: 27 busy samples then 3 with cpu 0 and no network gives `silence CRITICAL` (z capped at 50, because `q = 1` makes the denominator tiny). 57 samples at 4 req/s then 3 at 0 req/s (5 s apart) gives expected = `4 * 5 * 3 = 60`, so `silence CRITICAL` with z reported as 60. Flat baseline `[5]*20` with recent `[40, 90]` gives `flat-baseline-jump CRITICAL`.

**Parameters (`PARAMS`).**
| Name | Value | What changing it does |
|---|---|---|
| `mad_to_std` | 1.4826 | converts MAD to a standard deviation for normal data |
| `tail_quantile` / `tail_z` | 0.9 / 1.645 | spread respects heavy tails; protects a mostly flat series from exploding on one tick |
| `self_heal_z` | 4.0 | lower removes more history from the baseline |
| `healthy_quantile` / `healthy_z` | 0.995 / 3 | how strongly jumpy series are shrunk |
| `z_cap` | 50 | largest reported z |
| `min_requests` | 5 | fewer requests than this is not enough for p95 or error share |
| `silence_*` | 3 / 5 / 2 | history factor, minimum expected requests, gap factor |
| per metric `unit`, `floor` | e.g. cpu 0.5 / 0.15 | smallest change worth noticing, smallest allowed spread |

**Edge cases.** Not enough history gives no alarm (a service that just started must not alert). A missing reading is unknown, not 0. Median and MAD are used so a past spike cannot hide a new one. Old sustained incidents are dropped so a long fault never becomes "normal", but isolated spikes stay because they tell us how jumpy the series is. Both samples must agree so a single glitch is ignored. Low request counts skip latency/error checks. A small absolute move is ignored with `min_delta` (idle 0.05% to 2% cpu is not an incident). A mostly idle service going quiet is just idle (`q < 0.6`).

**Left out of the Python version:** ids, remembering when each anomaly first started, and reading the history from the metric store.

**Mirrors:** `server/algorithms/detection/AnomalyDetector.ts`

---

## 5. Features (`features.py`)

**Purpose.** Turn the metrics of every service at one moment into a vector of 18 numbers that a scorer can use.

**Inputs.** For each service: its node and history. Plus the call edges `(caller, callee)`.
**Outputs.** `{service id: [18 numbers]}` in the order of `FEATURE_NAMES`.

**Steps.**
1. For each of 8 signals (cpu, memory, throttle, netDrop, netRise, reqDrop, errRise, latRise) compute `z` with `robust_score` (same method as section 4). Take the **smaller** z of the last two samples (both must agree); return 0 if history is too short (needs 14 values) or the request count is too low.
2. `own` = largest z among cpu, memory, throttle. `sym` = largest z among the other five.
3. Container facts become 0/1 flags: down, paused, restarting (also if a restart happened in the last 2 samples), detached.
4. Build caller/callee lists from the edges, ignoring self-edges and edges whose caller is a datastore (db, cache, redis, kafka...) calling a non-store.
5. Neighbour features: the max and the mean of the callers' `sym`, and the max of the callees' evidence, where `evidence = max(own, sym, 10 * any container fact)`.
6. Squash every z with `lz(z) = ln(1 + min(max(z,0), 50))`.

**Formula.** `lz(z) = ln(1 + clip(z, 0, 50))`. Why: z of 50 is not 50 times worse than z of 1, and the log keeps one huge value from dominating a model.

**Worked example** (demo output): `web` has latency 20 ms, then 400 and 410 ms in the last two samples; `api` stays at 20 ms; `web` calls `api`.
```
web {'own': 0.23, 'symptom': 3.03, 'cpu': 0.23, 'latRise': 3.03, 'hasRequests': 1}
api {'callersSymptomMax': 3.03, 'callersSymptomMean': 3.03, 'hasRequests': 1}
```
(only non-zero features are printed). `lz = 3.03` means z of about `e^3.03 - 1 = 19.7`. The slowness is a *symptom* of `web`, and `api` sees its caller suffering, which is a clue that points to `api`.

**Parameters.** The `unit` and `floor` of each signal are the measurement resolution (for example 2000 bytes/s for network, 0.5 percentage points for cpu), not decision thresholds. `min_history` = 12. The cap of 50 limits z.

**Edge cases.** Short history gives all zeros. `noData` = 1 if there is no history or no cpu/network reading at all. A store that "calls" a service is the reverse view of a TCP connection, so the edge is ignored. With no callers or callees the neighbour features are 0.

**Mirrors:** `server/algorithms/detection/features.ts`

---

## 6. Scoring (`scoring.py`)

**Purpose.** Give each service one score: how likely it is the cause right now.

**Inputs.** The feature vectors, and optionally learned weights `{mean, std, w, b}`.
**Outputs.** `{service id: score}`; load generators are not judged.

**Steps (learned).** Standardise each feature, multiply by its weight, add the bias, apply the sigmoid.
**Steps (rules, used when no weights exist).** Take the larger of the service's own evidence and its symptoms not explained by a broken callee, then add 10 for any container fact.

**Formulas.**
- learned: `score = sigmoid(b + sum_j w_j * (x_j - mean_j) / std_j)`, with `sigmoid(z) = 1 / (1 + e^-z)` (std of 0 is treated as 1)
- rules: `score = max(expm1(own), expm1(symptom) - expm1(calleesEvidenceMax)) + 10 * max(down, paused, restarting, detached)`

`expm1(lz) = e^lz - 1` undoes the log squash, so the rule works in z units again.

**Worked example** (demo output):
```
api (own evidence z=9)         rules score = 9.00
web (symptom explained away)   rules score = 0.00
crashed container              rules score = 10.00
learned score for api: 0.811
```
`web` has a symptom z of 9, but its callee `api` has evidence 9, so `9 - 9 = 0`: the broken dependency explains it away. `api` keeps 9. A crashed container gets the +10 bonus. The learned example uses weight 1.5 on `own` and bias -2: `sigmoid(1.5 * 2.303 - 2) = sigmoid(1.454) = 0.811`.

**Parameters.** The weights (learned offline, not here). The container-fact bonus of 10 makes a hard fact outrank any statistical evidence.

**Edge cases.** The sigmoid is written in a form that does not overflow for large inputs. The score is never negative, because `own` is at least 0 and the max takes the larger term, so over-explaining a symptom just gives 0. Load generators (traffic, locust, k6) are skipped because they are not part of the system.

**Mirrors:** `server/algorithms/detection/scoring.ts`

---

## Questions an evaluator may ask

**1. Why median/MAD instead of mean/standard deviation?**
A single past spike moves the mean and inflates the standard deviation, which would hide the next anomaly. The median and MAD barely move. We multiply MAD by 1.4826 so it matches the standard deviation for normal data.

**2. Why a log scale?**
Because 100 ms to 200 ms is as bad as 1 s to 2 s. On the log scale equal ratios are equal distances, so one rule works for a quiet database and a busy API.

**3. Why must two samples agree?**
One sample can be a glitch. Requiring the last two both above `z >= 3.5` removes most false alarms at the price of one extra polling cycle of delay.

**4. What stops a long fault from becoming "normal"?**
Self-healing: runs of two or more samples with `z >= 4` inside the baseline are removed before the baseline is computed, so an old incident does not teach the detector that the faulty value is normal. Isolated spikes are kept because they describe normal noise.

**5. What if there is not enough history?**
We say nothing. Fewer than 14 values (12 baseline + 2 judged) means no z-score is computed, so a service that just started cannot alert on its first readings. Container facts still work immediately.

**6. How is a frozen (hung) service found? It sends no errors.**
By silence: a service that is normally active (cpu or network, or a counted request rate) and now shows nothing for 3 samples in a row. For request-counted services we ask how unlikely "no requests at all" is given the usual rate (about `exp(-lambda * W)`), and also require the silence to be twice as long as its longest earlier quiet gap.

**7. Why is a stopped container sometimes not a failure?**
Exit code 0 means the job finished cleanly, `created` means it never started, and load generators are started and stopped by people. Only a non-zero exit, a dead or vanished container, or a missing one is `down`.

**8. Why are the incident rules separate from the learned scorer?**
Rules need no training and work on a brand new service even when no model exists. Keeping them apart also means the models are never evaluated against alerts they raised themselves.
