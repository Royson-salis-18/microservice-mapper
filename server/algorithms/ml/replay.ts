/**
 * Replay a recorded run through the ML engine, one moment at a time, using only the past (as the live server would).
 * Produces the same per-moment "how alarming / who is first" structure the rule-based scores use, so both are judged by
 * exactly the same event-level evaluation (server/algorithms/learning/evaluate.ts). PURE: text in, numbers out.
 */
import { MLEngine, ENGINE_DEFAULTS, type EngineParams } from './mlEngine.ts';
import { parseObserved, type Snapshot } from '../evaluation/score.ts';
import type { Prepared } from '../learning/evaluate.ts';
import type { MetricSnapshot } from '../../models/MetricSnapshot.ts';

function toSnapshot(ts: number, m: Record<string, unknown>): MetricSnapshot {
  const n = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : undefined);
  return {
    timestamp: new Date(ts).toISOString(), cpu: n('cpu'), memoryPercent: n('memoryPercent'), networkRxRate: n('networkRxRate'), networkTxRate: n('networkTxRate'),
    cpuThrottledPct: n('cpuThrottledPct'), restartDelta: n('restartDelta'), requestCount: n('requestCount'), requestRate: n('requestRate'),
    errorRate: n('errorRate'), p95Latency: n('latencyP95'), latency: n('latency'),
  };
}

/** One entry per recorded moment, aligned with buildRun() in learning/dataset.ts (same snapshot filter, same order). */
export function replayTop(observedText: string, subject: string, params: Partial<EngineParams> = {}): Prepared['top'][number] {
  const engine = new MLEngine({ ...ENGINE_DEFAULTS, ...params, baseline: { ...ENGINE_DEFAULTS.baseline, ...(params.baseline ?? {}) }, walk: { ...ENGINE_DEFAULTS.walk, ...(params.walk ?? {}) } });
  const snaps: Snapshot[] = parseObserved(observedText).filter((s) => s.metrics && Object.keys(s.metrics).length);
  const last = new Map<string, string>();
  let edges: [string, string][] = [];
  const top: Prepared['top'][number] = [];
  for (const s of snaps) {
    if (s.edges?.length) edges = s.edges;
    const services = Object.keys(s.metrics!).filter((id) => id !== 'traffic').sort();
    const fresh = new Map<string, MetricSnapshot[]>();
    for (const id of services) {
      const m = s.metrics![id], k = JSON.stringify(m);
      if (last.get(id) === k) continue;
      last.set(id, k);
      fresh.set(id, [toSnapshot(s.ts, m)]);
    }
    const nodes = services.map((id) => ({ id, name: id, type: 'service', status: s.status[id] ?? 'unknown',
      metadata: { state: s.metrics![id].state ?? undefined, networkDetached: s.metrics![id].networkDetached === true, exitCode: s.metrics![id].exitCode, project: subject } }));
    const r = engine.step(nodes, edges.map(([source, target]) => ({ source, target })), fresh);
    top.push({ max: r.maxLevel, ranked: r.ranked, scores: services.map((id) => r.rank.get(id) ?? 0) });
  }
  return top;
}
