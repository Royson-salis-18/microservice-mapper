#!/usr/bin/env node
/**
 * paper/exp/workload.ts: what each model of "normal" does when the workload changes and nothing is broken.
 *
 *   node server/node_modules/tsx/dist/cli.mjs paper/exp/workload.ts
 *
 * Replays the fault-free recordings (run/recorded-runs/steps, run/recorded-runs/workload) through the old per-service forest and
 * the load-aware model, and writes paper/data/workload.json: per recording the phases, and per moment the entry service's network
 * rate, the strongest level and the number of services over their line for each model, and the load factor the new model read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { replayEach } from '../../server/algorithms/ml/replay.ts';
import { parseObserved } from '../../server/algorithms/evaluation/score.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const REC = path.join(root, 'run/recorded-runs');
const ENTRY: Record<string, string> = { shopflow: 'api-gateway', ledgerline: 'edge' };
const MODELS: Record<string, any> = {
  forest: { levels: 'forest' },
  ensemble: { levels: 'forest', baseline: { detector: 'ensemble' } },
  control: { levels: 'load', load: { mode: 'control' } },
  pca: { levels: 'pca' },
  load: { levels: 'load' },
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const out: any = { recordings: [] };
for (const kind of ['steps', 'workload']) {
  for (const subject of ['shopflow', 'ledgerline']) {
    const dir = path.join(REC, kind, subject);
    const file = path.join(dir, `observed-${subject}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const phases = fs.readFileSync(path.join(dir, 'phases.log'), 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([t, s]) => ({ t: Number(t) * 1000, level: s }));
    const snaps = parseObserved(text).filter((s) => s.metrics && Object.keys(s.metrics).length);
    const t0 = snaps[0].ts;
    const rec: any = { kind, subject, phases: phases.map((p) => ({ min: r2((p.t - t0) / 60000), level: p.level })), minutes: r2((snaps.at(-1)!.ts - t0) / 60000), entry: snaps.map((s) => r2(Math.log10(1 + (Number((s.metrics as any)[ENTRY[subject]]?.networkRxRate) || 0)))), t: snaps.map((s) => r2((s.ts - t0) / 60000)), models: {} };
    for (const [name, params] of Object.entries(MODELS)) {
      const max: number[] = [], over: number[] = [], load: number[] = [];
      replayEach(text, subject, params, (r) => {
        const lv = [...r.services.values()].filter((v) => !v.hard).map((v) => v.level);
        max.push(r2(Math.min(8, Math.max(0, ...lv)))); over.push(lv.filter((x) => x >= 2).length); load.push(r2(r.workload?.load ?? 0));
      });
      rec.models[name] = { max, over, load };
      console.log(kind, subject, name.padEnd(9), `time with a service at level 2: ${r2(100 * over.filter((x, i) => x > 0 && rec.t[i] > 5).length / Math.max(1, over.filter((_, i) => rec.t[i] > 5).length))}%`);
    }
    out.recordings.push(rec);
  }
}
fs.mkdirSync(path.join(root, 'paper/data'), { recursive: true });
fs.writeFileSync(path.join(root, 'paper/data/workload.json'), JSON.stringify(out));
console.log('wrote paper/data/workload.json');
