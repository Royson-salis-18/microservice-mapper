/**
 * The ML engine for one project: a learned baseline per service (Isolation Forest on a sliding window of normal readings)
 * and a random walk on the call graph to find the source.
 *
 *   readings ──► per-service forest (scored against the previous window) ──► level per service
 *                                                         │
 *   container facts (stopped, paused, restarting) ────────┤  a fact counts as the maximum anomaly
 *                                                         ▼
 *                          anomaly a(v) on the call graph ──► random walk ──► root-cause ranking
 *
 * An alarm is raised when any service is above its own line (the caller asks for two cycles in a row) or a container
 * fact is present. PURE: the caller supplies readings, nodes and edges; the engine keeps only the learned state.
 */
import { ServiceBaseline, readingVector, BASELINE_DEFAULTS, type BaselineParams } from './serviceBaseline.js';
import { LoadModel, LOAD_DEFAULTS, vectorize, type LoadParams, type RoundInfo, type Level } from './loadModel.js';
import { PcaModel, PCA_DEFAULTS, type PcaParams } from './pcaModel.js';
import { PropagationModel } from './propagation.js';
import type { Forecast } from './serviceBaseline.js';
import { rootCauseWalk, pageRankScores, WALK_DEFAULTS, type WalkParams, type WalkEdge } from './randomWalk.js';
import { containerFact, isLoadGenerator } from '../detection/containerFacts.js';
import type { MetricSnapshot } from '../../models/MetricSnapshot.js';

export interface EngineParams {
  baseline: BaselineParams; walk: WalkParams;
  /** What learns a service's normal: the forest (per service, blind to load) or the load-aware residual model. */
  levels: 'forest' | 'load' | 'pca';
  load: LoadParams;
  pca: PcaParams;
  anomalyFloor: number;     // levels below this count as healthy for the walk
  servicePersist: number;   // readings in a row above the line before a service counts as anomalous
  hardFirst: boolean;       // a container fact (stopped, paused, restarting) ranks ahead of statistical evidence
  useWalk: boolean;
  useOwn: boolean;          // resource (own) anomalies keep the walker: they cannot be explained by a dependency
  loopWindow: number;       // steps in which two separate outages make a crash loop (0: off)
  loopHold: number;         // steps a crash-looping service stays down-ranked-first after its last outage
  rca: 'walk' | 'pagerank' | 'onset' | 'depth';   // how the root cause is ranked among anomalous services
  alarmLevel: number;       // the project alarms when some service holds at least this level (1 = its own line)
  warnAt: number;           // early warning when a service's trend reaches this level within the forecast horizon
  anomalySat: number;       // the level at which a service counts as fully anomalous for the walk (anomaly = level / this, at most 1)
  stoppedIsDown: boolean;   // exit code 0 after a minute of running counts as down (docker stop), not as a finished job
}
export const ENGINE_DEFAULTS: EngineParams = { baseline: BASELINE_DEFAULTS, walk: WALK_DEFAULTS, levels: 'load', load: LOAD_DEFAULTS, pca: PCA_DEFAULTS, anomalyFloor: 0.5, servicePersist: 2, hardFirst: true, useWalk: true, useOwn: true, loopWindow: 36, loopHold: 12, rca: 'walk', alarmLevel: 2, warnAt: 2, anomalySat: 2, stoppedIsDown: true };

export interface EngineNode { id: string; name: string; type?: string; status?: string; metadata?: Record<string, any> }
export interface EngineEdge { source: string; target: string; weight?: number }

export interface ServiceView { level: number; anomaly: number; own: number; hard: boolean; ready: boolean; score: number; ownLevel: number; symptomLevel: number; fact?: string; forecast?: Forecast;
  /** The signal furthest from what the current load predicts, and by how many spreads (load-aware model only). */
  top?: { feature: string; z: number } | null }
export interface EngineResult {
  services: Map<string, ServiceView>;
  rank: Map<string, number>;        // random-walk share, sums to 1 over services
  ranked: string[];                 // best first
  maxLevel: number;                 // the strongest level (a container fact counts as 10)
  hot: boolean;                     // something is above its line right now
  ready: boolean;                   // at least one service has a model
  learnedServices: number;
  /** Early warning: services not yet over their line whose recent trend crosses it within the forecast horizon. */
  warnings: { id: string; feature: string; inSec: number | null; level: number }[];
  /** Learned cascade: risk that the current top suspect's trouble reaches each healthy service. */
  atRisk: Map<string, number>;
  /** The workload the whole project moved by this step (load-aware model only), so a change of load is reported as such. */
  workload: RoundInfo | null;
}

