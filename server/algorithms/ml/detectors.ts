/**
 * Unsupervised anomaly detectors that can learn one service's normal from a window of readings. Every detector gives a
 * score where higher means more unusual; the baseline turns that into a level (0 typical, 1 on the alarm line) the same
 * way for all of them, so they can be swapped and compared.
 *
 *   iforest      Isolation Forest (Liu, Ting and Zhou 2008): how few random cuts isolate the point
 *   knn          mean distance to the k nearest training readings (Ramaswamy et al. 2000), on standardised features
 *   mahalanobis  distance from the training mean in units of the training covariance (shrunk towards the diagonal, so it
 *                stays invertible with few readings); the classic multivariate control chart (Hotelling T²)
 *   hbos         histogram-based outlier score (Goldstein and Dengel 2012): per feature, how rare the reading's bin is;
 *                fast and robust, but blind to combinations
 *   ensemble     the mean of the levels of all four (scored separately, each against its own alarm line)
 *
 * PURE: numbers in, numbers out.
 */
import { fitForest, scoreForest, type Forest } from './isolationForest.js';

export type DetectorKind = 'iforest' | 'knn' | 'mahalanobis' | 'hbos';
export const DETECTORS: DetectorKind[] = ['iforest', 'knn', 'mahalanobis', 'hbos'];

export interface Detector { kind: DetectorKind; score(x: number[]): number }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Per-feature centre and spread, for the distance-based detectors (a floor keeps a constant feature usable). */
function standardiser(X: number[][], floors: number[]) {
  const d = X[0]?.length ?? 0;
  const mu = Array.from({ length: d }, (_, k) => mean(X.map((x) => x[k])));
  const sd = Array.from({ length: d }, (_, k) => Math.max(floors[k] ?? 1e-3, Math.sqrt(mean(X.map((x) => (x[k] - mu[k]) ** 2)))));
  return (x: number[]) => x.map((v, k) => (v - mu[k]) / sd[k]);
}

function knn(X: number[][], floors: number[], k = 5): Detector {
  const z = standardiser(X, floors);
  const Z = X.map(z);
  const kk = Math.max(1, Math.min(k, Z.length - 1));
  return {
    kind: 'knn',
    score(x) {
      const q = z(x);
      const d = Z.map((p) => Math.sqrt(p.reduce((s, v, i) => s + (v - q[i]) ** 2, 0))).sort((a, b) => a - b);
      // a training reading scored against its own window would find itself at distance 0: skip exact matches
      const start = d[0] === 0 ? 1 : 0;
      return mean(d.slice(start, start + kk));
    },
  };
}

/** Solve A y = b for a small symmetric positive-definite A (Cholesky). */
function cholesky(A: number[][]): number[][] {
  const n = A.length, L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / L[j][j];
  }
  return L;
}

function mahalanobis(X: number[][], floors: number[], shrink = 0.3): Detector {
  const z = standardiser(X, floors);
  const Z = X.map(z), n = Z.length, d = Z[0]?.length ?? 0;
  const mu = Array.from({ length: d }, (_, k) => mean(Z.map((x) => x[k])));
  const C = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => {
    const c = Z.reduce((s, x) => s + (x[i] - mu[i]) * (x[j] - mu[j]), 0) / Math.max(1, n - 1);
    return (1 - shrink) * c + (i === j ? shrink : 0);       // shrink towards the identity (features are standardised)
  }));
  const L = cholesky(C);
  return {
    kind: 'mahalanobis',
    score(x) {
      const v = z(x).map((t, k) => t - mu[k]);
      // forward substitution: L y = v, distance² = |y|²
      const y = new Array(d).fill(0);
      for (let i = 0; i < d; i++) { let s = v[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
      return Math.sqrt(y.reduce((s, t) => s + t * t, 0));
    },
  };
}

function hbos(X: number[][], floors: number[], bins = 10): Detector {
  const d = X[0]?.length ?? 0, n = X.length;
  const hist = Array.from({ length: d }, (_, k) => {
    const vs = X.map((x) => x[k]);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    const pad = Math.max(floors[k] ?? 1e-3, (hi - lo) * 0.05); lo -= pad; hi += pad;
    const w = (hi - lo) / bins, counts = new Array(bins).fill(0);
    for (const v of vs) counts[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)))]++;
    return { lo, w, counts };
  });
  return {
    kind: 'hbos',
    score(x) {
      let s = 0;
      x.forEach((v, k) => {
        const h = hist[k], b = Math.floor((v - h.lo) / h.w);
        const c = b < 0 || b >= bins ? 0 : h.counts[b];
        s += Math.log(n / Math.max(0.5, c));       // a bin nobody fell into counts as half a reading
      });
      return s;
    },
  };
}

function iforest(X: number[][], opts: { trees: number; sampleSize: number; seed: number }): Detector {
  const forest: Forest = fitForest(X, opts);
  return { kind: 'iforest', score: (x) => scoreForest(forest, x) };
}

export function fitDetector(kind: DetectorKind, X: number[][], floors: number[], opts: { trees: number; sampleSize: number; seed: number }): Detector {
  switch (kind) {
    case 'knn': return knn(X, floors);
    case 'mahalanobis': return mahalanobis(X, floors);
    case 'hbos': return hbos(X, floors);
    default: return iforest(X, opts);
  }
}
