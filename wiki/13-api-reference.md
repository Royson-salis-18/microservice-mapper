# API Reference

**Base URL:** `http://localhost:3001/api`

All responses are JSON. All routes are defined in `server/api/routes.ts`.

---

## Authentication

Only the ingest endpoint requires authentication:

```
POST /api/ingest
Authorization: Bearer <INGEST_TOKEN>
```

Default token: `mapper-secret-token`. Override via `INGEST_TOKEN` environment variable.

All other endpoints are unauthenticated (designed for internal/VPN use).

---

## Graph

### `GET /api/graph`

Full graph snapshot.

**Response:**
```json
{
  "nodes": [ { "id": "sock-shop:catalogue", "name": "catalogue", ... } ],
  "edges": [ { "id": "sock-shop:front-end->sock-shop:catalogue", ... } ],
  "targets": [ { "targetId": "sock-shop", "status": "LIVE", ... } ]
}
```

### `GET /api/nodes/:id`

Single node by ID.

```
GET /api/nodes/sock-shop:catalogue
```

**Response:** `ServiceNode` object or `404 { "error": "Node not found" }`

### `GET /api/nodes/:id/metrics?range=5m`

Metric history from `MetricStore` ring buffer.

**Query params:**
- `range`: `1m`, `5m`, `30m`, `1h` (default `5m`)

**Response:**
```json
[
  { "timestamp": "2026-09-18T00:00:00Z", "cpu": 12.3, "memory": 134217728, ... },
  ...
]
```

### `GET /api/nodes/:id/logs?tail=200`

Fetch container logs via SSH (live from target EC2).

**Query params:**
- `tail`: number of lines (max `2000`, default `200`)

**Response:** `{ "lines": ["2026-09-18 12:34:56 GET /catalogue 200 23ms", ...] }`

**Requires:** `node.metadata.containerId` — only works if the node has been discovered with Docker metadata.

### `GET /api/status`

Global health status.

**Response:**
```json
{
  "healthy": 10,
  "degraded": 2,
  "critical": 1,
  "targets": 2,
  "overall": "degraded"
}
```

### `GET /api/analytics`

Graph-level analytics computed by `GraphAnalytics`.

**Response:**
```json
{
  "topCpuConsumers": [...],
  "topMemoryConsumers": [...],
  "highestLatency": [...],
  "mostConnected": [...],
  "centralityScores": { "sock-shop:catalogue": 0.85, ... }
}
```

---

## Targets

### `GET /api/targets`

All configured targets.

### `POST /api/targets/register`

Register a new remote target.

**Body:**
```json
{
  "targetId":    "my-app",
  "displayName": "My Application",
  "ec2PublicIp": "54.123.45.67",
  "sshUsername": "ubuntu",
  "sshKeyPath":  "~/.ssh/myapp.pem",
  "baseUrl":     "http://54.123.45.67:80"
}
```

**Effect:** Saves to `data/remote_config.json`, triggers immediate SSH discovery.

### `PUT /api/targets/:targetId`

Update target configuration. Same body shape as register.

### `DELETE /api/targets/:targetId`

Remove target and all associated nodes, edges, and metrics.

### `GET /api/targets/:targetId/diagnostics`

```json
{ "targetId": "sock-shop", "nodeCount": 14, "edgeCount": 18, "status": "LIVE" }
```

### `GET /api/targets/:targetId/discovery`

Discovery summary from `EndpointRegistry`.

### `GET /api/targets/:targetId/services`

List of discovered services.

### `GET /api/diagnostics`

All targets with node/edge counts.

---

## Telemetry Ingestion

### `POST /api/ingest`

Used by the remote collector. See [07-remote-collector.md](./07-remote-collector.md) for the envelope format.

**Headers:** `Authorization: Bearer <token>`

**Body:** `TelemetryEnvelope`

**Response:** `{ "status": "ok", "processed": { "nodes": 14, "metrics": 14, ... } }`

### `POST /api/discovery/refresh`

Force a re-discovery cycle for a target.

**Body:** `{ "targetId": "sock-shop" }`

---

## Traces

### `GET /api/traces/:targetId/events?since=ISO&limit=100`

TCP connection events from `TraceStore`.

**Query params:**
- `since`: ISO timestamp (default: 1 hour ago)
- `limit`: max events (default `100`)

**Response:** `ConnectionEvent[]`

### `GET /api/traces/:targetId/graph?windowSec=300`

Aggregated call graph for the trace window.

**Response:**
```json
{
  "nodes": ["sock-shop:front-end", "sock-shop:catalogue"],
  "edges": [
    {
      "sourceServiceId": "sock-shop:front-end",
      "destServiceId":   "sock-shop:catalogue",
      "eventCount":      47,
      "firstSeen":       "2026-09-18T00:00:00Z",
      "lastSeen":        "2026-09-18T00:05:00Z",
      "destPorts":       ["8080"]
    }
  ]
}
```

### `DELETE /api/traces/:targetId`

Clear all trace data for a target (both disk file and in-memory buffer).

---

## Traffic & Experiments

### `POST /api/traffic/start`

Start a traffic scenario.

**Body:** `{ "targetId": "sock-shop", "scenarioId": "browsing" }`

### `POST /api/traffic/stop`

Stop current traffic. No body required.

### `GET /api/experiments`

All experiment history.

### `GET /api/experiments/:id`

Single experiment by ID.

---

## Incidents & RCA

### `GET /api/incidents/:targetId`

All incidents for a target (most recent first).

**Response:** `Incident[]`

### `GET /api/incidents/:targetId/latest`

Most recent incident for a target.

### `POST /api/incidents/:targetId/evaluate`

Manually trigger RCA evaluation (normally runs automatically every 5s).

**Response:** `Incident` object.

---

## Traffic Metrics

### `GET /api/traffic?limit=100`

Recent HTTP `InteractionEvent` objects from `MetricStore`.

**Query params:** `limit` (default `100`, max `1000`)

---

## ML Pipeline Status

### `GET /api/ml/status`

ML pipeline information (reads from `ml/data/` directory).

**Response:**
```json
{
  "scoresFile": { "exists": true, "mtimeMs": 1726598400000, "serviceCount": 12 },
  "modelsDir":  { "exists": true, "modelCount": 12, "services": ["sock-shop:catalogue", ...] },
  "rawDataFile": { "exists": true, "rowCount": 43200 }
}
```

---

## WebSocket

**URL:** `ws://localhost:3001/ws` (same host as REST API)

See [10-websocket.md](./10-websocket.md) for full protocol documentation.
