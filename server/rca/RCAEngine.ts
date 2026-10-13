import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { AnomalyRecord, CandidateCause, EvidenceItem, PropagationStep, RCAConfidence, ScoreContribution } from '../models/Incident.js';
import { TemporalAnalyzer } from './TemporalAnalyzer.js';
import { ExplanationEngine } from './ExplanationEngine.js';
import { computeEdgeWeights } from '../graph/EdgeWeights.js';

/** Largest contribution of the explanatory-coverage factor. */
export const EXPLAINS_WEIGHT = 0.25;
/** Largest deduction for a candidate whose own dependencies are failing. */
export const VICTIM_WEIGHT = 0.25;
/**
 * Dependency-path strength below which a candidate is not said to explain
 * another failure. Telemetry links are weighted at a tenth, so without this a
 * dashboard that one proxy forwards to was credited with "explaining" seven
 * failing services through paths of strength 0.004, and the independent-
 * failure rule (which asked for coverage of exactly zero) never fired.
 */
export const MATERIAL_REACH = 0.1;

/**
 * Strongest dependency path from every service up to `rootId`, as the product
 * of edge weights along it (1 = rootId itself).
 *
 * Edges read "caller -> callee", so a service depends on `rootId` if there is
 * a chain of calls from it down to `rootId`. The strength of that chain is how
 * much of a failure at `rootId` would plausibly reach it. Max-product path,
 * solved by relaxation — graphs here are tens of nodes, so this is trivial.
 */
