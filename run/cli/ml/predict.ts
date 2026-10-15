#!/usr/bin/env node
// run/cli/ml/predict.ts: how well does the engine see trouble coming?
//
//   npm run ml:predict -- [run dirs]          default: the recorded runs
//
// 1. Early warning. The trend forecast warns when a service's recent readings are heading over its line. Per fault: was
//    there a warning (on the faulted service or on something it affects) before the first alarm, and how much earlier?
//    Warnings outside every fault window count as false warnings.
// 2. Cascade. At the first alarm of each fault, which services that are still healthy will turn unhealthy before the
//    fault ends? Compared: the learned cascade model (risk >= 0.5), every service upstream of the suspect (the call graph
//    alone), and, where recorded, what the live mapper listed as at risk.
import fs from 'node:fs';
import { loadRuns } from './run.ts';
import { replayEach } from '../../../server/algorithms/ml/replay.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const jsonOut = opt('json', ''), riskCut = Number(opt('risk', '0.5')), params = JSON.parse(opt('params', '{}'));
const { runs, texts } = loadRuns(dirs);
if (!runs.length) { console.error('no usable runs'); process.exit(1); }

interface M { ts: number; hot: boolean; top: string | null; warn: Set<string>; warnInfo: Map<string, number | null>; risk: Map<string, number>; status: Record<string, string>; abnormal: Set<string>; live: Set<string> | null }
const GRACE = 60000;
const early = { faults: 0, warned: 0, warnedBeforeAlarm: 0, leads: [] as number[], warnedNoAlarm: 0, falseEpisodes: 0, fpHours: 0, byClass: new Map<string, { n: number; before: number }>() };
const cascade: Record<string, { tp: number; fp: number; fn: number; faults: number }> = {};
const add = (k: string, pred: Set<string>, truth: Set<string>) => {
  const c = (cascade[k] ??= { tp: 0, fp: 0, fn: 0, faults: 0 });
  c.faults++; for (const x of pred) truth.has(x) ? c.tp++ : c.fp++; for (const x of truth) if (!pred.has(x)) c.fn++;
};

runs.forEach((run, ri) => {
  const ms: M[] = [];
  replayEach(texts[ri].observed, texts[ri].subject, params, (r, services, s) => {
    const live = s.incidents?.length ? new Set(s.incidents.flatMap((i) => i.atRisk.map((a) => a.id))) : null;
    ms.push({ ts: s.ts, hot: r.hot, top: r.ranked[0] ?? null, warn: new Set(r.warnings.map((w) => w.id)), warnInfo: new Map(r.warnings.map((w) => [w.id, w.inSec])), risk: r.atRisk, status: s.status,
      abnormal: new Set([...r.services].filter(([, v]) => v.anomaly > 0).map(([id]) => id)), live: run.moments.some((m) => m.live.alarm) ? (live ?? new Set()) : null });
  });
  const alarm = ms.map((m, i) => m.hot && i > 0 && ms[i - 1].hot);
  const windows = run.faults.map((f) => [f.a, f.b + GRACE] as const);
  // false warnings: warning episodes that touch no fault window, after the warm-up
  for (let i = 1; i < ms.length; i++) {
    const inFault = windows.some(([a, b]) => ms[i].ts >= a && ms[i].ts <= b);
    if (ms[i].ts < run.t0 + 300000 || inFault) continue;
    early.fpHours += (ms[i].ts - ms[i - 1].ts) / 3.6e6;
    if (ms[i].warn.size && !ms[i - 1].warn.size) early.falseEpisodes++;
  }
  for (const f of run.faults) {
    const touches = new Set([f.target, ...(f.truth?.expectedAffected ?? [])]);
    const idx = ms.map((m, i) => i).filter((i) => ms[i].ts >= f.a && ms[i].ts <= f.b + GRACE);
    if (!idx.length) continue;
    early.faults++;
    const firstAlarm = idx.find((i) => alarm[i]);
    const firstWarn = idx.find((i) => [...ms[i].warn].some((id) => touches.has(id)));
    const cls = early.byClass.get(f.class) ?? { n: 0, before: 0 }; cls.n++;
    if (firstWarn !== undefined) {
      early.warned++;
      if (firstAlarm === undefined) early.warnedNoAlarm++;
      else if (firstWarn < firstAlarm) { early.warnedBeforeAlarm++; early.leads.push((ms[firstAlarm].ts - ms[firstWarn].ts) / 1000); cls.before++; }
    }
    early.byClass.set(f.class, cls);

    // cascade, from the first alarm inside the fault
    if (firstAlarm === undefined || ms[firstAlarm].ts > f.b) continue;
    const t0 = ms[firstAlarm];
    const healthyNow = (id: string) => (t0.status[id] ?? 'healthy') === 'healthy' && !t0.abnormal.has(id);
    const truth = new Set<string>();
    for (const i of idx) if (i > firstAlarm) for (const [id, st] of Object.entries(ms[i].status)) if (id !== f.target && id !== 'traffic' && st !== 'healthy' && healthyNow(id)) truth.add(id);
    const learned = new Set([...t0.risk].filter(([id, p]) => p >= riskCut && healthyNow(id)).map(([id]) => id));
    const graph = new Set([...t0.risk.keys()].filter(healthyNow));
    add('learned cascade model', learned, truth);
    add('call graph (everything upstream)', graph, truth);
    add('nothing (predict no one)', new Set(), truth);
    if (t0.live) add('live mapper (recorded at-risk list)', new Set([...t0.live].filter(healthyNow)), truth);
  }
});

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
console.log(`${runs.length} runs, ${early.faults} faults\n`);
console.log('EARLY WARNING (trend forecast, 2 minutes ahead)');
console.log(`  faults warned before the first alarm  ${early.warnedBeforeAlarm}/${early.faults}   median lead ${med(early.leads) ?? '-'} s`);
console.log(`  faults warned that never alarmed      ${early.warnedNoAlarm}`);
console.log(`  false warning episodes                ${(early.falseEpisodes / Math.max(1e-9, early.fpHours)).toFixed(1)} per fault-free hour`);
console.log(`  by class (warned before the alarm):  ${[...early.byClass].sort().map(([c, v]) => `${c} ${v.before}/${v.n}`).join(', ')}`);
console.log('\nCASCADE (which healthy services turn unhealthy after the first alarm)');
const prf = (c: { tp: number; fp: number; fn: number }) => { const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0, r = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0; return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0 }; };
for (const [k, c] of Object.entries(cascade)) { const m = prf(c); console.log(`  ${k.padEnd(38)} precision ${(m.precision * 100).toFixed(0).padStart(3)}%  recall ${(m.recall * 100).toFixed(0).padStart(3)}%  F1 ${m.f1.toFixed(2)}   (${c.faults} faults, ${c.tp + c.fn} services hit)`); }
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ early: { ...early, byClass: Object.fromEntries(early.byClass), medianLeadSec: med(early.leads) }, cascade: Object.fromEntries(Object.entries(cascade).map(([k, c]) => [k, { ...c, ...prf(c) }])) }, null, 2));
