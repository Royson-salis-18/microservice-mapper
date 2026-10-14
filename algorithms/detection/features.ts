/**
 * Features for "is this service the cause, right now?" - one vector per service per collection cycle. PURE.
 *
 * Shared by the offline learner (algorithms/learning) and the live server, so the model is trained on exactly what it later sees.
 *
 * Two layers, deliberately separate:
 *   1. Unsupervised normalisation, per series: every signal is compared with that service's OWN recent past using the
 *      robust z of AnomalyDetector.robustScore (median/MAD, log scale for positive quantities, one-sided, noise-shrunk).
 *      This needs no labels and makes a CPU jump on a busy API comparable to one on a quiet database.
 *   2. Supervised combination (algorithms/learning): HOW MUCH each normalised signal, container fact and neighbour signal counts,
 *      and where the alarm threshold sits, are learned from labelled fault runs - not written by hand.
 *
 * The constants below are measurement resolution (the smallest change worth noticing in each unit), not decision
 * thresholds: a 0.5% CPU step or a 2 kB/s network step is noise at the precision docker reports.
 */
import { robustScore, DETECTOR_PARAMS } from './AnomalyDetector.js';
import { containerFact } from './containerFacts.js';
import type { MetricSnapshot } from '../../server/models/MetricSnapshot.js';
import type { ServiceNode } from '../../server/models/ServiceNode.js';

interface Signal {
  name: string;
  pick: (h: MetricSnapshot) => number | null | undefined;
  direction: 1 | -1;
  scale: 'log' | 'lin';
  unit: number;
  floor: number;
  /** A percentile or an error share from a handful of requests is one request, not a rate: needs this many per window. */
  minRequests?: number;
  own: boolean;
}

const MIN_REQUESTS_FOR_A_RATE = DETECTOR_PARAMS.minRequests;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const net = (h: MetricSnapshot) => { const a = num(h.networkRxRate), b = num(h.networkTxRate); return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0); };

export const SIGNALS: Signal[] = [
  { name: 'cpu', pick: (h) => h.cpu, direction: 1, scale: 'log', unit: 0.5, floor: 0.15, own: true },
  { name: 'memory', pick: (h) => h.memoryPercent, direction: 1, scale: 'log', unit: 1, floor: 0.15, own: true },
  { name: 'throttle', pick: (h) => h.cpuThrottledPct, direction: 1, scale: 'lin', unit: 0, floor: 3, own: true },
  { name: 'netDrop', pick: net, direction: -1, scale: 'log', unit: 2000, floor: 0.15, own: false },
  { name: 'netRise', pick: net, direction: 1, scale: 'log', unit: 2000, floor: 0.15, own: false },
  { name: 'reqDrop', pick: (h) => h.requestRate, direction: -1, scale: 'log', unit: 0.1, floor: 0.15, own: false },
  { name: 'errRise', pick: (h) => h.errorRate, direction: 1, scale: 'lin', unit: 0, floor: 0.02, minRequests: MIN_REQUESTS_FOR_A_RATE, own: false },
  { name: 'latRise', pick: (h) => h.p95Latency ?? h.latency, direction: 1, scale: 'log', unit: 1, floor: 0.15, minRequests: MIN_REQUESTS_FOR_A_RATE, own: false },
];

/** Persistent deviation of one signal: the smaller z of the last two samples (both must agree), 0 when it cannot be told. */
export function signalZ(history: MetricSnapshot[], s: Signal, minHistory = 12): number {
  if (s.minRequests && history.slice(-2).some((h) => (num(h.requestCount) ?? Infinity) < s.minRequests!)) return 0;
  const series = history.map(s.pick).map(num).filter((v): v is number => v !== undefined);
  if (series.length < minHistory + 2) return 0;
  const r = robustScore(series.slice(0, -2), series.slice(-2), s, minHistory);
  if (!r) return 0;
  const z = Math.min(...r.z);
  return Number.isFinite(z) ? Math.max(0, z) : 0;
}

