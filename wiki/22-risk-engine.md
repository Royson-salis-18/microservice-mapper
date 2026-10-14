# 22 - Risk, cascades and blast radius

**Files:** `server/graph/RiskEngine.ts` (per-service exposure, blast radius, orchestration), `algorithms/graph/CascadeEngine.ts` (the cascade model, criticality, what-if), `algorithms/graph/EdgeWeights.ts` (the weights both read).

## What this answers

RCA speaks once something is already broken. This layer looks ahead:

| Question | Answer | Where it shows |
|---|---|---|
| How healthy is this service right now? | `healthScore` with a factor breakdown | Reliability tab, inspector |
| How much of the system rests on it? | `criticality`, `centrality` | Reliability tab, inspector |
| How exposed is it overall? | `riskScore` (current exposure, **not** a probability) | RISK badge on the 2D card |
| Given what is failing now, what fails next, and through what? | `failureProbability`, `affectedProbability`, `cascadeVia` | inspector, `GET /api/reliability/cascade` |
| If this one failed, what would it take with it? | what-if and blast radius | inspector, `GET /api/reliability/whatif/:id`, `GET /api/reliability/blast-radius/:id` |

Everything is recomputed every poll cycle, **per project**, and written onto the node objects the store already holds. That is how it reaches `/api/graph` and the `graph-update` broadcast without either of them knowing this engine exists.

---

## Step 1: edge weights

Everything below reads `edge.weight`, recomputed first each cycle:

```
weight = confidence × dependency   (× 0.1 if it is a telemetry edge)
```

- **confidence** comes from the evidence: 1.0 for a listen-port-directed observed link, down to 0.4 for declared-only.
- **dependency** is the caller's share of its traffic going to this callee. Shares sum to exactly 1 per caller and kind.

See [Measuring precisely](31-measurement-precision.md) for how the shares are built.

---

## Step 2: health

Health is a weighted average of up to three real signals:

| Factor | Weight | Value |
|---|---|---|
| `status` | 0.60 | healthy 1.0 · degraded 0.5 · critical 0.0 · unknown 0.5 |
| `anomaly` | 0.25 | 1 − ML ensemble score; **dropped** when the service has no trained model |
| `incident` | 0.15 | 1.0 not in an open incident · 0.3 affected · 0.0 named root cause |

A dropped factor's weight is not filled with a guess. The remaining weights are **renormalised**: without an anomaly score, 0.60 and 0.15 become 0.80 and 0.20. Each part is rounded first, and the total is the sum of the rounded parts, so `healthBreakdown` always adds up exactly to `healthScore`.

Incidents are matched by id (names are still accepted for incidents recorded before the id change). `RESOLVED` incidents are ignored: `IncidentManager` keeps them in memory forever, so without the filter a service would stay marked down long after it recovered.

---

## Step 3: the cascade model

Each service gets an **intrinsic** probability `p0` from its own measured state:

| Signal | Contribution |
|---|---|
| status critical | 1.0 |
| status degraded | 0.5 |
| status healthy or unknown | 0 (no evidence is not partial failure) |
| ML anomaly score `a`, persistent | `a × 0.8` |
| ML anomaly score `a`, single window | `a × 0.3` |

These combine as independent routes: `p0 = 1 − Π(1 − contribution)`.

Risk then flows along dependencies with a **noisy-OR**:

```
P(n) = 1 − (1 − p0(n)) × Π over callees c of (1 − τ · w(n→c) · P(c))
```

- **τ = 0.7** (`DEFAULT_TRANSMISSION`) is the share of a dependency's failure that reaches its caller. It is below 1 because real services retry, time out, cache and degrade gracefully.
- The model is solved by iterating to a fixed point (tolerance 1e-6, at most 200 iterations). P only ever rises from p0 and is bounded by 1, so cycles converge.

Published per service:

| Field | Meaning |
|---|---|
| `failureProbability` | P(n), the total |
| `affectedProbability` | the part arriving through dependencies alone, never more than the total |
| `cascadeVia` | **id** of the dependency contributing the most inherited risk; shown only when inherited ≥ 0.15 |
| `cascadeDepth` | hops back to where the risk originates |

Bands: **high** ≥ 0.7, **elevated** ≥ 0.4, **low** ≥ 0.15, **minimal** below that. A service is **at risk** when its own state is fine (p0 < 0.15) but P ≥ 0.15, meaning the cascade would reach it next.

> [!IMPORTANT]
> These are estimates under a stated model with a stated parameter, not observed frequencies. Nothing has been calibrated against real cascades, because the system does not yet record whether a predicted failure happened. Every prediction carries `model: 'noisy-or-propagation'` and `transmission: 0.7`, so this is never hidden.

