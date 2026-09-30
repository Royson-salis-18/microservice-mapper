# 20 — Traffic Controller & Experiment System

## Overview

The traffic subsystem (`server/traffic/`) orchestrates synthetic load generation against monitored targets, manages experiment lifecycle, and feeds telemetry data into the ML pipeline. It bridges the mapper server with an external `traffic-gen` Node.js service via HTTP and WebSocket.

## Architecture

```
┌──────────────────┐     HTTP/WS      ┌──────────────────┐
│  TrafficController│ ◄──────────────► │   traffic-gen    │
│  (server/traffic) │                  │   (port 4400)    │
├──────────────────┤                  ├──────────────────┤
│ ExperimentManager │                  │   engine.js      │
├──────────────────┤                  │   server.js      │
│ ExperimentStore   │                  │   workflows/     │
└──────────────────┘                  └──────────────────┘
```

## TrafficController (server/traffic/TrafficController.ts)

The largest single file in the traffic subsystem (~37KB, 857 lines). It handles:

### Traffic Modes

| Mode | Description |
|------|-------------|
| `USER_JOURNEY` | Follows real user paths through the frontend |
| `ENDPOINT` | Targets a specific endpoint/route |
| `SERVICE` | Targets all endpoints of a specific service |
| `SWEEP` | **Exercises every discovered endpoint** — critical for ML training data coverage |

### SWEEP Mode — The ML Data Generator

SWEEP mode is specifically designed to feed the per-service Isolation Forest:

1. **Probes all discovered endpoints** via live HTTP checks
2. **Builds a dynamic workflow** from endpoints that actually respond
3. **Auto-discovers gateway paths** using `COMMON_GATEWAY_PATHS` (e.g., `/api/products`, `/catalogue`, `/health`)
4. **Filters out observability UIs** — Grafana, Jaeger, Prometheus endpoints are excluded from traffic

```typescript
const COMMON_GATEWAY_PATHS = [
  '/api', '/api/products', '/api/cart', '/api/data', '/api/currency',
  '/api/shipping', '/api/recommendations', '/api/checkout', '/api/orders',
  '/catalogue', '/cart', '/orders', '/health', '/healthz', '/metrics',
];
```

### Probe System

Before sending traffic, every endpoint is probed:

```typescript
interface ProbeCandidate {
  url: string;
  serviceName: string;
  endpointId: string;
  port: number;
}

interface ProbeResult {
  url: string;
  serviceName: string;
  reachable: boolean;        // Port is open and listening
  httpResponds: boolean;     // Returns a valid HTTP response
  statusCode?: number;
  latencyMs?: number;
}
```

- **Probe timeout**: 25 seconds (`MAX_PROBE_TIMEOUT_MS`) — sized from real measurements where sock-shop's `/catalogue?size=5` took 15.1s under load
- Unreachable endpoints are excluded, not assumed broken

### Traffic Profiles

Mapped from old UI names to traffic-gen profiles:

| UI Name | traffic-gen Profile |
|---------|-------------------|
| normal / baseline | BASELINE |
| moderate | MODERATE |
| heavy | HEAVY |
| stress | STRESS |
| ramp | RAMP |

### Known Targets

Only these targets have traffic-gen workflow support:
- `sock-shop`
- `vertikal`
- `death-star`
- `train-ticket`
- `open-telemetry`

### Callbacks

```typescript
trafficController.onStatsCallback = (targetId, stats) =>
  experimentManager.updateExperimentStats(targetId, stats);

trafficController.onStoppedCallback = (targetId) =>
  experimentManager.stopExperiment(targetId, 'STOPPED');
```

The `onStoppedCallback` is critical: without it, timed sweeps would appear as running forever in the UI because nothing told the experiment it was done.

## ExperimentManager (server/traffic/ExperimentManager.ts)

Wraps traffic runs in a tracked experiment record:

### Key Design Decisions

1. **Safety limits are tracked but NOT enforced** — these are failure-injection experiments, services are *supposed* to break
2. **Peak metrics tracked** — CPU, memory, latency P95, error rate peaks are recorded per experiment
3. **Auto-stop** — When traffic-gen reports a sweep stopped (duration reached), the experiment is auto-stopped

### Experiment Lifecycle

```
startExperiment() → RUNNING → updateExperimentStats() → stopExperiment() → STOPPED
                                                                          → ABORTED_SAFETY
                                                                          → INTERRUPTED (on restart)
```

## ExperimentStore (server/traffic/ExperimentStore.ts)

Persistent JSON-backed storage for experiment history.

### Orphan Reconciliation

On server startup, any experiment still marked `RUNNING` is automatically transitioned to `INTERRUPTED`:

```typescript
private reconcileOrphanedRuns(): void {
  const orphaned = Array.from(this.records.values())
    .filter(r => r.status === 'RUNNING');
  for (const rec of orphaned) {
    rec.status = 'INTERRUPTED';
    rec.stoppedAt = rec.stoppedAt || now;
    rec.stopReason = 'Server restarted while this run was active';
  }
}
```

This prevents phantom "active" experiments that nobody can stop because nothing is driving them.

### Experiment Record Fields

| Field | Type | Description |
|-------|------|-------------|
| `experimentId` | UUID | Unique experiment identifier |
| `targetId` | string | Which target was tested |
| `workloadSource` | `EXTERNAL` / `USER_SIM` | Where traffic came from |
| `profile` | string | BASELINE, MODERATE, HEAVY, etc. |
| `status` | enum | RUNNING, COMPLETED, ABORTED_SAFETY, STOPPED, INTERRUPTED |
| `trafficStatistics` | object | Requests attempted/completed/successful/failed, peak rate |
| `peakObservedMetrics` | object | Peak CPU%, memory%, latency P95, error rate |

## Traffic Generator (traffic-gen/)

A separate Node.js service (20KB `server.js` + 14KB `engine.js`):

- **Profile-based**: BASELINE, MODERATE, HEAVY, STRESS, RAMP
- **Workflow-driven**: `targets.json` defines per-target endpoints and authentication
- **WebSocket streaming**: Real-time stats (requests/sec, errors, duration) streamed back to mapper
- **CLI interface**: `cli.js` for standalone operation
- **Target discovery**: `discover-target.sh` script for probing remote hosts

### Default Authentication

Seeded sock-shop test account used for authenticated flows:
```typescript
const DEFAULT_AUTH = { username: 'user', password: 'password' };
```
