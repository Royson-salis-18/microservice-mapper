import type { ServiceNode } from './ServiceNode.js';
import type { DependencyEdge } from './DependencyEdge.js';
import type { MetricSnapshot } from './MetricSnapshot.js';
import type { InteractionEvent } from './InteractionEvent.js';

export interface TelemetryEnvelope {
  schemaVersion: string;
  targetId: string;
  collectorId: string;
  timestamp: string;
  source: string;
  events: {
    nodes?: ServiceNode[];
    edges?: DependencyEdge[];
    metrics?: { nodeId: string; snapshot: MetricSnapshot }[];
    interactions?: InteractionEvent[];
  };
}
