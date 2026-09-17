import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { createRouter } from './api/routes.js';
import { WebSocketManager } from './api/websocket.js';
import { GraphStore } from './graph/GraphStore.js';

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

async function main() {
  // REMOVED: clearRuntimeState(); // STOPPED clearing data on every boot to preserve target configs and telemetry

  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);
  const wsManager = new WebSocketManager(server);

  const graphStore = new GraphStore(wsManager);
  const incidentManager = new IncidentManager(graphStore);
  const trafficController = new TrafficController(graphStore);
  const experimentManager = new ExperimentManager(graphStore, graphStore.metricStore, trafficController);
  trafficController.onStatsCallback = (targetId, stats) => experimentManager.updateExperimentStats(targetId, stats);
  app.use('/api', createRouter(graphStore, wsManager, incidentManager, trafficController, experimentManager));

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
    } catch (e) {}

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

  // Periodic RCA Evaluation Cycle & Broadcast
  setInterval(() => {
    try {
      wsManager.broadcast('graph-update', graphStore.getGraph());

      // Target-isolated RCA Evaluation
      const targets = graphStore.getGraph().targets;
      for (const target of targets) {
        const incident = incidentManager.evaluateTarget(target.targetId);
        if (incident) {
          wsManager.broadcast('incident.updated', incident);
        }
      }
    } catch (e) {
      console.error('Error during polling cycle:', e);
    }
  }, config.POLLING_INTERVAL_MS);
}

main().catch(console.error);