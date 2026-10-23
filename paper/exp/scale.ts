#!/usr/bin/env node
/**
 * paper/exp/scale.ts: cost of one five-second decision window against the number of services.
 *
 *   node server/node_modules/tsx/dist/cli.mjs paper/exp/scale.ts
 *
 * For each size N a random call graph (about 1.3 N edges, entry point, services, stores) is fed synthetic readings. After a
 * warm-up long enough for every service to have trained models, the cost of 120 further windows is timed in three parts:
 * the per-service detectors plus facts plus walk (MLEngine.step), the random walk alone, and the cascade risk alone. The
 * same is repeated for each detector. Single core, one process, wall-clock milliseconds per window (mean and p95).
 * Writes paper/data/scale.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MLEngine, ENGINE_DEFAULTS, resolveDirections } from '../../server/algorithms/ml/mlEngine.ts';
import { rootCauseWalk } from '../../server/algorithms/ml/randomWalk.ts';
import { PropagationModel } from '../../server/algorithms/ml/propagation.ts';
import { rng } from '../../server/algorithms/ml/isolationForest.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const SIZES = [10, 20, 40, 80, 160, 320];
const DETECTORS = ['iforest', 'knn', 'mahalanobis', 'hbos', 'ensemble', 'load', 'pca'] as const;      // the first five are the old per-service forest family; load and pca are the load-aware models

function topology(n: number, seed: number) {
  const r = rng(seed);
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i === 0 ? 'gateway' : i > n * 0.75 ? `store-${i}` : `svc-${i}`, name: i === 0 ? 'gateway' : i > n * 0.75 ? `store-${i}` : `svc-${i}` }));
  const edges: { source: string; target: string }[] = [];
  for (let i = 1; i < n; i++) { const j = Math.floor(r() * i); edges.push({ source: nodes[j].id, target: nodes[i].id }); if (r() < 0.3) { const k = Math.floor(r() * i); if (k !== j) edges.push({ source: nodes[k].id, target: nodes[i].id }); } }
  return { nodes, edges };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const out: any = { sizes: SIZES, detectors: {}, walk: {}, cascade: {}, edges: {} };
for (const n of SIZES) {
  const { nodes, edges } = topology(n, 7 + n);
  out.edges[n] = edges.length;
  const dirs = resolveDirections(edges, (id) => nodes.find((x) => x.id === id));
  const ids = nodes.map((x) => x.id), a = new Map(ids.map((id, i) => [id, i % 7 === 0 ? 0.8 : 0.05]));
  // walk alone
  const wt: number[] = [];
  for (let k = 0; k < 50; k++) { const t0 = performance.now(); rootCauseWalk(ids, a, dirs); wt.push(performance.now() - t0); }
  out.walk[n] = { mean: mean(wt), p95: p95(wt) };
  // cascade alone
  const pm = new PropagationModel(); const ab = new Set(ids.filter((_, i) => i % 7 === 0));
  const callersOf = (id: string) => dirs.filter((e) => e.to === id).map((e) => e.from), calleesOf = (id: string) => dirs.filter((e) => e.from === id).map((e) => e.to);
  const ct: number[] = [];
  for (let k = 0; k < 50; k++) { const t0 = performance.now(); pm.risk(ids[1], ab, callersOf, calleesOf); ct.push(performance.now() - t0); }
  out.cascade[n] = { mean: mean(ct), p95: p95(ct) };
  for (const det of DETECTORS) {
    if (!['iforest', 'load', 'pca'].includes(det) && n > 160) continue;                               // the distance-based detectors are not meant for this size
    const r = rng(11 + n);
    const engine = new MLEngine(det === 'load' || det === 'pca' ? { ...ENGINE_DEFAULTS, levels: det } as any : { ...ENGINE_DEFAULTS, levels: 'forest', baseline: { ...ENGINE_DEFAULTS.baseline, detector: det } } as any);
    const reading = (i: number) => ({ timestamp: '', cpu: 10 + gauss(r) * 0.5, memoryPercent: 30 + gauss(r) * 0.3, networkRxRate: 5000 * (1 + 0.1 * gauss(r)), networkTxRate: 4000 * (1 + 0.1 * gauss(r)), requestRate: 20 + gauss(r), requestCount: 200, errorRate: 0, p95Latency: 40 + gauss(r), cpuThrottledPct: 0, restartDelta: 0 });
    const step = () => engine.step(nodes, edges, new Map(ids.map((id, i) => [id, [reading(i)]])) as any);
    const warm = 45; for (let k = 0; k < warm; k++) step();
    const heap0 = process.memoryUsage().heapUsed;
    const ts: number[] = [];
    for (let k = 0; k < 120; k++) { const t0 = performance.now(); step(); ts.push(performance.now() - t0); }
    (out.detectors[det] ??= {})[n] = { mean: mean(ts), p95: p95(ts), heapMB: Math.max(0, (process.memoryUsage().heapUsed - heap0) / 1e6) };
    console.log(`N=${String(n).padStart(3)} ${det.padEnd(12)} ${mean(ts).toFixed(2)} ms/window (p95 ${p95(ts).toFixed(2)})  walk ${out.walk[n].mean.toFixed(3)} ms  cascade ${out.cascade[n].mean.toFixed(3)} ms`);
  }
}
fs.writeFileSync(path.join(root, 'paper/data/scale.json'), JSON.stringify(out));
console.log('wrote paper/data/scale.json');
