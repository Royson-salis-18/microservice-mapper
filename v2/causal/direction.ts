/**
 * v2 causal: learn the DIRECTION of each observed service pair (caller -> callee) from the telemetry itself, online.
 *
 * The collector sees connections, but most pairs show up from both ends, so the direction of a call is unknown. v1
 * guesses it from service names (entry -> service -> store). This module learns it from what the services do instead.
 * Every method gives a signed score s(a, b) in [-1, 1] for the pair key "a|b" (a < b): s > 0 means "a calls b",
 * s < 0 means "b calls a", 0 means no evidence.
 *
 * Indicators, per service x and moment t (all computed online, each reading judged against the window BEFORE it):
 *   H_x(t)   container fact (down, paused, restarting, detached): ml[x][4] = 1
 *   zE, zL   robust z-score of the error share and of log p95 latency:  z = (v - median) / max(1.4826 MAD, floor)
 *   zR       robust z-score of log request rate, or of log received bytes when the service has no request metrics
 *   U_x(t)   "upward symptom":  not H, and max(zE, zL) >= zUp        (errors and slow calls travel UP to callers)
 *   D_x(t)   "traffic drop":    not H, and zR <= -zDown              (missing traffic travels DOWN to callees)
 *   S_x(t)   "source-like":     H, or own (resource) level ml[x][1] >= 1
 *   T_x(t)   "trouble":         H or U
 *
 * Methods (score for "a calls b"):
 *   edges        collector views:  (n(a->b) - n(b->a)) / (n(a->b) + n(b->a)).  A pair seen from one end only.
 *   up           errors flow up:   lift(U_a | S_b) - lift(U_b | S_a),  lift(U | S) = P(U | S) - P(U)
 *   down         traffic flows down: lift(D_b | S_a) - lift(D_a | S_b)
 *   implication  P(T_a | T_b) - P(T_b | T_a): everything that hurts b hurts its caller a, not the other way round
 *   onset        onsets of T: (#b-before-a - #a-before-b) / (total + 2), b's onset preceding a's within W moments
 *   xcorr        lagged correlation of a series y (anomaly ml[3], or the symptom intensity max(0, zE, zL)):
 *                  max_k corr(y_b(t-k), y_a(t)) - max_k corr(y_a(t-k), y_b(t)),  k = 1..K   (the callee leads)
 *   granger      VAR(p) per pair on y, F-test of "b's past helps predict a" against "a's past helps predict b":
 *                  F = ((RSS_r - RSS_f) / p) / (RSS_f / (n - 2p - 1));   score = tanh((ln(1+F_ba) - ln(1+F_ab)) / 2)
 *                Transfer entropy equals Granger causality for Gaussian series (Barnett et al. 2009), so it is not
 *                computed separately.
 *   bytes        response bytes are larger than requests: r_x = ln((tx + 50) / (rx + 50)); score = tanh(r_b - r_a)
 *   instrumented a service with HTTP metrics calls one without (a store): share with error metrics, a minus b
 *   depth        BFS depth on the undirected observed graph from the entry (the service that talks to a node the
 *                collector does not watch, the load generator or outside clients): score = clamp(depth_b - depth_a)
 *
 * The learned direction combines them:  s = sum_m w_m s_m. A pair seen from one end only keeps the collector's view
 * (as in v1). Otherwise |s| < tau leaves the pair mutual (direction unknown).
 *
 * ONLINE: `observe` is called once per moment, in order; `direction` at moment i uses only moments 0..i.
 * PURE apart from that learned state. No service names are read.
 */
import type { TraceMoment, Trace } from '../core/trace.ts';
import { resolveDirections } from '../../server/algorithms/ml/mlEngine.ts';
import type { WalkEdge } from '../../server/algorithms/ml/randomWalk.ts';

export const METHODS = ['edges', 'up', 'down', 'implication', 'onset', 'xcorr-anomaly', 'xcorr-symptom', 'granger-anomaly', 'granger-symptom', 'bytes', 'instrumented', 'depth'] as const;
export type Method = (typeof METHODS)[number];

