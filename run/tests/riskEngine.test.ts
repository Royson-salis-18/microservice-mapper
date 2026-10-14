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

import { computeProjectRisk, computeBlastRadius } from '../../server/graph/RiskEngine.js';
import type { ServiceNode } from '../../server/models/ServiceNode.js';
import type { DependencyEdge } from '../../server/models/DependencyEdge.js';
import type { Incident } from '../../server/models/Incident.js';

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
  // Criticality comes from the cascade model. These fixture edges carry no
  // direction evidence, so their confidence (and weight) is 0.7. Killing A
  // takes C down with τ·w·1 = 0.7·0.7 = 0.49 (A is C's only dependency) and B
  // with 0.7·0.7·0.49 = 0.24. Each edge counts once, weighted by the chance
  // either end has failed: (60·1 + 60·(1−0.76·0.51) + 60·1) / 180 ≈ 0.87.
  // The point of the test is that the cycle neither loops forever nor pushes
  // the result past 1.
  const a = risk.get('p:a')!;
  assert.ok(finite(a.criticality!));
  assert.equal(a.criticality, 0.87);
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

test('blast radius travels AGAINST the arrow: a failing database takes down its callers, not the other way round', () => {
  // frontend -> orders -> orders-db  (X -> Y means "X calls Y")
  const nodes = [node('p:frontend'), node('p:orders'), node('p:orders-db')];
  const edges = [edge('p:frontend', 'p:orders', 100), edge('p:orders', 'p:orders-db', 80)];

  // The database is the thing everything else rests on.
  const dbBlast = computeBlastRadius('p:orders-db', nodes, edges)!;
  assert.equal(dbBlast.totalReachable, 2);
  assert.equal(dbBlast.affected.find(e => e.nodeId === 'p:orders')!.hopDistance, 1);
  assert.equal(dbBlast.affected.find(e => e.nodeId === 'p:frontend')!.hopDistance, 2);

  // The frontend is a leaf: nothing calls it, so its failure propagates nowhere.
  const frontendBlast = computeBlastRadius('p:frontend', nodes, edges)!;
  assert.equal(frontendBlast.totalReachable, 0);
});

test('blast radius: share reflects how much of a dependent\'s own dependencies are inside the radius', () => {
  // checkout calls payment (60/min) and also cart and shipping (20 each).
  const nodes = [node('p:checkout'), node('p:payment'), node('p:cart'), node('p:shipping')];
  const edges = [
    edge('p:checkout', 'p:payment', 60),
    edge('p:checkout', 'p:cart', 20),
    edge('p:checkout', 'p:shipping', 20),
  ];
  const result = computeBlastRadius('p:payment', nodes, edges)!;
  const checkout = result.affected.find(e => e.nodeId === 'p:checkout')!;
  assert.equal(checkout.outboundSamplesPerMin, 100);
  // 60 of checkout's 100 flows into the failing set — it is hurt, not dead.
  assert.equal(checkout.shareOfItsDependencies, 0.6);
});

test('blast radius: a sole-path dependent shows 1.0, and unmeasured traffic stays null', () => {
  const nodes = [node('p:a'), node('p:b'), node('p:c')];
  const measured = computeBlastRadius('p:b', [nodes[0], nodes[1]], [edge('p:a', 'p:b', 50)])!;
  assert.equal(measured.affected[0].shareOfItsDependencies, 1);

  const unmeasured = computeBlastRadius('p:b', [nodes[0], nodes[1]], [edge('p:a', 'p:b')])!;
  assert.equal(unmeasured.affected[0].outboundSamplesPerMin, null);
  assert.equal(unmeasured.affected[0].shareOfItsDependencies, null);
});

test('blast radius: a cycle does not infinite-loop and each node appears exactly once', () => {
  const nodes = [node('p:a'), node('p:b'), node('p:c')];
  const edges = [edge('p:a', 'p:b', 10), edge('p:b', 'p:c', 10), edge('p:c', 'p:a', 10)];
  const result = computeBlastRadius('p:a', nodes, edges)!;
  const ids = result.affected.map(e => e.nodeId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.totalReachable, 2);
});

// --- criticality must discriminate -----------------------------------------

