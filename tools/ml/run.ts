#!/usr/bin/env node
// tools/ml/run.ts: learn how to combine the mapper's signals from labelled fault runs, and prove it on data it did not see.
//
//   node server/node_modules/tsx/dist/cli.mjs tools/ml/run.ts <run-dir> [<run-dir> ...] [--out server/rca/model] [--k 5]
//
// A run dir holds ledger-<subject>.jsonl (injector ground truth) and observed-<subject>.jsonl (what the mapper's API showed,
// recorded by `npm run eval -- observe`). Writes learned.json (weights + threshold, loaded by the server) and results.json.
import fs from 'node:fs';
import path from 'node:path';
import { buildRun, labelledRows, slice, FEATURE_NAMES, type Run } from './dataset.ts';
import { fit, predict, type Model } from './logreg.ts';
import { evaluate, tuneThreshold, type Scores, type EventResult } from './evaluate.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const K = Number(opt('k', '5')), outDir = opt('out', 'server/rca/model');

const runs: Run[] = [];
for (const d of dirs) for (const f of fs.readdirSync(d).filter((x) => /^observed-.*\.jsonl$/.test(x))) {
  const subject = f.replace(/^observed-|\.jsonl$/g, ''), led = path.join(d, `ledger-${subject}.jsonl`);
  if (!fs.existsSync(led)) continue;
  const r = buildRun(`${path.basename(d)}/${subject}`, subject, fs.readFileSync(led, 'utf8'), fs.readFileSync(path.join(d, f), 'utf8'));
  if (r.moments.length && r.faults.length) runs.push(r);
}
if (!runs.length) { console.error('no usable runs (need observed-*.jsonl recorded with metrics, and the matching ledger)'); process.exit(1); }

const idx = (n: string) => FEATURE_NAMES.indexOf(n as any);
const ex = (v: number) => Math.expm1(v);
/** The hand-written rule the mapper used before (unsupervised): own evidence, or symptoms not explained by a broken
 *  dependency, plus a big bonus for container facts. The comparison point for what learning adds. */
const heuristic = (x: number[]) => Math.max(ex(x[idx('own')]), ex(x[idx('symptom')]) - ex(x[idx('calleesEvidenceMax')])) + 10 * Math.max(x[idx('down')], x[idx('paused')], x[idx('restarting')], x[idx('detached')]);

const scorer = (rs: Run[], f: (x: number[]) => number): Scores => (ri, mi) => rs[ri].moments[mi].X.map(f);
const rowsOf = (rs: Run[], keep?: (r: Run, ts: number) => boolean) => {
  const X: number[][] = [], y: number[] = [];
  for (const r of rs) { const d = labelledRows(r, { keep: keep ? (ts) => keep(r, ts) : undefined }); X.push(...d.X); y.push(...d.y); }
  return { X, y };
};
const LAMBDAS = [0.1, 1, 10];
function train(rs: Run[], keep?: (r: Run, ts: number) => boolean): { model: Model; threshold: number } {
  const { X, y } = rowsOf(rs, keep);
  // lambda chosen on the training data by the same event objective used for the threshold
  let best: { model: Model; threshold: number; obj: number } | null = null;
  const trainRuns = keep ? rs.map((r) => ({ ...r, moments: r.moments.filter((m) => keep(r, m.ts)), faults: r.faults.filter((f) => keep(r, f.a)) })) : rs;
  for (const l of LAMBDAS) {
    const model = fit(X, y, FEATURE_NAMES, l);
    const t = tuneThreshold(trainRuns, scorer(trainRuns, (x) => predict(model, x)));
    if (!best || t.objective > best.obj) best = { model, threshold: t.threshold, obj: t.objective };
  }
  return { model: best!.model, threshold: best!.threshold };
}

