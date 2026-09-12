# Microservice Mapper Architecture

This document outlines the detailed architecture, mechanisms, and design patterns used by the Microservice Mapper system to build real-time dependency graphs, ingest telemetry, and execute load workflows.

## System Components Overview

The system is highly decoupled to allow observability without requiring the target microservices to include custom tracing libraries (like OpenTelemetry). It consists of five primary components:

1. **Target Workloads (e.g., Vertikal, Sock Shop)**: Unmodified microservices running in Docker on local or remote servers.
2. **Remote Collector (`remote-collector/`)**: A Node.js agent deployed on the target host that bridges Docker's API with the central Mapper backend.
3. **Traffic Generator (`traffic-generator/`)**: An independent testing tool that simulates realistic user workflows to generate HTTP requests against the targets.
4. **Mapper Backend (`server/`)**: A Node.js/Express application acting as the centralized brain. It maintains the in-memory graph state and persists metrics.
5. **Mapper Frontend (`client/`)**: A Vite + React application that renders the dynamic `ReactFlow` graph and 3D architectural views.

---

## 1. Graph Construction (Nodes & Edges)

The Mapper builds a unified dependency graph using a two-tier approach: a **Declared Baseline** and a **Runtime Overlay**.

### A. The Declared Baseline (Architecture)
The backend uses **Adapters** (`server/collectors/*Adapter.ts`) to read the target's `docker-compose.yml`. By parsing the YAML file, the system discovers:
- **Services (Nodes)**: Extracts container configurations, images, and project names.
- **Dependencies (Edges)**: Reads the `depends_on` clauses to map out how the author intended the services to communicate. These edges are marked as `declared = true` and `observed = false`.

### B. The Runtime Overlay (Telemetry)
The `remote-collector` gathers real-time container metadata by querying `/var/run/docker.sock`:
- **Nodes**: Checks container statuses (`running`, `exited`) to determine node health (`healthy`, `critical`).
- **Edges (Network Level)**: The collector enters the running container and reads `/proc/net/tcp`. By parsing this file, it finds `ESTABLISHED` (state `01`) TCP connections. It then matches the remote hexadecimal IP addresses against the known pool of Docker container IP addresses. If a match is found, it proves an active connection and generates an edge marked `observed = true`.
- **Edges (Application Level)**: Parses standard output logs for application interactions. (See Section 2).

### C. Edge Merging Strategy
When the backend receives runtime telemetry via `POST /api/ingest`, the `GraphStore` merges it into the existing baseline graph. It does not blindly overwrite edges; instead, it uses a deep merge algorithm to ensure that if a declared edge receives runtime evidence, it becomes `observed = true` without losing its declared metadata.

---

## 2. Telemetry Ingestion (Logs and Metrics)

The system extracts runtime data directly from the host environment to minimize intrusion.

### A. Resource Metrics
The `remote-collector` queries `container.stats()` to extract cgroup-level data:
- **CPU**: Computed by evaluating the delta between `cpu_stats` and `precpu_stats` relative to the system's total CPU delta.
- **Memory**: Read directly from `memory_stats.usage` and converted to a percentage based on the container's allocated limit.
- **Network I/O**: Aggregates `rx_bytes` and `tx_bytes` across the container's virtual interfaces.

### B. HTTP Log Interactions
The collector tails the Docker logs (`container.logs()`) for services identified as gateways, routers, or specific API layers. 

1. **Demuxing**: Since Docker multiplexes stdout and stderr into a single binary stream, the collector first strips the 8-byte Docker stream headers to extract raw text lines.
2. **Regex Strategy (Standard Nginx/Apache)**: If the logs are raw text, it applies a Regex pattern: `/^([0-9.]+).*?"([A-Z]+)\s+([^\s]+)\s+HTTP\/[0-9.]+"\s+(\d+|-)?/` to extract the caller's IP, HTTP method, route, and status code.
3. **JSON Strategy (Modern Gateways)**: If the log line contains a JSON payload (e.g., Kong, Traefik, custom microservices), the collector parses it to extract fields like `upstream_response_time` (latency), `status`, `upstream_addr`, and `bytes_sent`.
4. **Resolution**: The `remote_addr` or `upstream_addr` is cross-referenced with the internal `ipToNameMap`. This links a raw HTTP request back to two explicit nodes, creating an `InteractionEvent`.

---

## 3. Real-World Traffic Simulation

To ensure the telemetry pipeline can be observed in action, the **Traffic Generator** synthesizes load.

### Simulated User Journeys
The generator uses structured "Scenarios" (e.g., `VertikalScenario.ts`) to execute sequences of requests that mimic a real user. For example, instead of just pinging a health check, a single execution journey might entail:
1. `GET /auth/v1/settings`
2. `POST /auth/v1/signup` (Triggers an internal email).
3. `GET /api/v1/messages` (The user checking their email via a mail catcher).

Because these requests execute in order, they naturally cause the gateway, authentication service, database, and email worker to communicate internally. This cascaded communication generates real HTTP and TCP logs across multiple containers, which the collector then detects and streams back to the UI.

---

## 4. Real-time Presentation

1. **State Broadcasting**: Every time the `GraphStore` merges new telemetry or edges, the `TrafficController` triggers a WebSocket `graph-update` broadcast to all connected clients.
2. **ReactFlow State Matching**: The frontend (`useGraphData.ts`) parses the incoming WebSocket JSON payload. It applies a shallow-copy map over the array of nodes to ensure React detects a new object reference, forcing a re-render of just the nodes whose metrics or health have changed.
3. **Animations**: The CSS utilizes dynamic `stroke-dasharray` and `stroke-dashoffset` variables to render marching ants (moving dashed lines) across edges, but *only* for edges where `observed = true`. The speed and color (Cyan, Yellow, Red) change automatically based on the latency and error rates reported in the recent telemetry.
