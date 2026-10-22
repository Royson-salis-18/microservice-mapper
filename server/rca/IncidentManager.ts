import type { Incident, IncidentStatus, IncidentSeverity } from '../models/Incident.js';
import type { GraphStore } from '../graph/GraphStore.js';
import { AnomalyDetector } from '../algorithms/detection/AnomalyDetector.js';
import { RCAEngine } from '../algorithms/rca/RCAEngine.js';
import { LearnedScorer, FEATURE_LABEL } from './LearnedScorer.js';
import { TargetModels } from './TargetModels.js';
import { loadThresholds } from './thresholdsStore.js';
import { getEngineMode } from './engineMode.js';
import { MLEngine, ENGINE_DEFAULTS } from '../algorithms/ml/mlEngine.js';
import { fuseMoment, HYBRID_DEFAULTS } from '../algorithms/ml/hybrid.js';
import { momentScores, makeScorer } from '../algorithms/detection/scoring.js';
import { RULES_LINE } from '../algorithms/detection/scoring.js';
import type { AnomalyRecord } from '../models/Incident.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';

/** Labels for the ML engine's "why this score" list. */
const ML_LABELS: Record<string, string> = {
  anomaly: 'Isolation Forest anomaly against its own learned baseline (0 to 1)',
  walk: 'share of the random walk on the call graph (root-cause score)',
  fact: 'container fact (stopped, paused or restarting)',
};

/** One engine's verdict on the moment, kept for every engine whatever the active one is (the Detection engines page). */
export interface EngineVerdict {
  /** Over its line on this cycle and the one before (the same persistence the live engine uses). */
  alarm: boolean;
  /** Strongest service against the engine's own alarm line: 1 = exactly at the line. */
  peak: number;
  /** Most likely sources, best first. `score` is the engine's own number for that service. */
  suspects: { id: string; score: number; fact?: string }[];
}
export interface ServiceRow { id: string; rules: number; level: number; own: number; symptom: number; walk: number; blend: number; hard: boolean; fact?: string }
interface Shadow {
  moments: number; rulesHot: number; mlHot: number; hybridHot: number;
  prev: { rules: boolean; ml: boolean; hybrid: boolean };
  now: { rulesTop: number; mlTop: number; hybridMax: number; rulesRanked: string[]; mlRanked: string[]; hybridRanked: string[] };
  at: string;
  engines: { rules: EngineVerdict; ml: EngineVerdict; hybrid: EngineVerdict };
  services: ServiceRow[];
  history: { t: number; rules: number; ml: number; hybrid: number }[];
}
export interface EngineTally { incidents: number; since: string; last: { at: string; target: string; root: string | null; severity: string } | null }

export class IncidentManager {
  private activeIncidents: Map<string, Incident> = new Map(); // targetId -> Incident
  private anomalyDetector: AnomalyDetector;
  private rcaEngine: RCAEngine;
  private learned = new LearnedScorer();
  /** One model per architecture, trained on its own baseline at every start (call models.start() once the server is up). */
  public readonly models: TargetModels;
  /** Incidents opened under each engine mode since the server started. */
  private tally: Record<'rules' | 'ml' | 'hybrid', EngineTally> = {
    rules: { incidents: 0, since: new Date().toISOString(), last: null },
    ml: { incidents: 0, since: new Date().toISOString(), last: null },
    hybrid: { incidents: 0, since: new Date().toISOString(), last: null },
  };
  /** Per target: was the learned model above its threshold last cycle (alarms need two cycles in a row). */
  private learnedHot = new Map<string, boolean>();
  /** ML engine state per target: the learned baselines, the newest reading already fed in, last cycle's alarm. */
  private ml = new Map<string, { engine: MLEngine; seen: Map<string, string>; hot: boolean; ready: boolean; learned: number; services: number; readings: number; rulesTop?: number; shadow?: Shadow; warnings?: { id: string; feature: string; inSec: number | null }[]; cascade?: { id: string; risk: number }[]; detail: { id: string; level: number; own: number; symptom: number; anomaly: number; walk: number; hard: boolean; ready: boolean; fact?: string }[] }>();

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
    const mode = getEngineMode();
    if (mode !== 'rules') return this.finish(targetId, targetNodes, targetEdges, anomalies, this.mlAnalysis(targetId, targetNodes, targetEdges, anomalies, hostSilent, open, mode === 'hybrid'), t);
    // The rule engine decides here, but the ML engine and the fused rule still step on the same readings, so the
    // Detection engines page can show all three side by side and a later switch does not start from nothing.
    this.observe(targetId, targetNodes, targetEdges, hostSilent, false);
    this.graphStore.clearEngineScores?.();
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

