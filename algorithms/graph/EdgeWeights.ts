import type { DependencyEdge, EdgeWeight } from '../../server/models/DependencyEdge.js';
import { isObservabilityService } from './serviceRoles.js';

/**
 * Edge weights: how much each service depends on each of its dependencies.
 *
 * An edge `A -> B` means A calls B. Its weight answers "if B fails, how badly
 * is A hit?", which is what root-cause scoring and cascade prediction both
 * need and what the raw graph could not say — every edge used to count the
 * same, so a service's rarely-used cache counted as much as the database that
 * serves all of its traffic.
 *
 * Two independent parts, multiplied:
 *
 *   dependency   how much of A's outbound work goes to B. Measured from
 *                request rates when every one of A's edges has them, else
 *                from socket activity, else — when A has no traffic figure at
 *                all — split evenly across its dependencies and labelled so.
 *
 *   confidence   how sure we are the dependency exists and points this way,
 *                from the evidence behind the edge. A link recovered from a
 *                listening port is near-certain; one a compose file merely
 *                declares, never seen carrying traffic, is a claim.
 *
 * Pure, so it can be tested without a store.
 */

export const CONFIDENCE = {
  listenPort: 1.0,
  httpLog: 1.0,
  ephemeralPort: 0.85,
  observedLegacy: 0.7,
  unresolvedDirection: 0.5,
  declaredOnly: 0.4,
  candidate: 0,
} as const;

/**
 * How much a telemetry edge counts, relative to a functional call.
 *
 * Exporting traces, metrics or logs is fire-and-forget: when the collector
 * dies, the service keeps serving. Weighted at face value these edges were
 * the heaviest in the graph — on the OpenTelemetry demo, nine services send
 * *all* their outbound traffic to otel-collector, so each weighed 1.00 on it
 * and a collector failure would have been predicted to take down the shop.
 * Not zero, because a blocked exporter can back up into a service; small,
 * because it usually doesn't.
 */
export const TELEMETRY_FACTOR = 0.1;

/** Monitoring traffic in either direction — exporting to, or being scraped or
 *  health-checked by, an observability component. */
export function isTelemetryEdge(edge: DependencyEdge): boolean {
  return isObservabilityService(edge.target) || isObservabilityService(edge.source);
}

/** Error rate at which an edge counts as fully stressed (matches the 5%
 *  threshold GraphStore uses to mark an edge failed). */
const STRESS_ERROR_RATE = 0.05;
/** Latency at which an edge counts as fully stressed, ms. */
const STRESS_LATENCY_MS = 1000;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function edgeConfidence(edge: DependencyEdge): { confidence: number; basis: string } {
  const ev = edge.evidenceSources ?? [];
  if (edge.observed) {
    if (ev.includes('http-log')) return { confidence: CONFIDENCE.httpLog, basis: 'seen in request logs' };
    if (ev.includes('direction:listen-port')) return { confidence: CONFIDENCE.listenPort, basis: 'observed; direction from listening port' };
    if (ev.includes('direction:ephemeral-port')) return { confidence: CONFIDENCE.ephemeralPort, basis: 'observed; direction from ephemeral port range' };
    if (ev.includes('direction:unresolved')) return { confidence: CONFIDENCE.unresolvedDirection, basis: 'observed, but direction could not be determined' };
    return { confidence: CONFIDENCE.observedLegacy, basis: 'observed (no direction evidence recorded)' };
  }
  if (edge.declared) return { confidence: CONFIDENCE.declaredOnly, basis: 'declared in config, never seen carrying traffic' };
  return { confidence: CONFIDENCE.candidate, basis: 'candidate only (shared network), not evidence of a dependency' };
}

function edgeStress(edge: DependencyEdge): number | null {
  const m = edge.metrics;
  if (!m) return null;
  const parts: number[] = [];
  if (typeof m.errorRate === 'number' && Number.isFinite(m.errorRate)) {
    parts.push(Math.min(Math.max(m.errorRate, 0) / STRESS_ERROR_RATE, 1));
  }
  const latency = m.p95Latency ?? m.latency;
  if (typeof latency === 'number' && Number.isFinite(latency)) {
    parts.push(Math.min(Math.max(latency, 0) / STRESS_LATENCY_MS, 1));
  }
  return parts.length > 0 ? round3(Math.max(...parts)) : null;
}

