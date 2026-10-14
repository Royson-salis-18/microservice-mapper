# Root-cause analysis (rca)

Folder: `algorithms/rca/`. Python 3, standard library only. Run the tests with
`python3 algorithms/rca/test_rca.py`.

When an incident happens, many services look sick at once. This folder answers:
**which service is the real cause, how sure are we, how did it spread, and who is
at risk next?** Three files work together:

| File | Job |
|---|---|
| `rca_engine.py` | the ranking itself (the important one) |
| `temporal_analyzer.py` | puts anomalies in time order, reports ties |
| `explanation_engine.py` | words the result in plain English |

Vocabulary used below:

- **anomaly**: a metric that is unusual for a service (found earlier by the detection step). It has a z-score `z` (how many "normal wobbles" away from normal) and a kind: `own` (cpu, memory, silence - about the service itself), `symptom` (latency, errors, traffic drop - can be inherited from a dependency) or `hard` (the container is stopped).
- **callee / caller**: edge `A -> B` means A calls B. A is the caller, B the callee.
- **failures travel callee -> caller**: if B breaks, A starts to fail too. So a caller whose errors are explained by a broken callee is a *victim*, not the cause.

---

## 1. RCA engine (`rca_engine.py`)

**Mirrors:** `server/algorithms/rca/RCAEngine.ts` (and the container-state rule of `server/algorithms/detection/containerFacts.ts`).

### Purpose
Rank the services of one project by how likely each is the root cause of the incident.

### Inputs
- `nodes`: services with `status` (healthy / degraded / critical / unknown), container `state` (like `"exited (137)"`), optional `metrics`.
- `edges`: caller -> callee links (weights come from `graph/edge_weights.py`).
- `anomalies`: list of anomalies per service.
- optional: `thresholds`, `incumbent` (root cause of the incident already open), `host_silent`, `learning`.

### Outputs
`root_cause` (best candidate), `candidates` (all, ranked, each with score 0..1, confidence, breakdown), `propagation_path`, `at_risk` list, overall `confidence`, an `explanation`, and `monitoring_gap`.

### Steps
1. **Facts about containers.** A stopped / paused / restarting / network-detached container is *hard evidence* (a fact, not a statistic). Exceptions that are not failures: exit code 0, a container that was only created, and load generators (locust, k6...).
2. **Per-service evidence.** For each service compute
   - `own` = largest z of its `own` anomalies (and at least 3.5 if its status is `degraded`),
   - `symptoms` = largest z of its `symptom` anomalies (and at least 8 if its status is `critical` while the container still runs),
   - `hard` = true/false from step 1.
3. **Silence is inherited.** If a service went silent but a service it calls is hard-down or loud (symptoms >= 3.5), its silence is treated as a symptom, not as its own fault (its requests fail fast and it falls quiet).
4. **Monitoring outage check.** If at least 80% of the services (and at least 3) are silent or vanished together, or the host itself is silent, return "monitoring outage" and blame nobody. If there is no anomaly at all, return "no incident".
5. **Score.** For each service (formulas below).
6. **Blind spot.** A service with no telemetry at all and score 0 can be inferred as the cause if its callers show unexplained symptoms.
7. **Coverage bonus.** Add a bonus for services that many other troubled services depend on.
8. **Hysteresis.** Multiply the open incident's cause by 1.15.
9. **Rank, confidence, propagation path, at-risk list, explanation.**

### Formulas
```
explained(s) = gamma * max( evidence(c) for every callee c of s )
evidence(c)  = 50 if hard(c) else max(own(c), symptoms(c))

score(s)     = max( own(s), max(0, symptoms(s) - explained(s)) ) + 100 * hard(s)

blind spot (no data, score 0):
   ups = [ max(0, symptoms(c) - explained(c)) for each caller c ]
   corroborated = (at least 2 ups >= 3.5) or (any up >= 5.0)
   score = 0.9 * max(ups)     if corroborated

coverage(s)  = troubled services o != s whose dependency path to s has strength >= 0.1
score(s)    += len(coverage(s)) / (troubled - 1) * 3.5 * min(1, gamma)

score(incumbent) *= 1.15     (only if the incumbent is not a hard fact)

margin       = 1 - score(second) / score(top)
display score (0..1) = 0.9 + (score-100)/500   if score >= 100   (hard facts: 0.9 to 1)
                       min(0.89, score / (score + 7))   otherwise
path strength = product of edge weights along the strongest call chain (max-product)
```