export interface DirectionParams {
  zUp: number; zDown: number;       // thresholds of the upward-symptom and traffic-drop indicators
  window: number;                   // readings in the robust baseline (median, MAD)
  lags: number;                     // K, the lags of the cross-correlation; p = min(lags, 2) for Granger
  onsetWindow: number;              // W, moments within which one onset can explain another
  prior: number;                    // pseudo-count pulling a conditional share towards the base rate
  weights: Partial<Record<Method, number>>;
  tau: number;                      // |combined score| under this leaves the pair mutual
  trustEdges: number;               // |edges score| at or above this decides the pair from the collector's view alone
}
export const DIRECTION_DEFAULTS: DirectionParams = {
  zUp: 3, zDown: 3, window: 120, lags: 3, onsetWindow: 6, prior: 4,
  weights: { depth: 1, implication: 1, down: 1, up: 2, instrumented: 2, 'granger-symptom': 0.5 }, tau: 0.05, trustEdges: 0.5,
};
/**
 * Weight presets, chosen by a grid search (weights 0, 0.5, 1, 2; tau 0.02 to 0.2) on tune.json + tune2.json only,
 * maximising right minus wrong directions on pairs seen from both ends, scored every 60 moments of every run.
 *   LEARNED   every useful method, the structural ones (depth, instrumented) included
 *   DYNAMIC   only what the time series do during trouble (no graph structure, no metric presence)
 */
export const PRESETS: Record<'learned' | 'dynamic', Partial<Record<Method, number>>> = {
  learned: DIRECTION_DEFAULTS.weights,
  dynamic: { implication: 1, down: 2, up: 1, 'granger-symptom': 0.5 },
};

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

/** Robust online baseline: median and MAD of the last `cap` accepted values. */
class Robust {
  private buf: number[] = [];
  constructor(private cap: number) {}
  z(x: number, floor: number): number {
    if (this.buf.length < 12) return 0;
    const s = [...this.buf].sort((p, q) => p - q), med = s[s.length >> 1];
    const dev = s.map((v) => Math.abs(v - med)).sort((p, q) => p - q), mad = dev[dev.length >> 1];
    return (x - med) / Math.max(1.4826 * mad, floor);
  }
  push(x: number) { this.buf.push(x); if (this.buf.length > this.cap) this.buf.shift(); }
}

/** Per-service online state. */
interface Svc {
  err: Robust; lat: Robust; req: Robust;
  n: number; nU: number; nD: number; nT: number; nS: number;
  withErr: number; tx: number; rx: number;
  prevT: boolean; lastOnset: number;
  hist: Record<'anomaly' | 'symptom', number[]>;   // the last lags+1 values, newest last
}

