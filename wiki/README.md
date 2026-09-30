# Microservice Mapper — Wiki & Architecture Reference

This wiki is the complete technical authority for the Microservice Mapper project. Every document reflects the actual codebase — verified against implementation code, data models, APIs, and algorithms.

---

## Complete Table of Documents

| # | File | Subsystem & What it Covers | Category |
|---|---|---|---|
| 01 | [01-overview.md](./01-overview.md) | What the system is, what it isn't, zero-instrumentation philosophy | Foundations |
| 02 | [02-architecture.md](./02-architecture.md) | Component map, data flow, ports, reverse SSH tunnels, persistence | Foundations |
| 03 | [03-graphstore.md](./03-graphstore.md) | `GraphStore.ts` internals: data structures, read/write paths, edge heat | Core Engine |
| 04 | [04-id-system.md](./04-id-system.md) | Canonical IDs, `normalizeId()`, ghost-node prevention | Core Engine |
| 05 | [05-telemetry-ingestion.md](./05-telemetry-ingestion.md) | `ingestRemote()` — all 8 processing stages with code | Core Engine |
| 06 | [06-node-edge-lifecycle.md](./06-node-edge-lifecycle.md) | Target status, node pruning (15m), edge status, ghost prevention | Core Engine |
| 07 | [07-remote-collector.md](./07-remote-collector.md) | Docker socket, log stream demuxing, `/proc/net/tcp` hex decoding | Data Plane |
| 08 | [08-rca-engine.md](./08-rca-engine.md) | Scoring algorithm, 4 factors & weights, BFS propagation, incident lifecycle | Intelligence |
| 09 | [09-frontend.md](./09-frontend.md) | React 19 hooks, XYFlow 2D graph, Three.js 3D vision, component reference | Frontend |
| 10 | [10-websocket.md](./10-websocket.md) | WS protocol, broadcast engine, terminal multiplexer, sentinel pattern | Transport |
| 11 | [11-ml-pipeline.md](./11-ml-pipeline.md) | IsolationForest stages, Python sidecar, server integration, limitations | Machine Learning |
| 12 | [12-data-models.md](./12-data-models.md) | All TypeScript interfaces (`ServiceNode`, `DependencyEdge`, `TelemetryEnvelope`) | Reference |
| 13 | [13-api-reference.md](./13-api-reference.md) | Full REST API routes + WebSocket specifications verified against server code | Reference |
| 14 | [14-configuration.md](./14-configuration.md) | All env vars, `remote_config.json`, `ml/config.json`, data storage paths | Operations |
| 15 | [15-troubleshooting.md](./15-troubleshooting.md) | Common issues, known bugs, diagnosis runbook, SSH lockouts | Operations |
| 16 | [16-change-log-and-rationale.md](./16-change-log-and-rationale.md) | What changed, why, and where — architectural decisions and fixes | History & Decisions |
| 17 | [17-findings-vs-incidents.md](./17-findings-vs-incidents.md) | Rule-based alerts vs unsupervised ML model output separation | Intelligence |
| 18 | [18-telemetry-tiers-plan.md](./18-telemetry-tiers-plan.md) | Tier 0/1/2 telemetry sources, provenance guarantees, phased rollout | Data Plane |
| 19 | [19-how-it-all-works.md](./19-how-it-all-works.md) | **Start here.** Plain-language doctor analogy, then complete technical deep dive | Foundations |
| 20 | [20-traffic-experiments.md](./20-traffic-experiments.md) | Traffic Controller, SWEEP discovery mode, ExperimentManager, telemetry correlation | Traffic & Testing |
| 21 | [21-connection-layer.md](./21-connection-layer.md) | Connection layer, SSH infrastructure, HostKey verification, streaming execution | Infrastructure |
| 22 | [22-risk-engine.md](./22-risk-engine.md) | Risk Engine, Blast Radius computation, weighted composite risk exposure | Intelligence |
| 23 | [23-endpoint-discovery.md](./23-endpoint-discovery.md) | EndpointDiscoveryEngine, TargetAgent lifecycle, EndpointRegistry route tracking | Discovery |
| 24 | [24-client-frontend.md](./24-client-frontend.md) | Client frontend architecture: 11 views, state hooks, 2D/3D dual rendering | Frontend |
| 25 | [25-telemetry-sources.md](./25-telemetry-sources.md) | Telemetry sources plugin system, Prometheus integration, source provenance | Data Plane |
| 26 | [26-ml-pipeline-deep-dive.md](./26-ml-pipeline-deep-dive.md) | Python ML sidecar code-level analysis: collector, preprocess, train, score | Machine Learning |
| 27 | [27-project-technical-reference.md](./27-project-technical-reference.md) | Full 32-section Engineering Manual & Technical Reference Specification | Reference |
| 28 | [28-mapper-technical-reference.md](./28-mapper-technical-reference.md) | 11-section Mapper Technical Reference (Process topology, tiers, ML, limits) | Reference |