Confidence of the top candidate:

- `HIGH` if it is the only hard-failed service, or margin >= 0.5 and one of its edges was really observed;
- else `MEDIUM` if margin >= 0.2; else `LOW`;
- forced to `LOW` if other services are troubled but none of them depends on it (independent problems);
- other candidates: `UNKNOWN` if their score is below half of the top score, else `LOW`.

At-risk (noisy-OR): for each service not itself failing that calls failing services `c`:
```
risk = 1 - product over failing callees c of ( 1 - min(1, evidence(c) / 7) * 0.5 )
```
"Failing" means hard, or score >= 3.5. 0.5 is `cascade_edge_probability`, a ranking aid, not a calibrated probability.

### Worked example (real output)
Chain `web -> orders -> db`. Anomalies: db memory z = 9 (own), orders error-rate z = 7 (symptom), web latency z = 6 (symptom).

```
db      own 9, symptoms 0, explained 0           -> base score 9
orders  own 0, symptoms 7, explained 9           -> max(0, 7-9) = 0   (victim of db)
web     own 0, symptoms 6, explained 7           -> max(0, 6-7) = 0   (victim of orders)
troubled = 3, others = 2
db covers orders and web: 2/2 * 3.5 = +3.5       -> 12.5   display 12.5/(12.5+7) = 0.64
orders covers web:        1/2 * 3.5 = +1.75      ->  1.75  display 0.20
margin = 1 - 1.75/12.5 = 0.86 and the edge is observed -> HIGH
```
Output of the code:
```
db 0.64 HIGH own=9.0 symptoms=0.0 explained=0.0  ['own_evidence:9.0', 'explains_failures:0.25']
orders 0.2 UNKNOWN own=0.0 symptoms=7.0 explained=9.0  ['symptoms:7.0', 'likely_victim:-7.0', 'explains_failures:0.13', 'dependency_failing:-0.25']
web 0.0 UNKNOWN own=0.0 symptoms=6.0 explained=7.0  ['symptoms:6.0', 'likely_victim:-6.0', 'dependency_failing:-0.25']
propagation_path: ['db', 'orders', 'web']
at_risk: orders, risk 0.5 via db      (1 - (1 - min(1, 9/7) * 0.5) = 0.5)
```
With `explain_away_gamma = 0` (ignore the call graph, plain "most abnormal") the same input gives `db 0.56, orders 0.50, web 0.46`: the victims climb back up the list. The built-in demo (`python3 algorithms/rca/rca_engine.py`) shows the hard-fact case:
```
confidence: HIGH | path: orders-db -> orders -> web
  orders-db  score=0.91  HIGH     own=0.0 sym=0.0 explained=0.0
  web        score=0.33  UNKNOWN  own=3.5 sym=4.0 explained=7.0
  orders     score=0.2   UNKNOWN  own=0.0 sym=7.0 explained=50.0
at risk: [{'service_id': 'orders', 'service_name': 'orders', 'risk': 0.5, 'via': ['orders-db']}]
why: orders-db is exited (137): hard evidence. 2 of the 2 other affected services depend on it.
```
The container died (exit 137), so `orders-db` gets +100 and a score of 0.91 that no statistic can beat.

Other results checked by the tests: two callers with symptoms 4.0 and 4.0 make a silent `ghost` service the cause (`ghost 0.5 MEDIUM`, factor `blind_spot`); with `a` at z = 5.0 and `b` at 5.5, `b` wins (`0.44` vs `0.42`), but with `a` as incumbent `a` wins (`0.45` vs `0.44`); five services all silent give "5 of 5 services stopped reporting at the same moment" and no root cause.

