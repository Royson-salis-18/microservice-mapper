export type IncidentStatus = 'NORMAL' | 'DEGRADED' | 'INCIDENT' | 'RECOVERING' | 'RESOLVED';
export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RCAConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface AnomalyRecord {
  id: string;
  nodeId: string;
  targetId: string;
  metric: string;
  timestamp: string;
  observedValue: number;
  baselineMean: number;
  baselineStdDev: number;
  zScore: number;
  severity: IncidentSeverity;
  evidenceSource?: string;
}

export interface PropagationStep {
  sourceId: string;
  targetId: string;
  timestamp: string;
  edgeId: string;
  evidenceSource: string;
  metricChange: string;
  confidence: RCAConfidence;
}

export interface ScoreContribution {
  factor: string;
  score: number;
  reason: string;
}

export interface CandidateCause {
  serviceId: string;
  serviceName: string;
  score: number; // 0.0 - 1.0
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
  source: string; // e.g., 'HTTP telemetry', 'container-runtime', 'network-tcp'
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
  anomalies: AnomalyRecord[];
  propagation: PropagationStep[];
  affectedServices: string[];
  candidateCauses: CandidateCause[];
  evidence: EvidenceItem[];
  explanation: RCAExplanation;
  remediationGuide: string[];
}
