import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import { containerFact } from './containerFacts.js';
import type { AnomalyRecord, AtRiskService, CandidateCause, EvidenceItem, PropagationStep, RCAConfidence, ScoreContribution } from '../models/Incident.js';
import { TemporalAnalyzer } from './TemporalAnalyzer.js';
import { ExplanationEngine } from './ExplanationEngine.js';
import { DEFAULT_THRESHOLDS, type IncidentThresholds } from './thresholds.js';
import { computeEdgeWeights } from '../graph/EdgeWeights.js';

// ---- shared helpers (from the bharath-ui engine; kept for its pipeline tests and callers)
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

/** A metric value as evidence shows it: one decimal, which is what docker reports. */
export const oneDecimal = (v: number): number => Math.round(v * 10) / 10;

/** One sentence for an anomaly: what moved, from where, and by which test. */
export function describeAnomaly(a: AnomalyRecord): string {
  const how = a.evidenceSource === 'dynamic-zscore' ? `, z = ${a.zScore}`
    : a.evidenceSource === 'absolute-threshold' ? ', over the absolute threshold'
    : a.evidenceSource === 'dynamic-baseline' ? ', off a flat baseline'
    : '';
  return `${a.metric} at ${oneDecimal(a.observedValue)} against a baseline of ${oneDecimal(a.baselineMean)} (${a.severity.toLowerCase()}${how})`;
}

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


const INCUMBENT_BONUS = 1.15;

export interface RCAParameters {
  targetId: string;
  nodes: ServiceNode[];
  edges: DependencyEdge[];
  anomalies: AnomalyRecord[];
  thresholds?: IncidentThresholds;
  /** The root cause of the incident already open, if any. Keeps the verdict from flipping between near-equal candidates. */
  incumbent?: string | null;
  /** The host itself stopped sending telemetry (target STALE or OFFLINE): judge nothing on frozen readings, blame no service. */
  hostSilent?: boolean;
  /** The target's model is still learning its baseline: only container facts can raise an incident. */
  learning?: { haveSec: number; needSec: number };
  /** Probabilities from the learned model (tools/ml), when one is installed: they decide whether there is an incident
   *  (alarm, already debounced over two cycles by the caller) and the order of the candidates. */
  learned?: { p: Map<string, number>; why: Map<string, { feature: string; value: number }[]>; alarm: boolean; threshold: number; labels: Record<string, string> };
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
    // While the baseline is still being learned nothing soft is judged: only container facts count.
    const targetAnomalies = anomalies.filter(a => a.targetId === targetId && (!params.learning || (a.evidence ?? (a.metric === 'container-health' ? 'hard' : 'own')) === 'hard'));
    const byNode = new Map<string, AnomalyRecord[]>();
    for (const a of targetAnomalies) byNode.set(a.nodeId, [...(byNode.get(a.nodeId) ?? []), a]);

    const zOf = (a: AnomalyRecord) => a.zScore !== null && Number.isFinite(a.zScore) ? Math.abs(a.zScore)
      : a.severity === 'CRITICAL' ? t.zScoreCritical : a.severity === 'HIGH' ? t.zScoreHigh : t.zScoreAnomaly;
    const kindOf = (a: AnomalyRecord) => a.evidence ?? (a.metric === 'container-health' ? 'hard' : 'own');
    const state = (n: ServiceNode) => String(n.metadata?.state ?? '');
    // A FACT about the container (stopped, paused, crash-looping, vanished). A 'critical' status on a container that is
    // still running is not a fact about it, so it counts as a strong symptom instead (it can be inherited).
    const isHard = (n: ServiceNode) => { const f = containerFact(n); return f === 'down' || f === 'paused' || f === 'restarting' || f === 'detached'
      || (f !== 'benign' && (byNode.get(n.id) ?? []).some(a => kindOf(a) === 'hard')); };

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