/** Sufficient statistics of two series for lagged correlation and a VAR(2) Granger test. */
class LagPair {
  n = 0;
  cross: number[][] = [];               // cross[0][k-1] = sum y_a(t-k) y_b(t);  cross[1][k-1] = sum y_b(t-k) y_a(t)
  sa = 0; sb = 0; saa = 0; sbb = 0;
  G: number[][] = Array.from({ length: 7 }, () => new Array(7).fill(0));   // Gram of [1, a1, a2, b1, b2, a, b]
  constructor(private K: number) { this.cross = [new Array(K).fill(0), new Array(K).fill(0)]; }
  add(ha: number[], hb: number[]) {   // histories, newest last, length K+1
    const a = ha[ha.length - 1], b = hb[hb.length - 1];
    this.n++; this.sa += a; this.sb += b; this.saa += a * a; this.sbb += b * b;
    for (let k = 1; k <= this.K; k++) { this.cross[0][k - 1] += ha[ha.length - 1 - k] * b; this.cross[1][k - 1] += hb[hb.length - 1 - k] * a; }
    const z = [1, ha[ha.length - 2], ha[ha.length - 3], hb[hb.length - 2], hb[hb.length - 3], a, b];
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) this.G[i][j] += z[i] * z[j];
  }
  /** max_k corr(b leads a) - max_k corr(a leads b): positive when b's changes come first. */
  xcorr(): number {
    if (this.n < 30) return 0;
    const ma = this.sa / this.n, mb = this.sb / this.n;
    const va = this.saa / this.n - ma * ma, vb = this.sbb / this.n - mb * mb;
    if (va < 1e-9 || vb < 1e-9) return 0;
    const c = (s: number) => (s / this.n - ma * mb) / Math.sqrt(va * vb);
    return clamp(Math.max(...this.cross[1].map(c)) - Math.max(...this.cross[0].map(c)));
  }
  private rss(X: number[], y: number): number {
    const m = X.length, A = X.map((i) => X.map((j) => this.G[i][j])), r = X.map((i) => this.G[i][y]);
    const tr = A.reduce((s, row, i) => s + row[i], 0);
    for (let i = 0; i < m; i++) A[i][i] += 1e-6 * (tr / m + 1);
    const beta = solve(A, [...r]);
    return Math.max(1e-12, this.G[y][y] - beta.reduce((s, b, i) => s + b * r[i], 0));
  }
  /** Granger: tanh((ln(1 + F[b -> a]) - ln(1 + F[a -> b])) / 2): positive when b's past predicts a. */
  granger(): number {
    const p = 2, dof = this.n - 2 * p - 1;
    if (this.n < 30) return 0;
    const F = (y: number, own: number[]) => { const rr = this.rss([0, ...own], y), rf = this.rss([0, 1, 2, 3, 4], y); return Math.max(0, ((rr - rf) / p) / (rf / dof)); };
    const fba = F(5, [1, 2]), fab = F(6, [3, 4]);
    return Math.tanh((Math.log1p(fba) - Math.log1p(fab)) / 2);
  }
}

/** Gaussian elimination with partial pivoting (small systems). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-15) continue;
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = Math.abs(A[r][r]) < 1e-15 ? 0 : s / A[r][r]; }
  return x;
}

/** Per-pair online statistics (a < b). */
interface Pair {
  a: string; b: string;
  nab: number; nba: number;                                   // collector views a->b, b->a
  both: number; sA: number; sB: number;                       // moments both observed; S_a, S_b counts
  uA_sB: number; uB_sA: number; dB_sA: number; dA_sB: number; // conditional counts
  tAB: number;                                                // T_a and T_b together
  aFirst: number; bFirst: number;                             // onset precedence
  lag: Record<'anomaly' | 'symptom', LagPair>;
}

export type PairScores = Record<Method, number>;

export class DirectionLearner {
  private svc = new Map<string, Svc>();
  private pairs = new Map<string, Pair>();
  private entries = new Set<string>();
  private t = 0;
  private depthCache: Map<string, number> | null = null;
  readonly p: DirectionParams;

  constructor(p: Partial<DirectionParams> = {}) { this.p = { ...DIRECTION_DEFAULTS, ...p, weights: { ...DIRECTION_DEFAULTS.weights, ...(p.weights ?? {}) } }; }

  private service(id: string): Svc {
    let s = this.svc.get(id);
    if (!s) {
      const K = this.p.lags + 1;
      s = { err: new Robust(this.p.window), lat: new Robust(this.p.window), req: new Robust(this.p.window), n: 0, nU: 0, nD: 0, nT: 0, nS: 0, withErr: 0, tx: 0, rx: 0,
        prevT: false, lastOnset: -Infinity, hist: { anomaly: new Array(K).fill(0), symptom: new Array(K).fill(0) } };
      this.svc.set(id, s);
    }
    return s;
  }

