import Docker from 'dockerode';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import type { InteractionEvent } from '../models/InteractionEvent.js';
import { BaseCollector } from './BaseCollector.js';
import type { MetricStore } from '../telemetry/MetricStore.js';

function demuxDockerLogs(buffer: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) {
      const chunk = buffer.subarray(offset + 8).toString('utf8');
      lines.push(...chunk.split('\n'));
      break;
    }
    const chunk = buffer.subarray(offset + 8, offset + 8 + size).toString('utf8');
    lines.push(...chunk.split('\n'));
    offset += 8 + size;
  }
  if (lines.length === 0 && buffer.length > 0) {
    lines.push(...buffer.toString('utf8').split('\n'));
  }
  return lines;
}

export class RuntimeObserver extends BaseCollector {
  private docker: Docker;
  private metricStore: MetricStore;
  private lastLogTime: number = Date.now() - 5000;

  constructor(metricStore: MetricStore) {
    super();
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.metricStore = metricStore;
  }

  async discover(): Promise<ServiceNode[]> {
    return [];
  }

  async collectMetrics(_nodeId: string): Promise<MetricSnapshot | null> {
    return null;
  }

  async getKnownDependencies(): Promise<DependencyEdge[]> {
    const edges = new Map<string, DependencyEdge>();
    try {
      const since = Math.floor(this.lastLogTime / 1000);
      this.lastLogTime = Date.now();
      
      const containers = await this.docker.listContainers({ all: false });
      
      for (const containerInfo of containers) {
        try {
          const containerName = containerInfo.Names[0].replace(/^\//, '');
          const cleanName = containerName.replace(/^docker-compose-/, '').replace(/-\d+$/, '');
          
          const container = this.docker.getContainer(containerInfo.Id);
          const logsBuffer = await container.logs({
            stdout: true,
            stderr: true,
            since: since,
            timestamps: false
          });
          
          const lines = demuxDockerLogs(logsBuffer);
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let method = 'GET';
            let path = '';
            let status = 200;
            let bytes = 0;
            let latency = 10;
            let matched = false;

            // 1. JSON log format
            if (trimmed.includes('{') && trimmed.includes('}')) {
              try {
                const jsonStr = trimmed.substring(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
                const log = JSON.parse(jsonStr);
                if (log.request || log.uri || log.url) {
                  method = log.method || (log.request ? log.request.split(' ')[0] : 'GET');
                  path = log.uri || log.url || (log.request ? log.request.split(' ')[1] : '/');
                  status = parseInt(log.status || log.upstream_status) || 200;
                  bytes = parseInt(log.body_bytes_sent || log.bytes_sent) || 0;
                  latency = (parseFloat(log.upstream_response_time || log.request_time) || 0.01) * 1000;
                  matched = true;
                }
              } catch (e) {}
            }

            // 2. Standard HTTP access log format: "GET /path HTTP/1.1" 200 123
            if (!matched) {
              const match = trimmed.match(/"([A-Z]+)\s+([^\s]+)\s+HTTP\/[0-9.]+"\s+(\d+)\s+(\d+)/);
              if (match) {
                method = match[1];
                path = match[2];
                status = parseInt(match[3]);
                bytes = parseInt(match[4]);
                matched = true;
              }
            }

            if (!matched || !path) continue;

            let target = cleanName;
            let source = 'external';

            // Vertikal Gateway routing logic
            if (cleanName.includes('gateway')) {
              source = 'vertikal-gateway';
              if (path.startsWith('/auth/v1')) target = 'vertikal-auth';
              else if (path.startsWith('/rest/v1')) target = 'vertikal-rest';
              else if (path.startsWith('/storage/v1')) target = 'vertikal-storage';
              else if (path.startsWith('/health')) target = 'vertikal-gateway';
            }
            // Sock Shop Edge Router / Front End routing logic
            else if (cleanName === 'edge-router' || cleanName === 'front-end') {
              source = cleanName === 'edge-router' ? 'edge-router' : 'front-end';
              if (path.startsWith('/catalogue')) target = 'catalogue';
              else if (path.startsWith('/cart')) target = 'carts';
              else if (path.startsWith('/orders')) target = 'orders';
              else if (path.startsWith('/login') || path.startsWith('/customers') || path.startsWith('/cards') || path.startsWith('/address')) target = 'user';
              else if (path.startsWith('/shipping')) target = 'shipping';
              else if (path.startsWith('/page') || path === '/') target = 'front-end';
            }

            const event: InteractionEvent = {
              id: `ev-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
              timestamp: new Date().toISOString(),
              source,
              target,
              protocol: 'HTTP',
              method,
              route: path,
              statusCode: status,
              latency,
              bytesSent: bytes,
              evidenceSource: 'http-log'
            };
            
            this.metricStore.pushEvent(event);
            
            const edgeId = `${source}-${target}`;
            if (!edges.has(edgeId) && source !== target) {
              edges.set(edgeId, {
                id: edgeId,
                source,
                target,
                type: 'http',
                declared: false,
                observed: true,
                evidenceSources: ['http-log'],
                status: 'unknown',
                metrics: null
              });
            }
          }
        } catch (e) {
          // ignore individual container log errors
        }
      }
    } catch (e) {
      console.error('RuntimeObserver error:', e);
    }
    
    return Array.from(edges.values());
  }
}
