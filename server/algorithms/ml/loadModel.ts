/**
 * A load-aware baseline: the part of "unusual" that is only "busier" or "quieter" is explained away, and what is left is judged.
 *
 * The problem it fixes. A service's CPU and network follow the work it is given. A per-service model of "normal readings"
 * (a forest, a histogram, a covariance) treats a drop of traffic as a fault: stop the traffic and every service reads as
 * anomalous at once, for as long as it takes the window to refill. A fault is different: it changes ONE service (and the
 * ones that depend on it), not all of them by the same amount.
 *
 *   1. Load factor L(t). Each traffic-driven signal of each service (network in and out, request rate, CPU) is compared
 *      with that service's own slow reference (the median of its last half hour). L is the MEDIAN of those shifts over all
 *      services: what the whole project moved by. A fault in one or a few services cannot move a median.
 *   2. Response. Each signal follows L with a slope b_f shared by the project: a service that does twice the work moves its
 *      network twice as much. The slope starts from a prior (1 for network and requests: proportional) and is re-estimated
 *      from the readings, pulled back to the prior while the load has barely varied (ridge).
 *   3. Residual. rho = x - b_f * L(t). A service's baseline is the median and robust spread (MAD) of its own recent residuals.
 *      z = (rho - median) / spread: how many spreads this service is from what the current load predicts for it.
 *   4. Level = z / line (line 1: z = zLine). Only increases of CPU, memory, errors, latency and throttling count as trouble.
 *   5. Gate. Only readings under the line join the window, so a fault never becomes normal. A change that is accepted
 *      (workload explained or slow drift) simply keeps flowing in.
 *
 * Every number can be checked by hand: the verdict of a service is "this metric is z spreads above what the current load
 * predicts". No labels, nothing installed on the target, one pass over the readings the mapper already collects.
 * PURE: readings in, levels out.
 */
import { median as med } from './stats.js';
import type { MetricSnapshot } from '../../models/MetricSnapshot.js';

/** Order of the features in a reading vector (same as readingVector in serviceBaseline.ts). */
export const F = { cpu: 0, memory: 1, netIn: 2, netOut: 3, requests: 4, errors: 5, latency: 6, throttle: 7 } as const;
const NAMES = ['cpu', 'memory', 'network in', 'network out', 'requests', 'errors', 'latency', 'throttling'];

export type LoadMode =
  | 'control'   // no load factor: each service against its own recent residual only (what a plain control chart does)
  | 'prior'     // load factor with the slopes fixed at their priors
  | 'pooled';   // load factor, slopes learned from the readings (ridge towards the prior)

export interface LoadParams {
  mode: LoadMode;
  window: number;          // accepted readings kept per service
  slow: number;            // readings in the slow reference (about half an hour at 5 s)
  minTrain: number;        // readings needed before a service is judged
  zLine: number;           // robust z that counts as level 1
  floors: number[];        // smallest spread worth noticing per feature
  prior: number[];         // slope of each feature on the load factor
  ridge: number;           // weight of the prior against the data, in units of squared load times samples
  loadFeatures: number[];  // the signals the load factor is read from
  minServices: number;     // services needed to read a load factor at all
  idle: number[];          // per feature: the logged value of an idle signal (a signal this far above it is carrying traffic)
  active: number;          // a signal counts for the load factor when its reference is this far above idle (log units)
  oneSided: boolean;
  mildLevel: number; mildDriftAfter: number; driftAfter: number;
  forecastWindow: number; forecastHorizon: number; forecastR2: number;
  minRequests: number;
  refresh: number;         // readings between recomputations of a signal's baseline
  /** Range guard: a value this many floors beyond everything in the window counts as level 1 (0: off). The spread-based z alone under-scores a huge jump on a noisy signal. */
  rangeK: number;
  /** Unit of each feature before the log: log(x + unit). Below about one unit a change is noise (a 1% CPU blip on an idle service). */
  units: number[];
  /** 'mad': spread from the median absolute deviation. 'tail': at least the distance to the 90th percentile in the direction that matters, so bursty signals are not scored as if they were Gaussian. */
  scale: 'mad' | 'tail';
}

