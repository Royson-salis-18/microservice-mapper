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
    const earliestNodeId = this.temporalAnalyzer.findEarliestAnomalousNode(targetAnomalies);

    // Compute candidate root cause scores
    const candidates: CandidateCause[] = [];
    const evidenceItems: EvidenceItem[] = [];

    for (const node of failingNodes) {
      const breakdown: ScoreContribution[] = [];
      let totalScore = 0;

      // 1. Temporal Precedence Factor (+0.30 if earliest anomalous node)
      if (node.id === earliestNodeId) {
        breakdown.push({ factor: 'temporal_precedence', score: 0.30, reason: '+0.30 temporal precedence (earliest detected anomaly)' });
        totalScore += 0.30;
      } else {
        const nodeAnomaly = targetAnomalies.find(a => a.nodeId === node.id);
        if (nodeAnomaly) {
          breakdown.push({ factor: 'anomaly_presence', score: 0.10, reason: '+0.10 metric anomaly detected' });
          totalScore += 0.10;
        }
      }

      // 2. Health & Container Exit Status Factor (+0.35 if container exited/critical)
      if (node.status === 'critical' || node.metadata?.state === 'exited') {
        breakdown.push({ factor: 'critical_status', score: 0.35, reason: '+0.35 container process exited/critical status' });
        totalScore += 0.35;
      } else if (node.status === 'degraded') {
        breakdown.push({ factor: 'degraded_status', score: 0.15, reason: '+0.15 degraded resource utilization' });
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

      // 4. Downstream Impact / Blast Radius Factor (+0.15 if downstream dependencies failing)
      const downstreamEdges = targetEdges.filter(e => e.source === node.id);
      const failingDownstreams = downstreamEdges.filter(e => {
        const tgt = targetNodes.find(n => n.id === e.target);
        return tgt && (tgt.status === 'critical' || tgt.status === 'degraded');
      });
      if (failingDownstreams.length > 0) {
        breakdown.push({ factor: 'downstream_correlation', score: 0.15, reason: `+0.15 downstream failure correlation (${failingDownstreams.length} downstream nodes failing)` });
        totalScore += 0.15;
      }

      // Normalize score between 0.0 and 1.0
      const finalScore = Math.min(Math.round(totalScore * 100) / 100, 1.0);

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
        beforeValue: 'healthy (Up)',
        afterValue: `${node.status} (${node.metadata?.state || 'stopped'})`,
        source: hasObservedEdge ? 'observed-runtime-tcp' : 'container-runtime',
        description: `Service '${node.name}' status changed to ${node.status.toUpperCase()} (CPU: ${node.metrics?.cpu || 0}%, MEM: ${node.metrics?.memoryPercent || 0}%)`
      });
    }

    // Sort candidate root causes by score descending
    candidates.sort((a, b) => b.score - a.score);

    const primaryRootCause = candidates.length > 0 ? candidates[0] : null;
    const overallConfidence = primaryRootCause ? primaryRootCause.confidence : 'UNKNOWN';

    // Compute propagation path (directed graph from root cause downwards)
    const propagationPath: string[] = [];
    const propagationSteps: PropagationStep[] = [];

    if (primaryRootCause) {
      propagationPath.push(primaryRootCause.serviceName);
      const queue = [primaryRootCause.serviceId];
      const visited = new Set<string>([primaryRootCause.serviceId]);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const outEdges = targetEdges.filter(e => e.source === curr);

        for (const edge of outEdges) {
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            const tgtNode = targetNodes.find(n => n.id === edge.target);
            if (tgtNode) {
              propagationPath.push(tgtNode.name);
              queue.push(tgtNode.id);
              propagationSteps.push({
                sourceId: curr,
                targetId: tgtNode.id,
                timestamp: new Date().toISOString(),
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
