/**
 * Online change-point detection per service and metric, with onset times.
 *
 * Every metric of every service is a stream of numbers, one every 5 s. Positive metrics are put on a log scale
 * (y = ln(x + eps)), so "twice as slow" counts the same for a fast and a slow service. Each stream gets a robust running
 * baseline: the median and the MAD of the last W values that were judged normal. A new value becomes a robust z-score
 *
 *   z_t = clip( (y_t - median) / max(1.4826 MAD, floor), -8, 8 )
 *
 * The baseline is frozen while the stream is in a change of mean |z| >= magMin (weaker drifts keep teaching it), so a long fault does not become the new normal. If a change
 * lasts longer than `maxChange` moments the baseline is rebuilt from the latest values (it was a real level shift).
 *
 * Three detectors read z (pick one with `kind`):
 *
 *   cusum   two-sided CUSUM (Page 1954):  S+_t = max(0, S+_{t-1} + z_t - k),  S-_t = max(0, S-_{t-1} - z_t - k).
 *           A change is on while S+ or S- >= h. Its onset is back-dated to the moment that S last left 0, which is
 *           where the shift really started, not where it became significant. S is capped at cap x h so the alarm
 *           ends soon after the stream returns to normal.
 *   ph      Page-Hinkley: m_t = sum_i (z_i - zbar_i - delta),  M_t = min_{s<=t} m_s,  change while m_t - M_t >= lambda.
 *           zbar is a slow running mean of normal z values. Two-sided (the same on -z). Onset = the argmin of m.
 *   bocpd   Bayesian online change-point detection (Adams and MacKay 2007). Run length r = moments since the last change.
 *           With a constant hazard H and a Normal model with known variance 1 and a Normal prior N(0, s0^2) on the mean:
 *             growth:   P(r_t = r+1, z_1..t) = P(r_{t-1} = r, z_1..t-1) * pi(z_t | r) * (1 - H)
 *             change:   P(r_t = 0,   z_1..t) = sum_r P(r_{t-1} = r, z_1..t-1) * pi(z_t | r) * H
 *           pi(z | r) is the posterior predictive N(mu_r, 1 + s_r^2) of the segment's last r points. The run length
 *           posterior is normalised every step and cut at rMax. A change is on while the most probable run length r*
 *           has a segment mean |mu_r*| >= zMin; its onset is t - r*.
 *
 * Container state is a fact, not a statistic: a service that is not "running" is changed from the first moment it left
 * that state, with a large magnitude.
 *
 * Per service the result is: changed (any metric changed with magnitude >= magMin), onset (the earliest onset among
 * those metrics), magnitude (largest mean |z| since onset) and the metric that gave the onset.
 * Causal: the value at moment i depends only on moments 0..i. PURE apart from a per-trace cache.
 */
import type { Trace } from '../core/trace.ts';

export type DetectorKind = 'cusum' | 'ph' | 'bocpd';

/** Metrics that are tracked, with the log offset eps and the noise floor (in log units) for each. */
export const METRICS: { key: string; eps: number; floor: number }[] = [
  { key: 'cpu', eps: 0.5, floor: 0.3 },
  { key: 'memoryPercent', eps: 1, floor: 0.03 },
  { key: 'networkRxRate', eps: 100, floor: 0.3 },
  { key: 'networkTxRate', eps: 100, floor: 0.3 },
  { key: 'cpuThrottledPct', eps: 1, floor: 0.5 },
  { key: 'requestRate', eps: 0.1, floor: 0.2 },
  { key: 'errorRate', eps: 0.02, floor: 0.5 },
  { key: 'latencyP95', eps: 5, floor: 0.25 },
];

