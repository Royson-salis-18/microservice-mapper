import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';

/**
 * Cascading-failure prediction.
 *
 * Answers two questions the rest of the system could not:
 *
 *   1. Given what is failing right now, which services are likely to fail
 *      next, and through which dependency?
 *   2. If this one service failed, how far would it spread?
 *
 * ── The model ──────────────────────────────────────────────────────────────
 *
 * Every service gets an intrinsic failure probability p0 from what is measured
 * about it now (container state, resource pressure, the anomaly model). Risk
 * then flows along dependencies: a service that calls a failing service is
 * exposed in proportion to how much it depends on it (the edge weight).
 *
 * Combined with a noisy-OR — each independent route to failure has its own
 * chance, and the service fails if any of them does:
 *
 *   P(n) = 1 − (1 − p0(n)) × Π over callees c of (1 − τ · w(n→c) · P(c))
 *
 * τ, the transmission factor, is the fraction of a dependency's failure that
 * actually reaches its caller. It is below 1 because real services retry,
 * time out, cache and degrade gracefully — a dependency failing does not
 * always take its caller down with it.
 *
 * Solved by iterating to a fixed point, which handles cycles: P only ever
 * rises from p0 and is bounded by 1, so it converges.
 *
 * ── What this is and is not ────────────────────────────────────────────────
 *
 * These are estimates under a stated model with a stated parameter. They are
 * NOT observed frequencies: nothing here has been calibrated against records
 * of real cascades, because this system does not yet record whether a
 * predicted failure happened. Every output carries `model` and `transmission`
 * so a reader can see exactly what produced it. What it does guarantee is
 * that the ranking is driven only by measured state and measured traffic.
 */

export const DEFAULT_TRANSMISSION = 0.7;

/** Intrinsic probability contributed by container status. */
export const STATUS_PROBABILITY: Record<string, number> = {
  critical: 1.0,
  degraded: 0.5,
  healthy: 0,
  // No evidence either way. Treating "unknown" as partly failing would make
  // every never-yet-measured service a source of phantom cascades.
  unknown: 0,
};

/**
 * How much the ML ensemble's anomaly score contributes. Its scale puts a
 * detector's threshold at ~0.5 and twice that distance at 1.0 (ml/ensemble.py),
 * so a service at threshold that has stayed there adds 0.4, one far past it
 * adds up to 0.8. A single above-threshold window counts for much less: the
 * persistence requirement exists precisely because one sample is often noise.
 */
const ANOMALY_WEIGHT = 0.3;
const PERSISTENT_ANOMALY_WEIGHT = 0.8;

const MAX_ITERATIONS = 200;
/** Inherited risk worth showing a route for. Below this a "via" would name a
 *  dependency that barely matters. */
const MEANINGFUL_INHERITED = 0.15;
const TOLERANCE = 1e-6;

export type RiskBand = 'high' | 'elevated' | 'low' | 'minimal';

export interface NodeCascade {
  nodeId: string;
  nodeName: string;
  /** Total predicted probability of failure, 0..1. */
  probability: number;
  /** The part coming from this service's own measured state. */
  intrinsic: number;
  /** Probability of being brought down through dependencies alone. */
  inherited: number;
  band: RiskBand;
  /** The dependency contributing the most inherited risk, if any. */
  via: { nodeId: string; nodeName: string; contribution: number } | null;
  /** The chain from this service back to the origin of its risk. */
  path: string[];
  /** Hops from the origin of its risk; 0 when the risk is its own. */
  depth: number;
  /** Why p0 is what it is, in plain language. */
  intrinsicReasons: string[];
}

export interface CascadePrediction {
  project: string;
  generatedAt: string;
  model: 'noisy-or-propagation';
  transmission: number;
  iterations: number;
  converged: boolean;
  /** Expected number of failed services under the model. */
  expectedFailures: number;
  /** Services currently fine that the model expects to be pulled down. */
  atRisk: NodeCascade[];
  nodes: NodeCascade[];
}

export interface WhatIfResult {
  project: string;
  generatedAt: string;
  model: 'noisy-or-propagation';
  transmission: number;
  origin: { nodeId: string; nodeName: string };
  /** Expected number of *additional* failures caused by the origin failing. */
  expectedAdditionalFailures: number;
  affected: Array<NodeCascade & { baseline: number; delta: number }>;
}

