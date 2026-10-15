// server/algorithms/learning/experiment.ts: training, blocked cross-validation and cross-system testing, shared by `npm run ml` and the report. PURE.
import { labelledRows, slice, FEATURE_NAMES, type Run } from './dataset.ts';
import { fit, predict, type Model } from './logreg.ts';
import { evaluatePrepared, prepare, tuneThreshold, type EvalOpts, type EventResult, type FaultOutcome, type Scores, type TuneResult } from './evaluate.ts';
import { rulesScore } from '../detection/scoring.ts';

export const LAMBDAS = [0.1, 1, 10, 100];
export type Method = 'learned' | 'rulesFixed' | 'rulesTuned' | 'live';
export const METHODS: Method[] = ['learned', 'rulesFixed', 'rulesTuned', 'live'];
export const RULES_FIXED_THRESHOLD = 3;      // the rule-based score is in z units; 3 is the usual "three sigma" line

export const scorer = (rs: Run[], f: (x: number[]) => number): Scores => (ri, mi) => rs[ri].moments[mi].X.map(f);

export function rowsOf(rs: Run[], keep?: (r: Run, ts: number) => boolean) {
  const X: number[][] = [], y: number[] = [];
  for (const r of rs) { const d = labelledRows(r, { keep: keep ? (ts) => keep(r, ts) : undefined }); X.push(...d.X); y.push(...d.y); }
  return { X, y };
}

export interface Trained { model: Model; threshold: number; objective: number; curve: TuneResult['curve']; lambdaCurve: { lambda: number; objective: number }[] }

/** Fit one logistic model per lambda on the rows kept, pick the lambda and threshold by the event objective on the same (training) data. */
export function train(rs: Run[], keep?: (r: Run, ts: number) => boolean, opts: EvalOpts = {}, lambdas = LAMBDAS): Trained {
  const { X, y } = rowsOf(rs, keep);
  const trainRuns = keep ? rs.map((r) => ({ ...r, moments: r.moments.filter((m) => keep(r, m.ts)), faults: r.faults.filter((f) => keep(r, f.a)) })) : rs;
  let best: Trained | null = null;
  const lambdaCurve: Trained['lambdaCurve'] = [];
  // strongest regularisation first, and only a strictly better objective replaces it: on ties the simpler (more shrunk) model wins
  for (const l of [...lambdas].sort((a, b) => b - a)) {
    const model = fit(X, y, FEATURE_NAMES, l);
    const t = tuneThreshold(trainRuns, scorer(trainRuns, (x) => predict(model, x)), opts);
    lambdaCurve.push({ lambda: l, objective: t.objective });
    if (!best || t.objective > best.objective) best = { model, threshold: t.threshold, objective: t.objective, curve: t.curve, lambdaCurve };
  }
  return best!;
}

export const blockOf = (r: Run, ts: number, K: number) => Math.min(K - 1, Math.floor(((ts - r.t0) / Math.max(1, r.t1 - r.t0 + 1)) * K));

export interface Pooled { faults: FaultOutcome[]; falseAlarms: number; fpHours: number; alarmMs?: number }
export interface CV {
  pooled: Record<Method, Pooled>;
  /** Out-of-fold row scores and labels, for ROC / precision-recall / calibration. */
  rows: { learned: { s: number; y: number }[]; rules: { s: number; y: number }[] };
  folds: { k: number; threshold: number; heurTuned: number; faults: number }[];
}

