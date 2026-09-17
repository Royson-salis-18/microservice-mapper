import type { ServiceNode } from './ServiceNode.js';
import type { DependencyEdge } from './DependencyEdge.js';
import type { MetricSnapshot } from './MetricSnapshot.js';
import type { InteractionEvent } from './InteractionEvent.js';
import type { ConnectionEvent } from '../traces/types.js';

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
    /** Raw TCP connection events from /proc/net/tcp — SSH-sampled, not distributed tracing */
    connectionEvents?: ConnectionEvent[];
  };
}