    // How strongly each caller depends on each callee (server/graph/EdgeWeights.ts): live weights when the graph
    // carries them, otherwise computed from the same edges. Telemetry links weigh a tenth.
    const computed = computeEdgeWeights(targetEdges);
    const weightOf = (e: DependencyEdge) => e.weight?.value ?? computed.get(e.id)?.value ?? 0.5;
    const callEdges = targetEdges.filter(e => !(isStore(e.source) && !isStore(e.target)));

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
    const monitoringGap = !!params.hostSilent || (targetNodes.length >= 3 && quietIds.length >= Math.max(3, Math.ceil(t.monitoringGapShare * targetNodes.length)));

    const nothing = params.learning ? !targetNodes.some(n => hard.get(n.id)) : params.learned ? !params.learned.alarm && !targetNodes.some(n => hard.get(n.id))
      : targetAnomalies.length === 0 && !targetNodes.some(n => hard.get(n.id) || n.status === 'degraded');
    if (nothing || monitoringGap) {
      const explanation = this.explanationEngine.generateExplanation({
        targetId, incidentStartedAt: new Date().toISOString(), primaryRootCause: null, alternativeCandidates: [],
        affectedServices: [], propagationPath: [], evidence: [], confidence: 'UNKNOWN',
      });
      if (monitoringGap && params.hostSilent) {
        explanation.whatHappened = 'No telemetry has arrived from this host for over two minutes. The readings on screen are the last ones received.';
        explanation.likelyRootCause = 'The host is unreachable (SSH, network, stopped instance, changed public IP) or its collector stopped. Not a fault in the services.';
        explanation.why = 'Without new data there is nothing to judge; blaming a service on frozen readings would be a guess.';
        explanation.recommendedInvestigation = ['npm run hosts  (is port 22 open, is the IP current?)', 'Check the instance in the EC2 console', 'Edit project: update the public IP if the instance was restarted'];
      } else if (monitoringGap) {
        explanation.whatHappened = `${quietIds.length} of ${targetNodes.length} services stopped reporting at the same moment.`;
        explanation.likelyRootCause = 'Monitoring outage (collector, SSH session or Docker daemon), not a fault in the services.';
        explanation.why = 'Independent services do not all freeze in the same few seconds; a broken telemetry path does. No service is blamed.';
        explanation.recommendedInvestigation = ['Check the SSH connection and the remote collector log', 'Run `docker ps` and `docker stats --no-stream` on the host'];
      }
      return { incidentDetected: monitoringGap, primaryRootCause: null, candidateCauses: [] as CandidateCause[], propagation: [] as PropagationStep[],
        affectedServices: monitoringGap && !params.hostSilent ? targetNodes.filter(n => quietIds.includes(n.id)).map(n => n.name) : [],
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
      // Inferring a fault where nothing is measured needs corroboration: at least two callers with unexplained symptoms past
      // the anomaly threshold, or one caller past the HIGH threshold. One noisy caller is not enough to blame a silent node.
      const ups = (callers.get(n.id) ?? []).map(c => Math.max(0, (sym.get(c) ?? 0) - (parts.get(c)?.x ?? 0)));
      const strong = ups.filter(u => u >= t.zScoreAnomaly);
      const corroborated = strong.length >= 2 || ups.some(u => u >= t.zScoreHigh);
      const guess = corroborated ? 0.9 * Math.max(0, ...ups) : 0;
      if (guess > 0) { raw.set(n.id, guess); parts.set(n.id, { ...(parts.get(n.id)!), blind: true }); }
    }

    const affected = targetNodes.filter(n => (raw.get(n.id) ?? 0) > 0 || (sym.get(n.id) ?? 0) > 0);
    const ranked = [...affected].sort((a, b) => (raw.get(b.id)! - raw.get(a.id)!) || a.name.localeCompare(b.name));
    // "Troubled": visibly unwell (status, hard evidence, or evidence past the anomaly threshold). Coverage asks how
    // many of the OTHER troubled services depend on a candidate through a material path; a candidate that depends on
    // a more broken service is likely a victim.
    const troubled = new Set(targetNodes.filter(n => hard.get(n.id) || n.status === 'critical' || n.status === 'degraded'
      || (raw.get(n.id) ?? 0) >= t.zScoreAnomaly || (sym.get(n.id) ?? 0) >= t.zScoreAnomaly).map(n => n.id));
    const reachOf = new Map<string, Map<string, number>>();
    const reach = (id: string) => { if (!reachOf.has(id)) reachOf.set(id, dependencyReach(id, callEdges, weightOf)); return reachOf.get(id)!; };
    const coverage = new Map<string, string[]>(), dependsOnWorse = new Map<string, string[]>();
    for (const n of affected) {
      const r = reach(n.id);
      coverage.set(n.id, [...troubled].filter(o => o !== n.id && (r.get(o) ?? 0) >= MATERIAL_REACH));
      dependsOnWorse.set(n.id, [...troubled].filter(o => o !== n.id && (reach(o).get(n.id) ?? 0) >= MATERIAL_REACH
        && (raw.get(o) ?? 0) >= (raw.get(n.id) ?? 0)));
    }
    const others = Math.max(0, troubled.size - 1);
    for (const n of affected) {
      const share = others ? (coverage.get(n.id)!.length / others) : 0;
      // Explaining others breaks ties between comparably abnormal services; it never outweighs hard evidence.
      // Scaled by gamma like explain-away, so gamma = 0 is still plain "most abnormal".
      raw.set(n.id, (raw.get(n.id) ?? 0) + share * t.zScoreAnomaly * Math.min(1, t.explainAwayGamma));
    }
    // Learned model installed: its probability replaces the hand-weighted score for the ranking. Services it gives at least
    // a fifth of the alarm threshold are candidates (plus any container fact), so the list stays short and meaningful.
    const L = params.learned;
    if (L) {
      for (const n of targetNodes) raw.set(n.id, L.p.get(n.id) ?? 0);
      const keep = targetNodes.filter(n => (L.p.get(n.id) ?? 0) >= L.threshold / 5 || hard.get(n.id));
      ranked.length = 0; ranked.push(...keep);
      for (const n of keep) if (!parts.has(n.id)) parts.set(n.id, { o: 0, s: 0, x: 0, blind: false });
    }
    // Hysteresis: the open incident's cause stays on top unless another candidate beats it by a clear margin (15%),
    // so ordinary measurement noise between two near-equal candidates does not rewrite the verdict every few minutes.
    if (params.incumbent && raw.has(params.incumbent) && !hard.get(params.incumbent)) raw.set(params.incumbent, raw.get(params.incumbent)! * INCUMBENT_BONUS);
    ranked.sort((a, b) => (raw.get(b.id)! - raw.get(a.id)!) || a.name.localeCompare(b.name));

    const top = ranked[0], second = ranked[1];
    const rawTop = top ? raw.get(top.id)! : 0, rawSecond = second ? raw.get(second.id)! : 0;
    const margin = rawTop > 0 ? 1 - rawSecond / rawTop : 0;
    const to01 = (r: number) => (L ? Math.min(1, r) : r >= 100 ? Math.min(1, 0.9 + (r - 100) / 500) : Math.min(0.89, r / (r + 2 * t.zScoreAnomaly)));

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
      const covered = coverage.get(n.id) ?? [], worse = dependsOnWorse.get(n.id) ?? [];
      const nameOf = (id: string) => targetNodes.find(x => x.id === id)?.name ?? id;
      if (covered.length && others) {
        const sc = round(EXPLAINS_WEIGHT * covered.length / others);
        if (sc >= 0.01) breakdown.push({ factor: 'explains_failures', score: sc, reason: `${covered.length} of the ${others} other affected services depend on it (${covered.map(nameOf).join(', ')})` });
      }
      if (worse.length) breakdown.push({ factor: 'dependency_failing', score: -round(VICTIM_WEIGHT), reason: `it depends on ${worse.map(nameOf).join(', ')}, which ${worse.length > 1 ? 'are' : 'is'} failing at least as badly` });
      if (p.blind) breakdown.push({ factor: 'blind_spot', score: round(r), reason: 'no telemetry from it, while the services calling it show errors nothing else explains' });
      if (L) {
        breakdown.length = 0;
        for (const c of (L.why.get(n.id) ?? []).filter(c => Math.abs(c.value) >= 0.25).slice(0, 5))
          breakdown.push({ factor: c.feature, score: round(c.value), reason: `${L.labels[c.feature] ?? c.feature} (${c.value >= 0 ? '+' : ''}${round(c.value)} log-odds)` });
      }
      const isTop = n.id === top.id;
      let confidence: RCAConfidence = 'LOW';
      if (isTop) {
        const hardCount = ranked.filter(x => hard.get(x.id)).length;
        const observed = targetEdges.some(e => (e.source === n.id || e.target === n.id) && e.observed);
        if ((hard.get(n.id) && hardCount === 1) || (margin >= 0.5 && observed)) confidence = 'HIGH';
        else if (margin >= 0.2) confidence = 'MEDIUM';
        if (others > 0 && covered.length === 0) confidence = 'LOW';     // explains none of the others: independent problems
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
        beforeValue: strongest ? `baseline ${oneDecimal(strongest.baselineMean)}` : 'running',
        afterValue: strongest ? `${oneDecimal(strongest.observedValue)}` : (state(n) ? `${n.status} (${state(n)})` : n.status),
        source: strongest?.evidenceSource ?? 'container-runtime',
        description: strongest
          ? `${describeAnomaly(strongest)}${strongest.reason ? ` — ${strongest.reason}` : ''}`
          : `'${n.name}': ${n.status}${state(n) ? ` (${state(n)})` : ''}`,
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
            const caller = targetNodes.find(x => x.id === callerId);
            const e = targetEdges.find(x => x.source === callerId && x.target === curr);
            // A real chain only: the caller is itself affected and leans on this callee materially. Healthy callers
            // are not "propagated to"; they are the at-risk list below.
            if (!caller || !e || !troubled.has(callerId) || weightOf(e) < MATERIAL_REACH) continue;
            visited.add(callerId);
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

    const affectedServices = affected.map(n => n.id);
    const explanation = this.explanationEngine.generateExplanation({
      targetId, incidentStartedAt: timeline[0]?.timestamp ?? new Date().toISOString(), primaryRootCause,
      alternativeCandidates: candidates, affectedServices: affected.map(n => n.name), propagationPath, evidence: evidenceItems, confidence: overallConfidence,
    });
    if (primaryRootCause) {
      const p = parts.get(primaryRootCause.serviceId)!;
      const rc = primaryRootCause.serviceName, covered = coverage.get(primaryRootCause.serviceId) ?? [];
      const base = hard.get(primaryRootCause.serviceId)
        ? `${rc} is ${state(targetNodes.find(n => n.id === primaryRootCause.serviceId)!) || 'down'}: hard evidence.`
        : p.blind ? `${rc} sends no telemetry while the services calling it fail with nothing else to explain it.`
          : `${rc} has the strongest evidence that is not explained by anything it depends on (own ${round(p.o)}, unexplained symptoms ${round(Math.max(0, p.s - p.x))}).`;
      explanation.why = others === 0 ? base
        : covered.length === 0
          ? `${base} None of the ${others} other affected service${others > 1 ? 's' : ''} depend${others > 1 ? '' : 's'} on ${rc}, so these look like independent problems; treat the ranking with care.`
          : `${base} ${covered.length} of the ${others} other affected services depend on it.`;
      if (atRisk.length) explanation.recommendedInvestigation = [...explanation.recommendedInvestigation, `Watch next: ${atRisk.slice(0, 3).map(a => `${a.serviceName} (${Math.round(a.risk * 100)}%)`).join(', ')}`];
    }

    return { incidentDetected: true, primaryRootCause, candidateCauses: candidates, propagation: propagationSteps, affectedServices,
      evidence: evidenceItems, confidence: overallConfidence, explanation, atRisk, monitoringGap: false };
  }
}

function round(x: number) { return Math.round(x * 100) / 100; }
