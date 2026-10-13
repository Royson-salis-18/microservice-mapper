import type { Incident, IncidentStatus, IncidentSeverity, RCAExplanation } from '../models/Incident.js';
import type { GraphStore } from '../graph/GraphStore.js';
import { AnomalyDetector } from './AnomalyDetector.js';
import { RCAEngine } from './RCAEngine.js';
import { loadThresholds } from './thresholds.js';

/**
 * What to do about an incident: the investigation steps the explanation
 * derived from the evidence. This used to be a fixed
 * `docker start docker-compose-<name>-1` for every incident whatever its
 * cause, so a running service with a memory spike was told to start a
 * container that was already running, under a name that need not exist.
 */
function remediationFor(explanation: RCAExplanation): string[] {
  return [...explanation.recommendedInvestigation];
}

export class IncidentManager {
  private activeIncidents: Map<string, Incident> = new Map(); // targetId -> Incident
  private anomalyDetector: AnomalyDetector;
  private rcaEngine: RCAEngine;

  constructor(private graphStore: GraphStore) {
    this.anomalyDetector = new AnomalyDetector(graphStore.metricStore);
    this.rcaEngine = new RCAEngine();
  }

  public evaluateTarget(targetId: string): Incident | null {
    const { nodes, edges } = this.graphStore.getGraph();
    const targetNodes = nodes.filter(n => n.project === targetId);
    const targetEdges = edges.filter(e => e.id.startsWith(targetId) || targetNodes.some(n => n.id === e.source));

    // 1. Detect Anomaly Records for Target
    const anomalies = this.anomalyDetector.detectAnomaliesForTarget(targetId, targetNodes);

    // 2. Execute RCA Analysis
    const rcaResult = this.rcaEngine.analyzeIncident({
      targetId,
      nodes: targetNodes,
      edges: targetEdges,
      anomalies
    });

    const existing = this.activeIncidents.get(targetId);
    const now = new Date().toISOString();

    if (!rcaResult.incidentDetected) {
      if (existing && existing.status !== 'RESOLVED') {
        existing.status = 'RESOLVED';
        existing.endedAt = now;
        return existing;
      }
      return null;
    }

    // Determine Severity
    const criticalCount = targetNodes.filter(n => n.status === 'critical').length;
    const degradedCount = targetNodes.filter(n => n.status === 'degraded').length;

    let severity: IncidentSeverity = 'LOW';
    let status: IncidentStatus = 'DEGRADED';

    const t = loadThresholds();
    if (criticalCount > 0) {
      severity = criticalCount > t.criticalServicesForCritical ? 'CRITICAL' : 'HIGH';
      status = 'INCIDENT';
    } else if (degradedCount > 0) {
      severity = 'MEDIUM';
      status = 'DEGRADED';
    }

    const primaryRC = rcaResult.primaryRootCause;

    if (existing && existing.status !== 'RESOLVED') {
      // Update existing active incident
      existing.status = status;
      existing.severity = severity;
      existing.rootCauseServiceId = primaryRC ? primaryRC.serviceId : null;
      existing.rootCauseScore = primaryRC ? primaryRC.score : 0;
      existing.confidence = rcaResult.confidence;
      existing.anomalies = anomalies;
      existing.propagation = rcaResult.propagation;
      existing.affectedServices = rcaResult.affectedServices;
      existing.candidateCauses = rcaResult.candidateCauses;
      existing.evidence = rcaResult.evidence;
      existing.explanation = rcaResult.explanation;
      existing.remediationGuide = remediationFor(rcaResult.explanation);
      return existing;
    }

    // Create New First-Class Incident
    const incidentId = `inc-${targetId}-${Date.now()}`;
    const newIncident: Incident = {
      id: incidentId,
      targetId,
      startedAt: now,
      detectedAt: now,
      endedAt: null,
      status,
      severity,
      rootCauseServiceId: primaryRC ? primaryRC.serviceId : null,
      rootCauseEdgeId: null,
      rootCauseScore: primaryRC ? primaryRC.score : 0,
      confidence: rcaResult.confidence,
      symptoms: rcaResult.affectedServices.map(s => `Service '${s}' experiencing anomaly/failure`),
      anomalies,
      propagation: rcaResult.propagation,
      affectedServices: rcaResult.affectedServices,
      candidateCauses: rcaResult.candidateCauses,
      evidence: rcaResult.evidence,
      explanation: rcaResult.explanation,
      remediationGuide: remediationFor(rcaResult.explanation)
    };

    this.activeIncidents.set(targetId, newIncident);
    return newIncident;
  }

  public getIncidentForTarget(targetId: string): Incident | null {
    return this.activeIncidents.get(targetId) || null;
  }

  public getAllActiveIncidents(): Incident[] {
    return Array.from(this.activeIncidents.values());
  }
}