### Parameters (the `Thresholds` dataclass and constants)
| Name | Value | Effect of changing it |
|---|---|---|
| `z_anomaly` | 3.5 | Lower = more services count as troubled and the coverage bonus is larger. |
| `z_high` | 5.0 | Lower = a single caller can already justify a blind-spot guess. |
| `z_critical` | 8.0 | Strength given to a service with `critical` status but a running container. |
| `monitoring_gap_share` | 0.8 | Lower = a smaller group of silent services is called an outage. |
| `explain_away_gamma` | 1.0 | 0 = plain "most abnormal"; 1 = a broken callee fully excuses its callers. Range 0..2 in the original. |
| `cascade_edge_probability` | 0.5 | Chance a failure crosses one edge (at-risk list only). |
| `MATERIAL_REACH` | 0.1 | Dependency paths weaker than this do not count (telemetry links are 0.1 so they sit at the border). |
| `INCUMBENT_BONUS` | 1.15 | Larger = the verdict flips less often. |
| `HARD_BONUS` | 100 | Makes a stopped container beat any statistic. |

### Edge cases and why
- **Datastore reverse edges.** Edges found from TCP sockets appear from both ends (`cart -> cart-store` and `cart-store -> cart`). An edge whose caller is a datastore (name like db, redis, queue, or type database/queue) is the reverse view and is ignored. Without this the store was listed as "at risk".
- **Weak paths.** A dashboard that a proxy forwards to has path strength 0.004; it must not "explain" seven failures. Hence `MATERIAL_REACH`.
- **Exit code 0, created, load generators** are not failures.
- **Silence of a caller** is inherited from a broken callee (step 3).
- **Blind spot needs corroboration**: one noisy caller is not enough to blame a silent node.
- **No data at all** (all quiet) returns no incident; **learning mode** (baseline not ready) only trusts hard facts.
- **Hysteresis** is not applied to a hard fact, which does not need it.
- **Cycles** in the graph: the reach calculation stops as soon as nothing improves.

---

## 2. Temporal analyzer (`temporal_analyzer.py`)

**Mirrors:** `server/algorithms/rca/TemporalAnalyzer.ts`

**Purpose:** order anomalies in time and find who was first.
**Inputs:** anomalies with `node_id`, `metric`, `timestamp` (ISO string or seconds).
**Outputs:** a timeline (sorted list, each point flagged `is_earliest`) and the set of earliest nodes.

**Steps**
1. Sort by timestamp.
2. Take the first timestamp as `t0`.
3. A point is `is_earliest` if `abs(t - t0) < 1 second`.
4. `find_earliest_nodes` returns every node with an earliest point (a set, so a tie stays a tie).

**Formula:** `is_earliest = |t - t0| < 1 s`.

**Worked example (real output)**
```
2026-01-01T10:00:00Z  db     memory   earliest=True
2026-01-01T10:00:00.4Z  cache  cpu      earliest=True
2026-01-01T10:00:09Z  web    latency  earliest=False
earliest set: ['cache', 'db']
```
db and cache started within 0.4 s, which is inside one polling cycle, so we cannot say which came first. We report both.

**Parameter:** `SAME_MOMENT_SECONDS = 1.0`. Larger = more ties.
**Edge cases:** empty input gives an empty timeline. A single earliest node would be unfair to its tie partner, which is why `find_earliest_nodes` exists.
In the engine the timeline is only used to date the incident (`when_started`).

---

## 3. Explanation engine (`explanation_engine.py`)

**Mirrors:** `server/algorithms/rca/ExplanationEngine.ts`

**Purpose:** turn the ranking into sentences: what happened, likely root cause, why, what to check.
**Inputs:** target id, start time, root-cause candidate (with its score breakdown), alternatives, affected services, propagation path, evidence, confidence, optional `independent` flag and `explains = {count, of}`.
**Outputs:** a dict with `what_happened`, `likely_root_cause`, `why`, `propagation_path`, `alternatives`, `evidence_summary`, `recommended_investigation`.

