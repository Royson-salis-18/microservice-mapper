# Data Models - TypeScript Interfaces Reference

All models are defined in two places:
- **Server canonical:** `server/models/` (individual files per type)
- **Client mirror:** `client/src/types/index.ts` (flat file, kept in sync manually)

---

## `ServiceNode`

```typescript
interface ServiceNode {
  // Identity
  id:      string;  // Canonical: "${targetId}:${serviceName}" e.g. "sock-shop:catalogue"
  name:    string;  // Short service name: "catalogue"
  type:    'gateway' | 'service' | 'database' | 'queue' | 'frontend' | 'infrastructure' | 'external';
  project: string;  // targetId: "sock-shop"

  // Health
  status:   'healthy' | 'degraded' | 'critical' | 'unknown';
  lastSeen: string;  // ISO-8601 - server clock, not collector clock

  // Container metadata
  metadata: {
    containerId?:   string;   // Docker container ID (short or full)
    image?:         string;   // Docker image name + tag
    ports?:         string[]; // ["80/tcp", "443/tcp"]
    uptime?:        string;   // Human-readable: "2d 14h 32m"
    restartCount?:  number;
    state?:         string;   // Docker state: "running", "exited", "dead"
    [key: string]:  any;      // Extensible for future fields
  };

  // Current metrics (latest values, fast path from ingestRemote).
  // A figure that was not measured is null or absent, never 0.
  metrics: {
    cpu?:               number | null; // % of ONE core, as docker reports it (200 = two full cores)
    cpuAllowanceCores?: number | null; // cores it may use: --cpus / CpuQuota÷CpuPeriod, else host nproc
    cpuOfAllowance?:    number | null; // cpu ÷ allowance, 0–100: what status and the UI use
    memory?:            number | null; // absolute bytes
    memoryPercent?:     number | null; // 0–100, of its memory limit
    networkRx?:         number | null; // CUMULATIVE bytes received (exact /proc counter when fresh)
    networkTx?:         number | null; // CUMULATIVE bytes sent
    networkRxRate?:     number | null; // bytes/second received, from /proc/<pid>/net/dev deltas
    networkTxRate?:     number | null; // bytes/second sent
    networkSource?:     string;        // which source produced the totals
    latency?:           number | null; // mean ms (Tier 1/2 request data only)
    requestRate?:       number | null; // requests/second (Tier 1/2 only)
    errorRate?:         number | null; // 0.0–1.0 (Tier 1/2 only)
  } | null;

  // Analytics: computed every poll cycle (RiskEngine, CascadeEngine) or read from the ML scorer
  analytics?: {
    anomalyScore?:        number;        // 0–1 from the 4-detector ML ensemble (~0.5 = at threshold)
    anomalyPersistent?:   boolean;       // ensemble anomalous for N consecutive windows
    healthScore?:         number | null; // 0–1, weighted & renormalised (status, anomaly, incident)
    healthBreakdown?:     ScoreContribution[]; // parts that sum exactly to healthScore
    riskScore?:           number | null; // current exposure: 0.5×(1−health) + 0.5×criticality. NOT a probability
    criticality?:         number | null; // share of project traffic disrupted if it failed alone
    centrality?:          number | null; // observed degree ÷ busiest node's degree
    failureProbability?:  number | null; // cascade model P(n): noisy-OR, τ = 0.7 (an estimate)
    affectedProbability?: number | null; // the part of P(n) arriving through dependencies
    cascadeVia?:          string | null; // ID of the dependency contributing most inherited risk
    cascadeDepth?:        number;        // hops back to where its risk originates
    upstreamCount?:       number;        // observed callers
    downstreamCount?:     number;        // observed callees
  };
}
```

### Key design notes

**`lastSeen` is always the server's clock:** The collector's machine could have clock skew. Using the server's clock ensures staleness detection (`checkTargetStaleness()`) is consistent.

**`metrics.latency` is null for most services:** Only services whose logs are parsed (gateways, configured services) have HTTP-derived latency. Docker stats don't include latency. Showing `null` is better than showing `0` which would imply "zero latency."

**`metadata` is an open record:** New fields can be added by adapters without changing the interface. The GraphStore merges metadata spreads: `{ ...existing.metadata, ...incoming.metadata }`.

---

## `DependencyEdge`

