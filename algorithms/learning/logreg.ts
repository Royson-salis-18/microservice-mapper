// algorithms/learning/logreg.ts: L2-regularised logistic regression fitted by Newton's method (IRLS). PURE, deterministic, no dependencies.
// Small on purpose: ~18 features, a few thousand rows. A linear model keeps every learned weight readable in the UI and the
// wiki ("a paused container counts this much"), which matters more here than squeezing out the last point with a black box.

/** Every tunable of the fit (printed by the report). Rows are class-balanced; the intercept is not penalised. */
export const LOGREG_PARAMS = { iterations: 30, tolerance: 1e-7, classBalanced: true, penalty: 'L2 (ridge), intercept excluded', defaultLambda: 1 } as const;

export interface Model { mean: number[]; std: number[]; w: number[]; b: number; lambda: number; features: readonly string[] }

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Solve A x = y for a small dense symmetric positive-definite A (Gaussian elimination with partial pivoting). */
function solve(A: number[][], y: number[]): number[] {
  const n = y.length, M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}

/**
 * Fit. Rows are weighted so both classes count equally in total (faults are rare: without this the model learns "never").
 * lambda penalises large weights (not the intercept), which keeps the model stable on a few hundred positive rows.
 */
export function fit(X: number[][], y: number[], features: readonly string[], lambda: number = LOGREG_PARAMS.defaultLambda, iters: number = LOGREG_PARAMS.iterations): Model {
  const d = X[0]?.length ?? 0, n = X.length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / Math.max(1, n));
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / Math.max(1, n)) || 1);
  const Z = X.map((r) => [1, ...r.map((v, j) => (v - mean[j]) / std[j])]);
  const pos = y.filter((v) => v === 1).length, neg = n - pos;
  const cw = y.map((v) => (v === 1 ? n / (2 * Math.max(1, pos)) : n / (2 * Math.max(1, neg))));
  let beta = new Array(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0), H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i], p = sigmoid(z.reduce((s, v, j) => s + v * beta[j], 0)), w = cw[i] * p * (1 - p), e = cw[i] * (y[i] - p);
      for (let j = 0; j <= d; j++) { g[j] += e * z[j]; for (let k = j; k <= d; k++) H[j][k] += w * z[j] * z[k]; }
    }
    for (let j = 0; j <= d; j++) { for (let k = 0; k < j; k++) H[j][k] = H[k][j]; if (j > 0) { g[j] -= lambda * beta[j]; H[j][j] += lambda; } H[j][j] += 1e-9; }
    const step = solve(H, g);
    beta = beta.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < LOGREG_PARAMS.tolerance) break;
  }
  return { mean, std, w: beta.slice(1), b: beta[0], lambda, features };
}

export function predict(m: Model, x: number[]): number {
  let z = m.b; for (let j = 0; j < x.length; j++) z += m.w[j] * ((x[j] - m.mean[j]) / m.std[j]);
  return sigmoid(z);
}

/** Each feature's push on the log-odds for one row: what the UI shows as "why this score". */
export function contributions(m: Model, x: number[]): { feature: string; value: number }[] {
  return x.map((v, j) => ({ feature: m.features[j], value: m.w[j] * ((v - m.mean[j]) / m.std[j]) })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}