export const LOAD_DEFAULTS: LoadParams = {
  mode: 'pooled', window: 120, slow: 360, minTrain: 30, zLine: 4,
  floors: [0.2, 0.05, 0.3, 0.3, 0.3, 0.02, 0.2, 3],
  units: [5, 1, 2000, 2000, 0.1, 0, 1, 0],
  prior: [0.4, 0, 1, 1, 1, 0, 0, 0],
  ridge: 60, loadFeatures: [F.netIn, F.netOut, F.requests, F.cpu], minServices: 2, oneSided: true,
  idle: [Math.log(5), 0, Math.log(2000), Math.log(2000), Math.log(0.1), 0, 0, 0], active: 0.4,
  mildLevel: 3, mildDriftAfter: 24, driftAfter: 360, forecastWindow: 24, forecastHorizon: 24, forecastR2: 0.6, minRequests: 5, refresh: 4, rangeK: 0, scale: 'tail',
};

const UPPER_ONLY = new Set<number>([F.cpu, F.memory, F.errors, F.latency, F.throttle]);
const OWN: number[] = [F.cpu, F.memory, F.throttle];

export interface Forecast { level: number; feature: string | null; inSteps: number | null }
export interface Level {
  ready: boolean; level: number; own: number; symptom: number; score: number; accepted: boolean; forecast: Forecast;
  /** The strongest feature and its z, for the evidence line ("cpu 5.1 spreads above what the load predicts"). */
  top: { feature: string; z: number } | null;
}
export interface RoundInfo { load: number; loadServices: number; shifted: boolean; slopes: number[] }
const NO_FORECAST: Forecast = { level: 0, feature: null, inSteps: null };

interface Entry { x: (number | null)[]; load: number }
interface Svc {
  win: Entry[];
  slow: (number | null)[][];
  rejectedRun: number;
  mildRun: number;
  recent: number[][];       // residual z per feature, for the trend
  cache: Map<string, { base: number; spread: number; hi: number; lo: number; at: number; n: number }>;   // baseline per signal and hypothesis, refreshed every few readings
}

/** One reading as the model sees it: positive quantities on a log scale (ratios matter, not differences), a missing signal as null. */
export function vectorize(h: MetricSnapshot, p: Pick<LoadParams, 'units' | 'minRequests'>): (number | null)[] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const lg = (v: number | null, unit: number) => (v === null ? null : Math.log(Math.max(0, v) + unit));
  const enough = !(typeof h.requestCount === 'number' && h.requestCount < p.minRequests);
  return [
    lg(num(h.cpu), p.units[0]), lg(num(h.memoryPercent), p.units[1]), lg(num(h.networkRxRate), p.units[2]), lg(num(h.networkTxRate), p.units[3]),
    lg(num(h.requestRate), p.units[4]), enough ? num(h.errorRate) : null, enough ? lg(num(h.p95Latency ?? h.latency), p.units[6]) : null, num(h.cpuThrottledPct),
  ];
}

const mad = (xs: number[], m: number) => 1.4826 * med(xs.map((x) => Math.abs(x - m)));

export class LoadModel {
  private svc = new Map<string, Svc>();
  private tick = 0;
  info: RoundInfo = { load: 0, loadServices: 0, shifted: false, slopes: [] };
  constructor(private readonly p: LoadParams = LOAD_DEFAULTS) {}

  private state(id: string): Svc {
    let s = this.svc.get(id);
    if (!s) { s = { win: [], slow: [], rejectedRun: 0, mildRun: 0, recent: [], cache: new Map() }; this.svc.set(id, s); }
    return s;
  }

