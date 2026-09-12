import { DockerCollector } from './DockerCollector.js';
import config from '../config.js';

export class VertikalCollector extends DockerCollector {
  getProject() {
    return 'vertikal';
  }

  async discover() {
    const allNodes = await super.discover();
    return this.filterContainers(allNodes, config.VERTIKAL_PREFIXES);
  }

  getKnownDependencies(nodes = []) {
    // TODO: Add known dependencies for Vertikal
    return [];
  }
}
