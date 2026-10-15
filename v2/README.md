# Microservice Mapper v2 (research track)

v2 sits next to the working mapper and does not change it. It takes the weak spots that benchmarking found in v1 and tries
better methods for each, measured with exactly the same scoring as v1, on the same recorded and synthetic fault runs.
A method moves into v1 only if it wins here.

| Folder | Question | Status |
|---|---|---|
| `core/` | Shared inputs and scoring: every run replayed once through the v1 engines and cached; the v1 event-level scorer; v1 rules, ML and hybrid as baselines | done |
| `report/` | A postmortem page per run: one timeline with every service, the injected faults, the alarms and who was named first | done |
| `causal/` | Can call directions be learned from the telemetry instead of guessed from service names? Does that improve root cause? | done: learned directions match the true-direction ceiling and, unlike the name rule, survive unknown names |
| `onset/` | Do change-point onset times (who changed first) improve root cause or detect faults earlier? | done: change-point alarms roughly halve detection delay on the real benches; onset ranking is net neutral |
| `diagnose/` | Once an incident is raised, can the fault type be recognised (crash, stop, memory leak, throttling, slow network...) and a runbook attached? | done: a random forest recognises the fault class with 99% accuracy when the suspect is right |

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

## Results

All numbers use the v1 event-level scoring (`v2/core/score.ts`). The current default engine, v1 hybrid, is the baseline.

### causal: learn call directions from telemetry

v1 points each dependency edge by SERVICE NAMES (gateway calls db). That fails when names are uninformative. The learned
method points an edge by which service's changes lead the other's (lagged implication, cross-correlation and traffic ratio),
from the run's own history.

Direction accuracy on the observed pairs that are real calls, at end of run:

| | real, names available | real, names hidden | held-out synthetic, names hidden |
|---|---|---|---|
| v1 name rule | 21/31 right, 10 unknown | 0/31 right, 31 unknown | 95/204 right, 109 unknown |
| learned (ours) | 28/31 right, 3 wrong | 28/31 right, 3 wrong | 197/204 right |

The name rule collapses when names are hidden; the learned method does not change. Fed into the random walk, learned
directions reach caught-and-named 71% on the real benches against a 73% ceiling from the true graph and 68% with no
directions at all; the name rule reaches 69% once names are hidden. Directions are worth about 6 points of root cause, and
the learned ones recover almost all of it without reading names.

### onset: change-point detection for earlier alarms

Online Page-Hinkley / CUSUM / Bayesian change-point detectors on the raw metrics. Used as an extra alarm, they roughly
halve the median detection delay on the real benches (10.5 s to 4.9 s, paired over 56 faults) and lift detection from 90%
to 95%, for about 1.5 extra false alarms per hour. Used to re-rank by temporal precedence they are net neutral (they fix
some gradual faults and break others), so the random walk stays the ranker. See `onset/README.md`.

### diagnose: name the fault type and attach a runbook

At the first alarm, take the engine's top suspect and classify the fault (crash, stop, pause, crash-loop, flap, memory,
brownout, latency, partition) from 35 features, then show a short runbook. A hand-written random forest reaches, 30 seconds
after the alarm:

| | held-out synthetic | real (cross-domain) |
|---|---|---|
| accuracy on the engine's suspect | 77% | 55 to 59% |
| accuracy on the true service (oracle) | 99% | 73 to 84% |

When the engine names the right service, the class is almost always right (99% on synthetic). The gap on real runs is the
synthetic-to-real shift (real flaps are pause cycles, real brownouts on idle services show no throttling); the hand-written
decision list transfers best there. See `diagnose/README.md`.

### Where this leaves v1

- The learned directions are the clearest win: same accuracy as perfect directions, and robust to naming. A candidate to
  replace the name rule in v1.
- Change-point alarms are a clear win for detection latency on gradual faults, at a small false-alarm cost.
- Onset re-ranking and learned edge weights did not beat the current walk and are kept as studied negatives.
- Fault-type diagnosis is accurate once the suspect is right, and is a useful add-on rather than a change to detection or ranking.

