#!/usr/bin/env node
// run/cli/ml/synth.ts: a synthetic fault bench, for tuning and stress-testing the engines on far more faults than the
// recorded runs hold. It writes runs in exactly the recorded format (ledger-<subject>.jsonl + observed-<subject>.jsonl),
// so every evaluation script reads them unchanged.
//
//   npm run ml:synth                         writes run/synthetic-runs/ (git-ignored), default 12 campaigns
//   npm run ml:synth -- --campaigns 24 --minutes 60 --seed 7 --out <dir>
//
// What is simulated, per 5-second reading:
//   - Every service has a quiet baseline (CPU, memory, network, request rate, error share, p95 latency) with noise. For the
//     two bench topologies the baselines are the medians measured in the recorded runs; other topologies are random.
//   - Traffic follows a slow wave plus bursts. A burst raises traffic everywhere at once: busy, not broken.
//   - Faults (crash, stop, pause, crash-loop, flap, memory leak, CPU brownout, slow network, partition) hit one service.
//     Their effects travel UP the call graph (callers see errors and slow calls) and DOWN it (callees see less traffic).
//   - Things that are not faults and are not labelled: noisy neighbours (a CPU spike on a healthy service), a deploy that
//     moves one service's memory level for good, missing readings. These are where false alarms come from.
//   - Some faults overlap (an incident during an incident), as in the real campaigns.
// The ledger holds the truth (root cause and the services that should be affected); the observed file holds only what a
// collector could see.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const CAMPAIGNS = Number(opt('campaigns', '12')), MINUTES = Number(opt('minutes', '60')), SEED = Number(opt('seed', '1'));
const AMPLIFY = Number(opt('amplify', '1'));            // callers feel a fault this many times more strongly (retry storms)
const ONLY = opt('classes', '').split(',').filter(Boolean);   // restrict to these fault classes, e.g. brownout,latency,memory
const OUT = path.resolve(opt('out', path.resolve(import.meta.dirname, '..', '..', 'synthetic-runs')));
const STEP = 5000;

// ---------------------------------------------------------------- random numbers
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
type R = () => number;
const gauss = (r: R) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
const pick = <T,>(r: R, xs: T[]) => xs[Math.floor(r() * xs.length)];
const between = (r: R, a: number, b: number) => a + (b - a) * r();

// ---------------------------------------------------------------- topologies
interface Svc { id: string; cpu: number; mem: number; net: number; req: number | null; lat: number | null; err: number; cpuSeen: number; noise: number }
interface Topo { subject: string; services: Svc[]; calls: [string, string][] }

const svc = (id: string, cpu: number, mem: number, net: number, req: number | null, lat: number | null, cpuSeen = 0.9): Svc => ({ id, cpu, mem, net, req, lat, err: 0, cpuSeen, noise: 0.15 });

/** The two bench systems, with baselines measured in run/recorded-runs/runC (medians over the whole run). */
const SHOPFLOW: Topo = {
  subject: 'synth-shopflow',
  services: [svc('api-gateway', 0.6, 7.6, 7627, 1.73, 7), svc('catalog', 0.8, 11.8, 7910, 1.51, 3), svc('cart', 0.5, 13.9, 335, 0.3, 5), svc('orders', 0.3, 8.4, 264, 0.08, 69),
    svc('inventory', 0.3, 21.6, 64, 0.05, 14, 0.4), svc('payments', 0.3, 10.5, 127, 0.05, 58, 0.4), svc('notifier', 0.2, 15.3, 509, null, null), svc('psp-sandbox', 0.3, 15.2, 63, 0.05, 54, 0.4),
    svc('catalog-db', 0.2, 4.7, 105, null, null), svc('orders-db', 0.2, 4.2, 40, null, null, 0.6), svc('catalog-cache', 0.5, 6.4, 547, null, null), svc('cart-store', 0.5, 4.7, 74, null, null), svc('event-bus', 0.4, 3.4, 316, null, null)],
  calls: [['api-gateway', 'catalog'], ['api-gateway', 'cart'], ['api-gateway', 'orders'], ['catalog', 'catalog-db'], ['catalog', 'catalog-cache'], ['cart', 'cart-store'], ['cart', 'catalog'],
    ['orders', 'orders-db'], ['orders', 'cart'], ['orders', 'inventory'], ['orders', 'payments'], ['orders', 'event-bus'], ['inventory', 'catalog-db'], ['payments', 'psp-sandbox'], ['notifier', 'event-bus'], ['notifier', 'orders']],
};
const LEDGERLINE: Topo = {
  subject: 'synth-ledgerline',
  services: [svc('edge', 0.4, 9.8, 1528, 1.96, 25), svc('transfers', 0.6, 19, 1616, 0.77, 30), svc('accounts', 0.6, 12.7, 1771, 2.54, 7), svc('fraud-screening', 0.3, 18.1, 536, 1.27, 2),
    svc('fx-rates', 0.2, 16.1, 192, 0.25, 2), svc('ledger', 0.4, 16.7, 673, 0.57, 10), svc('statements-worker', 0.3, 9.8, 10897, 0.49, 9), svc('fx-provider', 0.2, 20.3, 92, 0.14, 1, 0.35),
    svc('accounts-db', 0.2, 9.7, 666, null, null), svc('ledger-db', 0.3, 11.7, 1135, null, null), svc('state-store', 0.6, 3.6, 494, null, null), svc('event-bus', 0.4, 9.5, 430, null, null)],
  calls: [['edge', 'transfers'], ['edge', 'accounts'], ['transfers', 'accounts'], ['transfers', 'fraud-screening'], ['transfers', 'fx-rates'], ['transfers', 'ledger'], ['transfers', 'event-bus'], ['transfers', 'state-store'],
    ['accounts', 'accounts-db'], ['fraud-screening', 'state-store'], ['fx-rates', 'fx-provider'], ['ledger', 'ledger-db'], ['statements-worker', 'event-bus'], ['statements-worker', 'ledger-db'], ['statements-worker', 'accounts']],
};