**Steps**
1. No root cause, or confidence `UNKNOWN`: return the generic "insufficient telemetry" text with three generic checks.
2. Strip the `sock-shop-` / `vertikal-` prefix from names.
3. Join the `reason` of every breakdown factor ("Key factors").
4. Build the lead clause only from factors that exist: `critical_status` -> "is down or crash-looping", else `degraded_status` -> "is degraded", else "shows a metric anomaly"; `temporal_precedence` -> "its problem began first"; `explains_failures` -> "N of the M other affected services depend on it" (exact count, "all M" if equal).
5. If `independent`: say these look like independent problems, one investigation per service.
6. Otherwise recommend: check resource limits (or the exit code when the cause is down), confirm the path recovers with it, open logs around the start time.

**Formula:** displayed percentage = `score * 100` rounded.

**Worked example (real output)**
```
what_happened: Incident detected on 'sock-shop': 2 service(s) affected (orders-db, orders).
likely_root_cause: orders-db
why: 'orders-db' shows a metric anomaly, all 2 other affected services depend on it (score 93%). Key factors: container exited: a fact, not a degree; 2 of the 2 other affected services depend on it.
recommended_investigation: ["Check resource limits and recent load on 'orders-db'", "Once 'orders-db' recovers, confirm orders recover with it", 'Open its logs from the service card for the moments around 10:00:00']
```
Known quirk, kept on purpose because the TypeScript has it: the lead clause looks for the factor names `critical_status` / `degraded_status`, but the engine names its factor `hard_evidence`, so a stopped container still reads "shows a metric anomaly" here. The engine therefore overwrites the `why` field with its own sentence (see the last line of the first demo above).

**Parameters:** none numeric. **Edge cases:** missing root cause, `independent` mode, a count equal to the total ("all N"), one other service ("the other affected service").

---

## Questions an evaluator may ask

1. **Why not just pick the service with the highest anomaly?** Because failures propagate to callers. A caller can look worse than the broken service it depends on. Subtracting what the callee explains (`symptoms - explained`) pushes victims down. The code says honestly that on the research benchmark this step was not better than "most abnormal"; the scoring details (silence, normalised z) mattered more. `explain_away_gamma = 0` gives plain "most abnormal".
2. **What is a "hard fact" and why +100?** A stopped, paused, crash-looping or detached container is certain, not a probability. The +100 makes it beat any statistical score, and it maps to display scores 0.9 to 1.0 so it is clearly separate from soft evidence (capped at 0.89).
3. **What if the broken service has no monitoring data?** The blind-spot rule: if at least two callers (or one strongly) have symptoms nothing else explains, we guess the silent service with `0.9 * strongest unexplained symptom`. It is flagged `blind_spot` in the breakdown so nobody mistakes it for measured evidence.
4. **When do you refuse to blame anyone?** If 80% or more of the services (minimum 3) go silent together, or the host stops sending data: independent services do not freeze in the same seconds, a broken telemetry path does.
5. **How do you stop the answer flipping between two close candidates?** Hysteresis: the open incident's cause gets x1.15, so a challenger must beat it by 15%. A hard fact is not boosted.
6. **How is confidence computed?** From the margin between the top two scores: HIGH when margin >= 0.5 with an observed edge or when it is the only stopped container, MEDIUM at >= 0.2, else LOW. LOW when the other troubled services do not depend on it at all.
7. **What does the at-risk list mean?** Healthy-looking services that call a failing one. Noisy-OR combines the routes: `1 - product(1 - strength * 0.5)`. It is a ranking aid, not a calibrated probability.
8. **Why ignore edges that start at a datastore?** Socket-based discovery sees a connection from both ends. The edge from the database back to the service is only the reverse view of a real call, so using it would make the database look like a caller of the service.
