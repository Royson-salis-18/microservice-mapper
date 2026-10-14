# Dependency graph algorithms (graph)

Folder: `algorithms/graph/`. Python 3, standard library only. Run the tests with
`python3 algorithms/graph/test_graph.py`.

The service map is a directed graph: edge `A -> B` means **A calls B**. These files decide
how strong each edge is, how failures spread over the graph, and whether the numbers we
publish contradict each other.

| File | Question it answers |
|---|---|
| `service_roles.py` | Is this service part of the monitoring stack? |
| `link_thresholds.py` | Is this link active, degraded or failed? |
| `edge_weights.py` | If B fails, how badly is A hit? (weight of the edge) |
| `cascade_engine.py` | Who fails next? What if X failed? How critical is each service? |
| `consistency.py` | Do the published numbers agree with each other? |

Order of use: `service_roles` -> `edge_weights` -> `cascade_engine` (and `rca/rca_engine.py` reads
the weights). `consistency` checks the results at the end.

---

## 1. Service roles (`service_roles.py`)

**Mirrors:** `server/algorithms/graph/serviceRoles.ts`

- **Purpose:** recognise monitoring services (grafana, jaeger, prometheus, opensearch, kibana, zipkin, tempo, loki, otel-collector, fluentd, logstash...).
- **Inputs:** a service id (`project:service`) or a name. **Output:** true / false.
- **Steps:** 1. take the part after `:`; 2. test it against a case-insensitive regex of monitoring names.
- **Why by name:** ports collide (:3000 is Grafana in one stack and an app frontend in another). Elasticsearch is excluded on purpose: it is often a real search backend.
- **Worked example (real output):**
```
shop:grafana       -> monitoring service: True
shop:orders        -> monitoring service: False
otel-collector     -> monitoring service: True
elasticsearch      -> monitoring service: False
shop:Jaeger-ui     -> monitoring service: True
```
- **Parameters:** the name list. Adding a name makes calls into it count as telemetry.
- **Mirrors:** `serviceRoles.ts`.

---

## 2. Link thresholds (`link_thresholds.py`)

**Mirrors:** `server/algorithms/graph/linkThresholds.ts`

- **Purpose:** classify a link by its measured error rate and latency.
- **Inputs:** `error_rate` (0..1), `latency_ms` (p95 if available, else mean). **Output:** `failed`, `degraded` or `active`.
- **Steps:** 1. if error rate >= 5% or latency >= 1000 ms: failed; 2. else if error rate >= 1% or latency >= 300 ms: degraded; 3. else active. Missing values count as 0.
- **Formula:** `failed if err >= 0.05 or lat >= 1000; degraded if err >= 0.01 or lat >= 300`.
- **Worked example (real output):**
```
error_rate=0.0, latency_ms=40 -> active
error_rate=0.02, latency_ms=120 -> degraded
error_rate=0.0, latency_ms=450 -> degraded
error_rate=0.06, latency_ms=50 -> failed
error_rate=None, latency_ms=None -> active
error_rate=0.0, latency_ms=1200 -> failed
```
- **Parameters:** `SLOW_MS=300`, `VERY_SLOW_MS=1000`, `ERROR_WARN=0.01`, `ERROR_CRITICAL=0.05`. Lower = more links flagged. The client colours use the same numbers so a link is never drawn calm while marked failed.
- **Edge case:** no measurement means no evidence of trouble (`active`).

---

## 3. Edge weights (`edge_weights.py`)

**Mirrors:** `server/algorithms/graph/EdgeWeights.ts`

### Purpose
Give every edge `A -> B` a number 0..1 for "if B fails, how badly is A hit". Before this, a rarely used cache counted as much as the database serving all the traffic.

### Inputs
Edges with `observed` / `declared` flags, `evidence_sources`, optional `metrics.request_rate`, `activity.samples_per_min` / `baseline_per_min`, `error_rate`, `p95_latency`.