```typescript
interface DependencyEdge {
  // Identity
  id:     string;  // "${source}->${target}" e.g. "sock-shop:front-end->sock-shop:catalogue"
  source: string;  // Source node ID (canonical)
  target: string;  // Target node ID (canonical)

  // Edge classification
  type:      'http' | 'database' | 'message' | 'dependency';
  protocol?: string;  // "http", "https", "amqp", "rabbitmq", "tcp"

  // Evidence flags
  declared:        boolean;       // true = found in Docker Compose depends_on
  observed:        boolean;       // true = confirmed at runtime (log or TCP)
  evidenceSources: string[];      // ["compose-config", "http-log", "proc-net-tcp"]

  // Timestamps
  firstSeen?: string;  // ISO-8601 - when first observed
  lastSeen?:  string;  // ISO-8601 - most recent confirmation

  // HTTP metrics (from InteractionEvent aggregation)
  metrics: {
    requestCount?: number | null;
    errorCount?:   number | null;
    errorRate?:    number | null;  // 0.0–1.0
    latency?:      number | null;  // Average ms
    p50Latency?:   number | null;
    p95Latency?:   number | null;
    p99Latency?:   number | null;
    bytesSent?:    number | null;
  } | null;

  // HTTP status code breakdown
  statusCodeDistribution?: Record<string, number>;  // {"200": 1247, "404": 3, "500": 12}

  // Socket-level activity (Tier 0). Absent if the link was never observed.
  activity?: {
    samplesPerMin:         number;  // socket SIGHTINGS per minute: a relative activity index
    baselinePerMin?:       number;  // slow average of the above (rise τ 60 s, fall τ 600 s)
    windowSec:             number;  // age of the measurement window
    lastSeen:              string;
    openConnections?:      number;  // distinct ESTABLISHED connections, averaged (≥ 2 sweeps)
    newConnectionsPerMin?: number;  // distinct connections opened per minute
    connectionSweeps?:     number;  // sweeps behind the two figures above
  };

  // How much the caller depends on this callee (RiskEngine, every cycle)
  weight?: {
    value:            number;  // confidence × dependency (× 0.1 for telemetry), 0–1
    dependency:       number;  // caller's share of its traffic going here; sums to 1 per caller and kind
    dependencyBasis:  'requests' | 'activity' | 'uniform';
    kind:             'request' | 'telemetry';
    confidence:       number;  // from evidence: 1.0 listen-port … 0.4 declared-only
    confidenceBasis:  string;
    volume:           number | null;  // activity relative to the busiest link
    stress:           number | null;  // max(errorRate/5%, latency/1 s), capped at 1
  };

  // Computed status: linkStatus(errorRate, p95 ?? latency): ≥1% or ≥300 ms → degraded, ≥5% or ≥1 s → failed
  status: 'active' | 'degraded' | 'failed' | 'unknown';
}
```

### Evidence sources

| Value | Meaning |
|---|---|
| `compose-config` | Found in `depends_on` of the Compose file |
| `http-log` | Observed via container log parsing |
| `proc-net-tcp` | Observed via `/proc/net/tcp` snapshot |
| `direction:listen-port` | Direction decided by the callee's LISTEN row (confidence 1.0) |
| `direction:ephemeral-port` | Direction decided by the ephemeral port range (0.85) |
| `direction:unresolved` | Direction could not be decided; the scan's orientation was kept (0.5) |

An edge can accumulate multiple sources over time. The `evidenceSources.push()` in `ingestRemote()` deduplicates with `includes()` before appending.

---

## `Target`

```typescript
interface Target {
  targetId:     string;  // Short unique ID: "sock-shop"
  displayName:  string;  // Human label: "Sock Shop AWS"
  environment:  'local' | 'remote' | 'aws' | string;
  region?:      string;  // AWS region: "ap-south-1"

  // SSH connection info (from remote_config.json)
  host?:         string;  // EC2 public IP
  sshUsername?:  string;
  sshKeyPath?:   string;
  transport?:    'http' | 'ssh-tunnel' | string;

  // Liveness
  status:   'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA';
  lastSeen: string | null;

  // HTTP endpoint (for health pings)
  baseUrl?:        string;  // "http://18.206.136.26:80"
  publicPort?:     number;
  endpointStatus?: 'REACHABLE' | 'UNREACHABLE' | 'UNCONFIGURED';

  // Feature flags
  capabilities?: {
    dockerMetrics?:    boolean;
    serviceHealth?:    boolean;
    topology?:         boolean;
    httpInteractions?: boolean;
    traces?:           boolean;
  };

  // Discovery summary
  discoverySummary?: {
    serviceCount:    number;
    endpointCount:   number;
    lastDiscoveredAt: string;
  };
}
```

---

## `MetricSnapshot`