---

## Chronological Workflow: "First We Did This, Then We Did This"

1. **Phase 1: Target Discovery & SSH Connection Layer** ([21-connection-layer.md](./21-connection-layer.md), [23-endpoint-discovery.md](./23-endpoint-discovery.md))
   - Established secure SSH tunnels to remote EC2 instances without pre-installing agents.
   - Parsed `docker-compose.yml` to extract declared topology and service labels.

2. **Phase 2: Remote Collector Daemon & Telemetry Extraction** ([07-remote-collector.md](./07-remote-collector.md), [25-telemetry-sources.md](./25-telemetry-sources.md))
   - Deployed minimal Node.js collector container streaming Docker socket stats.
   - Decoded `/proc/net/tcp` kernel tables into active socket pairs and demuxed HTTP logs.

3. **Phase 3: Central GraphStore & Canonical Ingestion** ([03-graphstore.md](./03-graphstore.md), [04-id-system.md](./04-id-system.md), [05-telemetry-ingestion.md](./05-telemetry-ingestion.md))
   - Implemented `normalizeId()` to eradicate ghost duplicates across targets.
   - Executed the 8-stage `ingestRemote()` pipeline merging declared and observed edges.

4. **Phase 4: Real-time 2D & 3D Interactive Frontend** ([09-frontend.md](./09-frontend.md), [10-websocket.md](./10-websocket.md), [24-client-frontend.md](./24-client-frontend.md))
   - Built React 19 + XYFlow 2D topology canvas and Three.js 3D visualizer.
   - Connected WebSocket broadcast engine for real-time node halos and packet pulse animations.

5. **Phase 5: Intelligence, Root Cause Analysis & Risk Engine** ([08-rca-engine.md](./08-rca-engine.md), [22-risk-engine.md](./22-risk-engine.md), [17-findings-vs-incidents.md](./17-findings-vs-incidents.md))
   - Engineered the 4-factor heuristic RCA scoring algorithm with BFS cascade tracing.
   - Built the Risk Engine for dynamic blast radius and vulnerability exposure calculations.

6. **Phase 6: Synthetic Traffic Generation & ML Anomaly Detection** ([20-traffic-experiments.md](./20-traffic-experiments.md), [11-ml-pipeline.md](./11-ml-pipeline.md), [26-ml-pipeline-deep-dive.md](./26-ml-pipeline-deep-dive.md))
   - Orchestrated endpoint sweep traffic scenarios to exercise observed routes.
   - Trained unsupervised IsolationForest and LOF models in a Python sidecar to detect metric drift.

---

## Quick Navigation Links

- **Complete System Walkthrough:** [19-how-it-all-works.md](./19-how-it-all-works.md)
- **Comprehensive Technical Reference Spec:** [27-project-technical-reference.md](./27-project-technical-reference.md)
- **Data Models & Schemas:** [12-data-models.md](./12-data-models.md)
- **API Reference:** [13-api-reference.md](./13-api-reference.md)
- **Troubleshooting & Operations:** [15-troubleshooting.md](./15-troubleshooting.md)
