import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { Incident, ScoreContribution } from '../models/Incident.js';
import type { GraphStore } from './GraphStore.js';
import { computeEdgeWeights } from './EdgeWeights.js';
import { predictCascade, simulateFailure, structuralCriticality, type CascadePrediction, type WhatIfResult } from './CascadeEngine.js';

/**
 * Current reliability exposure per service, recomputed every poll cycle.
 *
 * Everything the rest of the app does is backward-looking: RCAEngine only
 * speaks once a service is already critical or degraded. This scores services
 * that are still fine but structurally exposed — how much of the system's
 * live traffic is sitting behind them — and, through the cascade model,
 * which of them are likely to be pulled down next.
 *
 * Each cycle, per project:
 *   1. edge weights     how strongly each caller depends on each callee
 *   2. health and risk  current exposure, with a visible factor breakdown
 *   3. cascade model    predicted failure probability, written to
 *                       `failureProbability` / `affectedProbability`
 *
 * Every number traces back to a collected signal through arithmetic a person
 * can redo by hand. The cascade probabilities are estimates under a stated
 * model (see CascadeEngine.ts) rather than observed frequencies, and they
 * carry the model name and its parameter so that is never hidden.
 *
 * Edge direction is "source calls target": the collector recovers it from
 * listening ports (orientConnection in MetricCollector.ts), so failure travels
 * against the arrow — from a callee to the services that call it.
 */

export interface NodeRisk {
  healthScore: number;
  riskScore: number;
  criticality: number | null;
  centrality: number | null;
  upstreamCount: number;
  downstreamCount: number;
  healthBreakdown: ScoreContribution[];
}

export interface BlastRadiusEntry {
  nodeId: string;
  nodeName: string;
  /** Hops back up the dependency chain from the failing node. 1 = calls it directly. */
  hopDistance: number;
  /** Total activity on this node's own outbound calls. Null when none of them
   *  carry activity data — unmeasured, not idle. */
  outboundSamplesPerMin: number | null;
  /** How much of what this node depends on sits inside the blast radius.
   *  1 = everything it calls is down; 0.25 = it has other paths still up.
   *  Null when its outbound traffic is unmeasured. */
  shareOfItsDependencies: number | null;
}

export interface BlastRadiusResult {
  nodeId: string;
  nodeName: string;
  project: string;
  generatedAt: string;
  /** Names the evidence this was built from, so the UI never has to guess. */
  basis: 'observed-edges';
  totalReachable: number;
  affected: BlastRadiusEntry[];
}

export const HEALTH_WEIGHTS = { status: 0.6, anomaly: 0.25, incident: 0.15 } as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A link's normal traffic level — the slow baseline, so a link that went
 *  silent because its callee died still counts for what it usually carries. */
function activityOf(edge: DependencyEdge): number {
  return edge.activity?.baselinePerMin ?? edge.activity?.samplesPerMin ?? 0;
}

/** Edges belong to the project of whichever endpoint we can resolve. Edge ids
 *  are `source->target` over `project:service` node ids, so an edge whose
 *  endpoints were pruned resolves to neither and is skipped. */
function projectOfEdge(edge: DependencyEdge, projectByNodeId: Map<string, string>): string | undefined {
  return projectByNodeId.get(edge.source) ?? projectByNodeId.get(edge.target);
}

/**
 * Everything that would be hit if `startId` failed, with hop distance.
 *
 * An edge means "source calls target", so the caller depends on the callee
 * and failure travels *against* the arrow: if a database dies, the services
 * calling it break, then whatever calls those. So this walks in-edges
 * (target -> source), not out-edges.
 *
 * Walking out-edges instead — which is what this did originally — answers
 * "what does X call", which is close to the opposite question and puts
 * databases at the far end of a blast radius they should be at the origin of.
 *
 * The visited set keeps a genuine dependency cycle from looping forever or
 * counting one service's traffic twice.
 */
