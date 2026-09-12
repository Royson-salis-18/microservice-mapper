const fs = require('fs');
const path = require('path');

const dir = '/home/royson/Documents/projects/microservice-mapper/server';

const files = {
  'config.ts': `
export const config = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3001,
  POLLING_INTERVAL_MS: process.env.POLLING_INTERVAL_MS ? parseInt(process.env.POLLING_INTERVAL_MS, 10) : 5000,
  METRIC_HISTORY_SIZE: process.env.METRIC_HISTORY_SIZE ? parseInt(process.env.METRIC_HISTORY_SIZE, 10) : 720,
  VERTIKAL_COMPOSE_PATH: process.env.VERTIKAL_COMPOSE_PATH || '/home/royson/Documents/projects/vertikal/docker-compose.yml',
  SOCK_SHOP_COMPOSE_PATH: process.env.SOCK_SHOP_COMPOSE_PATH || ''
};
`,
  'models/ServiceNode.ts': `
export interface ServiceNode {
  id: string;
  name: string;
  type: string;
  project: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  restarts: number;
  uptime: string;
  ports: string[];
}
`,
  'models/DependencyEdge.ts': `
export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  sourceOfTruth: 'compose-config' | 'code-analysis' | 'observed';
}
`,
  'models/MetricSnapshot.ts': `
export interface MetricSnapshot {
  timestamp: number;
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
}
`,
  'models/InteractionEvent.ts': `
export interface InteractionEvent {
  id: string;
  timestamp: number;
  source: string;
  target: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
}
`,
  'models/index.ts': `
export * from './ServiceNode';
export * from './DependencyEdge';
export * from './MetricSnapshot';
export * from './InteractionEvent';
`,
  'collectors/BaseCollector.ts': `
import { ServiceNode, DependencyEdge, MetricSnapshot } from '../models/index';

export abstract class BaseCollector {
  abstract discover(): Promise<ServiceNode[]>;
  abstract collectMetrics(nodeId: string): Promise<MetricSnapshot | null>;
  abstract getKnownDependencies(): Promise<DependencyEdge[]>;
}
`,
  'collectors/DockerCollector.ts': `
import Docker from 'dockerode';
import { BaseCollector } from './BaseCollector';
import { ServiceNode, DependencyEdge, MetricSnapshot } from '../models/index';

export class DockerCollector extends BaseCollector {
  private docker: Docker;
  
  constructor() {
    super();
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async discover(): Promise<ServiceNode[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      return containers.map(c => {
        const name = c.Names[0].replace('/', '');
        
        let project = 'unknown';
        if (name.startsWith('vertikal-')) project = 'vertikal';
        else if (name.startsWith('sockshop-') || ['front-end', 'catalogue', 'carts', 'orders', 'user', 'payment', 'shipping', 'queue-master'].includes(name)) project = 'sockshop';
        
        let type = 'service';
        if (name.includes('db') || name.includes('database')) type = 'database';
        else if (name.includes('redis') || name.includes('cache')) type = 'cache';
        else if (name.includes('rabbitmq') || name.includes('queue')) type = 'queue';
        else if (name.includes('front') || name.includes('studio')) type = 'frontend';
        else if (name.includes('kong') || name.includes('gateway')) type = 'gateway';
        else if (name.includes('mailpit') || name.includes('meta')) type = 'infrastructure';

        let status: 'healthy' | 'degraded' | 'critical' | 'unknown' = 'unknown';
        if (c.State === 'running') {
            status = 'healthy';
        } else if (c.State === 'restarting' || c.State === 'dead' || c.State === 'exited') {
            status = 'critical';
        }

        return {
          id: c.Id,
          name,
          type,
          project,
          status,
          restarts: c.Status.includes('Restarting') ? 1 : 0, 
          uptime: c.Status,
          ports: c.Ports.map(p => \`\${p.PublicPort}:\${p.PrivatePort}\`),
        };
      });
    } catch (e) {
      console.error('Failed to discover containers:', e);
      return [];
    }
  }

  async collectMetrics(nodeId: string): Promise<MetricSnapshot | null> {
    try {
      const container = this.docker.getContainer(nodeId);
      const stats = await container.stats({ stream: false });

      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemCpuDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const numberCpus = stats.cpu_stats.online_cpus || 1;
      let cpuPercent = 0.0;
      if (systemCpuDelta > 0 && cpuDelta > 0) {
        cpuPercent = (cpuDelta / systemCpuDelta) * numberCpus * 100.0;
      }

      const memoryUsage = stats.memory_stats.usage || null;
      const memoryLimit = stats.memory_stats.limit || null;
      let memoryPercent = null;
      if (memoryUsage !== null && memoryLimit !== null && memoryLimit > 0) {
        memoryPercent = (memoryUsage / memoryLimit) * 100.0;
      }

      let networkRxBytes = 0;
      let networkTxBytes = 0;
      if (stats.networks) {
        for (const eth of Object.values(stats.networks) as any) {
          networkRxBytes += eth.rx_bytes;
          networkTxBytes += eth.tx_bytes;
        }
      }

      return {
        timestamp: Date.now(),
        cpuPercent,
        memoryUsageBytes: memoryUsage,
        memoryLimitBytes: memoryLimit,
        memoryPercent,
        networkRxBytes,
        networkTxBytes
      };
    } catch (e) {
      console.error(\`Failed to collect metrics for \${nodeId}:\`, e);
      return null;
    }
  }

  async getKnownDependencies(): Promise<DependencyEdge[]> {
    return [];
  }
}
`,
  'collectors/SockShopAdapter.ts': `
import fs from 'fs';
import yaml from 'yaml';
import { BaseCollector } from './BaseCollector';
import { ServiceNode, DependencyEdge, MetricSnapshot } from '../models/index';
import { config } from '../config';

export class SockShopAdapter extends BaseCollector {
  async discover(): Promise<ServiceNode[]> { return []; }
  async collectMetrics(): Promise<MetricSnapshot | null> { return null; }
  
  async getKnownDependencies(): Promise<DependencyEdge[]> {
    if (!config.SOCK_SHOP_COMPOSE_PATH) return [];
    try {
      if (!fs.existsSync(config.SOCK_SHOP_COMPOSE_PATH)) return [];
      const content = fs.readFileSync(config.SOCK_SHOP_COMPOSE_PATH, 'utf8');
      const doc = yaml.parse(content);
      const edges: DependencyEdge[] = [];
      
      if (doc.services) {
        for (const [serviceName, serviceDef] of Object.entries(doc.services) as any) {
          if (serviceDef.depends_on) {
            const deps = Array.isArray(serviceDef.depends_on) ? serviceDef.depends_on : Object.keys(serviceDef.depends_on);
            for (const dep of deps) {
              edges.push({
                id: \`sockshop-\${serviceName}-\${dep}\`,
                source: serviceName,
                target: dep,
                sourceOfTruth: 'compose-config'
              });
            }
          }
        }
      }
      return edges;
    } catch (e) {
      console.error('Failed to parse Sock Shop compose:', e);
      return [];
    }
  }
}
`,
  'collectors/VertikalAdapter.ts': `
import fs from 'fs';
import yaml from 'yaml';
import { BaseCollector } from './BaseCollector';
import { ServiceNode, DependencyEdge, MetricSnapshot } from '../models/index';
import { config } from '../config';

export class VertikalAdapter extends BaseCollector {
  async discover(): Promise<ServiceNode[]> { return []; }
  async collectMetrics(): Promise<MetricSnapshot | null> { return null; }
  
  async getKnownDependencies(): Promise<DependencyEdge[]> {
    if (!config.VERTIKAL_COMPOSE_PATH) return [];
    try {
      if (!fs.existsSync(config.VERTIKAL_COMPOSE_PATH)) return [];
      const content = fs.readFileSync(config.VERTIKAL_COMPOSE_PATH, 'utf8');
      const doc = yaml.parse(content);
      const edges: DependencyEdge[] = [];
      
      if (doc.services) {
        for (const [serviceName, serviceDef] of Object.entries(doc.services) as any) {
          if (serviceDef.depends_on) {
            const deps = Array.isArray(serviceDef.depends_on) ? serviceDef.depends_on : Object.keys(serviceDef.depends_on);
            for (const dep of deps) {
              edges.push({
                id: \`vertikal-\${serviceName}-\${dep}\`,
                source: serviceName,
                target: dep,
                sourceOfTruth: 'compose-config'
              });
            }
          }
        }
      }
      return edges;
    } catch (e) {
      console.error('Failed to parse Vertikal compose:', e);
      return [];
    }
  }
}
`,
  'telemetry/MetricStore.ts': `
import { MetricSnapshot } from '../models/index';
import { config } from '../config';

export class MetricStore {
  private store: Map<string, MetricSnapshot[]> = new Map();
  private readonly maxSize: number;

  constructor(maxSize: number = config.METRIC_HISTORY_SIZE) {
    this.maxSize = maxSize;
  }

  push(nodeId: string, snapshot: MetricSnapshot): void {
    if (!this.store.has(nodeId)) {
      this.store.set(nodeId, []);
    }
    const history = this.store.get(nodeId)!;
    history.push(snapshot);
    if (history.length > this.maxSize) {
      history.shift();
    }
  }

  getHistory(nodeId: string, range: '5m'|'15m'|'30m'|'1h'): MetricSnapshot[] {
    const history = this.store.get(nodeId) || [];
    const now = Date.now();
    let msRange = 5 * 60 * 1000;
    if (range === '15m') msRange = 15 * 60 * 1000;
    else if (range === '30m') msRange = 30 * 60 * 1000;
    else if (range === '1h') msRange = 60 * 60 * 1000;

    return history.filter(s => now - s.timestamp <= msRange);
  }
}
`,
  'graph/GraphStore.ts': `
import { ServiceNode, DependencyEdge, MetricSnapshot } from '../models/index';
import { BaseCollector } from '../collectors/BaseCollector';
import { DockerCollector } from '../collectors/DockerCollector';
import { MetricStore } from '../telemetry/MetricStore';

export class GraphStore {
  private nodes = new Map<string, ServiceNode>();
  private edges = new Map<string, DependencyEdge>();
  public metricStore = new MetricStore();

  async updateFromCollectors(dockerCollector: DockerCollector, adapters: BaseCollector[]): Promise<void> {
    const discoveredNodes = await dockerCollector.discover();
    
    // Update nodes
    const currentIds = new Set<string>();
    for (const node of discoveredNodes) {
      currentIds.add(node.id);
      
      const metrics = await dockerCollector.collectMetrics(node.id);
      if (metrics) {
         this.metricStore.push(node.id, metrics);
         
         if (node.status === 'healthy') {
             if ((metrics.cpuPercent !== null && metrics.cpuPercent > 80) || 
                 (metrics.memoryPercent !== null && metrics.memoryPercent > 80)) {
                 node.status = 'degraded';
             }
         }
      }
      this.nodes.set(node.id, node);
    }
    
    // Remove stale nodes
    for (const id of this.nodes.keys()) {
      if (!currentIds.has(id)) {
        this.nodes.delete(id);
      }
    }

    // Update edges
    this.edges.clear();
    for (const adapter of adapters) {
      const knownEdges = await adapter.getKnownDependencies();
      for (const edge of knownEdges) {
        this.edges.set(edge.id, edge);
      }
    }
  }

  getGraph(): { nodes: ServiceNode[], edges: DependencyEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }

  getNode(id: string): ServiceNode | undefined {
    return this.nodes.get(id);
  }
}
`,
  'graph/GraphAnalytics.ts': `
import { GraphStore } from './GraphStore';

export class GraphAnalytics {
  constructor(private store: GraphStore) {}

  nodeDegree(nodeId: string): number {
    return this.upstreamCount(nodeId) + this.downstreamCount(nodeId);
  }

  upstreamCount(nodeId: string): number {
    const node = this.store.getNode(nodeId);
    if (!node) return 0;
    const { edges } = this.store.getGraph();
    return edges.filter(e => e.target === node.name || e.target === node.id).length;
  }

  downstreamCount(nodeId: string): number {
    const node = this.store.getNode(nodeId);
    if (!node) return 0;
    const { edges } = this.store.getGraph();
    return edges.filter(e => e.source === node.name || e.source === node.id).length;
  }

  topCpuConsumers(limit: number) {
    const { nodes } = this.store.getGraph();
    const withCpu = nodes.map(n => {
      const history = this.store.metricStore.getHistory(n.id, '5m');
      const latest = history[history.length - 1];
      return { node: n, cpu: latest?.cpuPercent || 0 };
    });
    return withCpu.sort((a, b) => b.cpu - a.cpu).slice(0, limit);
  }

  topMemoryConsumers(limit: number) {
    const { nodes } = this.store.getGraph();
    const withMem = nodes.map(n => {
      const history = this.store.metricStore.getHistory(n.id, '5m');
      const latest = history[history.length - 1];
      return { node: n, mem: latest?.memoryPercent || 0 };
    });
    return withMem.sort((a, b) => b.mem - a.mem).slice(0, limit);
  }

  mostConnected(limit: number) {
    const { nodes } = this.store.getGraph();
    const withDegree = nodes.map(n => ({ node: n, degree: this.nodeDegree(n.id) }));
    return withDegree.sort((a, b) => b.degree - a.degree).slice(0, limit);
  }

  getAnalytics() {
    return {
      topCpuConsumers: this.topCpuConsumers(5),
      topMemoryConsumers: this.topMemoryConsumers(5),
      mostConnected: this.mostConnected(5)
    };
  }
}
`,
  'api/routes.ts': `
import { Router } from 'express';
import { GraphStore } from '../graph/GraphStore';
import { GraphAnalytics } from '../graph/GraphAnalytics';

export function createRouter(graphStore: GraphStore) {
  const router = Router();
  const analytics = new GraphAnalytics(graphStore);

  router.get('/graph', (req, res) => {
    res.json(graphStore.getGraph());
  });

  router.get('/nodes/:id', (req, res) => {
    const node = graphStore.getNode(req.params.id);
    if (node) res.json(node);
    else res.status(404).json({ error: 'Node not found' });
  });

  router.get('/nodes/:id/metrics', (req, res) => {
    const range = (req.query.range as any) || '5m';
    const history = graphStore.metricStore.getHistory(req.params.id, range);
    res.json(history);
  });

  router.get('/analytics', (req, res) => {
    res.json(analytics.getAnalytics());
  });

  router.get('/status', (req, res) => {
    res.json({ status: 'ok' });
  });

  return router;
}
`,
  'api/websocket.ts': `
import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export class WebSocketManager {
  private wss: WebSocketServer;

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server });
    
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('Client connected to WebSocket');
      ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
      });
    });
  }

  broadcast(type: string, data: any) {
    const payload = JSON.stringify({ type, data });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
`,
  'index.ts': `
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config } from './config';
import { createRouter } from './api/routes';
import { WebSocketManager } from './api/websocket';
import { GraphStore } from './graph/GraphStore';
import { DockerCollector } from './collectors/DockerCollector';
import { SockShopAdapter } from './collectors/SockShopAdapter';
import { VertikalAdapter } from './collectors/VertikalAdapter';

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);
  const wsManager = new WebSocketManager(server);

  const graphStore = new GraphStore();
  app.use('/api', createRouter(graphStore));

  const dockerCollector = new DockerCollector();
  const adapters = [new SockShopAdapter(), new VertikalAdapter()];

  server.listen(config.PORT, () => {
    console.log(\`Server started on port \${config.PORT}\`);
  });

  setInterval(async () => {
    try {
      await graphStore.updateFromCollectors(dockerCollector, adapters);
      wsManager.broadcast('graph_update', graphStore.getGraph());
    } catch (e) {
      console.error('Error during polling cycle:', e);
    }
  }, config.POLLING_INTERVAL_MS);
}

main().catch(console.error);
`,
  'tsconfig.json': `
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": ".",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
`
};

for (const [filePath, content] of Object.entries(files)) {
  const fullPath = path.join(dir, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.trim());
  console.log('Created:', fullPath);
}
