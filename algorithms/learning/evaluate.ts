// algorithms/learning/evaluate.ts: judge a scorer the way an operator would feel it — per fault and per alarm, not per row. PURE.
//
//   alarm       the highest-scoring service is at or above the threshold in `persistence` consecutive moments (one-off spikes do not page anyone)
//   detected    an alarm during the fault (or within `graceSec` after it) whose top three services include the faulted
//               service or something that depends on it
//   Top-1       at the last alarming moment before the fault was healed, the highest-scoring service IS the faulted one
//   false alarm an alarm episode that overlaps no fault window, counted per hour of fault-free time after warm-up
import type { Run } from './dataset.ts';
import { wilson } from '../evaluation/score.ts';

export type Scores = (runIdx: number, momentIdx: number) => number[];   // one score per service of that moment

export interface FaultOutcome { run: string; id: string; class: string; target: string; detected: boolean; top1: boolean; delaySec: number | null; predicted: string | null; isolated: boolean }
export interface EventResult {
  faults: FaultOutcome[];
  detected: ReturnType<typeof wilson>; top1: ReturnType<typeof wilson>; top1All: ReturnType<typeof wilson>;
  falseAlarms: number; fpHours: number; perHour: number; medianDelay: number;
}
export interface EvalOpts { graceSec?: number; warmupSec?: number; persistence?: number }

const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Scores sorted once per moment, so many thresholds can be tried cheaply. */
export interface Prepared { runs: Run[]; top: { max: number; ranked: string[]; scores: number[] }[][] }

export function prepare(runs: Run[], scores: Scores): Prepared {
  return {
    runs,
    top: runs.map((run, ri) => run.moments.map((m, mi) => {
      const sc = scores(ri, mi);
      const order = m.services.map((id, i) => [id, sc[i]] as const).sort((a, b) => b[1] - a[1]);
      return { max: order[0]?.[1] ?? 0, ranked: order.map((o) => o[0]), scores: sc };
    })),
  };
}

const liveTop = (runs: Run[]): Prepared['top'] => runs.map((run) => run.moments.map((m) => ({ max: m.live.alarm ? 1 : 0, ranked: m.live.root ? [m.live.root, ...m.live.top3.filter((x) => x !== m.live.root)] : m.live.top3, scores: [] })));

export function evaluatePrepared(prep: Prepared | 'live', runsIn: Run[] | null, threshold: number, opts: EvalOpts = {}): EventResult {
  const runs = prep === 'live' ? runsIn! : prep.runs;
  const top = prep === 'live' ? liveTop(runs) : prep.top;
  const grace = (opts.graceSec ?? 60) * 1000, warmup = (opts.warmupSec ?? 300) * 1000, K = Math.max(1, opts.persistence ?? 2);
  const faults: FaultOutcome[] = [];
  let falseAlarms = 0, fpMs = 0;
  runs.forEach((run, ri) => {
    const n = run.moments.length, t = top[ri];
    const hot = t.map((x) => x.max >= threshold);
    const alarm = hot.map((h, i) => (prep === 'live' ? h : h && i >= K - 1 && hot.slice(i - K + 1, i).every(Boolean)));
    const windows = run.faults.map((f) => [f.a, f.b + grace] as const);
    for (const f of run.faults) {
      const touches = new Set([f.target, ...(f.truth?.expectedAffected ?? [])]);
      let first: number | null = null, settled: string | null = null;
      for (let i = 0; i < n; i++) {
        const ts = run.moments[i].ts;
        if (ts < f.a || ts > f.b + grace || !alarm[i]) continue;
        if (!t[i].ranked.slice(0, 3).some((x) => touches.has(x))) continue;
        if (first === null) first = ts;
        if (ts <= f.b) settled = t[i].ranked[0] ?? null;
      }
      const isolated = !run.faults.some((o) => o !== f && o.a < f.b + 30000 && o.b > f.a);
      faults.push({ run: run.name, id: f.id, class: f.class, target: f.target, detected: first !== null, top1: settled === f.target,
        delaySec: first === null ? null : Math.max(0, (first - f.a) / 1000), predicted: settled, isolated });
    }
    let i = 0;
    while (i < n) {
      if (!alarm[i]) { i++; continue; }
      let j = i; while (j + 1 < n && alarm[j + 1]) j++;
      const s = run.moments[i].ts, e = run.moments[j].ts;
      if (s >= run.t0 + warmup && !windows.some(([a, b]) => s <= b && e >= a)) falseAlarms++;
      i = j + 1;
    }
    for (let k = 1; k < n; k++) {
      const ts = run.moments[k].ts;
      if (ts < run.t0 + warmup) continue;
      if (!windows.some(([a, b]) => ts >= a && ts <= b)) fpMs += ts - run.moments[k - 1].ts;
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

export function evaluate(runs: Run[], scores: Scores | 'live', threshold: number, opts: EvalOpts = {}): EventResult {
  return scores === 'live' ? evaluatePrepared('live', runs, threshold, opts) : evaluatePrepared(prepare(runs, scores), null, threshold, opts);
}

/** The objective used to pick a threshold: harmonic mean of "faults caught with the right service first" and "alarms that were real". */
export function objective(r: EventResult): number {
  const caught = r.faults.length ? r.faults.filter((f) => f.detected && f.top1).length / r.faults.length : 0;
  const episodes = r.faults.filter((f) => f.detected).length + r.falseAlarms;
  const precision = episodes ? r.faults.filter((f) => f.detected).length / episodes : 0;
  return caught + precision ? (2 * caught * precision) / (caught + precision) : 0;
}

export interface TuneResult { threshold: number; objective: number; curve: { threshold: number; objective: number; detected: number; top1: number; perHour: number }[] }

/** Pick the alarm threshold from data, on the TRAINING runs only. Candidates are quantiles of the observed top scores. */
export function tuneThreshold(runs: Run[], scores: Scores, opts: EvalOpts = {}, candidates = 60): TuneResult {
  const prep = prepare(runs, scores);
  const all = prep.top.flatMap((t) => t.map((x) => x.max)).sort((a, b) => a - b);
  const cands = [...new Set(Array.from({ length: candidates }, (_, k) => all[Math.min(all.length - 1, Math.floor((0.5 + 0.5 * k / (candidates - 1)) * (all.length - 1)))]))];
  let best = { threshold: cands[cands.length - 1] ?? 0.5, objective: -1 };
  const curve: TuneResult['curve'] = [];
  for (const th of cands) {
    const r = evaluatePrepared(prep, null, th, opts), obj = objective(r);
    curve.push({ threshold: th, objective: obj, detected: r.detected.p, top1: r.top1.p, perHour: r.perHour });
    if (obj > best.objective + 1e-9) best = { threshold: th, objective: obj };
  }
  return { ...best, curve };
}
