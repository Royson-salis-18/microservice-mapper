#!/usr/bin/env node
// run/cli/ml/compare.ts: the ML engine (sliding-window Isolation Forest + random-walk root cause) against the rule-based
// engine, on the recorded fault runs, with the same event-level scoring for both.
//
//   npm run ml:compare                      defaults, plus sweeps and a cross-system check
//   npm run ml:compare -- --quick           defaults only
//
// The ML engine never sees a label: every moment is scored from the past only. Its settings are chosen in advance; the
// sweeps show how much they matter, and the cross-system check picks settings on one bench and tests them on the other.
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns } from './run.ts';
import { replayTop } from '../../../server/algorithms/ml/replay.ts';
import { ENGINE_DEFAULTS, type EngineParams } from '../../../server/algorithms/ml/mlEngine.ts';
import { evaluatePrepared, prepare, type EventResult, type Prepared } from '../../../server/algorithms/learning/evaluate.ts';
import { scorer, RULES_FIXED_THRESHOLD, summarise } from '../../../server/algorithms/learning/experiment.ts';
import { rulesScore } from '../../../server/algorithms/detection/scoring.ts';
import type { Run } from '../../../server/algorithms/learning/dataset.ts';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const outFile = path.resolve(import.meta.dirname, '..', '..', '..', 'graphs', 'output', 'ml-vs-rules.json');

const { runs, texts } = loadRuns([]);
if (!runs.length) { console.error('no recorded runs found in run/recorded-runs'); process.exit(1); }

type P = Partial<Omit<EngineParams, 'baseline' | 'walk'>> & { baseline?: Partial<EngineParams['baseline']>; walk?: Partial<EngineParams['walk']>; threshold?: number };
const sum = (r: EventResult) => summarise({ faults: r.faults, falseAlarms: r.falseAlarms, fpHours: r.fpHours });
const pool = (rs: EventResult[]) => summarise({ faults: rs.flatMap((r) => r.faults), falseAlarms: rs.reduce((s, r) => s + r.falseAlarms, 0), fpHours: rs.reduce((s, r) => s + r.fpHours, 0), alarmMs: rs.reduce((s, r) => s + r.alarmMs, 0) });

const cache = new Map<string, Prepared['top'][number]>();
function mlTop(i: number, p: P) {
  const key = `${i}|${JSON.stringify({ ...p, threshold: undefined })}`;
  if (!cache.has(key)) cache.set(key, replayTop(texts[i].observed, texts[i].subject, p as Partial<EngineParams>));
  return cache.get(key)!;
}
/** Evaluate the ML engine with settings p on a subset of runs (by index). */
function evalML(idx: number[], p: P): EventResult[] {
  return idx.map((i) => evaluatePrepared({ runs: [runs[i]], top: [mlTop(i, p)] }, null, p.threshold ?? 1));
}
const evalRules = (idx: number[], th = RULES_FIXED_THRESHOLD) => idx.map((i) => { const rs: Run[] = [runs[i]]; return evaluatePrepared(prepare(rs, scorer(rs, rulesScore)), null, th); });
const evalLive = (idx: number[]) => idx.map((i) => evaluatePrepared('live', [runs[i]], 0.5));

const all = runs.map((_, i) => i);
const fmt = (s: any) => (s.seeds ? `detected ${(s.detected * 100).toFixed(0)}±${(s.spread.detected * 100).toFixed(0)}%  right first ${(s.top1OfDetected * 100).toFixed(0)}±${(s.spread.top1OfDetected * 100).toFixed(0)}%  false alarms ${s.falseAlarmsPerHour.toFixed(1)}±${s.spread.falseAlarmsPerHour.toFixed(1)}/h  alarm time ${((s.alarmShare ?? 0) * 100).toFixed(0)}%  (mean ± sd over ${s.seeds} seeds)` : `detected ${(s.detected * 100).toFixed(0)}% (${s.detectedN}/${s.faults})  right first ${(s.top1OfDetected * 100).toFixed(0)}% (${s.top1N}/${s.detectedN})  false alarms ${s.falseAlarmsPerHour.toFixed(1)}/h  alarm time ${((s.alarmShare ?? 0) * 100).toFixed(0)}%  delay ${s.medianDelaySec === null ? 'n/a' : s.medianDelaySec.toFixed(0) + ' s'}`);

