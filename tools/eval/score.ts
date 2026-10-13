// tools/eval/score.ts: score a mapper against the fault injector's private ledger. PURE: files in, numbers out.
//
// The mapper is observed only through its public API (observe.ts). The ledger is read only AFTER the run. Nothing here
// can influence what the mapper did, which is the point.
//
// Definitions (documented in docs/FAULT_INJECTION.md section 11):
//   fault window      [a, b]  from "applied" to "healed"; detection window [a, b + grace]
//   localised         an incident open in the detection window whose top-3 candidates or affected set touch the fault's
//                     root or any service that depends on it ("an incident that is about this fault")
//   detection delay   first localised snapshot minus a (0 if the incident was already open: flagged `preexisting`)
//   Top-k             the root is within the first k candidates of the LAST ranking before heal ("settled"); `initial` is the first
//   structural truth  expectedAffected(f) = every service that depends on the root (what could break)
//   observed impact   services that actually went non-healthy during the window (what did break)
//   false alarm       incident time outside every detection window


import { FAMILY_OF, FAMILIES, inferFamily } from './infer.ts';
import { moments, spearman, corrP, bootstrapCI, kFold, binomUpper, kappa } from './stats.ts';

export interface LedgerFault {
  id: string; class: string; target: string; source: string; compoundOf?: string;
  durationSec: number; a: number; b: number; failed?: string; recovery?: string;
  truth: { rootCause: string; expectedAffected: string[]; blastShare: number };
}
export interface SnapIncident {
  id: string; status: string; severity: string; startedAt: number; endedAt: number | null; root: string | null; confidence: string;
  candidates: string[]; affected: string[]; atRisk: { id: string; risk: number }[]; monitoringGap?: boolean; rootEvidence?: string[];
}
export interface Snapshot { ts: number; incidents: SnapIncident[]; status: Record<string, string> }

/** One 5-second window of what the traffic generator experienced (users' view, independent of the mapper). */
export interface ImpactSample { ts: number; n: number; p95: number; err: number }
/**
 * Parse `docker logs -t <traffic container>`: lines like
 *   2026-10-13T15:03:23.456Z 15:03:23 n=23 p50=5ms p95=10ms err5xx/net=0.0%
 * Pure: the text is read elsewhere.
 */
export function parseTrafficLog(text: string): ImpactSample[] {
  const out: ImpactSample[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z?)\s+\S+\s+n=(\d+)\s+p50=\d+ms\s+p95=(\d+)ms\s+err5xx\/net=([\d.]+)%/.exec(line.trim());
    if (m) out.push({ ts: Date.parse(m[1]), n: Number(m[2]), p95: Number(m[3]), err: Number(m[4]) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export const norm = (id: string | null | undefined): string => (id ? (id.includes(':') ? id.split(':').slice(1).join(':') : id) : '');

// ---------------------------------------------------------------- loading
export function parseLedger(text: string): { faults: LedgerFault[]; campaigns: { seed: string; ts: number }[] } {
  const starts = new Map<string, any>(), ends = new Map<string, any>(); const campaigns: { seed: string; ts: number }[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'fault-start') starts.set(r.id, r);
    else if (r.type === 'fault-end') ends.set(r.id, r);
    else if (r.type === 'campaign-start') campaigns.push({ seed: r.seed, ts: r.ts });
  }
  const faults: LedgerFault[] = [];
  for (const [id, s] of starts) {
    const e = ends.get(id);
    const a = e?.appliedAt ?? s.startedAt, b = e?.healedAt ?? e?.endedAt ?? (s.startedAt + s.durationSec * 1000);
    faults.push({ id, class: s.class, target: s.target, source: s.source ?? 'plan', compoundOf: s.compoundOf, durationSec: s.durationSec, a, b, failed: e?.error, recovery: e?.recovery, truth: s.truth });
  }
  return { faults: faults.sort((x, y) => x.a - y.a), campaigns };
}
export function parseObserved(text: string): Snapshot[] {
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) as Snapshot; } catch { return null; } }).filter((s): s is Snapshot => !!s).sort((x, y) => x.ts - y.ts);
}

