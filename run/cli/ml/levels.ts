#!/usr/bin/env node
// run/cli/ml/levels.ts: which model of "normal" should the ML engine use? Every candidate is unsupervised (it never sees a
// label), learns from live telemetry only (nothing installed on the hosts), and is judged on three kinds of recording:
//
//   real      the 62 recorded faults of runC (ShopFlow + LedgerLine), the evaluation of the paper
//   live      the 168 faults of the live Fault Lab runs (auto-restart on/off, seed 11, both benches)
//   synthetic 16 simulated topologies with 12 campaigns of injected faults (npm run ml:synth)
//   steps     steady load held at 2, 8, 2, 0, 20, 2 concurrent visitors, no faults (run/scripts/workload-steps-experiment.sh)
//   workload  recordings with NO fault at all: traffic runs, stops, runs, stops longer, runs. Every alarm is a false alarm.
//
//   npm run ml:levels                     the headline table
//   npm run ml:levels -- --sweep          also sweep the load model's settings
import fs from 'node:fs';
import path from 'node:path';
import { buildRun, type Run } from '../../../server/algorithms/learning/dataset.ts';
import { replayTop } from '../../../server/algorithms/ml/replay.ts';
import type { EngineParams } from '../../../server/algorithms/ml/mlEngine.ts';
import { evaluatePrepared, type EventResult } from '../../../server/algorithms/learning/evaluate.ts';
import { summarise } from '../../../server/algorithms/learning/experiment.ts';

const args = process.argv.slice(2);
const sweep = args.includes('--sweep');
const onlySets = args.includes('--sets') ? args[args.indexOf('--sets') + 1].split(',') : null;
const onlyVariants = args.includes('--variants') ? args[args.indexOf('--variants') + 1].split(',') : null;
const REC = path.resolve(import.meta.dirname, '..', '..', 'recorded-runs');
const OUT = path.resolve(import.meta.dirname, '..', '..', '..', 'graphs', 'output', 'ml-levels.json');

export interface Loaded { run: Run; observed: string; subject: string }
function load(dir: string, requireFaults: boolean): Loaded[] {
  if (!fs.existsSync(dir)) return [];
  const out: Loaded[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^observed-.*\.jsonl$/.test(x))) {
    const subject = f.replace(/^observed-|\.jsonl$/g, ''), led = path.join(dir, `ledger-${subject}.jsonl`);
    const ledger = fs.existsSync(led) ? fs.readFileSync(led, 'utf8') : '';
    if (requireFaults && !ledger) continue;
    const observed = fs.readFileSync(path.join(dir, f), 'utf8');
    const run = buildRun(`${path.basename(dir)}/${subject}`, subject, ledger, observed);
    if (run.moments.length && (!requireFaults || run.faults.length)) out.push({ run, observed, subject });
  }
  return out;
}
const sub = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).map((x) => path.join(d, x)).filter((x) => fs.statSync(x).isDirectory()) : []);
const SETS: Record<string, Loaded[]> = {
  real: load(path.join(REC, 'runC'), true),
  live: sub(path.join(REC, 'autorestart')).filter((d) => !/stop-test/.test(d)).flatMap((d) => load(d, true)),
  workload: sub(path.join(REC, 'workload')).flatMap((d) => load(d, false)),
  synthetic: sub(path.resolve(REC, '..', 'synthetic-runs')).flatMap((d) => load(d, true)),
  steps: sub(path.join(REC, 'steps')).flatMap((d) => load(d, false)),
};

type P = Partial<Omit<EngineParams, 'baseline' | 'walk' | 'load' | 'pca'>> & { pca?: Partial<EngineParams['pca']>; baseline?: Partial<EngineParams['baseline']>; walk?: Partial<EngineParams['walk']>; load?: Partial<EngineParams['load']> };
const cache = new Map<string, ReturnType<typeof replayTop>>();
function top(set: string, i: number, p: P) {
  const key = `${set}|${i}|${JSON.stringify(p)}`;
  if (!cache.has(key)) cache.set(key, replayTop(SETS[set][i].observed, SETS[set][i].subject, p as Partial<EngineParams>));
  return cache.get(key)!;
}
function evalSet(set: string, p: P, threshold = 1): EventResult[] {
  return SETS[set].map((l, i) => evaluatePrepared({ runs: [l.run], top: [top(set, i, p)] }, null, threshold));
}
const byClass = (rs: EventResult[]) => { const o = rs.flatMap((r) => r.faults); return Object.fromEntries([...new Set(o.map((f) => f.class))].sort().map((c) => { const x = o.filter((f) => f.class === c); return [c, { n: x.length, detected: x.filter((f) => f.detected).length, named: x.filter((f) => f.detected && f.top1).length, delay: median(x.filter((f) => f.detected).map((f) => f.delaySec!)) }]; })); };
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const pool = (rs: EventResult[]) => summarise({ faults: rs.flatMap((r) => r.faults), falseAlarms: rs.reduce((s, r) => s + r.falseAlarms, 0), fpHours: rs.reduce((s, r) => s + r.fpHours, 0), alarmMs: rs.reduce((s, r) => s + r.alarmMs, 0) });
const pc = (x: number) => `${Math.round(x * 100)}%`.padStart(4);