export function bandFor(p: number): RiskBand {
  if (p >= 0.7) return 'high';
  if (p >= 0.4) return 'elevated';
  if (p >= 0.15) return 'low';
  return 'minimal';
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function intrinsicProbability(node: ServiceNode): { p: number; reasons: string[] } {
  const reasons: string[] = [];
  let survive = 1;

  const s = STATUS_PROBABILITY[node.status] ?? 0;
  if (s > 0) {
    survive *= 1 - s;
    const why = node.metadata?.statusReason ? ` (${node.metadata.statusReason})` : '';
    reasons.push(`status ${node.status}${why}`);
  }

  const a = node.analytics?.anomalyScore;
  if (typeof a === 'number' && Number.isFinite(a) && a > 0) {
    const w = node.analytics?.anomalyPersistent ? PERSISTENT_ANOMALY_WEIGHT : ANOMALY_WEIGHT;
    const contribution = Math.min(Math.max(a, 0), 1) * w;
    survive *= 1 - contribution;
    reasons.push(`anomaly score ${round3(a)}${node.analytics?.anomalyPersistent ? ' (persistent)' : ''}`);
  }

  return { p: 1 - survive, reasons };
}

interface Graph {
  nodes: ServiceNode[];
  /** Out-edges by caller, only those with a usable weight. */
  outBySource: Map<string, DependencyEdge[]>;
  nameById: Map<string, string>;
}

function buildGraph(nodes: ServiceNode[], edges: DependencyEdge[]): Graph {
  const ids = new Set(nodes.map(n => n.id));
  const outBySource = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    if (!e.weight || e.weight.value <= 0) continue;
    const list = outBySource.get(e.source);
    if (list) list.push(e);
    else outBySource.set(e.source, [e]);
  }
  return { nodes, outBySource, nameById: new Map(nodes.map(n => [n.id, n.name])) };
}

/**
 * Solve the model for a given set of intrinsic probabilities.
 */
function solve(graph: Graph, p0: Map<string, number>, tau: number) {
  let P = new Map(p0);
  let iterations = 0;
  let converged = false;

  for (; iterations < MAX_ITERATIONS; iterations++) {
    const next = new Map<string, number>();
    let maxDelta = 0;
    for (const n of graph.nodes) {
      let survive = 1 - (p0.get(n.id) ?? 0);
      for (const e of graph.outBySource.get(n.id) ?? []) {
        survive *= 1 - tau * e.weight!.value * (P.get(e.target) ?? 0);
      }
      const value = 1 - survive;
      next.set(n.id, value);
      maxDelta = Math.max(maxDelta, Math.abs(value - (P.get(n.id) ?? 0)));
    }
    P = next;
    if (maxDelta < TOLERANCE) {
      converged = true;
      iterations++;
      break;
    }
  }

  return { P, iterations, converged };
}

function describe(graph: Graph, P: Map<string, number>, p0: Map<string, number>, reasonsById: Map<string, string[]>, tau: number): NodeCascade[] {
  // Strongest single inherited route per node, used for "via" and the path.
  const bestVia = new Map<string, { target: string; contribution: number }>();
  const inheritedById = new Map<string, number>();

  for (const n of graph.nodes) {
    let survive = 1;
    let best: { target: string; contribution: number } | null = null;
    for (const e of graph.outBySource.get(n.id) ?? []) {
      const contribution = tau * e.weight!.value * (P.get(e.target) ?? 0);
      survive *= 1 - contribution;
      if (contribution > 0 && (!best || contribution > best.contribution)) {
        best = { target: e.target, contribution };
      }
    }
    inheritedById.set(n.id, 1 - survive);
    if (best) bestVia.set(n.id, best);
  }

  return graph.nodes.map(n => {
    const probability = P.get(n.id) ?? 0;
    const intrinsic = p0.get(n.id) ?? 0;
    const inherited = inheritedById.get(n.id) ?? 0;

    // Walk the strongest routes back to where the risk originates, stopping at
    // the first service whose risk does not meaningfully arrive from its own
    // dependencies. A degraded service can both have problems of its own and
    // be inheriting risk — orders degraded because its database died — and
    // both are worth showing, so the route is kept whenever the inherited part
    // is meaningful, not only when it is the larger part.
    const hasRoute = (id: string) => (inheritedById.get(id) ?? 0) >= MEANINGFUL_INHERITED || (inheritedById.get(id) ?? 0) > (p0.get(id) ?? 0);
    const path = [n.name];
    const seen = new Set([n.id]);
    let cur = n.id;
    while (hasRoute(cur)) {
      const via = bestVia.get(cur);
      if (!via || seen.has(via.target)) break;
      seen.add(via.target);
      path.push(graph.nameById.get(via.target) ?? via.target);
      cur = via.target;
    }

    const via = bestVia.get(n.id);
    const routed = hasRoute(n.id) && !!via;
    return {
      nodeId: n.id,
      nodeName: n.name,
      probability: round3(probability),
      intrinsic: round3(intrinsic),
      inherited: round3(inherited),
      band: bandFor(probability),
      via: routed
        ? { nodeId: via!.target, nodeName: graph.nameById.get(via!.target) ?? via!.target, contribution: round3(via!.contribution) }
        : null,
      path: routed ? path : [n.name],
      depth: routed ? path.length - 1 : 0,
      intrinsicReasons: reasonsById.get(n.id) ?? [],
    };
  });
}

/**
 * Predicted failure for every service in one project, from its current state.
 */
