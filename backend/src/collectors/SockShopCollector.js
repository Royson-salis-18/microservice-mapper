import { DockerCollector } from './DockerCollector.js';
import config from '../config.js';
import { createDependencyEdge } from '../models/DependencyEdge.js';

export class SockShopCollector extends DockerCollector {
  getProject() {
    return 'sock-shop';
  }

  async discover() {
    const allNodes = await super.discover();
    const filteredNodes = this.filterContainers(allNodes, config.SOCK_SHOP_PREFIXES);
    
    filteredNodes.forEach(node => {
      const searchStr = node.name.toLowerCase();
      if (searchStr.includes('db')) {
        node.type = 'database';
      } else if (searchStr.includes('rabbitmq')) {
        node.type = 'queue';
      } else if (searchStr.includes('edge-router')) {
        node.type = 'gateway';
      } else if (searchStr.includes('front-end')) {
        node.type = 'frontend';
      }
    });

    return filteredNodes;
  }

  getKnownDependencies(nodes = []) {
    const edgesInfo = [
      { source: 'front-end', target: 'catalogue', type: 'http' },
      { source: 'front-end', target: 'carts', type: 'http' },
      { source: 'front-end', target: 'orders', type: 'http' },
      { source: 'front-end', target: 'user', type: 'http' },
      { source: 'orders', target: 'payment', type: 'http' },
      { source: 'orders', target: 'shipping', type: 'http' },
      { source: 'orders', target: 'queue-master', type: 'queue' },
      { source: 'queue-master', target: 'rabbitmq', type: 'queue' },
      { source: 'catalogue', target: 'catalogue-db', type: 'database' },
      { source: 'carts', target: 'carts-db', type: 'database' },
      { source: 'orders', target: 'orders-db', type: 'database' },
      { source: 'user', target: 'user-db', type: 'database' },
      { source: 'shipping', target: 'rabbitmq', type: 'queue' }
    ];

    const edges = [];
    const findNodeId = (nameIncludes) => {
      const node = nodes.find(n => n.name.includes(nameIncludes));
      return node ? node.id : null;
    };

    for (const info of edgesInfo) {
      const sourceId = findNodeId(info.source);
      const targetId = findNodeId(info.target);
      if (sourceId && targetId) {
        edges.push(createDependencyEdge({
          id: `${sourceId}-${targetId}`,
          source: sourceId,
          target: targetId,
          type: info.type,
          sourceOfTruth: 'config',
          status: 'unknown'
        }));
      }
    }

    return edges;
  }
}