  /** The slow reference of each feature: the median of the service's last `slow` readings, or null while there are too few. */
  private reference(s: Svc): (number | null)[] | null {
    if (s.slow.length < this.p.minTrain) return null;
    return NAMES.map((_, f) => { const v = s.slow.map((x) => x[f]).filter((x): x is number => x !== null); return v.length >= s.slow.length * 0.5 ? med(v) : null; });
  }

  /** One synchronous step: every service's newest reading, in one map. Returns each judged service's level. */
  round(readings: Map<string, (number | null)[]>): Map<string, Level> {
    const p = this.p;
    this.tick++;
    const refs = new Map<string, (number | null)[]>();
    for (const id of readings.keys()) { const r = this.reference(this.state(id)); if (r) refs.set(id, r); }

    // 1. load factor: the median shift, over services and load signals
    const shifts: number[] = [];
    let contributing = 0;
    if (p.mode !== 'control') {
      for (const [id, x] of readings) {
        const r = refs.get(id); if (!r) continue;
        let used = false;
        // only a signal that carries traffic says anything about load: an idle database reads the same zeros either way
        for (const f of p.loadFeatures) if (x[f] !== null && r[f] !== null && (r[f] as number) - p.idle[f] >= p.active) { shifts.push((x[f] as number) - (r[f] as number)); used = true; }
        if (used) contributing++;
      }
    }
    const load = contributing >= p.minServices ? med(shifts) : 0;

    // 2. slopes: pooled over services and over the window (their stored loads against their shifts from the reference)
    const slopes = p.prior.slice();
    if (p.mode === 'pooled' && contributing >= p.minServices) {
      for (let f = 0; f < slopes.length; f++) {
        if (!p.loadFeatures.includes(f) && p.prior[f] === 0) continue;
        let sxy = 0, sxx = 0;
        for (const [id, s] of this.svc) {
          const r = refs.get(id); if (!r || r[f] === null || (r[f] as number) - p.idle[f] < p.active) continue;
          for (const e of s.win) if (e.x[f] !== null) { const d = (e.x[f] as number) - (r[f] as number); sxy += d * e.load; sxx += e.load * e.load; }
        }
        slopes[f] = (sxy + p.ridge * p.prior[f]) / (sxx + p.ridge);
      }
    }
    const usedSlopes = p.mode === 'control' ? p.prior.map(() => 0) : slopes;
    const shifted = Math.abs(load) >= 1;
    this.info = { load, loadServices: contributing, shifted, slopes: usedSlopes };

    // 3. each service against what the load predicts for it
    const out = new Map<string, Level>();
    for (const [id, x] of readings) {
      const s = this.state(id);
      const ready = s.win.length >= p.minTrain && refs.has(id);
      let level = 0, own = 0, symptom = 0, score = 0;
      let top: Level['top'] = null;
      const zs = new Array<number>(NAMES.length).fill(0);
      if (ready) {
        for (let f = 0; f < NAMES.length; f++) {
          const xf = x[f];
          if (xf === null) continue;
          // The signal is judged under each hypothesis about how it follows the load: not at all (b = 0), or by the slope the
          // project shows (b = slope). It counts as unusual only if NEITHER explains it: a service that ignores the load
          // (a message bus idling at the same rate) and one that follows it (a gateway) are both handled before either has
          // been seen to move. With the load unchanged, both hypotheses agree.
          const betas = usedSlopes[f] === 0 || p.mode === 'control' ? [0] : [0, usedSlopes[f]];
          let zBest = Infinity;
          for (const b of betas) {
            const ck = `${f}|${b.toFixed(2)}`;
            let c = s.cache.get(ck);
            if (!c || this.tick - c.at >= p.refresh || Math.abs(c.n - s.win.length) > 20) {
              const rho = s.win.map((e) => (e.x[f] === null ? null : (e.x[f] as number) - b * e.load)).filter((v): v is number => v !== null);
              if (rho.length < p.minTrain * 0.6) continue;
              const base0 = med(rho);
              let spread0 = mad(rho, base0);
              if (p.scale === 'tail') {
                const sorted = [...rho].sort((a, c2) => a - c2), q = (u: number) => sorted[Math.min(sorted.length - 1, Math.floor(u * (sorted.length - 1)))];
                const up = (q(0.9) - base0) / 1.2816, down = (base0 - q(0.1)) / 1.2816;
                spread0 = Math.max(spread0, p.oneSided && UPPER_ONLY.has(f) ? up : Math.max(up, down));
              }
              c = { base: base0, spread: Math.max(spread0, p.floors[f]), hi: Math.max(...rho), lo: Math.min(...rho), at: this.tick, n: s.win.length };
              s.cache.set(ck, c);
            }
            const base = c.base, spread = c.spread;
            const adj = xf - b * load;
            let zb = (adj - base) / spread;
            if (p.oneSided && UPPER_ONLY.has(f)) zb = Math.max(0, zb);
            let zAbs = Math.abs(zb);
            if (p.rangeK > 0) {
              const excess = p.oneSided && UPPER_ONLY.has(f) ? Math.max(0, adj - c.hi) : Math.max(0, adj - c.hi, c.lo - adj);
              zAbs = Math.max(zAbs, (excess / (p.floors[f] * p.rangeK)) * p.zLine);
            }
            zBest = Math.min(zBest, zAbs);
          }
          if (!Number.isFinite(zBest)) continue;
          let z = zBest;
          zs[f] = z;
          const lv = z / p.zLine;
          if (lv > level) { level = lv; score = z; top = { feature: NAMES[f], z }; }
          if (OWN.includes(f)) own = Math.max(own, lv); else symptom = Math.max(symptom, lv);
        }
      }
      // trend: residual z of rising-only features over the recent readings, projected ahead
      s.recent.push(zs); if (s.recent.length > p.forecastWindow) s.recent.shift();
      const forecast = ready ? this.forecast(s) : NO_FORECAST;

      const normal = !ready || level < 1;
      s.rejectedRun = normal ? 0 : s.rejectedRun + 1;
      s.mildRun = !normal && level < p.mildLevel ? s.mildRun + 1 : 0;
      const accepted = normal || s.rejectedRun >= p.driftAfter || (p.mildDriftAfter > 0 && s.mildRun >= p.mildDriftAfter);
      s.slow.push(x); if (s.slow.length > p.slow) s.slow.shift();
      if (accepted) { s.win.push({ x, load }); if (s.win.length > p.window) s.win.shift(); }
      out.set(id, { ready, level, own, symptom, score, accepted, forecast, top });
    }
    return out;
  }

