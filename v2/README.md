# Microservice Mapper v2 (research track)

v2 sits next to the working mapper and does not change it. It takes the weak spots that benchmarking found in v1 and tries
better methods for each, measured with exactly the same scoring as v1, on the same recorded and synthetic fault runs.
A method moves into v1 only if it wins here.

| Folder | Question | Status |
|---|---|---|
| `core/` | Shared inputs and scoring: every run replayed once through the v1 engines and cached; the v1 event-level scorer; v1 rules, ML and hybrid as baselines | done |
| `report/` | A postmortem page per run: one timeline with every service, the injected faults, the alarms and who was named first | done |
| `causal/` | Can call directions be learned from the telemetry instead of guessed from service names? Does that improve root cause? | CAUSAL_STATUS |
| `onset/` | Do change-point onset times (who changed first) improve root cause or detect faults earlier? | ONSET_STATUS |
| `diagnose/` | Once an incident is raised, can the fault type be recognised (crash, stop, memory leak, throttling, slow network...) and a runbook attached? | DIAGNOSE_STATUS |

## How to run

```bash
# 1. build the caches (once; a few minutes each). Synthetic runs: npm run ml:synth -- --campaigns 16 --seed 1 --out <dir>
node server/node_modules/tsx/dist/cli.mjs v2/core/trace.ts v2/.cache/real.json run/recorded-runs/runC
node server/node_modules/tsx/dist/cli.mjs v2/core/trace.ts v2/.cache/tune.json <tuning run dirs>
node server/node_modules/tsx/dist/cli.mjs v2/core/trace.ts v2/.cache/test.json <held-out run dirs>

# 2. the v1 engines on the caches (must match npm run ml:hybrid)
node server/node_modules/tsx/dist/cli.mjs v2/eval/baseline.ts v2/.cache/real.json

# 3. postmortem pages (open the HTML files in a browser)
node server/node_modules/tsx/dist/cli.mjs v2/report/postmortem.ts v2/.cache/real.json --out v2/reports

# 4. each research module
node server/node_modules/tsx/dist/cli.mjs v2/causal/run.ts
node server/node_modules/tsx/dist/cli.mjs v2/onset/run.ts
node server/node_modules/tsx/dist/cli.mjs v2/diagnose/run.ts
```

## Rules every module follows

- Settings are chosen on the synthetic tuning runs only. The held-out synthetic runs and the real recorded runs are scored once.
- Everything is causal: a decision at a moment uses only what was known at that moment.
- The true call graph and the fault labels are used to score, never by an engine.
- Results are reported as measured, including the ones that did not help.

RESULTS_SECTION
