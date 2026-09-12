import { GraphStore } from './GraphStore.js';

export class GraphAnalytics {
  constructor(private store: GraphStore) {}

  nodeDegree(nodeId: string): number {
    return this.upstreamCount(nodeId) + this.downstreamCount(nodeId);
  }

  upstreamCount(nodeId: string): number {
    const { edges } = this.store.getGraph();
    return edges.filter(e => e.target === nodeId).length;
  }

  downstreamCount(nodeId: string): number {
    const { edges } = this.store.getGraph();
    return edges.filter(e => e.source === nodeId).length;
  }

  topCpuConsumers(limit: number) {
    const { nodes } = this.store.getGraph();
    const withCpu = nodes.map(n => {
      const history = this.store.metricStore.getHistory(n.id, '5m');
      const latest = history[history.length - 1];
      return { node: n, cpu: latest?.cpu || 0 };
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
      mostConnected: this.mostConnected(5),
    };
  }
}