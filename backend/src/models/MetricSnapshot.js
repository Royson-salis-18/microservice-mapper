export function createMetricSnapshot({ timestamp = Date.now(), cpu = null, memory = null, memoryPercent = null, networkRx = null, networkTx = null, latency = null, requestRate = null, errorRate = null, restartCount = null } = {}) {
  return {
    timestamp,
    cpu,
    memory,
    memoryPercent,
    networkRx,
    networkTx,
    latency,
    requestRate,
    errorRate,
    restartCount
  };
}
