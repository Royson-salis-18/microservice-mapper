#!/usr/bin/env node
/**
 * paper/exp/ablate.ts: ablation of the ML engine. Each row removes one mechanism from the full engine and is scored on the real
 * systems and on the synthetic held-out set with the same event-level evaluation.
 *
 *   node server/node_modules/tsx/dist/cli.mjs paper/exp/ablate.ts
 *
 * Writes paper/data/abl_real.json and paper/data/abl_test.json: { rows: [{ name, ...summary }] }.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns } from '../../run/cli/ml/run.ts';
import { replayTop } from '../../server/algorithms/ml/replay.ts';
import { evaluatePrepared } from '../../server/algorithms/learning/evaluate.ts';
import { summarise } from '../../server/algorithms/learning/experiment.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const SETS: Record<string, string[]> = {
  real: [path.join(root, 'run/recorded-runs/runC')],
  test: fs.readdirSync(path.join(root, 'run/synthetic-runs/test')).sort().map((d) => path.join(root, 'run/synthetic-runs/test', d)),
};
const VARIANTS: [string, any, number][] = [
  ['full (default)', {}, 1],
  ['- docker-stop fact', { stoppedIsDown: false }, 1],
  ['- crash-loop fact', { loopWindow: 0 }, 1],
  ['- load factor', { load: { mode: 'control' } }, 1],
  ['- tail-aware spread', { load: { scale: 'mad' } }, 1],
  ['- random walk', { useWalk: false }, 1],
  ['- one-sided features', { load: { oneSided: false } }, 1],
  ['- two-speed drift', { load: { mildDriftAfter: 0 } }, 1],
  ['- alarm at level 2 (alarm at 1)', { alarmLevel: 1 }, 1],
];
for (const [setName, dirs] of Object.entries(SETS)) {
  const { runs, texts } = loadRuns(dirs);
  const rows = VARIANTS.map(([name, params, th]) => {
    const rs = runs.map((run, i) => evaluatePrepared({ runs: [run], top: [replayTop(texts[i].observed, texts[i].subject, { levels: 'load', ...params, load: params.load })] }, null, th));
    const s = summarise({ faults: rs.flatMap((r) => r.faults), falseAlarms: rs.reduce((a, r) => a + r.falseAlarms, 0), fpHours: rs.reduce((a, r) => a + r.fpHours, 0), alarmMs: rs.reduce((a, r) => a + r.alarmMs, 0) });
    console.log(setName.padEnd(5), name.padEnd(34), `det ${(s.detected * 100).toFixed(0)}  c+n ${(s.caughtAndNamed * 100).toFixed(0)}  fa ${s.falseAlarmsPerHour.toFixed(1)}  alarm ${((s.alarmShare ?? 0) * 100).toFixed(0)}%`);
    return { name, ...s };
  });
  fs.writeFileSync(path.join(root, `paper/data/abl_${setName}.json`), JSON.stringify({ rows }));
}