export const VARIANTS: Record<string, P> = {
  'forest (current)': {},
  'forest ensemble (4 detectors)': { baseline: { detector: 'ensemble' } },
  'hbos': { baseline: { detector: 'hbos' } },
  'control chart, MAD spread': { levels: 'load', load: { mode: 'control', scale: 'mad' } },
  'control chart, tail spread': { levels: 'load', load: { mode: 'control', scale: 'tail' } },
  'subspace residual, 1 component': { levels: 'pca', pca: { components: 1 } },
  'subspace residual, 2 components': { levels: 'pca', pca: { components: 2 } },
  'load factor, MAD spread': { levels: 'load', load: { mode: 'pooled', scale: 'mad' } },
  'load factor, tail spread': { levels: 'load', load: { mode: 'pooled', scale: 'tail' } },
};

const EMPTY = summarise({ faults: [], falseAlarms: 0, fpHours: 0, alarmMs: 0 });
function row(name: string, p: P) {
  const raw = new Map<string, EventResult[]>();
  const ev = (set: string) => { if (onlySets && !onlySets.includes(set)) return EMPTY; const rs = evalSet(set, p); raw.set(set, rs); return pool(rs); };
  const r = ev('real'), l = ev('live'), w = ev('workload'), sy = ev('synthetic'), st = ev('steps');
  const classes = Object.fromEntries([...raw].map(([k, v]) => [k, byClass(v)]));
  const line = `${name.padEnd(34)} real ${pc(r.detected)} found ${pc(r.top1OfDetected)} first ${r.falseAlarmsPerHour.toFixed(1).padStart(5)} FA/h | live ${pc(l.detected)} found ${pc(l.top1OfDetected)} first ${l.falseAlarmsPerHour.toFixed(1).padStart(5)} FA/h | workload ${w.falseAlarmsPerHour.toFixed(1).padStart(6)} FA/h, ${pc(w.alarmShare ?? 0)} of time in alarm | steps ${st.falseAlarmsPerHour.toFixed(1).padStart(6)} FA/h, ${pc(st.alarmShare ?? 0)} in alarm | synthetic ${pc(sy.detected)} found ${pc(sy.top1OfDetected)} first ${sy.falseAlarmsPerHour.toFixed(1).padStart(5)} FA/h`;
  console.log(line);
  return { name, real: r, live: l, workload: w, steps: st, synthetic: sy, classes };
}

console.log(Object.entries(SETS).map(([k, v]) => `${k}: ${v.length} runs${k !== 'workload' ? `, ${v.reduce((s, x) => s + x.run.faults.length, 0)} faults` : `, ${v.reduce((s, x) => s + x.run.moments.length, 0)} moments`}`).join('   '));
const result: any = { generatedAt: new Date().toISOString(), sets: Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, v.map((x) => ({ name: x.run.name, faults: x.run.faults.length, moments: x.run.moments.length }))])), variants: [] as any[], sweeps: {} };
for (const [name, p] of Object.entries(VARIANTS)) if (!onlyVariants || onlyVariants.some((v) => name.includes(v))) result.variants.push(row(name, p));

if (sweep) {
  console.log('\nload model, learned slopes: zLine (alarm at level 2 = twice the line)');
  result.sweeps.zLine = [2, 3, 4, 5, 6, 8].map((z) => ({ value: z, ...row(`zLine ${z}`, { levels: 'load', load: { mode: 'pooled', zLine: z } }) }));
  console.log('\nload model: window');
  result.sweeps.window = [60, 120, 240].map((w) => ({ value: w, ...row(`window ${w}`, { levels: 'load', load: { mode: 'pooled', window: w } }) }));
  console.log('\nload model: slow reference');
  result.sweeps.slow = [120, 360, 720].map((w) => ({ value: w, ...row(`slow ${w}`, { levels: 'load', load: { mode: 'pooled', slow: w } }) }));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