const STORE = /(^|[-_])(db|store|cache|redis|memcached|mongo|mongodb|postgres|mysql|queue|bus|kafka|nats|rabbitmq)([-_]|$)/i;
const HARD_LEVEL = 10;
const ENTRY = /(^|[-_])(gateway|edge|frontend|front|web|ui|proxy|nginx|ingress|lb|api)([-_]|$)/i;
const BACKEND = /(^|[-_])(provider|sandbox|external|psp|smtp|mail)([-_]|$)/i;

/** Where a service usually sits in a call chain: 0 entry point, 1 service, 2 data store, queue or external dependency. */
export function tierOf(n: EngineNode | undefined): number {
  if (!n) return 1;
  if (n.type === 'database' || n.type === 'queue' || STORE.test(n.name) || BACKEND.test(n.name)) return 2;
  if (n.type === 'frontend' || n.type === 'gateway' || ENTRY.test(n.name)) return 0;
  return 1;
}

/**
 * Connections are seen from both ends, so the same pair often appears in both directions. Keep the direction a call
 * normally takes (entry point -> service -> store); a pair between two services of the same tier keeps both directions,
 * marked mutual (direction unknown).
 */
export function resolveDirections(edges: EngineEdge[], nodeOf: (id: string) => EngineNode | undefined): WalkEdge[] {
  const has = new Set(edges.map((e) => `${e.source}\u0000${e.target}`));
  const out: WalkEdge[] = [];
  for (const e of edges) {
    if (e.source === e.target) continue;
    const ts = tierOf(nodeOf(e.source)), tt = tierOf(nodeOf(e.target));
    const both = has.has(`${e.target}\u0000${e.source}`);
    if (ts > tt && (both || ts === 2)) continue;              // the reverse view of a downward call
    out.push({ from: e.source, to: e.target, weight: e.weight ?? 1, mutual: both && ts === tt });
  }
  return out;
}

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export class MLEngine {
  private models = new Map<string, ServiceBaseline>();
  private loadModel: { round(r: Map<string, (number | null)[]>): Map<string, Level>; info: RoundInfo; forget(): void };
  private last = new Map<string, ServiceView>();
  private streak = new Map<string, number>();
  private sinceFact = new Map<string, number>();
  private runningFor = new Map<string, number>();
  private onsets = new Map<string, number[]>();
  private wasHard = new Map<string, boolean>();
  private clock = 0;
  private onsetAt = new Map<string, number>();
  private propagation = new PropagationModel();
  private warnStreak = new Map<string, number>();   // step at which the service last became anomalous

  constructor(private readonly p: EngineParams = ENGINE_DEFAULTS) { this.loadModel = p.levels === 'pca' ? new PcaModel(p.pca) : new LoadModel(p.load); }

  /** Feed the readings that arrived since the previous step (per service, oldest first) and get the current verdict. */
  step(nodes: EngineNode[], edges: EngineEdge[], fresh: Map<string, MetricSnapshot[]>): EngineResult {
    const services = new Map<string, ServiceView>();
    this.clock++;
    const onsets: string[] = [];
    const watched = nodes.filter((n) => !isLoadGenerator(n.name));
    // Pass 1: container facts and hard states, which need no model.
    interface Pending { n: EngineNode; fact: string | null; stopped: boolean; restarted: boolean; hard: boolean; hardNow: boolean; looping: boolean; readings: MetricSnapshot[] }
    const pending: Pending[] = [];
    for (const n of watched) {
      let fact = containerFact(n as any);
      // `docker stop` exits with code 0, which reads like a one-shot job that finished. A service that had been running
      // for a while and then exits is stopped, whatever the code.
      const state = String(n.metadata?.state ?? '').toLowerCase();
      if (state.startsWith('running')) this.runningFor.set(n.id, (this.runningFor.get(n.id) ?? 0) + 1);
      let stopped = false;
      if (fact === 'benign' && this.p.stoppedIsDown && state.startsWith('exited') && (this.runningFor.get(n.id) ?? 0) >= 12) { fact = 'down'; stopped = true; }
      if (fact === 'benign') { services.set(n.id, { level: 0, anomaly: 0, own: 0, hard: false, ready: false, score: 0, ownLevel: 0, symptomLevel: 0 }); continue; }
      const readings = fresh.get(n.id) ?? [];
      const restarted = readings.some((r) => (r.restartDelta ?? 0) > 0);
      const hardNow = fact === 'down' || fact === 'paused' || fact === 'restarting' || fact === 'detached' || restarted;
      // went down more than once in the last few minutes and has not been stable since: a crash loop or a flapping
      // container. Between outages it looks fine, but it is still the prime suspect.
      const since = hardNow ? 0 : (this.sinceFact.get(n.id) ?? Infinity) + 1;
      this.sinceFact.set(n.id, since);
      const ons = (this.onsets.get(n.id) ?? []).filter((t) => this.clock - t <= this.p.loopWindow);
      if (hardNow && !this.wasHard.get(n.id)) ons.push(this.clock);
      this.onsets.set(n.id, ons);
      this.wasHard.set(n.id, hardNow);
      const looping = this.p.loopWindow > 0 && !hardNow && ons.length >= 2 && since <= this.p.loopHold;
      pending.push({ n, fact, stopped, restarted, hard: hardNow || looping, hardNow, looping, readings });
    }

    // Pass 2: what the model makes of the new readings.
    const views = new Map<string, ServiceView>();
    const readyOf = new Map<string, boolean>();
    let workload: RoundInfo | null = null;
    if (this.p.levels !== 'forest') {
      const live = pending.filter((q) => !q.hard);
      const rounds = Math.max(0, ...live.map((q) => q.readings.length));
      for (let k = 0; k < rounds; k++) {
        const vecs = new Map<string, (number | null)[]>();
        for (const q of live) if (q.readings[k]) vecs.set(q.n.id, vectorize(q.readings[k], this.p.load));
        const res = this.loadModel.round(vecs);
        workload = this.loadModel.info;
        for (const [id, v] of res) {
          views.set(id, { level: v.level, anomaly: 0, own: 0, hard: false, ready: v.ready, score: v.score, ownLevel: v.own, symptomLevel: v.symptom, forecast: v.forecast, top: v.top });
          this.streak.set(id, v.level >= 1 ? (this.streak.get(id) ?? 0) + 1 : 0);
          readyOf.set(id, v.ready);
        }
      }
    }

    // Pass 3: persistence, the anomaly the walk sees, the label.
    for (const q of pending) {
      const { n, fact, stopped, restarted, hard, hardNow, looping, readings } = q;
      let view = views.get(n.id) ?? this.last.get(n.id) ?? { level: 0, anomaly: 0, own: 0, hard: false, ready: false, score: 0, ownLevel: 0, symptomLevel: 0 };
      let ready = readyOf.get(n.id) ?? view.ready;
      if (this.p.levels === 'forest') {
        let model = this.models.get(n.id);
        if (!model) { model = new ServiceBaseline(hash(n.id), this.p.baseline); this.models.set(n.id, model); }
        if (!hard) {
          for (const r of readings) {
            const v = model.observe(readingVector(r, this.p.baseline.minRequests));
            view = { level: v.level, anomaly: 0, own: 0, hard: false, ready: v.ready, score: v.score, ownLevel: v.own, symptomLevel: v.symptom, forecast: v.forecast };
            this.streak.set(n.id, v.level >= 1 ? (this.streak.get(n.id) ?? 0) + 1 : 0);
          }
        }
        ready = model.ready;
      }
      // a level must hold for a few readings before the service counts, and below the floor the model's ordinary
      // wobble is not evidence
      const persistent = (this.streak.get(n.id) ?? 0) >= this.p.servicePersist;
      const lvl = hard ? HARD_LEVEL : persistent ? view.level : Math.min(view.level, 0.99);
      const toA = (x: number) => (x < this.p.anomalyFloor ? 0 : Math.min(1, x / this.p.anomalySat));
      const anomaly = hard ? 1 : toA(lvl);
      const own = hard ? 1 : persistent ? toA(view.ownLevel) : 0;
      const label = looping ? 'crash loop' : stopped ? 'stopped' : restarted && !fact ? 'restarted' : hardNow ? fact ?? undefined : undefined;
      view = { ...view, level: lvl, anomaly, own, hard, ready, fact: label };
      this.last.set(n.id, view);
      services.set(n.id, view);
      if (anomaly > 0) { if (!this.onsetAt.has(n.id)) { this.onsetAt.set(n.id, this.clock); onsets.push(n.id); } } else this.onsetAt.delete(n.id);
    }

    const ids = [...services.keys()];
    const byId = new Map(watched.map((n) => [n.id, n]));
    const walkEdges = resolveDirections(edges.filter((e) => services.has(e.source) && services.has(e.target)), (id) => byId.get(id));
    const a = new Map(ids.map((id) => [id, services.get(id)!.anomaly]));
    const ownA = new Map(ids.map((id) => [id, services.get(id)!.own]));
    const rank = !this.p.useWalk ? new Map(ids.map((id) => [id, a.get(id)!])) : this.rankBy(ids, a, ownA, walkEdges);
    const hardOf = (id: string) => (this.p.hardFirst && services.get(id)!.hard ? 1 : 0);
    const ranked = [...ids].sort((x, y) => (hardOf(y) - hardOf(x)) || (rank.get(y)! - rank.get(x)!) || (services.get(y)!.level - services.get(x)!.level) || x.localeCompare(y));
    let maxLevel = 0;
    for (const v of services.values()) maxLevel = Math.max(maxLevel, v.level);
    const learned = [...services.values()].filter((v) => v.ready).length;
    const hot = maxLevel >= this.p.alarmLevel;

    // learned cascade: count how often trouble moved from a service to its callers, then project from the top suspect
    const callersOf = (id: string) => walkEdges.filter((e) => e.to === id).map((e) => e.from);
    const calleesOf = (id: string) => walkEdges.filter((e) => e.from === id).map((e) => e.to);
    const abnormal = new Set(ids.filter((id) => services.get(id)!.anomaly > 0));
    this.propagation.update(this.clock, onsets, abnormal, callersOf);
    const atRisk = hot && ranked[0] ? this.propagation.risk(ranked[0], abnormal, callersOf, calleesOf) : new Map<string, number>();

    // early warning: a trend heading for the alarm level, on a service not at that level yet, two steps in a row
    const warnings: EngineResult['warnings'] = [];
    for (const id of ids) {
      const v = services.get(id)!, f = v.forecast;
      const warn = !v.hard && v.level < this.p.alarmLevel && !!f && f.level >= this.p.warnAt && !!f.feature;
      this.warnStreak.set(id, warn ? (this.warnStreak.get(id) ?? 0) + 1 : 0);
      if (warn && this.warnStreak.get(id)! >= 2) warnings.push({ id, feature: f!.feature!, inSec: f!.inSteps === null ? null : f!.inSteps * 5, level: f!.level });
    }
    return { services, rank, ranked, maxLevel, hot, ready: learned > 0, learnedServices: learned, warnings, atRisk, workload };
  }

  /** Root-cause scores among the anomalous services, by the configured method. */
  private rankBy(ids: string[], a: Map<string, number>, ownA: Map<string, number>, walkEdges: WalkEdge[]): Map<string, number> {
    if (this.p.rca === 'pagerank') return pageRankScores(ids, a, walkEdges, this.p.walk.alpha, this.p.walk.iterations);
    const walk = rootCauseWalk(ids, a, walkEdges, this.p.walk, this.p.useOwn ? ownA : undefined);
    if (this.p.rca === 'onset') {
      // temporal precedence: in a cascade the source turns abnormal first, so earlier onsets weigh more (half weight per 30 s)
      const ons = ids.filter((id) => a.get(id)! > 0).map((id) => this.onsetAt.get(id) ?? this.clock);
      const first = ons.length ? Math.min(...ons) : this.clock;
      return new Map(ids.map((id) => [id, walk.get(id)! * Math.pow(0.5, ((this.onsetAt.get(id) ?? this.clock) - first) / 6)]));
    }
    if (this.p.rca === 'depth') {
      // the deepest anomalous service: one with no anomalous callee of known direction
      const sick = (id: string) => a.get(id)! > 0;
      return new Map(ids.map((id) => [id, a.get(id)! * (walkEdges.some((e) => e.from === id && !e.mutual && sick(e.to)) ? 0.3 : 1)]));
    }
    return walk;
  }

  forget(): void { this.loadModel.forget(); this.models.clear(); this.last.clear(); this.streak.clear(); this.sinceFact.clear(); this.runningFor.clear(); this.onsets.clear(); this.wasHard.clear(); this.onsetAt.clear(); this.propagation.forget(); this.warnStreak.clear(); }
}