  /** A straight line through the recent z of each rising-only feature, projected forecastHorizon readings ahead. */
  private forecast(s: Svc): Forecast {
    const p = this.p;
    let best: Forecast = NO_FORECAST;
    for (const f of UPPER_ONLY) {
      const pts = s.recent.map((z, i) => [i, z[f]] as const);
      if (pts.length < Math.max(8, p.forecastWindow / 2)) continue;
      const n = pts.length, mx = pts.reduce((a, q) => a + q[0], 0) / n, my = pts.reduce((a, q) => a + q[1], 0) / n;
      const sxx = pts.reduce((a, q) => a + (q[0] - mx) ** 2, 0), sxy = pts.reduce((a, q) => a + (q[0] - mx) * (q[1] - my), 0), syy = pts.reduce((a, q) => a + (q[1] - my) ** 2, 0);
      if (sxx <= 0 || syy <= 0) continue;
      const b = sxy / sxx, r2 = (sxy * sxy) / (sxx * syy);
      if (b <= 0 || r2 < p.forecastR2) continue;
      const last = n - 1, level = (my + b * (last + p.forecastHorizon - mx)) / p.zLine;
      const crossAt = (p.zLine - my) / b + mx;
      if (level > best.level) best = { level, feature: NAMES[f], inSteps: Math.max(0, Math.round(crossAt - last)) };
    }
    return best;
  }

  forget() { this.svc.clear(); }
}
