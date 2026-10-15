/**
 * v2 diagnose: small, dependency-free classifiers for the fault type. All share one shape:
 *   fit(X, y) -> model,   model.predict(x) -> class label
 *
 *   rules    a hand-made decision list: container facts first (detached, paused, restarts, exit codes), then
 *            memory, throttling, and "slow network" as the default. No training. The baseline to beat.
 *   knn      k nearest neighbours on z-scored features (mean and standard deviation from the training set),
 *            Euclidean distance, votes weighted by 1 / (distance + 1e-6).
 *   nb       Gaussian naive Bayes:  log P(c | x) = log P(c) + sum_j log N(x_j; mu_cj, var_cj) + const,
 *            with var_cj + 1e-2 x (largest feature variance) as smoothing, so a constant feature cannot dominate.
 *   tree     CART: binary splits "x_j <= threshold", chosen to minimise the weighted Gini impurity of the children,
 *            Gini(S) = 1 - sum_c p_c^2. Stops at maxDepth, at minLeaf samples, or when a node is pure.
 *   forest   random forest (Breiman 2001): T CART trees, each on a bootstrap sample, each split looking at a random
 *            subset of mtry features (default sqrt(d)). Prediction = majority vote. Seeded, so runs repeat exactly.
 *
 * PURE: numbers in, labels out.
 */
import { FEATURE_NAMES, type FeatureName } from './features.ts';

export interface Model { predict(x: number[]): string; proba?(x: number[]): Map<string, number> }
export type Trainer = (X: number[][], y: string[]) => Model;

/** Seeded PRNG (mulberry32): same seed, same forest. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const argmax = (m: Map<string, number>): string => {
  let best = '', bv = -Infinity;
  for (const [k, v] of [...m].sort((p, q) => (p[0] < q[0] ? -1 : 1))) if (v > bv) { bv = v; best = k; }
  return best;
};

// ---------- (a) hand-made decision list ----------
const F = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i])) as Record<FeatureName, number>;
/** Rules of thumb an operator would use. Thresholds were set by reading the feature definitions, not by fitting. */
export function decisionList(x: number[]): string {
  const g = (n: FeatureName) => x[F[n]];
  if (g('detached') > 0 || (g('net_zero') > 0.3 && g('st_exited') + g('st_paused') + g('st_restarting') === 0)) return 'partition';
  if (g('st_paused') > 0) return 'pause';
  const memoryUp = g('mem_ratio') > 0.35 || (g('mem_max') > 0.8 && g('mem_jump') > 0.2) || g('mem_slope') > 2.5;
  if (memoryUp) return 'memory';
  const outages = g('st_outages');
  const down = g('st_exited') + g('st_restarting') > 0 || g('restart_events') > 0;
  if (down) {
    const clean = g('exit_zero') > g('exit_nonzero');
    if (outages >= 2) return clean ? 'flap' : 'crash-loop';
    if (clean) return 'stop';
    return g('st_down_now') && g('st_longest_down') > Math.log1p(8) ? 'stop' : 'crash';
  }
  if (g('thr_delta') > 3 || g('thr_max') > 10) return 'brownout';
  return 'latency';
}
export const trainRules: Trainer = () => ({ predict: decisionList });

// ---------- standardisation ----------
export interface Scaler { mu: number[]; sd: number[] }
export function fitScaler(X: number[][]): Scaler {
  const d = X[0]?.length ?? 0;
  const mu = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
  const sd = mu.map((m, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - m) ** 2, 0) / X.length) || 1);
  return { mu, sd };
}
export const scale = (s: Scaler, x: number[]) => x.map((v, j) => (v - s.mu[j]) / s.sd[j]);

