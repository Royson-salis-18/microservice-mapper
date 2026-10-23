# Live demonstration: run sheet

Everything here was rehearsed against the four real hosts on 2026-10-23. The times are what was measured.

## 0. The evening before (10 minutes)

1. **Start all four EC2 instances** and wait until the status checks say 2/2. EC2 gives a stopped instance a **new public IP** every time it starts.
2. Put the new IPs into the mapper, one line per host (names are the project names in the app):

   ```bash
   npm run hosts -- set death-star     <ip>
   npm run hosts -- set open-telemetry <ip>
   npm run hosts -- set shopflow       <ip>
   npm run hosts -- set ledgerline     <ip>
   ```

   `npm run hosts` (no arguments) lists every host and whether its ssh port answers. All four use `~/Downloads/sock-shop-key.pem`, user `ubuntu`.
3. Start the mapper: `npm run dev`. Open http://localhost:5173.
4. Run the check: `npm run preflight`. It must print **GO**. Every line that says `FIX` has the one thing to do next to it.
   Wait about a minute after (re)starting the server before you read it; discovery needs that long.
5. **Do not leave traffic running overnight.** Ledgerline's ledger grows with traffic; after a day of it the statements worker runs out of memory.

## 1. One hour before

```bash
npm run preflight        # GO, or fix what it says
npm run labs             # tunnels + the Grafana and FaultLab links (also opened by preflight)
```

Open these in browser tabs (the Consoles page in the app, **Miscellaneous > Consoles & links**, shows the same links and has one-click buttons for the tunnels):

| What | Link |
|---|---|
| Mapper | http://localhost:5173 |
| ShopFlow Grafana | http://localhost:23100/d/bench/shopflow-test-bench?orgId=1&from=now-15m&to=now&timezone=browser&refresh=5s |
| ShopFlow FaultLab | http://localhost:28101 |
| Ledgerline Grafana | http://localhost:23000/d/bench/ledgerline-test-bench?orgId=1&from=now-15m&to=now&timezone=browser&refresh=5s |
| Ledgerline FaultLab | http://localhost:28100 |

Calm baseline: in each FaultLab page set the **Traffic** box to organic, 8 requests/s and press **Start / apply**. At 30 requests/s these small 2-CPU machines run hot and show errors before you inject anything.

If a tunnel link dies (laptop slept, wifi changed): `npm run labs`.

## 2. The demonstration, host by host

Mapper settings: top bar **Hybrid** engine, project selector on the host you are showing, **Spatial view**.

### ShopFlow and Ledgerline (FaultLab does the injecting)

1. In the mapper select the project. Show it all green. Say what you are about to do.
2. In its **FaultLab** page, in the **One fault by hand** box, choose a service and a fault class, press **Inject**. Good first choice: **payments, pause, 60 s** (ShopFlow) or **accounts, pause, 60 s** (Ledgerline).
3. What the mapper does (measured on ShopFlow, `payments` paused):
   - **+15 s** the service turns red (critical, "container is paused"),
   - **+30 to 45 s** the link into it turns amber, then red, as request errors rise,
   - an **incident (severity HIGH)** appears with the right root cause (`shopflow:payments`),
   - when the fault ends it heals by itself and the incident resolves; the link is back to green about 2 minutes later.
4. Show Grafana at the same time: the error panels move on the same schedule, so the audience sees both views agree.
5. Fault classes in FaultLab: `crash`, `crash-loop`, `stop`, `pause`, `brownout`, `memory`, `partition`, `flap`. `pause` and `stop` are the clearest on screen. `brownout` (CPU squeeze) shows as slow links.
6. **Heal everything early:** FaultLab page > **Heal everything** (or **Stop and heal** if a campaign is running). Or: `curl -s -X POST localhost:28101/api/heal -H 'x-panel: 1' -H 'content-type: application/json' -d '{}'` (28100 for Ledgerline).

### Death Star and OpenTelemetry (no FaultLab: use the traffic panel and docker)

1. Select the project. In the mapper's **Traffic generator** (gauge icon, top bar): target `death-star`, endpoint **nginx-thrift :8080**, mode **User journey**, profile **Heavy**, users **60**. Start.
   - Death Star at 60 users is about 45 requests/s; at **Stress, 200 users** about 225 requests/s (nginx at ~50% CPU, p95 above 1 s). Use that one when you want the host to visibly work.
   - OpenTelemetry: endpoint **frontend-proxy :8080**, Moderate, 30 users is plenty (the box is small).
2. Give it 20 seconds, then break something on the host (one line):

   ```bash
   # Death Star
   ssh -i ~/Downloads/sock-shop-key.pem ubuntu@<death-star-ip> 'docker pause socialnetwork-user-timeline-service-1'
   # OpenTelemetry
   ssh -i ~/Downloads/sock-shop-key.pem ubuntu@<otel-ip> 'docker pause cart'
   ```

   Measured: service critical within 20 to 30 s and an incident (HIGH) naming it as root cause (`death-star:user-timeline-service`, `open-telemetry:cart`).
3. **Undo it** (same command with `unpause`). The incident resolves by itself.
4. Media-frontend (Death Star) has links to and from it while the traffic runs: requests for `/get-media` travel nginx-thrift > media-frontend > media-mongodb. Without traffic the link fades after about 10 minutes.

## 3. Things that will go wrong, and the answer

| Symptom | Cause | Fix |
|---|---|---|
| A project is grey / "Offline" / no services | the instance has a new public IP | `npm run hosts -- set <project> <ip>`, then restart the server |
| `preflight` says "FIX ... link already red" | traffic or a fault is still running, or just ended | stop traffic, heal in FaultLab, wait 2 minutes |
| Grafana or FaultLab link does not open | tunnel died | `npm run labs` |
| FaultLab inject does nothing | the page lost its tunnel, or you used curl without `-H 'x-panel: 1'` | `npm run labs`; use the page |
| Mapper shows a project as "No data" right after a restart | discovery still running | wait 60 seconds |
| A service shows twice, one named `unknown-...` | old build; fixed (containers are matched by name now) | restart the server |
| Traffic panel cannot start: "timeout" | wrong entry point selected | pick `nginx-thrift :8080` / `frontend-proxy :8080` / `api-gateway :8080` / `edge :8081` (Ledgerline) |
| Ledgerline's statements-worker restarting by itself | ledger too large from long traffic | on the host: `cd ~/bench/ledgerline && docker stop ledgerline-traffic-1 && make down && make up && make obs-up` (wipes its synthetic data) |
| Everything looks stuck | | `npm run preflight` tells you which part |

## 4. Clean slate before a repeat run

```bash
# heal both benches and stop their built-in traffic
curl -s -X POST localhost:28101/api/stop -H 'x-panel: 1'; curl -s -X POST localhost:28100/api/stop -H 'x-panel: 1'
# forget the mapper's remembered state for a project (it relearns what normal is in a few minutes)
curl -s -X POST localhost:3001/api/data/clear -H 'content-type: application/json' -d '{"targetId":"shopflow"}'
```

Open incidents from the previous run clear on their own once the service has been healthy for a couple of minutes.

## 5. What the mapper cannot do (so you can say it first)

- **The ML engine needs about 30 readings per service** (a few minutes of normal running) before it judges anything. Right after clearing a project it falls back to container facts (paused, crashed, restarting) and the rules engine. Run the baseline for five minutes before the audience arrives.
- **Business errors are not failures.** A card declined (402) or insufficient funds (409) is the service working; only 5xx and timeouts count as errors.
- **Small hosts.** The four machines are 2 CPUs and 4 GB. OpenTelemetry's demo is too big for them: keep its traffic at Moderate.
