import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';

export abstract class BaseCollector {
  abstract discover(): Promise<ServiceNode[]>;
  abstract collectMetrics(nodeId: string): Promise<MetricSnapshot | null>;
  abstract getKnownDependencies(): Promise<DependencyEdge[]>;
}