// ---------- (b) k nearest neighbours ----------
export function trainKnn(k = 5): Trainer {
  return (X, y) => {
    const sc = fitScaler(X);
    const Z = X.map((r) => scale(sc, r));
    const proba = (x: number[]) => {
      const z = scale(sc, x);
      const d = Z.map((r, i) => ({ i, d: Math.sqrt(r.reduce((s, v, j) => s + (v - z[j]) ** 2, 0)) })).sort((p, q) => p.d - q.d || p.i - q.i).slice(0, k);
      const votes = new Map<string, number>();
      for (const { i, d: dist } of d) votes.set(y[i], (votes.get(y[i]) ?? 0) + 1 / (dist + 1e-6));
      return votes;
    };
    return { proba, predict: (x) => argmax(proba(x)) };
  };
}

// ---------- (c) Gaussian naive Bayes ----------
export function trainNaiveBayes(smoothing = 1e-2): Trainer {
  return (X, y) => {
    const classes = [...new Set(y)].sort();
    const d = X[0].length;
    const sc = fitScaler(X);
    const Z = X.map((r) => scale(sc, r));
    const varMax = 1; // after z-scoring every feature has variance 1 (or 0)
    const stats = classes.map((c) => {
      const rows = Z.filter((_, i) => y[i] === c);
      const mu = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);
      const v = mu.map((m, j) => rows.reduce((s, r) => s + (r[j] - m) ** 2, 0) / rows.length + smoothing * varMax);
      return { c, prior: Math.log(rows.length / Z.length), mu, v };
    });
    const proba = (x: number[]) => {
      const z = scale(sc, x);
      const logp = stats.map((s) => s.prior + z.reduce((acc, zj, j) => acc - 0.5 * Math.log(2 * Math.PI * s.v[j]) - ((zj - s.mu[j]) ** 2) / (2 * s.v[j]), 0));
      const mx = Math.max(...logp);
      const p = logp.map((l) => Math.exp(l - mx));
      const tot = p.reduce((a, b) => a + b, 0);
      return new Map(stats.map((s, i) => [s.c, p[i] / tot]));
    };
    return { proba, predict: (x) => argmax(proba(x)) };
  };
}

// ---------- (d) CART decision tree ----------
export type Node = { leaf: true; counts: Map<string, number> } | { leaf: false; f: number; thr: number; l: Node; r: Node };
export interface TreeParams { maxDepth: number; minLeaf: number; mtry?: number; seed?: number }

export function gini(counts: Map<string, number>, n: number): number {
  if (!n) return 0;
  let s = 0;
  for (const c of counts.values()) s += (c / n) ** 2;
  return 1 - s;
}
const countOf = (idx: number[], y: string[]) => { const m = new Map<string, number>(); for (const i of idx) m.set(y[i], (m.get(y[i]) ?? 0) + 1); return m; };

export function buildTree(X: number[][], y: string[], idx: number[], p: TreeParams, rand: () => number, depth = 0): Node {
  const counts = countOf(idx, y);
  if (depth >= p.maxDepth || idx.length < 2 * p.minLeaf || counts.size === 1) return { leaf: true, counts };
  const d = X[0].length;
  // the features this split may look at (all of them for a plain tree, a random subset in a forest)
  let feats = Array.from({ length: d }, (_, j) => j);
  if (p.mtry && p.mtry < d) {
    for (let j = d - 1; j > 0; j--) { const k = Math.floor(rand() * (j + 1)); [feats[j], feats[k]] = [feats[k], feats[j]]; }
    feats = feats.slice(0, p.mtry);
  }
  const n = idx.length;
  let best = { score: gini(counts, n) - 1e-12, f: -1, thr: 0 };
  for (const f of feats) {
    const sorted = [...idx].sort((a, b) => X[a][f] - X[b][f]);
    const left = new Map<string, number>(), right = new Map(counts);
    for (let k = 0; k < n - 1; k++) {
      const c = y[sorted[k]];
      left.set(c, (left.get(c) ?? 0) + 1);
      right.set(c, right.get(c)! - 1);
      const nl = k + 1, nr = n - nl;
      const a = X[sorted[k]][f], b = X[sorted[k + 1]][f];
      if (a === b || nl < p.minLeaf || nr < p.minLeaf) continue;
      const score = (nl * gini(left, nl) + nr * gini(right, nr)) / n;
      if (score < best.score) best = { score, f, thr: (a + b) / 2 };
    }
  }
  if (best.f < 0) return { leaf: true, counts };
  const l = idx.filter((i) => X[i][best.f] <= best.thr), r = idx.filter((i) => X[i][best.f] > best.thr);
  return { leaf: false, f: best.f, thr: best.thr, l: buildTree(X, y, l, p, rand, depth + 1), r: buildTree(X, y, r, p, rand, depth + 1) };
}
export function leafOf(node: Node, x: number[]): Map<string, number> {
  while (!node.leaf) node = x[node.f] <= node.thr ? node.l : node.r;
  return node.counts;
}
export function trainTree(p: TreeParams = { maxDepth: 6, minLeaf: 2 }): Trainer {
  return (X, y) => {
    const root = buildTree(X, y, X.map((_, i) => i), p, rng(p.seed ?? 1));
    return { predict: (x) => argmax(leafOf(root, x)), proba: (x) => leafOf(root, x) };
  };
}

