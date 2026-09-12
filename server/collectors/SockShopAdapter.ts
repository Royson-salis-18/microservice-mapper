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
    if (!config.SOCK_SHOP_COMPOSE_PATH || !fs.existsSync(config.SOCK_SHOP_COMPOSE_PATH)) return [];
    try {
      const content = fs.readFileSync(config.SOCK_SHOP_COMPOSE_PATH, 'utf8');
      const doc = yaml.parse(content);
      const edgesMap = new Map<string, DependencyEdge>();

      if (doc && doc.services) {
        const serviceNames = Object.keys(doc.services);

        for (const [serviceName, serviceDef] of Object.entries(doc.services) as [string, any][]) {
          const sourceId = `sock-shop-${serviceName}`;

          // 1. Check explicit depends_on
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

          // 2. Check links
          if (serviceDef?.links) {
            for (const link of serviceDef.links) {
              const dep = link.split(':')[0];
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

          // 3. Dynamic Environment Var Target Resolution (e.g. MONGO_HOST=user-db:27017)
          if (serviceDef?.environment) {
            const envVars = Array.isArray(serviceDef.environment)
              ? serviceDef.environment
              : Object.entries(serviceDef.environment).map(([k, v]) => `${k}=${v}`);

            for (const env of envVars) {
              for (const targetName of serviceNames) {
                if (targetName !== serviceName && env.includes(targetName)) {
                  const targetId = `sock-shop-${targetName}`;
                  const edgeId = `edge-${sourceId}-${targetId}`;
                  const targetType = determineNodeType(targetName, doc.services[targetName]?.image || '');
                  const edgeType = targetType === 'database' ? 'database' : targetType === 'queue' ? 'message' : 'http';

                  edgesMap.set(edgeId, {
                    id: edgeId,
                    source: sourceId,
                    target: targetId,
                    type: edgeType,
                    declared: true,
                    observed: false,
                    evidenceSources: ['compose-env-vars'],
                    status: 'unknown',
                    metrics: null
                  });
                }
              }
            }
          }
        }
      }
      return Array.from(edgesMap.values());
    } catch (e) {
      console.error('Failed to parse Sock Shop compose for dependencies:', e);
      return [];
    }
  }
}