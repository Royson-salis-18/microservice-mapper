export function createDependencyEdge({ id, source, target, type, protocol, sourceOfTruth, status, metrics = {}, lastSeen }) {
  return {
    id,
    source,
    target,
    type,
    protocol: protocol || null,
    sourceOfTruth,
    status,
    metrics: {
      requestCount: metrics.requestCount !== undefined ? metrics.requestCount : null,
      latency: metrics.latency !== undefined ? metrics.latency : null,
      errorCount: metrics.errorCount !== undefined ? metrics.errorCount : null,
      errorRate: metrics.errorRate !== undefined ? metrics.errorRate : null
    },
    lastSeen: lastSeen || null
  };
}
