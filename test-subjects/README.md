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

## Quick start (each project is self-contained)

```bash
cd shopflow            # or: cd ledgerline
make test              # builds the images, starts every container, runs the API tests (14 tests, every service), leaves it running
make load              # 60 s of realistic traffic against the gateway
make scenario SCEN=sf-05-secret-rotation   # inject one production condition (make scenarios lists them)
make down              # stop and delete volumes (databases re-seed on next start)
```

Everything a project needs lives in its own directory: `docker-compose.yml`, one `Dockerfile` per service, the service library
(`lib/`), database seeds, nginx config, load generator, API tests, scenarios and a `Makefile`. Behind a TLS-intercepting proxy add
`BUILD_CA_BUNDLE=/path/ca.crt` to any `make` command.

From the repo root: `npm run install:all && npm test` (syntax + static validation of all 19 scenarios, needs the docker CLI but no
daemon) and `npm run test:api` (both projects in real containers). No Docker at all? `lab/local-stack.sh shopflow up` runs the same
services as plain processes.

## What is in the box

```
shopflow/                 self-contained project
  docker-compose.yml        healthy baseline (12 containers)       docker-compose.expose.yml   publishes every service on 127.0.0.1 for tests
  services/<name>/          index.js + Dockerfile (one per service)
  lib/                      service plumbing: HTTP server/client, pools, metrics, queue consumer, lifecycle
  db/  nginx/  observability/   seeds, gateway config, optional Prometheus (Tier 2)
  loadgen/                  traffic generator + journeys          tests/   API tests (node:test)
  scenarios/sf-*/           compose.override.yml + scenario.yaml (ground truth) [+ local.env]
  Makefile
ledgerline/               same layout
lab/                      cross-project tools: up.sh/down.sh (render one compose file), validate.mjs, check-scenario.mjs, local-stack.sh
docs/                     HOW-IT-FITS-THE-MAPPER.md, SCENARIO-CATALOG.md
```

The two projects intentionally share no code at runtime: each carries its own copy of `lib/`, as two independent teams' services would.

Read next: [docs/HOW-IT-FITS-THE-MAPPER.md](docs/HOW-IT-FITS-THE-MAPPER.md) (why these systems and these failures; how to attach them to
the mapper; what the mapper cannot see) and [docs/SCENARIO-CATALOG.md](docs/SCENARIO-CATALOG.md).

## Honest status

Verified by running it (real Docker containers: nginx, Postgres 16, Redis 7, NATS 2.10 and the services):

* **API tests: 14/14 pass for each project from a clean `make test`** -- every endpoint of every service, validation and error paths,
  idempotency, the full checkout and transfer sagas, double-entry conservation under concurrency, the async event path, the gateway
  routing table, and the access-log shape the mapper parses.
* **Optional Tier 2:** `make up COMPOSE_PROFILES=observability` -- Prometheus scrapes all 7 ShopFlow services (7/7 up) and returns exact per-service p95 from `http_server_request_duration_seconds`.
* **Baselines under load:** ShopFlow ~520 req/s with 0 errors; LedgerLine correct books (entries sum to 0, money conserved).
* **Scenarios reproduced in Docker with measurements recorded in their `scenario.yaml`:** `sf-03` (memory ramp to 95% then restart),
  `sf-05` (real scram auth failure, restart loop, healthy DB), `sf-09` (flat ~26% CPU at 0.25 cpus), `ll-05` (batch restart loop on 2M rows).
* **Scenarios reproduced as plain processes** (same code, real Postgres/Redis/NATS, no cgroups): `sf-01`, `sf-02`, `sf-04`, `sf-06`, `sf-08`,
  `sf-10`, `sf-11`, `ll-01`, `ll-02`, `ll-03`, `ll-04` (exhaustion), `ll-06`. Numbers are in `measured_locally`.
* **Not yet executed in Docker:** `sf-01`, `sf-02`, `sf-04`, `sf-06`, `sf-07`, `sf-08`, `sf-10`, `sf-11`, `ll-01`..`ll-04`, `ll-06`; and `ll-04`'s
  failover flip was never reproduced anywhere. Their compose files render and are statically validated; `make scenario SCEN=...` runs them.
* **Not run against the mapper itself.** `scenario.yaml` is the specification to run it against (`lab/check-scenario.mjs`).

Bugs the real runs caught in this repo (fixed): the ledger debited payers the amount but not the fee, so balances drifted from entries;
the ledger seed could abort Postgres init and leave a half-initialised database; an access-log test mishandled nginx's empty `upstream_addr`.
