export const GraphAnalytics = {
  computeAnalytics(snapshot) {
    const { nodes, edges } = snapshot;

    const nodesWithDegrees = nodes.map(node => {
      const upstreamEdges = edges.filter(e => e.target === node.id);
      const downstreamEdges = edges.filter(e => e.source === node.id);
      return {
        ...node,
        upstreamCount: upstreamEdges.length,
        downstreamCount: downstreamEdges.length,
        degree: upstreamEdges.length + downstreamEdges.length
      };
    });

    const topCpu = [...nodes]
      .filter(n => n.metrics && n.metrics.cpu !== null)
      .sort((a, b) => b.metrics.cpu - a.metrics.cpu)
      .slice(0, 5);

    const topMemory = [...nodes]
      .filter(n => n.metrics && n.metrics.memoryPercent !== null)
      .sort((a, b) => b.metrics.memoryPercent - a.metrics.memoryPercent)
      .slice(0, 5);

    const mostConnected = [...nodesWithDegrees]
      .sort((a, b) => b.degree - a.degree);

    const mostDependedOn = [...nodesWithDegrees]
      .sort((a, b) => b.upstreamCount - a.upstreamCount);

    const recentFailures = nodes.filter(n => n.status === 'critical' || n.status === 'degraded');

    return {
      topCpu,
      topMemory,
      mostConnected,
      mostDependedOn,
      recentFailures,
      nodeStats: nodesWithDegrees.map(n => ({
        id: n.id,
        degree: n.degree,
        upstreamCount: n.upstreamCount,
        downstreamCount: n.downstreamCount
      }))
    };
  }
};
