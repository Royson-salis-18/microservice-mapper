/**
 * v2 causal: root-cause ranking with LEARNED call directions.
 *
 * Detection is not touched: `max` is exactly V1.hybrid's (ML level, or the rules well over their line). Only the
 * ranking changes:
 *
 *   1. container facts first (ml[id][4] = 1: down, paused, restarting, detached, crash loop), as in v1
 *   2. then the MonitorRank-style random walk (server/algorithms/ml/randomWalk.ts) on
 *        a(v)   = ml[v][3]                                   the v1 anomaly, 0..1
 *        own(v) = 1 if a fact, else ownLevel >= 0.5 ? min(1, ownLevel / 2) : 0      (as in the v1 engine)
 *      over the edges seen at the moment, with directions from one of:
 *        none      every pair mutual (direction unknown): how much the walk depends on directions at all
 *        name      v1's name rule (resolveDirections): a replica of what v1 does, for a like-for-like comparison
 *        learned   DirectionLearner with the LEARNED preset (collector view first, then the combined score)
 *        dynamic   DirectionLearner with the DYNAMIC preset (time series only)
 *        name+     the name rule where it decides, the learned direction where it leaves a pair mutual
 *        oracle    the true call graph. A CEILING for analysis only: it reads trueCalls, so it is not an engine.
 *   3. ties broken by the v1 level, then by id.
 *
 * Optionally (`weights: 'implication'`) a learned edge weight replaces 1: w(u -> v) = 0.25 + P(T_u | T_v), the share
 * of v's trouble that its caller u also showed. A caller that does not feel a callee's trouble passes less walk to it.
 *
 * ONLINE: for moment i the learner has seen moments 0..i of the same run and nothing else.
 */
import { rootCauseWalk, type WalkEdge } from '../../server/algorithms/ml/randomWalk.ts';
import { resolveDirections } from '../../server/algorithms/ml/mlEngine.ts';
import { V1, type Engine } from '../core/score.ts';
import type { Trace, TraceMoment } from '../core/trace.ts';
import { DirectionLearner, PRESETS, type DirectionParams } from './direction.ts';

export type DirectionSource = 'none' | 'name' | 'learned' | 'dynamic' | 'name+' | 'oracle';
export interface RcaOptions { directions: DirectionSource; weights?: 'unit' | 'implication'; learner?: Partial<DirectionParams> }

function nameEdges(m: TraceMoment): WalkEdge[] {
  const watched = new Set(m.services);
  return resolveDirections(m.edges.filter(([f, t]) => watched.has(f) && watched.has(t)).map(([source, target]) => ({ source, target })), (id) => ({ id, name: id }));
}

function mutualEdges(m: TraceMoment): WalkEdge[] {
  const watched = new Set(m.services);
  return m.edges.filter(([f, t]) => f !== t && watched.has(f) && watched.has(t)).map(([from, to]) => ({ from, to, weight: 1, mutual: true }));
}

function oracleEdges(t: Trace, m: TraceMoment): WalkEdge[] {
  const watched = new Set(m.services), tc = new Set((t.trueCalls ?? []).map(([a, b]) => `${a}>${b}`)), seen = new Set<string>(), out: WalkEdge[] = [];
  for (const [f, g] of m.edges) {
    if (f === g || !watched.has(f) || !watched.has(g)) continue;
    const k = f < g ? `${f}|${g}` : `${g}|${f}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const fg = tc.has(`${f}>${g}`), gf = tc.has(`${g}>${f}`);
    if (fg) out.push({ from: f, to: g, weight: 1 });
    if (gf) out.push({ from: g, to: f, weight: 1 });
    if (!fg && !gf) out.push({ from: f, to: g, weight: 1, mutual: true }, { from: g, to: f, weight: 1, mutual: true });
  }
  return out;
}

/** The walk ranking of one moment, given its walk edges. */
export function rankMoment(m: TraceMoment, edges: WalkEdge[]): string[] {
  const ids = m.services, ml = (id: string) => m.ml[id] ?? [0, 0, 0, 0, 0, 0];
  const a = new Map(ids.map((id) => [id, ml(id)[3]]));
  const own = new Map(ids.map((id) => { const v = ml(id); return [id, v[4] === 1 ? 1 : v[1] >= 0.5 ? Math.min(1, v[1] / 2) : 0]; }));
  const walk = rootCauseWalk(ids, a, edges, {}, own);
  return [...ids].sort((x, y) => (ml(y)[4] - ml(x)[4]) || (walk.get(y)! - walk.get(x)!) || (ml(y)[0] - ml(x)[0]) || x.localeCompare(y));
}

/** Rankings for every moment of a run, computed once, in time order (the learner only ever looks back). */
export function rankRun(t: Trace, o: RcaOptions): string[][] {
  const weights = o.directions === 'dynamic' ? PRESETS.dynamic : PRESETS.learned;
  const L = new DirectionLearner({ ...(o.learner ?? {}), weights: o.learner?.weights ?? weights });
  return t.moments.map((m) => {
    L.observe(m);
    let edges: WalkEdge[];
    if (o.directions === 'none') edges = mutualEdges(m);
    else if (o.directions === 'name') edges = nameEdges(m);
    else if (o.directions === 'oracle') edges = oracleEdges(t, m);
    else if (o.directions === 'name+') {
      // the name rule where it decides; where it leaves a pair mutual, the learned direction
      const learned = L.walkEdges(m);
      const decided = new Set(nameEdges(m).filter((e) => !e.mutual).map((e) => (e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`)));
      edges = [...nameEdges(m).filter((e) => !e.mutual), ...learned.filter((e) => !decided.has(e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`))];
    } else edges = L.walkEdges(m);
    if (o.weights === 'implication') edges = edges.map((e) => (e.mutual ? e : { ...e, weight: 0.25 + L.feels(e.from, e.to) }));
    return rankMoment(m, edges);
  });
}

/** An Engine: V1.hybrid's detection, ranking re-done with the chosen directions. */
export function causalEngine(o: RcaOptions): Engine {
  const cache = new WeakMap<Trace, string[][]>();
  return (t, i) => {
    let r = cache.get(t);
    if (!r) { r = rankRun(t, o); cache.set(t, r); }
    return { max: V1.hybrid(t, i).max, ranked: r[i] };
  };
}
