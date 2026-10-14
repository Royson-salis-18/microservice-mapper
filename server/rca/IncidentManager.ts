import type { Incident, IncidentStatus, IncidentSeverity } from '../models/Incident.js';
import type { GraphStore } from '../graph/GraphStore.js';
import { AnomalyDetector } from '../../algorithms/detection/AnomalyDetector.js';
import { RCAEngine } from '../../algorithms/rca/RCAEngine.js';
import { LearnedScorer, FEATURE_LABEL } from './LearnedScorer.js';
import { TargetModels } from './TargetModels.js';
import { loadThresholds } from './thresholdsStore.js';

export class IncidentManager {
  private activeIncidents: Map<string, Incident> = new Map(); // targetId -> Incident
  private anomalyDetector: AnomalyDetector;
  private rcaEngine: RCAEngine;
  private learned = new LearnedScorer();
  /** One model per architecture, trained on its own baseline at every start (call models.start() once the server is up). */
  public readonly models: TargetModels;
  /** Per target: was the learned model above its threshold last cycle (alarms need two cycles in a row). */
  private learnedHot = new Map<string, boolean>();

  constructor(private graphStore: GraphStore) {
    this.anomalyDetector = new AnomalyDetector(graphStore.metricStore, loadThresholds);
    this.rcaEngine = new RCAEngine();
    this.models = new TargetModels(graphStore, this.learned);
  }

  public evaluateTarget(targetId: string): Incident | null {
    const { nodes, edges } = this.graphStore.getGraph();
    const targetNodes = nodes.filter(n => n.project === targetId);
    const targetEdges = edges.filter(e => e.id.startsWith(targetId) || targetNodes.some(n => n.id === e.source));

    const t = loadThresholds();
    // 1. Detect Anomaly Records for Target
    const anomalies = this.anomalyDetector.detectAnomaliesForTarget(targetId, targetNodes);

    // 2. Execute RCA Analysis
    const open = this.activeIncidents.get(targetId);
    const hostStatus = String((this.graphStore as any).targets?.get?.(targetId)?.status ?? 'LIVE');
    const hostSilent = hostStatus === 'STALE' || hostStatus === 'OFFLINE';
    const model = this.models.get(targetId);
    const learning = model.state === 'learning' ? { haveSec: model.baselineSec, needSec: model.needSec } : undefined;
    const scored = hostSilent || learning ? null : this.learned.score(targetNodes, targetEdges, (id) => this.graphStore.metricStore.getHistory(id, '15m'), model.threshold);
    let learned: any;
    if (scored) {
      const hot = scored.maxP >= scored.threshold;
      learned = { p: scored.p, why: scored.why, threshold: scored.threshold, labels: FEATURE_LABEL, alarm: hot && (this.learnedHot.get(targetId) ?? false) };
      this.learnedHot.set(targetId, hot);
    }
    const rcaResult = this.rcaEngine.analyzeIncident({
      learning,
      learned,
      hostSilent,
      incumbent: open && open.status !== 'RESOLVED' ? open.rootCauseServiceId : null,
      targetId,
      nodes: targetNodes,
      edges: targetEdges,
      anomalies,
      thresholds: t,
    });

    const existing = this.activeIncidents.get(targetId);
    const now = new Date().toISOString();
    this.models.noteIncident(targetId, rcaResult.incidentDetected);

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
      // A service nothing depends on and that depends on nothing: a real failure, but with no blast radius.
      const rootId = rcaResult.primaryRootCause?.serviceId;
      if (severity === 'HIGH' && rootId && !targetEdges.some(e => e.source === rootId || e.target === rootId)) severity = 'MEDIUM';
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
      existing.explanation = this.withRemediation(rcaResult.explanation, primaryRC?.serviceId, targetNodes, !!rcaResult.monitoringGap);
      existing.remediationGuide = existing.explanation.recommendedInvestigation;
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
      explanation: this.withRemediation(rcaResult.explanation, primaryRC?.serviceId, targetNodes, !!rcaResult.monitoringGap),
      remediationGuide: [],
      atRisk: rcaResult.atRisk,
      monitoringGap: rcaResult.monitoringGap,
    };

    newIncident.remediationGuide = newIncident.explanation.recommendedInvestigation;
    this.activeIncidents.set(targetId, newIncident);
    return newIncident;
  }

  /**
   * What to type, based on what is actually wrong. The old guide was always `docker start docker-compose-<name>-1`,
   * a container name that only existed on one host and the wrong command for a paused or running container.
   */
  /** One list of steps: the concrete command for what is actually wrong first, then the explanation's own checks.
   *  The incident's remediation guide is exactly this list, so the panel and the report never disagree. */
  private withRemediation(explanation: any, serviceId: string | undefined, nodes: any[], monitoringGap: boolean) {
    const steps = [...this.remediation(serviceId, nodes, monitoringGap), ...(explanation.recommendedInvestigation ?? [])];
    return { ...explanation, recommendedInvestigation: [...new Set(steps)] };
  }

  private remediation(serviceId: string | undefined, nodes: any[], monitoringGap: boolean): string[] {
    if (monitoringGap) return ['Check the SSH session / collector on the host', 'docker ps', 'docker stats --no-stream'];
    const n = nodes.find(x => x.id === serviceId);
    if (!n) return [];
    const container = n.metadata?.containerName || n.metadata?.containerId?.slice(0, 12) || n.name;
    const state = String(n.metadata?.state ?? '');
    if (n.metadata?.networkDetached) return [`docker inspect --format '{{json .NetworkSettings.Networks}}' ${container}`, `docker network connect <project>_default ${container}`];
    if (state === 'paused') return [`docker unpause ${container}`, `docker logs --tail 100 ${container}`];
    if (state === 'exited' || state === 'dead' || n.metadata?.vanished) return [`docker logs --tail 100 ${container}`, `docker restart ${container}`];
    if (state === 'restarting') return [`docker logs --tail 200 ${container}`, `docker inspect --format '{{.State.ExitCode}} {{.State.Error}}' ${container}`];
    return [`docker logs --tail 100 ${container}`, `docker stats --no-stream ${container}`];
  }

  /** Drop incidents (and the detector's onset memory) for one target, or for all. */
  public clear(targetId?: string): void {
    if (targetId) this.activeIncidents.delete(targetId); else this.activeIncidents.clear();
    this.models.clear(targetId);
    this.anomalyDetector.forget(targetId);
  }

  public getIncidentForTarget(targetId: string): Incident | null {
    return this.activeIncidents.get(targetId) || null;
  }

  public getAllActiveIncidents(): Incident[] {
    return Array.from(this.activeIncidents.values());
  }
}