### Outputs
For each edge: `value` (the weight), `dependency`, `basis` (requests / activity / uniform), `kind` (request or telemetry), `confidence` and why, `stress`.

### Steps
1. **Confidence** of the edge from its evidence (table below).
2. Group the caller's edges with confidence > 0, separately for functional calls and for telemetry edges. Candidate edges (confidence 0) do not take part.
3. **Dependency share** inside the group:
   - if every edge has a request rate: `rate / sum of rates` (basis `requests`);
   - else if activity is known: `activity / total activity * measured_pool` (basis `activity`);
   - else `1 / N` (basis `uniform`).
4. `value = confidence * dependency * factor`, clamped to 0..1, rounded to 3 decimals (half up).
5. `stress = max( min(error_rate/0.05, 1), min(latency/1000, 1) )`, or none if unmeasured.

### Formulas
```
weight     = confidence * dependency * (0.1 if telemetry edge else 1)
dependency = rate(A->B) / sum of rates of A's edges            (requests)
measured_pool = 1 - (edges without traffic) / (all edges)      (so shares add to exactly 1)
```
Confidence table: seen in request logs 1.0; direction from listening port 1.0; ephemeral port 0.85; observed without direction evidence 0.7; direction unresolved 0.5; declared in config only 0.4; shared network only 0.

### Worked example (real output)
`orders` calls `db` (90 req/s, seen in logs), `cache` (10 req/s, ephemeral port, 2% errors) and `otel-collector` (500 req/s, telemetry); `web -> orders` is only declared.
```
e1 {'value': 0.9, 'dependency': 0.9, 'basis': 'requests', 'kind': 'request', 'confidence': 1.0, ..., 'stress': None}
e2 {'value': 0.085, 'dependency': 0.1, 'basis': 'requests', 'kind': 'request', 'confidence': 0.85, ..., 'stress': 0.4}
e3 {'value': 0.1, 'dependency': 1.0, 'basis': 'requests', 'kind': 'telemetry', 'confidence': 1.0, ..., 'stress': None}
e4 {'value': 0.4, 'dependency': 1.0, 'basis': 'uniform', 'kind': 'request', 'confidence': 0.4, ..., 'stress': None}
```
Reading it: db is 90/(90+10) = 0.9 of orders' functional work. The 500 req/s of telemetry does not dilute that share, because telemetry is grouped separately; telemetry gets 1.0 * 1.0 * 0.1 = 0.1. e2 stress = 0.02/0.05 = 0.4.

### Parameters
`CONFIDENCE` values; `TELEMETRY_FACTOR = 0.1` (0 would say a dead collector never matters, 1 would predict a collector failure takes the shop down); `STRESS_ERROR_RATE = 0.05`; `STRESS_LATENCY_MS = 1000`.

### Edge cases and why
- **Baseline over live rate:** a link goes quiet exactly when its callee dies; weighing on the live rate would make a crashed dependency look less and less important.
- **Unmeasured edges** get an even slice `1/N`, and measured edges split the rest, so shares always sum to 100% (an earlier version reached 183%).
- **Candidate edges** (shared network only) get weight 0 and do not dilute real edges.
- **Telemetry grouped separately:** 50 trace exports/min and 10 DB calls/min means the DB is depended on completely, not 17%.

---

## 4. Cascade engine (`cascade_engine.py`)

**Mirrors:** `server/algorithms/graph/CascadeEngine.ts`

