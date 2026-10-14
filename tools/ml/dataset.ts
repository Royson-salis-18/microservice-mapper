// tools/ml/dataset.ts: turn one recorded run (the injector's ledger + what the mapper's API showed) into a labelled dataset.
// PURE: text in, rows out. Features are computed causally (each moment sees only the past), exactly as the live server would.
import { featureVectors, nodeSignals, FEATURE_NAMES } from '../../server/rca/features.ts';
import { parseLedger, parseObserved, type LedgerFault, type Snapshot } from '../eval/score.ts';
import type { MetricSnapshot } from '../../server/models/MetricSnapshot.ts';

export interface Moment {
  ts: number;
  services: string[];
  X: number[][];                 // one feature row per service, same order as `services`
  /** What the live rule-based mapper said at this moment (the baseline to beat). */
  live: { alarm: boolean; root: string | null; top3: string[] };
}
export interface Run { name: string; subject: string; faults: LedgerFault[]; moments: Moment[]; t0: number; t1: number }
export { FEATURE_NAMES };

const HISTORY = 120;            // samples kept per service (~15 min at the collector's pace), as the live detector's window

/** One reading as the server's MetricSnapshot, from what observe.ts recorded off the API. */
function toSnapshot(ts: number, m: Record<string, unknown>): MetricSnapshot {
  const n = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : undefined);
  return {
    timestamp: new Date(ts).toISOString(), cpu: n('cpu'), memoryPercent: n('memoryPercent'), networkRxRate: n('networkRxRate'), networkTxRate: n('networkTxRate'),
    cpuThrottledPct: n('cpuThrottledPct'), restartDelta: n('restartDelta'), requestCount: n('requestCount'), requestRate: n('requestRate'),
    errorRate: n('errorRate'), p95Latency: n('latencyP95'), latency: n('latency'),
  };
}

/** The observer polls faster than the collector reports, so the same reading appears several times: keep one per change. */
const key = (m: Record<string, unknown>) => JSON.stringify(m);

export function buildRun(name: string, subject: string, ledgerText: string, observedText: string): Run {
  const { faults } = parseLedger(ledgerText);
  const snaps: Snapshot[] = parseObserved(observedText).filter((s) => s.metrics && Object.keys(s.metrics).length);
  const hist = new Map<string, MetricSnapshot[]>(), last = new Map<string, string>();
  let edges: [string, string][] = [];
  const moments: Moment[] = [];
  for (const s of snaps) {
    if (s.edges?.length) edges = s.edges;
    const services = Object.keys(s.metrics!).filter((id) => id !== 'traffic').sort();
    for (const id of services) {
      const m = s.metrics![id], k = key(m);
      if (last.get(id) === k) continue;
      last.set(id, k);
      const h = hist.get(id) ?? []; h.push(toSnapshot(s.ts, m)); if (h.length > HISTORY) h.shift(); hist.set(id, h);
    }
    const nodes = services.map((id) => ({ id, name: id, project: subject, type: 'service', status: s.status[id] ?? 'unknown',
      metadata: { state: s.metrics![id].state ?? undefined, networkDetached: s.metrics![id].networkDetached === true, exitCode: s.metrics![id].exitCode } }) as any);
    const signals = nodes.map((n: any) => nodeSignals(n, hist.get(n.id) ?? []));
    const fv = featureVectors(signals, edges, (id) => id);
    const inc = s.incidents[0];
    moments.push({ ts: s.ts, services, X: services.map((id) => fv.get(id)!), live: { alarm: s.incidents.length > 0 && !inc?.monitoringGap, root: inc?.root ?? null, top3: (inc?.candidates ?? []).slice(0, 3) } });
  }
  return { name, subject, faults: faults.filter((f) => !f.failed), moments, t0: moments[0]?.ts ?? 0, t1: moments.at(-1)?.ts ?? 0 };
}

/**
 * Row labels. Positive: the service a fault is applied to, while it is applied. Rows in the minute after a fault ends are
 * left out (the service is recovering: neither clearly faulty nor clearly fine), and so is the warm-up while baselines form.
 */
export function labelledRows(run: Run, opts: { warmupSec?: number; recoverySec?: number; keep?: (ts: number) => boolean } = {}) {
  const warm = run.t0 + (opts.warmupSec ?? 300) * 1000, rec = (opts.recoverySec ?? 60) * 1000;
  const X: number[][] = [], y: number[] = [], ts: number[] = [];
  for (const m of run.moments) {
    if (m.ts < warm || (opts.keep && !opts.keep(m.ts))) continue;
    if (run.faults.some((f) => m.ts > f.b && m.ts <= f.b + rec)) continue;
    const active = run.faults.filter((f) => m.ts >= f.a && m.ts <= f.b);
    m.services.forEach((id, i) => { X.push(m.X[i]); y.push(active.some((f) => f.target === id) ? 1 : 0); ts.push(m.ts); });
  }
  return { X, y, ts };
}

/** The part of a run between two times, for blocked cross-validation (features keep their full causal past). */
export function slice(run: Run, from: number, to: number): Run {
  return { ...run, moments: run.moments.filter((m) => m.ts >= from && m.ts < to), faults: run.faults.filter((f) => f.a >= from && f.a < to) };
}
