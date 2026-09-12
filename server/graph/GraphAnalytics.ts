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

  performRCA() {
    const { nodes, edges } = this.store.getGraph();
    const failingNodes = nodes.filter(n => n.status === 'critical' || n.status === 'degraded');
    
    if (failingNodes.length === 0) {
      return {
        incidentDetected: false,
        message: 'All system components operating within normal telemetry parameters.',
        primaryRootCauses: [],
        cascadingFailures: [],
        blastRadius: { totalImpacted: 0, affectedServices: [] }
      };
    }

    const failingNodeIds = new Set(failingNodes.map(n => n.id));
    const primaryRootCauses: any[] = [];
    const cascadingFailures: any[] = [];

    for (const node of failingNodes) {
      // Find dependencies of this node (outgoing edges: source === node.id -> target)
      const dependencies = edges.filter(e => e.source === node.id).map(e => e.target);
      const failedDependencies = dependencies.filter(depId => failingNodeIds.has(depId));

      if (failedDependencies.length === 0) {
        // Primary Root Cause: No failing dependencies, failed independently
        primaryRootCauses.push({
          nodeId: node.id,
          name: node.name,
          project: node.project,
          type: node.type,
          status: node.status,
          failureReason: node.metadata?.state ? `Container state: ${node.metadata.state}` : 'Unresponsive microservice process',
          evidence: [
            `Container state: ${node.metadata?.state || 'Exited / Stopped'}`,
            `Zero telemetry response from endpoint`,
            `Downstream dependencies unable to communicate`
          ]
        });
      } else {
        // Cascading Failure: Failed due to dependency failure
        cascadingFailures.push({
          nodeId: node.id,
          name: node.name,
          project: node.project,
          type: node.type,
          status: node.status,
          causedBy: failedDependencies,
          failureReason: `Upstream dependency failure (${failedDependencies.map(id => id.replace(/^(sock-shop|vertikal)-/, '')).join(', ')})`,
          evidence: [
            `Upstream target ${failedDependencies.join(', ')} is unreachable`,
            `Dependency connection status: FAILED`
          ]
        });
      }
    }

    // Blast Radius calculation (all services connected to primary root causes)
    const blastRadiusNodes = new Set<string>();
    for (const rc of primaryRootCauses) {
      edges.filter(e => e.target === rc.nodeId || e.source === rc.nodeId).forEach(e => {
        blastRadiusNodes.add(e.source);
        blastRadiusNodes.add(e.target);
      });
    }

    return {
      incidentDetected: true,
      timestamp: new Date().toISOString(),
      primaryRootCauses,
      cascadingFailures,
      blastRadius: {
        totalImpacted: failingNodes.length,
        affectedServices: Array.from(blastRadiusNodes).map(id => id.replace(/^(sock-shop|vertikal)-/, '')),
      },
      remediationGuide: primaryRootCauses.map(rc => 
        `docker start docker-compose-${rc.name}-1`
      ).join(' && ')
    };
  }

  getAnalytics() {
    return {
      topCpuConsumers: this.topCpuConsumers(5),
      topMemoryConsumers: this.topMemoryConsumers(5),
      mostConnected: this.mostConnected(5),
      rca: this.performRCA(),
    };
  }
}