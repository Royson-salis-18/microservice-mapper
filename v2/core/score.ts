/**
 * v2 core: score any engine on traces with EXACTLY the v1 event-level evaluation (server/algorithms/learning/evaluate.ts),
 * so v2 results are directly comparable with v1. Also provides the three v1 engines (rules, ML, hybrid) as baselines.
 *
 * An engine is a function (trace, momentIndex) => { max, ranked }:
 *   max     how alarming the moment is, scaled so 1 = alarm (the alarm also needs 2 moments in a row)
 *   ranked  services, most likely root cause first
 */
import { evaluatePrepared, type EventResult } from '../../server/algorithms/learning/evaluate.ts';
import { summarise } from '../../server/algorithms/learning/experiment.ts';
import { fuseMoment, HYBRID_DEFAULTS, type FusionParams } from '../../server/algorithms/ml/hybrid.ts';
import { ENGINE_DEFAULTS } from '../../server/algorithms/ml/mlEngine.ts';
import type { Trace, TraceMoment } from './trace.ts';

export type Engine = (t: Trace, i: number) => { max: number; ranked: string[] };

/** The minimal Run the v1 evaluator needs. */
function asRun(t: Trace): any {
  return { name: t.name, subject: t.subject, t0: t.t0, t1: t.t1, moments: t.moments.map((m) => ({ ts: m.ts, services: m.services })),
    faults: t.faults.map((f) => ({ ...f, truth: { rootCause: f.target, expectedAffected: f.affected } })) };
}

export interface Score {
  faults: number; detected: number; top1OfDetected: number; caughtAndNamed: number; falseAlarmsPerHour: number; alarmShare: number;
  byClass: Record<string, { n: number; detected: number; named: number }>;
  outcomes: EventResult['faults'];
}

export function score(traces: Trace[], engine: Engine): Score {
  const res = traces.map((t) => evaluatePrepared({ runs: [asRun(t)], top: [t.moments.map((_, i) => ({ ...engine(t, i), scores: [] }))] }, null, 1));
  const s = summarise({ faults: res.flatMap((r) => r.faults), falseAlarms: res.reduce((a, r) => a + r.falseAlarms, 0), fpHours: res.reduce((a, r) => a + r.fpHours, 0), alarmMs: res.reduce((a, r) => a + r.alarmMs, 0) });
  const outcomes = res.flatMap((r) => r.faults);
  const byClass: Score['byClass'] = {};
  for (const o of outcomes) { const c = (byClass[o.class] ??= { n: 0, detected: 0, named: 0 }); c.n++; if (o.detected) c.detected++; if (o.detected && o.top1) c.named++; }
  return { faults: s.faults, detected: s.detected, top1OfDetected: s.top1OfDetected, caughtAndNamed: s.caughtAndNamed, falseAlarmsPerHour: s.falseAlarmsPerHour, alarmShare: s.alarmShare ?? 0, byClass, outcomes };
}

/** What the v1 engines saw at a moment, in the hybrid's input format. */
export function v1Inputs(m: TraceMoment) {
  const ids = m.services;
  return {
    services: ids,
    rules: new Map(ids.map((id) => [id, m.rules[id] ?? 0])),
    level: new Map(ids.map((id) => [id, (m.ml[id]?.[0] ?? 0) / ENGINE_DEFAULTS.alarmLevel])),
    hard: new Set(ids.filter((id) => m.ml[id]?.[4] === 1)),
    walk: new Map(ids.map((id) => [id, m.ml[id]?.[5] ?? 0])),
    mlRanked: m.mlRanked,
  };
}
const fused = (p: FusionParams): Engine => (t, i) => fuseMoment(v1Inputs(t.moments[i]), p);
export const V1 = {
  rules: fused({ detection: 'rules', ranking: 'rules' }),
  ml: fused({ detection: 'ml', ranking: 'ml' }),
  hybrid: fused(HYBRID_DEFAULTS),
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
export function line(name: string, s: Score): string {
  return `${name.padEnd(34)} ${pct(s.detected)}   ${pct(s.top1OfDetected)}       ${pct(s.caughtAndNamed)}     ${s.falseAlarmsPerHour.toFixed(1).padStart(5)}   ${pct(s.alarmShare)}`;
}
export const HEADER = `${'engine'.padEnd(34)} detected right-first caught+named false/h alarm-time`;