```typescript
interface MetricSnapshot {
  timestamp:      string;
  cpu?:           number;        // 0–100 (%)
  memory?:        number;        // Absolute bytes
  memoryPercent?: number;        // 0–100 (%)
  networkRx?:     number;        // Cumulative bytes (exact /proc counter when fresh)
  networkTx?:     number;        // Cumulative bytes
  latency?:       number | null;
  requestRate?:   number | null;
  errorRate?:     number | null;
  restartCount?:  number;
}
```

Stored in `MetricStore` ring buffer. Retrieved via `GET /api/nodes/:id/metrics?range=5m`.

---

## `InteractionEvent`

```typescript
interface InteractionEvent {
  timestamp:      string;
  source:         string;   // Canonical node ID (or "external"/"unknown-upstream")
  target:         string;   // Canonical node ID
  protocol:       string;   // "http", "amqp", etc.
  method?:        string;   // "GET", "POST", etc.
  route?:         string;   // "/catalogue", "/orders"
  statusCode?:    number | null;
  latencyMs?:     number | null;
  bytesSent?:     number | null;
  bytesReceived?: number | null;
  success?:       boolean | null;  // statusCode < 400
  evidenceSource: string;           // "http-log"
}
```

---

## `ConnectionEvent`

```typescript
// SSH-sampled TCP connection from /proc/net/tcp
// NOT a distributed trace span
interface ConnectionEvent {
  timestamp:       string;
  targetId:        string;  // Which target reported this
  sourceServiceId: string;  // Canonical node ID
  destServiceId:   string;  // Canonical node ID
  destPort:        number;  // Destination (callee) port
  state:           string;  // "ESTABLISHED", "TIME_WAIT", …
  connKey?:        string;  // "callerIp:port>calleeIp:port": identifies ONE connection,
                            // so a sweep can count distinct connections instead of rows
}
```

---

## `TelemetryEnvelope`

The payload posted by the remote collector to `POST /api/ingest`:

```typescript
interface TelemetryEnvelope {
  targetId: string;
  events: {
    nodes:            Partial<ServiceNode>[];
    edges:            Partial<DependencyEdge>[];
    metrics:          { nodeId: string; snapshot: MetricSnapshot }[];
    interactions:     InteractionEvent[];
    connectionEvents: ConnectionEvent[];
  };
}
```

All arrays are optional (can be empty `[]`). The server processes only what's present.

---

## `AnomalyRecord`

A symptom found by the **rule-based** `AnomalyDetector` (not the ML ensemble). Used by `RCAEngine` and stored on the incident:

```typescript
interface AnomalyRecord {
  id:              string;
  nodeId:          string;   // project:name
  targetId:        string;
  metric:          string;   // 'container-health', 'cpu', 'memory', …
  timestamp:       string;   // ONSET: kept from the first cycle it appeared, for as long as it lasts
  observedValue:   number;
  baselineMean:    number;
  baselineStdDev:  number;
  zScore:          number;
  severity:        IncidentSeverity;
  evidenceSource?: string;
}
```

---

## `Incident`

One per target, updated in place while open (`server/models/Incident.ts`):

```typescript
interface Incident {
  id:                 string;          // inc-<targetId>-<ms>
  targetId:           string;
  startedAt:          string;
  detectedAt:         string;
  endedAt:            string | null;   // set when RESOLVED
  status:             'NORMAL' | 'DEGRADED' | 'INCIDENT' | 'RECOVERING' | 'RESOLVED';
  severity:           'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

  rootCauseServiceId: string | null;   // an ID
  rootCauseEdgeId:    string | null;
  rootCauseScore:     number;          // 0–1
  confidence:         'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

  symptoms:           string[];
  anomalies:          AnomalyRecord[];
  propagation:        PropagationStep[];   // root → callers, with edge, weight, evidence
  affectedServices:   string[];            // IDs of every symptomatic service
  candidateCauses:    CandidateCause[];    // each with scoreBreakdown: ScoreContribution[]
  evidence:           EvidenceItem[];
  explanation:        RCAExplanation;      // whatHappened, why, propagationPath, alternatives…
  remediationGuide:   string[];
}

interface ScoreContribution { factor: string; score: number; reason: string }   // also used by healthBreakdown
interface CandidateCause {
  serviceId: string; serviceName: string; score: number; confidence: RCAConfidence;
  scoreBreakdown: ScoreContribution[]; earliestAnomalyTimestamp?: string; primaryAnomalyMetric?: string;
}
```

Every service reference in an incident is a node **id**. It used to mix names and ids, and code that matched one against the other silently found nothing. The consistency rule `incident-references` now enforces it.

