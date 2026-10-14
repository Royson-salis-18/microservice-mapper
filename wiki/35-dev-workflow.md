# Working on it

How to run the project, check a change, and prove that a number is right. This is the loop every change in this repository went through.

---

## Run it

```bash
npm run install:all          # server, client, remote-collector and traffic-gen dependencies
npm run dev                  # server on :3001 and client on :5173, together
```

Open `http://localhost:5173`. The Vite dev server proxies `/api` and `/ws` to `:3001`.

Targets are listed in `server/data/remote_config.json` (host, SSH user, key path, display name, optional `telemetrySources`). With no reachable target the app still starts; the graph is just empty.

Optional pieces:

```bash
npm run traffic-gen                          # load generator on :4400
cd ml && python3 collector.py                # start building ML history (or use the ML page)
```

---

## The check loop

Run all of these before calling a change done. They are fast.

| Check | Command | Expect |
|---|---|---|
| tests | `npm test` | all pass |
| server types | `cd server && npx tsc --noEmit` | no output |
| client types | `cd client && npx tsc -b` | no output |
| client lint | `cd client && npm run lint` | 0 errors |
| ML ensemble | `python3 ml/test_ensemble.py` | "N unit tests passed; real-model check passed" |

When piping a check through `head` or `tail`, read `${PIPESTATUS[0]}`. Otherwise you get the exit code of `head`, and a failing check can look green.

---

## Proving a number is right: the isolated server and the simulator

Unit tests pin formulas. To check the whole pipeline end to end, run a second, **isolated** server and feed it the ground-truth simulator:

```bash
# 1. a server with its own state, port and token (never your real graph)
mkdir -p /tmp/mapper-sim && cd /tmp/mapper-sim
INGEST_TOKEN=sim PORT=3099 <repo>/server/node_modules/.bin/tsx <repo>/server/index.ts

# 2. a target whose truth is known (from the repo root)
server/node_modules/.bin/tsx scripts/simulate-target.ts \
    --url http://localhost:3099 --token sim --scenario db-crash --duration 180

# 3. compare what the mapper says with what the simulator knows
curl -s localhost:3099/api/incidents?targetId=sim-shop
curl -s localhost:3099/api/diagnostics/consistency
curl -s localhost:3099/api/graph
```

The server keeps its state in `./data` relative to its working directory, which is why it is started from a scratch directory. Simulated targets must be named `sim-*` (the script refuses anything else), so they can never be mistaken for a real one.

Scenarios: `baseline`, `db-crash`, `slow-payment`, `crash-loop`. Each states its ground-truth root cause when it starts. What to check:

- **RCA** names the scenario's root cause, at the expected confidence.
- **`openConnections`** equals 2 on every link; **`newConnectionsPerMin`** is within a few percent of each link's rate ÷ 10, once 120 s have passed.
- **Consistency** reports 0 violations.

When you are done, stop the isolated server and simulator **by PID**. `pkill -f` with a pattern that appears in your own shell's command line kills that shell:

```bash
ps -eo pid,cmd | grep -E "[s]imulate-target|[P]ORT=3099" | awk '{print $1}' | xargs -r kill
ss -ltnp | grep ':3099 '          # the listener's PID, if it is still up
```

---

## Checking the UI

- **A second dev server needs its own Vite cache.** Sharing `node_modules/.vite` with the running one (for example from a git worktree with symlinked `node_modules`) rewrites the dependency cache under the open tabs and breaks them. Give the second one a separate `cacheDir`.
- **Screenshots without a visible window:** headless Chrome renders WebGL through SwiftShader:

```bash
google-chrome --headless=new --user-data-dir=/tmp/mm-chrome --use-angle=swiftshader \
  --window-size=1600,1000 --virtual-time-budget=25000 \
  --screenshot=/tmp/shot.png http://localhost:5173
```

- **Do not judge 3D frame rate from an embedded preview pane.** A hidden pane pauses `requestAnimationFrame` (0 fps), and a visible one may be capped near 12 fps. Measure in a real browser window.

---

## Building this book

```bash
python3 wiki/build_visualizer.py      # wiki/*.md → "wiki/visualizer/*.html"
```

The chapter list, part structure, diagrams and interactive labs all live in that script. Each lab re-implements a real function with the same constants. When you change an RCA weight, a risk weight, a threshold or a colour band, change the lab in the same commit. A lab that disagrees with its source teaches the wrong thing.

---

## Conventions

- **Comments say why**, especially when the obvious version was tried and failed. Most long comments in this codebase describe a bug the simpler code had.
- **`null` for unmeasured.** Never `|| 0` on a measurement.
- **Ids are `project:name`** everywhere; display the short name.
- **One definition per idea.** If the client needs a server rule, mirror it once and add a test that the two agree.
- **Light on the target.** New remote work goes into the existing exec where possible, loops wait for themselves, and nothing new runs without a reason.
- **Commit messages** explain the change and its motivation; commits are made only when asked.