/** Blocked K-fold over time: each run is cut into K consecutive blocks; the model never sees the block it is tested on. */
export function crossValidate(runs: Run[], K: number, opts: EvalOpts = {}, lambdas = LAMBDAS): CV {
  const pooled = Object.fromEntries(METHODS.map((m) => [m, { faults: [], falseAlarms: 0, fpHours: 0 }])) as Record<Method, Pooled>;
  const rows = { learned: [] as { s: number; y: number }[], rules: [] as { s: number; y: number }[] };
  const folds: CV['folds'] = [];
  for (let k = 0; k < K; k++) {
    const keepTrain = (r: Run, ts: number) => blockOf(r, ts, K) !== k;
    const test = runs.map((r) => { const from = r.t0 + ((r.t1 - r.t0 + 1) * k) / K, to = r.t0 + ((r.t1 - r.t0 + 1) * (k + 1)) / K; return slice(r, from, to); }).filter((r) => r.moments.length);
    if (!test.some((r) => r.faults.length)) continue;
    const tr = train(runs, keepTrain, opts, lambdas);
    const trainRuns = runs.map((r) => ({ ...r, moments: r.moments.filter((m) => keepTrain(r, m.ts)), faults: r.faults.filter((f) => keepTrain(r, f.a)) }));
    const hTuned = tuneThreshold(trainRuns, scorer(trainRuns, rulesScore), opts).threshold;
    const learnedPrep = prepare(test, scorer(test, (x) => predict(tr.model, x))), rulesPrep = prepare(test, scorer(test, rulesScore));
    const res: Record<Method, EventResult> = {
      learned: evaluatePrepared(learnedPrep, null, tr.threshold, opts),
      rulesFixed: evaluatePrepared(rulesPrep, null, RULES_FIXED_THRESHOLD, opts),
      rulesTuned: evaluatePrepared(rulesPrep, null, hTuned, opts),
      live: evaluatePrepared('live', test, 0.5, opts),
    };
    for (const m of METHODS) { pooled[m].faults.push(...res[m].faults); pooled[m].falseAlarms += res[m].falseAlarms; pooled[m].fpHours += res[m].fpHours; }
    for (const r of test) {
      const d = labelledRows(r, { warmupSec: 0, recoverySec: 60 });
      d.X.forEach((x, i) => { rows.learned.push({ s: predict(tr.model, x), y: d.y[i] }); rows.rules.push({ s: rulesScore(x), y: d.y[i] }); });
    }
    folds.push({ k, threshold: tr.threshold, heurTuned: hTuned, faults: test.reduce((s, r) => s + r.faults.length, 0) });
  }
  return { pooled, rows, folds };
}

export function summarise(p: Pooled) {
  const det = p.faults.filter((f) => f.detected), d = det.map((f) => f.delaySec!).sort((a, b) => a - b);
  return {
    faults: p.faults.length, detected: det.length / Math.max(1, p.faults.length), detectedN: det.length,
    top1OfDetected: det.filter((f) => f.top1).length / Math.max(1, det.length), top1N: det.filter((f) => f.top1).length,
    caughtAndNamed: p.faults.filter((f) => f.top1).length / Math.max(1, p.faults.length),
    falseAlarmsPerHour: p.fpHours ? p.falseAlarms / p.fpHours : 0, falseAlarms: p.falseAlarms,
    /** share of fault-free time spent in alarm */
    alarmShare: p.fpHours && p.alarmMs !== undefined ? p.alarmMs / 3.6e6 / p.fpHours : null,
    medianDelaySec: d.length ? d[Math.floor(d.length / 2)] : null,
  };
}

/** Train on all runs of other subjects, test on this subject: does it work on a system it never saw? */
export function crossSystem(runs: Run[], opts: EvalOpts = {}) {
  const subjects = [...new Set(runs.map((r) => r.subject))];
  const out: { label: string; learned: ReturnType<typeof summarise>; rules: ReturnType<typeof summarise>; live: ReturnType<typeof summarise> }[] = [];
  if (subjects.length < 2) return out;
  for (const s of subjects) {
    const tr = runs.filter((r) => r.subject !== s), te = runs.filter((r) => r.subject === s);
    const t = train(tr, undefined, opts);
    const hT = tuneThreshold(tr, scorer(tr, rulesScore), opts).threshold;
    const l = evaluatePrepared(prepare(te, scorer(te, (x) => predict(t.model, x))), null, t.threshold, opts);
    const r = evaluatePrepared(prepare(te, scorer(te, rulesScore)), null, hT, opts);
    const v = evaluatePrepared('live', te, 0.5, opts);
    const pool = (e: EventResult): Pooled => ({ faults: e.faults, falseAlarms: e.falseAlarms, fpHours: e.fpHours });
    out.push({ label: `train ${tr.map((x) => x.subject).filter((v2, i, a) => a.indexOf(v2) === i).join('+')} → test ${s}`, learned: summarise(pool(l)), rules: summarise(pool(r)), live: summarise(pool(v)) });
  }
  return out;
}