export interface NodeSignals {
  id: string;
  z: Record<string, number>;
  own: number;         // strongest evidence about the service itself
  sym: number;         // strongest evidence that can be inherited from a broken dependency
  down: number; paused: number; restarting: number; detached: number;
  hasRequests: number; noData: number;
}

/** Per-service signals from its own history and container state. */
export function nodeSignals(node: ServiceNode, history: MetricSnapshot[], minHistory = 12): NodeSignals {
  const z: Record<string, number> = {};
  for (const s of SIGNALS) z[s.name] = signalZ(history, s, minHistory);
  const fact = containerFact(node);
  const last2 = history.slice(-2);
  const restarting = fact === 'restarting' || last2.some((h) => (num(h.restartDelta) ?? 0) > 0) ? 1 : 0;
  return {
    id: node.id, z,
    own: Math.max(...SIGNALS.filter((s) => s.own).map((s) => z[s.name])),
    sym: Math.max(...SIGNALS.filter((s) => !s.own).map((s) => z[s.name])),
    down: fact === 'down' ? 1 : 0, paused: fact === 'paused' ? 1 : 0, restarting, detached: fact === 'detached' ? 1 : 0,
    hasRequests: history.some((h) => (num(h.requestCount) ?? 0) > 0) ? 1 : 0,
    noData: history.length === 0 || history.every((h) => num(h.cpu) === undefined && net(h) === undefined) ? 1 : 0,
  };
}

/** Datastores answer calls, they do not make them: an edge whose caller is a store is the reverse view of a TCP connection. */
const STORE = /(^|[-_])(db|store|cache|redis|memcached|mongo|mongodb|postgres|mysql|queue|bus|kafka|nats|rabbitmq)([-_]|$)/i;

export const FEATURE_NAMES = [
  'own', 'symptom', 'cpu', 'memory', 'throttle', 'netDrop', 'reqDrop', 'errRise', 'latRise',
  'down', 'paused', 'restarting', 'detached',
  'callersSymptomMax', 'callersSymptomMean', 'calleesEvidenceMax', 'hasRequests', 'noData',
] as const;

const lz = (v: number) => Math.log1p(Math.min(Math.max(v, 0), 50));

/**
 * Full feature vectors for every service of one target at one moment. Neighbour features say what the services that CALL
 * this one are suffering (victims point at their cause) and what the services it calls show (a broken dependency explains
 * this one's symptoms away).
 */
export function featureVectors(signals: NodeSignals[], edges: [string, string][], nameOf: (id: string) => string): Map<string, number[]> {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const callers = new Map<string, string[]>(), callees = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!byId.has(a) || !byId.has(b) || a === b) continue;
    if (STORE.test(nameOf(a)) && !STORE.test(nameOf(b))) continue;
    callers.set(b, [...(callers.get(b) ?? []), a]);
    callees.set(a, [...(callees.get(a) ?? []), b]);
  }
  const evidence = (s: NodeSignals) => Math.max(s.own, s.sym, 10 * Math.max(s.down, s.paused, s.restarting, s.detached));
  const out = new Map<string, number[]>();
  for (const s of signals) {
    const cs = (callers.get(s.id) ?? []).map((c) => byId.get(c)!.sym);
    const ds = (callees.get(s.id) ?? []).map((c) => evidence(byId.get(c)!));
    out.set(s.id, [
      lz(s.own), lz(s.sym), lz(s.z.cpu), lz(s.z.memory), lz(s.z.throttle), lz(s.z.netDrop), lz(s.z.reqDrop), lz(s.z.errRise), lz(s.z.latRise),
      s.down, s.paused, s.restarting, s.detached,
      lz(cs.length ? Math.max(...cs) : 0), lz(cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0), lz(ds.length ? Math.max(...ds) : 0),
      s.hasRequests, s.noData,
    ]);
  }
  return out;
}
