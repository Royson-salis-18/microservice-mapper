import type { CandidateCause, EvidenceItem, RCAConfidence } from '../models/Incident.js';

export interface ExplanationInput {
  targetId: string;
  incidentStartedAt: string;
  primaryRootCause: CandidateCause | null;
  alternativeCandidates: CandidateCause[];
  affectedServices: string[];
  propagationPath: string[];
  evidence: EvidenceItem[];
  confidence: RCAConfidence;
}

export class ExplanationEngine {
  public generateExplanation(input: ExplanationInput) {
    const {
      targetId,
      incidentStartedAt,
      primaryRootCause,
      alternativeCandidates,
      affectedServices,
      propagationPath,
      evidence,
      confidence
    } = input;

    if (!primaryRootCause || confidence === 'UNKNOWN') {
      return {
        whatHappened: `Anomalous activity detected in target '${targetId}'.`,
        whenStarted: incidentStartedAt,
        likelyRootCause: 'UNKNOWN',
        why: 'Insufficient runtime telemetry or conflicting evidence. Unable to confirm primary root cause without further runtime metrics.',
        propagationPath: [],
        affectedServices,
        confidence: 'UNKNOWN' as RCAConfidence,
        alternativeCandidates: [],
        evidenceSummary: evidence.map(e => e.description),
        recommendedInvestigation: [
          'Verify container logs and stdout/stderr streams',
          'Ensure network telemetry access logging is enabled',
          'Check system resource allocations and kernel logs'
        ]
      };
    }

    const cleanRcName = primaryRootCause.serviceName.replace(/^(sock-shop|vertikal)-/, '');
    const cleanAffected = affectedServices.map(s => s.replace(/^(sock-shop|vertikal)-/, ''));
    const cleanPropagation = propagationPath.map(s => s.replace(/^(sock-shop|vertikal)-/, ''));

    const scoreReasons = primaryRootCause.scoreBreakdown.map(b => b.reason).join('; ');

    const explanationText = `Service '${cleanRcName}' showed the earliest anomaly and highest causal weight (${(primaryRootCause.score * 100).toFixed(0)}%). Key factors: ${scoreReasons}.`;

    const altList = alternativeCandidates
      .filter(c => c.serviceId !== primaryRootCause.serviceId)
      .map(c => ({
        name: c.serviceName.replace(/^(sock-shop|vertikal)-/, ''),
        score: Math.round(c.score * 100) / 100,
        confidence: c.confidence
      }));

    const recommendations = [
      `Inspect logs for container 'docker-compose-${cleanRcName}-1'`,
      `Verify socket connectivity and resource bounds for '${cleanRcName}'`,
      `If process exited, restart container using: docker start docker-compose-${cleanRcName}-1`
    ];

    return {
      whatHappened: `Incident detected on '${targetId}': ${cleanAffected.length} service(s) affected (${cleanAffected.join(', ')}).`,
      whenStarted: incidentStartedAt,
      likelyRootCause: cleanRcName,
      why: explanationText,
      propagationPath: cleanPropagation,
      affectedServices: cleanAffected,
      confidence,
      alternativeCandidates: altList,
      evidenceSummary: evidence.map(e => `${e.source}: ${e.description} (${e.beforeValue} → ${e.afterValue})`),
      recommendedInvestigation: recommendations
    };
  }
}