  /** Feed one moment (in time order). */
  observe(m: TraceMoment): void {
    this.t++;
    const ids = m.services, watched = new Set(ids);
    const U = new Map<string, boolean>(), D = new Map<string, boolean>(), S = new Map<string, boolean>(), T = new Map<string, boolean>(), onset = new Set<string>();
    for (const id of ids) {
      const s = this.service(id), x = m.metrics[id] ?? {}, ml = m.ml[id] ?? [0, 0, 0, 0, 0, 0];
      const hard = ml[4] === 1;
      const err = num(x.errorRate), lat = num(x.latencyP95 ?? x.latency), req = num(x.requestRate), rx = num(x.networkRxRate), tx = num(x.networkTxRate);
      let zE = 0, zL = 0, zR = 0;
      if (!hard) {
        if (err !== null) { zE = s.err.z(err, 0.02); s.err.push(err); }
        if (lat !== null) { const v = Math.log(lat + 1); zL = s.lat.z(v, 0.15); s.lat.push(v); }
        // traffic: request rate when the service reports requests, else received bytes
        const hasReq = s.withErr > 0.5 * Math.max(1, s.n) && req !== null;
        const tv = hasReq ? Math.log(req! + 0.1) : rx !== null ? Math.log(rx + 50) : null;
        if (tv !== null) { zR = s.req.z(tv, 0.15); s.req.push(tv); }
      }
      s.n++; if (err !== null) s.withErr++;
      if (tx !== null && rx !== null) { s.tx += tx; s.rx += rx; }
      const u = !hard && Math.max(zE, zL) >= this.p.zUp, d = !hard && zR <= -this.p.zDown, src = hard || ml[1] >= 1, tr = hard || u;
      U.set(id, u); D.set(id, d); S.set(id, src); T.set(id, tr);
      s.nU += +u; s.nD += +d; s.nS += +src; s.nT += +tr;
      if (tr && !s.prevT) { onset.add(id); }
      s.prevT = tr;
      const push = (h: number[], v: number) => { h.push(v); h.shift(); };
      push(s.hist.anomaly, ml[3]);
      push(s.hist.symptom, hard ? 3 : clamp(Math.max(0, zE, zL) / 3, 0, 3));
    }
    // edges: collector views, new pairs, the entry (a service connected to something the collector does not watch)
    for (const [f, t] of m.edges) {
      if (f === t) continue;
      if (watched.has(f) !== watched.has(t)) { const e = watched.has(f) ? f : t; if (!this.entries.has(e)) { this.entries.add(e); this.depthCache = null; } continue; }
      if (!watched.has(f)) continue;
      const k = key(f, t);
      let p = this.pairs.get(k);
      if (!p) {
        const [a, b] = f < t ? [f, t] : [t, f];
        p = { a, b, nab: 0, nba: 0, both: 0, sA: 0, sB: 0, uA_sB: 0, uB_sA: 0, dB_sA: 0, dA_sB: 0, tAB: 0, aFirst: 0, bFirst: 0, lag: { anomaly: new LagPair(this.p.lags), symptom: new LagPair(this.p.lags) } };
        this.pairs.set(k, p); this.depthCache = null;
      }
      if (f === p.a) p.nab++; else p.nba++;
    }
    // pair statistics, once per pair per moment
    for (const p of this.pairs.values()) {
      if (!watched.has(p.a) || !watched.has(p.b)) continue;
      const { a, b } = p;
      p.both++;
      if (S.get(a)) { p.sA++; if (U.get(b)) p.uB_sA++; if (D.get(b)) p.dB_sA++; }
      if (S.get(b)) { p.sB++; if (U.get(a)) p.uA_sB++; if (D.get(a)) p.dA_sB++; }
      if (T.get(a) && T.get(b)) p.tAB++;
      // onsets: whose trouble started first (same-moment onsets carry no order)
      const sa = this.svc.get(a)!, sb = this.svc.get(b)!, W = this.p.onsetWindow;
      if (onset.has(a) && !onset.has(b) && T.get(b) && this.t - sb.lastOnset <= W) p.bFirst++;
      if (onset.has(b) && !onset.has(a) && T.get(a) && this.t - sa.lastOnset <= W) p.aFirst++;
      for (const kind of ['anomaly', 'symptom'] as const) p.lag[kind].add(sa.hist[kind], sb.hist[kind]);
    }
    for (const id of onset) this.svc.get(id)!.lastOnset = this.t;
  }

