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
    anomalyScore?: number;
    anomalyPersistent?: boolean;
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
  /** Observed TCP connection activity — see server DependencyEdge model. */
  activity?: {
    /** Socket observations/min — see server DependencyEdge for what this
     * does and does not mean. */
    samplesPerMin: number;
    windowSec: number;
    lastSeen: string;
  };
  status: 'active' | 'degraded' | 'failed' | 'unknown';
}

export interface GraphData {
  nodes: ServiceNode[];
  edges: DependencyEdge[];
  targets: Target[];
}

export interface Target {
  targetId: string;
  displayName: string;
  environment: 'local' | 'remote' | 'aws' | string;
  host?: string;
  transport?: 'http' | 'ssh-tunnel' | string;
  status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA' | 'NO_DATA';
  lastSeen: string | null;
  baseUrl?: string;
  publicPort?: number;
  endpointStatus?: 'REACHABLE' | 'UNREACHABLE' | 'UNCONFIGURED';
  capabilities?: {
    dockerMetrics?: boolean;
    serviceHealth?: boolean;
    topology?: boolean;
    httpInteractions?: boolean;
    traces?: boolean;
  };
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
    connectionEvents?: any[];
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

export interface DiscoveredService {
  serviceId: string;
  targetId: string;
  name: string;
  containerId?: string;
  image?: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  health?: string;
  containerIP?: string;
  ports: number[];
  protocols: string[];
  labels: Record<string, string>;
  environmentMetadata?: Record<string, string>;
  restartCount?: number;
  networks?: string[];
  lastSeen: string;
}

export interface DiscoveredEndpoint {
  endpointId: string;
  targetId: string;
  serviceId: string;
  serviceName: string;
  host: string;
  port: number;
  protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'GRPC' | 'AMQP';
  basePath?: string;
  type: 'PUBLIC' | 'INTERNAL';
  source: string;
  discoveryMethod: string;
  reachable: boolean;
  lastChecked: string;
  statusCode?: number;
  latencyMs?: number;
}

export interface DiscoveredRoute {
  routeId: string;
  targetId: string;
  serviceId: string;
  endpointId: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ANY';
  path: string;
  protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'AMQP';
  source: string;
  declared: boolean;
  observed: boolean;
  trafficCapable: boolean;
  incapableReason?: string;
  firstSeen?: string;
  lastSeen?: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  latencyMs?: number;
}

export interface TargetDiscoverySummary {
  targetId: string;
  status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA';
  lastDiscovery: string;
  servicesCount: number;
  publicEndpointsCount: number;
  internalEndpointsCount: number;
  routesCount: number;
  observedRoutesCount: number;
  trafficCapableRoutesCount: number;
}

