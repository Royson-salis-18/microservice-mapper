import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createServer as createNetServer } from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { createRouter } from './api/routes.js';
import { WebSocketManager } from './api/websocket.js';
import { GraphStore } from './graph/GraphStore.js';
import { RiskEngine } from './graph/RiskEngine.js';

import { IncidentManager } from './rca/IncidentManager.js';
import { TrafficController } from './traffic/TrafficController.js';
import { ExperimentManager } from './traffic/ExperimentManager.js';

function clearRuntimeState(): void {
  const dataDir = path.resolve(process.cwd(), 'data');
  const emptyState: Record<string, unknown> = {};

  for (const filename of ['graph_db.json', 'remote_config.json', 'telemetry_db.json']) {
    const filePath = path.join(dataDir, filename);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(emptyState), 'utf8');
    } catch (error) {
      console.error(`[MAPPER] Failed to clear runtime state ${filename}:`, error);
    }
  }
}

/**
 * Refuse to start a second server.
 *
 * Constructing the GraphStore starts an SSH collector for every target, and
 * the process-level crash guard below keeps the process alive through an
 * EADDRINUSE from listen(). So a second `npm run server` while one was
 * already up used to run on as a headless duplicate: no API, but every host
 * read twice over SSH (on hosts that were already overloaded) and both
 * processes writing the same data files. Checking the port first means
 * nothing is started at all.
 */
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const probe = createNetServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n[MAPPER] Port ${port} is already in use: another mapper server is probably running (for example from \`npm run dev\`).`);
        console.error('[MAPPER] Not starting a second one, so targets are not polled twice. Stop the other server first, or set PORT.');
        console.error(process.platform === 'win32'
          ? `[MAPPER] Find it: netstat -ano | findstr :${port}    then: taskkill /PID <pid> /F\n`
          : `[MAPPER] Find it: lsof -nP -iTCP:${port} -sTCP:LISTEN    then: kill <pid>   (an old server left behind by Ctrl-C shows up here)\n`);
        process.exit(1);
      }
      resolve();
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '0.0.0.0');
  });
}

async function main() {
  // REMOVED: clearRuntimeState(); // STOPPED clearing data on every boot to preserve target configs and telemetry

  await assertPortFree(Number(config.PORT));

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  const server = createServer(app);
  const wsManager = new WebSocketManager(server);

  const graphStore = new GraphStore(wsManager);
  const incidentManager = new IncidentManager(graphStore);
  const riskEngine = new RiskEngine(graphStore);
  const trafficController = new TrafficController(graphStore);
  const experimentManager = new ExperimentManager(graphStore, graphStore.metricStore, trafficController);
  trafficController.onStatsCallback = (targetId, stats) => experimentManager.updateExperimentStats(targetId, stats);
  // A sweep with a durationSec now ends itself instead of running until
  // someone clicks Stop. Without this, the experiment record and the
  // traffic status UI would both keep reporting it as live forever.
  trafficController.onStoppedCallback = (targetId) => experimentManager.stopExperiment(targetId, 'STOPPED');
  app.use('/api', createRouter(graphStore, wsManager, incidentManager, trafficController, experimentManager, riskEngine));

  // Backstop for a port taken between the check above and here.
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[MAPPER] Server failed to listen on ${config.PORT}: ${err.message}`);
    process.exit(1);
  });
  server.listen(Number(config.PORT), '0.0.0.0', () => {
    // Auto-detect local network IP for MAPPER_PUBLIC_URL hint
    let localIp = '127.0.0.1';
    try {
      const nets = os.networkInterfaces();
      for (const iface of Object.values(nets)) {
        if (!iface) continue;
        for (const addr of iface) {
          if (addr.family === 'IPv4' && !addr.internal) {
            localIp = addr.address;
            break;
          }
        }
        if (localIp !== '127.0.0.1') break;
      }
    } catch {
      // Best-effort LAN IP detection for the collector callback URL. Falling
      // back to 127.0.0.1 is a valid outcome, not an error worth surfacing.
    }

    const mapperUrl = process.env.MAPPER_PUBLIC_URL || `http://${localIp}:${config.PORT}`;
    // Store for use by EndpointDiscoveryEngine
    if (!process.env.MAPPER_PUBLIC_URL) {
      process.env.MAPPER_PUBLIC_URL = mapperUrl;
      console.log(`\x1b[33m[MAPPER] Auto-set MAPPER_PUBLIC_URL=${mapperUrl}\x1b[0m`);
      console.log(`\x1b[33m[MAPPER] If the EC2 cannot reach this IP, set MAPPER_PUBLIC_URL=http://<ngrok-or-public-ip>:${config.PORT}\x1b[0m`);
    }
    console.log(`Microservice Mapper server started on port ${config.PORT}`);
    console.log(`Polling interval: ${config.POLLING_INTERVAL_MS}ms (Remote Telemetry Mode)`);
  });

  // Periodic RCA evaluation, risk recompute, and broadcast.
  //
  // Order matters: incidents run first so RiskEngine's "is this node part of
  // an open incident" factor reflects this cycle rather than lagging by one
  // poll, and risk runs before the broadcast so /api/graph and graph-update
  // both go out already carrying it. Runs once immediately (not just on the
  // first timer tick) so the first broadcast after boot isn't 5s stale.
  // What each target's incident last looked like when it was sent. An
  // incident was broadcast every cycle for every target whether or not
  // anything had changed — 48 a minute measured live — so it now goes out
  // only when something a person would notice has changed.
  const lastIncidentSignature = new Map<string, string>();
  const incidentSignature = (i: any) => JSON.stringify([
    i.id, i.status, i.severity, i.rootCauseServiceId, i.confidence,
    Math.round((i.rootCauseScore ?? 0) * 100),
    [...(i.affectedServices ?? [])].sort(),
    (i.explanation?.propagationPath ?? []),
  ]);

  function runPollingCycle() {
    try {
      const targets = graphStore.getGraph().targets;
      for (const target of targets) {
        const incident = incidentManager.evaluateTarget(target.targetId);
        if (incident) {
          const sig = incidentSignature(incident);
          if (lastIncidentSignature.get(target.targetId) !== sig) {
            lastIncidentSignature.set(target.targetId, sig);
            wsManager.broadcast('incident.updated', incident);
          }
        }
      }

      riskEngine.recomputeAll(incidentManager.getAllActiveIncidents());

      graphStore.requestBroadcast();
    } catch (e) {
      console.error('Error during polling cycle:', e);
    }
  }

  runPollingCycle();
  setInterval(runPollingCycle, config.POLLING_INTERVAL_MS);
}

// A long-running collector polls hosts that are frequently unreachable. A
// single stray rejection — a dropped SSH channel, a socket reset mid-write —
// would otherwise terminate the whole server in Node 18+, taking every
// healthy target down with it. Log loudly and keep serving; a crash loop is
// strictly worse than a degraded target.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-GUARD] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL-GUARD] Uncaught exception:', err);
});

main().catch((e) => {
  console.error('[FATAL] Server failed to start:', e);
  process.exit(1);
});