export function predictCascade(
  project: string,
  nodes: ServiceNode[],
  edges: DependencyEdge[],
  tau: number = DEFAULT_TRANSMISSION,
): CascadePrediction {
  const graph = buildGraph(nodes, edges);
  const p0 = new Map<string, number>();
  const reasonsById = new Map<string, string[]>();
  for (const n of nodes) {
    const { p, reasons } = intrinsicProbability(n);
    p0.set(n.id, p);
    reasonsById.set(n.id, reasons);
  }

  const { P, iterations, converged } = solve(graph, p0, tau);
  const described = describe(graph, P, p0, reasonsById, tau);

  // "At risk" means currently fine by its own measurements, but expected to be
  // pulled down through its dependencies — the services a cascade reaches next.
  const atRisk = described
    .filter(d => d.intrinsic < 0.15 && d.probability >= 0.15)
    .sort((a, b) => b.probability - a.probability || a.depth - b.depth);

  return {
    project,
    generatedAt: new Date().toISOString(),
    model: 'noisy-or-propagation',
    transmission: tau,
    iterations,
    converged,
    expectedFailures: round3(described.reduce((s, d) => s + d.probability, 0)),
    atRisk,
    nodes: described.sort((a, b) => b.probability - a.probability),
  };
}

/**
 * Structural criticality: the expected share of the project's traffic that
 * would be disrupted if each service failed on its own, starting from an
 * otherwise healthy system.
 *
 * This replaced an unweighted reachability measure that badly overstated it.
 * Reachability treated any chain of calls as total failure: a queue that only
 * shipping depends on reached the frontend through shipping → orders →
 * frontend, so the frontend counted as down and *all* of its traffic — to
 * services a queue outage never touches — counted as disrupted. Measured on a
 * simulated shop: 66% for the queue. Through the cascade model, a failure only
 * travels as far as the dependency weights carry it, which gives about 8%.
 *
 * Measured from a clean slate on purpose: this is a property of the service's
 * place in the graph, and should not swing because something else happens to
 * be failing right now. Current state is what riskScore adds on top.
 *
 * An edge's traffic counts as disrupted with the probability that either end
 * of it has failed: calls into a failed callee fail, and a failed caller stops
 * making calls.
 */
export function structuralCriticality(
  nodes: ServiceNode[],
  edges: DependencyEdge[],
  trafficOf: (e: DependencyEdge) => number,
  tau: number = DEFAULT_TRANSMISSION,
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const graph = buildGraph(nodes, edges);
  const ids = new Set(nodes.map(n => n.id));
  const counted = edges.filter(e => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const total = counted.reduce((s, e) => s + trafficOf(e), 0);

  for (const n of nodes) {
    if (total <= 0) {
      result.set(n.id, null);
      continue;
    }
    const p0 = new Map<string, number>(nodes.map(x => [x.id, x.id === n.id ? 1 : 0]));
    const { P } = solve(graph, p0, tau);
    let disrupted = 0;
    for (const e of counted) {
      const ps = P.get(e.source) ?? 0;
      const pt = P.get(e.target) ?? 0;
      disrupted += trafficOf(e) * (1 - (1 - ps) * (1 - pt));
    }
    result.set(n.id, Math.round(Math.min(disrupted / total, 1) * 100) / 100);
  }
  return result;
}

/**
 * What if `originId` failed outright? Everything else keeps its measured state.
 */
export function simulateFailure(
  project: string,
  originId: string,
  nodes: ServiceNode[],
  edges: DependencyEdge[],
  tau: number = DEFAULT_TRANSMISSION,
): WhatIfResult | null {
  const origin = nodes.find(n => n.id === originId);
  if (!origin) return null;

  const graph = buildGraph(nodes, edges);
  const p0 = new Map<string, number>();
  const reasonsById = new Map<string, string[]>();
  for (const n of nodes) {
    const { p, reasons } = intrinsicProbability(n);
    p0.set(n.id, p);
    reasonsById.set(n.id, reasons);
  }

  const baseline = solve(graph, p0, tau).P;

  const forced = new Map(p0);
  forced.set(originId, 1);
  reasonsById.set(originId, ['assumed failed for this simulation']);
  const { P } = solve(graph, forced, tau);
  const described = describe(graph, P, forced, reasonsById, tau);

  const affected = described
    .filter(d => d.nodeId !== originId)
    .map(d => ({ ...d, baseline: round3(baseline.get(d.nodeId) ?? 0), delta: round3(d.probability - (baseline.get(d.nodeId) ?? 0)) }))
    .filter(d => d.delta >= 0.005)
    .sort((a, b) => b.delta - a.delta || a.depth - b.depth);

  return {
    project,
    generatedAt: new Date().toISOString(),
    model: 'noisy-or-propagation',
    transmission: tau,
    origin: { nodeId: origin.id, nodeName: origin.name },
    expectedAdditionalFailures: round3(affected.reduce((s, d) => s + d.delta, 0)),
    affected,
  };
}
