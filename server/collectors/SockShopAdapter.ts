import fs from 'fs';
import yaml from 'yaml';
import { BaseCollector } from './BaseCollector.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import { config } from '../config.js';

function determineNodeType(name: string, image: string): 'database' | 'queue' | 'gateway' | 'frontend' | 'service' | 'infrastructure' {
  const n = name.toLowerCase();
  const img = (image || '').toLowerCase();
  if (n.includes('db') || img.includes('mongo') || img.includes('mysql') || img.includes('postgres')) return 'database';
  if (n.includes('rabbitmq') || n.includes('queue')) return 'queue';
  if (n.includes('edge-router') || n.includes('gateway') || img.includes('traefik')) return 'gateway';
  if (n.includes('front-end') || n.includes('ui')) return 'frontend';
  if (n.includes('sim') || n.includes('test')) return 'infrastructure';
  return 'service';
}

// Declared microservice architecture for Sock Shop
const KNOWN_SOCK_SHOP_DECLARED_EDGES = [
  { source: 'edge-router', target: 'front-end', type: 'http' },
  { source: 'front-end', target: 'catalogue', type: 'http' },
  { source: 'front-end', target: 'carts', type: 'http' },
  { source: 'front-end', target: 'orders', type: 'http' },
  { source: 'front-end', target: 'user', type: 'http' },
  { source: 'catalogue', target: 'catalogue-db', type: 'database' },
  { source: 'carts', target: 'carts-db', type: 'database' },
  { source: 'orders', target: 'orders-db', type: 'database' },
  { source: 'orders', target: 'payment', type: 'http' },
  { source: 'orders', target: 'shipping', type: 'http' },
  { source: 'shipping', target: 'rabbitmq', type: 'message' },
  { source: 'queue-master', target: 'rabbitmq', type: 'message' },
  { source: 'user', target: 'user-db', type: 'database' },
  { source: 'user-sim', target: 'edge-router', type: 'http' },
];

export class SockShopAdapter extends BaseCollector {
  async discover(): Promise<ServiceNode[]> {
    if (!config.SOCK_SHOP_COMPOSE_PATH || !fs.existsSync(config.SOCK_SHOP_COMPOSE_PATH)) return [];
    try {
      const content = fs.readFileSync(config.SOCK_SHOP_COMPOSE_PATH, 'utf8');
      const doc = yaml.parse(content);
      const nodes: ServiceNode[] = [];

      if (doc && doc.services) {
        for (const [serviceName, serviceDef] of Object.entries(doc.services) as [string, any][]) {
          nodes.push({
            id: `sock-shop-${serviceName}`,
            name: serviceName,
            type: determineNodeType(serviceName, serviceDef?.image || ''),
            project: 'sock-shop',
            status: 'unknown',
            metrics: null,
            metadata: {
              image: serviceDef?.image,
              declaredInCompose: true
            }
          });
        }
      }
      return nodes;
    } catch (e) {
      console.error('Failed to parse Sock Shop compose for discovery:', e);
      return [];
    }
  }

  async collectMetrics(): Promise<MetricSnapshot | null> { return null; }

  async getKnownDependencies(): Promise<DependencyEdge[]> {
    const edgesMap = new Map<string, DependencyEdge>();

    // 1. Load baseline declared microservice architecture edges
    for (const edge of KNOWN_SOCK_SHOP_DECLARED_EDGES) {
      const sourceId = `sock-shop-${edge.source}`;
      const targetId = `sock-shop-${edge.target}`;
      const edgeId = `edge-${sourceId}-${targetId}`;
      edgesMap.set(edgeId, {
        id: edgeId,
        source: sourceId,
        target: targetId,
        type: edge.type as any,
        declared: true,
        observed: false,
        evidenceSources: ['compose-config'],
        status: 'unknown',
        metrics: null
      });
    }

    // 2. Add dependencies from compose file if specified
    if (config.SOCK_SHOP_COMPOSE_PATH && fs.existsSync(config.SOCK_SHOP_COMPOSE_PATH)) {
      try {
        const content = fs.readFileSync(config.SOCK_SHOP_COMPOSE_PATH, 'utf8');
        const doc = yaml.parse(content);

        if (doc && doc.services) {
          const serviceNames = Object.keys(doc.services);

          for (const [serviceName, serviceDef] of Object.entries(doc.services) as [string, any][]) {
            const sourceId = `sock-shop-${serviceName}`;

            if (serviceDef?.depends_on) {
              const deps = Array.isArray(serviceDef.depends_on) ? serviceDef.depends_on : Object.keys(serviceDef.depends_on);
              for (const dep of deps) {
                const targetId = `sock-shop-${dep}`;
                const edgeId = `edge-${sourceId}-${targetId}`;
                edgesMap.set(edgeId, {
                  id: edgeId,
                  source: sourceId,
                  target: targetId,
                  type: 'dependency',
                  declared: true,
                  observed: false,
                  evidenceSources: ['compose-config'],
                  status: 'unknown',
                  metrics: null
                });
              }
            }
          }
        }
      } catch (e) {
        console.error('Failed to parse Sock Shop compose for dependencies:', e);
      }
    }

    return Array.from(edgesMap.values());
  }
}