function reachDependents(
  startId: string,
  edges: DependencyEdge[],
): { nodes: Map<string, number>; edgeIds: Set<string> } {
  const inByTarget = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    const list = inByTarget.get(e.target);
    if (list) list.push(e);
    else inByTarget.set(e.target, [e]);
  }

  const nodes = new Map<string, number>();
  const edgeIds = new Set<string>();
  let frontier = [startId];
  const seen = new Set<string>([startId]);
  let hop = 0;

  while (frontier.length > 0) {
    hop += 1;
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of inByTarget.get(current) ?? []) {
        edgeIds.add(edge.id);
        if (seen.has(edge.source)) continue;
        seen.add(edge.source);
        nodes.set(edge.source, hop);
        next.push(edge.source);
      }
    }
    frontier = next;
  }

  return { nodes, edgeIds };
}

/**
 * How much of `nodeId`'s own outbound dependency traffic runs into
 * `failingSet`. 1 means everything it depends on is inside the blast radius;
 * 0.25 means it has three other paths still standing.
 *
 * Null when none of its out-edges carry activity data — unmeasured is not the
 * same claim as unaffected.
 */
function shareOfDependenciesInSet(
  nodeId: string,
  failingSet: Set<string>,
  edges: DependencyEdge[],
): { share: number | null; outboundSamplesPerMin: number | null } {
  const out = edges.filter(e => e.source === nodeId);
  const measured = out.filter(e => e.activity !== undefined);
  if (measured.length === 0) return { share: null, outboundSamplesPerMin: null };

  const total = measured.reduce((sum, e) => sum + activityOf(e), 0);
  if (total <= 0) return { share: null, outboundSamplesPerMin: round2(total) };

  const intoFailing = measured
    .filter(e => failingSet.has(e.target))
    .reduce((sum, e) => sum + activityOf(e), 0);

  return { share: round2(intoFailing / total), outboundSamplesPerMin: round2(total) };
}

/**
 * Health from the signals that already exist, weighted and renormalised.
 *
 * A factor with no data is dropped rather than defaulted, and the remaining
 * weights are renormalised so the breakdown always sums to exactly the score.
 * Defaulting a missing anomaly score to some middle value would invent an
 * opinion the models never expressed.
 */
function computeHealth(node: ServiceNode, incidents: Incident[]): { score: number; breakdown: ScoreContribution[] } {
  const parts: { factor: string; weight: number; value: number; reason: string }[] = [];

  // 'unknown' (never measured, or a job that finished) is no evidence either way, so it is left out and the other factors
  // are renormalised. Scoring it 0.5 made every service without data look half broken and pushed it up the risk ranking.
  if (node.status !== 'unknown') {
    const statusValue = node.status === 'healthy' ? 1 : node.status === 'degraded' ? 0.5 : 0;
    parts.push({
      factor: 'status',
      weight: HEALTH_WEIGHTS.status,
      value: statusValue,
      reason: `container status is ${node.status}`,
    });
  }

  const anomaly = node.analytics?.anomalyScore;
  if (typeof anomaly === 'number' && Number.isFinite(anomaly)) {
    const clamped = Math.min(Math.max(anomaly, 0), 1);
    parts.push({
      factor: 'anomaly',
      weight: HEALTH_WEIGHTS.anomaly,
      value: 1 - clamped,
      reason: `model anomaly score ${round2(clamped)}${node.analytics?.anomalyPersistent ? ', persistent' : ''}`,
    });
  }

  // Both fields hold full node ids. affectedServices used to hold bare names
  // while rootCauseServiceId held an id, and matching one kind against the
  // other silently never matched; names are still accepted so an incident
  // recorded before the change keeps counting.
  // RESOLVED incidents are excluded because IncidentManager keeps them in its
  // map forever — it flips status rather than deleting, so an unfiltered read
  // would hold a service down long after it recovered.
  const live = incidents.filter(i => i.status !== 'RESOLVED');
  const isRootCause = live.some(i => i.rootCauseServiceId === node.id);
  const isAffected = live.some(i => i.affectedServices.includes(node.id) || i.affectedServices.includes(node.name));
  const incidentValue = isRootCause ? 0 : isAffected ? 0.3 : 1;
  parts.push({
    factor: 'incident',
    weight: HEALTH_WEIGHTS.incident,
    value: incidentValue,
    reason: isRootCause
      ? 'named as the root cause of an open incident'
      : isAffected
        ? 'listed among the affected services of an open incident'
        : 'not part of any open incident',
  });

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const breakdown = parts.map(p => ({
    factor: p.factor,
    score: round2((p.value * p.weight) / totalWeight),
    reason: p.reason,
  }));
  // Built from the already-rounded breakdown, not rounded independently from
  // the raw sum — summing two things separately rounded is how "the
  // breakdown adds up to the total" quietly stops being true.
  const score = round2(breakdown.reduce((sum, b) => sum + b.score, 0));

  return { score, breakdown };
}

