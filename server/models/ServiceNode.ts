export interface ServiceNode {
  id: string;
  name: string;
  type: 'gateway' | 'service' | 'database' | 'queue' | 'frontend' | 'infrastructure' | 'external';
  project: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
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
  };
}