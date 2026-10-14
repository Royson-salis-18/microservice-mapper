// tools/ml/evaluate.ts: judge a scorer the way an operator would feel it — per fault and per alarm, not per row. PURE.
//
//   alarm       some service scores at or above the threshold in two consecutive moments (one-off spikes do not page anyone)
//   detected    an alarm during the fault (or within `graceSec` after it) whose top three services include the faulted
//               service or something that depends on it
//   Top-1       at the last alarming moment before the fault was healed, the highest-scoring service IS the faulted one
//   false alarm an alarm episode that overlaps no fault window, counted per hour of fault-free time after warm-up
import type { Run } from './dataset.ts';
import { wilson } from '../eval/score.ts';

export type Scores = (runIdx: number, momentIdx: number) => number[];   // one score per service of that moment

export interface EventResult {
  faults: { run: string; id: string; class: string; target: string; detected: boolean; top1: boolean; delaySec: number | null; predicted: string | null; isolated: boolean }[];
  detected: ReturnType<typeof wilson>; top1: ReturnType<typeof wilson>; top1All: ReturnType<typeof wilson>;
  falseAlarms: number; fpHours: number; perHour: number; medianDelay: number;
}

const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export function evaluate(runs: Run[], scores: Scores | 'live', threshold: number, opts: { graceSec?: number; warmupSec?: number } = {}): EventResult {
  const grace = (opts.graceSec ?? 60) * 1000, warmup = (opts.warmupSec ?? 300) * 1000;
  const faults: EventResult['faults'] = [];
  let falseAlarms = 0, fpMs = 0;
  runs.forEach((run, ri) => {
    const n = run.moments.length;
    const top: { alarm: boolean; ranked: string[] }[] = run.moments.map((m, mi) => {
      if (scores === 'live') return { alarm: m.live.alarm, ranked: m.live.root ? [m.live.root, ...m.live.top3.filter((x) => x !== m.live.root)] : m.live.top3 };
      const sc = scores(ri, mi);
      const order = m.services.map((id, i) => [id, sc[i]] as const).sort((a, b) => b[1] - a[1]);
      return { alarm: (order[0]?.[1] ?? 0) >= threshold, ranked: order.map((o) => o[0]) };
    });
    // persistence: two consecutive moments
    const alarm = top.map((t, i) => (scores === 'live' ? t.alarm : t.alarm && i > 0 && top[i - 1].alarm));
    const windows = run.faults.map((f) => [f.a, f.b + grace] as const);
    for (const f of run.faults) {
      const touches = new Set([f.target, ...(f.truth?.expectedAffected ?? [])]);
      let first: number | null = null, settled: string | null = null;
      for (let i = 0; i < n; i++) {
        const t = run.moments[i].ts;
        if (t < f.a || t > f.b + grace || !alarm[i]) continue;
        if (!top[i].ranked.slice(0, 3).some((x) => touches.has(x))) continue;
        if (first === null) first = t;
        if (t <= f.b) settled = top[i].ranked[0] ?? null;
      }
      const isolated = !run.faults.some((o) => o !== f && o.a < f.b + 30000 && o.b > f.a);
      faults.push({ run: run.name, id: f.id, class: f.class, target: f.target, detected: first !== null, top1: settled === f.target,
        delaySec: first === null ? null : Math.max(0, (first - f.a) / 1000), predicted: settled, isolated });
    }
    // false alarms: alarm episodes after warm-up that overlap no fault window
    let i = 0;
    while (i < n) {
      if (!alarm[i]) { i++; continue; }
      let j = i; while (j + 1 < n && alarm[j + 1]) j++;
      const s = run.moments[i].ts, e = run.moments[j].ts;
      if (s >= run.t0 + warmup && !windows.some(([a, b]) => s <= b && e >= a)) falseAlarms++;
      i = j + 1;
    }
    // fault-free time after warm-up
    for (let k = 1; k < n; k++) {
      const t = run.moments[k].ts;
      if (t < run.t0 + warmup) continue;
      if (!windows.some(([a, b]) => t >= a && t <= b)) fpMs += t - run.moments[k - 1].ts;
    }
  });
  const det = faults.filter((f) => f.detected);
  const fpHours = fpMs / 3.6e6;
  return {
    faults, detected: wilson(det.length, faults.length), top1: wilson(det.filter((f) => f.top1).length, det.length),
    top1All: wilson(faults.filter((f) => f.top1).length, faults.length),
    falseAlarms, fpHours, perHour: fpHours ? falseAlarms / fpHours : 0, medianDelay: median(det.map((f) => f.delaySec!)),
  };
}

/**
 * Pick the alarm threshold from data: the one that maximises the harmonic mean of "faults caught with the right service
 * first" and "alarms that were real", on the TRAINING runs only. Candidates are the observed score quantiles.
 */
export function tuneThreshold(runs: Run[], scores: Scores): { threshold: number; objective: number } {
  const all: number[] = [];
  runs.forEach((run, ri) => run.moments.forEach((_, mi) => { const s = scores(ri, mi); all.push(Math.max(...s)); }));
  all.sort((a, b) => a - b);
  const cands = [...new Set(Array.from({ length: 60 }, (_, k) => all[Math.min(all.length - 1, Math.floor((0.5 + 0.5 * k / 59) * (all.length - 1)))]))];
  let best = { threshold: cands[cands.length - 1] ?? 0.5, objective: -1 };
  for (const th of cands) {
    const r = evaluate(runs, scores, th);
    const caught = r.faults.length ? r.faults.filter((f) => f.detected && f.top1).length / r.faults.length : 0;
    const episodes = r.faults.filter((f) => f.detected).length + r.falseAlarms;
    const precision = episodes ? r.faults.filter((f) => f.detected).length / episodes : 0;
    const obj = caught + precision ? (2 * caught * precision) / (caught + precision) : 0;
    if (obj > best.objective + 1e-9) best = { threshold: th, objective: obj };
  }
  return best;
}
