# Microservice Test Subjects

Two production-style microservice systems, built as **test subjects for [Microservice Mapper](https://github.com/Royson-salis-18/microservice-mapper)** and its RCA lab.

> The code in both systems is correct, defensive and reviewable: timeouts, bounded retries, idempotency, health/readiness
> probes, graceful shutdown, pooled connections, structured logs. **Every failure in this repo comes from somewhere else** --
> configuration drift, data volume, capacity sizing, deployment topology, third-party behaviour, or the *interaction* of
> two individually-correct components. That is how most real production incidents look, and it is exactly the class of problem
> an outside-in mapper (declared vs observed topology, container telemetry, gateway logs) is built to shorten.

| Subject | Domain | Containers | Shape | Scenarios |
|---|---|---|---|---|
| [**ShopFlow**](shopflow/README.md) | Online retail / checkout | 12 (+ optional Prometheus) | sync HTTP fan-out, cache-aside, Postgres x2, Redis x2, NATS JetStream consumer | 12 (`sf-00` ... `sf-11`) |
| [**LedgerLine**](ledgerline/README.md) | Retail-banking transfers | 12 (+ optional Prometheus) | saga orchestrator, double-entry ledger, third-party FX + breaker, batch worker, possible dependency cycle | 7 (`ll-00` ... `ll-06`) |

Each subject has a **healthy baseline** (the control group) and one scenario per production condition. Every scenario ships with
a machine-readable **ground truth** (`scenario.yaml`): the true root cause, the symptomatic services, which signals the mapper can
see (strong / partial / blind), and which graph edges must be declared and/or observed.

## Quick start

```bash
npm run install:all && npm test      # syntax check + static validation of all 19 scenarios (needs the docker CLI, no daemon)

# on a Docker host (e.g. the EC2 box the mapper SSHes into)
lab/up.sh shopflow sf-00-baseline                  # healthy control group
node lab/loadgen.mjs shopflow --concurrency 20 --duration 600

lab/down.sh shopflow
lab/up.sh shopflow sf-05-secret-rotation           # inject one production condition
node lab/check-scenario.mjs --scenario shopflow/scenarios/sf-05-secret-rotation --target shopflow --mapper http://localhost:3001
```

No Docker? `lab/local-stack.sh shopflow up [scenario/local.env]` runs the same services as plain processes (needs node 20+,
Postgres server binaries, redis-server, nats-server). That is how the mechanisms in this repo were measured.

## What is in the box

```
shared/            service plumbing used by every service (HTTP server+client, pools, metrics, queue consumer, lifecycle)
shopflow/          docker-compose.yml (baseline), services/, db/, nginx/, loadgen/, scenarios/sf-*/
ledgerline/        same layout
lab/               up.sh / down.sh, loadgen.mjs, validate.mjs, check-scenario.mjs, local-stack.sh
docs/              HOW-IT-FITS-THE-MAPPER.md, SCENARIO-CATALOG.md
```

Read next: [docs/HOW-IT-FITS-THE-MAPPER.md](docs/HOW-IT-FITS-THE-MAPPER.md) (why these systems and these failures; how to attach them to
the mapper; what the mapper cannot see) and [docs/SCENARIO-CATALOG.md](docs/SCENARIO-CATALOG.md).

## Honest status

* **Measured locally** (real Postgres, Redis, NATS, the real service code, no containers): the baselines of both systems; and the
  mechanism of `sf-01`, `sf-02`, `sf-03`, `sf-04`, `sf-05` (exit behaviour), `sf-06`, `sf-08`, `sf-10`, `sf-11`, `ll-01`, `ll-02`, `ll-03`,
  `ll-04` (exhaustion), `ll-05`, `ll-06`. The measured numbers are recorded in each `scenario.yaml` (`measured_locally`).
* **Validated statically only** (compose renders, declared-edge claims checked against depends_on): `sf-07`, `sf-09`, and the Docker-specific
  parts of every scenario (cgroup memory/CPU limits, restart policies, Docker DNS, scram authentication). These rely on standard Docker
  semantics but were **not executed** -- no Docker daemon was available where this was built. Run the scenarios on a Docker host and
  treat the first run as the verification.
* Nothing here has been run **against the mapper itself** yet; `scenario.yaml` is the specification to run it against.
