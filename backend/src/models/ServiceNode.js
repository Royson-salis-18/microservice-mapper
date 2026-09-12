export function createServiceNode({ id, name, type, project, status, metadata = {}, metrics = {} }) {
  return {
    id,
    name,
    type,
    project,
    status,
    metadata: {
      containerId: metadata.containerId || null,
      image: metadata.image || null,
      ports: metadata.ports || [],
      uptime: metadata.uptime || null,
      restartCount: metadata.restartCount !== undefined ? metadata.restartCount : null,
      labels: metadata.labels || {}
    },
    metrics: {
      cpu: metrics.cpu !== undefined ? metrics.cpu : null,
      memory: metrics.memory !== undefined ? metrics.memory : null,
      memoryPercent: metrics.memoryPercent !== undefined ? metrics.memoryPercent : null,
      networkRx: metrics.networkRx !== undefined ? metrics.networkRx : null,
      networkTx: metrics.networkTx !== undefined ? metrics.networkTx : null
    }
  };
}
