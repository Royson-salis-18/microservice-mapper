import Docker from 'dockerode';
import { BaseCollector } from './BaseCollector.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';

type NodeType = ServiceNode['type'];

export class DockerCollector extends BaseCollector {
  private docker: Docker;
  // Maps container name → container docker ID for stats collection
  private containerIdMap = new Map<string, string>();

  constructor() {
    super();
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  private inferProject(name: string): ServiceNode['project'] {
    if (name.startsWith('vertikal-') || name.startsWith('vertikal_')) return 'vertikal';
    const sockShopNames = ['front-end', 'edge-router', 'catalogue', 'catalogue-db', 'carts', 'carts-db', 'orders', 'orders-db', 'user', 'user-db', 'payment', 'shipping', 'queue-master', 'rabbitmq', 'user-sim'];
    const cleanName = name.replace(/^docker-compose-/, '').replace(/-\d+$/, '');
    if (name.startsWith('sockshop') || name.startsWith('sock-shop') || sockShopNames.includes(cleanName)) return 'sock-shop';
    return 'vertikal';
  }

  private inferType(name: string, image: string): NodeType {
    const lower = name.toLowerCase();
    if (lower.includes('-db') || lower.includes('_db') || lower.includes('postgres') || lower.includes('mysql') || lower.includes('mongo')) return 'database';
    if (lower.includes('rabbitmq') || lower.includes('queue') || lower.includes('kafka') || lower.includes('redis')) return 'queue';
    if (lower.includes('gateway') || lower.includes('kong') || lower.includes('nginx') || lower.includes('edge-router')) return 'gateway';
    if (lower.includes('studio') || lower.includes('front-end') || lower.includes('frontend')) return 'frontend';
    if (lower.includes('mail') || lower.includes('meta') || lower.includes('prometheus') || lower.includes('grafana')) return 'infrastructure';
    return 'service';
  }

  async discover(): Promise<ServiceNode[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      this.containerIdMap.clear();

      return containers.map(c => {
        const name = c.Names[0].replace(/^\//, '');
        const image = c.Image;
        const dockerId = c.Id;

        const cleanName = name.replace(/^docker-compose-/, '').replace(/-\d+$/, '');
        const project = this.inferProject(name);
        const id = project === 'sock-shop' ? `sock-shop-${cleanName}` : name;

        this.containerIdMap.set(name, dockerId);
        this.containerIdMap.set(cleanName, dockerId);
        this.containerIdMap.set(id, dockerId);
        const type = this.inferType(name, image);

        let status: ServiceNode['status'] = 'unknown';
        if (c.State === 'running') {
          status = c.Status.toLowerCase().includes('healthy') ? 'healthy' : 'healthy';
        } else if (c.State === 'restarting') {
          status = 'critical';
        } else if (c.State === 'exited' || c.State === 'dead') {
          status = 'critical';
        }
        // Containers that are restarting show State=restarting
        if (c.Status.toLowerCase().includes('restarting')) {
          status = 'critical';
        }

        const ports = c.Ports
          .filter(p => p.PublicPort)
          .map(p => `${p.PublicPort}:${p.PrivatePort}`);

        const restartCount = parseInt(c.Status.match(/Restarting \((\d+)\)/)?.[1] || '0', 10);

        return {
          id, // Standardized node ID
          name: cleanName,
          type,
          project,
          status,
          metadata: {
            containerId: dockerId.slice(0, 12),
            image,
            ports,
            uptime: c.Status,
            restartCount,
          },
          metrics: null, // Will be populated by collectMetrics
        };
      });
    } catch (e) {
      console.error('Failed to discover containers:', e);
      return [];
    }
  }

  async collectMetrics(nodeId: string): Promise<MetricSnapshot | null> {
    try {
      // nodeId is now container name; resolve to docker ID
      const dockerId = this.containerIdMap.get(nodeId);
      if (!dockerId) return null;

      const container = this.docker.getContainer(dockerId);
      const stats = await container.stats({ stream: false });

      // CPU calculation
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemCpuDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const numberCpus = stats.cpu_stats.online_cpus || 1;
      let cpu = 0;
      if (systemCpuDelta > 0 && cpuDelta > 0) {
        cpu = Math.round(((cpuDelta / systemCpuDelta) * numberCpus * 100.0) * 100) / 100;
      }

      // Memory calculation
      const memoryUsage = stats.memory_stats.usage || 0;
      const memoryLimit = stats.memory_stats.limit || 0;
      let memoryPercent: number | undefined;
      if (memoryLimit > 0) {
        memoryPercent = Math.round((memoryUsage / memoryLimit) * 100 * 100) / 100;
      }

      // Network
      let networkRx = 0;
      let networkTx = 0;
      if (stats.networks) {
        for (const iface of Object.values(stats.networks) as any[]) {
          networkRx += iface.rx_bytes || 0;
          networkTx += iface.tx_bytes || 0;
        }
      }

      return {
        timestamp: new Date().toISOString(),
        cpu,
        memory: memoryUsage,
        memoryPercent,
        networkRx,
        networkTx,
      };
    } catch (e: any) {
      // Container may have stopped between discover and stats
      if (!e.message?.includes('is not running')) {
        console.error(`Failed to collect metrics for ${nodeId}:`, e.message);
      }
      return null;
    }
  }

  async getKnownDependencies(): Promise<DependencyEdge[]> {
    return [];
  }
}