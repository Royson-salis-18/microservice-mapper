# A tour of the code

This chapter is a map for reading the source. It shows where things live, then follows one measurement from a socket on the target host to a pulse of light on your screen, then one failure from a crashed container to the incident panel. It ends with a table of where to make common changes.

---

## The repository

```
microservice-mapper/
├── server/                     Node + TypeScript, Express 5, ws, ssh2        (:3001)
│   ├── index.ts                boot; the 5 s cycle: incidents → risk → broadcast
│   ├── config.ts               PORT, POLLING_INTERVAL_MS, INGEST_TOKEN
│   ├── api/
│   │   ├── routes.ts           every REST endpoint under /api
│   │   └── websocket.ts        the /ws server and terminal relay
│   ├── connection/             SSH: ConnectionManager, SSHConnection
│   ├── discovery/
│   │   ├── EndpointDiscoveryEngine.ts   one per target: discover, poll, sweep, recover
│   │   └── engine/             classifyService, serviceIdentity, compose parsers
│   ├── telemetry-platform/src/
│   │   ├── connection/RemoteCommand.ts  EVERY command ever run on a target
│   │   └── collection/
│   │       ├── MetricCollector.ts       docker stats, /proc/net/tcp(6), /proc/net/dev, direction
│   │       └── containerHealth.ts       status from a sample (CPU vs allowance, state)
│   ├── graph/
│   │   ├── GraphStore.ts       the in-memory model; ingest, ids, activity, connections
│   │   ├── EdgeWeights.ts      confidence × dependency
│   │   ├── RiskEngine.ts       health, risk, criticality, blast radius; runs the cascade
│   │   ├── CascadeEngine.ts    the noisy-OR model, what-if
│   │   ├── linkThresholds.ts   slow / very slow / error thresholds
│   │   └── consistency.ts      the 12 invariants
│   ├── rca/                    IncidentManager, AnomalyDetector, RCAEngine, Explanation, thresholds
│   ├── telemetry/MetricStore.ts    per-service ring buffers (history for z-scores and charts)
│   ├── telemetry-sources/      Tier 2: PrometheusSource (opt-in per target)
│   ├── traces/                 trace capture and aggregation
│   ├── traffic/                TrafficController, ExperimentManager
│   ├── models/                 ServiceNode, DependencyEdge, Incident, TelemetryEnvelope
│   └── data/                   remote_config.json, graph_db.json, incident_thresholds.json
│
├── client/src/                 React 19 + Vite                                (:5173)
│   ├── App.tsx                 view routing, selection, filters
│   ├── hooks/useGraphData.ts   WebSocket → nodes/edges, reusing unchanged objects
│   ├── components/
│   │   ├── GraphCanvas.tsx, ServiceNode.tsx, DependencyEdge.tsx     2D (XYFlow)
│   │   ├── InspectionPanel.tsx, EdgeInspectionPanel.tsx            click-to-inspect
│   │   ├── shared/edgeHeat.ts, linkFlow.ts, serviceVisuals.ts      ONE visual language
│   │   ├── 3d/Scene3D.tsx, site.ts, Islands.tsx, Edge3D.tsx, Node3D.tsx, SceneHud.tsx
│   │   └── RCAView, ReliabilityView, FindingsView, MLPipelineView, TelemetryView…
│   └── types/index.ts          mirrors server/models
│
├── ml/                         Python: collector → preprocess → train → score (+ ensemble.py)
├── traffic-gen/                Node load generator                            (:4400)
├── scripts/
│   ├── simulate-target.ts      the ground-truth target
│   └── build_wiki_visualizer.py   builds this book
├── tests/                      node:test suites (npm test)
└── wiki/                       the markdown this book is built from
```

---

## Follow a measurement: a socket on the host → a pulse on screen

| # | Where | What happens |
|---|---|---|
| 1 | `GraphStore` constructor → `loadTargetsFromConfig()` | Each target in `server/data/remote_config.json` gets an `EndpointDiscoveryEngine` |
| 2 | `EndpointDiscoveryEngine` + `ConnectionManager` | Opens one SSH connection, reused across many `exec` channels, and recovers it if the host goes quiet |
| 3 | `refreshDiscovery()` | `docker ps` and `docker inspect`, plus compose files → named, classified services with declared dependencies |
| 4 | **sweep** loop → `MetricCollector.collectObservedEdges()` | Per container, one `exec` of `RemoteCommand.dockerContainerTcp`: tcp, tcp6, a marker line, net/dev |
| 5 | `decodeProcNetIp()`, `orientConnection()` | Hex addresses become IPs (IPv4-mapped included). The listening end is the callee. Each event gets a `connKey` |
| 6 | `parseNetDev()`, `recordNetwork()` | Exact byte counters, and bytes/s from the previous read |
| 7 | `translateMetricsToEnvelope()` → `onTelemetryCollected()` | Builds a `TelemetryEnvelope`, the same shape `POST /api/ingest` accepts |
| 8 | `GraphStore.ingestRemote()` | `normalizeId()` makes ids `project:name`; nodes merged; edges upserted with evidence; activity counted; `recordConnectionSweep()` |
| 9 | `getGraph()` → `applyEdgeActivity()` | `samplesPerMin`, baseline, `openConnections`, `newConnectionsPerMin` |
| 10 | `server/index.ts` `runPollingCycle()` | Incidents, then `RiskEngine.recomputeAll()` (weights, risk, cascade), then `requestBroadcast()` |
| 11 | `requestBroadcast()` | One `graph-update` frame, at most every 3 s, to every browser |
| 12 | `client/src/hooks/useGraphData.ts` | Receives it; reuses any node or edge whose *displayed* values did not change, so React skips it |
| 13 | `GraphCanvas` → `DependencyEdge` | `edgeAppearance()` sets the colour, the weight sets the width, `linkFlow()` + `svgPulses()` set the pulses |
| 14 | `Scene3D` → `Edge3D` | The same `edgeAppearance()` and `linkFlow()`; an instanced pulse pool advanced by `pulses × Δt` |