/**
 * Risk for every node of one project.
 *
 * Pure on purpose: it takes plain arrays rather than a GraphStore, so the
 * arithmetic can be tested against fixtures without booting a store (whose
 * constructor loads from disk and starts a timer).
 *
 * Scoped per project because degree and traffic share are only meaningful
 * within one stack — ranking a sock-shop service against a death-star one
 * would compare two unrelated systems.
 */
export function computeProjectRisk(
  nodes: ServiceNode[],
  edges: DependencyEdge[],
  incidents: Incident[],
): Map<string, NodeRisk> {
  const observed = edges.filter(e => e.observed);
  const result = new Map<string, NodeRisk>();

  const degree = new Map<string, { up: number; down: number }>();
  for (const node of nodes) degree.set(node.id, { up: 0, down: 0 });
  for (const edge of observed) {
    const src = degree.get(edge.source);
    if (src) src.down += 1;
    const tgt = degree.get(edge.target);
    if (tgt) tgt.up += 1;
  }

  const maxDegree = Math.max(0, ...nodes.map(n => {
    const d = degree.get(n.id)!;
    return d.up + d.down;
  }));

  // Criticality comes from the cascade model: the expected share of traffic
  // disrupted if this service failed alone. Weights are filled in here when
  // the caller has not already set them, so this stays usable on its own.
  const weights = computeEdgeWeights(observed);
  const weighted = observed.map(e => (e.weight ? e : { ...e, weight: weights.get(e.id) }));
  const criticalityById = structuralCriticality(nodes, weighted, activityOf);

  for (const node of nodes) {
    const d = degree.get(node.id)!;
    const health = computeHealth(node, incidents);

    // A zero denominator means "nothing to compare against", which is not the
    // same claim as "this node scored zero". Null keeps those apart, here and
    // everywhere below.
    const centrality = maxDegree > 0 ? round2((d.up + d.down) / maxDegree) : null;
    const criticality = criticalityById.get(node.id) ?? null;

    const riskScore = criticality !== null
      ? round2(0.5 * (1 - health.score) + 0.5 * criticality)
      : round2(1 - health.score);

    result.set(node.id, {
      healthScore: health.score,
      riskScore,
      criticality,
      centrality,
      upstreamCount: d.up,
      downstreamCount: d.down,
      healthBreakdown: health.breakdown,
    });
  }

  return result;
}

/**
 * What is downstream of `nodeId` right now, and how much of each dependent's
 * own inbound traffic arrives through it.
 *
 * This is a read over traffic already observed — it does not touch the target,
 * start anything, or stop anything. The share is computed against each
 * dependent's *total* inbound activity, because "40% of what reaches this
 * service comes through the failing one" is the answer that changes a
 * decision; a raw sample count on its own does not.
 */
export function computeBlastRadius(
  nodeId: string,
  nodes: ServiceNode[],
  edges: DependencyEdge[],
): BlastRadiusResult | null {
  const origin = nodes.find(n => n.id === nodeId);
  if (!origin) return null;

  const observed = edges.filter(e => e.observed);
  const nameById = new Map(nodes.map(n => [n.id, n.name]));
  const { nodes: reached } = reachDependents(nodeId, observed);

  const failingSet = new Set<string>([nodeId, ...reached.keys()]);

  const affected: BlastRadiusEntry[] = [];
  for (const [affectedId, hopDistance] of reached) {
    const { share, outboundSamplesPerMin } = shareOfDependenciesInSet(affectedId, failingSet, observed);
    affected.push({
      nodeId: affectedId,
      nodeName: nameById.get(affectedId) ?? affectedId,
      hopDistance,
      outboundSamplesPerMin,
      shareOfItsDependencies: share,
    });
  }

  affected.sort((a, b) => a.hopDistance - b.hopDistance || a.nodeName.localeCompare(b.nodeName));

  return {
    nodeId,
    nodeName: origin.name,
    project: origin.project,
    generatedAt: new Date().toISOString(),
    basis: 'observed-edges',
    totalReachable: affected.length,
    affected,
  };
}

