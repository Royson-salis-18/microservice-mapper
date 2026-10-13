# The rules the project is built on

Most of the code in this repository follows from a short list of rules. When the code looks stranger than it needs to be (a field left `null` when `0` would be simpler, a score split into named parts, a loop that waits for itself), one of these rules is usually the reason. This chapter states each rule, says why it exists, and points to where it shows up in the code. Several rules were written down only after breaking them caused a real bug, and those bugs are listed too.

---

## 1. Nothing is installed on the target

**The rule.** The mapper watches a running system from outside, over a single SSH connection. It runs read-only commands (`docker ps`, `docker inspect`, `docker stats`, `cat /proc/<pid>/net/tcp`) and nothing else. No agent, no sidecar, no library added to the services, no changed config.

**Why.** It lets you point the tool at a system you do not own, or one you cannot redeploy, and know you have not changed what you are measuring. It also limits what can go wrong to "a read failed".

**What it costs.** Without instrumentation there is no per-request data by default. You can see that `orders` holds sockets to `orders-db`, but not how many requests went over them or how long each took. That gap is why the [three tiers of evidence](18-telemetry-tiers-plan.md) exist, and why most of the precision work is about squeezing honest numbers out of socket tables.

**Where.** `server/telemetry-platform/src/connection/RemoteCommand.ts` (every command that is ever run), `server/telemetry-platform/src/connection/` (SSH).

---

## 2. Observed beats declared

**The rule.** A `depends_on` line in a compose file is only a claim. A socket that is open between two containers is a fact. Both are kept, but they are never treated as equal.

**Why.** Config drifts from reality. Services get re-pointed, sidecars appear, and declared dependencies go unused. Root cause and cascade prediction are only as good as the edges under them.

**Where.** Each edge's confidence comes from its evidence (`server/graph/EdgeWeights.ts`):

| Evidence | Confidence |
|---|---|
| seen in request logs (`http-log`) | 1.00 |
| observed; direction from a listening port | 1.00 |
| observed; direction from the ephemeral port range | 0.85 |
| observed, no direction evidence recorded | 0.70 |
| observed, direction could not be decided | 0.50 |
| declared in config, never seen carrying traffic | 0.40 |
| candidate only (shared network) | 0.00 |

RCA gives +0.20 for an observed edge and +0.05 for a declared-only one. Blast radius, centrality and criticality walk observed edges only. RCA propagation and the cascade model use every edge but weight each by its confidence, so a declared-only link counts for 40% of an observed one.

---

## 3. Unmeasured is `null`, never `0`

**The rule.** `0` means "measured, and it was zero". If a number was not measured, it is `null`, or the field is left out.

**Why.** On screen, a made-up zero looks exactly like a real one. "This link is idle" and "we have not measured this link" lead to opposite decisions.

**Where it shows up:**

- Metrics are built with `num()` in `EndpointDiscoveryEngine.ts`, which returns `null` rather than `0` for a missing figure.
- An edge with no observations has no `activity` field at all (`GraphStore.applyEdgeActivity`).
- `criticality` and `centrality` are `null` when the project has nothing to divide by (`RiskEngine.ts`).
- A health factor with no data is dropped, and the remaining weights are renormalised. It is never filled with a middle value.
- The 2D card meters show `—`, not `0.0%`.
- A service with no trained model is absent from `latest_scores.json`. It is never given a default score.

**Broken once:** the anomaly baseline in `server/rca/AnomalyDetector.ts` used `value || 0`, so every missing sample pulled the average towards zero, and the next real reading looked like a spike. It now filters missing values out.

---

## 4. Every number can be checked by hand

**The rule.** Every score is plain arithmetic over named inputs, and its parts are published next to it.

**Why.** An operator has to decide whether to believe a number. A breakdown they can recompute is something they can trust or reject. A single opaque figure is not.

**Where:**

- RCA scores are a sum of named factors (`scoreBreakdown`), each with a reason string.
- `healthScore` ships with `healthBreakdown`, and the parts add up to the score exactly. The total is built from the rounded parts, so rounding can never break the sum.
- Each edge weight is published as `confidence × dependency` (× 0.1 for telemetry), with the basis of each part.
- Every cascade prediction carries `model: 'noisy-or-propagation'` and its `transmission` parameter.
- The constants (`MATERIAL_REACH`, `TELEMETRY_FACTOR`, `LINK_THRESHOLDS`, `DEFAULT_TRANSMISSION`) are exported, so tests and this wiki use the same values the code does.

---

## 5. Call things what they are

**The rule.** A field's name and its UI label say exactly what was measured, even when a grander name would read better.

| Name used | Name avoided | Why |
|---|---|---|
| `samplesPerMin` / "relative activity index" | requests per minute | It counts socket sightings, and one long-lived connection is seen in every sweep |
| `openConnections`, `newConnectionsPerMin` | connections per minute | Distinct keys, counted once each (see [Measuring precisely](31-measurement-precision.md)) |
| `riskScore` = "current exposure" | failure probability | It mixes current health with structural importance. It is not a forecast |
| `failureProbability`, labelled with its model and τ | "chance of failure" | It is an estimate under a stated model and has not been calibrated against real outcomes |
| `flag_rate` (holdout) | accuracy | The holdout has no labels. The number says how often the model fires, not whether it is right |
| CPU "% of its 2-core allowance" | CPU % | Docker reports a percentage of one core, so 150% is normal on a 2-core limit |

---

## 6. One definition, used everywhere

**The rule.** When two places need the same idea, they share one definition. They do not keep two copies that drift apart.

