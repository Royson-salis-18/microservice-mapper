/**
 * Subspace model of the whole project (principal-component residuals, the classic multivariate process-monitoring chart).
 *
 * Idea. All the services of a project are driven by a few shared causes (the amount of traffic, the time of day). Collect one
 * vector per reading: every service's signals, each in "spreads from its own usual value". The readings of a healthy project
 * lie close to a low-dimensional subspace (the shared causes move everything together along it). A fault moves ONE service
 * (and its neighbours) off the subspace. So:
 *
 *   u(t)  = standardised readings of all services          (spreads from each service's slow reference)
 *   U     = the top k eigenvectors of the covariance of recent healthy u (k = 1 or 2: the "load directions")
 *   e(t)  = u(t) - U U' u(t)                               (what the shared causes cannot explain)
 *   z_sf  = e_sf / spread of that residual over the recent healthy window
 *   level of a service = its largest z (rising-only signals count upwards only) / zLine
 *
 * A change of workload moves u along U and leaves e unchanged; so it raises no alarm. Nothing is labelled, nothing is
 * installed on the target. PURE: readings in, levels out.
 */
import { median as med } from './stats.js';
import { F, type Level, type Forecast, type RoundInfo } from './loadModel.js';

const NAMES = ['cpu', 'memory', 'network in', 'network out', 'requests', 'errors', 'latency', 'throttling'];
const UPPER_ONLY = new Set<number>([F.cpu, F.memory, F.errors, F.latency, F.throttle]);
const OWN: number[] = [F.cpu, F.memory, F.throttle];

export interface PcaParams {
  components: number;
  window: number; slow: number; minTrain: number; refit: number;
  zLine: number; floors: number[]; oneSided: boolean;
  mildLevel: number; mildDriftAfter: number; driftAfter: number;
  forecastWindow: number; forecastHorizon: number; forecastR2: number;
}
export const PCA_DEFAULTS: PcaParams = {
  components: 1, window: 120, slow: 360, minTrain: 30, refit: 10, zLine: 4,
  floors: [0.2, 0.05, 0.3, 0.3, 0.3, 0.02, 0.2, 3], oneSided: true,
  mildLevel: 3, mildDriftAfter: 24, driftAfter: 360, forecastWindow: 24, forecastHorizon: 24, forecastR2: 0.6,
};
const NO_FORECAST: Forecast = { level: 0, feature: null, inSteps: null };

interface Svc { slow: (number | null)[][]; run: number; mild: number; recent: number[][] }

/** Top-k eigenvectors of a symmetric matrix by power iteration with deflation. */
function topEigen(C: number[][], k: number): number[][] {
  const d = C.length, vecs: number[][] = [];
  const M = C.map((r) => r.slice());
  for (let c = 0; c < k; c++) {
    let v = Array.from({ length: d }, (_, i) => 1 + ((i * 37 + c * 11) % 7) / 10);
    let norm = Math.hypot(...v); v = v.map((x) => x / norm);
    let lambda = 0;
    for (let it = 0; it < 60; it++) {
      const w = M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
      norm = Math.hypot(...w);
      if (norm < 1e-12) break;
      lambda = norm;
      const next = w.map((x) => x / norm);
      const diff = Math.hypot(...next.map((x, i) => x - v[i]));
      v = next;
      if (diff < 1e-7) break;
    }
    vecs.push(v);
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) M[i][j] -= lambda * v[i] * v[j];
  }
  return vecs;
}

export class PcaModel {
  private svc = new Map<string, Svc>();
  private hist: Map<string, number>[] = [];        // standardised healthy vectors: key "service|f" -> u
  private basis: { keys: string[]; U: number[][]; spread: Map<string, number> } | null = null;
  private sinceFit = 0;
  info: RoundInfo = { load: 0, loadServices: 0, shifted: false, slopes: [] };
  constructor(private readonly p: PcaParams = PCA_DEFAULTS) {}

