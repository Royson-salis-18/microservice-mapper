/**
 * v2 diagnose: turn an incident into a feature vector, so a classifier can say WHAT KIND of fault it is.
 *
 * Pipeline per fault:
 *   1. alarm    the first moment the v1 hybrid engine alarms during the fault: two moments in a row with max >= 1,
 *               both inside [a, b + 60 s]. The alarm moment is the second of the two (that is when it would page).
 *   2. suspect  the hybrid's top ranked service at the alarm moment (or, in oracle mode, the true target).
 *   3. window   only readings up to alarm + N moments are read (N = 0, 6, 12 means 0, 30 s, 60 s after the alarm).
 *               Nothing about the fault's real start, end or label is used.
 *
 * Windows, all relative to the alarm moment (moments are 5 s apart):
 *   baseline   [alarm - 300 s, alarm - 120 s]       robust "normal": medians of the suspect's metrics
 *   recent     [alarm - 120 s, alarm + N]           state history, counts, slopes, maxima
 *   tail       the last 4 readings of the recent window   "what it looks like now"
 *
 * Ratios are logs against the baseline median, with a small floor so zeros do not explode:
 *   ratio(x) = ln( (tail median + eps) / (baseline median + eps) )
 *
 * Every feature is a finite number (missing readings fall back to neutral values), so any model can read the vector.
 * PURE: traces in, numbers out.
 */
import type { Trace, TraceFault, TraceMoment } from '../core/trace.ts';
import { V1, type Engine } from '../core/score.ts';

export const STEP_MS = 5000;
export const WINDOWS = { baselineFrom: 300_000, baselineTo: 120_000, recent: 120_000, tail: 4, afterEnd: 60_000 };

/** Names in the order extractFeatures returns them. */
export const FEATURE_NAMES = [
  'st_exited', 'st_paused', 'st_restarting', 'st_down_now', 'st_outages', 'st_longest_down',
  'exit_nonzero', 'exit_zero', 'restart_events', 'restart_max',
  'mem_ratio', 'mem_slope', 'mem_max', 'mem_jump',
  'cpu_ratio', 'thr_delta', 'thr_max',
  'lat_ratio', 'err_delta',
  'net_ratio', 'net_zero', 'detached',
  'req_ratio',
  'callers_n', 'callers_anom', 'callers_lat_ratio', 'callers_err_delta',
  'anom_share',
  'ml_level', 'ml_own', 'ml_symptom', 'ml_hard', 'ml_anomaly', 'ml_walk', 'rules',
] as const;
export type FeatureName = typeof FEATURE_NAMES[number];

export interface Alarm { idx: number; suspect: string }

/** First v1 alarm inside [a, b + 60 s] (two consecutive max >= 1), and the top suspect at that moment. */
export function findAlarm(t: Trace, f: TraceFault, engine: Engine = V1.hybrid): Alarm | null {
  let prev = false;
  for (let i = 0; i < t.moments.length; i++) {
    const ts = t.moments[i].ts;
    if (ts < f.a) continue;
    if (ts > f.b + WINDOWS.afterEnd) break;
    const e = engine(t, i);
    const on = e.max >= 1;
    if (on && prev) return { idx: i, suspect: e.ranked[0] };
    prev = on;
  }
  return null;
}