/**
 * Weights for every edge in one project's graph.
 *
 * Returned as a map rather than written onto the edges, so the caller decides
 * when to publish them and tests can inspect them without side effects.
 */
export function computeEdgeWeights(edges: DependencyEdge[]): Map<string, EdgeWeight> {
  const result = new Map<string, EdgeWeight>();

  const confidenceById = new Map<string, { confidence: number; basis: string }>();
  for (const e of edges) confidenceById.set(e.id, edgeConfidence(e));

  // Only edges that are evidence of a dependency take part in a caller's
  // share. Candidate edges (confidence 0) would otherwise dilute the real ones.
  // Shares are computed within a kind: functional calls against functional
  // calls, telemetry against telemetry. A service that sends 50/min of traces
  // and 10/min to its database depends on that database completely, not 17%.
  const groupKey = (e: DependencyEdge) => `${e.source}|${isTelemetryEdge(e) ? 't' : 'r'}`;
  const outBySource = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    if (confidenceById.get(e.id)!.confidence <= 0) continue;
    const key = groupKey(e);
    const list = outBySource.get(key);
    if (list) list.push(e);
    else outBySource.set(key, [e]);
  }

  const maxActivity = Math.max(0, ...edges.map(e => e.activity?.samplesPerMin ?? 0));
  // Dependency is measured on the slow baseline, not the instantaneous rate:
  // a link goes quiet exactly when its callee dies, and weighting on current
  // traffic would make a crashed dependency look less and less important the
  // longer it stays down. Falls back to the live rate before a baseline exists.
  const reference = (e: DependencyEdge) => e.activity?.baselinePerMin ?? e.activity?.samplesPerMin ?? 0;

  for (const e of edges) {
    const { confidence, basis } = confidenceById.get(e.id)!;
    const siblings = outBySource.get(groupKey(e)) ?? [];
    const telemetry = isTelemetryEdge(e);

    let dependency = 0;
    let dependencyBasis: EdgeWeight['dependencyBasis'] = 'uniform';

    if (confidence > 0 && siblings.length > 0) {
      const requestRates = siblings.map(s => s.metrics?.requestRate);
      const allHaveRequests = requestRates.every(r => typeof r === 'number' && Number.isFinite(r));
      const totalRequests = allHaveRequests ? (requestRates as number[]).reduce((a, b) => a + b, 0) : 0;
      const totalActivity = siblings.reduce((sum, s) => sum + reference(s), 0);

      // Shares always sum to exactly 1 across a caller's group. Edges with
      // no traffic figure (a declared dependency never seen in use) are given
      // an even slice each, 1/N; the measured edges split what is left in
      // proportion to their traffic. Weighting an unmeasured edge zero would
      // call it irrelevant, which nothing measured; giving it 1/N *on top of*
      // a full measured split (what this used to do) made a caller's shares
      // add up to as much as 183%.
      const measured = siblings.filter(s => reference(s) > 0);
      const unmeasuredCount = siblings.length - measured.length;
      const measuredPool = 1 - unmeasuredCount / siblings.length;

      if (allHaveRequests && totalRequests > 0) {
        dependency = (e.metrics!.requestRate as number) / totalRequests;
        dependencyBasis = 'requests';
      } else if (totalActivity > 0 && reference(e) > 0) {
        dependency = (reference(e) / totalActivity) * measuredPool;
        dependencyBasis = 'activity';
      } else {
        dependency = 1 / siblings.length;
        dependencyBasis = 'uniform';
      }
    }

    const activity = e.activity?.samplesPerMin;
    const factor = telemetry ? TELEMETRY_FACTOR : 1;
    result.set(e.id, {
      value: round3(Math.min(Math.max(confidence * dependency * factor, 0), 1)),
      dependency: round3(dependency),
      dependencyBasis,
      kind: telemetry ? 'telemetry' : 'request',
      volume: activity !== undefined && maxActivity > 0 ? round3(activity / maxActivity) : null,
      confidence,
      confidenceBasis: basis,
      stress: edgeStress(e),
    });
  }

  return result;
}
