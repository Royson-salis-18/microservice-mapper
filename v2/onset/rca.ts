/**
 * Root-cause ranking with temporal precedence, and earlier detection from change points.
 *
 * Idea: in a cascade the source changes first and its callers follow a few seconds later. So among services that are
 * anomalous now and connected in the observed call graph, the one whose change began first is a better root-cause
 * candidate. Onsets come from changepoint.ts (back-dated to where the shift started).
 *
 * Ranking engines keep the alarm decision (`max`) of V1.hybrid and only change `ranked`:
 *   1. container facts first (ml[id][4] === 1), in the v1 order, as in v1
 *   2. then the rest, by one of these forms. w(id) = v1 walk share / top walk share; d(id) = onset(id) - the earliest onset
 *      in id's connected anomalous component (seconds); non-anomalous services get d = dNone.
 *        decay      score = (w + 0.05) * exp(-d / tau)
 *        rrf        score = 1 / (K + rank in v1 order) + beta / (K + onset rank in its component)
 *        earliest   the earliest-onset service of each connected anomalous component goes first (components ordered by
 *                   their total walk share), then everything else in the v1 order
 *        gate       v1 order, except: if the v1 top service is anomalous and a connected anomalous service changed at least
 *                   `gap` seconds earlier and has at least `ratio` x its walk share, that service goes first
 *   "Anomalous" = a change-point flag whose onset is at most maxAge seconds old (optionally also seen by v1:
 *   walk share > 0 or rule score >= 0.5).
 *
 * The detection engine adds a change-point alarm to V1.hybrid: max = max(hybrid max, 1 if some service has a change of
 * mean |z| >= magAlarm, flagged for at least `persist` moments and at most `maxAlarmAge` seconds, in at least minServices
 * services). The age limit stops a change that never returns to baseline from holding the alarm on.
 * Causal: everything at moment i uses moments 0..i only. Never reads trueCalls.
 */
import type { Trace } from '../core/trace.ts';
import { V1, type Engine } from '../core/score.ts';
import { track, type CpParams } from './changepoint.ts';

export type RankForm = 'decay' | 'rrf' | 'earliest' | 'gate';
export interface RankOpts { form: RankForm; tau?: number; beta?: number; rrfK?: number; gap?: number; ratio?: number; dNone?: number }

export interface RankInput {
  services: string[];
  edges: [string, string][];
  base: string[];                       // v1 order
  hard: Set<string>;
  walk: (id: string) => number;
  onset: (id: string) => number | null; // ms, null = not anomalous
}

/** Connected components of the anomalous services in the undirected observed edge graph. */
function components(ids: string[], edges: [string, string][]): Map<string, number> {
  const set = new Set(ids), adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [a, b] of edges) if (set.has(a) && set.has(b) && a !== b) { adj.get(a)!.push(b); adj.get(b)!.push(a); }
  const comp = new Map<string, number>(); let c = 0;
  for (const id of ids) {
    if (comp.has(id)) continue;
    const stack = [id]; comp.set(id, c);
    while (stack.length) { const x = stack.pop()!; for (const y of adj.get(x)!) if (!comp.has(y)) { comp.set(y, c); stack.push(y); } }
    c++;
  }
  return comp;
}

