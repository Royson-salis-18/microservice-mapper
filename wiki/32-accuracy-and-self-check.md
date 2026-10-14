# Keeping the numbers honest

A monitoring tool is only useful if its numbers can be believed. This project relies on three things for that:

1. **Ground truth.** A simulated target whose true state is known exactly, so every published figure can be compared with the real answer.
2. **Invariants.** Rules that relate the published numbers to each other, checked live by the server and in the tests.
3. **Tests that pin the arithmetic.** Fixtures with hand-computed answers for every formula in the book.

This chapter covers all three, and the bugs they caught.

---

## 1. Ground truth: the simulated target

The live targets are EC2 hosts. They are often stopped, and when they are running you never know the true root cause of what you are looking at. `scripts/simulate-target.ts` fixes that. It plays a ten-service shop (frontend, catalogue, carts, orders, payment, shipping, three databases and a queue) and pushes telemetry envelopes to the real `POST /api/ingest`. That is the same `GraphStore.ingestRemote()` path the SSH collector feeds, so everything downstream runs for real.

What makes it useful is that its socket model is known exactly:

| Simulator truth | What the mapper should report |
|---|---|
| `PERSISTENT = 2` long-lived connections per link | `openConnections` = 2 |
| new connections at a tenth of the link's request rate | `newConnectionsPerMin` = rate / 10 |
| closed connections stay in `TIME_WAIT` for 60 s | not counted twice |
| each connection reported from both ends | counted once |

It also has scripted failures with a known cause:

| Scenario | What really happens | What RCA should say |
|---|---|---|
| `baseline` | everything healthy | no incident |
| `db-crash` | `orders-db` exits (137); then `orders`, then `frontend` degrade | root cause `orders-db` |
| `slow-payment` | `payment` saturates; `orders` degrades after it | root cause `payment` |
| `crash-loop` | `carts-db` crash-loops; `carts` degrades after it | root cause `carts-db` |

The simulator only ever uses target ids starting `sim-` and is meant to run against an **isolated** server (a separate port, separate working directory and ingest token), so simulated data never mixes with a real target's graph. The steps are in [Working on it](35-dev-workflow.md).

**Results from the last audit:**

- `openConnections` was exact on **9 of 9** links.
- `newConnectionsPerMin` had a mean error of **1.4%** (worst 4.4%) once the 120 s window had filled.
- In `db-crash`, RCA named `orders-db` as root cause with **HIGH** confidence. `affectedServices` were ids, and every one resolved to a node in the same project.
- The consistency check reported **0 violations**.

---

## 2. Invariants: the consistency check

`algorithms/graph/consistency.ts` holds `checkConsistency(nodes, edges, incidents)`. It is a pure function: give it the graph and the incidents, and it returns what is wrong. Every rule in it was written after the thing it checks was seen broken in live output.

| Rule | What must hold | The bug that prompted it |
|---|---|---|
| `edge-endpoints` | every link joins two known services | edges outliving pruned nodes |
| `health-breakdown-sum` | the health factors add up to `healthScore` (±0.011) | rounding parts separately from the total |
| `score-range` | probabilities and scores are within 0–1; an incident's `rootCauseScore` too | unclamped penalties |
| `inherited-within-total` | risk inherited through dependencies ≤ total predicted risk | |
| `cascade-via-is-dependency` | `cascadeVia` names a service this one actually calls, by id | `cascadeVia` held a bare name |
| `metric-range` | percentages within 0–100; nothing negative | |
| `rate-not-total` | network rates below 10 GB/s | a cumulative byte count shown as a rate |
| `weight-formula` | weight = confidence × reliance (× 0.1 for telemetry) | |
| `reliance-sums-to-one` | each caller's shares, per kind, sum to 100% (±2%) | shares summing to 183% |
| `activity-range` | connection figures are non-negative | |
| `incident-references` | incidents name services that exist, by id, in their own project | names in `affectedServices`, ids in `rootCauseServiceId` |
| `root-cause-is-candidate` | the named root cause is one of the scored candidates | |

