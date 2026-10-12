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
 * Warm colours mean trouble and nothing else. Traffic volume is shown by
 * brightness and thickness on a cool neutral scale, so a merely busy link
 * never looks like a failing one. (It used to run yellow to orange to red with
 * load, which made a healthy busy gateway look like an incident.)
 *
 * Thresholds are socket samples per minute, absolute rather than relative to
 * the busiest link, so a link's colour doesn't change meaning when an
 * unrelated service gets noisy.
 */
export function edgeAppearance(edge: DependencyEdge | undefined): EdgeAppearance {
  const errRate = edge?.metrics?.errorRate ?? 0;
  const latency = edge?.metrics?.latency ?? 0;

  if (edge?.status === 'failed' || errRate > 5) {
    return { heat: 'failed', color: '#ef5f67', glow: '#f58a90', intensity: 0.95, label: 'failed' };
  }
  if (edge?.status === 'degraded' || latency > 500) {
    return { heat: 'degraded', color: '#e8a33d', glow: '#f0bd6a', intensity: 0.9, label: 'degraded' };
  }

  if (!edge?.observed) {
    // Declared by config, never seen carrying anything: recedes behind links doing work.
    return { heat: 'idle', color: '#4a4f57', glow: '#5d636c', intensity: 0.55, label: 'declared, not observed' };
  }

  const perMin = edge.activity?.samplesPerMin;
  if (perMin === undefined) {
    return { heat: 'calm', color: '#7d8590', glow: '#a9b0ba', intensity: 0.7, label: 'observed' };
  }

  // Calibrated against the live spread across 47 measured links (median 112, p75 256, p90 1774, max 5571).
  if (perMin > 1200) return { heat: 'saturated', color: '#c9dbff', glow: '#e6eeff', intensity: 0.95, label: `${perMin}/min, saturated` };
  if (perMin > 250) return { heat: 'heavy', color: '#8ab4ff', glow: '#b8d0ff', intensity: 0.88, label: `${perMin}/min, heavy` };
  if (perMin > 60) return { heat: 'busy', color: '#9aa3b0', glow: '#c3c9d2', intensity: 0.8, label: `${perMin}/min, busy` };
  return { heat: 'calm', color: '#7d8590', glow: '#a9b0ba', intensity: 0.7, label: `${perMin}/min` };
}