/** A random system: one entry point, a layer or two of services, data stores and an external provider. */
function randomTopo(r: R, k: number): Topo {
  const mids = ['orders', 'billing', 'search', 'profile', 'shipping', 'pricing', 'auth', 'reviews', 'checkout', 'recommend'].sort(() => r() - 0.5).slice(0, 4 + Math.floor(r() * 4));
  const services: Svc[] = [svc('gateway', between(r, 0.2, 1), between(r, 5, 12), between(r, 1000, 8000), between(r, 1, 4), between(r, 5, 40))];
  const calls: [string, string][] = [];
  mids.forEach((m, i) => {
    services.push(svc(m, between(r, 0.1, 1.5), between(r, 6, 25), between(r, 60, 3000), between(r, 0.05, 2.5), between(r, 2, 80), r() < 0.3 ? 0.4 : 0.9));
    if (i < 2 || r() < 0.5) calls.push(['gateway', m]);
    else calls.push([mids[Math.floor(r() * i)], m]);
    if (i > 0 && r() < 0.35) { const callee = mids[Math.floor(r() * i)]; if (!calls.some(([a, b]) => a === m && b === callee) && !calls.some(([a, b]) => a === callee && b === m)) calls.push([m, callee]); }
  });
  const stores = mids.filter(() => r() < 0.6).map((m) => `${m}-db`);
  for (const s of stores) { services.push(svc(s, between(r, 0.1, 0.6), between(r, 3, 12), between(r, 40, 1200), null, null)); calls.push([s.replace(/-db$/, ''), s]); }
  services.push(svc('cache', between(r, 0.3, 0.6), between(r, 3, 7), between(r, 70, 600), null, null));
  for (const m of mids.filter(() => r() < 0.3)) calls.push([m, 'cache']);
  if (!calls.some(([, b]) => b === 'cache')) calls.push([mids[0], 'cache']);
  const ext = 'tax-provider'; services.push(svc(ext, 0.2, between(r, 10, 20), between(r, 50, 200), between(r, 0.05, 0.3), between(r, 20, 120), 0.4));
  calls.push([pick(r, mids), ext]);
  return { subject: `synth-random${k}`, services, calls };
}

// ---------------------------------------------------------------- faults
type FaultClass = 'crash' | 'stop' | 'pause' | 'crash-loop' | 'flap' | 'memory' | 'brownout' | 'latency' | 'partition';
const ALL_CLASSES: [FaultClass, number][] = [['crash', 2], ['stop', 1.5], ['pause', 1], ['crash-loop', 1], ['flap', 1], ['memory', 2], ['brownout', 2.5], ['latency', 2], ['partition', 1]];
const CLASSES: [FaultClass, number][] = ONLY.length ? ALL_CLASSES.filter(([c]) => ONLY.includes(c)) : ALL_CLASSES;
interface Fault { id: string; cls: FaultClass; target: string; a: number; b: number; sev: number; period: number; duty: number; oom: boolean; compoundOf?: string }

