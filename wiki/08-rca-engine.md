# RCA Engine — Root Cause Analysis

**Files:** `server/rca/IncidentManager.ts` (lifecycle), `AnomalyDetector.ts` (what counts as a symptom), `RCAEngine.ts` (scoring and propagation), `TemporalAnalyzer.ts` (who went first), `ExplanationEngine.ts` (the words), `thresholds.ts` (the editable rules).

---

## What it does

When something on a target is wrong, RCA answers three questions:

1. **Which service is most likely the origin?** Every symptomatic service is scored on named evidence factors, and the highest score is the root-cause candidate.
2. **How sure is that?** The score and the shape of the evidence give a confidence: HIGH, MEDIUM, LOW or UNKNOWN.
3. **How did it spread?** A walk from the origin to the services that depend on it.

It is **deterministic, rule-based scoring**, not machine learning. There are no labelled incidents to train a model on, and an operator has to be able to see why a service was blamed. Every factor arrives with its points and a sentence of reasoning.

---

## The cycle

Every 5 s (`server/index.ts`, `runPollingCycle`), for each target:

```
IncidentManager.evaluateTarget(targetId)
  ├─ AnomalyDetector.detectAnomaliesForTarget()   → symptoms, each with an onset time
  ├─ RCAEngine.analyzeIncident()                   → candidates, confidence, propagation
  └─ open / update / resolve the target's incident
then RiskEngine.recomputeAll(incidents)            → health and risk see this cycle's incident
then graph-update broadcast
```

An `incident.updated` frame is sent only when something a person would notice has changed: status, severity, root cause, confidence, score (to the percent), affected set or propagation path. It used to go out every cycle for every target, about 48 frames a minute.

---

## What counts as a symptom

`AnomalyDetector` is **rule-based** and deliberately separate from the ML pipeline (see [Two opinions, kept apart](17-findings-vs-incidents.md)). An incident must be able to fire on a service that started five minutes ago, on a target with no trained models, while the scorer is stopped.

A service is symptomatic if:

- its container is **critical**, or its state is `exited`, `dead` or `restarting`; or
- its status is **degraded** (for example CPU above 80% of its allowance); or
- a metric deviates from that service's own recent history by the rules in `thresholds.ts`.

Default thresholds, all editable from the Incidents page (`data/incident_thresholds.json`, re-read every cycle, clamped to sane bounds):

| Threshold | Default | Meaning |
|---|---|---|
| `minHistorySamples` | 3 | samples needed before a z-score means anything |
| `zScoreAnomaly` / `High` / `Critical` | 2.5 / 3.0 / 4.0 | \|z\| bands |
| `minDeviationPercent` | 5 | a move smaller than 5 points is never an anomaly, however steady the baseline |
| `absoluteHighPercent` / `CriticalPercent` | 70 / 85 | absolute levels that force HIGH or CRITICAL regardless of z |
| `flatlineStdDev` | 0.001 | below this spread the baseline is "flat", and z is not used |
| `flatlineDeltaPercent` / `CriticalPercent` | 30 / 80 | on a flat baseline, a 30-point move is the anomaly |
| `criticalServicesForCritical` | 2 | more critical services than this makes the incident CRITICAL rather than HIGH |

Two details keep this honest:

- **Onsets are remembered.** Each anomaly keeps the time it *first* appeared for as long as it lasts. Before that fix, every anomaly was stamped with the current cycle's time, and the +0.30 "went first" credit went to whichever service was discovered first.
- **The CPU rule uses `cpuOfAllowance`.** 150% of one core on a 2-core container is 75% of its allowance, not an emergency.

---

## Who is a candidate

Candidates are all symptomatic services: failing (critical or degraded) **or** carrying a measured anomaly. Including anomaly-only services matters. An incident raised purely on anomalies used to have nobody to blame and reported "root cause: none".

---

## Scoring a candidate

Each candidate's score is a sum of named factors, rounded and clamped to 0–1.

| # | Factor | Points | When |
|---|---|---|---|
| 1 | `temporal_precedence` | **+0.30** | its anomaly began in the earliest cycle (ties are reported as ties) |
| | `anomaly_presence` | +0.10 | it has an anomaly, but not the earliest |
| 2 | `critical_status` | **+0.35** | container down, exited, dead or crash-looping |
| | `degraded_status` | +0.15 | degraded |
| 3 | `observed_dependency` | +0.20 | it has at least one edge seen carrying traffic |
| | `declared_dependency` | +0.05 | only config-declared edges |
| 4 | `explains_failures` | **up to +0.25** | the other symptomatic services depend on it |
| 5 | `dependency_failing` | **down to −0.25** | its own dependencies are failing, so it is likely a victim |

Each pair (1, 2, 3) is exclusive: a candidate gets one line or the other.

### Factor 4: how much it explains

A root cause is the failure the others follow from. For every *other* symptomatic service, the engine takes the strength of that service's strongest dependency path down to the candidate:

```
reach(s → c) = max over call chains from s to c of  Π edge weights
```

(`dependencyReach()`: a max-product path solved by relaxation, which is trivial at tens of nodes.) An edge's weight is confidence × reliance (see [The graph store](03-graphstore.md)), so a direct, sole dependency gives 1.0, and long or weak chains give less.

Only **material** paths count: `reach ≥ MATERIAL_REACH = 0.1`.

```
coverage = Σ material reach over the other symptomatic services / their count
points   = 0.25 × coverage
```

