#!/usr/bin/env node
// tools/ml/run.ts: learn how to combine the mapper's signals from labelled fault runs, and prove it on data it did not see.
//
//   npm run ml -- <run-dir> [<run-dir> ...] [--out server/rca/model] [--k 5] [--install]
//
// A run dir holds ledger-<subject>.jsonl (injector ground truth) and observed-<subject>.jsonl (what the mapper's API showed,
// recorded by `npm run eval -- observe`). Writes results.json (always) and learned.json (only with --install, i.e. when you
// have decided the learned model beats the rules): the server loads learned.json from server/rca/model/.
import fs from 'node:fs';
import path from 'node:path';
import { buildRun, FEATURE_NAMES, type Run } from './dataset.ts';
import { crossSystem, crossValidate, summarise, train, METHODS } from './experiment.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const K = Number(opt('k', '5')), outDir = opt('out', 'server/rca/model'), install = args.includes('--install');

export function loadRuns(dirs: string[]): { runs: Run[]; texts: { name: string; subject: string; ledger: string; observed: string }[] } {
  const runs: Run[] = [], texts: { name: string; subject: string; ledger: string; observed: string }[] = [];
  for (const d of dirs) for (const f of fs.readdirSync(d).filter((x) => /^observed-.*\.jsonl$/.test(x))) {
    const subject = f.replace(/^observed-|\.jsonl$/g, ''), led = path.join(d, `ledger-${subject}.jsonl`);
    if (!fs.existsSync(led)) continue;
    const name = `${path.basename(path.resolve(d))}/${subject}`, ledger = fs.readFileSync(led, 'utf8'), observed = fs.readFileSync(path.join(d, f), 'utf8');
    const r = buildRun(name, subject, ledger, observed);
    if (r.moments.length && r.faults.length) { runs.push(r); texts.push({ name, subject, ledger, observed }); }
  }
  return { runs, texts };
}

if (process.argv[1]?.endsWith('run.ts')) {
  const { runs } = loadRuns(dirs);
  if (!runs.length) { console.error('no usable runs (need observed-*.jsonl recorded with metrics, and the matching ledger)'); process.exit(1); }
  const cvr = crossValidate(runs, K);
  const cv = Object.fromEntries(METHODS.map((m) => [m, summarise(cvr.pooled[m])]));
  const cross = crossSystem(runs);
  const final = train(runs);
  fs.mkdirSync(outDir, { recursive: true });
  const learned = { kind: 'logistic', trainedAt: new Date().toISOString(), runs: runs.map((r) => r.name), faults: runs.reduce((s, r) => s + r.faults.length, 0),
    threshold: final.threshold, persistence: 2, ...final.model };
  const weights = FEATURE_NAMES.map((f, j) => ({ feature: f, weight: Math.round(final.model.w[j] * 1000) / 1000 })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const results = { runs: runs.map((r) => ({ name: r.name, moments: r.moments.length, faults: r.faults.length })), k: K, cv, cross, threshold: final.threshold, lambda: final.model.lambda, weights, perFault: cvr.pooled.learned.faults, perFaultLive: cvr.pooled.live.faults };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  if (install) fs.writeFileSync(path.join(outDir, 'learned.json'), JSON.stringify(learned, null, 2));
  console.log(JSON.stringify({ runs: results.runs, cv, cross, threshold: final.threshold, lambda: final.model.lambda, topWeights: weights.slice(0, 8), installed: install }, null, 2));
}
