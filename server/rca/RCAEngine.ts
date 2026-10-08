import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { AnomalyRecord, CandidateCause, EvidenceItem, PropagationStep, RCAConfidence, ScoreContribution } from '../models/Incident.js';
import { TemporalAnalyzer } from './TemporalAnalyzer.js';
import { ExplanationEngine } from './ExplanationEngine.js';

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

    const isFailing = (n: ServiceNode | undefined) => !!n && (n.status === 'critical' || n.status === 'degraded');
    const anomalousIds = new Set(targetAnomalies.map(a => a.nodeId));
    const isAffected = (n: ServiceNode | undefined) => !!n && (isFailing(n) || anomalousIds.has(n.id));
    // Candidates are every service that is failing OR anomalous. Before, only Docker-status failures were
    // candidates, so an incident raised by metric anomalies on running services had no root cause at all.
    const failingNodes = targetNodes.filter(isAffected);

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
    const earliestNodeId = this.temporalAnalyzer.findEarliestAnomalousNode(targetAnomalies);

    // Compute candidate root cause scores
    const candidates: CandidateCause[] = [];
    const evidenceItems: EvidenceItem[] = [];

    for (const node of failingNodes) {
      const breakdown: ScoreContribution[] = [];
      let totalScore = 0;

      // 1. Temporal Precedence Factor. Weak on purpose (+0.10, was +0.30): calls propagate in milliseconds and
      // samples are seconds apart, so "flagged first" is mostly sampling noise (rca-lab measured it making rankings worse).
      if (node.id === earliestNodeId) {
        breakdown.push({ factor: 'temporal_precedence', score: 0.10, reason: '+0.10 earliest detected anomaly (weak: sampling order)' });
        totalScore += 0.10;
      } else {
        const nodeAnomaly = targetAnomalies.find(a => a.nodeId === node.id);
        if (nodeAnomaly) {
          breakdown.push({ factor: 'anomaly_presence', score: 0.10, reason: '+0.10 metric anomaly detected' });
          totalScore += 0.10;
        }
      }

      // 2. Health & Container Exit Status Factor (+0.35 if container exited/critical)
      if (node.status === 'critical' || ['exited', 'dead', 'paused'].includes(node.metadata?.state as string)) {
        breakdown.push({ factor: 'critical_status', score: 0.35, reason: '+0.35 container process exited/paused/critical status' });
        totalScore += 0.35;
      } else if (node.status === 'degraded') {
        breakdown.push({ factor: 'degraded_status', score: 0.15, reason: '+0.15 degraded resource utilization' });
        totalScore += 0.15;
      }

      // 3. Observed edges. Having traffic is not evidence of being the cause (almost every service has some), so it
      // no longer adds to the score; it only raises confidence in the wiring used below.
      const connectedEdges = targetEdges.filter(e => e.source === node.id || e.target === node.id);
      const hasObservedEdge = connectedEdges.some(e => e.observed);

      // 4. Source or victim? Edges are caller -> callee, and failures travel from callee to caller.
      //    A service whose CALLEE is also failing is most likely a victim of it (penalty).
      //    A service whose CALLERS are failing while its own callees are fine is the likely source (bonus).
      //    The old rule gave +0.15 for a failing callee, which ranked victims above the service that broke.
      const failingCallees = targetEdges.filter(e => e.source === node.id && e.target !== node.id && isAffected(targetNodes.find(n => n.id === e.target)));
      const failingCallers = targetEdges.filter(e => e.target === node.id && e.source !== node.id && isAffected(targetNodes.find(n => n.id === e.source)));
      if (failingCallees.length > 0) {
        breakdown.push({ factor: 'likely_victim', score: -0.25, reason: `-0.25 a service it calls is also failing (${failingCallees.length}); likely a victim of it` });
        totalScore -= 0.25;
      } else if (failingCallers.length > 0) {
        breakdown.push({ factor: 'explains_callers', score: 0.15, reason: `+0.15 its callers are failing (${failingCallers.length}) and none of its own dependencies are` });
        totalScore += 0.15;
      }

      // Normalize score between 0.0 and 1.0
      const finalScore = Math.max(0, Math.min(Math.round(totalScore * 100) / 100, 1.0));

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
        description: `Service '${node.name}' status changed to ${node.status.toUpperCase()} (CPU: ${node.metrics?.cpu || 0}%, MEM: ${node.metrics?.memoryPercent || 0}%)`
      });
    }

    // Sort candidate root causes by score descending
    candidates.sort((a, b) => b.score - a.score);

    const primaryRootCause = candidates.length > 0 ? candidates[0] : null;
    const overallConfidence = primaryRootCause ? primaryRootCause.confidence : 'UNKNOWN';

    // Propagation path: from the root cause to its CALLERS (failures travel callee -> caller), then theirs.
    // The old walk followed calls outward (root -> its dependencies), which drew the path backwards.
    const propagationPath: string[] = [];
    const propagationSteps: PropagationStep[] = [];

    if (primaryRootCause) {
      propagationPath.push(primaryRootCause.serviceName);
      const queue = [primaryRootCause.serviceId];
      const visited = new Set<string>([primaryRootCause.serviceId]);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const inEdges = targetEdges.filter(e => e.target === curr && e.source !== curr);

        for (const edge of inEdges) {
          if (!visited.has(edge.source)) {
            visited.add(edge.source);
            const tgtNode = targetNodes.find(n => n.id === edge.source);
            if (tgtNode) {
              propagationPath.push(tgtNode.name);
              queue.push(tgtNode.id);
              propagationSteps.push({
                sourceId: curr,
                targetId: tgtNode.id,
                timestamp: targetAnomalies.filter(a => a.nodeId === tgtNode.id).map(a => a.timestamp).sort()[0],
                edgeId: edge.id,
                evidenceSource: edge.observed ? 'network-tcp' : 'compose-declarative',
                metricChange: `Status: ${tgtNode.status}`,
                confidence: edge.observed ? 'HIGH' : 'MEDIUM'
              });
            }
          }
        }
      }
    }

    const affectedServices = targetNodes.filter(n => n.status !== 'healthy').map(n => n.name);
    const incidentStartedAt = timeline.length > 0 ? timeline[0].timestamp : new Date().toISOString();

    const explanation = this.explanationEngine.generateExplanation({
      targetId,
      incidentStartedAt,
      primaryRootCause,
      alternativeCandidates: candidates,
      affectedServices,
      propagationPath,
      evidence: evidenceItems,
      confidence: overallConfidence
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