// ---------- (e) random forest ----------
export interface ForestParams { trees: number; maxDepth: number; minLeaf: number; mtry?: number; seed: number }
export function trainForest(p: ForestParams = { trees: 150, maxDepth: 8, minLeaf: 1, seed: 7 }): Trainer {
  return (X, y) => {
    const rand = rng(p.seed);
    const mtry = p.mtry ?? Math.max(1, Math.round(Math.sqrt(X[0].length)));
    const trees: Node[] = [];
    for (let t = 0; t < p.trees; t++) {
      const boot = X.map(() => Math.floor(rand() * X.length));
      trees.push(buildTree(X, y, boot, { maxDepth: p.maxDepth, minLeaf: p.minLeaf, mtry }, rand));
    }
    const proba = (x: number[]) => {
      const votes = new Map<string, number>();
      for (const tr of trees) { const c = argmax(leafOf(tr, x)); votes.set(c, (votes.get(c) ?? 0) + 1 / trees.length); }
      return votes;
    };
    return { proba, predict: (x) => argmax(proba(x)) };
  };
}

/** Mean decrease in impurity is not tracked; instead count how often each feature is used for a split (cheap, readable). */
export function splitCounts(root: Node, out = new Map<number, number>()): Map<number, number> {
  if (!root.leaf) { out.set(root.f, (out.get(root.f) ?? 0) + 1); splitCounts(root.l, out); splitCounts(root.r, out); }
  return out;
}

// ---------- metrics ----------
export interface Report { n: number; accuracy: number; macroF1: number; labels: string[]; confusion: number[][]; perClass: Record<string, { n: number; recall: number; precision: number; f1: number }> }
/** Accuracy, macro-F1 (mean over the classes that occur in truth or predictions) and the confusion matrix (rows = truth). */
export function evaluate(truth: string[], pred: string[], labelOrder?: string[]): Report {
  const labels = labelOrder ?? [...new Set([...truth, ...pred])].sort();
  const ix = new Map(labels.map((l, i) => [l, i]));
  const confusion = labels.map(() => labels.map(() => 0));
  truth.forEach((t, i) => confusion[ix.get(t)!][ix.get(pred[i])!]++);
  const perClass: Report['perClass'] = {};
  const present = labels.filter((l, i) => confusion[i].some((v) => v > 0) || confusion.some((r) => r[i] > 0));
  for (const l of present) {
    const i = ix.get(l)!;
    const tp = confusion[i][i], n = confusion[i].reduce((a, b) => a + b, 0), predN = confusion.reduce((a, r) => a + r[i], 0);
    const recall = n ? tp / n : 0, precision = predN ? tp / predN : 0;
    perClass[l] = { n, recall, precision, f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0 };
  }
  const f1s = Object.values(perClass).map((c) => c.f1);
  return { n: truth.length, accuracy: truth.length ? truth.filter((t, i) => t === pred[i]).length / truth.length : 0, macroF1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0, labels, confusion, perClass };
}
