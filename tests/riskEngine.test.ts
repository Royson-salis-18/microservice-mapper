/**
 * RiskEngine's pure arithmetic — computeProjectRisk and computeBlastRadius.
 *
 * These take plain node/edge arrays rather than a GraphStore, specifically so
 * they can be tested without booting a store (whose constructor loads from
 * disk and starts a timer). The rule under test throughout is: a zero
 * denominator produces null ("nothing to compare against"), never 0 or NaN,
 * and a genuine zero result is still 0. A silent NaN or a null read as 0 is
 * exactly the kind of "looks real, isn't" bug this file exists to catch.
 *
 * Run: npx tsx --test tests/riskEngine.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeProjectRisk, computeBlastRadius } from '../server/graph/RiskEngine.js';
import type { ServiceNode } from '../server/models/ServiceNode.js';
import type { DependencyEdge } from '../server/models/DependencyEdge.js';
import type { Incident } from '../server/models/Incident.js';

function node(id: string, overrides: Partial<ServiceNode> = {}): ServiceNode {
  const [project, name] = id.split(':');
  return {
    id,
    name: name ?? id,
    type: 'service',
    project,
    status: 'healthy',
    metadata: {},
    metrics: null,
    ...overrides,
  };
}

function edge(source: string, target: string, samplesPerMin?: number, overrides: Partial<DependencyEdge> = {}): DependencyEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: 'http',
    declared: false,
    observed: true,
    evidenceSources: ['network-tcp'],
    metrics: null,
    activity: samplesPerMin === undefined ? undefined : { samplesPerMin, windowSec: 60, lastSeen: new Date().toISOString() },
    status: 'active',
    ...overrides,
  };
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// --- computeProjectRisk: null-vs-zero denominator rules ---------------------

test('risk: a single node with no edges gets null centrality/criticality, not 0 or NaN', () => {
  const nodes = [node('p:solo')];
  const risk = computeProjectRisk(nodes, [], []);
  const r = risk.get('p:solo')!;
  assert.equal(r.centrality, null);
  assert.equal(r.criticality, null);
  assert.ok(finite(r.healthScore));
  assert.ok(finite(r.riskScore));
});

test('risk: a leaf node with zero observed edges in a project that has activity elsewhere gets criticality 0, not null', () => {
  const nodes = [node('p:a'), node('p:b'), node('p:leaf')];
  const edges = [edge('p:a', 'p:b', 100)];
  const risk = computeProjectRisk(nodes, edges, []);
  // p:leaf has no outgoing observed edges, but the project has real activity
  // (the a->b edge) — its footprint carries none of it, and that is a real 0.
  assert.equal(risk.get('p:leaf')!.criticality, 0);
  assert.equal(risk.get('p:leaf')!.centrality, 0);
});

test('risk: edges with no activity field make total activity 0, so criticality is null everywhere in that project', () => {
  const nodes = [node('p:a'), node('p:b')];
  const edges = [edge('p:a', 'p:b')]; // no samplesPerMin passed -> activity undefined
  const risk = computeProjectRisk(nodes, edges, []);
  assert.equal(risk.get('p:a')!.criticality, null);
  assert.equal(risk.get('p:b')!.criticality, null);
  // centrality only needs degree, not activity, so it's still real
  assert.notEqual(risk.get('p:a')!.centrality, null);
});

test('risk: a cycle (A->B->C->A) does not loop forever and does not double-count an edge\'s activity', () => {
  const nodes = [node('p:a'), node('p:b'), node('p:c')];
  const edges = [edge('p:a', 'p:b', 60), edge('p:b', 'p:c', 60), edge('p:c', 'p:a', 60)];
  const risk = computeProjectRisk(nodes, edges, []);
  // Total activity is 180 (60+60+60). From A, all three edges are reachable
  // (A->B, B->C, C->A) exactly once each, so criticality(A) should be 1.0,
  // not something inflated by revisiting the cycle.
  const a = risk.get('p:a')!;
  assert.equal(a.criticality, 1);
  assert.ok(finite(a.criticality!));
});

test('risk: healthBreakdown entries sum exactly to healthScore', () => {
  const n = node('p:svc', {
    status: 'degraded',
    analytics: { anomalyScore: 0.4, anomalyPersistent: true },
  });
  const incidents: Incident[] = [{
    id: 'inc-1', targetId: 'p', startedAt: '', detectedAt: '', endedAt: null,
    status: 'INCIDENT', severity: 'HIGH',
    rootCauseServiceId: null, rootCauseEdgeId: null, rootCauseScore: 0.5, confidence: 'MEDIUM',
    symptoms: [], anomalies: [], propagation: [], affectedServices: ['svc'],
    candidateCauses: [], evidence: [],
    explanation: { whatHappened: '', whenStarted: '', likelyRootCause: '', why: '', propagationPath: [], affectedServices: [], confidence: 'MEDIUM', alternativeCandidates: [], evidenceSummary: [], recommendedInvestigation: [] },
    remediationGuide: [],
  }];
  const risk = computeProjectRisk([n], [], incidents);
  const r = risk.get('p:svc')!;
  const sum = r.healthBreakdown.reduce((s, b) => s + b.score, 0);
  assert.equal(Math.round(sum * 100) / 100, r.healthScore);
  assert.equal(r.healthBreakdown.length, 3); // status + anomaly + incident, all present
});

test('risk: a RESOLVED incident does not count against a node\'s health', () => {
  const n = node('p:svc', { status: 'healthy' });
  const incidents: Incident[] = [{
    id: 'inc-1', targetId: 'p', startedAt: '', detectedAt: '', endedAt: '2020-01-01', status: 'RESOLVED', severity: 'LOW',
    rootCauseServiceId: 'p:svc', rootCauseEdgeId: null, rootCauseScore: 0.9, confidence: 'HIGH',
    symptoms: [], anomalies: [], propagation: [], affectedServices: ['svc'],
    candidateCauses: [], evidence: [],
    explanation: { whatHappened: '', whenStarted: '', likelyRootCause: '', why: '', propagationPath: [], affectedServices: [], confidence: 'HIGH', alternativeCandidates: [], evidenceSummary: [], recommendedInvestigation: [] },
    remediationGuide: [],
  }];
  const risk = computeProjectRisk([n], [], incidents);
  const incidentFactor = risk.get('p:svc')!.healthBreakdown.find(b => b.factor === 'incident')!;
  assert.match(incidentFactor.reason, /not part of any open incident/);
});

test('risk: a missing anomaly score is omitted from the breakdown, not defaulted to a middle value', () => {
  const n = node('p:svc'); // no analytics.anomalyScore at all
  const risk = computeProjectRisk([n], [], []);
  const factors = risk.get('p:svc')!.healthBreakdown.map(b => b.factor);
  assert.ok(!factors.includes('anomaly'));
  assert.equal(factors.length, 2); // status + incident only
});

test('risk: computeProjectRisk takes already-scoped input — RiskEngine.recomputeAll groups nodes/edges by project before calling it, so p2 alone (no edges) gets null, independent of what p1 looks like', () => {
  // This mirrors what recomputeAll actually does: group by project, then call
  // computeProjectRisk once per project. Feeding it a mixed-project array
  // directly (skipping that grouping) is not the supported contract — degree
  // and activity are computed over whatever set of edges you hand it.
  const p1Risk = computeProjectRisk([node('p1:a'), node('p1:b')], [edge('p1:a', 'p1:b', 500)], []);
  const p2Risk = computeProjectRisk([node('p2:x')], [], []);

  assert.notEqual(p1Risk.get('p1:a')!.criticality, null);
  assert.equal(p2Risk.get('p2:x')!.centrality, null); // p2 has zero observed edges of its own
  assert.equal(p2Risk.get('p2:x')!.criticality, null); // p2 has zero total activity of its own
});

// --- computeBlastRadius -------------------------------------------------

test('blast radius: unknown node returns null, not a thrown error or an empty-but-truthy result', () => {
  const result = computeBlastRadius('p:ghost', [node('p:a')], []);
  assert.equal(result, null);
});

test('blast radius: a node with no downstream edges reports zero reachable, not an error', () => {
  const nodes = [node('p:leaf')];
  const result = computeBlastRadius('p:leaf', nodes, [])!;
  assert.equal(result.totalReachable, 0);
  assert.deepEqual(result.affected, []);
});

test('blast radius: hop distance is correct across a chain, and share is computed against each node\'s OWN total inbound, not the origin\'s outbound', () => {
  const nodes = [node('p:a'), node('p:b'), node('p:c'), node('p:other')];
  const edges = [
    edge('p:a', 'p:b', 80),
    edge('p:b', 'p:c', 80),
    // c also receives traffic from somewhere unrelated to a's failure
    edge('p:other', 'p:c', 20),
  ];
  const result = computeBlastRadius('p:a', nodes, edges)!;
  assert.equal(result.totalReachable, 2);

  const b = result.affected.find(e => e.nodeId === 'p:b')!;
  assert.equal(b.hopDistance, 1);
  assert.equal(b.inboundActivitySamplesPerMin, 80);
  assert.equal(b.dependentShareOfInbound, 1); // all of b's inbound traces back through a

  const c = result.affected.find(e => e.nodeId === 'p:c')!;
  assert.equal(c.hopDistance, 2);
  assert.equal(c.inboundActivitySamplesPerMin, 100); // 80 (via b) + 20 (via other)
  assert.equal(c.dependentShareOfInbound, 0.8); // 80/100 traces back through a, not 100%
});

test('blast radius: an inbound edge with no activity field makes that node\'s share null, not 0', () => {
  const nodes = [node('p:a'), node('p:b')];
  const edges = [edge('p:a', 'p:b')]; // no samplesPerMin
  const result = computeBlastRadius('p:a', nodes, edges)!;
  const b = result.affected.find(e => e.nodeId === 'p:b')!;
  assert.equal(b.inboundActivitySamplesPerMin, null);
  assert.equal(b.dependentShareOfInbound, null);
});

test('blast radius: a cycle does not infinite-loop and each node appears exactly once', () => {
  const nodes = [node('p:a'), node('p:b'), node('p:c')];
  const edges = [edge('p:a', 'p:b', 10), edge('p:b', 'p:c', 10), edge('p:c', 'p:a', 10)];
  const result = computeBlastRadius('p:a', nodes, edges)!;
  const ids = result.affected.map(e => e.nodeId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.totalReachable, 2); // b and c; a is the origin, not "affected"
});