function weighted<T>(r: R, xs: [T, number][]): T { const t = xs.reduce((s, [, w]) => s + w, 0); let u = r() * t; for (const [x, w] of xs) { u -= w; if (u <= 0) return x; } return xs[0][0]; }
const callersOf = (t: Topo, id: string) => t.calls.filter(([, b]) => b === id).map(([a]) => a);
const calleesOf = (t: Topo, id: string) => t.calls.filter(([a]) => a === id).map(([, b]) => b);
/** Services upstream of id (they call it, directly or not), with their distance. */
function upstream(t: Topo, id: string): Map<string, number> {
  const d = new Map<string, number>(); let frontier = [id], k = 0;
  while (frontier.length) { k++; const next: string[] = []; for (const f of frontier) for (const c of callersOf(t, f)) if (!d.has(c) && c !== id) { d.set(c, k); next.push(c); } frontier = next; }
  return d;
}
const durationFor = (r: R, cls: FaultClass) => cls === 'crash' ? between(r, 18, 26) : cls === 'stop' ? between(r, 60, 420) : cls === 'pause' ? between(r, 30, 150) : cls === 'crash-loop' ? between(r, 50, 110)
  : cls === 'flap' ? between(r, 60, 120) : cls === 'memory' ? between(r, 120, 400) : between(r, 60, 240);

function plan(r: R, t: Topo, t0: number, minutes: number): Fault[] {
  const faults: Fault[] = []; let at = between(r, 400, 600); let n = 0;
  const end = minutes * 60 - 120;
  while (at < end) {
    const cls = weighted(r, CLASSES), target = pick(r, t.services).id;
    const dur = durationFor(r, cls);
    const f: Fault = { id: `f${String(++n).padStart(3, '0')}`, cls, target, a: t0 + at * 1000, b: t0 + (at + dur) * 1000, sev: between(r, 0.25, 0.9), period: between(r, 12, 20), duty: between(r, 0.2, 0.5), oom: r() < 0.3 };
    faults.push(f);
    if (r() < 0.3) {   // an incident during an incident: often a neighbour of the first
      const near = [...callersOf(t, target), ...calleesOf(t, target)];
      const c2 = weighted(r, CLASSES), tg2 = near.length && r() < 0.6 ? pick(r, near) : pick(r, t.services).id;
      if (tg2 !== target) { const s2 = at + between(r, 20, 60), d2 = durationFor(r, c2); faults.push({ id: `f${String(++n).padStart(3, '0')}`, cls: c2, target: tg2, a: t0 + s2 * 1000, b: t0 + (s2 + d2) * 1000, sev: between(r, 0.25, 0.9), period: between(r, 12, 20), duty: between(r, 0.2, 0.5), oom: r() < 0.3, compoundOf: f.id }); }
    }
    at += dur + between(r, 120, 300);
  }
  return faults.filter((f) => f.b < t0 + end * 1000);
}

// ---------------------------------------------------------------- one campaign
interface Effect { down: boolean; paused: boolean; detached: boolean; graceful: boolean; restarts: number; cpuMul: number; memAdd: number; thr: number; latMul: number; errAdd: number; reqMul: number; netMul: number }
const none = (): Effect => ({ down: false, paused: false, detached: false, graceful: false, restarts: 0, cpuMul: 1, memAdd: 0, thr: 0, latMul: 1, errAdd: 0, reqMul: 1, netMul: 1 });