  private state(id: string): Svc {
    let s = this.svc.get(id);
    if (!s) { s = { slow: [], run: 0, mild: 0, recent: [] }; this.svc.set(id, s); }
    return s;
  }

  private fit() {
    const p = this.p;
    const counts = new Map<string, number>();
    for (const row of this.hist) for (const k of row.keys()) counts.set(k, (counts.get(k) ?? 0) + 1);
    const keys = [...counts].filter(([, n]) => n >= this.hist.length * 0.5).map(([k]) => k).sort();
    if (keys.length < 2) { this.basis = null; return; }
    const X = this.hist.map((row) => keys.map((k) => row.get(k) ?? 0));
    const n = X.length;
    const mu = keys.map((_, j) => X.reduce((a, r) => a + r[j], 0) / n);
    const C = keys.map((_, a) => keys.map((__, b) => X.reduce((s, r) => s + (r[a] - mu[a]) * (r[b] - mu[b]), 0) / n));
    const U = topEigen(C, Math.min(p.components, keys.length - 1));
    // residual spread of every coordinate over the healthy window
    const resid = X.map((r) => this.residual(r, U, mu));
    const spread = new Map<string, number>();
    keys.forEach((k, j) => {
      const col = resid.map((r) => r[j]);
      const m = med(col), mad = 1.4826 * med(col.map((x) => Math.abs(x - m)));
      const s = [...col].sort((a, b) => a - b), q = (u: number) => s[Math.min(s.length - 1, Math.floor(u * (s.length - 1)))];
      spread.set(k, Math.max(mad, (q(0.9) - m) / 1.2816, (m - q(0.1)) / 1.2816, 0.35));
    });
    (this as any).mu = mu;
    this.basis = { keys, U, spread };
  }
  private residual(x: number[], U: number[][], mu: number[]): number[] {
    const c = x.map((v, j) => v - mu[j]);
    const r = c.slice();
    for (const u of U) { const g = c.reduce((s, v, j) => s + v * u[j], 0); for (let j = 0; j < r.length; j++) r[j] -= g * u[j]; }
    return r;
  }

