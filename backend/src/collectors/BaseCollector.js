export class BaseCollector {
  async discover() {
    throw new Error('not implemented');
  }

  async collectMetrics(nodeId) {
    throw new Error('not implemented');
  }

  async collectAllMetrics() {
    throw new Error('not implemented');
  }

  getKnownDependencies() {
    return [];
  }

  getObservedInteractions() {
    return [];
  }

  getProject() {
    throw new Error('not implemented');
  }
}
