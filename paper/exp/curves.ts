#!/usr/bin/env node
/**
 * paper/exp/curves.ts: the data behind the curve-type figures of the paper, from the cached traces (v2/.cache).
 *
 *   node server/node_modules/tsx/dist/cli.mjs paper/exp/curves.ts
 *
 * Writes paper/data/curves.json with, per set (real, test) and engine:
 *   op       operating curve: sweep the alarm threshold, record detection rate, false alarms per hour, time in alarm, C+N
 *   moments  (score, label) per moment, for ROC and precision-recall (label = a fault is active on some service)
 *   faults   per fault: class, detected, delay, rank of the true root at the settled moment (null if not detected)
 *   cases    level matrices around three real faults, for the case-study figure
 * Engines: rules, ml, hybrid, severity (rank by anomaly alone), hybrid + change-point, hybrid + learned directions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTraces, type Trace } from '../../v2/core/trace.ts';
import { score, V1, type Engine } from '../../v2/core/score.ts';
import { earlyEngine } from '../../v2/onset/rca.ts';
import { causalEngine } from '../../v2/causal/rca.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const sets: Record<string, Trace[]> = {
  real: loadTraces(path.join(root, 'v2/.cache/real.json')),
  test: loadTraces(path.join(root, 'v2/.cache/test.json')),
};

/** Rank by anomaly alone (facts first): the severity baseline most alert systems use. */
const severity: Engine = (t, i) => {
  const b = V1.hybrid(t, i), m = t.moments[i];
  const hard = (id: string) => (m.ml[id]?.[4] === 1 ? 1 : 0);
  const ranked = [...m.services].sort((x, y) => hard(y) - hard(x) || (m.ml[y]?.[3] ?? 0) - (m.ml[x]?.[3] ?? 0) || (m.ml[y]?.[0] ?? 0) - (m.ml[x]?.[0] ?? 0) || x.localeCompare(y));
  return { max: b.max, ranked };
};
const cp = earlyEngine({ kind: 'ph' }, { magAlarm: 7, persist: 2, maxAlarmAge: 180, minServices: 1 }, V1.hybrid);
const learned: Engine = (() => { const e = causalEngine({ directions: 'learned' }); const h = V1.hybrid; return (t, i) => ({ max: h(t, i).max, ranked: e(t, i).ranked }); })();
const ENGINES: Record<string, Engine> = { rules: V1.rules, ml: V1.ml, hybrid: V1.hybrid, severity, 'hybrid + change-point': cp, 'hybrid + learned directions': learned };
const OPERATING = ['rules', 'ml', 'hybrid'];
const THETAS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 4, 6];
const scaled = (e: Engine, th: number): Engine => (t, i) => { const r = e(t, i); return { max: r.max / th, ranked: r.ranked }; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The settled root-cause rank of each fault, with the same alarm and detection rules as the v1 evaluation. */
function faultRanks(traces: Trace[], e: Engine) {
  const out: { run: string; id: string; cls: string; target: string; detected: boolean; delay: number | null; rank: number | null; n: number }[] = [];
  for (const t of traces) {
    const v = t.moments.map((_, i) => e(t, i));
    const alarm = v.map((x, i) => x.max >= 1 && i > 0 && v[i - 1].max >= 1);
    for (const f of t.faults) {
      const touches = new Set([f.target, ...f.affected]);
      let first = -1, settled = -1;
      for (let i = 0; i < t.moments.length; i++) {
        const ts = t.moments[i].ts;
        if (ts < f.a || ts > f.b + 60000 || !alarm[i]) continue;
        if (!v[i].ranked.slice(0, 3).some((x) => touches.has(x))) continue;
        if (first < 0) first = i;
        if (ts <= f.b) settled = i;
      }
      const k = settled >= 0 ? v[settled].ranked.indexOf(f.target) : -1;
      out.push({ run: t.name, id: f.id, cls: f.class, target: f.target, detected: first >= 0, delay: first >= 0 ? Math.max(0, (t.moments[first].ts - f.a) / 1000) : null,
        rank: first >= 0 ? (k >= 0 ? k + 1 : t.moments[0].services.length + 1) : null, n: t.moments[0].services.length });
    }
  }
  return out;
}

function momentScores(traces: Trace[], e: Engine) {
  const s: number[] = [], y: number[] = [];
  for (const t of traces) t.moments.forEach((m, i) => {
    if (m.ts < t.t0 + 300000) return;                       // warm-up
    s.push(r3(Math.min(e(t, i).max, 20)));
    y.push(t.faults.some((f) => m.ts >= f.a && m.ts <= f.b) ? 1 : 0);
  });
  return { s, y };
}

/** Level matrices around a few real faults (services x moments) for the case-study figure. */
function caseWindow(t: Trace, faultId: string, e: Engine) {
  const f = t.faults.find((x) => x.id === faultId)!;
  const i0 = t.moments.findIndex((m) => m.ts >= f.a - 90000), i1 = t.moments.findIndex((m) => m.ts > f.b + 70000);
  const idx = Array.from({ length: (i1 < 0 ? t.moments.length : i1) - i0 }, (_, k) => i0 + k);
  const services = [...t.moments[0].services].filter((s) => s !== 'traffic').sort();
  const v = idx.map((i) => e(t, i));
  return {
    run: t.name, fault: { id: f.id, cls: f.class, target: f.target, a: f.a, b: f.b, affected: f.affected }, services,
    others: t.faults.filter((o) => o !== f && o.a < t.moments[idx[idx.length - 1]].ts && o.b > t.moments[idx[0]].ts).map((o) => ({ id: o.id, cls: o.class, target: o.target, a: o.a, b: o.b })),
    ts: idx.map((i) => t.moments[i].ts),
    level: services.map((s) => idx.map((i) => r3(Math.min(t.moments[i].ml[s]?.[0] ?? 0, 10)))),
    rules: services.map((s) => idx.map((i) => r3(Math.min(t.moments[i].rules[s] ?? 0, 10)))),
    walk: services.map((s) => idx.map((i) => t.moments[i].ml[s]?.[5] ?? 0)),
    hard: services.map((s) => idx.map((i) => t.moments[i].ml[s]?.[4] ?? 0)),
    alarm: v.map((x, k) => (x.max >= 1 && k > 0 && v[k - 1].max >= 1 ? 1 : 0)), top1: v.map((x) => x.ranked[0]),
    status: services.map((s) => idx.map((i) => t.moments[i].status[s] ?? 'unknown')),
  };
}

const result: any = { engines: Object.keys(ENGINES), thetas: THETAS, sets: {} };
for (const [name, traces] of Object.entries(sets)) {
  const hours = traces.reduce((a, t) => a + (t.t1 - t.t0) / 3.6e6, 0);
  const blk: any = { faults: traces.reduce((a, t) => a + t.faults.length, 0), hours: r3(hours), op: {}, moments: {}, ranks: {}, summary: {} };
  for (const [en, e] of Object.entries(ENGINES)) {
    const s = score(traces, e);
    blk.summary[en] = { detected: s.detected, top1OfDetected: s.top1OfDetected, caughtAndNamed: s.caughtAndNamed, falseAlarmsPerHour: s.falseAlarmsPerHour, alarmShare: s.alarmShare };
    blk.ranks[en] = faultRanks(traces, e);
    if (OPERATING.includes(en)) {
      blk.op[en] = THETAS.map((th) => { const q = score(traces, scaled(e, th)); return { th, det: q.detected, cn: q.caughtAndNamed, fa: q.falseAlarmsPerHour, alarm: q.alarmShare }; });
      blk.moments[en] = momentScores(traces, e);
    }
    console.log(name, en.padEnd(30), `det ${(s.detected * 100).toFixed(0)}  c+n ${(s.caughtAndNamed * 100).toFixed(0)}  fa ${s.falseAlarmsPerHour.toFixed(1)}  alarm ${(s.alarmShare * 100).toFixed(0)}%`);
  }
  result.sets[name] = blk;
}
// case studies on the real runs: a memory leak that spreads, a crash loop, and a brownout
const pick = (cls: string, want: (r: any) => boolean = () => true) => { for (const t of sets.real) for (const f of t.faults) if (f.class === cls && want({ t, f })) return { t, id: f.id }; return null; };
result.cases = [];
for (const [cls, label] of [['memory', 'memory leak'], ['crash-loop', 'crash loop'], ['brownout', 'brownout']] as const) {
  const p = pick(cls, ({ t, f }) => f.affected.length >= 1 && t.subject === 'shopflow') ?? pick(cls);
  if (p) result.cases.push({ label, ...caseWindow(p.t, p.id, V1.hybrid) });
}
fs.mkdirSync(path.join(root, 'paper/data'), { recursive: true });
fs.writeFileSync(path.join(root, 'paper/data/curves.json'), JSON.stringify(result));
console.log('wrote paper/data/curves.json');
