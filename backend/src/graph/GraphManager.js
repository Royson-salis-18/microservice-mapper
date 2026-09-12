export class GraphManager {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.collectors = [];
    this.timestamp = Date.now();
  }

  registerCollector(collector) {
    this.collectors.push(collector);
  }

  async refresh() {
    const newNodes = new Map();
    const newEdges = new Map();

    for (const collector of this.collectors) {
      try {
        const discoveredNodes = await collector.discover();
        const metricsMap = await collector.collectAllMetrics(discoveredNodes);

        for (const node of discoveredNodes) {
          const metrics = metricsMap.get(node.id);
          if (metrics) {
            node.metrics = metrics;
            
            let status = node.status;
            if (status !== 'critical') {
              if (metrics.cpu > 95 || metrics.memoryPercent > 95) {
                status = 'critical';
              } else if (metrics.cpu > 90 || metrics.memoryPercent > 90) {
                status = 'degraded';
              }
            }
            node.status = status;
          }
          newNodes.set(node.id, node);
        }

        const discoveredEdges = collector.getKnownDependencies(discoveredNodes);
        for (const edge of discoveredEdges) {
          newEdges.set(edge.id, edge);
        }
      } catch (e) {
        console.error(`[MicroMapper] Error refreshing collector ${collector.getProject()}:`, e.message);
      }
    }

    this.nodes = newNodes;
    this.edges = newEdges;
    this.timestamp = Date.now();
  }

  getSnapshot() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      timestamp: this.timestamp,
      projectStats: {}
    };
  }

  getNodeDetail(nodeId) {
    return this.nodes.get(nodeId) || null;
  }

  getUpstream(nodeId) {
    return Array.from(this.edges.values()).filter(e => e.target === nodeId);
  }

  getDownstream(nodeId) {
    return Array.from(this.edges.values()).filter(e => e.source === nodeId);
  }
}