  round(readings: Map<string, (number | null)[]>): Map<string, Level> {
    const p = this.p;
    // standardise each service's reading by its own slow reference
    const u = new Map<string, number>();
    const ready = new Set<string>();
    const shifts: number[] = [];
    for (const [id, x] of readings) {
      const s = this.state(id);
      if (s.slow.length < p.minTrain) continue;
      ready.add(id);
      for (let f = 0; f < NAMES.length; f++) {
        if (x[f] === null) continue;
        const col = s.slow.map((r) => r[f]).filter((v): v is number => v !== null);
        if (col.length < s.slow.length * 0.5) continue;
        const m = med(col);
        const mad = 1.4826 * med(col.map((v) => Math.abs(v - m)));
        const sorted = [...col].sort((a, b) => a - b), q = (z: number) => sorted[Math.min(sorted.length - 1, Math.floor(z * (sorted.length - 1)))];
        const spread = Math.max(mad, (q(0.9) - m) / 1.2816, (m - q(0.1)) / 1.2816, p.floors[f]);
        const v = ((x[f] as number) - m) / spread;
        u.set(`${id}|${f}`, v);
        if (f === F.netIn || f === F.netOut) shifts.push(v);
      }
    }
    const load = shifts.length >= 4 ? med(shifts) : 0;
    this.info = { load, loadServices: ready.size, shifted: Math.abs(load) >= 3, slopes: [] };

    const out = new Map<string, Level>();
    const b = this.basis;
    const mu: number[] | undefined = (this as any).mu;
    let resid: number[] | null = null;
    if (b && mu) resid = this.residual(b.keys.map((k) => u.get(k) ?? 0), b.U, mu);

    const levels = new Map<string, { level: number; own: number; symptom: number; score: number; top: Level['top'] }>();
    for (const id of readings.keys()) levels.set(id, { level: 0, own: 0, symptom: 0, score: 0, top: null });
    if (b && resid) {
      b.keys.forEach((k, j) => {
        if (!u.has(k)) return;
        const [id, fs] = [k.slice(0, k.lastIndexOf('|')), Number(k.slice(k.lastIndexOf('|') + 1))];
        const L = levels.get(id); if (!L || !ready.has(id)) return;
        let z = resid![j] / b.spread.get(k)!;
        if (p.oneSided && UPPER_ONLY.has(fs)) z = Math.max(0, z);
        z = Math.abs(z);
        const lv = z / p.zLine;
        if (lv > L.level) { L.level = lv; L.score = z; L.top = { feature: NAMES[fs], z }; }
        if (OWN.includes(fs)) L.own = Math.max(L.own, lv); else L.symptom = Math.max(L.symptom, lv);
      });
    }

    // gate: the healthy window takes the whole vector, with any service that is over its line set to its usual value
    let anyHot = false;
    for (const id of readings.keys()) {
      const s = this.state(id), L = levels.get(id)!, x = readings.get(id)!;
      const isReady = ready.has(id) && !!b;
      const normal = !isReady || L.level < 1;
      s.run = normal ? 0 : s.run + 1;
      s.mild = !normal && L.level < p.mildLevel ? s.mild + 1 : 0;
      const accepted = normal || s.run >= p.driftAfter || (p.mildDriftAfter > 0 && s.mild >= p.mildDriftAfter);
      if (!normal && !accepted) anyHot = true;
      s.slow.push(x); if (s.slow.length > p.slow) s.slow.shift();
      const zs = NAMES.map((_, f) => (b && u.has(`${id}|${f}`) ? Math.abs(Math.max(0, (resid?.[b.keys.indexOf(`${id}|${f}`)] ?? 0) / (b.spread.get(`${id}|${f}`) ?? 1))) : 0));
      s.recent.push(zs); if (s.recent.length > p.forecastWindow) s.recent.shift();
      out.set(id, { ready: isReady, level: L.level, own: L.own, symptom: L.symptom, score: L.score, accepted, forecast: isReady ? this.forecast(s) : NO_FORECAST, top: L.top });
    }
    const row = new Map<string, number>();
    for (const [k, v] of u) { const id = k.slice(0, k.lastIndexOf('|')); row.set(k, out.get(id)!.accepted ? v : 0); }
    if (row.size && !anyHot) { this.hist.push(row); if (this.hist.length > p.window) this.hist.shift(); this.sinceFit++; }
    if (this.hist.length >= p.minTrain && (!this.basis || this.sinceFit >= p.refit)) { this.fit(); this.sinceFit = 0; }
    return out;
  }

  private forecast(s: Svc): Forecast {
    const p = this.p;
    let best: Forecast = NO_FORECAST;
    for (const f of UPPER_ONLY) {
      const pts = s.recent.map((z, i) => [i, z[f]] as const);
      if (pts.length < Math.max(8, p.forecastWindow / 2)) continue;
      const n = pts.length, mx = pts.reduce((a, q) => a + q[0], 0) / n, my = pts.reduce((a, q) => a + q[1], 0) / n;
      const sxx = pts.reduce((a, q) => a + (q[0] - mx) ** 2, 0), sxy = pts.reduce((a, q) => a + (q[0] - mx) * (q[1] - my), 0), syy = pts.reduce((a, q) => a + (q[1] - my) ** 2, 0);
      if (sxx <= 0 || syy <= 0) continue;
      const bb = sxy / sxx, r2 = (sxy * sxy) / (sxx * syy);
      if (bb <= 0 || r2 < p.forecastR2) continue;
      const last = n - 1, level = (my + bb * (last + p.forecastHorizon - mx)) / p.zLine;
      const crossAt = (p.zLine - my) / bb + mx;
      if (level > best.level) best = { level, feature: NAMES[f], inSteps: Math.max(0, Math.round(crossAt - last)) };
    }
    return best;
  }

  forget() { this.svc.clear(); this.hist = []; this.basis = null; }
}
