# Microservice Mapper — Telemetry & Traffic Generation System

Microservice Mapper is a real-time, 3D interactive telemetry and architecture mapping platform designed to visualize, trace, and analyze distributed applications on AWS (**Sock Shop** and **Vertikal**).

---

## 🚀 Architecture Overview

1. **Frontend (Vite / React 3D)**: Premium WebGL 3D visualization using `@react-three/fiber` with custom graph layout algorithms, neon dependency edge flow lines, live metric gauges, and a built-in **Traffic Control Panel** with automatic target endpoint resolution.
2. **Backend (Node.js / Express / WebSockets)**: Central graph repository with Target Registry isolation (`targetId`), single-source-of-truth endpoint resolution (`baseUrl`), endpoint health pings (`REACHABLE`/`UNREACHABLE`), data freshness monitoring (`LIVE`, `STALE`, `OFFLINE`), and Root Cause Analysis (RCA).
3. **Remote Collector (`remote-collector/`)**: Lightweight Docker container deployed directly on AWS EC2 instances. Inspects container metrics, extracts real NGINX `mapper_json` access log lines, and streams concrete interaction telemetry over reverse SSH tunnels (`-R 3001:localhost:3001`).
4. **Traffic Generator Subsystem (`traffic-generator/`)**: Modular user-journey traffic engine that exercises real application workflows (browsing, catalog, carts, orders, auth, REST APIs) against resolved AWS endpoints.

---

## ⚡ Target Resolution & Traffic Control

The Target Registry automatically resolves target endpoints from environment variables (`SOCK_SHOP_BASE_URL` and `VERTIKAL_BASE_URL`). The user does NOT need to enter target URLs manually.

### Target Environment Configuration

Set single-source-of-truth target endpoints in your environment or `.env`:

```bash
export SOCK_SHOP_BASE_URL="http://<YOUR_AWS_SOCK_SHOP_IP>:80"
export VERTIKAL_BASE_URL="http://<YOUR_AWS_VERTIKAL_IP>:54321"
```

### Automatic Resolution & Safety Guardrails

- **Automatic Selection**: Selecting **Sock Shop** or **Vertikal** in the UI populates the resolved `baseUrl` with an **`AUTO`** badge.
- **No Localhost Fallback**: If a target endpoint is unconfigured in the environment, the system displays `TARGET ENDPOINT UNCONFIGURED` and **blocks traffic execution** to prevent accidentally targeting localhost.
- **Target Lock**: Active traffic sessions lock target selection to prevent mid-stream target leakage.
- **Advanced Manual Override**: Optional checkbox for debugging overrides while keeping `targetId` strictly isolated.

---

## 🛠️ How to Run Traffic

### Option A: Web UI
1. Open `http://localhost:5173`.
2. Click **⚡ TRAFFIC** in the top navigation bar.
3. Select **Sock Shop** or **Vertikal** (endpoint resolves automatically).
4. Click **▶ START TRAFFIC**.

### Option B: Command Line
```bash
# Start Sock Shop traffic
npm run traffic:sockshop

# Start Vertikal traffic
npm run traffic:vertikal

# Start ALL targets
npm run traffic:all
```
