import Docker from 'dockerode';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import type { InteractionEvent } from '../models/InteractionEvent.js';
import { BaseCollector } from './BaseCollector.js';
import type { MetricStore } from '../telemetry/MetricStore.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  async collectMetrics(nodeId: string): Promise<MetricSnapshot | null> {
    return null;
  }

  async getKnownDependencies(): Promise<DependencyEdge[]> {
    const edges = new Map<string, DependencyEdge>();
    try {
      const since = Math.floor(this.lastLogTime / 1000);
      this.lastLogTime = Date.now();
      
      const container = this.docker.getContainer('vertikal-gateway');
      const logsBuffer = await container.logs({
        stdout: true,
        stderr: true,
        since: since,
        timestamps: false
      });
      
      // dockerode returns a Buffer or Stream. For a string buffer, it has headers.
      // We can just convert to string and regex extract the JSON objects.
      const logsStr = logsBuffer.toString('utf8');
      const lines = logsStr.split('\n').filter(l => l.includes('upstream_addr') && l.includes('{'));
      
      for (let line of lines) {
        try {
          // Strip docker headers if they exist by finding the first '{'
          line = line.substring(line.indexOf('{'));
          const log = JSON.parse(line);
          if (!log.upstream_addr || log.upstream_addr === '-') continue;
          
          let target = 'unknown';
          if (log.upstream_addr.includes('9999')) target = 'vertikal-auth';
          else if (log.upstream_addr.includes('3000')) target = 'vertikal-rest';
          else continue;

          const event: InteractionEvent = {
            id: `ev-${Date.now()}-${Math.floor(performance.now() * 1000)}`,
            timestamp: log.timestamp || new Date().toISOString(),
            source: 'vertikal-gateway',
            target,
            protocol: 'HTTP',
            method: log.method,
            route: log.uri,
            statusCode: parseInt(log.upstream_status) || parseInt(log.status) || 200,
            latency: parseFloat(log.upstream_response_time) * 1000 || parseFloat(log.request_time) * 1000 || 0,
            bytesSent: parseInt(log.bytes_sent) || 0,
            evidenceSource: 'http-log'
          };
          
          console.log('RuntimeObserver pushed event:', event.source, '->', event.target);
          this.metricStore.pushEvent(event);
          
          const edgeId = `vertikal-gateway-${target}`;
          if (!edges.has(edgeId)) {
            edges.set(edgeId, {
              id: edgeId,
              source: 'vertikal-gateway',
              target,
              type: 'http',
              declared: false,
              observed: true,
              evidenceSources: ['http-log'],
              status: 'unknown',
              metrics: null
            });
          }
        } catch(e) {
          // parse error
        }
      }
    } catch (e) {
      console.error('RuntimeObserver error:', e);
    }
    
    return Array.from(edges.values());
  }
}
