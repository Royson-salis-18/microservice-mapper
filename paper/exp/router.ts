#!/usr/bin/env node
/**
 * paper/exp/router.ts: does ranking by the rule layer when no container fact holds (and by the ML walk when one does) help?
 * Chosen on the tuning traces (tune + tune2), then scored once on the held-out synthetic traces and the real traces.
 */
import { loadTraces, type Trace } from '../../v2/core/trace.ts';
import { score, V1, line, HEADER, type Engine } from '../../v2/core/score.ts';

const root = '/home/user/Downloads/profesional-ui-final-/v2/.cache/';
const tune = [...loadTraces(root + 'tune.json'), ...loadTraces(root + 'tune2.json')], test = loadTraces(root + 'test.json'), real = loadTraces(root + 'real.json');

/** Ranking by the rule score alone (facts first). */
const rulesRank = (t: Trace, i: number): string[] => {
  const m = t.moments[i], hard = (id: string) => (m.ml[id]?.[4] === 1 ? 1 : 0);
  return [...m.services].sort((x, y) => hard(y) - hard(x) || (m.rules[y] ?? 0) - (m.rules[x] ?? 0) || (m.ml[y]?.[0] ?? 0) - (m.ml[x]?.[0] ?? 0) || x.localeCompare(y));
};
const router = (w: number): Engine => (t, i) => {
  const base = V1.hybrid(t, i), m = t.moments[i];
  const anyFact = m.services.some((id) => m.ml[id]?.[4] === 1);
  if (anyFact) return base;
  if (w >= 1) return { max: base.max, ranked: rulesRank(t, i) };
  // blend: w * rule rank score + (1 - w) * walk share, both scaled to their maximum
  const rs = m.services.map((id) => m.rules[id] ?? 0), ws = m.services.map((id) => m.ml[id]?.[5] ?? 0);
  const rm = Math.max(1e-9, ...rs), wm = Math.max(1e-9, ...ws);
  const sc = new Map(m.services.map((id, k) => [id, w * rs[k] / rm + (1 - w) * ws[k] / wm]));
  return { max: base.max, ranked: [...m.services].sort((x, y) => sc.get(y)! - sc.get(x)! || x.localeCompare(y)) };
};
const grid: [string, Engine][] = [['v1 hybrid (ML ranking)', V1.hybrid], ['router: rules rank when no fact', router(1)], ['router: blend 0.5', router(0.5)], ['router: blend 0.25', router(0.25)], ['router: blend 0.75', router(0.75)]];
for (const [name, set] of [['tune (tune+tune2)', tune], ['test (held out)', test], ['real', real]] as const) {
  console.log(`\n== ${name} ==\n${HEADER}`);
  for (const [n, e] of grid) { const s = score(set as Trace[], e); console.log(line(n, s)); }
}
