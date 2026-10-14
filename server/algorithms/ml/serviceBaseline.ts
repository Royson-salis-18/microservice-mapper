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
import { fitForest, scoreForest, rng, type Forest } from './isolationForest.js';
import type { MetricSnapshot } from '../../models/MetricSnapshot.js';

export interface BaselineParams {
  window: number;          // accepted readings kept for training (the sliding window)
  minTrain: number;        // readings needed before the first model
  retrainEvery: number;    // accepted readings between rebuilds
  quantile: number;        // where the alarm line sits among the training scores
  driftAfter: number;      // consecutive above-line readings after which the change is accepted as the new normal
  trees: number;
  sampleSize: number;
  minRequests: number;     // error share and latency mean nothing below this many requests
  jitter: number;          // training noise, in units of each feature's floor
  seed: number;            // added to every forest's random seed (repeat experiments with different seeds)
  lineK: number;           // alarm line = typical + lineK robust spreads of the training scores (0: use the quantile)
  rangeK: number;          // range guard: this many floors beyond the training range counts as level 1 (0: off)
}
export const BASELINE_DEFAULTS: BaselineParams = {
  window: 120, minTrain: 30, retrainEvery: 10, quantile: 0.97, driftAfter: 360, trees: 100, sampleSize: 64, minRequests: 5, jitter: 0.5, seed: 0, lineK: 3, rangeK: 5,
};

/** The numbers the forest sees for one reading. Positive quantities on a log scale (ratios matter, not differences). */
export const ML_FEATURES = ['cpu', 'memory', 'netIn', 'netOut', 'requests', 'errors', 'latency', 'throttle'] as const;
/** Smallest spread worth noticing for each feature (log units, except error share and throttling %). A feature that never
 *  moved in the window would otherwise give the trees nothing to cut on, and a later jump in it would go unseen. */
export const FEATURE_FLOOR = [0.15, 0.15, 0.15, 0.15, 0.15, 0.02, 0.15, 3];
/** Two forests per service: its OWN signals (resources: a dependency cannot cause these) and its SYMPTOMS (traffic,
 *  errors, latency, network: these can be inherited from a broken dependency). Indices into ML_FEATURES. */
export const GROUPS = { own: [0, 1, 7], symptom: [2, 3, 4, 5, 6] } as const;

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
}

/** One forest over a subset of the features, with its own alarm line. */
class GroupModel {
  forest: Forest | null = null;
  cols: number[] = [];
  fill: number[] = [];
  typical = 0;
  line = 1;
  lo: number[] = [];
  hi: number[] = [];
  constructor(private readonly features: readonly number[], private readonly seed: number, private readonly p: BaselineParams) {}

  project(v: (number | null)[]): number[] { return this.cols.map((c, k) => v[c] ?? this.fill[k]); }

  fit(window: (number | null)[][], fits: number) {
    // a feature is used only if most readings in the window have it
    this.cols = this.features.filter((c) => window.filter((v) => v[c] !== null).length >= 0.5 * window.length);
    if (!this.cols.length) { this.forest = null; return; }
    this.fill = this.cols.map((c) => median(window.map((v) => v[c]).filter((x): x is number => x !== null)));
    // training copy with a little noise at each feature's floor, so constant features still define a range
    const noise = rng(this.seed * 31 + fits);
    const gauss = () => { const u = Math.max(1e-9, noise()), w = noise(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
    const raw = window.map((v) => this.project(v));
    this.lo = this.cols.map((_, k) => Math.min(...raw.map((x) => x[k])));
    this.hi = this.cols.map((_, k) => Math.max(...raw.map((x) => x[k])));
    const X = raw.map((x) => x.map((v, k) => v + gauss() * FEATURE_FLOOR[this.cols[k]] * this.p.jitter));
    this.forest = fitForest(X, { trees: this.p.trees, sampleSize: this.p.sampleSize, seed: this.seed + fits });
    const s = X.map((x) => scoreForest(this.forest!, x));
    this.typical = median(s);
    // the line is never closer to typical than a small margin: a perfectly flat series would otherwise alarm on noise
    const spread = 1.4826 * median(s.map((x) => Math.abs(x - this.typical)));
    const lineRaw = this.p.lineK > 0 ? this.typical + this.p.lineK * spread : quantile(s, this.p.quantile);
    this.line = Math.max(lineRaw, this.typical + 0.02);
  }

  judge(v: (number | null)[]): { score: number; level: number } {
    if (!this.forest) return { score: 0, level: 0 };
    const x = this.project(v);
    const score = scoreForest(this.forest, x);
    const forestLevel = Math.max(0, (score - this.typical) / Math.max(1e-6, this.line - this.typical));
    // range guard: a value far outside anything seen in training would be cut off at the root of every tree, but the
    // forest scores it no higher than its most extreme training point. Count how many floors beyond the range it is.
    let rangeLevel = 0;
    if (this.p.rangeK > 0) x.forEach((val, k) => {
      const excess = Math.max(0, val - this.hi[k], this.lo[k] - val);
      rangeLevel = Math.max(rangeLevel, excess / (FEATURE_FLOOR[this.cols[k]] * this.p.rangeK));
    });
    return { score, level: Math.max(forestLevel, rangeLevel) };
  }
}

export class ServiceBaseline {
  private window: (number | null)[][] = [];
  private own: GroupModel;
  private symptom: GroupModel;
  private sinceFit = 0;
  private rejectedRun = 0;
  private fits = 0;
  private fitted = false;

  constructor(seed: number, private readonly p: BaselineParams = BASELINE_DEFAULTS) {
    this.own = new GroupModel(GROUPS.own, seed + p.seed * 7919, p);
    this.symptom = new GroupModel(GROUPS.symptom, seed + 1000 + p.seed * 7919, p);
  }

  get ready() { return this.fitted && (this.own.forest !== null || this.symptom.forest !== null); }
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
    const level = Math.max(o.level, sy.level), score = o.level >= sy.level ? o.score : sy.score;
    const normal = !this.ready || level < 1;
    this.rejectedRun = normal ? 0 : this.rejectedRun + 1;
    const accepted = normal || this.rejectedRun >= this.p.driftAfter;
    if (accepted) {
      this.window.push(v);
      if (this.window.length > this.p.window) this.window.shift();
      this.sinceFit++;
      if ((!this.fitted && this.window.length >= this.p.minTrain) || (this.fitted && this.sinceFit >= this.p.retrainEvery)) this.fit();
    }
    return { ready: this.ready, score, level, own: o.level, symptom: sy.level, accepted };
  }
}
