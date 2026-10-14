import type { CandidateCause, EvidenceItem, RCAConfidence } from '../../models/Incident.js';

export interface ExplanationInput {
  targetId: string;
  incidentStartedAt: string;
  primaryRootCause: CandidateCause | null;
  alternativeCandidates: CandidateCause[];
  affectedServices: string[];
  propagationPath: string[];
  evidence: EvidenceItem[];
  confidence: RCAConfidence;
  /** The top candidate explains none of the other symptomatic services. */
  independent?: boolean;
  /** How many of the other symptomatic services depend materially on the
   *  top candidate, out of how many: what "the others depend on it" rests on. */
  explains?: { count: number; of: number };
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
      confidence,
      independent = false,
      explains,
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
    const factors = new Set(primaryRootCause.scoreBreakdown.map(b => b.factor));

    // Say only what the score actually rests on. This used to open with
    // "showed the earliest anomaly" for every root cause, whether or not
    // temporal precedence was one of its factors.
    const lead = [
      factors.has('critical_status') ? 'is down or crash-looping' : factors.has('degraded_status') ? 'is degraded' : 'shows a metric anomaly',
      factors.has('temporal_precedence') ? 'its problem began first' : null,
      // The count, not a blanket claim: "the other affected services depend
      // on it" was printed even when one of eight did.
      factors.has('explains_failures') && explains && explains.count > 0
        ? (explains.count === explains.of
          ? (explains.of === 1 ? 'the other affected service depends on it' : `all ${explains.of} other affected services depend on it`)
          : `${explains.count} of the ${explains.of} other affected services depend on it`)
        : null,
    ].filter(Boolean).join(', ');

    const explanationText = independent
      ? `Several services are misbehaving, but none of them explains the others through its dependencies - these look like independent problems rather than one cascade. '${cleanRcName}' ranks highest (${(primaryRootCause.score * 100).toFixed(0)}%) but is not shown to cause the rest. Key factors: ${scoreReasons}.`
      : `'${cleanRcName}' ${lead} (score ${(primaryRootCause.score * 100).toFixed(0)}%). Key factors: ${scoreReasons}.`;

    const altList = alternativeCandidates
      .filter(c => c.serviceId !== primaryRootCause.serviceId)
      .map(c => ({
        name: c.serviceName.replace(/^(sock-shop|vertikal)-/, ''),
        score: Math.round(c.score * 100) / 100,
        confidence: c.confidence
      }));

    const recommendations = independent
      ? cleanAffected.map(s => `Investigate '${s}' on its own - nothing measured links it to the others`)
      : [
          factors.has('critical_status')
            ? `Check why '${cleanRcName}' stopped: container logs and exit code (137 usually means it was killed for memory)`
            : `Check resource limits and recent load on '${cleanRcName}'`,
          ...(cleanPropagation.length > 1 ? [`Once '${cleanRcName}' recovers, confirm ${cleanPropagation.slice(1).join(', ')} recover with it`] : []),
          `Open its logs from the service card for the moments around ${new Date(incidentStartedAt).toLocaleTimeString()}`,
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