// ---------------------------------------------------------------- statistics
/** Wilson score interval for a proportion (95% by default): well behaved for small n and for p near 0 or 1. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number; n: number } {
  if (n === 0) return { p: NaN, lo: NaN, hi: NaN, n };
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d), n };
}
const quantile = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
/** AUC by the rank-sum (Mann-Whitney) identity; ties get average rank. */
export function auc(scores: number[], labels: number[]): number {
  const pos = labels.filter((l) => l === 1).length, neg = labels.length - pos;
  if (!pos || !neg) return NaN;
  const idx = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(scores.length); let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[idx[k][1]] = r; i = j + 1; }
  const sumPos = labels.reduce((s, l, k) => s + (l === 1 ? ranks[k] : 0), 0);
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

// ---------------------------------------------------------------- scoring
export interface FaultResult {
  id: string; class: string; target: string; concurrent: number; a: number; b: number;
  detected: boolean; anyIncident: boolean; preexisting: boolean; delaySec: number | null;
  rankSettled: number | null; rankInitial: number | null; top1: boolean; top3: boolean; top1Initial: boolean; top1AnyActive: boolean; predictedRoot: string | null;
  structural: { precision: number; recall: number; f1: number } | null;
  observed: { precision: number; recall: number; f1: number; impacted: number } | null;
  preWarned: { warned: number; of: number } | null;
  /** True when no other fault overlapped this one (nor its 30 s tail): only then can user impact be attributed to it. */
  isolated: boolean;
  /** What kind of fault the mapper's own evidence on its named root suggests, and whether it is the family that was injected. Null when nothing was detected. */
  /** Did the fault change anything measurable? 'felt': container state changed (crash, stop, crash-loop, pause) or users saw errors/slowness. 'none': a soft fault (brownout, flap, memory, partition) that ran alone, with traffic measured, and users saw nothing. 'unknown': cannot be told (overlapping faults or no traffic log). 'none' faults are not ground truth for the confusion matrices. */
  effect: 'felt' | 'none' | 'unknown';
  inferredFamily: string | null; trueFamily: string; familyMatch: boolean | null; chance: number | null;
  /** What users experienced during the fault, from the traffic generator. Null when no traffic log was supplied OR the fault was
   *  not isolated (with another fault running, any impact could be that one's). */
  userImpact: { visible: boolean; errPctMax: number; errPctMean: number; p95Ratio: number } | null;
}
export interface Score {
  options: { graceSec: number; atRiskHorizonSec: number };
  faults: FaultResult[]; excluded: { id: string; reason: string }[];
  overall: any; byClass: Record<string, any>; falseAlarm: { episodes: number; minutes: number; perHour: number; spanHours: number; warmupMinutes?: number; warmupIncidents?: number };
  calibration: { n: number; brier: number; ece: number; auc: number; bins: { lo: number; hi: number; n: number; meanRisk: number; rate: number }[] } | null;
  confusion: { truth: string[]; predicted: string[]; counts: number[][] };
  noEffect: { n: number; detected: number; items: { id: string; class: string; target: string; detected: boolean }[] };
  kindConfusion: { truth: string[]; predicted: string[]; counts: number[][]; accuracy: any; kappa: number };
  research: any;
}

const f1 = (p: number, r: number) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
const prf = (pred: Set<string>, truth: Set<string>) => {
  const hit = [...pred].filter((x) => truth.has(x)).length;
  const precision = pred.size ? hit / pred.size : (truth.size ? 0 : 1), recall = truth.size ? hit / truth.size : 1;
  return { precision, recall, f1: f1(precision, recall) };
};