  /** BFS depth from the entry services on the undirected observed graph. */
  private depth(): Map<string, number> {
    if (this.depthCache) return this.depthCache;
    const adj = new Map<string, string[]>();
    for (const p of this.pairs.values()) { (adj.get(p.a) ?? adj.set(p.a, []).get(p.a)!).push(p.b); (adj.get(p.b) ?? adj.set(p.b, []).get(p.b)!).push(p.a); }
    const d = new Map<string, number>(); let frontier = [...this.entries];
    frontier.forEach((e) => d.set(e, 0));
    while (frontier.length) { const next: string[] = []; for (const f of frontier) for (const g of adj.get(f) ?? []) if (!d.has(g)) { d.set(g, d.get(f)! + 1); next.push(g); } frontier = next; }
    return (this.depthCache = d);
  }

  /** Every method's score for one pair ("a calls b" positive, a < b). */
  scores(a: string, b: string): PairScores | null {
    const p = this.pairs.get(key(a, b));
    if (!p) return null;
    const A = this.svc.get(p.a)!, B = this.svc.get(p.b)!, m = this.p.prior;
    // lift(X | C) = P(X | C) - P(X), with the conditional share pulled towards the base rate by m pseudo-readings
    const lift = (k: number, n: number, nX: number, nAll: number) => { const base = nX / Math.max(1, nAll); return (k + m * base) / (n + m) - base; };
    const up = lift(p.uA_sB, p.sB, A.nU, A.n) - lift(p.uB_sA, p.sA, B.nU, B.n);
    const down = lift(p.dB_sA, p.sA, B.nD, B.n) - lift(p.dA_sB, p.sB, A.nD, A.n);
    const impl = A.nT + B.nT > 0 ? (p.tAB + 0.5) / (B.nT + 1) - (p.tAB + 0.5) / (A.nT + 1) : 0;
    const onset = (p.bFirst - p.aFirst) / (p.bFirst + p.aFirst + 2);
    const ratio = (s: Svc) => Math.log((s.tx / Math.max(1, s.n) + 50) / (s.rx / Math.max(1, s.n) + 50));
    const dep = this.depth(), da = dep.get(p.a), db = dep.get(p.b);
    const s: PairScores = {
      edges: (p.nab - p.nba) / Math.max(1, p.nab + p.nba),
      up: clamp(4 * up), down: clamp(4 * down), implication: clamp(impl), onset,
      'xcorr-anomaly': p.lag.anomaly.xcorr(), 'xcorr-symptom': p.lag.symptom.xcorr(),
      'granger-anomaly': p.lag.anomaly.granger(), 'granger-symptom': p.lag.symptom.granger(),
      bytes: Math.tanh(ratio(B) - ratio(A)),
      instrumented: A.withErr / Math.max(1, A.n) - B.withErr / Math.max(1, B.n),
      depth: da === undefined || db === undefined ? 0 : clamp(db - da),
    };
    if (a !== p.a) for (const k of METHODS) s[k] = -s[k];
    return s;
  }

  /** The combined learned score for "a calls b" (the collector's view is not part of it). */
  combined(a: string, b: string, weights = this.p.weights): number {
    const s = this.scores(a, b);
    if (!s) return 0;
    let v = 0;
    for (const [k, w] of Object.entries(weights)) v += (w ?? 0) * s[k as Method];
    return v;
  }

  /**
   * The direction of a pair now: +1 a calls b, -1 b calls a, 0 unknown. A pair seen (mostly) from one end keeps the
   * collector's view; otherwise the combined learned score decides when it is clear enough.
   */
  direction(a: string, b: string, weights = this.p.weights): number {
    const s = this.scores(a, b);
    if (!s) return 0;
    if (Math.abs(s.edges) >= this.p.trustEdges) return Math.sign(s.edges);
    const v = this.combined(a, b, weights);
    return Math.abs(v) < this.p.tau ? 0 : Math.sign(v);
  }