export interface CpParams {
  kind: DetectorKind;
  window: number;      // baseline window W (moments)
  warm: number;        // values needed before the stream can change
  floorScale: number;  // multiplies every metric's noise floor
  maxChange: number;   // a change longer than this rebuilds the baseline
  k: number; h: number; cap: number;           // CUSUM
  delta: number; lambda: number;               // Page-Hinkley
  hazard: number; s0: number; rMax: number; zMin: number;   // BOCPD
  magMin: number;      // a metric counts for the service only if its mean |z| since onset is at least this
}
export const CP_DEFAULTS: CpParams = {
  kind: 'cusum', window: 60, warm: 20, floorScale: 1, maxChange: 120,
  k: 0.5, h: 5, cap: 1.5,
  delta: 0.5, lambda: 5,
  hazard: 1 / 200, s0: 3, rMax: 240, zMin: 2.5,
  magMin: 2,
};

/** Robust running baseline: median and MAD of the last W accepted values. */
export class RobustBaseline {
  private buf: number[] = [];
  private med = 0; private sd = 0; private dirty = true;
  constructor(private W: number, private floor: number) {}
  get size() { return this.buf.length; }
  push(y: number) { this.buf.push(y); if (this.buf.length > this.W) this.buf.shift(); this.dirty = true; }
  reset(ys: number[]) { this.buf = ys.slice(-this.W); this.dirty = true; }
  private refresh() {
    if (!this.dirty) return;
    const s = [...this.buf].sort((a, b) => a - b), n = s.length;
    this.med = n ? (n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
    const d = s.map((v) => Math.abs(v - this.med)).sort((a, b) => a - b);
    const mad = n ? (n % 2 ? d[(n - 1) >> 1] : (d[n / 2 - 1] + d[n / 2]) / 2) : 0;
    this.sd = Math.max(1.4826 * mad, this.floor);
    this.dirty = false;
  }
  z(y: number) { this.refresh(); return Math.max(-8, Math.min(8, (y - this.med) / this.sd)); }
}

/** One detector step: is a change on, since when (index of the onset moment), and how big. */
interface Step { on: boolean; onsetIdx: number }

/** Two-sided CUSUM on z. */
export class Cusum {
  private sp = 0; private sn = 0; private startP = 0; private startN = 0;
  constructor(private k: number, private h: number, private cap: number) {}
  update(z: number, idx: number): Step {
    if (this.sp === 0) this.startP = idx;
    if (this.sn === 0) this.startN = idx;
    this.sp = Math.min(this.cap * this.h, Math.max(0, this.sp + z - this.k));
    this.sn = Math.min(this.cap * this.h, Math.max(0, this.sn - z - this.k));
    if (this.sp >= this.h && (this.sn < this.h || this.startP <= this.startN)) return { on: true, onsetIdx: this.startP };
    if (this.sn >= this.h) return { on: true, onsetIdx: this.startN };
    return { on: false, onsetIdx: -1 };
  }
}

/** Two-sided Page-Hinkley on z, with a slow running mean of normal values. */
export class PageHinkley {
  private mean = 0; private mp = 0; private Mp = 0; private argP = 0; private mn = 0; private Mn = 0; private argN = 0;
  constructor(private delta: number, private lambda: number, private cap = 1.5, private alpha = 0.02) {}
  update(z: number, idx: number): Step {
    const d = z - this.mean;
    this.mp += d - this.delta; this.mn += -d - this.delta;
    if (this.mp <= this.Mp) { this.Mp = this.mp; this.argP = idx + 1; }
    if (this.mn <= this.Mn) { this.Mn = this.mn; this.argN = idx + 1; }
    // cap the statistics so the change ends soon after the stream recovers
    if (this.mp - this.Mp > this.cap * this.lambda) this.Mp = this.mp - this.cap * this.lambda;
    if (this.mn - this.Mn > this.cap * this.lambda) this.Mn = this.mn - this.cap * this.lambda;
    const gp = this.mp - this.Mp, gn = this.mn - this.Mn;
    if (gp < this.lambda && gn < this.lambda) this.mean += this.alpha * (z - this.mean);
    if (gp >= this.lambda && gp >= gn) return { on: true, onsetIdx: Math.min(this.argP, idx) };
    if (gn >= this.lambda) return { on: true, onsetIdx: Math.min(this.argN, idx) };
    return { on: false, onsetIdx: -1 };
  }
}

/** BOCPD with a Normal model (known variance 1, Normal prior on the mean) and a constant hazard. */
export class Bocpd {
  private p: Float64Array; private sum: Float64Array; private len = 1; private t = 0;
  private np: Float64Array; private nsum: Float64Array;
  constructor(private hazard: number, private s0: number, private rMax: number, private zMin: number) {
    this.p = new Float64Array(rMax + 1); this.sum = new Float64Array(rMax + 1);
    this.np = new Float64Array(rMax + 1); this.nsum = new Float64Array(rMax + 1);
    this.p[0] = 1;
  }
  update(z: number, idx: number): Step {
    const H = this.hazard, prec0 = 1 / (this.s0 * this.s0);
    let cp = 0, tot = 0;
    for (let r = 0; r < this.len; r++) {
      // posterior of the segment mean after r points: precision prec0 + r, mean sum / (prec0 + r)
      const prec = prec0 + r, mu = this.sum[r] / prec, v = 1 + 1 / prec;
      const pred = Math.exp(-0.5 * (z - mu) * (z - mu) / v) / Math.sqrt(2 * Math.PI * v);
      const w = this.p[r] * pred;
      cp += w * H;
      // growth; the longest run lengths are merged into rMax (truncation)
      const g = Math.min(r + 1, this.rMax);
      if (g === r + 1) this.nsum[g] = this.sum[r] + z;
      this.np[g] += w * (1 - H);
    }
    this.np[0] = cp; this.nsum[0] = 0;
    const newLen = Math.min(this.len + 1, this.rMax + 1);
    for (let r = 0; r < newLen; r++) tot += this.np[r];
    let best = 0, bestP = -1;
    for (let r = 0; r < newLen; r++) {
      this.p[r] = tot > 0 ? this.np[r] / tot : (r === 0 ? 1 : 0); this.sum[r] = this.nsum[r];
      if (this.p[r] > bestP) { bestP = this.p[r]; best = r; }
      this.np[r] = 0;
    }
    this.len = newLen; this.t++;
    // r* counts points in the current segment including z_t; r* = 0 means "a change right now, segment is empty"
    const rStar = Math.max(1, best);
    const mu = this.sum[best] / (prec0 + best);
    if (best >= 1 && Math.abs(mu) >= this.zMin) return { on: true, onsetIdx: idx - rStar + 1 };
    if (best === 0 && Math.abs(z) >= this.zMin * 2) return { on: true, onsetIdx: idx };
    return { on: false, onsetIdx: -1 };
  }
}

/** One stream: baseline + detector + bookkeeping of the current change. Indices are moment indices. */
export class MetricTracker {
  private base: RobustBaseline;
  private det: { update(z: number, idx: number): Step };
  private recent: number[] = [];
  private onSince = -1;         // first index of the current "on" episode
  private zs: { idx: number; z: number }[] = [];
  constructor(private p: CpParams, floor: number) {
    this.base = new RobustBaseline(p.window, floor * p.floorScale);
    this.det = this.newDet();
  }
  private newDet() {
    const p = this.p;
    return p.kind === 'cusum' ? new Cusum(p.k, p.h, p.cap) : p.kind === 'ph' ? new PageHinkley(p.delta, p.lambda, p.cap) : new Bocpd(p.hazard, p.s0, p.rMax, p.zMin);
  }
  /** Feed the transformed value y (or undefined when missing) at moment idx. */
  update(y: number | undefined, idx: number): { on: boolean; onsetIdx: number; mag: number; z: number } {
    if (y === undefined || !Number.isFinite(y)) return this.onSince >= 0 ? this.last : { on: false, onsetIdx: -1, mag: 0, z: 0 };
    this.recent.push(y); if (this.recent.length > this.p.window) this.recent.shift();
    if (this.base.size < this.p.warm) { this.base.push(y); return (this.last = { on: false, onsetIdx: -1, mag: 0, z: 0 }); }
    const z = this.base.z(y);
    this.zs.push({ idx, z }); if (this.zs.length > this.p.maxChange + 10) this.zs.shift();
    const s = this.det.update(z, idx);
    if (!s.on) {
      this.onSince = -1; this.base.push(y);
      return (this.last = { on: false, onsetIdx: -1, mag: 0, z });
    }
    let sum = 0, n = 0;
    for (const e of this.zs) if (e.idx >= s.onsetIdx) { sum += e.z; n++; }
    const mag = n ? Math.abs(sum / n) : Math.abs(z);
    if (this.onSince < 0) this.onSince = idx;
    if (idx - Math.min(this.onSince, s.onsetIdx) > this.p.maxChange) {
      // a lasting level shift: accept it as the new normal
      this.base.reset(this.recent.slice(-this.p.warm)); this.det = this.newDet(); this.onSince = -1;
      return (this.last = { on: false, onsetIdx: -1, mag: 0, z });
    }
    // a weak drift is not a fault: keep learning the baseline, report it as a small change
    if (mag < this.p.magMin) this.base.push(y);
    return (this.last = { on: true, onsetIdx: s.onsetIdx, mag, z });
  }
  private last = { on: false, onsetIdx: -1, mag: 0, z: 0 };
}

export interface ServiceChange { changed: boolean; onset: number; mag: number; metric: string | null; since: number }
/** Per moment, per service. onset and since are timestamps (ms); since = when the flag went up in this episode. */
export type ChangeTrack = Record<string, ServiceChange>[];

const STATE_MAG = 8;

/** Run the trackers over a whole trace, causally (moment i sees only moments 0..i). */
export function trackTrace(trace: Trace, params: Partial<CpParams> = {}): ChangeTrack {
  const p = { ...CP_DEFAULTS, ...params };
  const trackers = new Map<string, MetricTracker[]>();
  const stateSince = new Map<string, number>();
  const flagSince = new Map<string, number>();
  const out: ChangeTrack = [];
  trace.moments.forEach((m, i) => {
    const row: Record<string, ServiceChange> = {};
    for (const id of m.services) {
      let tr = trackers.get(id);
      if (!tr) { tr = METRICS.map((x) => new MetricTracker(p, x.floor)); trackers.set(id, tr); }
      const x = m.metrics[id] ?? {};
      const running = (x.state ?? 'running') === 'running' && !x.networkDetached;
      let best: ServiceChange = { changed: false, onset: Infinity, mag: 0, metric: null, since: Infinity };
      if (!running) {
        if (!stateSince.has(id)) stateSince.set(id, m.ts);
        best = { changed: true, onset: stateSince.get(id)!, mag: STATE_MAG, metric: 'state', since: m.ts };
      } else stateSince.delete(id);
      if (Number(x.restartDelta) > 0 && !best.changed) best = { changed: true, onset: m.ts, mag: STATE_MAG, metric: 'restart', since: m.ts };
      METRICS.forEach((def, k) => {
        const v = x[def.key];
        const y = running && typeof v === 'number' ? Math.log(Math.max(0, v) + def.eps) : undefined;
        const r = tr![k].update(y, i);
        if (!r.on || r.mag < p.magMin) return;
        const onset = trace.moments[r.onsetIdx]?.ts ?? m.ts;
        if (!best.changed || (best.metric !== 'state' && best.metric !== 'restart' && onset < best.onset)) best = { changed: true, onset, mag: Math.max(best.mag, r.mag), metric: def.key, since: m.ts };
        else best.mag = Math.max(best.mag, r.mag);
      });
      if (best.changed) { if (!flagSince.has(id)) flagSince.set(id, m.ts); best.since = flagSince.get(id)!; }
      else flagSince.delete(id);
      row[id] = best;
    }
    out.push(row);
  });
  return out;
}

const cache = new WeakMap<Trace, Map<string, ChangeTrack>>();
/** trackTrace with a cache per trace and parameter set. */
export function track(trace: Trace, params: Partial<CpParams> = {}): ChangeTrack {
  let m = cache.get(trace); if (!m) { m = new Map(); cache.set(trace, m); }
  const key = JSON.stringify({ ...CP_DEFAULTS, ...params });
  let r = m.get(key); if (!r) { r = trackTrace(trace, params); m.set(key, r); }
  return r;
}
