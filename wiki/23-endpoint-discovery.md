# 23 — Endpoint Discovery & Registry System

## Overview

The Endpoint Discovery system (`server/discovery/EndpointDiscoveryEngine.ts` + `server/registry/EndpointRegistry.ts`) automatically discovers every service, endpoint, and HTTP route across monitored targets — without requiring any configuration from the target application. It populates the registry that drives traffic generation, health probing, and the discovery summary shown in the UI.

## Architecture

```
┌───────────────────────────┐
│  EndpointDiscoveryEngine  │  ← 32KB, multi-source discovery
│   (server/discovery/)     │
│                           │
│   Discovery Sources:      │
│   ├── Docker containers   │
│   ├── Compose configs     │
│   ├── Nginx configs       │
│   ├── HTTP probes         │
│   └── Telemetry spans     │
├───────────────────────────┤
│    EndpointRegistry       │  ← Central registry of all discovered entities
│   (server/registry/)      │
│                           │
│   Tracks:                 │
│   ├── DiscoveredService   │
│   ├── DiscoveredEndpoint  │
│   └── DiscoveredRoute     │
└───────────────────────────┘
```

## EndpointRegistry (server/registry/EndpointRegistry.ts)

Central registry for all discovered services, endpoints, and routes.

### Deterministic ID Generation

All IDs are stable and deterministic — they survive restarts and avoid duplicates:

```typescript
// Service: targetId:cleanName
static makeServiceId(targetId, serviceName) {
  const cleanName = serviceName
    .replace(/^docker-compose-/, '')
    .replace(/-\d+$/, '')
    .replace(new RegExp(`^${targetId}-`), '');
  return `${targetId}:${cleanName}`;
}

// Endpoint: targetId/cleanName/protocol-port
static makeEndpointId(targetId, serviceName, protocol, port) {
  return `${targetId}/${cleanName}/${protocol.toLowerCase()}-${port}`;
}

// Route: targetId/cleanName/http-port/METHOD/path
static makeRouteId(targetId, serviceName, port, method, path) {
  return `${targetId}/${cleanName}/http-${port}/${method.toUpperCase()}${cleanPath}`;
}
```

### Smart Endpoint Ranking

When returning endpoints, the registry sorts them to prefer the application frontend over observability UIs:

```typescript
const OBSERVABILITY = /(grafana|jaeger|prometheus|opensearch|kibana|zipkin|otel-?collector)/i;
const APP_ENTRY_PORTS = [80, 443, 8080, 8000, 3000];
```

**Why this matters**: On the OpenTelemetry Demo, Grafana is on :3000 and the actual app is on :8080. Without this sorting, traffic-gen would target Grafana (the lowest port that's "PUBLIC") instead of the application.

The ranking:
1. Port 80/443 → rank 0 (most likely the app)
2. App entry ports (8080, 8000, 3000) → rank by position
3. Observability services → rank 30 (listed, but last)
4. Internal endpoints → rank 40

### Route Observation with EWMA Latency

When a route is observed via telemetry, its latency is smoothed using Exponential Weighted Moving Average:

```typescript
route.latencyMs = route.latencyMs
  ? Math.round((route.latencyMs * 0.7) + (latencyMs * 0.3))
  : latencyMs;
```

This prevents a single slow request from making the route look permanently slow.

### Discovery Summary

Per-target summary available at `/api/graph` (on the Target object):

```typescript
interface TargetDiscoverySummary {
  targetId: string;
  status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA';
  lastDiscovery: string;
  servicesCount: number;
  publicEndpointsCount: number;
  internalEndpointsCount: number;
  routesCount: number;
  observedRoutesCount: number;
  trafficCapableRoutesCount: number;
}
```

## Data Models

### DiscoveredService

```typescript
interface DiscoveredService {
  serviceId: string;     // e.g. "sock-shop/carts" or "vertikal/vertikal-auth"
  targetId: string;      // e.g. "sock-shop" or "vertikal"
  name: string;          // e.g. "carts"
  containerId?: string;
  containerIP?: string;
  ports: number[];
  protocols: string[];
  labels: Record<string, string>;
  networks?: string[];
  lastSeen: string;
}
```

### DiscoveredEndpoint

```typescript
interface DiscoveredEndpoint {
  endpointId: string;     // e.g. "sock-shop/edge-router/http-80"
  protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'GRPC' | 'AMQP';
  type: 'PUBLIC' | 'INTERNAL';
  source: 'compose' | 'docker' | 'nginx' | 'traefik' | 'source-code' | 'openapi' | 'otel' | 'runtime-observation';
  discoveryMethod: 'container-ports' | 'nginx-config' | 'compose-config' | 'http-probe' | 'telemetry-span';
  reachable: boolean;
  statusCode?: number;
  latencyMs?: number;
}
```

### DiscoveredRoute

```typescript
interface DiscoveredRoute {
  routeId: string;      // e.g. "sock-shop/edge-router/http-80/GET/catalogue"
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ANY';
  path: string;
  source: 'compose' | 'docker' | 'nginx' | 'nextjs' | 'source-code' | 'openapi' | 'otel' | 'http-log' | 'runtime-observation';
  declared: boolean;       // Found in config
  observed: boolean;       // Seen in live traffic
  trafficCapable: boolean; // Can traffic-gen target this?
  incapableReason?: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
}
```

## Integration Points

1. **GraphStore** — creates the discovery engine at construction, triggers discovery on target registration
2. **TrafficController** — queries the registry to find endpoints for SWEEP mode
3. **Telemetry ingestion** — marks routes as observed when interactions arrive
4. **UI** — shows discovery summary counts in target cards
