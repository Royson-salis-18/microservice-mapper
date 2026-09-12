import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config } from './config.js';
import { createRouter } from './api/routes.js';
import { WebSocketManager } from './api/websocket.js';
import { GraphStore } from './graph/GraphStore.js';
import { DockerCollector } from './collectors/DockerCollector.js';
import { SockShopAdapter } from './collectors/SockShopAdapter.js';
import { VertikalAdapter } from './collectors/VertikalAdapter.js';
import { RuntimeObserver } from './collectors/RuntimeObserver.js';

import { IncidentManager } from './rca/IncidentManager.js';
import { TrafficController } from './traffic/TrafficController.js';
import { ExperimentManager } from './traffic/ExperimentManager.js';

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);
  const wsManager = new WebSocketManager(server);

  const graphStore = new GraphStore();
  const incidentManager = new IncidentManager(graphStore);
  const trafficController = new TrafficController(graphStore);
  const experimentManager = new ExperimentManager(graphStore, graphStore.metricStore, trafficController);
  trafficController.onStatsCallback = (targetId, stats) => experimentManager.updateExperimentStats(targetId, stats);
  app.use('/api', createRouter(graphStore, wsManager, incidentManager, trafficController, experimentManager));

  const enableLocalDocker = process.env.DISABLE_LOCAL_DOCKER !== 'true';
  const dockerCollector = enableLocalDocker ? new DockerCollector() : (null as any);

  // Adapters parse the baseline architecture from compose files
  const adapters = [
    new VertikalAdapter(),
    new SockShopAdapter(),
    ...(enableLocalDocker ? [new RuntimeObserver(graphStore.metricStore)] : [])
  ];

  // Initial collection before starting server
  try {
    await graphStore.updateFromCollectors(dockerCollector, adapters);
    console.log(`Initial discovery: ${graphStore.getGraph().nodes.length} nodes, ${graphStore.getGraph().edges.length} edges`);
  } catch (e) {
    console.error('Initial collection failed:', e);
  }

  server.listen(Number(config.PORT), '0.0.0.0', () => {
    console.log(`Microservice Mapper server started on port ${config.PORT}`);
    console.log(`Polling interval: ${config.POLLING_INTERVAL_MS}ms (AWS Remote Mode)`);
  });

  // Periodic RCA Evaluation Cycle & Broadcast
  setInterval(async () => {
    try {
      await graphStore.updateFromCollectors(dockerCollector, adapters);
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