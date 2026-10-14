# Separating the ML pipeline from the mapper core

**Status:** the navigation change is done (ML screens are under "Advanced", hidden by default; toggle at the bottom of the sidebar). The code separation below is planned, not built.

## Who needs what (DevOps / on-call)

| Need | Screen | Daily? |
|---|---|---|
| What is broken right now, why, what to try first | Incidents | yes |
| Where it sits and what it touches | Spatial view, Architecture | yes |
| Dig in | Telemetry, Traces, Dependencies, Analytics | when investigating |
| Rehearse failures | Experiments (+ the bench fault injector) | when testing |
| Research tooling | Model findings, ML pipeline | no |

## Where ML touches the core today

* `server/api/routes.ts` `/api/ml/*` (about 200 lines): status, config, processes (start/stop python scripts), models, features.
* `ml/` (python): collector, preprocess, train, score. Writes scores that become `node.analytics.anomalyScore`.
* `CascadeEngine.intrinsicProbability` and `RiskEngine.computeHealth` read `analytics.anomalyScore` when present. Both already treat it as **optional**; incidents and root-cause ranking do not use it at all (they use the statistical detector).
* Client: `MLPipelineView`, `MLExecutionPanel`, `FindingsView`.

## Plan

1. **Server:** move the `/api/ml/*` routes into `server/ml/routes.ts`, mounted only when `ENABLE_ML=1` (default off). Nothing else imports from it.
2. **Contract:** `analytics.anomalyScore` stays the single optional input from ML into the core, documented in `MAPPER_ALGORITHMS.md`; add a test that cascade and health give sensible results with it absent.
3. **Client:** lazy-load the three ML views so they cost nothing when hidden; hide the toggle too unless the server reports ML enabled.
4. **Purity test:** extend `tests/purity.test.ts` with "core modules do not import `server/ml`".
5. **Docs:** a separate `ml/README.md` for the research side; the mapper docs stop mentioning it except for the one optional input.