export function score(faultsIn: LedgerFault[], snaps: Snapshot[], opts: { graceSec?: number; atRiskHorizonSec?: number; warmupSec?: number } = {}, impact: ImpactSample[] = []): Score {
  const graceSec = opts.graceSec ?? 60, horizon = opts.atRiskHorizonSec ?? 120;
  const excluded: { id: string; reason: string }[] = [];
  const faults = faultsIn.filter((f) => { if (f.failed) { excluded.push({ id: f.id, reason: `injection failed: ${f.failed.slice(0, 80)}` }); return false; } return true; });
  const results: FaultResult[] = [];
  const grace = graceSec * 1000;
  // Users' baseline: latency and errors in windows well clear of every fault.
  const calm = impact.filter((x) => !faults.some((f) => x.ts >= f.a - 30000 && x.ts <= f.b + 60000));
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  const baseP95 = Math.max(5, med((calm.length >= 6 ? calm : impact).map((x) => x.p95)));
  const baseErr = med((calm.length >= 6 ? calm : impact).map((x) => x.err)) || 0;

  for (const f of faults) {
    const win = snaps.filter((s) => s.ts >= f.a && s.ts <= f.b + grace);
    const touches = new Set([f.truth.rootCause, ...f.truth.expectedAffected]);
    const concurrentFaults = faults.filter((o) => o.a < f.b && o.b > f.a);
    const activeRoots = new Set(concurrentFaults.map((o) => o.truth.rootCause));
    const localised = (i: SnapIncident) => i.candidates.slice(0, 3).some((c) => touches.has(c)) || i.affected.some((c) => touches.has(c)) || touches.has(i.root ?? '');
    const first = win.find((s) => s.incidents.some(localised));
    const anyIncident = win.some((s) => s.incidents.length > 0);
    const preexisting = !!first && first.incidents.some((i) => localised(i) && i.startedAt < f.a - 2000);
    const delaySec = first ? Math.max(0, (first.ts - f.a) / 1000) : null;
    const inFault = win.filter((s) => s.ts <= f.b && s.incidents.some(localised));
    const settledSnap = inFault.at(-1) ?? first, initialSnap = first;
    const pick = (s?: Snapshot) => s?.incidents.filter(localised).sort((x, y) => y.candidates.length - x.candidates.length)[0];
    const sIn = pick(settledSnap), iIn = pick(initialSnap);
    const rankOf = (i?: SnapIncident) => { if (!i) return null; const k = i.candidates.indexOf(f.truth.rootCause); return k < 0 ? null : k + 1; };
    const rankSettled = rankOf(sIn), rankInitial = rankOf(iIn);
    const top = sIn?.candidates[0] ?? null;

    // structural and observed cascade
    let structural: FaultResult['structural'] = null, observed: FaultResult['observed'] = null, preWarned: FaultResult['preWarned'] = null;
    if (sIn) {
      const pred = new Set(sIn.affected.filter((x) => x !== f.truth.rootCause));
      structural = prf(pred, new Set(f.truth.expectedAffected));
      const before = [...snaps].reverse().find((s) => s.ts < f.a);
      const impactedAt = new Map<string, number>();
      for (const s of snaps.filter((x) => x.ts >= f.a && x.ts <= f.b)) for (const [id, st] of Object.entries(s.status)) {
        if (st !== 'healthy' && id !== f.truth.rootCause && (before?.status[id] ?? 'healthy') === 'healthy' && !impactedAt.has(id)) impactedAt.set(id, s.ts);
      }
      const truthObs = new Set(impactedAt.keys());
      observed = { ...prf(pred, truthObs), impacted: truthObs.size };
      if (truthObs.size) {
        let warned = 0;
        for (const [id, t] of impactedAt) if (snaps.some((s) => s.ts >= f.a && s.ts < t && s.incidents.some((i) => i.atRisk.some((r) => r.id === id)))) warned++;
        preWarned = { warned, of: truthObs.size };
      }
    }
    // Did users feel it? Visible = errors clearly above their baseline (>= +1 point mean) or p95 at least 3x baseline and 50 ms worse.
    let userImpact: FaultResult['userImpact'] = null;
    const isolated = !faults.some((o) => o !== f && o.a < f.b + 30000 && o.b > f.a);
    const win2 = impact.filter((x) => x.ts >= f.a && x.ts <= f.b + 10000 && x.n > 0);
    if (isolated && win2.length >= 2) {
      const errMean = win2.reduce((s, x) => s + x.err, 0) / win2.length, errMax = Math.max(...win2.map((x) => x.err));
      const p95Ratio = Math.max(...win2.map((x) => x.p95)) / baseP95, p95Worse = Math.max(...win2.map((x) => x.p95)) - baseP95;
      userImpact = { visible: errMean - baseErr >= 1 || (p95Ratio >= 3 && p95Worse >= 50), errPctMax: errMax, errPctMean: errMean, p95Ratio };
    }
    const evidence = [...new Set(inFault.flatMap((s) => s.incidents.filter((i) => localised(i) && i.root === f.truth.rootCause).flatMap((i) => i.rootEvidence ?? [])))];
    const inferredFamily = first ? inferFamily(evidence) : null;
    const trueFamily = FAMILY_OF[f.class] ?? f.class;
    const hardFamily = ['down', 'frozen'].includes(FAMILY_OF[f.class] ?? '');
    const effect: FaultResult['effect'] = hardFamily ? 'felt' : userImpact ? (userImpact.visible ? 'felt' : 'none') : 'unknown';
    results.push({
      effect, inferredFamily, trueFamily, familyMatch: inferredFamily ? inferredFamily === trueFamily : null,
      chance: sIn && sIn.candidates.length ? 1 / sIn.candidates.length : null,
      id: f.id, class: f.class, target: f.target, concurrent: concurrentFaults.length, a: f.a, b: f.b,
      detected: !!first, anyIncident, preexisting, delaySec, rankSettled, rankInitial,
      top1: rankSettled === 1, top3: rankSettled !== null && rankSettled <= 3, top1Initial: rankInitial === 1,
      top1AnyActive: !!top && activeRoots.has(top), predictedRoot: top, structural, observed, preWarned, isolated, userImpact,
    });
  }

  // ---- aggregate
  const agg = (rs: FaultResult[]) => {
    const det = rs.filter((r) => r.detected);
    const delays = det.map((r) => r.delaySec!).filter((x) => x !== null);
    const rr = det.map((r) => (r.rankSettled ? 1 / r.rankSettled : 0));
    const sp = det.filter((r) => r.structural), op = det.filter((r) => r.observed), pw = det.filter((r) => r.preWarned);
    return {
      n: rs.length,
      detected: wilson(det.length, rs.length),
      top1: wilson(det.filter((r) => r.top1).length, det.length),
      top3: wilson(det.filter((r) => r.top3).length, det.length),
      top1Initial: wilson(det.filter((r) => r.top1Initial).length, det.length),
      top1AnyActive: wilson(det.filter((r) => r.top1AnyActive).length, det.length),
      mrr: mean(rr),
      delaySec: { median: quantile(delays, 0.5), p90: quantile(delays, 0.9), mean: mean(delays), values: delays },
      structural: { precision: mean(sp.map((r) => r.structural!.precision)), recall: mean(sp.map((r) => r.structural!.recall)), f1: mean(sp.map((r) => r.structural!.f1)) },
      observed: { precision: mean(op.map((r) => r.observed!.precision)), recall: mean(op.map((r) => r.observed!.recall)), f1: mean(op.map((r) => r.observed!.f1)), faultsWithImpact: op.filter((r) => r.observed!.impacted > 0).length },
      isolated: rs.filter((r) => r.isolated).length,
      visible: rs.filter((r) => r.userImpact?.visible).length,
      detectedWhenVisible: wilson(rs.filter((r) => r.userImpact?.visible && r.detected).length, rs.filter((r) => r.userImpact?.visible).length),
      detectedWhenInvisible: wilson(rs.filter((r) => r.userImpact && !r.userImpact.visible && r.detected).length, rs.filter((r) => r.userImpact && !r.userImpact.visible).length),
      preWarned: pw.length ? wilson(pw.reduce((s, r) => s + r.preWarned!.warned, 0), pw.reduce((s, r) => s + r.preWarned!.of, 0)) : null,
    };
  };
  const overall = { ...agg(results), isolated: agg(results.filter((r) => r.concurrent <= 1)), overlapping: agg(results.filter((r) => r.concurrent > 1)) };
  const byClass: Record<string, any> = {};
  for (const c of [...new Set(results.map((r) => r.class))].sort()) byClass[c] = agg(results.filter((r) => r.class === c));

  // ---- false alarms: incident time outside every detection window
  const windows = faults.map((f) => [f.a, f.b + grace] as const);
  // The learning period (the baseline stage) is reported apart: an incident there says the baseline was not ready, not that the mapper cried wolf.
  const warmupEnd = (snaps[0]?.ts ?? 0) + (opts.warmupSec ?? 0) * 1000;
  const warmupIds = new Set<string>();
  for (const s of snaps) if (s.ts < warmupEnd) for (const i of s.incidents) warmupIds.add(i.id);
  const ep = new Map<string, { s: number; e: number }>();
  for (const s of snaps.filter((x) => x.ts >= warmupEnd)) for (const i of s.incidents) { const cur = ep.get(i.id); const st = Math.max(i.startedAt, snaps[0]?.ts ?? i.startedAt); ep.set(i.id, { s: cur ? Math.min(cur.s, st) : st, e: Math.max(cur?.e ?? 0, i.endedAt ?? s.ts) }); }
  let faMs = 0, faEp = 0;
  for (const { s, e } of ep.values()) {
    const covered = windows.some(([a, b]) => s < b && e > a);
    if (!covered) { faEp++; faMs += e - s; }
    else {                                                        // time of a covered incident that runs past its window also counts
      const overshoot = Math.max(0, e - Math.max(...windows.filter(([a, b]) => s < b && e > a).map(([, b]) => b)));
      faMs += overshoot;
    }
  }
  const spanH = snaps.length > 1 ? Math.max(0, (snaps.at(-1)!.ts - Math.max(warmupEnd, snaps[0].ts)) / 3.6e6) : 0;
  const falseAlarm = { episodes: faEp, minutes: faMs / 60000, perHour: spanH ? faMs / 60000 / 60 / spanH * 60 : 0, spanHours: spanH, warmupMinutes: (opts.warmupSec ?? 0) / 60, warmupIncidents: warmupIds.size };
  falseAlarm.perHour = spanH ? faEp / spanH : 0;

  // ---- calibration of the at-risk list: did the service actually go non-healthy within the horizon?
  const samples: { risk: number; label: number }[] = [];
  for (let k = 0; k < snaps.length; k++) {
    const s = snaps[k];
    for (const inc of s.incidents) for (const r of inc.atRisk) {
      const later = snaps.filter((x) => x.ts > s.ts && x.ts <= s.ts + horizon * 1000);
      if (s.status[r.id] && s.status[r.id] !== 'healthy') continue;       // already unhealthy: not a prediction
      samples.push({ risk: r.risk, label: later.some((x) => x.status[r.id] && x.status[r.id] !== 'healthy') ? 1 : 0 });
    }
  }
  let calibration: Score['calibration'] = null;
  if (samples.length) {
    const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
    const bins = edges.slice(0, -1).map((lo, i) => { const m = samples.filter((x) => x.risk >= lo && x.risk < edges[i + 1]); return { lo, hi: Math.min(1, edges[i + 1]), n: m.length, meanRisk: mean(m.map((x) => x.risk)), rate: mean(m.map((x) => x.label)) }; });
    const brier = mean(samples.map((x) => (x.risk - x.label) ** 2));
    const ece = bins.reduce((s, b) => s + (b.n ? (b.n / samples.length) * Math.abs(b.meanRisk - b.rate) : 0), 0);
    calibration = { n: samples.length, brier, ece, auc: auc(samples.map((x) => x.risk), samples.map((x) => x.label)), bins };
  }

  // ---- confusion of true root vs predicted top-1 (detected faults)
  const real = results.filter((r) => r.effect !== 'none');
  const truthNames = [...new Set(real.map((r) => r.target))].sort();
  const predNames = [...new Set([...real.map((r) => r.predictedRoot).filter((x): x is string => !!x), ...truthNames])].sort();
  const cols = [...predNames, '(missed)'];
  const counts = truthNames.map((t) => cols.map(() => 0));
  for (const r of real) { const i = truthNames.indexOf(r.target); const j = r.detected && r.predictedRoot ? cols.indexOf(r.predictedRoot) : cols.length - 1; counts[i][j]++; }

  // ---- what kind of fault: injected family vs the family the mapper's evidence points to
  const kRows = FAMILIES, kCols = [...FAMILIES, '(unclear)', '(missed)'];
  const kCounts = kRows.map(() => kCols.map(() => 0));
  for (const r of real) { const i = kRows.indexOf(r.trueFamily); if (i < 0) continue; const j = !r.detected ? kCols.length - 1 : r.inferredFamily ? kCols.indexOf(r.inferredFamily) : kCols.length - 2; kCounts[i][j]++; }
  const withKind = real.filter((r) => r.familyMatch !== null);
  const noEffectList = results.filter((r) => r.effect === 'none');
  const noEffect = { n: noEffectList.length, detected: noEffectList.filter((r) => r.detected).length, items: noEffectList.map((r) => ({ id: r.id, class: r.class, target: r.target, detected: r.detected })) };
  const sq = kRows.map((_, i) => kRows.map((__, j) => kCounts[i][j]));
  const kindConfusion = { truth: kRows, predicted: kCols, counts: kCounts, accuracy: wilson(withKind.filter((r) => r.familyMatch).length, withKind.length), kappa: kappa(sq) };

  // ---- research statistics
  const det = results.filter((r) => r.detected);
  const delays = det.map((r) => r.delaySec!).filter((x) => x !== null);
  const dur = det.filter((r) => r.delaySec !== null).map((r) => (r.b - r.a) / 1000);
  const rho = spearman(dur, delays);
  const t1 = det.map((r) => (r.top1 ? 1 : 0)), chances = det.filter((r) => r.chance !== null).map((r) => r.chance!);
  const meanChance = mean(chances);
  const research = {
    delay: moments(delays),
    delayVsDuration: { rho, p: corrP(rho, delays.length), n: delays.length },
    bootstrap: { detected: bootstrapCI(results.map((r) => (r.detected ? 1 : 0))), top1: bootstrapCI(t1), top3: bootstrapCI(det.map((r) => (r.top3 ? 1 : 0))) },
    crossValidation: { top1: kFold(t1, det.map((r) => r.class)), detected: kFold(results.map((r) => (r.detected ? 1 : 0)), results.map((r) => r.class)) },
    chance: { meanCandidates: chances.length ? 1 / meanChance : NaN, top1Chance: meanChance, top1: det.length ? t1.reduce((a, b) => a + b, 0) / det.length : NaN, pValue: binomUpper(t1.reduce((a, b) => a + b, 0), det.length, meanChance) },
  };

  return { options: { graceSec, atRiskHorizonSec: horizon }, faults: results, excluded, overall, byClass, falseAlarm, calibration, confusion: { truth: truthNames, predicted: cols, counts }, noEffect, kindConfusion, research };
}
