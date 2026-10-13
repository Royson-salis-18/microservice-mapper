// tools/eval/stats.ts: the statistics a results section needs, beyond proportions with intervals. PURE and seeded: the
// same inputs give the same numbers every time.
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const sd = (x: number[]) => { if (x.length < 2) return NaN; const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };

export function moments(x: number[]) {
  const n = x.length, m = mean(x), s = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (n || 1));
  const skew = n > 2 && s > 0 ? x.reduce((a, v) => a + ((v - m) / s) ** 3, 0) / n : NaN;
  const kurt = n > 3 && s > 0 ? x.reduce((a, v) => a + ((v - m) / s) ** 4, 0) / n - 3 : NaN;      // excess kurtosis
  return { n, mean: m, sd: sd(x), skew, kurt };
}

function ranks(x: number[]): number[] {
  const idx = x.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array(x.length);
  let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}
export function pearson(a: number[], b: number[]): number {
  const n = a.length; if (n < 3) return NaN; const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}
export const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));
/** Two-sided p-value for a correlation r over n pairs (t approximation, normal tail via erf for large df; adequate for n >= 8). */
export function corrP(r: number, n: number): number {
  if (!Number.isFinite(r) || n < 4) return NaN; const t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));
  const z = Math.abs(t) * (1 - 1 / (4 * (n - 2))) / Math.sqrt(1 + (t * t) / (2 * (n - 2)));
  return Math.min(1, 2 * (1 - normCdf(z)));
}
export const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x: number) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }

/** Small seeded PRNG (mulberry32) so bootstrap and fold assignment are reproducible. */
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Percentile bootstrap CI for the mean of 0/1 outcomes (or any numbers). */
export function bootstrapCI(x: number[], iters = 2000, seed = 7): { mean: number; lo: number; hi: number; n: number } {
  if (!x.length) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const r = rng(seed), ms: number[] = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let i = 0; i < x.length; i++) s += x[(r() * x.length) | 0]; ms.push(s / x.length); }
  ms.sort((a, b) => a - b); return { mean: mean(x), lo: ms[Math.floor(0.025 * iters)], hi: ms[Math.floor(0.975 * iters)], n: x.length };
}

/**
 * Stratified k-fold cross-validation of an outcome per fault. The mapper's rules are fixed (nothing is trained on these faults),
 * so this is not model selection: it shows how much the accuracy figure moves when the faults are split into k disjoint groups,
 * i.e. how stable the estimate is. `strata` keeps every fold's mix of fault classes similar.
 */
export function kFold(outcomes: number[], strata: string[], k = 5, seed = 11): { folds: { n: number; acc: number }[]; mean: number; sd: number } {
  const r = rng(seed), byS = new Map<string, number[]>();
  outcomes.forEach((_, i) => { const a = byS.get(strata[i]) ?? []; a.push(i); byS.set(strata[i], a); });
  const fold: number[][] = Array.from({ length: k }, () => []); let c = 0;
  for (const idxs of byS.values()) { idxs.sort(() => r() - 0.5); for (const i of idxs) fold[c++ % k].push(i); }
  const folds = fold.filter((f) => f.length).map((f) => ({ n: f.length, acc: mean(f.map((i) => outcomes[i])) }));
  return { folds, mean: mean(folds.map((f) => f.acc)), sd: sd(folds.map((f) => f.acc)) };
}

/** Exact one-sided binomial test: P(X >= k) for X ~ Bin(n, p). Used against "pick one of the candidates at random". */
export function binomUpper(k: number, n: number, p: number): number {
  if (n === 0) return NaN; let logC = 0, tot = 0;
  const lg = (m: number) => { let s = 0; for (let i = 2; i <= m; i++) s += Math.log(i); return s; };
  const lN = lg(n);
  for (let i = k; i <= n; i++) { logC = lN - lg(i) - lg(n - i); tot += Math.exp(logC + i * Math.log(Math.max(p, 1e-12)) + (n - i) * Math.log(Math.max(1 - p, 1e-12))); }
  return Math.min(1, tot);
}

/** Cohen's kappa for a confusion matrix of counts (agreement beyond chance between injected and inferred class). */
export function kappa(counts: number[][]): number {
  const n = counts.flat().reduce((a, b) => a + b, 0); if (!n) return NaN;
  const po = counts.reduce((s, row, i) => s + (row[i] ?? 0), 0) / n;
  const rows = counts.map((r) => r.reduce((a, b) => a + b, 0)), cols = counts[0].map((_, j) => counts.reduce((s, r) => s + r[j], 0));
  const pe = rows.reduce((s, r, i) => s + (r * (cols[i] ?? 0)) / (n * n), 0);
  return pe === 1 ? NaN : (po - pe) / (1 - pe);
}