- **Service ids** are `project:name` everywhere. Incidents used to list bare names while `rootCauseServiceId` held an id, so any code matching one against the other silently found nothing. `cascadeVia` had the same bug.
- **Link thresholds** (slow at 300 ms, very slow at 1 s, errors at 1% and 5%) are defined once on the server (`server/graph/linkThresholds.ts`) and once on the client (`edgeHeat.ts`). A test asserts the two are identical.
- **Link appearance** comes from one function, `edgeAppearance()`, used by the 2D canvas, the 3D scene and the inspector. A link cannot look calm in one view and hot in another.
- **CPU shown** comes from one helper, `cpuShown()` (share of allowance when known, raw otherwise), used by every view.

---

## 7. An arrow means "calls", and failure moves against it

**The rule.** An edge `A → B` means A calls B. A depends on B, so if B fails, A is hit. Failure therefore moves against the arrow.

**Why it matters.** It is easy to get backwards, and everything downstream flips if you do. Blast radius originally walked out-edges and listed what a database *calls* (nothing) instead of who calls *it*.

**Where.** Direction comes from the listening port (`orientConnection()` in `MetricCollector.ts`, see [Lifecycle and direction](06-node-edge-lifecycle.md)). RCA coverage, propagation, blast radius and the cascade model all walk callee → caller.

---

## 8. Compare like with like

- **Per project.** Degree, traffic share and criticality are computed inside one stack. Ranking a sock-shop service against a death-star one would compare two unrelated systems.
- **Per kind.** A caller's traffic shares are split within functional calls and, separately, within telemetry calls. A service that sends most of its packets to a trace collector still depends 100% on its database.
- **Per service.** Every ML model is trained on one service's own history. A database using 500 MB is normal, and a frontend using 500 MB is not.

---

## 9. Rules and models stay separate

Incidents come from fixed rules. Findings come from learned models. They are never merged, because if the alerts came from the models, judging the models would mean grading them against their own output. See [Two opinions, kept apart](17-findings-vs-incidents.md).

---

## 10. Be light on the target

The mapper reads someone else's production host, so it costs as little as it can:

- **Loops wait for themselves.** The next poll or sweep starts 5 s *after* the previous one finishes, never on a fixed `setInterval`. Fixed timers let slow cycles overlap until they hit the SSH server's `MaxSessions` limit, and then about 2.6 scans per cycle were silently refused.
- **One read per container per sweep.** Socket table and interface counters come back from the same `exec`, split at a marker line.
- **Full rediscovery only every 180 s.** It costs a `docker ps` plus one `docker inspect` per container.
- **Going deeper needs consent.** Tier 2 (querying a target's own Prometheus) is switched on per target with `telemetrySources.prometheus.enabled` in `remote_config.json`. A reachable Prometheus is not, by itself, permission to query it on a loop. When it is enabled, the query runs on the target (Prometheus is usually bound to localhost there), and a failure there can never cost the Tier 0 metrics.

---

## 11. The system checks itself

Every relationship between published numbers that has been seen broken in live output becomes a rule in `server/graph/consistency.ts`. The rules are checked on demand at `GET /api/diagnostics/consistency`, by a chip in the 3D HUD, and in the test suite. See [Keeping the numbers honest](32-accuracy-and-self-check.md).

---

## 12. Calm by default; warm colours mean trouble

The interface is dark navy and indigo with restrained light. Orange and red appear only when something is slow, erroring or down, never just because a link is busy. Busy links get brighter blues. Bloom is off by default and 2D cards are flat and matte; links are lit clearly (azure to ice cyan) without bloom, so the light comes from the data, not from post-processing. See [Reading the picture](33-visual-language.md).

---

## Design decisions, and what they were chosen over

| Decision | Alternatives considered | Why this one | Where |
|---|---|---|---|
| SSH + docker CLI + `/proc` | An agent per host, eBPF, a service mesh | Needs nothing installed; works on any Docker host you can SSH to | `RemoteCommand.ts` |
| Direction from the LISTEN port | Trusting the scanned container as the source | Every connection is seen from both ends; the scan's view produced a reversed duplicate of every link | `orientConnection()` |
| Distinct connection keys per sweep | Counting socket rows | A long-lived connection shows up in every sweep; rows overcount it by the number of sweeps | `GraphStore.recordConnectionSweep` |
| Byte counters from `/proc/<pid>/net/dev` | `docker stats` NET I/O | Docker rounds to three significant figures, so a 9.87 MB counter moves in 10 kB steps | `parseNetDev()` |
| In-memory graph + JSON snapshot | A database | Tens of nodes per target; recomputing every 5 s is cheaper than querying | `GraphStore.ts`, `server/data/graph_db.json` |
| WebSocket push, coalesced to ≤ 1 per 3 s | Client polling | One fan-out per change; bursts from several targets merge into one frame | `requestBroadcast()` |
| Python ML as a separate process that talks through files | ML inside Node | scikit-learn lives in Python; the server only reads one JSON file, cached on its mtime | `ml/`, `GraphStore.readAnomalyScores` |
| Four detectors, majority vote, median score | Isolation Forest alone | Different model families only add information when they could disagree; the median resists one misbehaving detector | `ml/ensemble.py` |
| Additive RCA factors | A trained classifier | There are no labelled incidents to train on; additive factors can be explained | `RCAEngine.ts` |
| Noisy-OR cascade with τ = 0.7 | Plain reachability | Reachability treated any chain as total failure (66% criticality for a queue; the cascade model gives about 8%) | `CascadeEngine.ts` |
| XYFlow for 2D, react-three-fiber for 3D | D3, Cytoscape, raw three.js | React components all the way down; memoised nodes keep re-renders proportional to what changed | `client/src/components/` |
| Islands layout for 3D | A grid, a "server room", a building | Sections read at a glance; districts per project; the room and building versions were tried and rejected as boring | `3d/site.ts` |