/** Re-rank one moment. PURE. */
export function rankByOnset(x: RankInput, o: RankOpts): string[] {
  const pos = new Map(x.base.map((id, i) => [id, i]));
  const bpos = (id: string) => pos.get(id) ?? x.base.length;
  const byBase = (a: string, b: string) => bpos(a) - bpos(b);
  const hard = x.services.filter((id) => x.hard.has(id)).sort(byBase);
  const rest = x.services.filter((id) => !x.hard.has(id));
  const anom = rest.filter((id) => x.onset(id) !== null);
  const comp = components(anom, x.edges);
  const compMin = new Map<number, number>(), compWalk = new Map<number, number>();
  for (const id of anom) { const c = comp.get(id)!; compMin.set(c, Math.min(compMin.get(c) ?? Infinity, x.onset(id)!)); compWalk.set(c, (compWalk.get(c) ?? 0) + x.walk(id)); }
  const delay = (id: string) => (x.onset(id) === null ? (o.dNone ?? 60) : (x.onset(id)! - compMin.get(comp.get(id)!)!) / 1000);
  const topW = Math.max(1e-9, ...rest.map(x.walk));

  let ordered: string[];
  if (o.form === 'decay') {
    const tau = o.tau ?? 15;
    const s = new Map(rest.map((id) => [id, (x.walk(id) / topW + 0.05) * Math.exp(-delay(id) / tau)]));
    ordered = [...rest].sort((a, b) => s.get(b)! - s.get(a)! || byBase(a, b));
  } else if (o.form === 'rrf') {
    const K = o.rrfK ?? 3, beta = o.beta ?? 1;
    // onset rank within the component: 1 = earliest
    const orank = new Map<string, number>();
    for (const id of anom) orank.set(id, 1 + anom.filter((y) => comp.get(y) === comp.get(id) && x.onset(y)! < x.onset(id)!).length);
    const s = new Map(rest.map((id) => [id, 1 / (K + bpos(id) + 1) + beta / (K + (orank.get(id) ?? rest.length))]));
    ordered = [...rest].sort((a, b) => s.get(b)! - s.get(a)! || byBase(a, b));
  } else if (o.form === 'earliest') {
    const leaders = new Map<number, string>();
    for (const id of [...anom].sort((a, b) => x.onset(a)! - x.onset(b)! || x.walk(b) - x.walk(a) || byBase(a, b))) if (!leaders.has(comp.get(id)!)) leaders.set(comp.get(id)!, id);
    const lead = [...leaders.entries()].sort((a, b) => compWalk.get(b[0])! - compWalk.get(a[0])! || byBase(a[1], b[1])).map((e) => e[1]);
    const ls = new Set(lead);
    ordered = [...lead, ...rest.filter((id) => !ls.has(id)).sort(byBase)];
  } else {
    ordered = [...rest].sort(byBase);
    const top = ordered[0];
    if (top !== undefined && x.onset(top) !== null) {
      const gap = (o.gap ?? 10) * 1000, ratio = o.ratio ?? 0.3;
      const cands = anom.filter((id) => id !== top && comp.get(id) === comp.get(top) && x.onset(id)! <= x.onset(top)! - gap && x.walk(id) >= ratio * x.walk(top));
      if (cands.length) {
        const pick = cands.sort((a, b) => x.onset(a)! - x.onset(b)! || byBase(a, b))[0];
        ordered = [pick, ...ordered.filter((id) => id !== pick)];
      }
    }
  }
  return [...hard, ...ordered];
}

export interface AnomOpts { maxAge?: number; requireV1?: boolean }

/** The onset function of a moment: onset time of anomalous services, null for the others. */
export function onsetAt(t: Trace, i: number, cp: Partial<CpParams>, a: AnomOpts = {}) {
  const row = track(t, cp)[i], m = t.moments[i], maxAge = (a.maxAge ?? 600) * 1000;
  return (id: string): number | null => {
    const c = row[id];
    if (!c || !c.changed || m.ts - c.onset > maxAge) return null;
    if (a.requireV1 && !((m.ml[id]?.[5] ?? 0) > 0 || (m.rules[id] ?? 0) >= 0.5 || (m.ml[id]?.[0] ?? 0) >= 0.5)) return null;
    return c.onset;
  };
}

/** Ranking engine: V1.hybrid's alarm, onset-aware order. */
export function rcaEngine(cp: Partial<CpParams>, o: RankOpts, a: AnomOpts = {}): Engine {
  return (t, i) => {
    const base = V1.hybrid(t, i), m = t.moments[i];
    const ranked = rankByOnset({ services: m.services, edges: m.edges, base: base.ranked, hard: new Set(m.services.filter((id) => m.ml[id]?.[4] === 1)),
      walk: (id) => m.ml[id]?.[5] ?? 0, onset: onsetAt(t, i, cp, a) }, o);
    return { max: base.max, ranked };
  };
}

export interface EarlyOpts { magAlarm: number; persist: number; minServices?: number; maxAlarmAge?: number; metrics?: string[] }

/** Detection engine: V1.hybrid OR a persistent change-point alarm. `rank` decides the order (default V1.hybrid). */
export function earlyEngine(cp: Partial<CpParams>, e: EarlyOpts, rank: Engine = V1.hybrid): Engine {
  return (t, i) => {
    const r = rank(t, i), row = track(t, cp)[i], ts = t.moments[i].ts;
    let hits = 0;
    for (const id of t.moments[i].services) {
      const c = row[id];
      if (!c?.changed || c.mag < e.magAlarm) continue;
      if (e.metrics && c.metric && !e.metrics.includes(c.metric)) continue;
      const age = ts - c.since;
      if (age >= (e.persist - 1) * 5000 - 500 && age <= (e.maxAlarmAge ?? Infinity) * 1000) hits++;
    }
    const cpAlarm = hits >= (e.minServices ?? 1) ? 1 : 0;
    return { max: Math.max(r.max, cpAlarm), ranked: r.ranked };
  };
}
