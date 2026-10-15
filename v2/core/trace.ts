/**
 * v2 core: every recorded or synthetic run, replayed ONCE through the v1 engines and saved, so v2 experiments can run in
 * seconds and all start from exactly the same inputs.
 *
 * One Trace per run. Per moment and per service it holds:
 *   metrics   what the collector reported (cpu, memoryPercent, requestRate, errorRate, latencyP95, state, ...)
 *   status    the collector's health colour
 *   ml        [level, ownLevel, symptomLevel, anomaly, hard, walkShare]  from the v1 ML engine (level 1 = own line)
 *   rules     v1 rule score / 3 (1 = the rule engine's line)
 * plus the v1 ML ranking, the edges the collector saw, and (when known) the TRUE call graph, which no engine reads.
 *
 *   node server/node_modules/tsx/dist/cli.mjs v2/core/trace.ts <out.json> <run dir> [<run dir> ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns } from '../../run/cli/ml/run.ts';
import { replayEach } from '../../server/algorithms/ml/replay.ts';
import { rulesScore, RULES_LINE } from '../../server/algorithms/detection/scoring.ts';
import { TRUE_CALLS } from './topologies.ts';

export interface TraceFault { id: string; class: string; target: string; a: number; b: number; affected: string[] }
export interface TraceMoment {
  ts: number;
  services: string[];
  edges: [string, string][];
  status: Record<string, string>;
  metrics: Record<string, Record<string, number | string | boolean>>;
  ml: Record<string, [number, number, number, number, 0 | 1, number]>;
  mlRanked: string[];
  rules: Record<string, number>;
}
export interface Trace { name: string; subject: string; t0: number; t1: number; faults: TraceFault[]; trueCalls: [string, string][] | null; moments: TraceMoment[] }

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function buildTraces(dirs: string[]): Trace[] {
  const { runs, texts } = loadRuns(dirs);
  return runs.map((run, ri) => {
    const moments: TraceMoment[] = [];
    replayEach(texts[ri].observed, texts[ri].subject, {}, (r, services, s) => {
      const m = run.moments[moments.length];
      if (!m) return;
      const rules: Record<string, number> = {};
      m.services.forEach((id, i) => { rules[id] = r3(rulesScore(m.X[i]) / RULES_LINE); });
      const ml: TraceMoment['ml'] = {};
      for (const [id, v] of r.services) ml[id] = [r3(v.level), r3(v.ownLevel), r3(v.symptomLevel), r3(v.anomaly), v.hard ? 1 : 0, r3(r.rank.get(id) ?? 0)];
      const metrics: TraceMoment['metrics'] = {};
      for (const id of services) metrics[id] = s.metrics![id] as any;
      moments.push({ ts: s.ts, services, edges: s.edges ?? [], status: s.status, metrics, ml, mlRanked: r.ranked, rules });
    });
    // the true call graph: from the synthetic run's topology file, or the known bench topologies
    const dir = dirs.length ? dirs.find((d) => run.name.startsWith(path.basename(path.resolve(d)) + '/')) : undefined;
    const topoFile = dir ? path.join(dir, `topology-${run.subject}.json`) : '';
    const trueCalls = topoFile && fs.existsSync(topoFile) ? JSON.parse(fs.readFileSync(topoFile, 'utf8')).calls : TRUE_CALLS[run.subject.replace(/^synth-/, '')] ?? null;
    return {
      name: run.name, subject: run.subject, t0: run.t0, t1: run.t1, trueCalls,
      faults: run.faults.map((f) => ({ id: f.id, class: f.class, target: f.target, a: f.a, b: f.b, affected: f.truth?.expectedAffected ?? [] })),
      moments,
    };
  });
}

export function loadTraces(file: string): Trace[] { return JSON.parse(fs.readFileSync(file, 'utf8')); }

if (process.argv[1]?.endsWith('trace.ts')) {
  const [out, ...dirs] = process.argv.slice(2);
  if (!out || !dirs.length) { console.error('usage: trace.ts <out.json> <run dir> [...]'); process.exit(2); }
  const traces = buildTraces(dirs);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(traces));
  console.log(`${traces.length} traces, ${traces.reduce((s, t) => s + t.faults.length, 0)} faults -> ${out}`);
}
