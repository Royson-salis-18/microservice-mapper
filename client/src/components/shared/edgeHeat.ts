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
  /** Why the link is orange or red, in words; absent when it is neither. */
  reason?: string;
}

export interface EdgeContext {
  /** Status of the service being called. */
  targetStatus?: string;
}

/**
 * Where a link turns orange (slow or erroring) and red (severe).
 * Latency is the p95 when a source gives percentiles, the mean otherwise.
 */
export const LINK_THRESHOLDS = {
  slowMs: 300,
  verySlowMs: 1000,
  errorWarn: 0.01,
  errorCritical: 0.05,
} as const;

const RED = { color: '#ff3d5e', glow: '#ff7a90', intensity: 1 };
const ORANGE = { color: '#ff9a3c', glow: '#ffc78a', intensity: 0.95 };

function ms(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

/**
 * One scale shared by the 2D canvas, the 3D scene and the panels, so a link
 * never looks calm in one view and hot in another.
 *
 * Trouble outranks traffic. A link is red when it is failing (marked failed,
 * 5%+ errors, p95 of a second or more, or, when no request data covers it,
 * the service it calls is down) and orange when it is slow or erroring short
 * of that (300 ms+, 1%+ errors, or calling a degraded service). Measured
 * request data wins over the callee's status: a link carrying clean traffic
 * is not failing just because its callee was flagged.
 *
 * Otherwise colour is volume, from observed socket activity, on a cool ramp
 * (azure to ice cyan, brightening with volume). Warm colours mean trouble and nothing else.
 * Bright enough to read as live light on the dark scene; bloom stays off by
 * default, so these do not turn into glare.
 *
 * Volume thresholds are socket samples per minute, absolute rather than
 * relative to the busiest link, so a link's colour doesn't change meaning
 * when an unrelated service gets noisy.
 */
export function edgeAppearance(edge: DependencyEdge | undefined, ctx: EdgeContext = {}): EdgeAppearance {
  const m = edge?.metrics;
  const errorRate = m?.errorRate;
  const latency = m?.p95Latency ?? m?.latency;
  const measured = errorRate != null || latency != null;
  const observed = edge?.observed ?? false;

  // --- red: failing -----------------------------------------------------
  if (edge?.status === 'failed') return { heat: 'failed', ...RED, label: 'failing', reason: 'marked failed' };
  if (errorRate != null && errorRate >= LINK_THRESHOLDS.errorCritical) {
    return { heat: 'failed', ...RED, label: 'failing', reason: `${(errorRate * 100).toFixed(1)}% of requests failing` };
  }
  if (latency != null && latency >= LINK_THRESHOLDS.verySlowMs) {
    return { heat: 'failed', ...RED, label: 'very slow', reason: `latency ${ms(latency)}` };
  }
  if (observed && !measured && ctx.targetStatus === 'critical') {
    return { heat: 'failed', ...RED, label: 'failing', reason: 'calls a service that is down' };
  }

  // --- orange: slow or erroring ------------------------------------------
  if (edge?.status === 'degraded') return { heat: 'degraded', ...ORANGE, label: 'degraded', reason: 'marked degraded' };
  if (errorRate != null && errorRate >= LINK_THRESHOLDS.errorWarn) {
    return { heat: 'degraded', ...ORANGE, label: 'erroring', reason: `${(errorRate * 100).toFixed(1)}% of requests failing` };
  }
  if (latency != null && latency >= LINK_THRESHOLDS.slowMs) {
    return { heat: 'degraded', ...ORANGE, label: 'slow', reason: `latency ${ms(latency)}` };
  }
  if (observed && !measured && ctx.targetStatus === 'degraded') {
    return { heat: 'degraded', ...ORANGE, label: 'degraded', reason: 'calls a degraded service' };
  }

  // --- volume ---------------------------------------------------------------
  if (!observed) {
    // Declared by config, never seen carrying anything: recedes behind links
    // that are doing work.
    return { heat: 'idle', color: '#5b6aa0', glow: '#8290c6', intensity: 0.5, label: 'declared, not observed' };
  }

  const perMin = edge?.activity?.samplesPerMin;
  if (perMin === undefined) {
    // Seen at least once, but no rate measured yet.
    return { heat: 'calm', color: '#4f7dff', glow: '#8fabff', intensity: 0.85, label: 'observed' };
  }

  // Calibrated against the live spread across 47 measured links
  // (median 112, p75 256, p90 1774, max 5571) so the bands separate traffic
  // instead of lumping almost everything into the top one.
  if (perMin > 1200) return { heat: 'saturated', color: '#9cf4ff', glow: '#d6fbff', intensity: 1, label: `${perMin}/min, very heavy` };
  if (perMin > 250) return { heat: 'heavy', color: '#1fd1ff', glow: '#86e8ff', intensity: 0.95, label: `${perMin}/min, heavy` };
  if (perMin > 60) return { heat: 'busy', color: '#2f9bff', glow: '#80c4ff', intensity: 0.9, label: `${perMin}/min, busy` };
  return { heat: 'calm', color: '#4f7dff', glow: '#8fabff', intensity: 0.85, label: `${perMin}/min` };
}
