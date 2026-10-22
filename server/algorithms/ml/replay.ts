/**
 * Replay a recorded run through the ML engine, one moment at a time, using only the past (as the live server would).
 * Produces the same per-moment "how alarming / who is first" structure the rule-based scores use, so both are judged by
 * exactly the same event-level evaluation (server/algorithms/learning/evaluate.ts). PURE: text in, numbers out.
 */
import { MLEngine, ENGINE_DEFAULTS, type EngineParams, type EngineResult } from './mlEngine.ts';
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
  const top: Prepared['top'][number] = [];
  // max is scaled so 1 is the engine's alarm level, like the rule scores are scaled to their own line
  const alarm = params.alarmLevel ?? ENGINE_DEFAULTS.alarmLevel;
  replayEach(observedText, subject, params, (r, services) => top.push({ max: r.maxLevel / alarm, ranked: r.ranked, scores: services.map((id) => r.rank.get(id) ?? 0) }));
  return top;
}

/** The same replay, handing the full engine verdict of every moment to `each` (for the hybrid and prediction experiments). */
export function replayEach(observedText: string, subject: string, params: Partial<EngineParams>, each: (r: EngineResult, services: string[], snap: Snapshot) => void): void {
  const engine = new MLEngine({ ...ENGINE_DEFAULTS, ...params, baseline: { ...ENGINE_DEFAULTS.baseline, ...(params.baseline ?? {}) }, walk: { ...ENGINE_DEFAULTS.walk, ...(params.walk ?? {}) }, load: { ...ENGINE_DEFAULTS.load, ...(params.load ?? {}) }, pca: { ...ENGINE_DEFAULTS.pca, ...(params.pca ?? {}) } });
  const snaps: Snapshot[] = parseObserved(observedText).filter((s) => s.metrics && Object.keys(s.metrics).length);
  let edges: [string, string][] = [];
  for (const s of snaps) {
    if (s.edges?.length) edges = s.edges;
    const services = Object.keys(s.metrics!).filter((id) => id !== 'traffic').sort();
    const fresh = new Map<string, MetricSnapshot[]>();
    // Every recorded moment is one reading, as on the live server (the collector reports every cycle). An idle service
    // reports the same zeros again and again; dropping those repeats would hide the whole idle period from the model.
    for (const id of services) fresh.set(id, [toSnapshot(s.ts, s.metrics![id])]);
    const nodes = services.map((id) => ({ id, name: id, type: 'service', status: s.status[id] ?? 'unknown',
      metadata: { state: s.metrics![id].state ?? undefined, networkDetached: s.metrics![id].networkDetached === true, exitCode: s.metrics![id].exitCode, project: subject } }));
    const r = engine.step(nodes, edges.map(([source, target]) => ({ source, target })), fresh);
    each(r, services, s);
  }
}
