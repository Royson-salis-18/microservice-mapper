# Glossary

The words this project uses in a specific sense. Each entry says what the term means here and where it is defined.

| Term | Meaning here | Defined in |
|---|---|---|
| **activity index** | `samplesPerMin`: socket sightings per minute on a link. Good for comparing two links, wrong for counting requests | `GraphStore.applyEdgeActivity` · [31](31-measurement-precision.md) |
| **affected** | A service showing a symptom in an open incident (failing, or with a measured anomaly). Listed by id | `RCAEngine` · [08](08-rca-engine.md) |
| **allowance** | How many CPU cores a container may use: its `--cpus` limit, else quota ÷ period, else the host's core count | `MetricCollector` · [31](31-measurement-precision.md) |
| **baseline** | `baselinePerMin`: a slow average of a link's activity (rises in about 1 min, falls in about 10). Used for weights so a dead callee keeps its importance | `GraphStore` · [03](03-graphstore.md) |
| **blast radius** | Everyone who calls a service, directly or through others, over observed edges, with hop distance | `RiskEngine.computeBlastRadius` · [22](22-risk-engine.md) |
| **callee / caller** | In `A → B`, A is the caller and B the callee. A depends on B | [06](06-node-edge-lifecycle.md) |
| **candidate** | A symptomatic service scored as a possible root cause | `RCAEngine` · [08](08-rca-engine.md) |
| **cascade probability** | `failureProbability`: P(n) from the noisy-OR model. An estimate under a stated model, not an observed frequency | `CascadeEngine` · [22](22-risk-engine.md) |
| **confidence (edge)** | How sure we are a dependency exists and points this way: 1.0 (listen port) down to 0.4 (declared only) | `EdgeWeights.edgeConfidence` · [29](29-design-principles.md) |
| **confidence (RCA)** | HIGH / MEDIUM / LOW / UNKNOWN for a root cause, from its score and evidence; forced LOW for independent failures | `RCAEngine` · [08](08-rca-engine.md) |
| **connKey** | `callerIp:port>calleeIp:port`: identifies one TCP connection, so it is counted once | `MetricCollector` · [31](31-measurement-precision.md) |
| **consistency check** | Twelve invariants between published numbers, checked live and in tests | `consistency.ts` · [32](32-accuracy-and-self-check.md) |
| **criticality** | Share of a project's traffic disrupted if this service alone failed, through the cascade model | `structuralCriticality` · [22](22-risk-engine.md) |
| **declared** | An edge a config file claims (`depends_on`), whether or not it was seen | [01](01-overview.md) |
| **dependency (share)** | `weight.dependency`: the caller's share of its traffic going to this callee. Sums to 1 per caller and kind | `EdgeWeights` · [31](31-measurement-precision.md) |
| **ensemble** | The four ML detectors per service, combined by majority vote, scored by their median | `ml/ensemble.py` · [11](11-ml-pipeline.md) |
| **explains** | A candidate explains another symptomatic service when that service depends on it through a material path (reach ≥ 0.1) | `RCAEngine` · [08](08-rca-engine.md) |
| **finding** | An ML ensemble anomaly. Never raises an incident | [17](17-findings-vs-incidents.md) |
| **health score** | 0–1, a weighted average of status, anomaly and incident role, renormalised when a factor is missing | `RiskEngine.computeHealth` · [22](22-risk-engine.md) |
| **incident** | A rule-based alert for a target, with a root cause, candidates, propagation and explanation | `IncidentManager` · [08](08-rca-engine.md) |
| **independent failure** | Several services symptomatic, but the top candidate explains none of them: two problems, not one | `RCAEngine` · [08](08-rca-engine.md) |
| **islands** | The default 3D layout: a district per project, a raised platform per role | `3d/site.ts` · [33](33-visual-language.md) |
| **isolated server** | A second mapper on another port, working directory and token, fed by the simulator | [35](35-dev-workflow.md) |
| **material path** | A dependency path with strength ≥ `MATERIAL_REACH` (0.1) | `RCAEngine` · [08](08-rca-engine.md) |
| **noisy-OR** | P = 1 − Π(1 − pᵢ): fails if any independent route to failure fires | `CascadeEngine` · [22](22-risk-engine.md) |
| **observed** | An edge seen carrying traffic in a socket table or request log | [06](06-node-edge-lifecycle.md) |
| **onset** | When an anomaly first appeared; kept for as long as it lasts, so "who went first" is real | `AnomalyDetector` · [08](08-rca-engine.md) |
| **p95** | 95th-percentile latency; preferred over the mean for link status because it shows the slow tail | `linkThresholds.ts` · [31](31-measurement-precision.md) |
| **persistent anomaly** | The ensemble called a service anomalous for N (3) windows in a row | `ml/score.py` · [11](11-ml-pipeline.md) |
| **propagation** | The path a failure took from the root cause to its callers | `RCAEngine` · [08](08-rca-engine.md) |
| **pulse rate** | Pulses per second on a link: `0.3 + 1.6·log10(1 + rate)`, capped at 5 | `linkFlow.ts` · [33](33-visual-language.md) |
| **reach** | Strength of the strongest dependency path from one service down to another: the product of weights along it | `dependencyReach` · [08](08-rca-engine.md) |
| **risk score** | Current exposure: half (1 − health), half criticality. Not a probability | `RiskEngine` · [22](22-risk-engine.md) |
| **simulator** | `scripts/simulate-target.ts`: a target with a known topology, socket model and scripted failures | [32](32-accuracy-and-self-check.md) |
| **sweep** | One pass reading every container's socket tables and interface counters | `EndpointDiscoveryEngine` · [31](31-measurement-precision.md) |
| **τ (transmission)** | Share of a dependency's failure that reaches its caller in the cascade model: 0.7 | `CascadeEngine` · [22](22-risk-engine.md) |
| **target** | One monitored host/project, e.g. `sock-shop`; every id is prefixed with it | [04](04-id-system.md) |
| **telemetry edge** | A link to or from an observability component (collector, Prometheus…). Weighted at 0.1 | `EdgeWeights` · [22](22-risk-engine.md) |
| **tier** | Where a number came from: 0 outside (always), 1 gateway log (sometimes), 2 the target's own metrics (opt-in) | [18](18-telemetry-tiers-plan.md) |
| **victim penalty** | Up to −0.25 for a candidate whose own callees are failing: more likely downstream than the origin | `RCAEngine` · [08](08-rca-engine.md) |
| **weight** | confidence × dependency (× 0.1 for telemetry): how badly a caller is hit if this callee fails | `EdgeWeights` · [22](22-risk-engine.md) |
| **what-if** | The cascade model re-solved with one service forced to fail | `simulateFailure` · [22](22-risk-engine.md) |
