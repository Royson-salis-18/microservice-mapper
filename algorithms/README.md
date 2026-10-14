# algorithms

The core logic of the mapper as short Python files you can read in about 20 minutes and run with nothing installed (standard library only).

**Important, say this plainly if asked:** the running application executes the TypeScript in `server/algorithms/`. These Python files are the same ideas and the same numbers written in a smaller form for reading and explaining. They are not called by the app. The longer, faithful Python version of every TypeScript file is in `detailed/`.

```
python3 algorithms/demo.py          # a made-up shop, one broken service: detect, find the cause, predict the spread
python3 algorithms/run_tests.py     # tests for the files below
```

## The files (about 450 lines in total)

| Step | File | Lines | What it does |
|---|---|---|---|
| 0 | `settings.py` | 30 | Every threshold and weight in one place |
| 1 | `preprocessing.py` | 70 | Log lines into request count, error share and latency; the short feature list per service |
| 2 | `detector.py` | 120 | Is a service abnormal compared with its own past? (median, MAD, log scale, two samples in a row) |
| 3 | `root_cause.py` | 110 | Which service started it? (own evidence, symptoms, what dependencies explain away) |
| 4 | `cascading_failure.py` | 60 | Who fails next? (noisy-OR along the call graph, "what if X failed?") |
| 5 | `ml_model.py` | 90 | Logistic regression with class balance, L2 and blocked cross-validation |
| 6 | `ml_engine.py` | 170 | The ML engine behind the Rules/ML switch: Isolation Forest per service on a sliding window of normal readings, and a random walk (PageRank) on the call graph to find the source |

Read in that order. One-page explanation of step 4: [cascading_failure.md](cascading_failure.md).

## Where the real thing is

| This file | The real code the app runs |
|---|---|
| `preprocessing.py` | `server/algorithms/detection/requestStats.ts`, `features.ts` |
| `detector.py` | `server/algorithms/detection/AnomalyDetector.ts` |
| `root_cause.py` | `server/algorithms/rca/RCAEngine.ts` |
| `cascading_failure.py` | `server/algorithms/graph/CascadeEngine.ts` |
| `ml_model.py` | `server/algorithms/learning/logreg.ts`, `experiment.ts` |
| `ml_engine.py` | `server/algorithms/ml/` (isolationForest, serviceBaseline, randomWalk, mlEngine) |

## detailed/ (optional)

One Python file per TypeScript file with a Markdown page per area, tested against the TypeScript where noted: `detection/`, `model/`, `rca/`, `graph/`, `learning/`, `evaluation/`. Only open it if an evaluator asks about something the six files above do not cover. Run all of its tests with `python3 algorithms/detailed/run_all_tests.py`.

## Why is the real system written in TypeScript?

Short answer you can give: **the product is a web application, and TypeScript lets the server, the collector and the dashboard share one language and one set of data types.** The maths is simple enough to be written in any language; Python versions of it are in this folder.

The reasons, in the order to say them:

1. **The dashboard has to be JavaScript.** It runs in the browser (React, plus three.js for the 3D map). So there is a JavaScript project anyway. Using TypeScript for the server too means one language to learn, one package manager, one test runner.
2. **One set of data shapes.** A service, a link, an incident and an anomaly look the same in the collector, the server and the browser. TypeScript checks that every part agrees on those shapes, which catches mistakes (a renamed field, a number that can be missing) before the program runs. With several parts exchanging JSON all the time, that matters.
3. **The logic runs inside the live server.** The detector, root cause and cascade run every 5 seconds on fresh data, in the same process that stores the data and serves the API. Writing them in TypeScript avoids running a second program (Python) next to the server and passing data between them.
4. **Docker and SSH libraries and real-time features are first class in Node.** The collector talks to the Docker engine (`dockerode`), the server holds SSH sessions (`ssh2`) and pushes live updates over WebSockets. These are mature, well supported in Node.
5. **The same logic is reused everywhere.** The exact files the server uses are also used by the tests, by the command line tools that score the mapper against the fault injector, and by the report builders. One implementation, so the tests test what really runs.

Be honest about the trade-off if asked "why not Python?": Python is the usual language for data science and is easier to read, which is why the machine learning experiments (`ml/`) are in Python and why this folder exists. Using it for the whole product would mean keeping two runtimes, converting data between them, and losing the shared types with the dashboard. For this tool the benefit of one language outweighed that.

## Reading order for the evaluation

1. `demo.py` output, then `detector.py` (the core idea: compare with your own past)
2. `root_cause.py` (cause versus victims)
3. `cascading_failure.py` and its page (the cascade formula)
4. `ml_model.py` (what is learned, and why the learned model is not used: 50% of faults found against 97% for the rules)
