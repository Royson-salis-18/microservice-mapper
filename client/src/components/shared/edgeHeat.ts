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
 * Intensities are held 20% below full so links read as lighting rather
 * than glare.
 *
 * Thresholds are socket samples per minute, absolute rather than relative to
 * the busiest link, so a link's colour doesn't change meaning when an
 * unrelated service gets noisy.
 */
export function edgeAppearance(edge: DependencyEdge | undefined): EdgeAppearance {
  const errRate = edge?.metrics?.errorRate ?? 0;
  const latency = edge?.metrics?.latency ?? 0;

  if (edge?.status === 'failed' || errRate > 5) {
    return { heat: 'failed', color: '#ff1744', glow: '#ff5c7a', intensity: 0.8, label: 'failed' };
  }
  if (edge?.status === 'degraded' || latency > 500) {
    return { heat: 'degraded', color: '#ff8a00', glow: '#ffb457', intensity: 0.72, label: 'degraded' };
  }

  if (!edge?.observed) {
    // Declared by config, never seen carrying anything. Deliberately inert
    // grey so it recedes behind links that are actually doing work.
    return { heat: 'idle', color: '#5b6778', glow: '#7c8a9e', intensity: 0.34, label: 'declared, not observed' };
  }

  const perMin = edge.activity?.samplesPerMin;
  if (perMin === undefined) {
    // Seen at least once, but no rate measured yet.
    return { heat: 'calm', color: '#22e4ff', glow: '#7df3ff', intensity: 0.64, label: 'observed' };
  }

  // Calibrated against the live spread across 47 measured links
  // (median 112, p75 256, p90 1774, max 5571) so the four bands actually
  // separate traffic instead of painting almost everything red.
  if (perMin > 1200) return { heat: 'saturated', color: '#ff1744', glow: '#ff6b85', intensity: 0.8, label: `${perMin}/min — saturated` };
  if (perMin > 250) return { heat: 'heavy', color: '#ff8a00', glow: '#ffc06b', intensity: 0.76, label: `${perMin}/min — heavy` };
  if (perMin > 60) return { heat: 'busy', color: '#ffd400', glow: '#ffe873', intensity: 0.72, label: `${perMin}/min — busy` };
  return { heat: 'calm', color: '#22e4ff', glow: '#7df3ff', intensity: 0.64, label: `${perMin}/min` };
}