The materiality cut-off exists because telemetry links are weighted at a tenth. Without it, a dashboard that one proxy forwards to was credited with "explaining" seven failing services through paths of strength 0.004.

The factor is listed only when it is worth at least 0.01. Its reason states the count, for example `+0.18 explains 3 of 4 other affected service(s): they depend on it (weighted coverage 72%)`.

### Factor 5: the victim penalty

If a service's own callees are failing, it is more likely downstream of the problem than its origin:

```
victimShare = min(1, Σ weight of its edges to failing callees)
points      = −0.25 × victimShare
```

The reason names the failing dependencies: `−0.20 depends on failing orders-db (weighted share 80%) — likely a victim, not the cause`.

### Confidence

| Score | Confidence |
|---|---|
| ≥ 0.75 **and** an observed edge | HIGH |
| ≥ 0.50 | MEDIUM |
| ≥ 0.25 | LOW |
| below 0.25 | UNKNOWN |

A high score built only on declared dependencies can never be HIGH.

### Independent failures

If several services are symptomatic and the top candidate explains **none** of them (no material path), there is no single-cause story. Two services each running hot on their own are two problems, not one problem with a root. The ranking stays, but the confidence is forced to **LOW**, and the explanation says the problems look independent. This rule never fired before the materiality cut-off existed. Live, it had named Grafana at 95% memory as the cause of OpenSearch at 84% memory, with no dependency between them.

---

## Worked example (real engine output)

The fixture below was run through `RCAEngine.analyzeIncident()` itself, and the numbers are what it returned.

`orders-db` exits. Ten seconds later `orders` shows an anomaly and degrades, and ten seconds after that, `frontend`. Observed traffic, with direction from listening ports (confidence 1.0):

| Edge | Activity | Caller's share → weight |
|---|---|---|
| `frontend → orders` | 120/min | 0.60 |
| `frontend → catalogue` | 80/min | 0.40 |
| `orders → orders-db` | 300/min | 0.75 |
| `orders → payment` | 100/min | 0.25 |

Reach to `orders-db`: from `orders` 0.75, from `frontend` 0.60 × 0.75 = 0.45. Coverage = (0.75 + 0.45) / 2 = 60%.

| Candidate | Factors | Score | Confidence |
|---|---|---|---|
| **`orders-db`** | +0.30 earliest · +0.35 down · +0.20 observed · +0.15 explains 2 of 2 (coverage 60%) | **1.00** | **HIGH** |
| `orders` | +0.10 anomaly · +0.15 degraded · +0.20 observed · +0.08 explains 1 of 2 (30%) · **−0.19** depends on failing orders-db (75%) | 0.34 | LOW |
| `frontend` | +0.10 anomaly · +0.15 degraded · +0.20 observed · **−0.15** depends on failing orders (60%) | 0.30 | LOW |

Propagation path: `orders-db → orders → frontend`. Affected: `sim-shop:frontend`, `sim-shop:orders`, `sim-shop:orders-db` (ids). The explanation reads:

> 'orders-db' is down or crash-looping, its problem began first, all 2 other affected services depend on it (score 100%).

The victim penalty is what keeps `orders` from looking like the origin, even though it is in the middle of everything.

---

## Propagation: how it spread

Failure travels **against** the arrow. A failing database breaks the services calling it, then whatever calls those. From the root cause, the engine walks to its *callers*, strongest edge first, ignoring edges below 0.05:

- A caller **joins** the path if it is symptomatic, or if it depends on the failing service heavily (edge weight ≥ 0.5) and is therefore a plausible pass-through even before it shows a symptom.
- The walk continues only from services that joined.

Each step records the edge, its evidence source (`network-tcp` or `compose-declarative`), the caller's status, the weight, and a confidence (HIGH ≥ 0.5, MEDIUM > 0.15, otherwise LOW).

This replaced a walk that followed every edge of any strength to everything reachable, which reported one service's memory pressure as having spread across a 20-service system.

---

## The incident record

`IncidentManager` keeps one incident per target:

| Field | Value |
|---|---|
| `status` | `INCIDENT` if anything is critical, `DEGRADED` if only degraded, `RESOLVED` when RCA finds nothing |
| `severity` | `CRITICAL` (more than 2 critical services), `HIGH` (1–2), `MEDIUM` (degraded only), `LOW` (anomaly only) |
| `rootCauseServiceId`, `rootCauseScore`, `confidence` | from the top candidate |
| `affectedServices` | **ids** of every symptomatic service (once names, which silently failed to match ids everywhere else) |
| `candidateCauses` | every candidate with its `scoreBreakdown` |
| `propagation` | the steps above |
| `explanation` | from `ExplanationEngine` |

While an incident is open it is updated in place, never duplicated. When RCA finds nothing it is marked `RESOLVED` with `endedAt`. Resolved incidents stay in memory, which is why `RiskEngine` filters them out explicitly.

---

## The explanation

`ExplanationEngine` turns the result into plain sentences: what happened, when it started, the likely root cause, why (the factor reasons), the propagation path, and alternatives with their scores. The "why" states the explaining count in words:

- "the other affected service depends on it" (exactly one other)
- "all 3 other affected services depend on it"
- "2 of the 4 other affected services depend on it"
- or, for independent failures, that the services do not appear to depend on each other.

Evidence lines say "not measured" for a figure that was not measured, never "0%".