export function dependencyReach(rootId: string, edges: DependencyEdge[], weightOf: (e: DependencyEdge) => number): Map<string, number> {
  const reach = new Map<string, number>([[rootId, 1]]);
  for (let pass = 0; pass < edges.length + 1; pass++) {
    let changed = false;
    for (const e of edges) {
      const down = reach.get(e.target);
      if (down === undefined) continue;
      const candidate = down * weightOf(e);
      if (candidate > (reach.get(e.source) ?? 0) + 1e-12) {
        reach.set(e.source, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return reach;
}

export interface RCAParameters {
  targetId: string;
  nodes: ServiceNode[];
  edges: DependencyEdge[];
  anomalies: AnomalyRecord[];
}

export class RCAEngine {
  private temporalAnalyzer = new TemporalAnalyzer();
  private explanationEngine = new ExplanationEngine();

  public analyzeIncident(params: RCAParameters) {
    const { targetId, nodes, edges, anomalies } = params;

    // Filter to target nodes & edges
    const targetNodes = nodes.filter(n => n.project === targetId);
    const targetEdges = edges.filter(e => e.id.startsWith(targetId) || targetNodes.some(n => n.id === e.source));
    const targetAnomalies = anomalies.filter(a => a.targetId === targetId);

    const failingNodes = targetNodes.filter(n => n.status === 'critical' || n.status === 'degraded');

    if (failingNodes.length === 0 && targetAnomalies.length === 0) {
      return {
        incidentDetected: false,
        primaryRootCause: null,
        candidateCauses: [],
        propagation: [],
        affectedServices: [],
        evidence: [],
        confidence: 'UNKNOWN' as RCAConfidence,
        explanation: this.explanationEngine.generateExplanation({
          targetId,
          incidentStartedAt: new Date().toISOString(),
          primaryRootCause: null,
          alternativeCandidates: [],
          affectedServices: [],
          propagationPath: [],
          evidence: [],
          confidence: 'UNKNOWN'
        })
      };
    }

    const timeline = this.temporalAnalyzer.buildTimeline(targetAnomalies);
    const earliestNodeIds = this.temporalAnalyzer.findEarliestAnomalousNodes(targetAnomalies);

    // Compute candidate root cause scores
    const candidates: CandidateCause[] = [];
    const evidenceItems: EvidenceItem[] = [];

    // Edge weights say how strongly each caller depends on each callee. Used
    // for explanatory coverage and the victim penalty below; computed here
    // rather than read off the edges because this runs before the risk
    // engine's pass in each poll cycle.
    const weights = computeEdgeWeights(targetEdges);
    const weightOf = (e: DependencyEdge) => weights.get(e.id)?.value ?? 0;
    const failingIds = new Set(failingNodes.map(n => n.id));

    // Candidates are failing services *and* services with a measured anomaly
    // that have not crossed into "degraded". Candidates used to be failing
    // services only, so an incident raised purely on anomalies had nobody to
    // blame and reported root cause "none" with a score of 0.
    const anomalousIds = new Set(targetAnomalies.map(a => a.nodeId));
    const candidateNodes = targetNodes.filter(n => failingIds.has(n.id) || anomalousIds.has(n.id));
    const coverageById = new Map<string, number>();
    const explainedById = new Map<string, number>();

    for (const node of candidateNodes) {
      const breakdown: ScoreContribution[] = [];
      let totalScore = 0;

      // 1. Temporal Precedence Factor (+0.30 if earliest anomalous node)
      if (earliestNodeIds.has(node.id)) {
        breakdown.push({ factor: 'temporal_precedence', score: 0.30, reason: earliestNodeIds.size > 1 ? `+0.30 temporal precedence (earliest anomaly, tied with ${earliestNodeIds.size - 1} other service(s) that began in the same cycle)` : '+0.30 temporal precedence (earliest detected anomaly)' });
        totalScore += 0.30;
      } else {
        const nodeAnomaly = targetAnomalies.find(a => a.nodeId === node.id);
        if (nodeAnomaly) {
          breakdown.push({ factor: 'anomaly_presence', score: 0.10, reason: '+0.10 metric anomaly detected' });
          totalScore += 0.10;
        }
      }

      // 2. Health & Container Exit Status Factor (+0.35 if container exited/critical)
      if (node.status === 'critical' || /^(exited|dead|restarting)/.test(String(node.metadata?.state ?? ''))) {
        const why = node.metadata?.statusReason ? ` — ${node.metadata.statusReason}` : '';
        breakdown.push({ factor: 'critical_status', score: 0.35, reason: `+0.35 container down or crash-looping${why}` });
        totalScore += 0.35;
      } else if (node.status === 'degraded') {
        const why = node.metadata?.statusReason ? ` — ${node.metadata.statusReason}` : '';
        breakdown.push({ factor: 'degraded_status', score: 0.15, reason: `+0.15 degraded${why}` });
        totalScore += 0.15;
      }

      // 3. Observed Dependency Weighting Factor (+0.20 if connected by observed runtime TCP edge)
      const connectedEdges = targetEdges.filter(e => e.source === node.id || e.target === node.id);
      const hasObservedEdge = connectedEdges.some(e => e.observed);
      if (hasObservedEdge) {
        breakdown.push({ factor: 'observed_dependency', score: 0.20, reason: '+0.20 observed runtime TCP/HTTP traffic confirmed' });
        totalScore += 0.20;
      } else if (connectedEdges.some(e => e.declared)) {
        breakdown.push({ factor: 'declared_dependency', score: 0.05, reason: '+0.05 architectural declared dependency inference' });
        totalScore += 0.05;
      }

      // 4. Explanatory coverage (up to +0.25): how much of the *other*
      //    failures this candidate explains.
      //
      // A root cause is the failure the others follow from. So for every
      // other failing service, take the strength of its dependency path down
      // to this candidate — 1.0 if it calls this directly and does nothing
      // else, smaller through weaker or longer chains, 0 if it does not
      // depend on it at all — and average. This replaced a flat +0.15 for
      // "at least one dependent is failing", which scored a database that
      // five failing services lean on the same as one a single service
      // barely touches.
      //
      // Edges read "caller -> callee", and failure travels to callers, so the
      // services explained are the ones whose calls lead *to* this node.
      // Everything else that is showing a symptom — failing or anomalous.
      const others = candidateNodes.filter(n => n.id !== node.id);
      if (others.length > 0) {
        const reach = dependencyReach(node.id, targetEdges, weightOf);
        // Only material paths count, both for the score and for the claim.
        const material = (id: string) => {
          const r = reach.get(id) ?? 0;
          return r >= MATERIAL_REACH ? r : 0;
        };
        const explainedStrength = others.reduce((sum, o) => sum + material(o.id), 0);
        const coverage = explainedStrength / others.length;
        const explainedCount = others.filter(o => material(o.id) > 0).length;
        coverageById.set(node.id, coverage);
        explainedById.set(node.id, explainedCount);
        const points = Math.round(EXPLAINS_WEIGHT * coverage * 100) / 100;
        // A factor is listed only if it moved the score: "+0.00 explains 7
        // of 8" said two contradictory things at once.
        if (points >= 0.01) {
          breakdown.push({
            factor: 'explains_failures',
            score: points,
            reason: `+${points.toFixed(2)} explains ${explainedCount} of ${others.length} other affected service(s): they depend on it (weighted coverage ${Math.round(coverage * 100)}%)`,
          });
          totalScore += points;
        }
      }

      // 5. Victim penalty (up to −0.25): its own dependencies are failing.
      //
      // If a strong dependency of this service is itself failing, this
      // service is more likely downstream of the problem than its origin.
      // The deduction is the weighted share of its dependencies that are down.
      const victimShare = Math.min(
        targetEdges
          .filter(e => e.source === node.id && failingIds.has(e.target))
          .reduce((sum, e) => sum + weightOf(e), 0),
        1,
      );
      if (victimShare > 0) {
        const points = Math.round(VICTIM_WEIGHT * victimShare * 100) / 100;
        const failingDeps = targetEdges
          .filter(e => e.source === node.id && failingIds.has(e.target))
          .map(e => targetNodes.find(n => n.id === e.target)?.name ?? e.target);
        breakdown.push({
          factor: 'dependency_failing',
          score: -points,
          reason: `−${points.toFixed(2)} depends on failing ${failingDeps.join(', ')} (weighted share ${Math.round(victimShare * 100)}%) — likely a victim, not the cause`,
        });
        totalScore -= points;
      }

      // Clamp to 0..1 — the victim penalty can take a weak candidate below zero.
      const finalScore = Math.min(Math.max(Math.round(totalScore * 100) / 100, 0), 1.0);

      // Determine confidence level based on evidence
      let confidence: RCAConfidence = 'LOW';
      if (finalScore >= 0.75 && hasObservedEdge) confidence = 'HIGH';
      else if (finalScore >= 0.50) confidence = 'MEDIUM';
      else if (finalScore >= 0.25) confidence = 'LOW';
      else confidence = 'UNKNOWN';

      candidates.push({
        serviceId: node.id,
        serviceName: node.name,
        score: finalScore,
        confidence,
        scoreBreakdown: breakdown,
        earliestAnomalyTimestamp: targetAnomalies.find(a => a.nodeId === node.id)?.timestamp,
        primaryAnomalyMetric: targetAnomalies.find(a => a.nodeId === node.id)?.metric || 'container-state'
      });

      // Populate Real Telemetry Evidence Items
      evidenceItems.push({
        id: `ev-${node.id}-${Date.now()}`,
        metric: node.metrics?.cpu !== undefined ? 'CPU / Memory / State' : 'Container Status',
        timestamp: new Date().toISOString(),
        beforeValue: 'unknown',
        afterValue: `${node.status} (${node.metadata?.state || 'stopped'})`,
        source: hasObservedEdge ? 'observed-runtime-tcp' : 'container-runtime',
        description: `Service '${node.name}' is ${node.status.toUpperCase()}${node.metadata?.statusReason ? `: ${node.metadata.statusReason}` : ''} (CPU: ${typeof node.metrics?.cpu === 'number' ? `${node.metrics.cpu}%` : 'not measured'}, MEM: ${typeof node.metrics?.memoryPercent === 'number' ? `${node.metrics.memoryPercent}%` : 'not measured'})`
      });
    }

    // Sort candidate root causes by score descending
    candidates.sort((a, b) => b.score - a.score);

    const primaryRootCause = candidates.length > 0 ? candidates[0] : null;

    // Independent problems. When several services are misbehaving and the
    // top candidate explains none of the others through its dependents, there
    // is no single-cause story to tell — two services each running hot on
    // their own is two problems, not one with a root. RCA used to name a root
    // cause regardless (live: grafana at 95% memory named as the cause of
    // opensearch at 84%, with no dependency between them). The ranking stays;
    // the confidence says how much it is worth.
    const symptomatic = candidates.length;
    const primaryExplains = primaryRootCause ? (explainedById.get(primaryRootCause.serviceId) ?? 0) : 0;
    const independent = !!primaryRootCause && symptomatic > 1 && primaryExplains === 0;
    if (independent && primaryRootCause && primaryRootCause.confidence !== 'UNKNOWN') {
      primaryRootCause.confidence = 'LOW';
    }
    const overallConfidence = primaryRootCause ? primaryRootCause.confidence : 'UNKNOWN';

    // Propagation: how the failure reached the services that depend on it.
    //
    // An edge means "source calls target", so the caller depends on the
    // callee and a failure travels *against* the arrow — a failing database
    // breaks the services calling it, then whatever calls those.
    //
    // Only real chains are followed. A dependent joins the path if it is
    // itself showing a symptom, or if it depends on the failing service
    // heavily enough (weight >= 0.5) to be a plausible pass-through; the walk
    // continues only from services that joined. This used to follow every
    // edge of any strength to every service reachable, so one service's memory
    // pressure was reported as having spread across the entire system — a
    // 20-service "propagation path" out of what was a local problem.
    const PASS_THROUGH_WEIGHT = 0.5;
    const MIN_EDGE_WEIGHT = 0.05;
    const propagationPath: string[] = [];
    const propagationSteps: PropagationStep[] = [];
    const symptomaticIds = new Set(candidateNodes.map(n => n.id));

    if (primaryRootCause) {
      propagationPath.push(primaryRootCause.serviceName);
      const queue = [primaryRootCause.serviceId];
      const visited = new Set<string>([primaryRootCause.serviceId]);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const dependentEdges = targetEdges
          .filter(e => e.target === curr && weightOf(e) >= MIN_EDGE_WEIGHT)
          .sort((a, b) => weightOf(b) - weightOf(a));

        for (const edge of dependentEdges) {
          if (visited.has(edge.source)) continue;
          const dependentNode = targetNodes.find(n => n.id === edge.source);
          if (!dependentNode) continue;
          const w = weightOf(edge);
          const showingSymptom = symptomaticIds.has(dependentNode.id);
          if (!showingSymptom && w < PASS_THROUGH_WEIGHT) continue;

          visited.add(edge.source);
          propagationPath.push(dependentNode.name);
          queue.push(dependentNode.id);
          propagationSteps.push({
            sourceId: curr,
            targetId: dependentNode.id,
            timestamp: new Date().toISOString(),
            edgeId: edge.id,
            evidenceSource: edge.observed ? 'network-tcp' : 'compose-declarative',
            metricChange: `Status: ${dependentNode.status}${showingSymptom ? '' : ' (no symptom yet — depends on it heavily)'} · dependency weight ${w.toFixed(2)}`,
            confidence: w >= PASS_THROUGH_WEIGHT ? 'HIGH' : w > 0.15 ? 'MEDIUM' : 'LOW',
          });
        }
      }
    }

    // Services showing a symptom: failing, or with a measured anomaly. This
    // was "anything not healthy", which swept in services whose status is
    // simply unknown — a job that finished cleanly, a service never measured.
    // Ids, like every other service reference in an incident: this used to
    // hold bare names while rootCauseServiceId held an id, so any consumer
    // matching one against the other silently found nothing.
    const affectedServices = candidateNodes.map(n => n.id);
    const incidentStartedAt = timeline.length > 0 ? timeline[0].timestamp : new Date().toISOString();

    const explanation = this.explanationEngine.generateExplanation({
      targetId,
      incidentStartedAt,
      primaryRootCause,
      alternativeCandidates: candidates,
      affectedServices: candidateNodes.map(n => n.name),
      propagationPath,
      evidence: evidenceItems,
      confidence: overallConfidence,
      independent,
      explains: primaryRootCause ? { count: primaryExplains, of: Math.max(0, symptomatic - 1) } : undefined,
    });

    return {
      incidentDetected: true,
      primaryRootCause,
      candidateCauses: candidates,
      propagation: propagationSteps,
      affectedServices,
      evidence: evidenceItems,
      confidence: overallConfidence,
      explanation
    };
  }
}