// ---- blocked K-fold over time, per run: whole faults stay in one fold, the past is never trained on the future's labels only
const blockOf = (r: Run, ts: number) => Math.min(K - 1, Math.floor(((ts - r.t0) / Math.max(1, r.t1 - r.t0 + 1)) * K));
const pooled = { learned: [] as EventResult['faults'], heurFixed: [] as EventResult['faults'], heurTuned: [] as EventResult['faults'], live: [] as EventResult['faults'] };
const fa = { learned: [0, 0], heurFixed: [0, 0], heurTuned: [0, 0], live: [0, 0] };
for (let k = 0; k < K; k++) {
  const keepTrain = (r: Run, ts: number) => blockOf(r, ts) !== k;
  const test = runs.map((r) => { const from = r.t0 + ((r.t1 - r.t0 + 1) * k) / K, to = r.t0 + ((r.t1 - r.t0 + 1) * (k + 1)) / K; return slice(r, from, to); }).filter((r) => r.moments.length);
  if (!test.some((r) => r.faults.length)) continue;
  const { model, threshold } = train(runs, keepTrain);
  const trainRuns = runs.map((r) => ({ ...r, moments: r.moments.filter((m) => keepTrain(r, m.ts)), faults: r.faults.filter((f) => keepTrain(r, f.a)) }));
  const hTuned = tuneThreshold(trainRuns, scorer(trainRuns, heuristic)).threshold;
  const res = {
    learned: evaluate(test, scorer(test, (x) => predict(model, x)), threshold),
    heurFixed: evaluate(test, scorer(test, heuristic), 3),
    heurTuned: evaluate(test, scorer(test, heuristic), hTuned),
    live: evaluate(test, 'live', 0),
  };
  for (const key of Object.keys(res) as (keyof typeof res)[]) { pooled[key].push(...res[key].faults); fa[key][0] += res[key].falseAlarms; fa[key][1] += res[key].fpHours; }
}
const summarise = (fs_: EventResult['faults'], [n, h]: number[]) => {
  const det = fs_.filter((f) => f.detected), d = det.map((f) => f.delaySec!).sort((a, b) => a - b);
  return { faults: fs_.length, detected: det.length / Math.max(1, fs_.length), top1OfDetected: det.filter((f) => f.top1).length / Math.max(1, det.length),
    caughtAndNamed: fs_.filter((f) => f.top1).length / Math.max(1, fs_.length), falseAlarmsPerHour: h ? n / h : 0, medianDelaySec: d[Math.floor(d.length / 2)] ?? null };
};
const cv = Object.fromEntries((Object.keys(pooled) as (keyof typeof pooled)[]).map((k) => [k, summarise(pooled[k], fa[k])]));

// ---- cross-system: train on one bench, test on the other (does it generalise, or did it memorise one system?)
const subjects = [...new Set(runs.map((r) => r.subject))];
const cross: Record<string, any> = {};
if (subjects.length > 1) for (const s of subjects) {
  const tr = runs.filter((r) => r.subject !== s), te = runs.filter((r) => r.subject === s);
  const { model, threshold } = train(tr);
  const e = evaluate(te, scorer(te, (x) => predict(model, x)), threshold), l = evaluate(te, 'live', 0);
  cross[`train ${tr.map((r) => r.subject).join('+')} -> test ${s}`] = { learned: summarise(e.faults, [e.falseAlarms, e.fpHours]), live: summarise(l.faults, [l.falseAlarms, l.fpHours]) };
}

// ---- final model on everything, for the server
const final = train(runs);
fs.mkdirSync(outDir, { recursive: true });
const learned = { kind: 'logistic', trainedAt: new Date().toISOString(), runs: runs.map((r) => r.name), faults: runs.reduce((s, r) => s + r.faults.length, 0),
  threshold: final.threshold, persistence: 2, ...final.model };
fs.writeFileSync(path.join(outDir, 'learned.json'), JSON.stringify(learned, null, 2));
const weights = FEATURE_NAMES.map((f, j) => ({ feature: f, weight: Math.round(final.model.w[j] * 1000) / 1000 })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
const results = { runs: runs.map((r) => ({ name: r.name, moments: r.moments.length, faults: r.faults.length })), k: K, cv, cross, threshold: final.threshold, lambda: final.model.lambda, weights,
  perFault: pooled.learned, perFaultLive: pooled.live };
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ runs: results.runs, cv, cross, threshold: final.threshold, lambda: final.model.lambda, topWeights: weights.slice(0, 8) }, null, 2));
