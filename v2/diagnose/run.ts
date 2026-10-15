/**
 * v2 diagnose: train fault-type classifiers on the synthetic training campaigns and report them once on held-out data.
 *
 *   train      v2/.cache/tune.json + tune2.json (16 synthetic campaigns). All settings are picked here, by
 *              leave-one-campaign-out cross-validation (LOCO), scored by macro-F1 on the pipeline rows.
 *   test       v2/.cache/test.json (synthetic, held out). Reported once.
 *   real       v2/.cache/real.json (2 recorded bench runs). Reported once as a cross-domain test, plus a
 *              leave-one-run-out check inside the real data.
 *
 * Rows:  pipeline = the v1 hybrid's own suspect at its first alarm (what an operator would get),
 *        oracle   = the true target at the same moment (separates "wrong suspect" from "wrong class").
 * Settings picked by CV per model and per N: hyperparameters, and which rows to train on (pipeline, oracle or both).
 *
 *   node server/node_modules/tsx/dist/cli.mjs v2/diagnose/run.ts            writes v2/diagnose/results.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTraces, type Trace } from '../core/trace.ts';
import { buildDataset, FEATURE_NAMES, type Row } from './features.ts';
import { trainRules, trainKnn, trainNaiveBayes, trainTree, trainForest, evaluate, buildTree, splitCounts, rng, type Trainer, type Report } from './models.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '..', '.cache');
const NS = [0, 6, 12];
const CLASSES = ['crash', 'stop', 'pause', 'crash-loop', 'flap', 'memory', 'brownout', 'latency', 'partition'];
type TrainRows = 'pipeline' | 'oracle' | 'both';

interface Candidate { family: string; setting: string; make: () => Trainer }
const D = FEATURE_NAMES.length;
const CANDIDATES: Candidate[] = [
  { family: 'rules', setting: 'fixed', make: () => trainRules },
  ...[1, 3, 5, 7, 9].map((k) => ({ family: 'knn', setting: `k=${k}`, make: () => trainKnn(k) })),
  ...[1e-3, 1e-2, 1e-1, 1].map((s) => ({ family: 'nb', setting: `smooth=${s}`, make: () => trainNaiveBayes(s) })),
  ...[3, 4, 5, 6, 8].flatMap((d) => [1, 2, 4].map((m) => ({ family: 'tree', setting: `depth=${d},minLeaf=${m}`, make: () => trainTree({ maxDepth: d, minLeaf: m }) }))),
  ...[6, 10].flatMap((d) => [Math.round(Math.sqrt(D)), Math.round(D / 3)].map((mtry) => ({ family: 'forest', setting: `trees=150,depth=${d},mtry=${mtry}`, make: () => trainForest({ trees: 150, maxDepth: d, minLeaf: 1, mtry, seed: 7 }) }))),
];
const FAMILIES = ['rules', 'knn', 'nb', 'tree', 'forest'];

function load(file: string): Trace[] {
  const p = path.join(CACHE, file);
  return loadTraces(p);
}

interface Sets { pipe: Row[]; oracle: Row[] }
function sets(traces: Trace[], n: number): Sets & { undetected: number; faults: number } {
  const p = buildDataset(traces, n, 'pipeline');
  const o = buildDataset(traces, n, 'oracle');
  return { pipe: p.rows, oracle: o.rows, undetected: p.undetected.length, faults: p.rows.length + p.undetected.length };
}
const pick = (s: Sets, which: TrainRows) => (which === 'pipeline' ? s.pipe : which === 'oracle' ? s.oracle : [...s.pipe, ...s.oracle]);
const fitPredict = (tr: Trainer, train: Row[], test: Row[]) => {
  const m = tr(train.map((r) => r.x), train.map((r) => r.y));
  return test.map((r) => m.predict(r.x));
};

/** Leave-one-campaign-out on the training set: pooled predictions over all held-out campaigns. */
function loco(train: Sets, cand: Candidate, which: TrainRows): Report {
  const groups = [...new Set(train.pipe.map((r) => r.group))];
  const truth: string[] = [], pred: string[] = [];
  for (const g of groups) {
    const fold = pick(train, which).filter((r) => r.group !== g);
    const held = train.pipe.filter((r) => r.group === g);
    truth.push(...held.map((r) => r.y));
    pred.push(...fitPredict(cand.make(), fold, held));
  }
  return evaluate(truth, pred, CLASSES);
}