---

## Follow a failure: a crashed container → the incident panel

| # | Where | What happens |
|---|---|---|
| 1 | poll loop → `statusFromSample()` | `orders-db` reads `exited (137)` → status `critical`, with a reason |
| 2 | `IncidentManager.evaluateTarget()` | Runs every cycle for every target |
| 3 | `AnomalyDetector.detectAnomaliesForTarget()` | Container-health anomaly; onset time remembered |
| 4 | `RCAEngine.analyzeIncident()` | Candidates scored: precedence, status, evidence, explains, victim penalty |
| 5 | same | Propagation walked from the root to its callers |
| 6 | `ExplanationEngine` | The plain-language story |
| 7 | `IncidentManager` | Incident opened or updated in place: ids, severity, confidence |
| 8 | `server/index.ts` | `incident.updated` broadcast **only if** its visible signature changed |
| 9 | `RiskEngine.recomputeAll()` | Health sees the open incident; the cascade marks the callers at risk |
| 10 | `RCAView`, `InspectionPanel` | Root cause, factor bars, path; each service's role (root, candidate, affected) |

---

## Five snippets worth knowing

**Every remote command lives in one file**, built from validated inputs only:

```typescript
// server/telemetry-platform/src/connection/RemoteCommand.ts
dockerContainerTcp: (containerId: string): RemoteCommand<string> => ({
  command: `PID=$(docker inspect ${sanitizeContainerId(containerId)} --format '{{.State.Pid}}' 2>/dev/null); ...
            cat /proc/$PID/net/tcp /proc/$PID/net/tcp6 2>&1; echo '${NETDEV_MARKER}'; cat /proc/$PID/net/dev 2>/dev/null; fi`,
```

**A weight is two parts multiplied**, published with its basis:

```typescript
// server/graph/EdgeWeights.ts
value: round3(Math.min(Math.max(confidence * dependency * factor, 0), 1)),
```

**A root cause has to explain something material:**

```typescript
// server/rca/RCAEngine.ts
const material = (id: string) => { const r = reach.get(id) ?? 0; return r >= MATERIAL_REACH ? r : 0; };
```

**The cascade is one line of probability**, iterated to a fixed point:

```typescript
// server/graph/CascadeEngine.ts
survive *= 1 - tau * e.weight!.value * (P.get(e.target) ?? 0);
```

**One colour decision for every view:**

```typescript
// client/src/components/shared/edgeHeat.ts
if (errorRate != null && errorRate >= LINK_THRESHOLDS.errorCritical) return { heat: 'failed', ...RED, ... };
```

---

## Where to change things

| To change… | Edit | Also update |
|---|---|---|
| a command run on targets | `RemoteCommand.ts` | `tests/security.test.ts` |
| when a container counts as degraded | `containerHealth.ts` | wiki 31 |
| incident sensitivity | the Incidents page, or `server/data/incident_thresholds.json` | (no code change needed) |
| link slow or error thresholds | `server/graph/linkThresholds.ts` **and** `client/.../edgeHeat.ts` | the equality test fails until both match |
| an RCA factor or weight | `RCAEngine.ts` constants | wiki 08 and its lab in `build_wiki_visualizer.py` |
| health weights, τ, risk bands | `RiskEngine.ts`, `CascadeEngine.ts` | wiki 22 and its lab |
| a published invariant | `consistency.ts` (and bump `RULES`) | wiki 32 |
| an API endpoint | `server/api/routes.ts` | wiki 13 |
| a node or edge field | `server/models/*` **and** `client/src/types/index.ts` | wiki 12 |
| a view | a component, plus an entry in `Sidebar.tsx` and a branch in `App.tsx` | wiki 09 |
| a 3D layout | `client/src/components/3d/layouts.ts` (+ `site.ts` for islands) | `tests/logic.test.ts` |
| ML features or sensitivity | `ml/config.json` (or the ML page) then retrain | wiki 11 |

---

## Reading the code in an afternoon

1. `server/models/ServiceNode.ts` and `DependencyEdge.ts`: the vocabulary.
2. `server/index.ts`: the heartbeat.
3. `server/graph/GraphStore.ts`, `ingestRemote()` and `getGraph()`: the centre.
4. `server/graph/EdgeWeights.ts`, then `RiskEngine.ts` and `CascadeEngine.ts`: the arithmetic.
5. `server/rca/RCAEngine.ts`: judgement.
6. `client/src/hooks/useGraphData.ts`, then `components/shared/*`: how it becomes pixels.
7. `tests/*.test.ts`: every claim above, pinned to a number.
