import Docker from 'dockerode';
import { BaseCollector } from './BaseCollector.js';
import { createServiceNode } from '../models/ServiceNode.js';
import { createMetricSnapshot } from '../models/MetricSnapshot.js';
import config from '../config.js';

export class DockerCollector extends BaseCollector {
  constructor() {
    super();
    this.docker = new Docker({ socketPath: config.DOCKER_SOCKET });
  }

  async discover() {
    try {
      const containers = await this.docker.listContainers({ all: true });
      return await Promise.all(containers.map(async (c) => {
        const name = c.Names[0].replace(/^\//, '');
        const containerId = c.Id.substring(0, 12);
        const image = c.Image;
        const status = c.State === 'running' ? 'healthy' : (c.State === 'exited' || c.State === 'dead' ? 'critical' : 'unknown');
        const ports = c.Ports || [];
        const uptime = c.Created;
        
        let restartCount = 0;
        try {
          const container = this.docker.getContainer(c.Id);
          const inspectData = await container.inspect();
          restartCount = inspectData.RestartCount;
        } catch (e) {
          console.warn(`[MicroMapper] Failed to inspect container ${containerId}:`, e.message);
        }

        const labels = c.Labels || {};
        
        let type = 'service';
        const searchStr = `${name} ${image}`.toLowerCase();
        if (/mongo|mysql|postgres|redis|mariadb/.test(searchStr)) {
          type = 'database';
        } else if (/rabbit|kafka|nats/.test(searchStr)) {
          type = 'queue';
        } else if (/gateway|nginx|traefik|kong|envoy/.test(searchStr)) {
          type = 'gateway';
        } else if (/frontend|edge-router/.test(searchStr)) {
          type = 'frontend';
        }

        return createServiceNode({
          id: containerId,
          name,
          type,
          project: this.getProject(),
          status,
          metadata: { containerId, image, ports, uptime, restartCount, labels }
        });
      }));
    } catch (e) {
      console.error('[MicroMapper] Docker discover failed:', e.message);
      return [];
    }
  }

  async collectMetrics(containerId) {
    try {
      const container = this.docker.getContainer(containerId);
      const stats = await container.stats({ stream: false });
      
      let cpu = null;
      let memory = null;
      let memoryPercent = null;
      let networkRx = null;
      let networkTx = null;

      if (stats.cpu_stats && stats.precpu_stats) {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const numCpus = stats.cpu_stats.online_cpus || 1;
        if (systemDelta > 0 && cpuDelta > 0) {
          cpu = (cpuDelta / systemDelta) * numCpus * 100;
        }
      }

      if (stats.memory_stats && stats.memory_stats.usage) {
        const inactive_file = (stats.memory_stats.stats && stats.memory_stats.stats.inactive_file) || 
                              (stats.memory_stats.stats && stats.memory_stats.stats.cache) || 0;
        memory = stats.memory_stats.usage - inactive_file;
        if (stats.memory_stats.limit) {
          memoryPercent = (memory / stats.memory_stats.limit) * 100;
        }
      }

      if (stats.networks) {
        networkRx = 0;
        networkTx = 0;
        for (const eth of Object.values(stats.networks)) {
          networkRx += eth.rx_bytes;
          networkTx += eth.tx_bytes;
        }
      }

      return createMetricSnapshot({
        timestamp: Date.now(),
        cpu,
        memory,
        memoryPercent,
        networkRx,
        networkTx
      });
    } catch (e) {
      console.warn(`[MicroMapper] Failed to collect metrics for ${containerId}:`, e.message);
      return createMetricSnapshot();
    }
  }

  async collectAllMetrics(nodes = []) {
    const metricsMap = new Map();
    const results = await Promise.allSettled(nodes.map(n => this.collectMetrics(n.id).then(m => ({ id: n.id, metrics: m }))));
    for (const res of results) {
      if (res.status === 'fulfilled') {
        metricsMap.set(res.value.id, res.value.metrics);
      }
    }
    return metricsMap;
  }

  filterContainers(containers, prefixes) {
    return containers.filter(c => prefixes.some(p => c.name.includes(p)));
  }
}
