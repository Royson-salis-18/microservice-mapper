/**
 * One service's learned baseline: an Isolation Forest trained on a sliding window of that service's own NORMAL readings.
 *
 *   1. A new reading arrives. It is scored by the model trained on the PREVIOUS window (it never judges itself).
 *   2. Its score is compared with the service's own alarm line: the score that only the top few percent of its training
 *      readings reach. level = (score - typical) / (line - typical): 0 = typical, 1 = on the line, 2 = twice as far out.
 *   3. Gate: only a reading under the line joins the training window. A fault therefore never becomes "normal".
 *      (If a service stays above the line for a very long time with nothing broken, the change is accepted as the new
 *      normal: a deploy or a new traffic level, not a fault. That escape is `driftAfter` readings.)
 *   4. Every `retrainEvery` accepted readings the forest is rebuilt on the newest `window` accepted readings.
 *
 * PURE: readings in, scores out.
 */
import { rng } from './isolationForest.js';
import { fitDetector, DETECTORS, type Detector, type DetectorKind } from './detectors.js';
import type { MetricSnapshot } from '../../models/MetricSnapshot.js';

export interface BaselineParams {
  window: number;          // accepted readings kept for training (the sliding window)
  minTrain: number;        // readings needed before the first model
  retrainEvery: number;    // accepted readings between rebuilds
  quantile: number;        // where the alarm line sits among the training scores
  driftAfter: number;      // consecutive above-line readings after which the change is accepted as the new normal
  mildLevel: number;       // a deviation under this level (but over the line) is mild ...
  mildDriftAfter: number;  // ... and is accepted as the new normal after this many readings in a row (0: off)
  trees: number;
  sampleSize: number;
  minRequests: number;     // error share and latency mean nothing below this many requests
  jitter: number;          // training noise, in units of each feature's floor
  seed: number;            // added to every forest's random seed (repeat experiments with different seeds)
  lineK: number;           // alarm line = typical + lineK robust spreads of the training scores (0: use the quantile)
  rangeK: number;          // range guard: this many floors beyond the training range counts as level 1 (0: off)
  floors: number[];        // smallest meaningful change per feature (see FEATURE_FLOOR)
  detector: DetectorKind | 'ensemble';   // which unsupervised model learns normal (see detectors.ts)
  oneSided: boolean;       // UPPER_ONLY features cannot be anomalous by being low
  forecastWindow: number;  // recent readings the trend is fitted on
  forecastHorizon: number; // readings ahead the trend is projected (24 x 5 s = 2 minutes)
  forecastR2: number;      // how straight the recent readings must be before a trend is believed
  ensemble: DetectorKind[];               // the members when detector is 'ensemble' (their levels are averaged)
}
/** Smallest gap between typical and the alarm line, per detector (their scores are on different scales). */
const MIN_MARGIN: Record<DetectorKind, number> = { iforest: 0.02, knn: 0.3, mahalanobis: 0.5, hbos: 1 };
/** The numbers the forest sees for one reading. Positive quantities on a log scale (ratios matter, not differences). */
export const ML_FEATURES = ['cpu', 'memory', 'netIn', 'netOut', 'requests', 'errors', 'latency', 'throttle'] as const;
/** Smallest spread worth noticing for each feature (log units, except error share and throttling %). A feature that never
 *  moved in the window would otherwise give the trees nothing to cut on, and a later jump in it would go unseen. */
export const FEATURE_FLOOR = [0.15, 0.05, 0.15, 0.15, 0.15, 0.02, 0.15, 3];
/** Two forests per service: its OWN signals (resources: a dependency cannot cause these) and its SYMPTOMS (traffic,
 *  errors, latency, network: these can be inherited from a broken dependency). Indices into ML_FEATURES. */
export const BASELINE_DEFAULTS: BaselineParams = {
  window: 120, minTrain: 30, retrainEvery: 10, quantile: 0.97, driftAfter: 360, mildLevel: 3, mildDriftAfter: 24, trees: 100, sampleSize: 64, minRequests: 5, jitter: 0.5, seed: 0, lineK: 3, rangeK: 5, floors: FEATURE_FLOOR, detector: 'iforest', ensemble: DETECTORS, oneSided: true, forecastWindow: 24, forecastHorizon: 24, forecastR2: 0.6,
};

export const GROUPS = { own: [0, 1, 7], symptom: [2, 3, 4, 5, 6] } as const;
/** Features where only an increase is trouble: less CPU, memory, throttling, errors or latency than usual is never a fault
 *  of the service itself (it happens after every restart). Traffic and network count both ways: a drop matters. */
export const UPPER_ONLY = new Set([0, 1, 5, 6, 7]);