const pct = (x: number) => `${(100 * x).toFixed(1)}`.padStart(5);
function confusionTable(r: Report): string {
  const labs = r.labels.filter((l) => r.confusion[r.labels.indexOf(l)].some((v) => v) || r.confusion.some((row) => row[r.labels.indexOf(l)]));
  const short = (l: string) => l.replace('crash-loop', 'c-loop').replace('partition', 'partit').replace('brownout', 'brown').replace('latency', 'laten').replace('memory', 'mem');
  const head = 'truth \\ pred'.padEnd(12) + labs.map((l) => short(l).padStart(7)).join('');
  const rows = labs.map((l) => short(l).padEnd(12) + labs.map((p) => String(r.confusion[r.labels.indexOf(l)][r.labels.indexOf(p)] || '.').padStart(7)).join(''));
  return [head, ...rows].join('\n');
}

function main() {
  const t0 = Date.now();
  const trainTraces = [...load('tune.json'), ...load('tune2.json')];
  const testTraces = load('test.json');
  const realTraces = load('real.json');
  const results: any = { features: FEATURE_NAMES, ns: NS, cv: {}, chosen: {}, test: {}, real: {}, realLoro: {}, detection: {}, splits: {} };

  for (const n of NS) {
    const train = sets(trainTraces, n), test = sets(testTraces, n), real = sets(realTraces, n);
    if (n === NS[0]) {
      for (const [name, s] of [['train', train], ['test', test], ['real', real]] as const) {
        results.detection[name] = { faults: s.faults, detected: s.pipe.length, suspectRight: s.pipe.filter((r) => r.suspectOk).length };
        console.log(`${name.padEnd(6)} faults ${s.faults}, detected by v1 hybrid ${s.pipe.length}, right suspect ${s.pipe.filter((r) => r.suspectOk).length}`);
      }
    }
    console.log(`\n=== N = ${n} (reading up to ${n * 5} s after the alarm) ===`);
    // 1) model selection by LOCO on the training set
    results.cv[n] = {};
    results.chosen[n] = {};
    for (const fam of FAMILIES) {
      let best: { cand: Candidate; which: TrainRows; r: Report } | null = null;
      for (const cand of CANDIDATES.filter((c) => c.family === fam)) {
        for (const which of (fam === 'rules' ? ['pipeline'] : ['pipeline', 'oracle', 'both']) as TrainRows[]) {
          const r = loco(train, cand, which);
          results.cv[n][`${fam} ${cand.setting} train=${which}`] = { accuracy: r.accuracy, macroF1: r.macroF1 };
          if (!best || r.macroF1 > best.r.macroF1 + 1e-9) best = { cand, which, r };
        }
      }
      results.chosen[n][fam] = { setting: best!.cand.setting, trainRows: best!.which, cvAccuracy: best!.r.accuracy, cvMacroF1: best!.r.macroF1 };
    }
    // 2) fit once on all training data, report once on test and real
    results.test[n] = {};
    results.real[n] = {};
    results.realLoro[n] = {};
    console.log(`${'model'.padEnd(8)} ${'setting (picked by CV)'.padEnd(38)} | CV acc  F1 | test acc  F1 | test-oracle acc  F1 | real acc  F1 | real-oracle acc  F1`);
    for (const fam of FAMILIES) {
      const ch = results.chosen[n][fam];
      const cand = CANDIDATES.find((c) => c.family === fam && c.setting === ch.setting)!;
      const trainRows = pick(train, ch.trainRows);
      const model = cand.make()(trainRows.map((r) => r.x), trainRows.map((r) => r.y));
      const out: Record<string, Report & { pred?: string[] }> = {};
      for (const [key, rows] of [['test', test.pipe], ['testOracle', test.oracle], ['real', real.pipe], ['realOracle', real.oracle]] as const) {
        const pred = rows.map((r) => model.predict(r.x));
        out[key] = evaluate(rows.map((r) => r.y), pred, CLASSES);
        // end to end: right suspect AND right class, over all faults (undetected count as misses)
        if (key === 'test' || key === 'real') {
          const both = rows.filter((r, i) => r.suspectOk && pred[i] === r.y).length;
          const all = key === 'test' ? test.faults : real.faults;
          (out[key] as any).endToEnd = { rightSuspectAndClass: both, faults: all, share: both / all };
          (out[key] as any).accRightSuspect = (() => { const ok = rows.map((r, i) => [r, pred[i]] as const).filter(([r]) => r.suspectOk); return ok.length ? ok.filter(([r, p]) => p === r.y).length / ok.length : 0; })();
          (out[key] as any).accWrongSuspect = (() => { const ok = rows.map((r, i) => [r, pred[i]] as const).filter(([r]) => !r.suspectOk); return ok.length ? ok.filter(([r, p]) => p === r.y).length / ok.length : 0; })();
        }
      }
      results.test[n][fam] = { pipeline: out.test, oracle: out.testOracle };
      results.real[n][fam] = { pipeline: out.real, oracle: out.realOracle };
      console.log(`${fam.padEnd(8)} ${`${ch.setting} train=${ch.trainRows}`.padEnd(38)} | ${pct(ch.cvAccuracy)} ${pct(ch.cvMacroF1)} | ${pct(out.test.accuracy)} ${pct(out.test.macroF1)} | ${pct(out.testOracle.accuracy)}      ${pct(out.testOracle.macroF1)} | ${pct(out.real.accuracy)} ${pct(out.real.macroF1)} | ${pct(out.realOracle.accuracy)}      ${pct(out.realOracle.macroF1)}`);

      // 3) leave-one-run-out inside the real data (settings fixed from the synthetic CV, nothing tuned here)
      const runs = [...new Set(real.pipe.map((r) => r.group))];
      const loro: Record<string, { truth: string[]; pred: string[] }> = { realOnly: { truth: [], pred: [] }, synthPlusReal: { truth: [], pred: [] } };
      for (const g of runs) {
        const heldOut = real.pipe.filter((r) => r.group === g);
        const otherReal = pick({ pipe: real.pipe.filter((r) => r.group !== g), oracle: real.oracle.filter((r) => r.group !== g) }, ch.trainRows);
        for (const [k, tr] of [['realOnly', otherReal], ['synthPlusReal', [...trainRows, ...otherReal]]] as const) {
          if (new Set(tr.map((r) => r.y)).size < 2) continue;
          loro[k].truth.push(...heldOut.map((r) => r.y));
          loro[k].pred.push(...fitPredict(cand.make(), tr, heldOut));
        }
      }
      results.realLoro[n][fam] = Object.fromEntries(Object.entries(loro).map(([k, v]) => [k, evaluate(v.truth, v.pred, CLASSES)]));
    }
    console.log('leave-one-run-out inside real (pipeline rows):');
    for (const fam of FAMILIES) {
      const l = results.realLoro[n][fam];
      console.log(`  ${fam.padEnd(8)} real only: acc ${pct(l.realOnly.accuracy)} F1 ${pct(l.realOnly.macroF1)}   synthetic + other real run: acc ${pct(l.synthPlusReal.accuracy)} F1 ${pct(l.synthPlusReal.macroF1)}`);
    }
    // which features the trees lean on (a single CART on all training rows, and the forest's split counts)
    const ch = results.chosen[n].tree;
    const tr = pick(train, ch.trainRows);
    const [d, m] = ch.setting.match(/\d+/g)!.map(Number);
    const root = buildTree(tr.map((r) => r.x), tr.map((r) => r.y), tr.map((_, i) => i), { maxDepth: d, minLeaf: m }, rng(1));
    results.splits[n] = [...splitCounts(root)].sort((a, b) => b[1] - a[1]).map(([f, c]) => [FEATURE_NAMES[f], c]);
  }

  // confusion matrices of the forest at the largest N (and the rules for comparison)
  const nMax = NS[NS.length - 1];
  for (const fam of ['rules', 'forest']) {
    for (const where of ['test', 'real'] as const) {
      for (const kind of ['pipeline', 'oracle'] as const) {
        console.log(`\nconfusion, ${fam}, ${where}, ${kind} suspect, N = ${nMax}`);
        console.log(confusionTable(results[where][nMax][fam][kind]));
      }
    }
  }
  console.log('\nsplits in the single CART tree (N = 12):', results.splits[nMax].map(([f, c]: [string, number]) => `${f}:${c}`).join(' '));
  fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`\nwrote v2/diagnose/results.json in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main();
