# Microservice Mapper — Wiki

This wiki is the complete technical reference for the Microservice Mapper project. Every document reflects the actual codebase — no theoretical descriptions of features that don't exist.

---

## Documents

| # | File | What it covers |
|---|---|---|
| 01 | [overview.md](./01-overview.md) | What the system is, what it isn't, the core philosophy |
| 02 | [architecture.md](./02-architecture.md) | Component map, data flow, ports, persistence |
| 03 | [graphstore.md](./03-graphstore.md) | `GraphStore.ts` internals: data structures, read/write paths, edge heat |
| 04 | [id-system.md](./04-id-system.md) | Canonical IDs, `normalizeId()`, service name derivation |
| 05 | [telemetry-ingestion.md](./05-telemetry-ingestion.md) | `ingestRemote()` — all 8 processing stages with code |
| 06 | [node-edge-lifecycle.md](./06-node-edge-lifecycle.md) | Target status, node pruning, edge status, ghost prevention |
| 07 | [remote-collector.md](./07-remote-collector.md) | Docker socket, log parsing, `/proc/net/tcp`, SSH tunnel |
| 08 | [rca-engine.md](./08-rca-engine.md) | Scoring algorithm, factors & weights, propagation BFS, incident lifecycle |
| 09 | [frontend.md](./09-frontend.md) | React hooks, layout system, component reference, edge visuals |
| 10 | [websocket.md](./10-websocket.md) | Protocol, broadcast, terminal multiplexer, sentinel pattern |
| 11 | [ml-pipeline.md](./11-ml-pipeline.md) | IsolationForest stages, server integration, honest limitations |
| 12 | [data-models.md](./12-data-models.md) | All TypeScript interfaces with field-level annotations |
| 13 | [api-reference.md](./13-api-reference.md) | Full REST API + WebSocket protocol |
| 14 | [configuration.md](./14-configuration.md) | All env vars, config files, data file locations |
| 15 | [troubleshooting.md](./15-troubleshooting.md) | Common issues, known bugs, diagnosis runbook |

---

## Quick Links

- **Understanding the graph:** Start with [01-overview.md](./01-overview.md) → [02-architecture.md](./02-architecture.md)
- **How data flows:** [05-telemetry-ingestion.md](./05-telemetry-ingestion.md)
- **Why nodes disappear:** [06-node-edge-lifecycle.md](./06-node-edge-lifecycle.md) → Node Pruning section
- **Setting up a new target:** [14-configuration.md](./14-configuration.md) → Target SSH Config section
- **"Why does edge X show grey?":** [09-frontend.md](./09-frontend.md) → Edge Visualization Semantics
- **Debugging no metrics:** [15-troubleshooting.md](./15-troubleshooting.md)
- **RCA scoring explained:** [08-rca-engine.md](./08-rca-engine.md) → Scoring Algorithm
- **ML anomaly detection:** [11-ml-pipeline.md](./11-ml-pipeline.md)