export function readingVector(h: MetricSnapshot, minRequests = BASELINE_DEFAULTS.minRequests): (number | null)[] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const lg = (v: number | null, unit: number) => (v === null ? null : Math.log(Math.max(0, v) + unit));
  const enough = !(typeof h.requestCount === 'number' && h.requestCount < minRequests);
  return [
    lg(num(h.cpu), 0.5),
    lg(num(h.memoryPercent), 1),
    lg(num(h.networkRxRate), 2000),
    lg(num(h.networkTxRate), 2000),
    lg(num(h.requestRate), 0.1),
    enough ? num(h.errorRate) : null,
    enough ? lg(num(h.p95Latency ?? h.latency), 1) : null,
    num(h.cpuThrottledPct),
  ];
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

export interface Verdict {
  ready: boolean;          // a model exists for this service
  score: number;           // raw Isolation Forest score of the stronger group
  level: number;           // max of the groups: 0 typical, 1 on the alarm line, >1 beyond it
  own: number;             // level of the own-signal forest
  symptom: number;         // level of the symptom forest
  accepted: boolean;       // the reading joined the training window
  forecast: Forecast;      // where the recent trend leads (early warning)
}
/** A straight-line trend on the recent readings of a feature that only hurts when it rises (memory, CPU, throttling,
 *  errors, latency), projected forecastHorizon readings ahead and judged with the range guard. */
export interface Forecast { level: number; feature: string | null; inSteps: number | null }
const NO_FORECAST: Forecast = { level: 0, feature: null, inSteps: null };

/** One detector (or several, for the ensemble) over a subset of the features, each with its own alarm line. */
class GroupModel {
  models: { det: Detector; typical: number; line: number }[] = [];
  cols: number[] = [];
  fill: number[] = [];
  lo: number[] = [];
  hi: number[] = [];
  constructor(private readonly features: readonly number[], private readonly seed: number, private readonly p: BaselineParams) {}

  get fitted() { return this.models.length > 0; }
  project(v: (number | null)[]): number[] { return this.cols.map((c, k) => v[c] ?? this.fill[k]); }

