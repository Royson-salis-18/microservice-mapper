# Run it on your own machine (macOS, Linux, Windows)

Everything here works on a laptop with Docker. You end up with the mapper (3D scene, incidents, risk) watching a small shop or bank
that is running in Docker on the same machine, with realistic traffic, and a way to break it at random and see how the mapper copes.

## 1. What you need

| Need | Check | If missing |
|---|---|---|
| Node.js 20 or newer | `node -v` | https://nodejs.org (macOS: `brew install node`) |
| Docker (Desktop, Colima or an engine) running | `docker info` | https://docs.docker.com/get-docker/ |
| git | `git --version` | macOS: `xcode-select --install` |

## 2. Get the mapper and start it

```bash
git clone -b claude/zen-knuth-z3f9cj https://github.com/Royson-salis-18/microservice-mapper.git
cd microservice-mapper
npm run setup          # installs every folder's dependencies and checks this machine (npm run doctor)
npm run local          # starts the mapper + a collector for every docker compose project that is running
```

Open **http://localhost:5173** and pick your project in the top bar. `Ctrl-C` stops everything `npm run local` started.

`npm run local` options: `-- --project shopflow,ledgerline` (only these), `-- --no-collect` (mapper only), `-- --dry-run` (say what it would do).
Each compose project becomes its own target, so two benches running at once do not mix.

## 3. Start something to map

The two test benches are separate repositories, so clone the one you want next to the mapper.

```bash
git clone https://github.com/Royson-salis-18/bench-1.git      # ShopFlow: an online shop, 13 services
cd bench-1/shopflow
make bench                                                      # app + always-on organic traffic (+ Grafana on :3000)
```

No `make` (Windows)? From `bench-1/shopflow`:

```bash
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml --profile traffic up -d traffic
```

LedgerLine (a bank, 12 services) is the same in `bench-2/ledgerline`. Then run `npm run local` in the mapper again (or just leave it running and start the bench: re-run it so a collector
is started for the new project).

## 4. Break it, at random, without telling the mapper

```bash
cd bench-1
node lab/faultlab/faultlab.mjs shopflow plan --seed 7 --duration 30m          # preview: nothing is touched
node lab/faultlab/faultlab.mjs shopflow run --profile realistic --duration 30m
node lab/faultlab/faultlab.mjs shopflow inject payments brownout --severity 0.9 --for 2m   # one fault by hand
node lab/faultlab/faultlab.mjs shopflow heal                                    # put everything back
```

Watch the **Spatial view** and **Incidents** pages while it runs. Every fault is written to a private ledger (`~/.faultlab/ledger-shopflow.jsonl`) that the mapper cannot see.
The full description of what it does and why it is blind to the mapper is in [`bench-1/docs/FAULT_INJECTION.md`](https://github.com/Royson-salis-18/bench-1).

## 5. Score the mapper against the ledger

In the mapper folder, in a second terminal, *before* the campaign starts:

```bash
npm run eval -- observe --subject shopflow --target shopflow       # records what the mapper says every 5 s (Ctrl-C to stop)
```

After the campaign:

```bash
npm run eval -- all --subject shopflow                             # writes ~/.faultlab/eval-shopflow.html and .json
```

Open the HTML: detection rate, time to notice, root-cause Top-1/Top-3 per fault class, cascade precision/recall, honesty of the at-risk warnings, false alarms, a timeline of faults against incidents, and a table of every fault.

## 6. If something does not work

| Symptom | Fix |
|---|---|
| `npm run local` says Docker is not running | start Docker Desktop and run again |
| Nothing appears under your project in the top bar | the bench must be running first; check `docker ps`; run `npm run local` again |
| Port 3001 or 5173 already in use | stop whatever holds it (`lsof -i :3001` on macOS/Linux, `netstat -ano | findstr 3001` on Windows) |
| macOS: collector cannot reach Docker | it looks in `/var/run/docker.sock`, `~/.docker/run/docker.sock`, `~/.colima/default/docker.sock`, `~/.rd/docker.sock`; or set `DOCKER_HOST` |
| Windows: `make` not found | use the `docker compose` commands in section 3 |
| `npm run doctor` | lists exactly what this machine is missing and how to fix it |
