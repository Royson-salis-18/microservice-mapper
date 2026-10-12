import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { AnomalyRecord, AtRiskService, CandidateCause, EvidenceItem, PropagationStep, RCAConfidence, ScoreContribution } from '../models/Incident.js';
import { TemporalAnalyzer } from './TemporalAnalyzer.js';
import { ExplanationEngine } from './ExplanationEngine.js';
import { DEFAULT_THRESHOLDS, type IncidentThresholds } from './thresholds.js';

export interface RCAParameters {
  targetId: string;
  nodes: ServiceNode[];
  edges: DependencyEdge[];
  anomalies: AnomalyRecord[];
  thresholds?: IncidentThresholds;
}

/**
 * Root-cause ranking, ported from the rca-lab research method (new-repo/core/rca.py, measured on 751 labelled faults):
 *
 *   own(s)        strongest evidence about the service ITSELF   (cpu, memory, silence; noise-normalised z)
 *   symptoms(s)   strongest evidence that can be INHERITED       (latency, errors, traffic drop, network)
 *   explained(s)  gamma x the strongest evidence of any service it CALLS (a broken dependency explains its callers)
 *   score(s)      max(own, symptoms - explained)  + 100 if the container is stopped / paused / crash-looping (a fact)
 *
 * Failures travel callee -> caller, so a caller whose errors are explained by a broken callee falls down the list.
 * A service with no data whose callers have unexplained symptoms is inferred (blind spot). If most services go silent
 * together, that is reported as a monitoring outage instead of blaming anyone.
 *
 * Measured, so it is stated honestly: on the research bench the explain-away step was not better than "most abnormal",
 * the scoring (silence, noise normalisation) is what mattered. gamma = 0 in the thresholds gives plain "most abnormal".
 */
export class RCAEngine {
  private temporalAnalyzer = new TemporalAnalyzer();
  private explanationEngine = new ExplanationEngine();