It runs in three places:

- **Live:** `GET /api/diagnostics/consistency` returns `{ checkedAt, nodes, edges, incidents, rulesChecked, violations: [{ rule, subject, detail }] }`.
- **In the UI:** the 3D HUD polls that endpoint every 30 s and shows a chip, `✓ consistent` or `N data issues`.
- **In the tests:** the pipeline tests run the check over fixtures, so a regression is caught before it ships.

---

## 3. Tests that pin the arithmetic

`npm test` runs `tests/*.test.ts` with Node's built-in runner under tsx. The suites:

| File | Covers |
|---|---|
| `tests/logic.test.ts` | link severity (orange and red), shared thresholds (server = client), `linkFlow` and pulse timing, the islands layout (platform heights, no overlap, tracks only between sections that call each other) |
| `tests/pipeline.test.ts` | weights summing to 1, RCA on faint paths, the independent-failure rule, explanation counts, ids in incidents, `decodeProcNetIp`, `parseNetDev`, CPU allowance, the consistency checker |
| `tests/riskEngine.test.ts` | health renormalisation and its exact sum, the null-versus-zero rule, resolved incidents not counting, criticality (shared dependency versus leaf), blast radius direction and cycles, edge direction from listening ports |
| `tests/security.test.ts` | everything that reaches a remote shell is validated: container ids, timestamps, paths and `tail` counts refuse injection payloads, and no command keeps an unexpanded placeholder |

Each formula is tested against a hand-computed answer, not against whatever the code returned the first time it was run. When this chapter was written the suite stood at **132 passing**, with both TypeScript projects compiling cleanly and no lint errors.

---

## What the audit found, and what changed

| Area | Was | Now |
|---|---|---|
| Dependency shares | unmeasured edges got `1/N` on top of a full measured split; one caller summed to 183% | always sums to 1 per caller and kind |
| RCA "explains" | credited through paths of strength 0.004, so the independent-failure rule never fired | only paths ≥ `MATERIAL_REACH` (0.1) count |
| RCA factor list | "+0.00 explains 7 of 8" | factors under 0.01 are not listed; the count only includes material paths |
| Independent failures | a root cause was named even when it explained nothing | confidence is forced to LOW and the explanation says so |
| Incident ids | `affectedServices` held names, `rootCauseServiceId` an id | all ids, displayed by short name |
| `cascadeVia` | a bare name | an id |
| Network | Docker's rounded figure; totals displayed as rates | exact `/proc` counters plus real bytes/s |
| CPU | % of one core judged against 80% | % of the container's allowance |
| CPU limits | read only when the cache was empty | read for every new container |
| Connections | socket rows per minute | distinct open and new connections |
| IPv6 tables | IPv4-mapped addresses dropped | decoded to IPv4 |
| Link status | server and client disagreed; mean latency only | shared thresholds; p95 when available |
| Missing samples | `value \|\| 0` in the anomaly baseline | missing values filtered out |
| Evidence text | "0%" for unmeasured figures | "not measured" |

---

## Where the limits still are

Being exact about the limits is part of being accurate:

- **No per-request data at Tier 0.** Request rate, latency and errors exist only where a gateway log (Tier 1) or Prometheus (Tier 2) covers the link. Elsewhere they are `null`, and the link's colour reflects connections and callee status only.
- **The cascade probabilities are uncalibrated.** They follow a stated model (noisy-OR, τ = 0.7). No record exists yet of predicted failures that actually happened.
- **The ML holdout has no labels.** `flag_rate` is a firing rate, not an accuracy.
- **Collector changes need a live check.** The `/proc/net/dev`, IPv4-mapped and CPU-allowance paths are unit-tested and pass the simulator, but have not yet been checked against a running EC2 target.
