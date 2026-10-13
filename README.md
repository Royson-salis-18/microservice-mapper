<div align="left">
  <a href="https://github.com/Royson-salis-18"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" /></a>
  <a href="https://www.linkedin.com/in/royson-salis-3ab32628a/"><img src="https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" /></a>
  <a href="https://www.instagram.com/royson._/"><img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" /></a>
  <a href="mailto:roysonsalis2005@gmail.com"><img src="https://img.shields.io/badge/Gmail-D14836?style=for-the-badge&logo=gmail&logoColor=white" /></a>
</div>

---

# Microservice Mapper

**Real-time observability for Docker-based microservices — zero code changes required.**

Microservice Mapper connects to your EC2 instances over SSH, discovers your service topology from Docker Compose files and running containers, collects live telemetry, and renders an interactive 2D/3D dependency graph. Point it at a running stack and see your architecture come alive within seconds.

```
SSH into EC2 → Read Docker socket + /proc/net/tcp → Build live dependency graph → Visualize
```

---

## What It Does

- **Topology discovery** — reads your Compose file over SSH; discovers declared `depends_on` relationships
- **Runtime observation** — reads each container's socket tables to see which services actually talk to each other, and which end is calling (the one holding the listening port is the one being called)
- **Live metrics** — CPU (against the container's own allowance), memory, and exact network counters from `docker stats` and `/proc`, refreshed every 5 seconds
- **Root cause analysis** — when services fail or show anomalies, an additive, explainable score ranks the most likely cause, says how confident it is, and traces the propagation path
- **Cascade risk** — per-service health, criticality and risk; what-if failure simulation and blast radius
- **Anomaly detection** — optional Python ML pipeline trains four detectors per service and feeds their combined verdict back as Findings, kept separate from rule-based incidents
- **Traffic experiments** — built-in load test runner with experiment tracking
- **Embedded terminal** — SSH terminal into any target directly from the UI

## What It Is NOT

This is not a distributed tracing tool. There are no OpenTelemetry spans or request IDs. The "Traces" view shows SSH-sampled TCP connection snapshots from `/proc/net/tcp` — sampled at 5-second intervals, not per-request. No code changes are required in your applications.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, TypeScript |
| 2D Graph | `@xyflow/react` v12 (ReactFlow) |
| 3D View | Three.js + `@react-three/fiber` |
| Charts | Recharts |
| Animations | Framer Motion |
| Backend | Node.js, Express 5, TypeScript (run with `tsx`) |
| WebSocket | `ws` v8 (raw — no Socket.io) |
| SSH | `ssh2` v1 — Docker is read over SSH (`docker ps/inspect/stats`), nothing is installed on the target |
| ML Pipeline | Python 3, scikit-learn: Isolation Forest, LOF, one-class SVM, plus a z-score baseline |

---

## Quick Start

### Prerequisites

- Node.js ^20.19 or ≥ 22.12 (what Vite 8 requires), npm ≥ 9
- Docker ≥ 20.10 on target EC2 instances
- SSH key (`.pem`) with access to your EC2 instance. Keep it outside the repository; `*.pem` is git-ignored as a backstop
- Python 3.9+ (optional — only for the ML anomaly pipeline). The server runs it as `python3`, or `python` on Windows; set `PYTHON` to override

### Install & Run

```bash
# Clone
git clone https://github.com/Royson-salis-18/microservice-mapper.git
cd microservice-mapper

# Install all sub-projects
npm run install:all

# Start server + client
npm run dev
```

Open **http://localhost:5173**

The server runs on **:3001**. The Vite dev client runs on **:5173** and proxies `/api` + `/ws` to the backend.

### npm Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start server + client concurrently |
| `npm run server` | Start backend only |
| `npm run client` | Start Vite dev server only |
| `npm run build` | Production client build |
| `npm run install:all` | Install server, client, remote-collector, traffic-gen |
| `npm run traffic-gen` | Run traffic generator |
| `npm test` | Run the test suite: graph, root cause, risk and cascades, layouts, SSH/Docker parsing, command sanitising |

---

## Adding a Target

1. Open http://localhost:5173
2. Click **+ Add Project**
3. Fill in: Target ID, Display Name, EC2 Public IP, SSH Username, SSH Key Path
4. Click **Connect**

The server SSH connects immediately, reads the Compose file, discovers containers, and starts telemetry collection. Target configuration is saved to `server/data/remote_config.json` and persists across restarts.

### Supported Target Systems

Any Docker Compose application works; service types are inferred heuristically. `traffic-gen` ships load workflows for these:

| System | `traffic-gen` workflow |
|---|---|
| **Sock Shop** (Weaveworks) | `sockshop.js` |
| **DeathStarBench** social network | `deathstar.js` |
| **OpenTelemetry demo** | `opentelemetry.js` |
| **Train-Ticket** | `trainticket.js` |
| **Vertikal** | `vertikal.js` |

---

## How It Works

### Hybrid Graph Model

The system combines two sources of truth:

| Source | How collected |
|---|---|
| **Declared** | `depends_on` in `docker-compose.yml` and service URLs in application config, read over SSH |
| **Observed** | Each container's socket tables (`/proc/<pid>/net/tcp`), sampled every poll; direction comes from which end holds the listening port |
| **Request-level** (opt-in) | Access logs or the target's own Prometheus, where configured ([wiki/25](./wiki/25-telemetry-sources.md)) |

An edge can be declared-only, observed-only, or both. Sharing a Docker network is *not* treated as evidence of a dependency. This immediately surfaces:
- Declared deps with no runtime traffic (dead code / misconfiguration)
- Runtime traffic not in any Compose file (undocumented dependencies)

What each colour, width and pulse on the graph means is in [wiki/33](./wiki/33-visual-language.md).

### Node ID Format

All nodes use a canonical format: `${targetId}:${serviceName}` — e.g., `sock-shop:catalogue`. This prevents ID mismatches between subsystems. See [wiki/04-id-system.md](./wiki/04-id-system.md).

### Persistence

State persists to `server/data/graph_db.json` (debounced 2-second write). Nodes not updated for 15 minutes are pruned (ghost prevention); a link not seen carrying traffic for 10 minutes is dropped, or kept as declared-only if config still claims it. Targets go `STALE` after 2 minutes and `OFFLINE` after 5 minutes without telemetry.

---

## Root Cause Analysis

Every service that is failing or shows a metric anomaly is scored on additive factors (`server/rca/RCAEngine.ts`):

| Factor | Points | Why |
|---|---|---|
| Temporal precedence (earliest anomaly) | +0.30 | Failure propagates; the first anomaly is the likeliest origin. A later anomaly scores +0.10 |
| Container down or crash-looping | +0.35 | Process exits are definitive failure signals |
| Degraded | +0.15 | High CPU/memory is a secondary indicator |
| Observed runtime dependency | +0.20 | Traffic confirms the causal path exists (declared only: +0.05) |
| Explains the other failures | up to +0.25 | Weighted share of the other symptomatic services that depend on it through material paths |
| Victim penalty | up to −0.25 | Its own dependencies are failing, so it is more likely downstream of the problem |

Confidence: `HIGH` at ≥ 0.75 with observed traffic, `MEDIUM` at ≥ 0.50, `LOW` at ≥ 0.25. When the top candidate explains none of the others, the problems are reported as independent with `LOW` confidence rather than as one cascade. The recommended next steps follow from the evidence. RCA runs every poll (5 seconds). Details and a worked example: [wiki/08](./wiki/08-rca-engine.md).

---

## ML Anomaly Detection (Optional)

A separate Python pipeline trains four detectors per service on its own history (Isolation Forest, LOF, one-class SVM, and a z-score baseline). A sample counts as anomalous when at least half of the usable detectors agree. The collector, scorer and retraining can all be driven from the **ML Pipeline** page, or by hand (`python` instead of `python3` on Windows):

```bash
cd ml
pip install -r requirements.txt

# Collect baseline (run during normal operation)
python3 collector.py &

# Train models
python3 preprocess.py
python3 train.py

# Start live scoring
python3 score.py &

# Check the detector combination
python3 test_ensemble.py
```

The server reads `ml/data/latest_scores.json` on each graph request using a mtime cache. No Python API calls at runtime — just a file read. Results appear under **Findings**, separate from rule-based incidents ([wiki/17](./wiki/17-findings-vs-incidents.md)).

---

## Deployment

### Environment

The server reads its settings from environment variables (`server/config.ts`). It does **not** load a `.env` file by itself: export the variables in the shell, or let systemd read the file (below).

```env
PORT=3001
INGEST_TOKEN=your-strong-secret-here
POLLING_INTERVAL_MS=5000
METRIC_HISTORY_SIZE=720
PYTHON=python3
```

### systemd (production)

```ini
[Unit]
Description=Microservice Mapper Server
After=network-online.target

[Service]
WorkingDirectory=/home/ubuntu/microservice-mapper/server
ExecStart=/usr/bin/npm run start
Restart=always
EnvironmentFile=/home/ubuntu/microservice-mapper/server/.env

[Install]
WantedBy=multi-user.target
```

### NGINX (SSL + static files)

```nginx
server {
    listen 443 ssl;
    server_name mapper.yourdomain.com;

    location /api { proxy_pass http://localhost:3001; }
    location /ws {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    location / {
        root /home/ubuntu/microservice-mapper/client/dist;
        try_files $uri /index.html;
    }
}
```

---

## Project Structure

```
microservice-mapper/
├── server/              # Node.js/Express backend (:3001)
│   ├── graph/           # GraphStore (central state), edge weights, risk, cascades, self-check
│   ├── discovery/       # Discovery loop per target
│   ├── telemetry-platform/src/  # SSH connection, Docker parsing, metric collection
│   ├── telemetry-sources/       # Optional higher-tier sources (Prometheus)
│   ├── rca/             # Anomaly detection, root cause, incidents
│   ├── traces/          # TCP connection event storage
│   ├── telemetry/       # MetricStore ring buffer
│   ├── traffic/         # Load test execution + experiments
│   ├── api/             # REST routes + WebSocket manager
│   ├── models/          # TypeScript interfaces
│   └── data/            # Runtime state (auto-created, git-ignored)
├── client/              # React 19 + Vite frontend (:5173)
│   └── src/
│       ├── components/  # UI components (2D graph, 3D scene, panels)
│       ├── hooks/       # useGraphData — WebSocket + HTTP data hook
│       └── types/       # Client-side TypeScript interfaces
├── ml/                  # Python anomaly detection pipeline
├── traffic-gen/         # HTTP traffic scenario runner
├── remote-collector/    # Optional push agent (not the default path)
├── scripts/             # Ground-truth simulator, wiki builder, exports
├── tests/               # npm test
├── wiki/                # Technical documentation (Markdown)
└── wiki visualizer/     # The same wiki as an illustrated HTML book (generated)
```

---

## Documentation

Full technical documentation lives in **[wiki/](./wiki/README.md)**: start at its index, which has reading paths by goal and every page. The same pages are published as an illustrated book with diagrams: open `wiki visualizer/index.html` (rebuild with `python3 scripts/build_wiki_visualizer.py`).

---

## Known Limitations

- **Connection sampling, not per-request tracing** — the sweep counts sockets in `ESTABLISHED` and `TIME_WAIT`. `TIME_WAIT` lingers ~60s, so short request/response cycles between two sweeps are usually still caught, but nothing here is a per-request record
- **No per-edge latency or error rate by default** — `edge.metrics` is `null` in a plain Docker/SSH deployment, and only a configured request-level source (access logs, Prometheus) fills it. Otherwise edge heat is graded on observed connection volume (`activity.samplesPerMin`), which is a concurrency proxy, not HTTP load
- **HTTP/1.1 log parsing only** — no HTTP/2 or gRPC log parsing
- **Linux targets only** — `/proc/net/tcp` is Linux-specific
- **No auto-retraining** — ML models must be retrained (from the ML page or by hand) as data accumulates
- **Single backend instance** — no built-in clustering

---

## Contact

- **GitHub Issues**: https://github.com/Royson-salis-18/microservice-mapper/issues
- **Email**: roysonsalis2005@gmail.com

---

*Royson Salis — September 2026*
