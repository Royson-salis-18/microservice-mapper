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
    // Tier 0 — exact, from cgroup accounting.
    cpu?: number;
    memory?: number;
    memoryPercent?: number;
    /** Bytes received / sent since the container started (cumulative). */
    networkRx?: number;
    networkTx?: number;
    /** Bytes per second over the last interval: exact, from the container's
     *  /proc/<pid>/net/dev counters where readable. Undefined until two
     *  readings exist. */
    networkRxRate?: number;
    networkTxRate?: number;
    /** Cores the container may use: its CPU limit, else the host's cores. */
    cpuAllowanceCores?: number;
    /** CPU as a share of that allowance, 0..100. `cpu` above is docker's
     *  figure, percent of ONE core, which can exceed 100. */
    cpuOfAllowance?: number;
    // Tier 1/2 only. Nothing outside the container can measure these, so
    // they are absent rather than zero when no source supplied them.
    latency?: number | null;
    latencyP50?: number | null;
    latencyP95?: number | null;
    latencyP99?: number | null;
    requestRate?: number | null;
    errorRate?: number | null;
    /** Which source produced the request-level fields above.
     *  See wiki/18-telemetry-tiers-plan.md. */
    provenance?: {
      source: 'cgroup' | 'socket-scan' | 'access-log' | 'prometheus' | 'trace-backend';
      tier: 0 | 1 | 2;
      observedAt: string;
      detail?: string;
    };
  } | null;
  analytics?: {
    // healthScore/riskScore/criticality/centrality/upstreamCount/downstreamCount
    // are computed server-side every poll cycle by RiskEngine — see
    // server/graph/RiskEngine.ts. healthBreakdown is the named factors behind
    // healthScore/riskScore, same style as CandidateCause.scoreBreakdown below.
    healthScore?: number | null;
    /** Current exposure — half current health, half how much observed
     *  traffic structurally depends on this node. Not a predicted probability. */
    riskScore?: number | null;
    /** Predicted probability of failure from the cascade model — an estimate
     *  under a stated model, not an observed frequency. See
     *  server/graph/CascadeEngine.ts. */
    failureProbability?: number | null;
    /** The part of failureProbability arriving through dependencies alone. */
    affectedProbability?: number | null;
    /** Id of the dependency contributing most of the inherited risk. */
    cascadeVia?: string | null;
    /** Hops from where this service's risk originates; 0 = its own state. */
    cascadeDepth?: number;
    criticality?: number | null;
    centrality?: number | null;
    upstreamCount?: number;
    downstreamCount?: number;
    healthBreakdown?: ScoreContribution[];
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
    /** Slow-moving baseline of samplesPerMin (rises in ~1 min, falls over
     *  ~10), which edge weights are computed from. */
    baselinePerMin?: number;
    windowSec: number;
    lastSeen: string;
    /** Average number of distinct open (ESTABLISHED) connections over the
     *  last two minutes, each counted once whichever end reported it. */
    openConnections?: number;
    /** Distinct connections opened per minute over the same window. A closed
     *  connection lingers ~60s in TIME_WAIT and is still counted once. */
    newConnectionsPerMin?: number;
    /** Socket sweeps behind those two figures. */
    connectionSweeps?: number;
  };
  status: 'active' | 'degraded' | 'failed' | 'unknown';
  /** How strongly the source depends on the target — see
   *  server/graph/EdgeWeights.ts. Absent until the first poll cycle. */
  weight?: EdgeWeight;
}

export interface EdgeWeight {
  /** 0..1, confidence × dependency: how strongly a failure of the target
   *  transmits to the source. */
  value: number;
  dependency: number;
  dependencyBasis: 'requests' | 'activity' | 'uniform';
  /** telemetry = monitoring traffic, weighted at a tenth — see server EdgeWeights. */
  kind: 'request' | 'telemetry';
  volume: number | null;
  confidence: number;
  confidenceBasis: string;
  stress: number | null;
}

export type RiskBand = 'high' | 'elevated' | 'low' | 'minimal';

export interface NodeCascade {
  nodeId: string;
  nodeName: string;
  probability: number;
  intrinsic: number;
  inherited: number;
  band: RiskBand;
  via: { nodeId: string; nodeName: string; contribution: number } | null;
  path: string[];
  depth: number;
  intrinsicReasons: string[];
}

export interface CascadePrediction {
  project: string;
  generatedAt: string;
  model: string;
  transmission: number;
  iterations: number;
  converged: boolean;
  expectedFailures: number;
  atRisk: NodeCascade[];
  nodes: NodeCascade[];
}

export interface WhatIfResult {
  project: string;
  generatedAt: string;
  model: string;
  transmission: number;
  origin: { nodeId: string; nodeName: string };
  expectedAdditionalFailures: number;
  affected: Array<NodeCascade & { baseline: number; delta: number }>;
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