function campaign(t: Topo, seed: number, minutes: number, t0: number) {
  const r = rng(seed);
  const faults = plan(r, t, t0, minutes);
  const steps = Math.floor((minutes * 60 * 1000) / STEP);
  // traffic: a slow wave plus bursts (busy, not broken)
  const bursts: [number, number, number][] = [];
  for (let s = 0; s < steps; s++) if (r() < 1 / 240) bursts.push([s, s + Math.floor(between(r, 6, 24)), between(r, 1.4, 2.4)]);
  // things that are not faults: noisy neighbours and a deploy that moves one memory level
  const noisy: [string, number, number, number][] = [];
  for (let s = 0; s < steps; s++) if (r() < 1 / 900) noisy.push([pick(r, t.services).id, s, s + Math.floor(between(r, 6, 18)), between(r, 2, 5)]);
  const deploy = { id: pick(r, t.services).id, at: Math.floor(between(r, 0.3, 0.8) * steps), shift: between(r, 3, 8) };
  const coupling = new Map(t.calls.map(([a, b]) => [`${a}>${b}`, between(r, 0.5, 1)]));
  const memDrift = new Map(t.services.map((s) => [s.id, 0]));
  const restartsTotal = new Map(t.services.map((s) => [s.id, 0]));
  // edges as a collector sees them: most pairs from both ends
  const edges: [string, string][] = [];
  for (const [a, b] of t.calls) { edges.push([a, b]); if (r() < 0.5) edges.push([b, a]); }
  if (t.services.some((s) => s.id === 'traffic') === false) { const entry = t.services[0].id; edges.push(['traffic', entry]); }

  const observed: string[] = [], ledger: string[] = [];
  ledger.push(JSON.stringify({ ts: t0, subject: t.subject, type: 'campaign-start', seed: `synth-${seed}`, horizonSec: minutes * 60, synthetic: true }));
  for (const f of faults) {
    const affected = [...upstream(t, f.target).keys()].sort();
    ledger.push(JSON.stringify({ ts: f.a, subject: t.subject, type: 'fault-start', id: f.id, class: f.cls, target: f.target, durationSec: Math.round((f.b - f.a) / 1000), severity: +f.sev.toFixed(2), source: f.compoundOf ? 'compound' : 'plan', compoundOf: f.compoundOf, truth: { rootCause: f.target, expectedAffected: affected }, startedAt: f.a }));
    ledger.push(JSON.stringify({ ts: f.b, subject: t.subject, type: 'fault-end', id: f.id, target: f.target, class: f.cls, appliedAt: f.a, healedAt: f.b, endedAt: f.b }));
  }

  for (let s = 0; s < steps; s++) {
    const ts = t0 + s * STEP;
    const wave = 1 + 0.25 * Math.sin((2 * Math.PI * s * STEP) / (30 * 60 * 1000) + seed);
    const burst = bursts.filter(([a, b]) => s >= a && s < b).reduce((m, [, , k]) => Math.max(m, k), 1);
    const traffic = wave * burst;
    const eff = new Map(t.services.map((x) => [x.id, none()]));
    for (const f of faults) {
      if (ts < f.a || ts > f.b) continue;
      const e = eff.get(f.target)!, into = (ts - f.a) / Math.max(1, f.b - f.a), ramp = Math.min(1, (ts - f.a) / 40000);
      let hard = false, slow = 1;
      switch (f.cls) {
        case 'crash': if (ts - f.a < 20000) { e.down = true; hard = true; } break;
        case 'stop': e.down = true; e.graceful = true; hard = true; break;
        case 'pause': e.paused = true; hard = true; break;
        case 'crash-loop': { const ph = ((ts - f.a) / 1000) % 12; if (ph < 4) { e.down = true; hard = true; } if (ph < 5 && ph >= 0) e.restarts = 1; break; }
        case 'flap': { const ph = (((ts - f.a) / 1000) % f.period) / f.period; if (ph < f.duty) { e.down = true; e.graceful = true; hard = true; } break; }
        case 'memory': e.memAdd += 55 * f.sev * into; e.cpuMul *= 1 + 0.6 * f.sev * into; slow = 1 + 1.5 * f.sev * into; if (f.oom && f.b - ts < 6000) { e.down = true; hard = true; e.restarts = 1; } break;
        case 'brownout': e.thr += 70 * f.sev * ramp; e.cpuMul *= 1 + 1.5 * f.sev * ramp; slow = 1 + 5 * f.sev * ramp; e.errAdd += 0.08 * f.sev * ramp; break;
        case 'latency': slow = 1 + 9 * f.sev * ramp; e.netMul *= 0.75; break;
        case 'partition': e.detached = true; hard = true; break;
      }
      e.latMul *= slow;
      // effects travel up the call graph (callers wait or fail) ...
      for (const [c, d] of upstream(t, f.target)) {
        const via = callersOf(t, f.target).includes(c) ? coupling.get(`${c}>${f.target}`) ?? 0.7 : 0.7;
        const k = via * Math.pow(0.65, d - 1) * AMPLIFY;
        const ce = eff.get(c)!;
        if (hard) { ce.errAdd += 0.55 * k; ce.latMul *= 1 + 1.5 * k; ce.cpuMul *= 1 - 0.15 * k; ce.netMul *= 1 - 0.3 * k; }
        else { ce.latMul *= 1 + (slow - 1) * 0.6 * k; ce.errAdd += (slow - 1) * 0.015 * k; }
      }
      // ... and down it (what the target used to call now sees less traffic)
      for (const c of calleesOf(t, f.target)) { const ce = eff.get(c)!; const k = hard ? 0.75 : (slow - 1) * 0.05; ce.reqMul *= Math.max(0.1, 1 - k); ce.netMul *= Math.max(0.2, 1 - 0.8 * k); ce.cpuMul *= Math.max(0.5, 1 - 0.3 * k); }
    }
    for (const [id, a, b, k] of noisy) if (s >= a && s < b) eff.get(id)!.cpuMul *= k;

    const status: Record<string, string> = { traffic: 'healthy' }, metrics: Record<string, any> = { traffic: { state: 'running', cpu: +(0.4 * traffic).toFixed(1), memoryPercent: 32, restartDelta: 0 } };
    for (const x of t.services) {
      const e = eff.get(x.id)!;
      const n = (sd = x.noise) => Math.exp(sd * gauss(r));
      if (x.id === deploy.id && s === deploy.at) memDrift.set(x.id, deploy.shift);
      const memBase = x.mem + memDrift.get(x.id)! + 0.6 * Math.sin(s / 37 + x.mem);
      if (e.restarts) restartsTotal.set(x.id, restartsTotal.get(x.id)! + 1);
      if (e.down || e.paused) {
        status[x.id] = 'critical';
        metrics[x.id] = { state: e.paused ? 'paused' : (e.restarts ? 'restarting' : 'exited'), exitCode: e.paused ? undefined : e.graceful ? 0 : 137, restartDelta: e.restarts, ...(e.paused ? { cpu: 0, memoryPercent: +memBase.toFixed(1), networkRxRate: 0, networkTxRate: 0, requestCount: 0, requestRate: 0 } : {}) };
        continue;
      }
      const busy = 0.5 + 0.5 * traffic;
      const m: Record<string, any> = { state: 'running', restartDelta: e.restarts };
      if (r() < x.cpuSeen) m.cpu = +Math.max(0, x.cpu * busy * e.cpuMul * n(0.35)).toFixed(1);
      m.memoryPercent = +Math.min(99, memBase * n(0.02) + e.memAdd).toFixed(1);
      const net = e.detached ? 0 : x.net * traffic * e.netMul * n(0.3);
      m.networkRxRate = Math.round(net); m.networkTxRate = Math.round(net * between(r, 0.7, 1.3));
      m.cpuOfAllowance = +(m.cpu ?? 0).toFixed(1);
      m.cpuThrottledPct = +Math.max(0, e.thr * n(0.2)).toFixed(1);
      if (e.detached) m.networkDetached = true;
      if (x.req !== null && x.lat !== null) {
        const rate = Math.max(0, x.req * traffic * e.reqMul * n(0.25));
        const count = Math.round(rate * 60);
        m.requestRate = +rate.toFixed(2); m.requestCount = count;
        if (count > 0) {
          const err = Math.min(1, Math.max(0, x.err + e.errAdd + (r() < 0.02 ? 0.05 : 0)) * (e.errAdd > 0 ? n(0.2) : 1));
          m.errorRate = +err.toFixed(2);
          const lat = x.lat * (1 + 0.15 * (traffic - 1)) * e.latMul * n(0.25);
          m.latency = +lat.toFixed(1); m.latencyP95 = Math.round(lat * between(r, 1.5, 2.2));
        }
      } else { m.requestRate = 0; m.requestCount = 0; }
      status[x.id] = e.detached || (m.errorRate ?? 0) > 0.3 ? 'critical' : (m.errorRate ?? 0) > 0.1 ? 'degraded' : 'healthy';
      metrics[x.id] = m;
    }
    observed.push(JSON.stringify({ ts, incidents: [], status, metrics, edges }));
  }
  return { ledger: ledger.join('\n') + '\n', observed: observed.join('\n') + '\n', faults: faults.length };
}