// ---------- small helpers ----------
const num = (m: TraceMoment, id: string, k: string): number | undefined => {
  const v = m.metrics[id]?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const state = (m: TraceMoment, id: string): string => String(m.metrics[id]?.state ?? 'running');
const isDown = (s: string) => s !== 'running';
export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((p, q) => p - q);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const values = (ms: TraceMoment[], id: string, k: string, onlyRunning = true) =>
  ms.filter((m) => !onlyRunning || !isDown(state(m, id))).map((m) => num(m, id, k)).filter((v): v is number => v !== undefined);
/** ln((tail + eps) / (base + eps)); 0 when either side is unknown. */
function logRatio(tail: number | undefined, base: number | undefined, eps: number): number {
  if (tail === undefined || base === undefined) return 0;
  return Math.log((Math.max(0, tail) + eps) / (Math.max(0, base) + eps));
}
/** Least squares slope of y against x (x in minutes). 0 with fewer than 3 points. */
function slope(xs: number[], ys: number[]): number {
  if (xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : 0;
}
const netOf = (m: TraceMoment, id: string) => {
  const rx = num(m, id, 'networkRxRate'), tx = num(m, id, 'networkTxRate');
  return rx === undefined && tx === undefined ? undefined : (rx ?? 0) + (tx ?? 0);
};

/**
 * The feature vector for one suspect at one alarm moment, reading moments up to alarmIdx + n only.
 */
export function extractFeatures(t: Trace, alarmIdx: number, suspect: string, n: number): number[] {
  const end = Math.min(t.moments.length - 1, alarmIdx + n);
  const tAlarm = t.moments[alarmIdx].ts;
  const all = t.moments.slice(0, end + 1);
  const base = all.filter((m) => m.ts >= tAlarm - WINDOWS.baselineFrom && m.ts <= tAlarm - WINDOWS.baselineTo);
  const recent = all.filter((m) => m.ts > tAlarm - WINDOWS.recent);
  const tail = recent.slice(-WINDOWS.tail);
  const s = suspect;

  // container state history
  const states = recent.map((m) => state(m, s));
  const frac = (want: string) => states.filter((x) => x === want).length / Math.max(1, states.length);
  let outages = 0, longest = 0, run = 0;
  for (let i = 0; i < states.length; i++) {
    if (isDown(states[i])) { run++; if (i === 0 || !isDown(states[i - 1])) outages++; longest = Math.max(longest, run); } else run = 0;
  }
  const downMoments = recent.filter((m) => isDown(state(m, s)));
  const codes = downMoments.map((m) => num(m, s, 'exitCode')).filter((v): v is number => v !== undefined);
  const exitNonzero = downMoments.length ? codes.filter((c) => c !== 0).length / downMoments.length : 0;
  const exitZero = downMoments.length ? codes.filter((c) => c === 0).length / downMoments.length : 0;
  const restarts = recent.map((m) => num(m, s, 'restartDelta') ?? 0);
  const restartEvents = restarts.filter((r) => r > 0).length;
  // a restart seen while the container already reads "running" is an outage too short to catch in state
  for (let i = 0; i < recent.length; i++) if (restarts[i] > 0 && !isDown(states[i]) && (i === 0 || restarts[i - 1] === 0) && (i === 0 || !isDown(states[i - 1]))) outages++;

  // memory
  const memBase = median(values(base, s, 'memoryPercent'));
  const memTail = median(values(tail, s, 'memoryPercent'));
  const memPts = recent.filter((m) => !isDown(state(m, s)) && num(m, s, 'memoryPercent') !== undefined);
  const memSlope = slope(memPts.map((m) => (m.ts - tAlarm) / 60_000), memPts.map((m) => num(m, s, 'memoryPercent')!));
  const memRecent = values(recent, s, 'memoryPercent');
  const memMax = memRecent.length ? Math.max(...memRecent) : memTail ?? 0;

  // cpu and throttling
  const cpuRatio = logRatio(median(values(tail, s, 'cpu')), median(values(base, s, 'cpu')), 0.2);
  const thrBase = mean(values(base, s, 'cpuThrottledPct'));
  const thrTail = values(tail, s, 'cpuThrottledPct');
  const thrRecent = values(recent, s, 'cpuThrottledPct');

  // latency, errors, requests, network of the suspect itself
  const latRatio = logRatio(median(values(tail, s, 'latencyP95')), median(values(base, s, 'latencyP95')), 5);
  const errDelta = mean(values(tail, s, 'errorRate')) - mean(values(base, s, 'errorRate'));
  const reqRatio = logRatio(median(values(tail, s, 'requestRate', false)), median(values(base, s, 'requestRate', false)), 0.1);
  const netBase = median(base.map((m) => netOf(m, s)).filter((v): v is number => v !== undefined));
  const netTail = median(tail.filter((m) => !isDown(state(m, s))).map((m) => netOf(m, s)).filter((v): v is number => v !== undefined));
  const runningRecent = recent.filter((m) => !isDown(state(m, s)));
  const netZero = runningRecent.length ? runningRecent.filter((m) => netOf(m, s) === 0).length / runningRecent.length : 0;
  const detached = recent.filter((m) => m.metrics[s]?.networkDetached === true).length / Math.max(1, recent.length);

  // neighbours: who calls the suspect (edges seen in the recent window), and how they look
  const callers = new Set<string>();
  for (const m of recent) for (const [from, to] of m.edges) if (to === s && from !== s) callers.add(from);
  const levelMax = (id: string) => Math.max(0, ...tail.map((m) => m.ml[id]?.[0] ?? 0));
  const callerList = [...callers];
  const callersAnom = callerList.length ? callerList.filter((c) => levelMax(c) >= 1).length / callerList.length : 0;
  const callersLat = callerList.length ? Math.max(...callerList.map((c) => logRatio(median(values(tail, c, 'latencyP95')), median(values(base, c, 'latencyP95')), 5))) : 0;
  const callersErr = callerList.length ? Math.max(...callerList.map((c) => mean(values(tail, c, 'errorRate')) - mean(values(base, c, 'errorRate')))) : 0;
  const last = t.moments[end];
  const anomShare = last.services.filter((id) => levelMax(id) >= 1).length / Math.max(1, last.services.length);

  // the v1 ML engine's own view of the suspect (max over the tail)
  const mlMax = (k: number) => Math.max(0, ...tail.map((m) => m.ml[s]?.[k] ?? 0));
  const rules = Math.max(0, ...tail.map((m) => m.rules[s] ?? 0));

  const v = [
    frac('exited'), frac('paused'), frac('restarting'), isDown(state(last, s)) ? 1 : 0, outages, Math.log1p(longest),
    exitNonzero, exitZero, Math.log1p(restartEvents), Math.min(5, Math.max(0, ...restarts)),
    logRatio(memTail, memBase, 1), Math.max(-50, Math.min(50, memSlope)), memMax / 100, ((memMax) - (memBase ?? memMax)) / 100,
    cpuRatio, (thrTail.length ? mean(thrTail) : thrBase) - thrBase, thrRecent.length ? Math.max(...thrRecent) : 0,
    latRatio, errDelta,
    logRatio(netTail, netBase, 10), netZero, detached,
    reqRatio,
    Math.log1p(callerList.length), callersAnom, callersLat, callersErr,
    anomShare,
    Math.min(5, mlMax(0)), Math.min(5, mlMax(1)), Math.min(5, mlMax(2)), mlMax(4), mlMax(3), mlMax(5), Math.min(5, rules),
  ];
  return v.map((x) => (Number.isFinite(x) ? x : 0));
}

export type SuspectMode = 'pipeline' | 'oracle';
export interface Row {
  x: number[];
  y: string;            // the true fault class
  group: string;        // campaign (trace name), for leave-one-group-out
  trace: string;
  fault: string;
  target: string;
  suspect: string;
  suspectOk: boolean;
}
export interface Dataset { rows: Row[]; undetected: { trace: string; fault: string; y: string }[] }

/**
 * One row per DETECTED fault. pipeline: the hybrid's suspect; oracle: the true target, at the same alarm moment.
 * Undetected faults are listed separately (no alarm, so nothing to diagnose).
 */
export function buildDataset(traces: Trace[], n: number, mode: SuspectMode, engine: Engine = V1.hybrid): Dataset {
  const rows: Row[] = [];
  const undetected: Dataset['undetected'] = [];
  for (const t of traces) for (const f of t.faults) {
    const al = findAlarm(t, f, engine);
    if (!al) { undetected.push({ trace: t.name, fault: f.id, y: f.class }); continue; }
    const suspect = mode === 'oracle' ? f.target : al.suspect;
    rows.push({ x: extractFeatures(t, al.idx, suspect, n), y: f.class, group: t.name, trace: t.name, fault: f.id, target: f.target, suspect, suspectOk: al.suspect === f.target });
  }
  return { rows, undetected };
}
