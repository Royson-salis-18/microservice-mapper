import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { Incident, ScoreContribution } from '../models/Incident.js';
import type { GraphStore } from './GraphStore.js';

/**
 * Current reliability exposure per service.
 *
 * Everything the rest of the app does is backward-looking: RCAEngine only
 * speaks once a service is already critical or degraded. This scores services
 * that are still fine but structurally exposed — how much of the system's
 * live traffic is sitting behind them.
 *
 * The rule this file follows, and the reason it is written the way it is:
 * every number here traces back to a signal that was actually collected,
 * through arithmetic a person can redo by hand from the same graph. Hence
 * `healthBreakdown`, which carries the factors that produced the score in the
 * same visible style RCAEngine uses for root-cause scoring.
 *
 * Two fields on ServiceNode.analytics are deliberately left unset —
 * `failureProbability` and `affectedProbability`. Calibrating a probability
 * needs labelled outcomes ("it failed, N minutes after this pattern"), and
 * nothing in this system records that. A plausible-looking number in those
 * fields would be indistinguishable from a measured one on screen, which is
 * the specific failure this file exists to avoid.
 *
 * DIRECTION CAVEAT: observed edges come from per-container /proc/net/tcp
 * scans, which record `source = the container that was scanned` and
 * `target = the remote peer` — the scan cannot tell which side opened the
 * connection. So a database can legitimately appear as the source of an edge
 * to its own caller. Traversal here follows source→target because that is the
 * convention RCAEngine's propagation path already uses, and disagreeing with
 * it would put two different answers on screen for one incident. Declared
 * (compose depends_on) edges do not have this problem.
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
  hopDistance: number;
  /** Null when no inbound edge carries activity data — unmeasured, not idle. */
  inboundActivitySamplesPerMin: number | null;
  /** Share of this node's own inbound activity that arrives via the failing
   *  node's reachable set. Null when inbound activity is unmeasured. */
  dependentShareOfInbound: number | null;
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

const HEALTH_WEIGHTS = { status: 0.6, anomaly: 0.25, incident: 0.15 } as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function activityOf(edge: DependencyEdge): number {
  return edge.activity?.samplesPerMin ?? 0;
}

/** Edges belong to the project of whichever endpoint we can resolve. Edge ids
 *  are `source->target` over `project:service` node ids, so an edge whose
 *  endpoints were pruned resolves to neither and is skipped. */
function projectOfEdge(edge: DependencyEdge, projectByNodeId: Map<string, string>): string | undefined {
  return projectByNodeId.get(edge.source) ?? projectByNodeId.get(edge.target);
}

/**
 * Every node and edge reachable downstream of `startId`, following observed
 * edges only. The visited set is what keeps a dependency cycle (A→B→C→A)
 * from looping forever or counting the same edge's traffic twice.
 */
function reachDownstream(
  startId: string,
  edges: DependencyEdge[],
): { nodes: Map<string, number>; edgeIds: Set<string> } {
  const outBySource = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    const list = outBySource.get(e.source);
    if (list) list.push(e);
    else outBySource.set(e.source, [e]);
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
      for (const edge of outBySource.get(current) ?? []) {
        edgeIds.add(edge.id);
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        nodes.set(edge.target, hop);
        next.push(edge.target);
      }
    }
    frontier = next;
  }

  return { nodes, edgeIds };
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

  const statusValue =
    node.status === 'healthy' ? 1
    : node.status === 'degraded' ? 0.5
    : node.status === 'critical' ? 0
    : 0.5; // 'unknown' — never observed is not a clean bill of health, nor a fault
  parts.push({
    factor: 'status',
    weight: HEALTH_WEIGHTS.status,
    value: statusValue,
    reason: `container status is ${node.status}`,
  });

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

  // affectedServices holds service NAMES (RCAEngine builds it from node.name)
  // while rootCauseServiceId holds a full node id. Matching the wrong one
  // against the wrong field silently never matches, so both are explicit.
  // RESOLVED incidents are excluded because IncidentManager keeps them in its
  // map forever — it flips status rather than deleting, so an unfiltered read
  // would hold a service down long after it recovered.
  const live = incidents.filter(i => i.status !== 'RESOLVED');
  const isRootCause = live.some(i => i.rootCauseServiceId === node.id);
  const isAffected = live.some(i => i.affectedServices.includes(node.name));
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
  const totalActivity = observed.reduce((sum, e) => sum + activityOf(e), 0);

  for (const node of nodes) {
    const d = degree.get(node.id)!;
    const health = computeHealth(node, incidents);

    // A zero denominator means "nothing to compare against", which is not the
    // same claim as "this node scored zero". Null keeps those apart, here and
    // everywhere below.
    const centrality = maxDegree > 0 ? round2((d.up + d.down) / maxDegree) : null;

    let criticality: number | null = null;
    if (totalActivity > 0) {
      const { edgeIds } = reachDownstream(node.id, observed);
      let reachableActivity = 0;
      for (const edge of observed) {
        if (edgeIds.has(edge.id)) reachableActivity += activityOf(edge);
      }
      criticality = round2(reachableActivity / totalActivity);
    }

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
  const { nodes: reached } = reachDownstream(nodeId, observed);

  const reachableSet = new Set<string>([nodeId, ...reached.keys()]);

  const affected: BlastRadiusEntry[] = [];
  for (const [affectedId, hopDistance] of reached) {
    const inbound = observed.filter(e => e.target === affectedId);
    const measured = inbound.filter(e => e.activity !== undefined);

    const inboundActivity = measured.length > 0
      ? round2(measured.reduce((sum, e) => sum + activityOf(e), 0))
      : null;

    let dependentShare: number | null = null;
    if (inboundActivity !== null && inboundActivity > 0) {
      const viaOrigin = measured
        .filter(e => reachableSet.has(e.source))
        .reduce((sum, e) => sum + activityOf(e), 0);
      dependentShare = round2(viaOrigin / inboundActivity);
    }

    affected.push({
      nodeId: affectedId,
      nodeName: nameById.get(affectedId) ?? affectedId,
      hopDistance,
      inboundActivitySamplesPerMin: inboundActivity,
      dependentShareOfInbound: dependentShare,
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
  constructor(private store: GraphStore) {}

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

    for (const [project, projectNodes] of nodesByProject) {
      const projectEdges = edgesByProject.get(project) ?? [];
      const projectIncidents = incidents.filter(i => i.targetId === project);
      const risk = computeProjectRisk(projectNodes, projectEdges, projectIncidents);

      for (const node of projectNodes) {
        const r = risk.get(node.id);
        if (!r) continue;
        node.analytics = { ...node.analytics, ...r };
      }
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
