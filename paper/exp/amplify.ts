#!/usr/bin/env node
/**
 * paper/exp/amplify.ts: the amplification-regime study. Soft faults only (brownout, latency, memory); callers feel a fault
 * `amplify` times more strongly than its source, as under retry storms. Same alarms for every ranker (the hybrid's), only
 * the order differs. Per fault: detected, rank of the true cause, and whether some victim is louder than the cause.
 *
 *   node server/node_modules/tsx/dist/cli.mjs paper/exp/amplify.ts      (needs v2/.cache/amp_<level>.json)
 */
import fs from 'node:fs';
import { loadTraces, type Trace } from '../../v2/core/trace.ts';
import { V1, type Engine } from '../../v2/core/score.ts';
import { causalEngine } from '../../v2/causal/rca.ts';

const LEVELS = [1, 1.5, 2, 3, 4];
const severity: Engine = (t, i) => { const m = t.moments[i], b = V1.hybrid(t, i); const hard = (id: string) => (m.ml[id]?.[4] === 1 ? 1 : 0);
  return { max: b.max, ranked: [...m.services].sort((x, y) => hard(y) - hard(x) || (m.ml[y]?.[3] ?? 0) - (m.ml[x]?.[3] ?? 0) || (m.ml[y]?.[0] ?? 0) - (m.ml[x]?.[0] ?? 0) || x.localeCompare(y)) }; };
const rulesRank: Engine = (t, i) => { const m = t.moments[i], b = V1.hybrid(t, i); const hard = (id: string) => (m.ml[id]?.[4] === 1 ? 1 : 0);
  return { max: b.max, ranked: [...m.services].sort((x, y) => hard(y) - hard(x) || (m.rules[y] ?? 0) - (m.rules[x] ?? 0) || (m.ml[y]?.[0] ?? 0) - (m.ml[x]?.[0] ?? 0) || x.localeCompare(y)) }; };
const learned: Engine = (() => { const e = causalEngine({ directions: 'learned' }); return (t, i) => ({ max: V1.hybrid(t, i).max, ranked: e(t, i).ranked }); })();
const ENG: Record<string, Engine> = { 'hybrid (walk)': V1.hybrid, 'severity (anomaly only)': severity, 'rule decomposition': rulesRank, 'walk, learned directions': learned };

function study(traces: Trace[]) {
  const out: Record<string, { detected: boolean; rank: number | null }[]> = Object.fromEntries(Object.keys(ENG).map((k) => [k, []]));
  const louder: number[] = [];
  for (const t of traces) {
    const cache = new Map<string, ReturnType<Engine>[]>();
    for (const [k, e] of Object.entries(ENG)) cache.set(k, t.moments.map((_, i) => e(t, i)));
    const base = cache.get('hybrid (walk)')!;
    const alarm = base.map((x, i) => x.max >= 1 && i > 0 && base[i - 1].max >= 1);
    for (const f of t.faults) {
      const touches = new Set([f.target, ...f.affected]);
      let first = -1, settled = -1;
      for (let i = 0; i < t.moments.length; i++) {
        const ts = t.moments[i].ts; if (ts < f.a || ts > f.b + 60000 || !alarm[i]) continue;
        if (!base[i].ranked.slice(0, 3).some((x) => touches.has(x))) continue;       // detection is the hybrid's, identical for every ranker
        if (first < 0) first = i; if (ts <= f.b) settled = i;
      }
      for (const [k, v] of cache) { const j = settled >= 0 ? v[settled].ranked.indexOf(f.target) : -1; out[k].push({ detected: first >= 0, rank: first >= 0 ? (j >= 0 ? j + 1 : 99) : null }); }
      if (settled >= 0) { const m = t.moments[settled]; const own = m.ml[f.target]?.[0] ?? 0; louder.push(f.affected.some((a) => (m.ml[a]?.[0] ?? 0) > own) ? 1 : 0); }
    }
  }
  return { engines: out, louderShare: louder.length ? louder.reduce((a, b) => a + b, 0) / louder.length : 0, faults: out['hybrid (walk)'].length };
}
const res: any = { levels: LEVELS, byLevel: {} };
for (const a of LEVELS) { const p = `v2/.cache/amp_${a}.json`; if (!fs.existsSync(p)) continue; res.byLevel[a] = study(loadTraces(p));
  const e = res.byLevel[a].engines; console.log(`amplify ${a}: faults ${res.byLevel[a].faults}, victim louder in ${(res.byLevel[a].louderShare * 100).toFixed(0)}% of detected; C+N ` + Object.entries(e).map(([k, v]: any) => `${k} ${(v.filter((x: any) => x.detected && x.rank === 1).length / v.length * 100).toFixed(0)}%`).join(', ')); }
fs.writeFileSync('paper/data/amplify.json', JSON.stringify(res));