export class RiskEngine {
  /** Latest cascade prediction per project, served by the API. */
  private predictions = new Map<string, CascadePrediction>();

  constructor(private store: GraphStore) {}

  public getPrediction(project: string): CascadePrediction | null {
    return this.predictions.get(project) ?? null;
  }

  public getAllPredictions(): CascadePrediction[] {
    return [...this.predictions.values()];
  }

  /** What if this one service failed outright, with everything else as measured? */
  public simulateCascade(nodeId: string): WhatIfResult | null {
    const { nodes, edges } = this.store.getGraph();
    const origin = nodes.find(n => n.id === nodeId);
    if (!origin) return null;
    const projectNodes = nodes.filter(n => n.project === origin.project);
    const ids = new Set(projectNodes.map(n => n.id));
    const projectEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
    return simulateFailure(origin.project, nodeId, projectNodes, projectEdges);
  }

  /**
   * Writes risk onto the nodes the store already holds.
   *
   * getGraph() hands back the stored node objects themselves rather than
   * copies, so mutating analytics here is what puts these numbers on
   * /api/graph and the graph-update broadcast without either of them needing
   * to know this engine exists. The anomaly-score merge inside getGraph()
   * spreads existing analytics, so it preserves what is written here.
   *
   * Incidents arrive as an argument because GraphStore has no reference to
   * IncidentManager — IncidentManager is constructed around the store, and
   * reversing that to satisfy this engine would be the wrong trade.
   */
  public recomputeAll(incidents: Incident[]): void {
    const { nodes, edges } = this.store.getGraph();

    const projectByNodeId = new Map(nodes.map(n => [n.id, n.project]));
    const nodesByProject = new Map<string, ServiceNode[]>();
    for (const node of nodes) {
      const list = nodesByProject.get(node.project);
      if (list) list.push(node);
      else nodesByProject.set(node.project, [node]);
    }

    const edgesByProject = new Map<string, DependencyEdge[]>();
    for (const edge of edges) {
      const project = projectOfEdge(edge, projectByNodeId);
      if (!project) continue;
      const list = edgesByProject.get(project);
      if (list) list.push(edge);
      else edgesByProject.set(project, [edge]);
    }

    const liveProjects = new Set<string>();
    for (const [project, projectNodes] of nodesByProject) {
      liveProjects.add(project);
      const projectEdges = edgesByProject.get(project) ?? [];
      const projectIncidents = incidents.filter(i => i.targetId === project);

      // Weights first: the cascade model reads them from the edges.
      const weights = computeEdgeWeights(projectEdges);
      for (const edge of projectEdges) {
        const w = weights.get(edge.id);
        if (w) edge.weight = w;
      }

      const risk = computeProjectRisk(projectNodes, projectEdges, projectIncidents);
      for (const node of projectNodes) {
        const r = risk.get(node.id);
        if (!r) continue;
        node.analytics = { ...node.analytics, ...r };
      }

      const prediction = predictCascade(project, projectNodes, projectEdges);
      this.predictions.set(project, prediction);
      const byId = new Map(prediction.nodes.map(c => [c.nodeId, c]));
      for (const node of projectNodes) {
        const c = byId.get(node.id);
        if (!c) continue;
        node.analytics = {
          ...node.analytics,
          failureProbability: c.probability,
          affectedProbability: c.inherited,
          // An id, like every other service reference: this used to be the
          // bare name, so anything that looked the service up by it found
          // nothing. Views show the name part.
          cascadeVia: c.via?.nodeId ?? null,
          cascadeDepth: c.depth,
        };
      }
    }
    for (const project of this.predictions.keys()) {
      if (!liveProjects.has(project)) this.predictions.delete(project);
    }
  }

  public simulateBlastRadius(nodeId: string): BlastRadiusResult | null {
    const { nodes, edges } = this.store.getGraph();
    const origin = nodes.find(n => n.id === nodeId);
    if (!origin) return null;

    // Confine the traversal to the origin's own project: an edge crossing two
    // stacks would be a collection artefact, not a dependency.
    const projectNodes = nodes.filter(n => n.project === origin.project);
    const ids = new Set(projectNodes.map(n => n.id));
    const projectEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target));

    return computeBlastRadius(nodeId, projectNodes, projectEdges);
  }
}