// ---------------------------------------------------------------- write
const master = rng(SEED);
const topos: Topo[] = [SHOPFLOW, LEDGERLINE];
const nRandom = Math.max(2, Math.ceil(CAMPAIGNS / 3));
for (let k = 0; k < nRandom; k++) topos.push(randomTopo(master, k + 1));
fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (let c = 0; c < CAMPAIGNS; c++) {
  const t = topos[c % topos.length];
  const dir = path.join(OUT, `c${String(c + 1).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = campaign(t, SEED * 1000 + c, MINUTES, 1_800_000_000_000 + c * 86_400_000);
  fs.writeFileSync(path.join(dir, `ledger-${t.subject}.jsonl`), out.ledger);
  fs.writeFileSync(path.join(dir, `observed-${t.subject}.jsonl`), out.observed);
  // the true call graph, for experiments that learn it from the data (never read by the engines)
  fs.writeFileSync(path.join(dir, `topology-${t.subject}.json`), JSON.stringify({ subject: t.subject, calls: t.calls }, null, 1));
  total += out.faults;
  console.log(`${path.relative(process.cwd(), dir)}  ${t.subject.padEnd(18)} ${t.services.length} services  ${out.faults} faults`);
}
console.log(`\n${CAMPAIGNS} campaigns, ${total} faults, ${MINUTES} min each -> ${path.relative(process.cwd(), OUT)}`);
