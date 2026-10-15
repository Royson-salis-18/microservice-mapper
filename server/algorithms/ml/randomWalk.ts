/**
 * Root cause by random walk on the call graph: personalised PageRank, in the form MonitorRank uses
 * (Kim, Sumbaly and Shah, SIGMETRICS 2013).
 *
 * Every service has an anomaly a(v) between 0 and 1 (from its Isolation Forest). Imagine a walker that starts on an
 * anomalous service and keeps stepping:
 *
 *   forward   u -> v  (u calls v)     weight  w(u,v) * a(v)           follow the trouble down towards its source
 *   backward  v -> u  (u calls v)     weight  rho * a(u)              allows leaving a dead end
 *   stay      u -> u                  weight  max(0, a(u) - max a(callees), own(u))
 *             u is sicker than anything it calls, or its own resources (CPU, memory) are off: nothing downstream causes those
 *
 * At every step it jumps back to a random anomalous service with probability alpha (restart, weighted by a).
 * The share of time the walker spends on a service is its root-cause score. A service whose trouble is not explained
 * by anything it calls keeps the walker (the "stay" weight), so the source collects the most time; a caller whose
 * callee is sicker passes the walker on, so a victim collects less.
 *
 * PURE.
 */
export interface WalkParams { alpha: number; rho: number; iterations: number }
export const WALK_DEFAULTS: WalkParams = { alpha: 0.15, rho: 0.2, iterations: 60 };

export interface WalkEdge { from: string; to: string; weight: number; mutual?: boolean }   // caller -> callee; mutual: direction unknown

export function rootCauseWalk(ids: string[], a: Map<string, number>, edges: WalkEdge[], p: Partial<WalkParams> = {}, own?: Map<string, number>): Map<string, number> {
  const { alpha, rho, iterations } = { ...WALK_DEFAULTS, ...p };
  const n = ids.length, index = new Map(ids.map((id, i) => [id, i]));
  const an = ids.map((id) => Math.max(0, Math.min(1, a.get(id) ?? 0)));
  const ao = ids.map((id) => Math.max(0, Math.min(1, own?.get(id) ?? 0)));
  const total = an.reduce((s, x) => s + x, 0);
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!n || total <= 0) return out;

  const callees: { j: number; w: number; mutual: boolean }[][] = ids.map(() => []);
  const callers: number[][] = ids.map(() => []);
  for (const e of edges) {
    const i = index.get(e.from), j = index.get(e.to);
    if (i === undefined || j === undefined || i === j) continue;
    callees[i].push({ j, w: Math.max(0, e.weight), mutual: !!e.mutual });
    callers[j].push(i);
  }
  // transition rows
  const rows: { j: number; p: number }[][] = ids.map((_, i) => {
    const moves: { j: number; p: number }[] = [];
    let worstCallee = 0;
    // a link whose direction is unknown lets the walker move, but cannot explain this service away
    for (const { j, w, mutual } of callees[i]) { moves.push({ j, p: w * an[j] }); if (!mutual) worstCallee = Math.max(worstCallee, an[j]); }
    for (const k of callers[i]) moves.push({ j: k, p: rho * an[k] });
    // stay: trouble not explained by anything it calls, and its own (resource) trouble, which nothing downstream can cause
    moves.push({ j: i, p: Math.max(0, an[i] - worstCallee, ao[i]) });
    const sum = moves.reduce((s, m) => s + m.p, 0);
    return sum > 0 ? moves.map((m) => ({ j: m.j, p: m.p / sum })) : [{ j: i, p: 1 }];
  });
  const restart = an.map((x) => x / total);
  let pi = [...restart];
  for (let it = 0; it < iterations; it++) {
    const next = restart.map((r) => alpha * r);
    for (let i = 0; i < n; i++) for (const m of rows[i]) next[m.j] += (1 - alpha) * pi[i] * m.p;
    pi = next;
  }
  const s = pi.reduce((x, y) => x + y, 0) || 1;
  ids.forEach((id, i) => out.set(id, pi[i] / s));
  return out;
}

/**
 * Plain personalised PageRank, in the form MicroRCA uses (Wu et al., NOMS 2020): the walker follows calls towards
 * anomalous callees and restarts on anomalous services, with no "stay" weight and no explaining away. Kept as a
 * comparison for the MonitorRank-style walk above.
 */
export function pageRankScores(ids: string[], a: Map<string, number>, edges: WalkEdge[], alpha = 0.15, iterations = 60): Map<string, number> {
  const n = ids.length, index = new Map(ids.map((id, i) => [id, i]));
  const an = ids.map((id) => Math.max(0, Math.min(1, a.get(id) ?? 0)));
  const total = an.reduce((s, x) => s + x, 0);
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!n || total <= 0) return out;
  const rows: { j: number; p: number }[][] = ids.map(() => []);
  for (const e of edges) { const i = index.get(e.from), j = index.get(e.to); if (i !== undefined && j !== undefined && i !== j) rows[i].push({ j, p: Math.max(0, e.weight) * an[j] }); }
  const norm = rows.map((r, i) => { const s = r.reduce((t, m) => t + m.p, 0); return s > 0 ? r.map((m) => ({ j: m.j, p: m.p / s })) : [{ j: i, p: 1 }]; });
  const restart = an.map((x) => x / total);
  let pi = [...restart];
  for (let it = 0; it < iterations; it++) {
    const next = restart.map((r) => alpha * r);
    for (let i = 0; i < n; i++) for (const m of norm[i]) next[m.j] += (1 - alpha) * pi[i] * m.p;
    pi = next;
  }
  ids.forEach((id, i) => out.set(id, pi[i]));
  return out;
}