---

## Step 4: criticality, centrality and risk

**Criticality** is the share of the project's traffic that would be disrupted if this service failed *on its own*, starting from an otherwise healthy system. The model is run with p0 = 1 for that service and 0 for everyone else, and then:

```
disrupted = Σ over edges of traffic(e) × (1 − (1 − P(source)) × (1 − P(target)))
criticality = disrupted / total project traffic
```

Traffic is each link's activity *baseline*, so a link that went quiet because its callee died still counts for what it normally carries. An edge counts as disrupted if either end has failed: calls into a failed callee fail, and a failed caller stops making calls.

It replaced plain reachability, which treated any chain of calls as total failure. On the simulated shop, a queue that only `shipping` uses scored **66%** (it "reached" the frontend through shipping → orders → frontend). Through the cascade model it scores about **8%**.

**Centrality** is degree over observed edges, divided by the busiest service's degree in the same project.

**Risk** is half current condition and half structural importance:

```
riskScore = 0.5 × (1 − healthScore) + 0.5 × criticality      (or 1 − healthScore if criticality is null)
```

`criticality` and `centrality` are `null`, not 0, when the project has nothing to divide by (no observed traffic, no observed edges).

---

## Worked example (real engine output)

Five services from the simulated shop, observed traffic directed by listening ports:

```
frontend ──0.60──► orders ──0.75──► orders-db
    │                 │
    └─0.40─► catalogue└─0.25─► payment          (numbers are edge weights)
```

**Everything healthy.** Every P is 0. Structural criticality: `orders` 0.92, `orders-db` 0.74, `frontend` 0.33, `payment` 0.31, `catalogue` 0.19. Risk is half that (health is 1.0 everywhere): `orders` 0.46. What-if `orders-db` fails: `orders` 0 → 0.525 and `frontend` 0 → 0.22, so 0.745 additional expected failures.

**`orders-db` goes critical, and `orders` carries a persistent anomaly score of 0.6:**

| Service | p0 | P | inherited | band | via | risk |
|---|---|---|---|---|---|---|
| `orders-db` | 1.00 | 1.000 | 0 | high | - | 0.77 |
| `orders` | 0.48 (0.6 × 0.8) | **0.753** | 0.525 | high | `orders-db` | 0.54 |
| `frontend` | 0 | **0.316** | 0.316 | low | `orders` | 0.17 |
| `catalogue`, `payment` | 0 | 0 | 0 | minimal | - | ≤ 0.16 |

Check `orders` by hand: `1 − (1 − 0.48) × (1 − 0.7 × 0.75 × 1.0) = 1 − 0.52 × 0.475 = 0.753`. `frontend` is **at risk** (fine on its own, P ≥ 0.15), with path `frontend > orders > orders-db`.

`orders` health is 0.85: status 0.60 + anomaly 0.25 × 0.4 = 0.10 + incident 0.15. `orders-db` health is 0.20: with no anomaly score, the weights renormalise to 0.80 and 0.20, and only the incident part remains.

---

## What-if and blast radius

Two different answers to "what if this one failed?":

| | What-if (`/api/reliability/whatif/:id`) | Blast radius (`/api/reliability/blast-radius/:id`) |
|---|---|---|
| Method | re-runs the cascade model with p0 = 1 for the origin; everything else keeps its measured state | walks callers of callers over **observed** edges |
| Answer | each affected service's baseline → new probability and the **delta**; expected additional failures | each dependent's hop distance and `shareOfItsDependencies` (how much of what it calls is inside the radius) |
| Strength | weighs how much each service actually relies on the failing one | needs no model and no parameter: pure structure |

Blast radius walks **against** the arrow (in-edges), because a failing database breaks its callers. The original version walked out-edges, which answers "what does it call", close to the opposite question. Unmeasured traffic gives `shareOfItsDependencies: null`, not 0.

Both are reads over data already collected. Neither touches the target.

---

## The cycle, in order

```typescript
// server/index.ts, every POLLING_INTERVAL_MS (5 s), and once at boot
for (const target of targets) incidentManager.evaluateTarget(target.targetId);
riskEngine.recomputeAll(incidentManager.getAllActiveIncidents());  // weights → risk → cascade
graphStore.requestBroadcast();                                       // ≤ 1 graph-update per 3 s
```

Incidents run first, so the incident factor in health reflects this cycle. Risk runs before the broadcast, so the numbers on screen never lag a cycle behind.
