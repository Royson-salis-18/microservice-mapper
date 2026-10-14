/**
 * Isolation Forest (Liu, Ting and Zhou, ICDM 2008), small and dependency-free.
 *
 * Idea: build many random trees. Each tree keeps cutting the data at a random value of a random feature until every point
 * sits alone. A point that is unlike the rest gets isolated after very few cuts; a point inside the crowd needs many.
 * The anomaly score turns the average number of cuts into a number between 0 and 1:
 *
 *   s(x) = 2 ^ ( -E[h(x)] / c(psi) )        c(n) = 2 H(n-1) - 2(n-1)/n,  H(i) ~ ln(i) + 0.5772
 *
 * s close to 1: isolated quickly, anomalous.  s around 0.5 or below: an ordinary point.
 * PURE and seeded, so the same data always gives the same model (needed for repeatable experiments).
 */

export interface ForestParams {
  trees: number;          // number of random trees
  sampleSize: number;     // points drawn for each tree (psi)
  seed: number;
}
export const FOREST_DEFAULTS: ForestParams = { trees: 100, sampleSize: 64, seed: 7 };

type Tree = { size: number } | { f: number; v: number; l: Tree; r: Tree };
export interface Forest { trees: Tree[]; psi: number; dims: number }

/** Average path length of an unsuccessful search in a binary search tree of n points (the normaliser). */
export function cFactor(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
}

/** mulberry32: a tiny seeded random generator. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grow(X: number[][], idx: number[], depth: number, limit: number, rand: () => number): Tree {
  if (depth >= limit || idx.length <= 1) return { size: idx.length };
  const dims = X[0].length;
  // only features that still vary among these points can split them
  const usable: { f: number; lo: number; hi: number }[] = [];
  for (let f = 0; f < dims; f++) {
    let lo = Infinity, hi = -Infinity;
    for (const i of idx) { const v = X[i][f]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi > lo) usable.push({ f, lo, hi });
  }
  if (!usable.length) return { size: idx.length };
  const { f, lo, hi } = usable[Math.floor(rand() * usable.length)];
  const v = lo + rand() * (hi - lo);
  const left: number[] = [], right: number[] = [];
  for (const i of idx) (X[i][f] < v ? left : right).push(i);
  return { f, v, l: grow(X, left, depth + 1, limit, rand), r: grow(X, right, depth + 1, limit, rand) };
}

export function fitForest(X: number[][], p: Partial<ForestParams> = {}): Forest {
  const { trees, sampleSize, seed } = { ...FOREST_DEFAULTS, ...p };
  const rand = rng(seed);
  const psi = Math.min(sampleSize, X.length);
  const limit = Math.ceil(Math.log2(Math.max(2, psi)));
  const out: Tree[] = [];
  for (let t = 0; t < trees; t++) {
    // sample without replacement (partial Fisher-Yates)
    const pool = X.map((_, i) => i);
    for (let i = 0; i < psi; i++) { const j = i + Math.floor(rand() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    out.push(grow(X, pool.slice(0, psi), 0, limit, rand));
  }
  return { trees: out, psi, dims: X[0]?.length ?? 0 };
}

function pathLength(x: number[], t: Tree, depth: number): number {
  if ('size' in t) return depth + cFactor(t.size);
  return pathLength(x, x[t.f] < t.v ? t.l : t.r, depth + 1);
}

/** Anomaly score in (0, 1). */
export function scoreForest(forest: Forest, x: number[]): number {
  if (!forest.trees.length) return 0;
  let sum = 0;
  for (const t of forest.trees) sum += pathLength(x, t, 0);
  return Math.pow(2, -(sum / forest.trees.length) / Math.max(1e-9, cFactor(forest.psi)));
}
