# Microservice Mapper — Wiki

Microservice Mapper watches a running Docker microservice system **from the outside**: over one SSH connection, installing nothing. From the socket tables and container stats it builds a live dependency graph, judges what is wrong (root cause), and looks ahead (cascade risk), then shows the result in 2D and 3D.

Every page here is checked against the code. Where a page gives a number, a formula or a threshold, it is the one the code uses. Several worked examples were produced by running the real engines.

The same pages are published as an illustrated book with diagrams and interactive labs: run `python3 scripts/build_wiki_visualizer.py` and open `wiki visualizer/index.html`.

---

## Where to start

| If you want to… | Read |
|---|---|
| understand it in 10 minutes | [01 What this is](01-overview.md) → [19 How it all works](19-how-it-all-works.md) → [29 The rules it is built on](29-design-principles.md) |
| know why it is built this way | [29 Design principles](29-design-principles.md) → [30 Frameworks and why](30-tech-stack.md) → [17 Two opinions](17-findings-vs-incidents.md) |
| trust (or check) a number | [31 Measuring precisely](31-measurement-precision.md) → [32 Keeping the numbers honest](32-accuracy-and-self-check.md) |
| understand the maths | [03 Graph store](03-graphstore.md) → [08 Root cause](08-rca-engine.md) → [22 Risk and cascades](22-risk-engine.md) → [11 ML](11-ml-pipeline.md) |
| read the screen | [33 Reading the picture](33-visual-language.md) → [24 Client views](24-client-frontend.md) |
| change the code | [34 Code tour](34-code-tour.md) → [35 Working on it](35-dev-workflow.md) → [13 API](13-api-reference.md) → [12 Data models](12-data-models.md) |

---

## All pages

