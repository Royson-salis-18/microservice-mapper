#!/usr/bin/env node
/**
 * paper/exp/cascade.ts: data for the cascade-prediction figures (reliability diagram, ROC, precision-recall).
 *
 *   node server/node_modules/tsx/dist/cli.mjs paper/exp/cascade.ts
 *
 * At the first alarm of every fault, each service that is still healthy gets a probability from each predictor, and the
 * outcome is whether it turned unhealthy before the fault ended. Predictors:
 *   learned    the online Beta-Binomial propagation model (server/algorithms/ml/propagation.ts), noisy-OR from the suspect
 *   fixed      the same noisy-OR with every edge fixed at p = 0.7 (topology only, no learning)
 *   live       the risk values the shipped mapper recorded in its incident (real runs only)
 * Writes paper/data/cascade.json with one (fault, probability..., outcome) row per healthy service per fault.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns } from '../../run/cli/ml/run.ts';
import { replayEach } from '../../server/algorithms/ml/replay.ts';
import { resolveDirections } from '../../server/algorithms/ml/mlEngine.ts';
import { PropagationModel } from '../../server/algorithms/ml/propagation.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const SETS: Record<string, string[]> = {
  real: [path.join(root, 'run/recorded-runs/runC')],
  test: fs.readdirSync(path.join(root, 'run/synthetic-runs/test')).sort().map((d) => path.join(root, 'run/synthetic-runs/test', d)),
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fixed = new PropagationModel({ windowSteps: 12, prior: 0.7, priorWeight: 1e9 });   // never moves off 0.7

const out: any = { sets: {} };
for (const [setName, dirs] of Object.entries(SETS)) {
  const rows: { f: string; learned: number; fixed: number; live: number | null; y: number }[] = [];
  const { runs, texts } = loadRuns(dirs);
  runs.forEach((run, ri) => {
    const ms: { ts: number; hot: boolean; top: string; risk: Map<string, number>; status: Record<string, string>; anomalous: Set<string>; edges: [string, string][]; live: Map<string, number> | null }[] = [];
    replayEach(texts[ri].observed, texts[ri].subject, {}, (r, services, s) => {
      const inc = s.incidents?.[0];
      ms.push({ ts: s.ts, hot: r.hot, top: r.ranked[0], risk: r.atRisk, status: s.status, anomalous: new Set([...r.services].filter(([, v]) => v.anomaly > 0).map(([id]) => id)), edges: s.edges ?? [],
        live: inc ? new Map((inc.atRisk ?? []).map((a: any) => [a.id, a.risk])) : (run.moments[ms.length]?.live.alarm ? new Map() : null) });
    });
    for (const f of run.faults) {
      const idx = ms.map((_, i) => i).filter((i) => ms[i].ts >= f.a && ms[i].ts <= f.b);
      const k = idx.find((i) => i > 0 && ms[i].hot && ms[i - 1].hot);
      if (k === undefined) continue;
      const m = ms[k];
      const healthyNow = (id: string) => (m.status[id] ?? 'healthy') === 'healthy' && !m.anomalous.has(id) && id !== 'traffic';
      const ids = Object.keys(m.status).filter(healthyNow);
      const nodes = new Map(ids.concat([m.top]).map((id) => [id, { id, name: id }]));
      const dir = resolveDirections(m.edges.filter(([a, b]) => nodes.has(a) && nodes.has(b)).map(([source, target]) => ({ source, target })), (id) => nodes.get(id));
      const callersOf = (id: string) => dir.filter((e) => e.to === id).map((e) => e.from), calleesOf = (id: string) => dir.filter((e) => e.from === id).map((e) => e.to);
      const fx = fixed.risk(m.top, m.anomalous, callersOf, calleesOf);
      const hit = new Set<string>();
      for (const i of idx) if (i > k) for (const [id, st] of Object.entries(ms[i].status)) if (id !== f.target && id !== 'traffic' && st !== 'healthy' && healthyNow(id)) hit.add(id);
      for (const id of ids) {
        if (id === f.target) continue;
        rows.push({ f: `${run.name}:${f.id}`, learned: r3(m.risk.get(id) ?? 0), fixed: r3(fx.get(id) ?? 0), live: m.live ? r3(m.live.get(id) ?? 0) : null, y: hit.has(id) ? 1 : 0 });
      }
    }
  });
  out.sets[setName] = { rows, faults: new Set(rows.map((r) => r.f)).size };
  const pos = rows.filter((r) => r.y).length;
  console.log(setName, 'faults', out.sets[setName].faults, 'predictions', rows.length, 'positives', pos);
}
fs.writeFileSync(path.join(root, 'paper/data/cascade.json'), JSON.stringify(out));
console.log('wrote paper/data/cascade.json');
