#!/usr/bin/env node
// run/cli/ml/hybrid.ts: combine the rule engine and the ML engine, moment by moment, and score every combination with the
// same event-level evaluation as ml:compare.
//
//   npm run ml:hybrid -- [run dirs]              default: the recorded runs
//   npm run ml:hybrid -- <dirs> --json out.json
//
// Each moment gives, per service: the rule score (robust z, alarm at 3), the ML level (alarm at 1), whether a container
// fact holds, and the random walk's share. Detection rules decide when to alarm; ranking rules decide who is named first.
import fs from 'node:fs';
import { loadRuns } from './run.ts';
import { replayEach } from '../../../server/algorithms/ml/replay.ts';
import { ENGINE_DEFAULTS } from '../../../server/algorithms/ml/mlEngine.ts';
import { evaluatePrepared, type EventResult, type Prepared } from '../../../server/algorithms/learning/evaluate.ts';
import { summarise, RULES_FIXED_THRESHOLD } from '../../../server/algorithms/learning/experiment.ts';
import { rulesScore } from '../../../server/algorithms/detection/scoring.ts';
import { fuseMoment, DETECTION_MODES, RANKING_MODES, HYBRID_DEFAULTS, type FusionParams, type MomentInputs } from '../../../server/algorithms/ml/hybrid.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const jsonOut = opt('json', '');

const { runs, texts } = loadRuns(dirs);
if (!runs.length) { console.error('no usable runs'); process.exit(1); }
console.log(`${runs.length} runs, ${runs.reduce((s, r) => s + r.faults.length, 0)} faults\n`);

// per run, per moment: what each engine said about each service
const inputs: MomentInputs[][] = runs.map((run, ri) => {
  const out: MomentInputs[] = [];
  replayEach(texts[ri].observed, texts[ri].subject, {}, (r, services) => {
    const m = run.moments[out.length];
    if (!m) return;
    const rules = new Map(m.services.map((id, i) => [id, rulesScore(m.X[i]) / RULES_FIXED_THRESHOLD]));
    out.push({ services: m.services, rules, level: new Map([...r.services].map(([id, v]) => [id, v.level / ENGINE_DEFAULTS.alarmLevel])), hard: new Set([...r.services].filter(([, v]) => v.hard).map(([id]) => id)), walk: r.rank, mlRanked: r.ranked });
  });
  if (out.length !== run.moments.length) console.warn(`${run.name}: ${out.length} replayed moments for ${run.moments.length} recorded`);
  return out;
});

const pool = (rs: EventResult[]) => summarise({ faults: rs.flatMap((r) => r.faults), falseAlarms: rs.reduce((s, r) => s + r.falseAlarms, 0), fpHours: rs.reduce((s, r) => s + r.fpHours, 0), alarmMs: rs.reduce((s, r) => s + r.alarmMs, 0) });
function evaluate(p: FusionParams) {
  const res = runs.map((run, ri) => {
    const top: Prepared['top'][number] = inputs[ri].map((x) => fuseMoment(x, p));
    return evaluatePrepared({ runs: [run], top: [top] }, null, 1);
  });
  return { ...pool(res), outcomes: res.flatMap((r) => r.faults) };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
const rows: { name: string; p: FusionParams; s: any }[] = [];
const add = (name: string, p: FusionParams) => { const s = evaluate(p); rows.push({ name, p, s }); console.log(`${name.padEnd(44)} ${pct(s.detected)}   ${pct(s.top1OfDetected)}      ${pct(s.caughtAndNamed)}    ${s.falseAlarmsPerHour.toFixed(1).padStart(5)}    ${pct(s.alarmShare ?? 0)}`); };
console.log(`${'detection + ranking'.padEnd(44)} detected right-first caught+named false/h  alarm-time`);
add('rules only', { detection: 'rules', ranking: 'rules' });
add('ML only', { detection: 'ml', ranking: 'ml' });
add('HYBRID (default)', HYBRID_DEFAULTS);
for (const detection of DETECTION_MODES) for (const ranking of RANKING_MODES) {
  if ((detection === 'rules' && ranking === 'rules') || (detection === 'ml' && ranking === 'ml')) continue;
  add(`${detection} + ${ranking}`, { detection, ranking });
}
console.log('\nweights (detection "or-strict"):');
for (const rulesAlone of [1, 1.25, 1.5, 2, 3]) {
  add(`  rules alone at ${rulesAlone}x line, ML ranking`, { detection: 'or-strict', ranking: 'ml', rulesAlone });
  for (const w of [0.5, 0.7, 0.85]) add(`  rules alone at ${rulesAlone}x line, blend ML ${w}`, { detection: 'or-strict', ranking: 'blend', rulesAlone, mlWeight: w });
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ runs: runs.map((r) => ({ name: r.name, faults: r.faults.length })), rows: rows.map((r) => ({ name: r.name, params: r.p, ...r.s, outcomes: undefined,
  byClass: Object.fromEntries([...new Set(r.s.outcomes.map((o: any) => o.class))].map((c: any) => { const os = r.s.outcomes.filter((o: any) => o.class === c); return [c, { n: os.length, detected: os.filter((o: any) => o.detected).length, named: os.filter((o: any) => o.detected && o.top1).length }]; })) })) }, null, 2));
