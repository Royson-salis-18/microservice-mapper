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
  /** null when the rule that fired is not a z-score (exited container, flat-baseline jump). */
  zScore: number | null;
  /** Which rule fired, so a null zScore is explained rather than faked. */
  reason?: string;
  severity: IncidentSeverity;
  evidenceSource?: string;
  /** own = about the service itself (cpu, memory, silence); symptom = can be inherited from a broken dependency
   * (latency, errors, traffic); hard = a fact (container stopped / paused / restarted). */
  evidence?: 'own' | 'symptom' | 'hard';
}

export interface PropagationStep {
  sourceId: string;
  targetId: string;
  /** First anomaly seen on the target; absent when none was recorded. */
  timestamp?: string;
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
  /** Raw attribution parts (noise-normalised z scale): own evidence, symptoms, how much a broken callee explains. */
  own?: number;
  symptoms?: number;
  explained?: number;
}

/** A service not yet failing that is likely to be pulled in next (noisy-OR over its failing dependencies). */
export interface AtRiskService {
  serviceId: string;
  serviceName: string;
  risk: number;            // 0..1, a ranking of who to watch, not a calibrated probability
  via: string[];           // the failing dependencies it calls
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
  /** Services likely to be pulled in next. */
  atRisk?: AtRiskService[];
  /** True when most services went silent at once: a monitoring/collector outage, not a fault in the services. */
  monitoringGap?: boolean;
}
