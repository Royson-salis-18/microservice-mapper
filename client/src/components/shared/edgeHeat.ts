import type { DependencyEdge } from '../../types';

export type EdgeHeat = 'idle' | 'calm' | 'busy' | 'heavy' | 'saturated' | 'degraded' | 'failed';

export interface EdgeAppearance {
  heat: EdgeHeat;
  /** Main line colour. */
  color: string;
  /** Brighter companion for glows and pulses. */
  glow: string;
  /** 0..1, drives opacity and thickness. */
  intensity: number;
  label: string;
  /** Why it has this colour, when it is trouble. */
  reason?: string;
}

/**
 * One heat scale shared by the 2D canvas and the 3D scene, so a link never
 * looks calm in one view and hot in the other.
 *
 * Driven by observed TCP connection activity, because that is the only
 * real per-edge measurement available — `edge.metrics` (latency, error
 * rate, request rate) is null on every edge in this deployment, so grading
 * by "load" in the HTTP sense would be inventing numbers. An explicit
 * failed/degraded status still wins over activity: a broken link matters
 * more than a busy one.
 *
 * Colour is the link's state: green carrying traffic normally (brighter and
 * thicker the busier it is), amber degraded, red failing, grey declared but
 * never seen. Volume alone never turns a link amber or red. (It used to run yellow to orange to red with
 * load, which made a healthy busy gateway look like an incident.)
 *
 * Thresholds are socket samples per minute, absolute rather than relative to
 * the busiest link, so a link's colour doesn't change meaning when an
 * unrelated service gets noisy.
 */
export interface EdgeContext {
  /** Health of the service being called. */
  targetStatus?: string;
}

/**
 * Where a link turns amber (slow or erroring) and red (severe). Shared with the
 * server (server/graph/linkThresholds.ts) so status and colour always agree.
 * Latency is the p95 when a source gives percentiles, the mean otherwise.
 */
export const LINK_THRESHOLDS = {
  slowMs: 300,
  verySlowMs: 1000,
  errorWarn: 0.01,
  errorCritical: 0.05,
} as const;

const RED = { color: '#ef5f67', glow: '#f58a90', intensity: 1 };
const AMBER = { color: '#e8a33d', glow: '#f0bd6a', intensity: 0.9 };

function ms(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

/**
 * Colour is the link's state. Red: failing (marked failed, 5%+ errors, p95 of a
 * second or more, or, with no request data, calling a service that is down).
 * Amber: slow or erroring short of that, or calling a degraded service. Measured
 * request data wins over the callee's status. Otherwise green, brighter and
 * thicker with volume; grey when declared but never seen carrying anything.
 */
export function edgeAppearance(edge: DependencyEdge | undefined, ctx: EdgeContext = {}): EdgeAppearance {
  const m = edge?.metrics as (DependencyEdge['metrics'] & { p95Latency?: number | null }) | null | undefined;
  const errorRate = m?.errorRate;
  const latency = m?.p95Latency ?? m?.latency;
  const measured = errorRate != null || latency != null;
  const observed = edge?.observed ?? false;

  if (edge?.status === 'failed') return { heat: 'failed', ...RED, label: 'failing', reason: 'marked failed' };
  if (errorRate != null && errorRate >= LINK_THRESHOLDS.errorCritical) {
    return { heat: 'failed', ...RED, label: 'failing', reason: `${(errorRate * 100).toFixed(1)}% of requests failing` };
  }
  if (latency != null && latency >= LINK_THRESHOLDS.verySlowMs) return { heat: 'failed', ...RED, label: 'very slow', reason: `latency ${ms(latency)}` };
  if (observed && !measured && ctx.targetStatus === 'critical') return { heat: 'failed', ...RED, label: 'failing', reason: 'calls a service that is down' };

  if (edge?.status === 'degraded') return { heat: 'degraded', ...AMBER, label: 'degraded', reason: 'marked degraded' };
  if (errorRate != null && errorRate >= LINK_THRESHOLDS.errorWarn) {
    return { heat: 'degraded', ...AMBER, label: 'erroring', reason: `${(errorRate * 100).toFixed(1)}% of requests failing` };
  }
  if (latency != null && latency >= LINK_THRESHOLDS.slowMs) return { heat: 'degraded', ...AMBER, label: 'slow', reason: `latency ${ms(latency)}` };
  if (observed && !measured && ctx.targetStatus === 'degraded') return { heat: 'degraded', ...AMBER, label: 'degraded', reason: 'calls a degraded service' };

  if (!observed) return { heat: 'idle', color: '#4a4f57', glow: '#5d636c', intensity: 0.55, label: 'declared, not observed' };

  const perMin = edge?.activity?.samplesPerMin;
  if (perMin === undefined) return { heat: 'calm', color: '#2f9e6f', glow: '#3ecf8e', intensity: 0.82, label: 'observed' };
  // Calibrated against the live spread across 47 measured links (median 112, p75 256, p90 1774, max 5571).
  if (perMin > 1200) return { heat: 'saturated', color: '#7fe8b8', glow: '#c2f5dc', intensity: 0.95, label: `${perMin}/min, very heavy` };
  if (perMin > 250) return { heat: 'heavy', color: '#4fdc9c', glow: '#9cefc6', intensity: 0.92, label: `${perMin}/min, heavy` };
  if (perMin > 60) return { heat: 'busy', color: '#3ecf8e', glow: '#7fe8b8', intensity: 0.86, label: `${perMin}/min, busy` };
  return { heat: 'calm', color: '#2f9e6f', glow: '#3ecf8e', intensity: 0.82, label: `${perMin}/min` };
}
