# algorithms

Every algorithm of the mapper, explained in a Markdown page and written as short, readable Python.

The real system runs the TypeScript versions in `server/algorithms/` (same ideas, same numbers). These Python files are the simplified twins: you can run them, read them top to bottom, and explain them without knowing TypeScript. Standard library only, no installs.

```
python3 algorithms/run_all_tests.py        # runs every test file below
python3 algorithms/detection/anomaly_detector.py   # any file runs on its own and prints a small demo
```

| Folder | Page | Python files | Question it answers |
|---|---|---|---|
| `detection/` | [detection.md](detection/detection.md) | `anomaly_detector`, `container_facts`, `features`, `request_stats`, `scoring`, `thresholds` | Is this service behaving abnormally compared with its own past? |
| `model/` | [model.md](model/model.md) | `target_model` | What does "normal" look like for one whole project, and where should its alarm line sit? |
| `rca/` | [rca.md](rca/rca.md) | `rca_engine`, `temporal_analyzer`, `explanation_engine` | Several services look bad: which one is the root cause? |
| `graph/` | [graph.md](graph/graph.md) | `cascade_engine`, `edge_weights`, `consistency`, `link_thresholds`, `service_roles` | Who calls whom and how strongly, and who will fail next? |
| `learning/` | [learning.md](learning/learning.md) | `logreg`, `dataset`, `evaluate`, `experiment` | Can a model learn to combine the signals better than the rules? |
| `evaluation/` | [evaluation.md](evaluation/evaluation.md) | `score`, `stats`, `infer` | How good is the mapper, measured against the fault injector's answer key? |

Each `.py` mirrors one TypeScript file; the name is the TypeScript name in snake_case (`RCAEngine.ts` is `rca_engine.py`). The docstring at the top of every file says which one and what was left out (storage, ids, UI bookkeeping).

## The four core topics, and where each one lives

If you only have time for the core logic, these are the files (everything else in this folder is supporting material):

| Topic | Read first | Then |
|---|---|---|
| **Preprocessing** (raw readings into clean numbers) | `detection/request_stats.py` (log lines into request rate, error share, latency), `detection/features.py` (the 18 numbers per service) | `detection/container_facts.py`, `detection/thresholds.py` |
| **Anomaly detection** (is it abnormal?) | `detection/anomaly_detector.py` | `model/target_model.py` (per-project baseline and alarm line) |
| **Root cause analysis (RCA)** | `rca/rca_engine.py` | `rca/temporal_analyzer.py`, `rca/explanation_engine.py` |
| **Cascading failure** | `graph/cascade_engine.py` | `graph/edge_weights.py` (how strongly a service depends on another) |
| **Machine learning** | `learning/logreg.py`, `learning/experiment.py` | `learning/dataset.py`, `learning/evaluate.py` |

Supporting only: `evaluation/` (how we scored the mapper), `graph/consistency.py`, `graph/link_thresholds.py`, `graph/service_roles.py`, `detection/scoring.py`.

A smaller teaching version of just the three core steps (detect, root cause, cascade) with a runnable demo is in `../core_logic/`.

## Why is the real system written in TypeScript?

Short answer you can give: **the product is a web application, and TypeScript lets the server, the collector and the dashboard share one language and one set of data types.** The maths is simple enough to be written in any language; Python versions of it are in this folder.

The reasons, in the order to say them:

1. **The dashboard has to be JavaScript.** It runs in the browser (React, plus three.js for the 3D map). So there is a JavaScript project anyway. Using TypeScript for the server too means one language to learn, one package manager, one test runner.
2. **One set of data shapes.** A service, a link, an incident and an anomaly look the same in the collector, the server and the browser. TypeScript checks that every part agrees on those shapes, which catches mistakes (a renamed field, a number that can be missing) before the program runs. With several parts exchanging JSON all the time, that matters.
3. **The logic runs inside the live server.** The detector, root cause and cascade run every 5 seconds on fresh data, in the same process that stores the data and serves the API. Writing them in TypeScript avoids running a second program (Python) next to the server and passing data between them.
4. **Docker and SSH libraries and real-time features are first class in Node.** The collector talks to the Docker engine (`dockerode`), the server holds SSH sessions (`ssh2`) and pushes live updates over WebSockets. These are mature, well supported in Node.
5. **The same logic is reused everywhere.** The exact files the server uses are also used by the tests, by the command line tools that score the mapper against the fault injector, and by the report builders. One implementation, so the tests test what really runs.

Be honest about the trade-off if asked "why not Python?": Python is the usual language for data science and is easier to read, which is why the machine learning experiments (`ml/`) are in Python and why this folder and `core_logic/` exist. Using it for the whole product would mean keeping two runtimes, converting data between them, and losing the shared types with the dashboard. For this tool the benefit of one language outweighed that.

## Reading order for the evaluation

1. `detection/detection.md` (the core idea: compare with your own past)
2. `rca/rca.md` (cause versus victims)
3. `graph/graph.md` (the cascade formula)
4. `model/model.md` and `learning/learning.md` (what is learned, and why the learned model is not used)
5. `evaluation/evaluation.md` (how we measured it)