  /** Walk edges for the edges seen at a moment, with learned directions; an unknown pair stays mutual. */
  walkEdges(m: TraceMoment, weights = this.p.weights): WalkEdge[] {
    const watched = new Set(m.services), seen = new Set<string>(), out: WalkEdge[] = [];
    for (const [f, t] of m.edges) {
      if (f === t || !watched.has(f) || !watched.has(t)) continue;
      const k = key(f, t);
      if (seen.has(k)) continue;
      seen.add(k);
      const d = this.direction(f, t, weights);
      if (d > 0) out.push({ from: f, to: t, weight: 1 });
      else if (d < 0) out.push({ from: t, to: f, weight: 1 });
      else out.push({ from: f, to: t, weight: 1, mutual: true }, { from: t, to: f, weight: 1, mutual: true });
    }
    return out;
  }

  /** P(T_caller | T_callee), smoothed: how much of the callee's trouble its caller also showed (0.5 with no data). */
  feels(caller: string, callee: string): number {
    const p = this.pairs.get(key(caller, callee)), s = this.svc.get(callee);
    if (!p || !s) return 0.5;
    return (p.tAB + 0.5) / (s.nT + 1);
  }

  pairKeys(): string[] { return [...this.pairs.keys()]; }
}

// ------------------------------------------------------------------------------------------------ v1 and evaluation

/** v1's direction for a pair, from service names on the edges seen at a moment: +1 a calls b, -1 b calls a, 0 mutual. */
export function nameRuleDirections(m: TraceMoment): Map<string, number> {
  const watched = new Set(m.services);
  const edges = m.edges.filter(([f, t]) => watched.has(f) && watched.has(t)).map(([source, target]) => ({ source, target }));
  const walk = resolveDirections(edges, (id) => ({ id, name: id }));
  const out = new Map<string, number>();
  for (const e of walk) {
    const k = key(e.from, e.to), sign = e.from < e.to ? 1 : -1;
    if (e.mutual) { if (!out.has(k)) out.set(k, 0); continue; }
    const prev = out.get(k);
    out.set(k, prev === undefined || prev === 0 ? sign : prev === sign ? sign : 0);
  }
  return out;
}

/** The truth for an observed pair: +1 a calls b, -1 b calls a, 0 both ways (left out), null not a true call. */
export function truthOf(t: Trace, a: string, b: string): number | null {
  const tc = t.trueCalls ?? [];
  const ab = tc.some(([x, y]) => x === a && y === b), ba = tc.some(([x, y]) => x === b && y === a);
  return ab && ba ? 0 : ab ? 1 : ba ? -1 : null;
}

/**
 * Rename every service to s1..sn (a fixed shuffle), so no rule can read anything from names. Nodes the collector does
 * not watch (the load generator) are renamed too, to x1..xk.
 */
export function nameBlind(t: Trace, seed = 1): Trace {
  const ids = [...new Set(t.moments.flatMap((m) => m.services))].sort();
  let s = seed >>> 0; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const order = ids.map((id) => [rnd(), id] as const).sort((x, y) => x[0] - y[0]).map(([, id]) => id);
  const map = new Map(order.map((id, i) => [id, `s${i + 1}`]));
  let x = 0;
  const rn = (id: string) => { let v = map.get(id); if (!v) { v = `x${++x}`; map.set(id, v); } return v; };
  const rec = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [rn(k), v]));
  return {
    ...t, name: `${t.name}#blind`,
    trueCalls: t.trueCalls ? t.trueCalls.map(([a, b]) => [rn(a), rn(b)] as [string, string]) : null,
    faults: t.faults.map((f) => ({ ...f, target: rn(f.target), affected: f.affected.map(rn) })),
    moments: t.moments.map((m) => ({ ...m, services: m.services.map(rn), edges: m.edges.map(([a, b]) => [rn(a), rn(b)] as [string, string]),
      status: rec(m.status), metrics: rec(m.metrics), ml: rec(m.ml), rules: rec(m.rules), mlRanked: m.mlRanked.map(rn) })),
  };
}

export interface DirTally { right: number; wrong: number; unknown: number }
export const tally = (): DirTally => ({ right: 0, wrong: 0, unknown: 0 });
export const add = (x: DirTally, guess: number, truth: number) => { if (guess === 0) x.unknown++; else if (guess === truth) x.right++; else x.wrong++; };
