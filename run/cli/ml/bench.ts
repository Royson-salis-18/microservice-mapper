#!/usr/bin/env node
// run/cli/ml/bench.ts: score the rule engine and the ML engine on any set of runs (recorded or synthetic), overall and
// per fault class, with the same event-level scoring as ml:compare.
//
//   npm run ml:bench -- run/synthetic-runs/*                 every run in those directories
//   npm run ml:bench -- <dirs> --variants '[["name",{params}]]' --seeds 3 --json out.json
import fs from 'node:fs';
import { loadRuns } from './run.ts';
import { replayTop } from '../../../server/algorithms/ml/replay.ts';
import type { EngineParams } from '../../../server/algorithms/ml/mlEngine.ts';
import { evaluatePrepared, prepare, type EventResult } from '../../../server/algorithms/learning/evaluate.ts';
import { scorer, RULES_FIXED_THRESHOLD, summarise } from '../../../server/algorithms/learning/experiment.ts';
import { rulesScore } from '../../../server/algorithms/detection/scoring.ts';
import type { Run } from '../../../server/algorithms/learning/dataset.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const variants: [string, any][] = JSON.parse(opt('variants', '[["ML (default)",{}]]'));
const seeds = Array.from({ length: Number(opt('seeds', '1')) }, (_, i) => i);
const jsonOut = opt('json', '');

const { runs, texts } = loadRuns(dirs);
if (!runs.length) { console.error('no usable runs'); process.exit(1); }
const nFaults = runs.reduce((s, r) => s + r.faults.length, 0);
const minutes = runs.reduce((s, r) => s + (r.t1 - r.t0) / 60000, 0);
console.log(`${runs.length} runs, ${nFaults} faults, ${minutes.toFixed(0)} min\n`);

const pool = (rs: EventResult[]) => ({ ...summarise({ faults: rs.flatMap((r) => r.faults), falseAlarms: rs.reduce((s, r) => s + r.falseAlarms, 0), fpHours: rs.reduce((s, r) => s + r.fpHours, 0), alarmMs: rs.reduce((s, r) => s + r.alarmMs, 0) }), outcomes: rs.flatMap((r) => r.faults) });
const rules = pool(runs.map((r) => { const rs: Run[] = [r]; return evaluatePrepared(prepare(rs, scorer(rs, rulesScore)), null, RULES_FIXED_THRESHOLD); }));
const hasLive = runs.some((r) => r.moments.some((m) => m.live.alarm));
const live = hasLive ? pool(runs.map((r) => evaluatePrepared('live', [r], 0.5))) : null;

const rows: [string, any][] = [['Rules (re-scored)', rules], ...(live ? [['Rules (live, as recorded)', live] as [string, any]] : [])];
for (const [name, p] of variants) {
  const t = Date.now();
  const per = seeds.map((seed) => pool(runs.map((r, i) => evaluatePrepared({ runs: [r], top: [replayTop(texts[i].observed, texts[i].subject, { ...p, baseline: { ...(p.baseline ?? {}), seed } } as Partial<EngineParams>)] }, null, p.threshold ?? 1))));
  const mean = (f: (s: any) => number) => per.reduce((a, s) => a + f(s), 0) / per.length;
  const sd = (f: (s: any) => number) => { const m = mean(f); return Math.sqrt(per.reduce((a, s) => a + (f(s) - m) ** 2, 0) / per.length); };
  rows.push([name, { ...per[0], detected: mean((s) => s.detected), top1OfDetected: mean((s) => s.top1OfDetected), caughtAndNamed: mean((s) => s.caughtAndNamed), falseAlarmsPerHour: mean((s) => s.falseAlarmsPerHour), alarmShare: mean((s) => s.alarmShare ?? 0),
    sd: { top1: sd((s) => s.top1OfDetected), fa: sd((s) => s.falseAlarmsPerHour) }, sec: (Date.now() - t) / 1000 }]);
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
console.log(`${'engine'.padEnd(28)} detected  right-first  caught+named  false/h  alarm-time`);
for (const [name, s] of rows) console.log(`${name.padEnd(28)} ${pct(s.detected)}     ${pct(s.top1OfDetected)}${s.sd ? `±${(s.sd.top1 * 100).toFixed(0)}` : '   '}      ${pct(s.caughtAndNamed)}     ${s.falseAlarmsPerHour.toFixed(1).padStart(5)}${s.sd ? `±${s.sd.fa.toFixed(1)}` : '    '}   ${pct(s.alarmShare ?? 0)}`);

// per fault class: caught and named first (the number that matters to an operator)
const classes = [...new Set(rows[0][1].outcomes.map((o: any) => o.class))].sort() as string[];
console.log(`\ncaught and named first, by fault class (first seed):`);
console.log(`${'class'.padEnd(12)} ${'n'.padStart(4)}  ${rows.map(([n]) => n.slice(0, 16).padStart(17)).join('')}`);
for (const c of classes) {
  const n = rows[0][1].outcomes.filter((o: any) => o.class === c).length;
  console.log(`${c.padEnd(12)} ${String(n).padStart(4)}  ${rows.map(([, s]) => { const os = s.outcomes.filter((o: any) => o.class === c); return pct(os.filter((o: any) => o.detected && o.top1).length / Math.max(1, os.length)).padStart(17); }).join('')}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ runs: runs.map((r) => ({ name: r.name, faults: r.faults.length })), rows: rows.map(([n, s]) => ({ name: n, ...s, outcomes: undefined, byClass: Object.fromEntries(classes.map((c) => { const os = s.outcomes.filter((o: any) => o.class === c); return [c, { n: os.length, detected: os.filter((o: any) => o.detected).length, named: os.filter((o: any) => o.detected && o.top1).length }]; })) })) }, null, 2));
