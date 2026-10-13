import type { DependencyEdge } from '../../types';

export interface LinkFlow {
  /**
   * Where the pulse rate comes from. `requests` when a request-level source
   * (access logs, Prometheus, traces) measured the link: then the pulses are
   * requests per second. Otherwise `activity`: the socket activity index,
   * which tracks how busy a link is but is not a count of anything, so it is
   * never labelled as requests or connections per second.
   */
  basis: 'requests' | 'activity';
  /** Requests per second when basis is `requests`; otherwise null. */
  requestsPerSecond: number | null;
  /** Pulses per second to draw along the link. */
  pulses: number;
}

/**
 * How fast the light moves along a link: pulses per second rise with the
 * link's rate, on a log scale so that a link doing 1 req/s and one doing
 * 500 req/s are both readable. 0.1/s ≈ 0.4 pulses/s, 2/s ≈ 1, 30/s ≈ 2.7,
 * 100/s ≈ 3.5, capped at 5.
 */
export function pulsesFor(perSecond: number): number {
  return Math.min(5, Math.max(0.25, 0.3 + 1.6 * Math.log10(1 + Math.max(0, perSecond))));
}

export function linkFlow(edge: DependencyEdge | undefined): LinkFlow | null {
  const req = edge?.metrics?.requestRate;
  if (req != null && req > 0) return { basis: 'requests', requestsPerSecond: req, pulses: pulsesFor(req) };
  const index = edge?.activity?.samplesPerMin;
  if (index != null && index > 0) return { basis: 'activity', requestsPerSecond: null, pulses: pulsesFor(index / 60) };
  return null;
}

function fmt(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/**
 * What the link is measured doing, in words with units that mean what they
 * say: "12.4 req/s" where requests are measured; otherwise its distinct
 * connections, "2 open · 8 new/min", counted once each however many socket
 * sweeps saw them.
 */
export function formatFlow(edge: DependencyEdge | undefined): string {
  const req = edge?.metrics?.requestRate;
  if (req != null && req > 0) return `${fmt(req)} req/s`;
  const a = edge?.activity;
  if (a?.openConnections != null && a.newConnectionsPerMin != null) {
    return `${fmt(a.openConnections)} open · ${fmt(a.newConnectionsPerMin)} new/min`;
  }
  if (a?.samplesPerMin != null) return 'connections being counted…';
  return 'no traffic measured';
}

/**
 * Pulse timing for an SVG path of roughly `length` pixels: how many pulses
 * to keep on it, and the duration of one trip, so that exactly `pulses`
 * arrive per second at a travel speed near `speed` px/s.
 */
export function svgPulses(pulses: number, length: number, speed = 110, max = 8): { count: number; dur: number } {
  const trip = Math.max(0.4, length / speed);
  const count = Math.min(max, Math.max(1, Math.round(pulses * trip)));
  return { count, dur: count / pulses };
}
