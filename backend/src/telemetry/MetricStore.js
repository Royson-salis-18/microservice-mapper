import config from '../config.js';

export class MetricStore {
  constructor(maxSize = config.METRIC_HISTORY_SIZE) {
    this.maxSize = maxSize;
    this.store = new Map();
  }

  addMetric(nodeId, snapshot) {
    if (!this.store.has(nodeId)) {
      this.store.set(nodeId, []);
    }
    const history = this.store.get(nodeId);
    history.push(snapshot);
    if (history.length > this.maxSize) {
      history.shift();
    }
  }

  getHistory(nodeId, rangeMs = null) {
    const history = this.store.get(nodeId) || [];
    if (rangeMs === null) {
      return history;
    }
    const cutoff = Date.now() - rangeMs;
    return history.filter(m => m.timestamp >= cutoff);
  }

  getLatest(nodeId) {
    const history = this.store.get(nodeId) || [];
    return history.length > 0 ? history[history.length - 1] : null;
  }

  clear(nodeId) {
    this.store.delete(nodeId);
  }

  getAllLatest() {
    const latest = new Map();
    for (const nodeId of this.store.keys()) {
      latest.set(nodeId, this.getLatest(nodeId));
    }
    return latest;
  }
}
