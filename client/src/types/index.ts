export interface GlobalStatus {
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  healthy: number;
  degraded: number;
  critical: number;
  unknown: number;
  lastUpdate: string;
}

export interface MetricSnapshot {
  timestamp: string;
  cpu?: number;
  memory?: number;
  memoryPercent?: number;
  networkRx?: number;
  networkTx?: number;
  latency?: number | null;
  p50Latency?: number | null;
  p95Latency?: number | null;
  p99Latency?: number | null;
  requestCount?: number | null;
  requestRate?: number | null;
  errorCount?: number | null;
  errorRate?: number | null;
  restartCount?: number;
}

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

export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  type: 'http' | 'database' | 'message' | 'dependency';
  protocol?: string;
  
  declared: boolean;
  observed: boolean;
  evidenceSources: string[];

  firstSeen?: string;
  lastSeen?: string;

  metrics: {
    requestCount?: number | null;
    requestRate?: number | null;
    latency?: number | null;
    p50Latency?: number | null;
    p95Latency?: number | null;
    p99Latency?: number | null;
    errorCount?: number | null;
    errorRate?: number | null;
    bytesSent?: number | null;
    throughput?: number | null;
  } | null;

  statusCodeDistribution?: Record<string, number>;
  status: 'active' | 'degraded' | 'failed' | 'unknown';
}

export interface GraphData {
  nodes: ServiceNode[];
  edges: DependencyEdge[];
  targets: Target[];
}

export interface Target {
  id: string;
  name: string;
  type: string;
  environment: string;
  platform: string;
  region?: string;
  endpoint?: string;
  status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO_DATA';
  lastSeen: string | null;
  metadata?: Record<string, any>;
}

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
    interactions?: any[];
  };
}

export type IncidentStatus = 'NORMAL' | 'DEGRADED' | 'INCIDENT' | 'RECOVERING' | 'RESOLVED';
export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RCAConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface ScoreContribution {
  factor: string;
  score: number;
  reason: string;
}

export interface CandidateCause {
  serviceId: string;
  serviceName: string;
  score: number;
  confidence: RCAConfidence;
  scoreBreakdown: ScoreContribution[];
  earliestAnomalyTimestamp?: string;
  primaryAnomalyMetric?: string;
}

export interface EvidenceItem {
  id: string;
  metric: string;
  timestamp: string;
  beforeValue: string;
  afterValue: string;
  changePercentage?: string;
  source: string;
  description: string;
}

export interface RCAExplanation {
  whatHappened: string;
  whenStarted: string;
  likelyRootCause: string;
  why: string;
  propagationPath: string[];
  affectedServices: string[];
  confidence: RCAConfidence;
  alternativeCandidates: { name: string; score: number; confidence: string }[];
  evidenceSummary: string[];
  recommendedInvestigation: string[];
}

export interface Incident {
  id: string;
  targetId: string;
  startedAt: string;
  detectedAt: string;
  endedAt: string | null;
  status: IncidentStatus;
  severity: IncidentSeverity;

  rootCauseServiceId: string | null;
  rootCauseEdgeId: string | null;
  rootCauseScore: number;
  confidence: RCAConfidence;

  symptoms: string[];
  anomalies: any[];
  propagation: any[];
  affectedServices: string[];
  candidateCauses: CandidateCause[];
  evidence: EvidenceItem[];
  explanation: RCAExplanation;
  remediationGuide: string[];
}