test('criticality separates a shared dependency from a leaf that nothing calls', () => {
  // A realistic shape: one frontend, two services, each with its own store.
  //   frontend -> orders   -> orders-db
  //   frontend -> catalogue -> catalogue-db
  const nodes = ['p:frontend', 'p:orders', 'p:orders-db', 'p:catalogue', 'p:catalogue-db'].map(id => node(id));
  const edges = [
    edge('p:frontend', 'p:orders', 100),
    edge('p:orders', 'p:orders-db', 100),
    edge('p:frontend', 'p:catalogue', 100),
    edge('p:catalogue', 'p:catalogue-db', 100),
  ];
  const risk = computeProjectRisk(nodes, edges, []);
  const c = (id: string) => risk.get(id)!.criticality!;

  // orders-db: kills orders, which kills the frontend's orders path. Its own
  // 100 in, orders' 100 in, and the frontend's other leg still runs.
  // catalogue-db is symmetric, so the two must agree.
  assert.equal(c('p:orders-db'), c('p:catalogue-db'));

  // The databases sit under a chain, so more traffic dies with them than with
  // the leaf store of a single service path — and critically, the numbers are
  // not all pinned at 1.0 the way reachability made them.
  const distinct = new Set([c('p:frontend'), c('p:orders'), c('p:orders-db')]);
  assert.ok(distinct.size > 1, `criticality must discriminate, got ${[...distinct]}`);
  for (const v of [c('p:frontend'), c('p:orders'), c('p:orders-db')]) {
    assert.ok(v >= 0 && v <= 1, `criticality out of range: ${v}`);
  }
});

test('criticality: a node nothing depends on only takes its own traffic with it', () => {
  // a -> b (50), and an unrelated busy pair c -> d (450).
  const nodes = ['p:a', 'p:b', 'p:c', 'p:d'].map(id => node(id));
  const edges = [edge('p:a', 'p:b', 50), edge('p:c', 'p:d', 450)];
  const risk = computeProjectRisk(nodes, edges, []);
  // Killing b stops the 50 flowing into it, out of 500 total. Nothing else.
  assert.equal(risk.get('p:b')!.criticality, 0.1);
  // Killing d stops its 450 — nine times the blast of b, correctly ranked.
  assert.equal(risk.get('p:d')!.criticality, 0.9);
});

// --- edge direction inference ----------------------------------------------
//
// The whole dependency graph's direction rests on this one decision, so it is
// worth pinning down. Before this existed, every connection was recorded as
// "scanned container -> peer", which meant each link appeared twice in
// opposite directions (both ends get scanned) and databases were recorded as
// callers of their own clients.

import { orientConnection } from '../../server/telemetry-platform/src/collection/MetricCollector.js';

test('direction: the end holding the listening port is the one being called', () => {
  // orders (ephemeral 45000) -> orders-db (listening 27017)
  const fromClient = orientConnection(45000, 27017, new Set([8080]), new Set([27017]));
  assert.equal(fromClient.scannedIsCaller, true);
  assert.equal(fromClient.evidence, 'direction:listen-port');

  // The same connection seen from the database's own scan must resolve to the
  // SAME direction — this is what stops one link becoming two opposite edges.
  const fromServer = orientConnection(27017, 45000, new Set([27017]), new Set([8080]));
  assert.equal(fromServer.scannedIsCaller, false);
  assert.equal(fromServer.evidence, 'direction:listen-port');
});

test('direction: falls back to the ephemeral range when a listen table is missing', () => {
  // Distroless container whose listen table could not be read: empty sets.
  const r = orientConnection(51234, 5432, new Set(), new Set());
  assert.equal(r.scannedIsCaller, true);
  assert.equal(r.evidence, 'direction:ephemeral-port');

  const reverse = orientConnection(5432, 51234, new Set(), new Set());
  assert.equal(reverse.scannedIsCaller, false);
  assert.equal(reverse.evidence, 'direction:ephemeral-port');
});

test('direction: says so when it genuinely cannot tell, rather than guessing silently', () => {
  // Two service ports, neither ephemeral, no listen data.
  const r = orientConnection(8080, 9090, new Set(), new Set());
  assert.equal(r.evidence, 'direction:unresolved');

  // Both ephemeral is equally undecidable.
  const both = orientConnection(40000, 41000, new Set(), new Set());
  assert.equal(both.evidence, 'direction:unresolved');
});

test('direction: listen-port evidence wins over the ephemeral heuristic', () => {
  // Local port is in the ephemeral range but is genuinely this service's
  // listening port — a server that happens to listen high. The listen table
  // must win, or the arrow points backwards.
  const r = orientConnection(40000, 40001, new Set([40000]), new Set());
  assert.equal(r.scannedIsCaller, false);
  assert.equal(r.evidence, 'direction:listen-port');
});