### Purpose
Three functions: `predict_cascade` (who fails next), `simulate_failure` (what if X failed), `structural_criticality` (how much traffic would X's failure disrupt).

### Inputs
Nodes with `status`, optional `anomaly_score` (0..1) and `anomaly_persistent`; edges with a weight (computed from `edge_weights` if missing); `tau` (default 0.7); for criticality a function giving each edge's traffic.

### Outputs
Per service: `probability`, `intrinsic` (own part), `inherited` (through dependencies), `band`, `via` (strongest dependency), `path` back to the origin, `depth`. Plus `expected_failures`, `at_risk`, `iterations`, `converged`.

### Steps (predict_cascade)
1. **Own probability p0** per service: `survive = 1`; status critical multiplies survive by 0 (p = 1.0), degraded by 0.5, healthy / unknown by 1; an anomaly score `a` multiplies by `1 - min(a,1) * w` with `w = 0.3` (one window) or `0.8` (persistent). `p0 = 1 - survive`.
2. **Iterate** the noisy-OR formula until the biggest change is below 1e-6 (max 200 rounds).
3. **Describe**: find each service's strongest inherited route (`via`), and follow routes back to the origin for the path.
4. **At risk** = own p0 < 0.15 but total probability >= 0.15.
5. **Band**: high >= 0.7, elevated >= 0.4, low >= 0.15, else minimal.

### Formulas
```
P(n) = 1 - (1 - p0(n)) * product over callees c of ( 1 - tau * w(n->c) * P(c) )
simulate_failure(x):   same, with p0(x) forced to 1; report services whose P rose by >= 0.005
criticality(x) = sum over edges of traffic(e) * (1 - (1-P(source)) * (1-P(target))) / total traffic
                 (with p0 = 1 for x and 0 for everyone else)
```

### Worked example (real output)
`web -> orders (0.8)`, `orders -> db (0.9)`, `web -> mail (0.2)`; db critical, orders degraded.
```
converged=True after 3 rounds, expected failures 2.271
  db      P=1.0    own=1.0    band=high      path=db
  orders  P=0.815  own=0.5    band=high      path=orders <- db
  web     P=0.456  own=0.0    band=elevated  path=web <- orders <- db
  mail    P=0.0    own=0.0    band=minimal   path=mail
at risk: [('web', 0.456)]
what if db failed from a healthy system: [('orders', 0.63), ('web', 0.353)]
criticality: {'web': 0.67, 'orders': 0.85, 'db': 0.7, 'mail': 0.38}
```
By hand: orders = `1 - (1-0.5) * (1 - 0.7*0.9*1.0)` = `1 - 0.5*0.37` = 0.815. web = `1 - (1 - 0.7*0.8*0.815)` = 0.456. orders is not in the at-risk list because its own part (0.5) is already >= 0.15; web is, because it looks fine itself. In the what-if run from a healthy system orders = 0.7*0.9 = 0.63 and web = 0.7*0.8*0.63 = 0.353.

Cycle example (also in the tests): `a (degraded) -> b -> c -> a`, all weights 0.9: converges after 20 rounds to `a 0.571, c 0.36, b 0.227`.

### Parameters
| Name | Value | Effect |
|---|---|---|
| `tau` (transmission) | 0.7 | Share of a dependency's failure reaching its caller. 0 = no spread, 1 = full spread. Below 1 because of retries, timeouts, caches. |
| `STATUS_PROBABILITY` | critical 1, degraded 0.5, healthy 0, unknown 0 | Unknown is 0 so unmeasured services do not create phantom cascades. |
| `ANOMALY_WEIGHT` / `PERSISTENT_ANOMALY_WEIGHT` | 0.3 / 0.8 | One sample is often noise; a sustained anomaly counts more. |
| `MEANINGFUL_INHERITED` | 0.15 | Smallest inherited risk worth showing a route for. |
| `TOLERANCE`, `MAX_ITERATIONS` | 1e-6, 200 | Stopping rule. |

### Edge cases and why
- **Cycles:** P(n) depends on P(c) which may depend on P(n). We iterate; P only rises from p0 and is capped at 1, so it converges.
- **Self-loops, unknown endpoints and weight 0 edges** are ignored.
- **Criticality from a clean slate:** it describes the service's place in the graph and should not swing because something else is failing now. Plain reachability overstated it (66% for a queue only shipping uses; the weighted model gives about 8%).
- **Both ends of an edge** count for disruption: calls into a failed callee fail, and a failed caller stops calling.
- These are model estimates, not observed frequencies: nothing is calibrated against recorded cascades.

---

## 5. Consistency checks (`consistency.py`)

**Mirrors:** `server/algorithms/graph/consistency.ts`

- **Purpose:** validate that the numbers published by the mapper agree with each other. Each rule was found broken in live output once.
- **Inputs:** nodes (with `analytics`, `metrics`), edges (with `weight`, `activity`), incidents. **Output:** list of violations `{rule, subject, detail}`.
- **Steps:** run the 12 rules below over everything and collect what fails. Tolerance for rounded numbers: 0.011.

| # | Rule | Check |
|---|---|---|
| 1 | `edge-endpoints` | both ends of a link are known services |
| 2 | `health-breakdown-sum` | factors add up to the health score |
| 3 | `score-range` | probabilities and scores are in 0..1 |
| 4 | `inherited-within-total` | inherited probability <= total probability |
| 5 | `cascade-via-is-dependency` | "risk arrives via X" means X is really a callee |
| 6 | `metric-range` | cpu >= 0, memory percent 0..100, byte counts >= 0 |
| 7 | `rate-not-total` | a network rate over 10 GB/s is a total shown as a rate |
| 8 | `weight-formula` | weight = confidence * dependency (* 0.1 for telemetry) |
| 9 | `reliance-sums-to-one` | a caller's dependency shares per kind sum to 100% (+-2%) |
| 10 | `activity-range` | connection figures >= 0 |
| 11 | `incident-references` | incident services exist and belong to the incident's target |
| 12 | `root-cause-is-candidate` | the named root cause is among its candidates (also score in 0..1) |

Resolved incidents are skipped.

**Worked example (real output)** of the built-in demo with a ghost endpoint, a bad rate and a wrong weight:
```
6 violation(s) found by 12 rules:
  [edge-endpoints] e2: target shop:ghost is not a known service
  [inherited-within-total] shop:orders: inherited 0.5 exceeds total 0.3
  [metric-range] shop:orders: memory_percent = 120
  [rate-not-total] shop:orders: network_rx_rate = 500000000000.0 bytes/s
  [weight-formula] e1: weight 0.9 but confidence x dependency = 0.500
  [reliance-sums-to-one] shop:web: request shares sum to 50%
```
- **Parameters:** `TOL = 0.011`, the 10 GB/s limit, the 2% share tolerance.
- **Edge cases:** missing values are not violations (only present-but-wrong ones); a non-numeric value in a numeric field is a violation.

---

## Questions an evaluator may ask

1. **What does an edge weight mean?** The chance-like strength that a failure of the callee reaches the caller: `confidence * share of the caller's work * (0.1 for telemetry)`.
2. **Why is telemetry weighted at 0.1, not 0?** A service keeps serving when its collector dies, but a blocked exporter can back up into it. Small, not zero.
3. **What is the noisy-OR and why use it?** Each route to failure is independent; the service fails if any route does: `1 - product(1 - p_route)`. It never exceeds 1 and adding routes only raises risk.
4. **How do you handle cycles?** Repeat the formula until nothing changes by more than 1e-6. P only rises and is bounded by 1, so it converges (20 rounds in the cycle example).
5. **Why is tau 0.7?** Retries, timeouts, caching and graceful degradation mean a dependency failure does not always take its caller down. 0.7 is an assumed value, not calibrated; the output says so.
6. **What is the difference between predict_cascade and simulate_failure?** predict starts from what is measured now; simulate forces one service to failed (p0 = 1) and reports how much each other service's risk rises compared with the current baseline.
7. **Why is criticality computed from a healthy start?** It should describe the service's position in the graph, not the incident of the day. Current state is added elsewhere as a risk score.
8. **What are the consistency checks for?** Regression guards: each rule was once broken in live output (shares summing to 183%, a cumulative byte count shown as a rate). They run on the published graph and on test fixtures.
