#!/usr/bin/env node
/**
 * paper/exp/detroc.ts: service-level detection ROC and precision-recall for each unsupervised detector.
 *
 *   node server/node_modules/tsx/dist/cli.mjs paper/exp/detroc.ts <detector|rules> <real|test>
 *
 * Every (service, moment) is one example. Positive: the service is the target of a fault that is active at that moment (services that
 * could merely be affected are left out: whether they visibly change depends on protection the ledger does not record). Negative: no fault is active anywhere (and none ended in the last minute). Examples where a
 * container fact holds are left out: facts are identical for every detector, so they would only inflate every curve equally.
 * Detectors: iforest, knn, mahalanobis, hbos, ensemble (the old per-service forest family), load, control, pca (the load-aware models), rules.
 * The score is the service's level. Writes paper/data/roc_<detector>_<set>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns } from '../../run/cli/ml/run.ts';
import { replayEach } from '../../server/algorithms/ml/replay.ts';
import { loadTraces } from '../../v2/core/trace.ts';

const [det, setName] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..', '..');
const dirs = setName === 'real' ? [path.join(root, 'run/recorded-runs/runC')] : fs.readdirSync(path.join(root, 'run/synthetic-runs/test')).sort().map((d) => path.join(root, 'run/synthetic-runs/test', d));
const DETERMINISTIC = new Set(['rules', 'load', 'control', 'pca']);      // no random trees: one pass is the whole answer
const seeds = DETERMINISTIC.has(det) ? [0] : [0, 1, 2];

type Ex = { s: number; y: number };
function curve(ex: Ex[]) {
  const sorted = [...ex].sort((a, b) => b.s - a.s);
  const P = sorted.filter((e) => e.y).length, N = sorted.length - P;
  let tp = 0, fp = 0, auc = 0, ap = 0, prevF = 0, prevT = 0, prevTp = 0;
  const roc: [number, number][] = [[0, 0]], pr: [number, number][] = [];
  const step = Math.max(1, Math.floor(sorted.length / 220));
  sorted.forEach((e, i) => {
    if (e.y) { tp++; ap += tp / (tp + fp) / P; } else fp++;
    const f = fp / N, t = tp / P;
    auc += (f - prevF) * (t + prevT) / 2; prevF = f; prevT = t;
    if (i % step === 0 || i === sorted.length - 1) { roc.push([f, t]); pr.push([t, tp / (tp + fp)]); }
  });
  return { auroc: auc, ap, roc, pr, P, N };
}

const { runs, texts } = loadRuns(dirs);
const perSeed: any[] = [];
for (const seed of seeds) {
  const ex: Ex[] = [];
  const traces = det === 'rules' ? loadTraces(path.join(root, setName === 'real' ? 'v2/.cache/real.json' : 'v2/.cache/test.json')) : null;
  runs.forEach((run, ri) => {
    const clean = (ts: number) => !run.faults.some((f) => ts >= f.a && ts <= f.b + 60000);
    const involved = (id: string, ts: number) => run.faults.some((f) => ts >= f.a && ts <= f.b && f.target === id);
    const active = (ts: number) => run.faults.some((f) => ts >= f.a && ts <= f.b);
    if (traces) {
      const t = traces[ri];
      t.moments.forEach((m) => {
        if (m.ts < t.t0 + 300000) return;
        for (const id of m.services) { if (m.ml[id]?.[4] === 1) continue; const y = involved(id, m.ts) ? 1 : 0; if (y || clean(m.ts)) ex.push({ s: Math.min(m.rules[id] ?? 0, 20), y }); }
      });
      return;
    }
    // the four forest-family detectors run on the old per-service forest; load, control and pca are the load-aware models
    const params: any = det === 'load' ? { levels: 'load' } : det === 'control' ? { levels: 'load', load: { mode: 'control' } } : det === 'pca' ? { levels: 'pca' }
      : { levels: 'forest', baseline: { detector: det, seed } };
    replayEach(texts[ri].observed, texts[ri].subject, params, (r, services, s) => {
      if (s.ts < run.t0 + 300000) return;
      for (const id of services) { const v = r.services.get(id); if (!v || v.hard || !v.ready) continue; const y = involved(id, s.ts) ? 1 : 0; if (y || (clean(s.ts) && !active(s.ts))) ex.push({ s: Math.min(v.level, 20), y }); }
    });
  });
  perSeed.push(curve(ex));
  console.log(det, setName, 'seed', seed, 'auroc', perSeed.at(-1).auroc.toFixed(3), 'ap', perSeed.at(-1).ap.toFixed(3), 'P', perSeed.at(-1).P, 'N', perSeed.at(-1).N);
}
const mean = (f: (c: any) => number) => perSeed.reduce((a, c) => a + f(c), 0) / perSeed.length;
const sd = (f: (c: any) => number) => { const m = mean(f); return Math.sqrt(perSeed.reduce((a, c) => a + (f(c) - m) ** 2, 0) / perSeed.length); };
fs.writeFileSync(path.join(root, `paper/data/roc_${det}_${setName}.json`), JSON.stringify({ det, set: setName, auroc: mean((c) => c.auroc), aurocSd: sd((c) => c.auroc), ap: mean((c) => c.ap), apSd: sd((c) => c.ap), roc: perSeed[0].roc, pr: perSeed[0].pr, P: perSeed[0].P, N: perSeed[0].N }));
