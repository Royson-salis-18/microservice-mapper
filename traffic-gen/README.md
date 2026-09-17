# Traffic Generator

Organic HTTP traffic generator for Sock Shop with a live control UI, headless CLI, SSH-based target discovery, per-user sessions, and conservative safety controls.

## Run the UI

```bash
npm install
npm start
```

Open `http://127.0.0.1:4403`. The updated UI is started with `PORT=4403 npm start` because an older server may still occupy port 4400. Use **Connect & Discover** with the remote host, SSH user, and the path to your local `.pem` key. The key contents stay on the machine running this server. The server checks listening ports over SSH, saves the discovered base URL, and verifies reachability.

## Next run checklist

1. Start the updated UI:

	```bash
	cd /home/royson/Documents/projects/traffic-gen
	PORT=4403 npm start
	```

2. Open `http://127.0.0.1:4403/`.
3. Select an existing project, or enter a new project ID and click **ADD PROJECT**.
4. Enter the AWS host, SSH user, and key path, then click **CONNECT & DISCOVER**.
5. Click **TEST ENDPOINTS** and keep only successful routes selected.
6. Leave **Project gateway** selected for normal Sock Shop traffic. Do not select internal services unless they are explicitly externally reachable.
7. Set users, duration, and workflow mix. Start with `1` user and the `BASELINE` profile.
8. Click **START**. Watch the per-project stats cards.
9. Stop with the project **STOP** button, or run:

	```bash
	curl -X POST http://127.0.0.1:4403/api/stop \
	  -H 'content-type: application/json' \
	  -d '{"projectId":"YOUR_PROJECT_ID"}'
	```

10. Confirm all traffic is stopped:

	```bash
	curl http://127.0.0.1:4403/api/projects
	```

The UI server can remain running after traffic is stopped. `EADDRINUSE` on port 4400 means an older UI server already owns that port; use port 4403.

Each project has its own `Project ID` (for example `sock-shop-prod` and `sock-shop-staging`). Start each project separately from the UI or API; their engines, stats, URLs, and stop/update operations are independent.

In the UI, click **ADD PROJECT**, select the new project, connect its SSH host, then start traffic. Repeat those steps for each environment.

The standalone helper does the same from a terminal:

```bash
chmod +x discover-target.sh
./discover-target.sh sock-shop 3.91.12.44 ~/.ssh/sockshop-key.pem ubuntu
```

## Run traffic over SSH

```bash
node cli.js --target sock-shop --base-url http://<aws-ip> --profile MODERATE --users 15 --duration 1800
```

To keep it running after disconnecting:

```bash
nohup node cli.js --target sock-shop --base-url http://<aws-ip> --profile BASELINE --users 10 --duration 1800 > traffic.log 2>&1 &
```

For a persistent UI server, use PM2:

```bash
npm install -g pm2
pm2 start server.js --name traffic-gen
pm2 save
```

## API

- `GET /api/targets` lists targets, workflows, profiles, saved URLs, and reachability.
- `GET /api/projects` lists configured projects and their current stats.
- `POST /api/projects` creates a project with `{ projectId, targetId, baseUrl? }`.
- `POST /api/discover` accepts `{ projectId, targetId, host, sshUser, keyPath }` and returns listening ports, Docker containers/images, and HTTP probes for common local application ports. For Vertikal this is discovery-only until its storefront entrypoint and routes are confirmed.
- `POST /api/probe` accepts `{ projectId, paths }` and tests candidate storefront paths from the UI/control server.
- `POST /api/start` starts traffic using a saved project URL or an explicit `baseUrl`.
- `POST /api/update` and `POST /api/stop` require the target `projectId`.
- `GET /api/stats?projectId=<id>` returns one project's statistics; without it, all active projects are returned.
- `WS /ws` streams live statistics.

`vertikal` remains a stub until its real storefront entrypoint is confirmed. The engine enforces user, concurrency, request timeout, and duration limits.

## Audited Sock Shop contract

The current deployment was inspected over SSH on `65.1.91.28`.

- Public entrypoint: edge-router on port 80 (8080 also redirects).
- Frontend service: `docker-compose-front-end-1`, port 8079 inside the Docker network.
- Verified routes: `GET /`, `GET /catalogue`, `GET /catalogue/:productId`, `GET /cart`, `POST /cart` with `{ "id": "<catalogue id>" }`, `GET /customers`, `GET /address`, `GET /card`, `GET /orders`.
- Session: frontend sets `md.sid`; authenticated requests also receive `logged_in`.
- Login: `GET /login` with the supplied `Authorization` header; credentials are optional and never persisted by this tool.
- Checkout: frontend performs customer, address, and card lookups, then `POST /orders`; orders calls payment and shipping through the application and continue through RabbitMQ/queue-master naturally.
- Product IDs are selected from the live `/catalogue` response, never hard-coded.

The generator does not call payment, shipping, orders, carts, user, or RabbitMQ directly. Without credentials, account and checkout weights are automatically set to zero. With credentials, checkout remains only 5% of the default mix.

## Safety and validation

The default ceilings are 20 users, 20 concurrent users, 1,800 seconds, and automatic reduction when the completed-request error rate exceeds 35%. Profiles are BASELINE 1, MODERATE 3, HEAVY 5, RAMP 10, and STRESS 20 users with long think times.

The corrected generator was run with one user against the live gateway: 3 requests completed, 3 returned HTTP 200, and no network errors. The host was then observed with Docker stats; queue-master, shipping, user-db, frontend, and catalogue-db were already CPU-heavy, so escalation to 2, 5, or 10 users was deliberately not performed.