  fit(window: (number | null)[][], fits: number) {
    // a feature is used only if most readings in the window have it
    this.cols = this.features.filter((c) => window.filter((v) => v[c] !== null).length >= 0.5 * window.length);
    if (!this.cols.length) { this.models = []; return; }
    this.fill = this.cols.map((c) => median(window.map((v) => v[c]).filter((x): x is number => x !== null)));
    // training copy with a little noise at each feature's floor, so constant features still define a range
    const noise = rng(this.seed * 31 + fits);
    const gauss = () => { const u = Math.max(1e-9, noise()), w = noise(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
    const raw = window.map((v) => this.project(v));
    this.lo = this.cols.map((_, k) => Math.min(...raw.map((x) => x[k])));
    this.hi = this.cols.map((_, k) => Math.max(...raw.map((x) => x[k])));
    const floors = this.cols.map((c) => this.p.floors[c]);
    const X = raw.map((x) => x.map((v, k) => v + gauss() * floors[k] * this.p.jitter));
    const kinds: DetectorKind[] = this.p.detector === 'ensemble' ? this.p.ensemble : [this.p.detector];
    this.models = kinds.map((kind) => {
      const det = fitDetector(kind, X, floors, { trees: this.p.trees, sampleSize: this.p.sampleSize, seed: this.seed + fits });
      const s = X.map((x) => det.score(x));
      const typical = median(s);
      // the line is never closer to typical than a small margin: a perfectly flat series would otherwise alarm on noise
      const spread = 1.4826 * median(s.map((x) => Math.abs(x - typical)));
      const lineRaw = this.p.lineK > 0 ? typical + this.p.lineK * spread : quantile(s, this.p.quantile);
      return { det, typical, line: Math.max(lineRaw, typical + MIN_MARGIN[kind]) };
    });
  }

  judge(v: (number | null)[]): { score: number; level: number } {
    if (!this.models.length) return { score: 0, level: 0 };
    // a one-sided feature below its usual value is judged as if it were usual
    const x = this.project(v).map((val, k) => (this.p.oneSided && UPPER_ONLY.has(this.cols[k]) ? Math.max(val, this.fill[k]) : val));
    const levels = this.models.map((m) => { const sc = m.det.score(x); return { sc, lv: Math.max(0, (sc - m.typical) / Math.max(1e-6, m.line - m.typical)) }; });
    const modelLevel = levels.reduce((a, b) => a + b.lv, 0) / levels.length;
    // range guard: a value far outside anything seen in training would be cut off at the root of every tree, but the
    // forest scores it no higher than its most extreme training point. Count how many floors beyond the range it is.
    let rangeLevel = 0;
    if (this.p.rangeK > 0) x.forEach((val, k) => {
      const excess = Math.max(0, val - this.hi[k], this.lo[k] - val);
      rangeLevel = Math.max(rangeLevel, excess / (this.p.floors[this.cols[k]] * this.p.rangeK));
    });
    return { score: levels[0].sc, level: Math.max(modelLevel, rangeLevel) };
  }

  /** Least-squares trend of each rising-only feature over the recent readings, projected `horizon` readings ahead. */
  forecast(recent: (number | null)[][], horizon: number, minR2: number): Forecast {
    if (!this.models.length) return NO_FORECAST;
    let best: Forecast = NO_FORECAST;
    this.cols.forEach((c, k) => {
      if (!UPPER_ONLY.has(c)) return;
      const pts = recent.map((v, i) => [i, v[c]] as const).filter((q): q is readonly [number, number] => q[1] !== null);
      if (pts.length < Math.max(8, recent.length / 2)) return;
      const n = pts.length, mx = pts.reduce((a, q) => a + q[0], 0) / n, my = pts.reduce((a, q) => a + q[1], 0) / n;
      const sxx = pts.reduce((a, q) => a + (q[0] - mx) ** 2, 0), sxy = pts.reduce((a, q) => a + (q[0] - mx) * (q[1] - my), 0), syy = pts.reduce((a, q) => a + (q[1] - my) ** 2, 0);
      if (sxx <= 0 || syy <= 0) return;
      const b = sxy / sxx, r2 = (sxy * sxy) / (sxx * syy);
      const unit = this.p.floors[c] * this.p.rangeK;
      if (b <= 0 || r2 < minR2 || b * horizon < 2 * this.p.floors[c]) return;      // flat, noisy or too small to matter
      const last = recent.length - 1, at = (t: number) => my + b * (t - mx);
      const level = Math.max(0, at(last + horizon) - this.hi[k]) / unit;
      const crossAt = (this.hi[k] + unit - my) / b + mx;                             // reading index where level reaches 1
      if (level > best.level) best = { level, feature: FEATURE_NAMES[c], inSteps: Math.max(0, Math.round(crossAt - last)) };
    });
    return best;
  }
}
const FEATURE_NAMES = ['cpu', 'memory', 'network in', 'network out', 'requests', 'errors', 'latency', 'throttling'];

export class ServiceBaseline {
  private window: (number | null)[][] = [];
  private own: GroupModel;
  private symptom: GroupModel;
  private sinceFit = 0;
  private rejectedRun = 0;
  private mildRun = 0;       // mild above-line readings in a row
  private fits = 0;
  private fitted = false;
  private recent: (number | null)[][] = [];   // every recent reading, learned or not (for the trend)

  constructor(seed: number, private readonly p: BaselineParams = BASELINE_DEFAULTS) {
    this.own = new GroupModel(GROUPS.own, seed + p.seed * 7919, p);
    this.symptom = new GroupModel(GROUPS.symptom, seed + 1000 + p.seed * 7919, p);
  }

  get ready() { return this.fitted && (this.own.fitted || this.symptom.fitted); }
  get size() { return this.window.length; }

  private fit() {
    this.own.fit(this.window, this.fits);
    this.symptom.fit(this.window, this.fits);
    this.fits++;
    this.fitted = true;
    this.sinceFit = 0;
  }

  /** Judge one reading against the previous models, then (if it is normal in both) learn from it. */
  observe(v: (number | null)[]): Verdict {
    const o = this.own.judge(v), sy = this.symptom.judge(v);
    this.recent.push(v); if (this.recent.length > this.p.forecastWindow) this.recent.shift();
    const fo = this.own.forecast(this.recent, this.p.forecastHorizon, this.p.forecastR2), fs = this.symptom.forecast(this.recent, this.p.forecastHorizon, this.p.forecastR2);
    const forecast = fo.level >= fs.level ? fo : fs;
    const level = Math.max(o.level, sy.level), score = o.level >= sy.level ? o.score : sy.score;
    const normal = !this.ready || level < 1;
    this.rejectedRun = normal ? 0 : this.rejectedRun + 1;
    this.mildRun = !normal && level < this.p.mildLevel ? this.mildRun + 1 : 0;
    // a small, steady shift (a restart that settled at a new memory level, a quieter hour) becomes normal quickly;
    // a big one only after a long time, so a real fault is not learned
    const accepted = normal || this.rejectedRun >= this.p.driftAfter || (this.p.mildDriftAfter > 0 && this.mildRun >= this.p.mildDriftAfter);
    if (accepted) {
      this.window.push(v);
      if (this.window.length > this.p.window) this.window.shift();
      this.sinceFit++;
      if ((!this.fitted && this.window.length >= this.p.minTrain) || (this.fitted && this.sinceFit >= this.p.retrainEvery)) this.fit();
    }
    return { ready: this.ready, score, level, own: o.level, symptom: sy.level, accepted, forecast };
  }
}
