import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import config from './config.js';
import { MetricStore } from './telemetry/MetricStore.js';
import { GraphManager } from './graph/GraphManager.js';
import { SockShopCollector } from './collectors/SockShopCollector.js';
import { VertikalCollector } from './collectors/VertikalCollector.js';
import registerRoutes from './api/routes.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const metricStore = new MetricStore();
const graphManager = new GraphManager();

const sockShopCollector = new SockShopCollector();
const vertikalCollector = new VertikalCollector();

graphManager.registerCollector(sockShopCollector);
graphManager.registerCollector(vertikalCollector);

registerRoutes(app, graphManager, metricStore);

wss.on('connection', (ws) => {
  console.log('[MicroMapper] Client connected to WebSocket');
  ws.send(JSON.stringify({ type: 'init', data: graphManager.getSnapshot() }));

  ws.on('close', () => {
    console.log('[MicroMapper] Client disconnected');
  });
});

async function pollingLoop() {
  try {
    await graphManager.refresh();
    const snapshot = graphManager.getSnapshot();
    
    for (const node of snapshot.nodes) {
      if (node.metrics) {
        metricStore.addMetric(node.id, {
          timestamp: snapshot.timestamp,
          ...node.metrics
        });
      }
    }
    
    const message = JSON.stringify({ type: 'update', data: snapshot });
    for (const client of wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  } catch (e) {
    console.error('[MicroMapper] Error in polling loop:', e.message);
  } finally {
    setTimeout(pollingLoop, config.POLLING_INTERVAL_MS);
  }
}

server.listen(config.PORT, () => {
  console.log(`[MicroMapper] Server started on port ${config.PORT}`);
  console.log(`[MicroMapper] WebSocket endpoint at ws://localhost:${config.PORT}/ws`);
  
  // start polling loop
  pollingLoop();
});