    return this.finish(targetId, targetNodes, targetEdges, anomalies, rcaResult, t);
  }

  /** The ML engine: per-service Isolation Forest (learned on a sliding window of normal readings) and a random walk on the
   *  call graph. Its verdict goes through the same incident machinery as the rules (explanation, cascade, at-risk).
   *  Hybrid: the rule engine scores the same moment too, and either engine can raise the alarm (server/algorithms/ml/hybrid.ts). */
  /** Steps the ML engine one cycle and scores the same moment with the rules and the fused rule, whatever mode is active, so
   *  all three are always computed in parallel and can be shown side by side. Returns what the active mode needs. */
  private observe(targetId: string, nodes: any[], edges: any[], hostSilent: boolean, hybrid: boolean) {
    let st = this.ml.get(targetId);
    if (!st) { st = { engine: new MLEngine(ENGINE_DEFAULTS), seen: new Map(), hot: false, ready: false, learned: 0, services: 0, readings: 0, detail: [] }; this.ml.set(targetId, st); }
    const fresh = new Map<string, MetricSnapshot[]>();
    let readings = 0;
    for (const n of nodes) {
      const last = st.seen.get(n.id) ?? '';
      const h = this.graphStore.metricStore.getHistory(n.id, '15m').filter((x) => x.timestamp > last);
      if (h.length) { st.seen.set(n.id, h[h.length - 1].timestamp); fresh.set(n.id, h); readings += h.length; }
    }
    const r = st.engine.step(nodes, edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight?.value ?? 1 })), hostSilent ? new Map() : fresh);
    let hotNow = r.hot;
    if (!hostSilent) {
      const history = (id: string) => this.graphStore.metricStore.getHistory(id, '15m');
      const rules = momentScores(nodes, history, edges.map((e) => [e.source, e.target] as [string, string]), makeScorer(null));
      const ids = [...r.services.keys()];
      const rulesLine = new Map(ids.map((id) => [id, (rules.get(id) ?? 0) / RULES_LINE]));
      const fused = fuseMoment({ services: ids, rules: rulesLine, level: new Map(ids.map((id) => [id, r.services.get(id)!.level / ENGINE_DEFAULTS.alarmLevel])),
        hard: new Set(ids.filter((id) => r.services.get(id)!.hard)), walk: r.rank, mlRanked: r.ranked }, HYBRID_DEFAULTS);
      if (hybrid) hotNow = fused.max >= 1;
      const rulesTop = Math.max(0, ...rulesLine.values());
      st.rulesTop = rulesTop;
      const mlTop = Math.max(0, ...[...r.services.values()].map((v) => v.level / ENGINE_DEFAULTS.alarmLevel));
      const prev = st.shadow?.prev ?? { rules: false, ml: false, hybrid: false };
      const sh: Shadow = st.shadow ?? { moments: 0, rulesHot: 0, mlHot: 0, hybridHot: 0, prev, now: { rulesTop: 0, mlTop: 0, hybridMax: 0, rulesRanked: [], mlRanked: [], hybridRanked: [] }, at: '',
        engines: { rules: { alarm: false, peak: 0, suspects: [] }, ml: { alarm: false, peak: 0, suspects: [] }, hybrid: { alarm: false, peak: 0, suspects: [] } }, services: [], history: [] };
      const rulesHotNow = rulesTop >= 1, mlHotNow = r.hot, hybridHotNow = fused.max >= 1;
      sh.moments++;
      if (rulesHotNow) sh.rulesHot++;
      if (mlHotNow) sh.mlHot++;
      if (hybridHotNow) sh.hybridHot++;
      const round = (x: number) => +x.toFixed(2);
      const fact = (id: string) => r.services.get(id)?.fact;
      sh.now = {
        rulesTop: round(rulesTop), mlTop: round(mlTop), hybridMax: round(Math.min(fused.max, 10)),
        rulesRanked: [...rulesLine].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0).slice(0, 3).map(([id]) => id),
        mlRanked: r.ranked.slice(0, 3),
        hybridRanked: fused.ranked.slice(0, 3),
      };
      sh.engines = {
        rules: { alarm: rulesHotNow && prev.rules, peak: round(rulesTop), suspects: [...rulesLine].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0).slice(0, 5).map(([id, v]) => ({ id, score: round(v), fact: fact(id) })) },
        ml: { alarm: mlHotNow && prev.ml, peak: round(mlTop), suspects: r.ranked.slice(0, 5).map((id) => ({ id, score: +(r.rank.get(id) ?? 0).toFixed(3), fact: fact(id) })) },
        hybrid: { alarm: hybridHotNow && prev.hybrid, peak: round(Math.min(fused.max, 10)), suspects: fused.ranked.slice(0, 5).map((id) => ({ id, score: round(fused.blend.get(id) ?? 0), fact: fact(id) })) },
      };
      sh.prev = { rules: rulesHotNow, ml: mlHotNow, hybrid: hybridHotNow };
      sh.at = new Date().toISOString();
      sh.services = ids.map((id) => { const v = r.services.get(id)!; return { id, rules: round(rulesLine.get(id) ?? 0), level: round(v.level), own: round(v.ownLevel), symptom: round(v.symptomLevel), walk: +(r.rank.get(id) ?? 0).toFixed(3), blend: round(fused.blend.get(id) ?? 0), hard: v.hard, fact: v.fact }; })
        .sort((x, y) => Number(y.hard) - Number(x.hard) || y.blend - x.blend || y.rules - x.rules);
      sh.history.push({ t: Date.now(), rules: round(Math.min(rulesTop, 6)), ml: round(Math.min(mlTop, 6)), hybrid: round(Math.min(fused.max, 6)) });
      if (sh.history.length > 90) sh.history.shift();
      st.shadow = sh;
    }
    const alarm = hotNow && st.hot;
    st.hot = hotNow; st.ready = r.ready; st.learned = r.learnedServices; st.services = r.services.size; st.readings += readings;
    st.warnings = r.warnings.map((w) => ({ id: w.id, feature: w.feature, inSec: w.inSec }));
    st.cascade = [...r.atRisk].filter(([, p]) => p >= 0.5).sort((a, b) => b[1] - a[1]).map(([id, risk]) => ({ id, risk: Math.round(risk * 100) / 100 }));
    st.detail = [...r.services].map(([id, v]) => ({ id, level: +v.level.toFixed(2), own: +v.ownLevel.toFixed(2), symptom: +v.symptomLevel.toFixed(2), anomaly: +v.anomaly.toFixed(2), walk: +(r.rank.get(id) ?? 0).toFixed(3), hard: v.hard, ready: v.ready, fact: v.fact }))
      .sort((a, b) => b.walk - a.walk || b.level - a.level);
    this.graphStore.setEngineScores?.(new Map([...r.services].map(([id, v]) => [id, { score: v.anomaly, persistent: v.level >= 1 }])));
    return { st, r, alarm };
  }

  private mlAnalysis(targetId: string, nodes: any[], edges: any[], ruleAnomalies: AnomalyRecord[], hostSilent: boolean, open: Incident | undefined, hybrid = false) {
    const { st, r, alarm } = this.observe(targetId, nodes, edges, hostSilent, hybrid);

    // evidence for the incident: container facts (from the detector) plus the forest's verdicts
    const now = new Date().toISOString();
    const anomalies: AnomalyRecord[] = hybrid ? [...ruleAnomalies] : ruleAnomalies.filter((a) => (a.evidence ?? '') === 'hard');
    for (const [id, v] of r.services) {
      if (v.hard || v.level < 1) continue;
      anomalies.push({ id: `anomaly-${id}-iforest-${Date.now()}`, nodeId: id, targetId, metric: 'isolation-forest', timestamp: now, observedValue: Math.round(v.score * 1000) / 1000,
        baselineMean: 0, baselineStdDev: 0, zScore: Math.round(v.level * 350) / 100, reason: `isolated quickly by its own forest (level ${v.level.toFixed(2)}, 1 = alarm line)`,
        severity: v.level >= 4 ? 'CRITICAL' : v.level >= 2 ? 'HIGH' : 'MEDIUM', evidenceSource: 'isolation-forest', evidence: 'own' } as AnomalyRecord);
    }
    const why = new Map([...r.services].map(([id, v]) => [id, [
      ...(v.hard ? [{ feature: 'fact', value: 1 }] : []), { feature: 'anomaly', value: v.anomaly }, { feature: 'walk', value: r.rank.get(id) ?? 0 }]]));
    const learning = r.ready ? undefined : { haveSec: Math.round(st.readings * 5 / Math.max(1, nodes.length)), needSec: ENGINE_DEFAULTS.baseline.minTrain * 5 };
    return this.rcaEngine.analyzeIncident({
      targetId, nodes, edges, anomalies, thresholds: loadThresholds(), hostSilent, learning,
      incumbent: open && open.status !== 'RESOLVED' ? open.rootCauseServiceId : null,
      learned: { p: r.rank, why, alarm: alarm || [...r.services.values()].some((v) => v.hard), threshold: 0.25, labels: ML_LABELS, unit: '', minShow: 0.01 },
    });
  }

  /** What the ML engine has learned so far, per target (for the UI). */
  public engineStatus() {
    return { mode: getEngineMode(), targets: [...this.ml].map(([targetId, s]) => ({ targetId, ready: s.ready, learnedServices: s.learned, services: s.services, detail: s.detail, rulesTop: s.rulesTop ?? null, shadow: s.shadow ?? null, warnings: s.warnings ?? [], cascade: s.cascade ?? [], needReadings: ENGINE_DEFAULTS.baseline.minTrain })) };
  }

  /** Incidents opened per engine mode since the server started (for the Detection engines page). */
  public engineTally() { return this.tally; }

  /** Close every open incident (used when the engine is switched, so the new engine starts from a clean slate). */
  public resetIncidents(): void { this.activeIncidents.clear(); this.learnedHot.clear(); for (const s of this.ml.values()) s.hot = false; }

  private finish(targetId: string, targetNodes: any[], targetEdges: any[], anomalies: AnomalyRecord[], rcaResult: ReturnType<RCAEngine['analyzeIncident']>, t: ReturnType<typeof loadThresholds>): Incident | null {
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
    const tally = this.tally[getEngineMode()];
    tally.incidents++;
    tally.last = { at: now, target: targetId, root: newIncident.rootCauseServiceId, severity: String(severity) };
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
    if (targetId) { this.activeIncidents.delete(targetId); this.ml.delete(targetId); } else { this.activeIncidents.clear(); this.ml.clear(); }
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
