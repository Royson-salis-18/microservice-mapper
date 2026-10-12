import type { Incident, IncidentStatus, IncidentSeverity } from '../models/Incident.js';
import type { GraphStore } from '../graph/GraphStore.js';
import { AnomalyDetector } from './AnomalyDetector.js';
import { RCAEngine } from './RCAEngine.js';
import { loadThresholds } from './thresholds.js';

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

    const t = loadThresholds();
    // 1. Detect Anomaly Records for Target
    const anomalies = this.anomalyDetector.detectAnomaliesForTarget(targetId, targetNodes);

    // 2. Execute RCA Analysis
    const rcaResult = this.rcaEngine.analyzeIncident({
      targetId,
      nodes: targetNodes,
      edges: targetEdges,
      anomalies,
      thresholds: t,
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

    if (rcaResult.monitoringGap) {
      severity = 'MEDIUM';
      status = 'DEGRADED';
    } else if (criticalCount > 0) {
      severity = criticalCount > t.criticalServicesForCritical ? 'CRITICAL' : 'HIGH';
      status = 'INCIDENT';
    } else if (degradedCount > 0) {
      severity = 'MEDIUM';
      status = 'DEGRADED';
    } else if (anomalies.some(a => a.severity === 'CRITICAL')) {
      severity = 'HIGH';
      status = 'INCIDENT';
    } else if (anomalies.some(a => a.severity === 'HIGH')) {
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
      existing.remediationGuide = this.remediation(primaryRC?.serviceId, targetNodes, !!rcaResult.monitoringGap);
      existing.atRisk = rcaResult.atRisk;
      existing.monitoringGap = rcaResult.monitoringGap;
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
      remediationGuide: this.remediation(primaryRC?.serviceId, targetNodes, !!rcaResult.monitoringGap),
      atRisk: rcaResult.atRisk,
      monitoringGap: rcaResult.monitoringGap,
    };

    this.activeIncidents.set(targetId, newIncident);
    return newIncident;
  }

  /**
   * What to type, based on what is actually wrong. The old guide was always `docker start docker-compose-<name>-1`,
   * a container name that only existed on one host and the wrong command for a paused or running container.
   */
  private remediation(serviceId: string | undefined, nodes: any[], monitoringGap: boolean): string[] {
    if (monitoringGap) return ['Check the SSH session / collector on the host', 'docker ps', 'docker stats --no-stream'];
    const n = nodes.find(x => x.id === serviceId);
    if (!n) return [];
    const container = n.metadata?.containerName || n.metadata?.containerId?.slice(0, 12) || n.name;
    const state = String(n.metadata?.state ?? '');
    if (state === 'paused') return [`docker unpause ${container}`, `docker logs --tail 100 ${container}`];
    if (state === 'exited' || state === 'dead' || n.metadata?.vanished) return [`docker logs --tail 100 ${container}`, `docker start ${container}`];
    if (state === 'restarting') return [`docker logs --tail 200 ${container}`, `docker inspect --format '{{.State.ExitCode}} {{.State.Error}}' ${container}`];
    return [`docker logs --tail 100 ${container}`, `docker stats --no-stream ${container}`];
  }

  public getIncidentForTarget(targetId: string): Incident | null {
    return this.activeIncidents.get(targetId) || null;
  }

  public getAllActiveIncidents(): Incident[] {
    return Array.from(this.activeIncidents.values());
  }
}
