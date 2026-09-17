export interface ServiceNode {
  id: string;
  name: string;
  type: 'gateway' | 'service' | 'database' | 'queue' | 'frontend' | 'infrastructure' | 'external';
  project: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** ISO-8601 UTC timestamp of the last discovery or telemetry update that
   * touched this node. Used to prune ghost nodes a container's containerId
   * churn (restart) or a one-off match failure left behind — see
   * GraphStore.pruneStaleNodes(). */
  lastSeen?: string;
  metadata: {
    containerId?: string;
    image?: string;
    ports?: string[];
    uptime?: string;
    restartCount?: number;
    [key: string]: any;
  };
  metrics: {
    cpu?: number;
    memory?: number;
    memoryPercent?: number;
    networkRx?: number;
    networkTx?: number;
    latency?: number | null;
    requestRate?: number | null;
    errorRate?: number | null;
  } | null;
  analytics?: {
    healthScore?: number | null;
    riskScore?: number | null;
    failureProbability?: number | null;
    affectedProbability?: number | null;
    criticality?: number | null;
    centrality?: number | null;
    upstreamCount?: number;
    downstreamCount?: number;
    /** From ml/score.py's per-service Isolation Forest, 0..1. Absent (not
     * null) until that service has a trained model and a live score. */
    anomalyScore?: number;
    anomalyPersistent?: boolean;
  };
}