console.log(`runs: ${runs.map((r) => `${r.name} (${r.faults.length} faults)`).join(', ')}\n`);
const SEEDS = [0, 1, 2, 3, 4];
/** The ML engine is built from random trees: report the average over several seeds, with the spread. */
function overSeeds(idx: number[], p: P) {
  const rows = SEEDS.map((seed) => pool(evalML(idx, { ...p, baseline: { ...(p.baseline ?? {}), seed } })));
  const mean = (f: (s: ReturnType<typeof summarise>) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const sd = (f: (s: ReturnType<typeof summarise>) => number) => { const m = mean(f); return Math.sqrt(rows.reduce((a, r) => a + (f(r) - m) ** 2, 0) / rows.length); };
  return { ...rows[0], detected: mean((r) => r.detected), top1OfDetected: mean((r) => r.top1OfDetected), caughtAndNamed: mean((r) => r.caughtAndNamed),
    falseAlarmsPerHour: mean((r) => r.falseAlarmsPerHour), alarmShare: mean((r) => r.alarmShare ?? 0), spread: { detected: sd((r) => r.detected), top1OfDetected: sd((r) => r.top1OfDetected), falseAlarmsPerHour: sd((r) => r.falseAlarmsPerHour) }, seeds: SEEDS.length };
}
const headline: Record<string, any> = {
  'Rules (live, as recorded)': pool(evalLive(all)),
  'Rules (re-scored, threshold 3)': pool(evalRules(all)),
  'ML: two-sided features, alarm at the line': quick ? pool(evalML(all, { alarmLevel: 1, baseline: { oneSided: false, mildDriftAfter: 0 } })) : overSeeds(all, { alarmLevel: 1, baseline: { oneSided: false, mildDriftAfter: 0 } }),
  'ML: forest only (rank by anomaly)': quick ? pool(evalML(all, { useWalk: false })) : overSeeds(all, { useWalk: false }),
  'ML: forests + random walk (default)': quick ? pool(evalML(all, {})) : overSeeds(all, {}),
};
for (const [k, v] of Object.entries(headline)) console.log(`${k.padEnd(36)} ${fmt(v)}`);

const result: any = { generatedAt: new Date().toISOString(), runs: runs.map((r) => ({ name: r.name, faults: r.faults.length })), defaults: ENGINE_DEFAULTS, headline };

if (!quick) {
  console.log('\nsweeps (one setting changed at a time, all runs):');
  const sweeps: Record<string, { value: number; s: ReturnType<typeof summarise> }[]> = {};
  const sweep = (name: string, values: number[], mk: (v: number) => P) => {
    sweeps[name] = values.map((v) => ({ value: v, s: pool(evalML(all, mk(v))) }));
    for (const r of sweeps[name]) console.log(`  ${name.padEnd(14)} ${String(r.value).padEnd(6)} ${fmt(r.s)}`);
  };
  sweep('window', [60, 120, 240], (v) => ({ baseline: { window: v } }));
  sweep('lineK', [2, 3, 4], (v) => ({ baseline: { lineK: v } }));
  sweep('rangeK', [0, 3, 5, 8], (v) => ({ baseline: { rangeK: v } }));
  sweep('threshold', [1, 1.5, 2], (v) => ({ threshold: v }));
  sweep('trees', [50, 100, 200], (v) => ({ baseline: { trees: v } }));
  result.sweeps = sweeps;

  // cross-system: choose settings on one bench, test them untouched on the other
  const grid: P[] = [];
  for (const lineK of [2, 3, 4]) for (const rangeK of [3, 5, 8]) for (const threshold of [1, 1.5]) grid.push({ baseline: { lineK, rangeK }, threshold });
  const objective = (s: ReturnType<typeof summarise>) => s.caughtAndNamed - 0.02 * s.falseAlarmsPerHour;
  const subjects = [...new Set(runs.map((r) => r.subject))];
  result.cross = [];
  if (subjects.length > 1) {
    console.log('\ncross-system (settings chosen on one bench, tested on the other):');
    for (const tr of subjects) for (const te of subjects) {
      if (tr === te) continue;
      const trIdx = all.filter((i) => runs[i].subject === tr), teIdx = all.filter((i) => runs[i].subject === te);
      let best = grid[0], bestObj = -Infinity;
      for (const g of grid) { const o = objective(pool(evalML(trIdx, g))); if (o > bestObj) { bestObj = o; best = g; } }
      const ml = overSeeds(teIdx, best), rules = pool(evalLive(teIdx));
      console.log(`  train ${tr} -> test ${te}: chose ${JSON.stringify(best)}\n    ML    ${fmt(ml)}\n    rules ${fmt(rules)}`);
      result.cross.push({ train: tr, test: te, chosen: best, ml, rules });
    }
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`);
