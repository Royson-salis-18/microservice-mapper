# 25 - Prometheus & Telemetry Source Plugin Architecture

## Overview

The telemetry source system (`server/telemetry-sources/`) provides a plugin architecture for integrating higher-tier data sources (Tier 1 and Tier 2) alongside the existing Tier 0 agentless collection. It adds somewhere for Prometheus, access logs, and trace backends to plug in without turning the existing collector into a dispatch table.

## The Tier Model

| Tier | Source | What it provides | What it can't |
|------|--------|-----------------|---------------|
| **0** | cgroup / socket-scan | CPU, memory, network I/O, topology | No requests, no latency, no errors |
| **1** | access-log (proxy) | Real per-request status, upstream latency | Only traffic through that proxy |
| **2** | prometheus / trace-backend | Exact histograms, error rates, spans | Only as good as target's instrumentation |

## TelemetrySource Interface

```typescript
export interface TelemetrySource {
  readonly kind: MetricSourceKind;
  readonly targetId: string;

  // Cheap liveness check - called before collection so an absent
  // source costs one probe rather than a full timeout on every cycle.
  probe(): Promise<TelemetrySourceStatus>;

  // Current per-request metrics, over the given lookback window.
  collect(windowSec: number): Promise<TelemetrySnapshot>;
}
```

### Design Contract

- A source answers for a target, says whether it is usable right now, and returns metrics
- It does **not** own connections, does not write to the graph, and cannot decide what a metric means
- The contract is deliberately narrow

## MetricProvenance - Tracking Where Numbers Come From

```typescript
export type MetricSourceKind =
  | 'cgroup'         // Tier 0: docker stats / kernel cgroup accounting
  | 'socket-scan'    // Tier 0: /proc/net/tcp snapshots
  | 'access-log'     // Tier 1: proxy access log
  | 'prometheus'     // Tier 2: target's own Prometheus
  | 'trace-backend'; // Tier 2: target's own Jaeger/Tempo

export interface MetricProvenance {
  source: MetricSourceKind;
  tier: 0 | 1 | 2;
  observedAt: string;      // When the source produced this value
  detail?: string;         // How it was obtained (PromQL, log format, etc.)
}
```

### Capability Enforcement

Each source can only populate fields it can honestly speak to:

```typescript
const SOURCE_CAPABILITIES: Record<MetricSourceKind, {
  resourceUse: boolean;
  topology: boolean;
  requestRate: boolean;
  latency: boolean;
  errorRate: boolean;
}> = {
  'cgroup':        { resourceUse: true,  topology: false, requestRate: false, latency: false, errorRate: false },
  'socket-scan':   { resourceUse: false, topology: true,  requestRate: false, latency: false, errorRate: false },
  'access-log':    { resourceUse: false, topology: true,  requestRate: true,  latency: true,  errorRate: true  },
  'prometheus':    { resourceUse: true,  topology: false, requestRate: true,  latency: true,  errorRate: true  },
  'trace-backend': { resourceUse: false, topology: true,  requestRate: true,  latency: true,  errorRate: true  },
};
```

A socket scan **must never** end up populating a latency field, however convenient that would be.

## PrometheusSource (server/telemetry-sources/PrometheusSource.ts)

The Tier 2 implementation. Reads the target's own Prometheus instance.

### How It Works

1. **Discovery**: Auto-discovers which duration histogram family the target emits
2. **Label resolution**: Finds the correct service name and status code labels
3. **Collection**: Runs PromQL queries via `curl` over SSH (not from the mapper directly)

### Why SSH, Not Direct HTTP?

> "Prometheus is bound to localhost on these boxes and only :8080 is open in the security group, so querying from outside would require opening a port - a change to someone's infrastructure to read a metric, which is not a trade worth making."

### Duration Histogram Discovery

Multiple OTel versions emit different metric names:

```typescript
const DURATION_FAMILIES = [
  { base: 'http_server_request_duration_seconds', toMs: 1000 },
  { base: 'http_server_duration_milliseconds', toMs: 1 },
  { base: 'http_server_duration_seconds', toMs: 1000 },
  { base: 'rpc_server_duration_milliseconds', toMs: 1 },
  { base: 'rpc_server_duration_seconds', toMs: 1000 },
];
```

Units differ between them - guessing seconds-vs-milliseconds silently produces numbers 1000x wrong.

### Label Convention Discovery

Service name and status code labels also vary:

```typescript
const SERVICE_LABELS = ['service_name', 'service', 'job'];
const STATUS_LABELS = ['http_response_status_code', 'http_status_code', 'status_code'];
```

### Collected Metrics

For each service with a recognized duration histogram:

| Metric | PromQL |
|--------|--------|
| **Latency P50** | `histogram_quantile(0.5, sum by (svc, le) (rate(duration_bucket[win])))` |
| **Latency P95** | `histogram_quantile(0.95, ...)` |
| **Latency P99** | `histogram_quantile(0.99, ...)` |
| **Request Rate** | `sum by (svc) (rate(duration_count[win]))` |
| **Error Rate** | `sum(rate(count{status=~"5.."}[win])) / sum(rate(count[win]))` |

### Verified Against Production

> "Verified against the live open-telemetry target on 2026-09-18:
>   histogram_quantile(0.95, ...) → 0.0829 (82.9 ms p95, service_name="cart", 2296 samples)"

### Edge Attribution Limitation

Prometheus only attributes to the serving side. Without explicit client-side labels, it cannot say who called, so no caller→callee attribution is claimed - rather than inventing one.

## Per-Target Configuration

```typescript
interface TelemetrySourceConfig {
  prometheus?: {
    enabled: boolean;
    url?: string;   // Reached from target host, so localhost is normal
  };
  traceBackend?: {
    enabled: boolean;
    url?: string;
    kind?: 'jaeger' | 'tempo';
  };
  accessLogs?: {
    enabled: boolean;
    containers?: string[];  // Container names whose stdout is parseable
  };
}
```

Absent means Tier 0 only - the correct default. Enabling a source that is not there should be a deliberate act.

## How Tier 1/2 Metrics Flow to the Graph

When the remote collector or telemetry source produces Tier 1/2 request metrics, they ride along on the `TelemetryEnvelope` as `requestMetrics` on each node:

```typescript
// In ingestRemote():
const req = (node as any).requestMetrics;
delete (node as any).requestMetrics;
if (existing) {
  // Merged rather than assigned - a cycle where the optional source
  // was unavailable does not wipe the resource metrics
  existing.metrics = { ...(existing.metrics ?? {}), ...req };
}
```

The merge ensures that if Prometheus was temporarily unreachable, the Tier 0 resource metrics (CPU, memory) from the same cycle are still preserved.
