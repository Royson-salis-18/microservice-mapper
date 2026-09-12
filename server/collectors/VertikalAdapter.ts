import fs from 'fs';
import yaml from 'yaml';
import { BaseCollector } from './BaseCollector.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import { config } from '../config.js';

// Maps compose service names to their container_name in docker-compose.yml
const VERTIKAL_SERVICE_TO_CONTAINER: Record<string, string> = {
  db: 'vertikal-db',
  auth: 'vertikal-auth',
  rest: 'vertikal-rest',
  kong: 'vertikal-gateway',
  mailpit: 'vertikal-mail',
  meta: 'vertikal-meta',
  studio: 'vertikal-studio',
};

// Maps compose service names to dependency edge types
const VERTIKAL_EDGE_TYPES: Record<string, DependencyEdge['type']> = {
  db: 'database',
  auth: 'http',
  rest: 'http',
  kong: 'http',
  mailpit: 'http',
  meta: 'http',
  studio: 'http',
};

const VERTIKAL_NODE_TYPES: Record<string, ServiceNode['type']> = {
  db: 'database',
  auth: 'service',
  rest: 'service',
  kong: 'gateway',
  mailpit: 'infrastructure',
  meta: 'infrastructure',
  studio: 'frontend',
};

export class VertikalAdapter extends BaseCollector {
  async discover(): Promise<ServiceNode[]> {
    if (!config.VERTIKAL_COMPOSE_PATH || !fs.existsSync(config.VERTIKAL_COMPOSE_PATH)) return [];
    try {
      const content = fs.readFileSync(config.VERTIKAL_COMPOSE_PATH, 'utf8');
      const doc = yaml.parse(content);
      const nodes: ServiceNode[] = [];

      if (doc && doc.services) {
        for (const [serviceName, serviceDef] of Object.entries(doc.services) as [string, any][]) {
          const containerName = VERTIKAL_SERVICE_TO_CONTAINER[serviceName] || `vertikal-${serviceName}`;
          nodes.push({
            id: containerName,
            name: serviceName,
            type: VERTIKAL_NODE_TYPES[serviceName] || 'service',
            project: 'vertikal',
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
      console.error('Failed to parse Vertikal compose for discovery:', e);
      return [];
    }
  }

  async collectMetrics(): Promise<MetricSnapshot | null> { return null; }

  async getKnownDependencies(): Promise<DependencyEdge[]> {
    if (!config.VERTIKAL_COMPOSE_PATH) return [];

    try {
      if (!fs.existsSync(config.VERTIKAL_COMPOSE_PATH)) return [];
      
      const content = fs.readFileSync(config.VERTIKAL_COMPOSE_PATH, 'utf8');
      const doc = yaml.parse(content);
      const edges: DependencyEdge[] = [];

      if (doc.services) {
        for (const [serviceName, serviceDef] of Object.entries(doc.services) as [string, any][]) {
          const sourceContainer = VERTIKAL_SERVICE_TO_CONTAINER[serviceName] || `vertikal-${serviceName}`;
          
          if (serviceDef.depends_on) {
            const dependsOn = Array.isArray(serviceDef.depends_on) 
              ? serviceDef.depends_on 
              : Object.keys(serviceDef.depends_on);

            for (const dep of dependsOn) {
              const targetContainer = VERTIKAL_SERVICE_TO_CONTAINER[dep] || `vertikal-${dep}`;
              edges.push({
                id: `${sourceContainer}-${targetContainer}`,
                source: sourceContainer,
                target: targetContainer,
                type: VERTIKAL_EDGE_TYPES[dep] || 'dependency',
                declared: true,
                observed: false,
                evidenceSources: ['compose'],
                status: 'unknown',
                metrics: null,
              });
            }
          }
        }
      }

      // Add implicit gateway routes (Kong -> Auth, Kong -> Rest) since depends_on covers it mostly
      return edges;
    } catch (e) {
      console.error('Failed to parse Vertikal compose dependencies:', e);
      return [];
    }
  }
}