  public analyzeIncident(params: RCAParameters) {
    const { targetId, nodes, edges, anomalies } = params;
    const t = params.thresholds ?? DEFAULT_THRESHOLDS;

    const targetNodes = nodes.filter(n => n.project === targetId);
    const ids = new Set(targetNodes.map(n => n.id));
    const targetEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
    const targetAnomalies = anomalies.filter(a => a.targetId === targetId);
    const byNode = new Map<string, AnomalyRecord[]>();
    for (const a of targetAnomalies) byNode.set(a.nodeId, [...(byNode.get(a.nodeId) ?? []), a]);

    const zOf = (a: AnomalyRecord) => a.zScore !== null && Number.isFinite(a.zScore) ? Math.abs(a.zScore)
      : a.severity === 'CRITICAL' ? t.zScoreCritical : a.severity === 'HIGH' ? t.zScoreHigh : t.zScoreAnomaly;
    const kindOf = (a: AnomalyRecord) => a.evidence ?? (a.metric === 'container-health' ? 'hard' : 'own');
    const state = (n: ServiceNode) => String(n.metadata?.state ?? '');
    // A FACT about the container (stopped, paused, crash-looping, vanished). A 'critical' status on a container that is
    // still running is not a fact about it, so it counts as a strong symptom instead (it can be inherited).
    const isHard = (n: ServiceNode) => ['exited', 'dead', 'paused', 'restarting'].includes(state(n)) || !!n.metadata?.vanished
      || (byNode.get(n.id) ?? []).some(a => kindOf(a) === 'hard' && a.reason !== 'container-exited-or-critical')
      || (n.status === 'critical' && !state(n));

    // Datastores and queues answer calls; they do not make them. Edges inferred from TCP connections are seen from both
    // ends (cart -> cart-store AND cart-store -> cart), so an edge whose caller is a datastore is the reverse view of a
    // real call and is ignored for attribution and cascade risk (measured live: cart-store was listed as "at risk").
    const STORE = /(^|[-_])(db|store|cache|redis|memcached|mongo|mongodb|postgres|mysql|queue|bus|kafka|nats|rabbitmq)([-_]|$)/i;
    const isStore = (id: string) => { const n = targetNodes.find(x => x.id === id); return !!n && (n.type === 'database' || n.type === 'queue' || STORE.test(n.name)); };
    const callees = new Map<string, string[]>(), callers = new Map<string, string[]>();
    for (const e of targetEdges) {
      if (isStore(e.source) && !isStore(e.target)) continue;
      callees.set(e.source, [...(callees.get(e.source) ?? []), e.target]);
      callers.set(e.target, [...(callers.get(e.target) ?? []), e.source]);
    }

    // ---- per-service evidence
    const own = new Map<string, number>(), sym = new Map<string, number>(), hard = new Map<string, boolean>();
    for (const n of targetNodes) {
      const recs = byNode.get(n.id) ?? [];
      let o = Math.max(0, ...recs.filter(a => kindOf(a) === 'own').map(zOf));
      if (n.status === 'degraded') o = Math.max(o, t.zScoreAnomaly);            // collector saw CPU/memory above 80%
      own.set(n.id, o);
      hard.set(n.id, isHard(n));
      let sv = Math.max(0, ...recs.filter(a => kindOf(a) === 'symptom').map(zOf));
      if (n.status === 'critical' && !hard.get(n.id)) sv = Math.max(sv, t.zScoreCritical);
      sym.set(n.id, sv);
    }
    // Quiet is inherited: my silence is not my own fault if a service I call broke loudly (my requests fail fast).
    for (const n of targetNodes) {
      const silent = (byNode.get(n.id) ?? []).find(a => a.metric === 'silence');
      if (!silent) continue;
      const loudCallee = (callees.get(n.id) ?? []).some(c => hard.get(c) || (sym.get(c) ?? 0) >= t.zScoreAnomaly);
      if (loudCallee) {
        const others = (byNode.get(n.id) ?? []).filter(a => kindOf(a) === 'own' && a.metric !== 'silence').map(zOf);
        own.set(n.id, Math.max(0, ...others));
        sym.set(n.id, Math.max(sym.get(n.id) ?? 0, zOf(silent)));
      }
    }
    const evidence = (id: string) => (hard.get(id) ? 50 : Math.max(own.get(id) ?? 0, sym.get(id) ?? 0));

    // ---- monitoring outage: most services silent or vanished together
    const quietIds = targetNodes.filter(n => n.metadata?.vanished || (byNode.get(n.id) ?? []).some(a => a.metric === 'silence')).map(n => n.id);
    const monitoringGap = targetNodes.length >= 3 && quietIds.length >= Math.max(3, Math.ceil(t.monitoringGapShare * targetNodes.length));

    const nothing = targetAnomalies.length === 0 && !targetNodes.some(n => hard.get(n.id) || n.status === 'degraded');
    if (nothing || monitoringGap) {
      const explanation = this.explanationEngine.generateExplanation({
        targetId, incidentStartedAt: new Date().toISOString(), primaryRootCause: null, alternativeCandidates: [],
        affectedServices: [], propagationPath: [], evidence: [], confidence: 'UNKNOWN',
      });
      if (monitoringGap) {
        explanation.whatHappened = `${quietIds.length} of ${targetNodes.length} services stopped reporting at the same moment.`;
        explanation.likelyRootCause = 'Monitoring outage (collector, SSH session or Docker daemon), not a fault in the services.';
        explanation.why = 'Independent services do not all freeze in the same few seconds; a broken telemetry path does. No service is blamed.';
        explanation.recommendedInvestigation = ['Check the SSH connection and the remote collector log', 'Run `docker ps` and `docker stats --no-stream` on the host'];
      }
      return { incidentDetected: monitoringGap, primaryRootCause: null, candidateCauses: [] as CandidateCause[], propagation: [] as PropagationStep[],
        affectedServices: monitoringGap ? targetNodes.filter(n => quietIds.includes(n.id)).map(n => n.name) : [],
        evidence: [] as EvidenceItem[], confidence: 'UNKNOWN' as RCAConfidence, explanation, atRisk: [] as AtRiskService[], monitoringGap };
    }

    // ---- attribution
    const timeline = this.temporalAnalyzer.buildTimeline(targetAnomalies);
    const raw = new Map<string, number>(), parts = new Map<string, { o: number; s: number; x: number; blind: boolean }>();
    for (const n of targetNodes) {
      const o = own.get(n.id) ?? 0, s = sym.get(n.id) ?? 0;
      const x = t.explainAwayGamma * Math.max(0, ...(callees.get(n.id) ?? []).map(evidence));
      let score = Math.max(o, Math.max(0, s - x)) + (hard.get(n.id) ? 100 : 0);
      parts.set(n.id, { o, s, x, blind: false });
      raw.set(n.id, score);
    }
    // blind spot: no telemetry at all, but its callers have symptoms nothing else explains
    for (const n of targetNodes) {
      const noData = !n.metrics || Object.values(n.metrics).every(v => v === undefined || v === null);
      if (!noData || (raw.get(n.id) ?? 0) > 0) continue;
      const ups = (callers.get(n.id) ?? []).map(c => Math.max(0, (sym.get(c) ?? 0) - (parts.get(c)?.x ?? 0)));
      const guess = 0.9 * Math.max(0, ...ups);
      if (guess > 0) { raw.set(n.id, guess); parts.set(n.id, { ...(parts.get(n.id)!), blind: true }); }
    }

    const affected = targetNodes.filter(n => (raw.get(n.id) ?? 0) > 0 || (sym.get(n.id) ?? 0) > 0);
    const ranked = [...affected].sort((a, b) => (raw.get(b.id)! - raw.get(a.id)!) || a.name.localeCompare(b.name));
    const top = ranked[0], second = ranked[1];
    const rawTop = top ? raw.get(top.id)! : 0, rawSecond = second ? raw.get(second.id)! : 0;
    const margin = rawTop > 0 ? 1 - rawSecond / rawTop : 0;
    const to01 = (r: number) => (r >= 100 ? Math.min(1, 0.9 + (r - 100) / 500) : Math.min(0.89, r / (r + 2 * t.zScoreAnomaly)));

    const candidates: CandidateCause[] = [];
    const evidenceItems: EvidenceItem[] = [];
    for (const n of ranked) {
      const p = parts.get(n.id)!, r = raw.get(n.id)!;
      const recs = byNode.get(n.id) ?? [];
      const breakdown: ScoreContribution[] = [];
      if (hard.get(n.id)) breakdown.push({ factor: 'hard_evidence', score: 100, reason: `container ${state(n) || n.status}${n.metadata?.vanished ? ' (vanished while the other containers still report)' : ''}: a fact, not a degree` });
      if (p.o > 0) breakdown.push({ factor: 'own_evidence', score: round(p.o), reason: `its own signals are ${round(p.o)}x their normal wobble (${recs.filter(a => kindOf(a) === 'own').map(a => a.metric).join(', ') || 'resource pressure'})` });
      if (p.s > 0) breakdown.push({ factor: 'symptoms', score: round(p.s), reason: `errors / latency / traffic ${round(p.s)}x normal (${recs.filter(a => kindOf(a) === 'symptom').map(a => a.metric).join(', ')})` });
      if (p.x > 0 && p.s > 0) breakdown.push({ factor: 'likely_victim', score: -round(Math.min(p.x, p.s)), reason: `a service it calls is broken and explains ${round(Math.min(p.x, p.s))} of those symptoms` });
      if (p.blind) breakdown.push({ factor: 'blind_spot', score: round(r), reason: 'no telemetry from it, while the services calling it show errors nothing else explains' });
      const isTop = n.id === top.id;
      let confidence: RCAConfidence = 'LOW';
      if (isTop) {
        const hardCount = ranked.filter(x => hard.get(x.id)).length;
        const observed = targetEdges.some(e => (e.source === n.id || e.target === n.id) && e.observed);
        if ((hard.get(n.id) && hardCount === 1) || (margin >= 0.5 && observed)) confidence = 'HIGH';
        else if (margin >= 0.2) confidence = 'MEDIUM';
      } else if (r < 0.5 * rawTop) confidence = 'UNKNOWN';
      candidates.push({
        serviceId: n.id, serviceName: n.name, score: round(to01(r)), confidence, scoreBreakdown: breakdown,
        earliestAnomalyTimestamp: recs.map(a => a.timestamp).sort()[0],
        primaryAnomalyMetric: [...recs].sort((a, b) => zOf(b) - zOf(a))[0]?.metric ?? (hard.get(n.id) ? 'container-state' : 'inferred'),
        own: round(p.o), symptoms: round(p.s), explained: round(p.x),
      });
      const strongest = [...recs].sort((a, b) => zOf(b) - zOf(a))[0];
      evidenceItems.push({
        id: `ev-${n.id}-${Date.now()}`,
        metric: strongest?.metric ?? 'container-state',
        timestamp: strongest?.timestamp ?? new Date().toISOString(),
        beforeValue: strongest ? `${strongest.baselineMean}` : 'running',
        afterValue: strongest ? `${strongest.observedValue}` : `${n.status} (${state(n) || 'unknown'})`,
        source: strongest?.evidenceSource ?? 'container-runtime',
        description: strongest
          ? `'${n.name}': ${strongest.metric} at ${strongest.observedValue} vs usual ${strongest.baselineMean}${strongest.zScore !== null ? ` (z ${strongest.zScore})` : ''} — ${strongest.reason}`
          : `'${n.name}': ${n.status} (${state(n) || 'no state'})`,
      });
    }

    const primaryRootCause = candidates[0] ?? null;
    const overallConfidence = primaryRootCause?.confidence ?? 'UNKNOWN';

    // ---- propagation: from the root to its callers (failures travel callee -> caller), over the corrected caller graph
    // (reverse TCP views and datastore->service edges removed), at most 3 hops
    const propagationPath: string[] = [], propagationSteps: PropagationStep[] = [];
    if (primaryRootCause) {
      propagationPath.push(primaryRootCause.serviceName);
      let frontier = [primaryRootCause.serviceId];
      const visited = new Set(frontier);
      for (let hop = 0; hop < 3 && frontier.length; hop++) {
        const next: string[] = [];
        for (const curr of frontier) {
          for (const callerId of callers.get(curr) ?? []) {
            if (visited.has(callerId)) continue;
            visited.add(callerId);
            const caller = targetNodes.find(x => x.id === callerId);
            const e = targetEdges.find(x => x.source === callerId && x.target === curr);
            if (!caller || !e) continue;
            propagationPath.push(caller.name);
            next.push(caller.id);
            propagationSteps.push({
              sourceId: curr, targetId: caller.id,
              timestamp: (byNode.get(caller.id) ?? []).map(a => a.timestamp).sort()[0],
              edgeId: e.id, evidenceSource: e.observed ? 'network-tcp' : 'compose-declarative',
              metricChange: (sym.get(caller.id) ?? 0) > 0 ? `symptoms ${round(sym.get(caller.id)!)}x normal` : `status ${caller.status}`,
              confidence: e.observed ? 'HIGH' : 'MEDIUM',
            });
          }
        }
        frontier = next;
      }
    }

    // ---- cascade risk: healthy services calling broken ones (noisy-OR; research core/cascade.py risk())
    const failing = new Set(ranked.filter(n => hard.get(n.id) || (raw.get(n.id) ?? 0) >= t.zScoreAnomaly).map(n => n.id));
    const atRisk: AtRiskService[] = [];
    for (const n of targetNodes) {
      if (failing.has(n.id)) continue;
      const via = (callees.get(n.id) ?? []).filter(c => failing.has(c));
      if (!via.length) continue;
      const risk = 1 - via.reduce((acc, c) => acc * (1 - Math.min(1, evidence(c) / (2 * t.zScoreAnomaly)) * t.cascadeEdgeProbability), 1);
      atRisk.push({ serviceId: n.id, serviceName: n.name, risk: round(risk), via: via.map(c => targetNodes.find(x => x.id === c)?.name ?? c) });
    }
    atRisk.sort((a, b) => b.risk - a.risk);

    const affectedServices = affected.map(n => n.name);
    const explanation = this.explanationEngine.generateExplanation({
      targetId, incidentStartedAt: timeline[0]?.timestamp ?? new Date().toISOString(), primaryRootCause,
      alternativeCandidates: candidates, affectedServices, propagationPath, evidence: evidenceItems, confidence: overallConfidence,
    });
    if (primaryRootCause) {
      const p = parts.get(primaryRootCause.serviceId)!;
      explanation.why = hard.get(primaryRootCause.serviceId)
        ? `${primaryRootCause.serviceName} is ${state(targetNodes.find(n => n.id === primaryRootCause.serviceId)!) || 'down'}: hard evidence. Its callers' errors are explained by it.`
        : p.blind ? `${primaryRootCause.serviceName} sends no telemetry while the services calling it fail with nothing else to explain it.`
          : `${primaryRootCause.serviceName} has the strongest evidence that is not explained by anything it depends on (own ${round(p.o)}, unexplained symptoms ${round(Math.max(0, p.s - p.x))}).`;
      if (atRisk.length) explanation.recommendedInvestigation = [...explanation.recommendedInvestigation, `Watch next: ${atRisk.slice(0, 3).map(a => `${a.serviceName} (${Math.round(a.risk * 100)}%)`).join(', ')}`];
    }

    return { incidentDetected: true, primaryRootCause, candidateCauses: candidates, propagation: propagationSteps, affectedServices,
      evidence: evidenceItems, confidence: overallConfidence, explanation, atRisk, monitoringGap: false };
  }
}

function round(x: number) { return Math.round(x * 100) / 100; }