| # | Page | Covers |
|---|---|---|
| **Understanding the system** | | |
| 01 | [01-overview.md](01-overview.md) | What it is and is not; the one constraint (nothing installed on the target) |
| 19 | [19-how-it-all-works.md](19-how-it-all-works.md) | The whole loop in plain language, then in detail |
| 29 | [29-design-principles.md](29-design-principles.md) | **The rules behind the code**, and a register of design decisions with the alternatives considered |
| 02 | [02-architecture.md](02-architecture.md) | The layers, processes, ports and what crosses between them |
| 30 | [30-tech-stack.md](30-tech-stack.md) | **Every framework, what it is used for, and why it was chosen** |
| **Getting the data** | | |
| 21 | [21-connection-layer.md](21-connection-layer.md) | SSH, host keys, streaming exec, recovery |
| 23 | [23-endpoint-discovery.md](23-endpoint-discovery.md) | Discovery engine per target, the poll, sweep and rediscovery loops |
| 31 | [31-measurement-precision.md](31-measurement-precision.md) | **Exact network counters, CPU vs allowance, distinct connections, IPv4-mapped decoding, direction, thresholds** |
| 25 | [25-telemetry-sources.md](25-telemetry-sources.md) | The source abstraction; Prometheus (Tier 2, opt-in) |
| 18 | [18-telemetry-tiers-plan.md](18-telemetry-tiers-plan.md) | Tier 0 / 1 / 2: what is always, sometimes, rarely available |
| 07 | [07-remote-collector.md](07-remote-collector.md) | The *optional* push agent (not the default path) |
| **Building the graph** | | |
| 03 | [03-graphstore.md](03-graphstore.md) | The in-memory model: ingest, activity, baselines, connections, broadcasts |
| 04 | [04-id-system.md](04-id-system.md) | `project:name` ids and `normalizeId()` |
| 05 | [05-telemetry-ingestion.md](05-telemetry-ingestion.md) | How an envelope becomes nodes, edges and metrics |
| 06 | [06-node-edge-lifecycle.md](06-node-edge-lifecycle.md) | Ageing, pruning, and edge direction from listening ports |
| **Forming a judgement** | | |
| 17 | [17-findings-vs-incidents.md](17-findings-vs-incidents.md) | Why rule-based incidents and learned findings are kept apart |
| 08 | [08-rca-engine.md](08-rca-engine.md) | Root cause: five factors, materiality, victim penalty, independent failures, a real worked example |
| 22 | [22-risk-engine.md](22-risk-engine.md) | Health, criticality, risk; the noisy-OR cascade model; what-if and blast radius |
| 11 | [11-ml-pipeline.md](11-ml-pipeline.md) | Four detectors per service, majority vote, persistence |
| 26 | [26-ml-pipeline-deep-dive.md](26-ml-pipeline-deep-dive.md) | The ML pipeline at code level |
| **Driving the system** | | |
| 20 | [20-traffic-experiments.md](20-traffic-experiments.md) | Traffic controller and experiments |
| **Seeing it** | | |
| 09 | [09-frontend.md](09-frontend.md) | The client: hooks, 2D graph, views |
| 33 | [33-visual-language.md](33-visual-language.md) | **What every colour, width and pulse means**; the inspector; the 3D islands; why it looks the way it does |
| 24 | [24-client-frontend.md](24-client-frontend.md) | Views, layouts, inspectors, the data hook |
| 10 | [10-websocket.md](10-websocket.md) | The WebSocket protocol |
| **Trusting it and working on it** | | |
| 32 | [32-accuracy-and-self-check.md](32-accuracy-and-self-check.md) | **Ground-truth simulator, the 12 consistency rules, the tests, what the audit fixed** |
| 34 | [34-code-tour.md](34-code-tour.md) | **Repository map; a measurement and a failure followed through the code; where to change things** |
| 35 | [35-dev-workflow.md](35-dev-workflow.md) | **Run, check, prove: the isolated server + simulator loop, screenshots, building this book** |
| **Reference** | | |
| 36 | [36-glossary.md](36-glossary.md) | Every term used in a specific sense, with where it is defined |
| 12 | [12-data-models.md](12-data-models.md) | Every interface, with units and null semantics |
| 13 | [13-api-reference.md](13-api-reference.md) | Every route, including reliability and consistency |
| 14 | [14-configuration.md](14-configuration.md) | Environment, config files, data paths |
| 15 | [15-troubleshooting.md](15-troubleshooting.md) | Diagnosis runbook |
| 16 | [16-change-log-and-rationale.md](16-change-log-and-rationale.md) | What changed, and why |
| 27 | [27-project-technical-reference.md](27-project-technical-reference.md) | Long-form engineering manual (older; the chapters above take precedence) |
| 28 | [28-mapper-technical-reference.md](28-mapper-technical-reference.md) | Subsystem reference (older; the chapters above take precedence) |

---

## How the project was built, in order

1. **Reach the target without installing anything.** SSH to the host and read Docker and `/proc` from outside. Parse compose files for declared dependencies. → 21, 23
2. **Turn sockets into a graph.** Canonical `project:name` ids, declared vs observed evidence, and direction from listening ports (which removed a reversed duplicate of every link). → 03, 04, 05, 06
3. **Show it live.** React 19 + XYFlow for 2D, react-three-fiber for 3D, one WebSocket frame per change. → 09, 10, 24
4. **Judge it.** Rule-based incidents with additive, explainable RCA; risk and blast radius; ML findings kept separate. → 08, 17, 22
5. **Drive it and learn from it.** A traffic generator so there is something to observe; a per-service ML pipeline. → 20, 11, 26
6. **Make the judgement sharper.** Edge weights (confidence × reliance), the noisy-OR cascade model, structural criticality, materiality and the victim penalty in RCA, a four-detector ML ensemble. → 22, 08, 11
7. **Make every number exact.** A ground-truth simulator, the accuracy audit (exact network counters, CPU against allowance, distinct connections, IPv4-mapped decoding, ids everywhere, shares that sum to 1), and a live self-check. → 31, 32
8. **Make it readable.** One visual language for 2D and 3D: warm means trouble, pulses follow the traffic rate, thickness is reliance; flat 2D cards; the 3D islands. → 33
