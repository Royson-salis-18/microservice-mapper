# Frameworks and why each was chosen

Four programs make up the project, and each was built with the smallest set of tools that does its job. This chapter lists them by program, says what each library is used for in this codebase, and explains why it was picked over the obvious alternative.

```
your machine                                               the target (EC2 / any Docker host)
┌──────────────────────────────────────────────┐          ┌───────────────────────────────┐
│  client      React 19 + Vite        :5173    │          │  docker, /proc, compose files │
│     │  /api (REST)  /ws (WebSocket)          │   SSH    │  (nothing of ours installed)  │
│  server      Node + Express 5 + ws  :3001 ───┼─────────►│                               │
│     │  reads ml/data/latest_scores.json      │   :22    │                               │
│  ml/         Python + scikit-learn           │          │                               │
│  traffic-gen Node                   :4400 ───┼── HTTP ─►│  the target's own front door  │
└──────────────────────────────────────────────┘          └───────────────────────────────┘
```

---

## Server (`server/`)

| Library | Version | Used for | Why this one |
|---|---|---|---|
| **TypeScript** run with **tsx** | TS 5.7, tsx 4 | All server code; `npm start` runs `tsx index.ts` with no build step | Types catch id and unit mistakes at compile time; tsx removes the compile loop in development |
| **Express** | 5.1 | The REST API in `server/api/routes.ts` (graph, incidents, reliability, ML control, traffic) | Small, well understood, and version 5 handles errors thrown by async handlers |
| **ws** | 8 | `server/api/websocket.ts`: pushes `graph-update`, `incident.updated`, `trace-*`, `TERMINAL_LOG` | A plain WebSocket server. Socket.IO's fallbacks and rooms are not needed |
| **ssh2** | 1.17 | `server/telemetry-platform/src/connection/SSHConnection.ts`: one connection per target, many `exec` channels | Pure JavaScript SSH client with key auth. No `ssh` binary or shell quoting games |
| **yaml**, **js-yaml** | 2.7 / 4 | Parsing compose files during discovery, to recover declared dependencies | Compose files are YAML; the two exist for historical reasons |
| **node:test** | built in | The test suite in `tests/*.test.ts` (`npm test`) | No framework to install or configure; runs under tsx like the server |

**Why Node for the server?** Most of the work is waiting on SSH channels and pushing JSON to browsers, which Node does well. Running the same language as the client also lets the shared rules (link thresholds, id formats) be checked against each other in one test file.

---

## Client (`client/`)

| Library | Version | Used for | Why this one |
|---|---|---|---|
| **React** | 19.2 | Every view; `App.tsx` routes between them | Component model, memoisation, huge ecosystem |
| **Vite** | 8 | Dev server on :5173 that proxies `/api` and `/ws` to :3001; the production build | Instant hot module reload; no bundler config to maintain |
| **TypeScript** | 6.0 | All client code; `client/src/types/index.ts` mirrors the server models | The same field names on both sides, checked |
| **@xyflow/react** (React Flow) | 12 | The 2D architecture graph: `GraphCanvas`, `ServiceNode`, `DependencyEdge` | Nodes are React components, so a service card is ordinary JSX and can be memoised per node |
| **three** + **@react-three/fiber** + **drei** | 0.186 / 9 / 10 | The 3D scene in `components/3d/` | react-three-fiber makes three.js objects into React components; drei supplies camera controls, text and HTML overlays |
| **recharts** | 3 | Sparklines and charts in Telemetry, Analytics, ML Pipeline | Declarative charts that suit small dashboard panels |
| **framer-motion** | 13 | Panel and list transitions | Spring animations without hand-written CSS keyframes |
| **lucide-react** | 1.45 | Icons (sidebar, service-type tiles) | Consistent stroke icons, tree-shaken |
| **oxlint** | 1.81 | `npm run lint` in `client/` | Very fast linter that catches real mistakes without a config to tune |

**What the client deliberately does not use:** no state library (the graph arrives as one WebSocket frame and lives in `useGraphData`), no CSS framework (`styles/index.css` holds design tokens as custom properties), no D3 force layout (layouts are deterministic functions in `layouts2d.ts` and `3d/layouts.ts`, so the picture does not wobble every time data arrives).

---

## ML pipeline (`ml/`)

| Library | Used for | Why |
|---|---|---|
| **pandas** | Reading `metrics_raw.csv`, per-service grouping, rates from counters | The natural tool for time-series tables |
| **numpy** | Feature vectors, z-scores | Everything scikit-learn eats |
| **scikit-learn** | `IsolationForest`, `LocalOutlierFactor`, `OneClassSVM` | Mature, well-documented unsupervised detectors from three different families |
| **joblib** | Saving and loading trained models (`ml/models/*.joblib`) | The standard way to persist scikit-learn models |

It is a separate process on purpose. Training can take minutes and must never stall the server's 5-second cycle. The two programs share nothing but files: `score.py` writes `ml/data/latest_scores.json`, and the server reads it, re-parsing only when the file's modification time changes.

---

## Traffic generator (`traffic-gen/`)

A small Node HTTP service on :4400 (`server.js`, `engine.js`) that drives realistic user workflows (browse, add to cart, check out) against a target's public entry point. The server starts and stops it through `server/traffic/TrafficController.ts`. It is separate because an idle system tells you very little: no traffic, no edges, no activity, nothing to learn. See [Generating traffic](20-traffic-experiments.md).

---

## How the four talk to each other

| From → to | Channel | What crosses |
|---|---|---|
| server → target | SSH :22, `exec` channels | Read-only commands; their stdout |
| server → browser | WebSocket `/ws` | `graph-update` (the whole graph, coalesced to at most one every 3 s), `incident.updated` (only when an incident visibly changes) |
| browser → server | REST `/api/*` | Selections, what-ifs, ML and traffic controls |
| ML → server | file `ml/data/latest_scores.json` | Per-service anomaly score, votes, persistence |
| server → ML | REST `GET /api/graph` | The live metrics `collector.py` and `score.py` sample |
| server → traffic-gen | HTTP :4400 | Start, stop and status of a workflow run |
| anything → server | `POST /api/ingest` with a bearer token | A telemetry envelope from an external collector (used by the ground-truth simulator) |
