# Microservice Mapper - Complete System Wiki & Operational Guide

Welcome to the official master documentation for **Microservice Mapper**. This wiki contains everything needed to install, run, understand, troubleshoot, and maintain the system.

---

## 1. Executive Summary & Architecture

Microservice Mapper is an autonomous, real-time observability and microservice topology discovery platform. It connects to target infrastructure (AWS EC2, local Docker stacks, hybrid deployments), discovers architecture declared dependencies and active container states, deploys non-invasive remote telemetry collectors, collects live HTTP log interactions and TCP socket pairs, calculates node/edge health metrics, and visualizes live traffic and root cause analyses.

### Component Diagram

```
[ Target AWS EC2 Instance ]                  [ Microservice Mapper Server ]
┌────────────────────────────┐              ┌───────────────────────────────┐
│ Docker Containers          │              │ Node.js / Express Server      │
│ (Sock-Shop / Custom App)   │              │  ├── EndpointDiscoveryEngine  │
│        │                   │              │  ├── DiscoveryEngine (Claude) │
│        ▼                   │  SSH Exec    │  ├── GraphStore (In-Memory)   │
│ mapper-collector           ├──────────────┤  ├── MetricStore              │
│ (proc/net/tcp & HTTP logs) │              │  └── WebSocketManager         │
│        │                   │              └───────────────┬───────────────┘
│        │ POST /api/ingest  │                              │ WS Broadcast
│        └───────────────────┼──────────────────────────────┤
                                                            ▼
                                             [ React / Vite Visualizer UI ]
                                             ┌──────────────────────────────┐
                                             │  ├── Interactive 2D/3D Graph │
                                             │  ├── Live Raw Traffic Stream │
                                             │  ├── Service Telemetry Table │
                                             │  └── Global Terminal Dock    │
                                             └──────────────────────────────┘
```

---

## 2. Dynamic ID Naming Convention & Data Pipeline

To eliminate node/edge glitches and metric mismatch across telemetry and discovery:
- **Canonical Node ID Format**: `${targetId}:${serviceName}` (e.g. `sock-shop:catalogue`, `vertikal:auth`).
- **Canonical Edge ID Format**: `${sourceNodeId}->${targetNodeId}` (e.g. `sock-shop:front-end->sock-shop:catalogue`).
- **Endpoint Route ID Format**: `${targetId}:${serviceName}/http-${port}/${METHOD}${path}`.

`GraphStore.ts` automatically normalizes legacy or third-party telemetry IDs (converting `-` or `/` separators into `:`) during ingestion, ensuring zero data loss and flawless edge correlation.

---

## 3. Storage vs Raw Telemetry Stream

- **Raw Telemetry Stream**: Standard access log events (`GET /catalogue 200 OK 45ms`) and TCP socket events are streamed continuously via `remote-collector`. They are visible live in the UI under **Raw Traffic Logs** (`GET /api/traffic`).
- **Preprocessed & Aggregated Storage**: `MetricStore.ts` buffers raw interactions and calculates windowed time-series aggregates (P50/P95/P99 latency, HTTP error rate %, moving average CPU/Memory %, throughput bytes/sec) stored persistently in `data/telemetry_db.json`.

---

## 4. Complete Installation & Deployment Guide

### Prerequisites
- Node.js >= v18.0.0
- npm >= 9.0.0
- Linux / macOS (or WSL2) environment
- Remote EC2 target running Docker with SSH key access (`.pem`)

### Step 1: Clone & Install Dependencies
```bash
# Clone the repository
git clone https://github.com/royson/microservice-mapper.git
cd microservice-mapper

# Install dependencies for server and client
npm run setup  # or npm install && cd client && npm install && cd ..
```

### Step 2: Configure Environment
Create `.env` in the root directory:
```env
PORT=3001
MAPPER_PUBLIC_URL=http://<YOUR_LOCAL_OR_PUBLIC_IP>:3001
INGEST_TOKEN=mapper-secret-token
```

### Step 3: Configure Target EC2 Instance
Target settings are managed via UI or stored in `data/remote_config.json`:
```json
{
  "sock-shop": {
    "displayName": "Sock Shop AWS",
    "ec2PublicIp": "18.206.136.26",
    "sshUsername": "ubuntu",
    "sshKeyPath": "~/.ssh/sockshop-key.pem"
  }
}
```

### Step 4: Run Development Server
```bash
# Launch server and Vite UI concurrently
npm run dev
```
Open browser at `http://localhost:5173`.

---

## 5. Subsystems Reference

### A. EndpointDiscoveryEngine (`server/discovery/EndpointDiscoveryEngine.ts`)
- Executes live Docker inspection via SSH.
- Parses running containers (`docker ps`), open ports, and docker network connections.
- Automatically deploys `remote-collector` container on remote target.

### B. GraphStore (`server/graph/GraphStore.ts`)
- Holds central topology state in memory and persists to `data/graph_db.json`.
- Broadcasts updates to UI clients over WebSockets (`graph-update`).
- Tracks target staleness (STALE after 2m, OFFLINE after 5m).

### C. Remote Telemetry Collector (`remote-collector/index.ts`)
- Compact TypeScript/Docker process deployed to target EC2 instances.
- Inspects `/proc/net/tcp` for active socket pairs.
- Parses container stdout/stderr logs for HTTP requests (JSON/Nginx/Apache format).
- Posts telemetry batches back to `POST /api/ingest`.

### D. Global Persistent Terminal (`server/api/websocket.ts`)
- Implements interactive SSH & shell session multiplexing over WebSockets.
- Maintains `cd` working directory state and environment context.
- Handles standard input (`TERMINAL_EXEC`) and output streaming (`TERMINAL_LOG`).

---

## 6. Verification & Troubleshooting Checklist

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| UI graphs show 0% CPU/Memory | ID mismatch between discovery (`sock-shop:catalogue`) & collector (`sock-shop-catalogue`) | Ensure `GraphStore.ts` ID normalization is active. |
| Edge disappears in Architecture view | Edge declared status is `false` | `DiscoveryEngine` & `GraphStore` automatically mark network dependencies as `declared: true` when topology is discovered. |
| Remote collector status offline | Host cannot reach `MAPPER_PUBLIC_URL` | Ensure port 3001 is reachable from the EC2 instance or use ngrok. |
| Global terminal closes after command | SSH process exit code 1 or missing PTY | Handled automatically; session auto-reconnects on next command invocation with `-tt` flag. |

---

*Updated on 2026-09-14 by Antigravity AI Pair Programmer.*
