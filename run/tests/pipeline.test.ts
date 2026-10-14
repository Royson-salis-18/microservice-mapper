/**
 * The judgement pipeline: container status, edge weights, root cause, and
 * cascade prediction.
 *
 * These are the pieces that decide what the system tells an operator, so the
 * tests pin down decisions, not just shapes: that a crash is critical and a
 * finished job is not, that a heavily used dependency outweighs a rarely used
 * one, that the root cause is the failure the others follow from, and that
 * predicted risk flows from a failing service to its callers - not the other
 * way round.
 *
 * Run: npx tsx --test tests/pipeline.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { statusFromSample, statusFromPsRow, indexPsRowsByServiceId } from '../../server/telemetry-platform/src/collection/containerHealth.js';
import { computeEdgeWeights, CONFIDENCE } from '../../algorithms/graph/EdgeWeights.js';
import { predictCascade, simulateFailure, intrinsicProbability, DEFAULT_TRANSMISSION } from '../../algorithms/graph/CascadeEngine.js';
import { RCAEngine, dependencyReach } from '../../algorithms/rca/RCAEngine.js';
import type { ServiceNode } from '../../server/models/ServiceNode.js';
import type { DependencyEdge } from '../../server/models/DependencyEdge.js';

// --- fixtures ---------------------------------------------------------------

function node(id: string, status: ServiceNode['status'] = 'healthy', extra: Partial<ServiceNode> = {}): ServiceNode {
  const [project, name] = id.split(':');
  return { id, name, type: 'service', project, status, metadata: {}, metrics: null, ...extra };
}

function edge(source: string, target: string, samplesPerMin?: number, extra: Partial<DependencyEdge> = {}): DependencyEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: 'dependency',
    declared: false,
    observed: true,
    evidenceSources: ['network-tcp', 'direction:listen-port'],
    metrics: null,
    activity: samplesPerMin === undefined ? undefined : { samplesPerMin, windowSec: 60, lastSeen: new Date().toISOString() },
    status: 'active',
    ...extra,
  };
}

/** Attach computed weights to the edges, as the risk engine does each cycle. */
function weigh(edges: DependencyEdge[]): DependencyEdge[] {
  const w = computeEdgeWeights(edges);
  for (const e of edges) e.weight = w.get(e.id);
  return edges;
}

const sample = (over: Partial<Parameters<typeof statusFromSample>[0]> = {}) => ({
  cpuPercent: 10, memoryPercent: 20, restartCount: 0, restartDelta: 0,
  containerState: 'running', containerUptimeSeconds: 3600, ...over,
});

// --- container status -------------------------------------------------------

test('status: a quiet running container is healthy', () => {
  assert.equal(statusFromSample(sample()).status, 'healthy');
});

test('status: resource saturation is degraded, not critical', () => {
  const r = statusFromSample(sample({ memoryPercent: 93 }));
  assert.equal(r.status, 'degraded');
  assert.match(r.reason, /memory 93%/);
});

test('status: a crash-and-restart between polls is surfaced, not discarded', () => {
  // restartDelta used to be collected and then thrown away.
  assert.equal(statusFromSample(sample({ restartDelta: 1, restartCount: 3 })).status, 'degraded');
  // …and a restart that landed before the first poll is caught by uptime.
  assert.equal(statusFromSample(sample({ restartCount: 2, containerUptimeSeconds: 40 })).status, 'degraded');
  // An old restart long since recovered from is not a current problem.
  assert.equal(statusFromSample(sample({ restartCount: 2, containerUptimeSeconds: 9000 })).status, 'healthy');
});

test('status: crash-looping is critical whatever the CPU says', () => {
  assert.equal(statusFromSample(sample({ containerState: 'restarting', cpuPercent: 1 })).status, 'critical');
});

test('status: a missing container is classified from docker ps -a', () => {
  const row = (State: string, Status: string) => ({ ID: 'x', Image: 'i', Names: 'shop-db-1', State, Status });
  assert.equal(statusFromPsRow(row('exited', 'Exited (137) 2 minutes ago'))!.status, 'critical');
  assert.match(statusFromPsRow(row('exited', 'Exited (137) 2 minutes ago'))!.reason, /out of memory/);
  assert.equal(statusFromPsRow(row('restarting', 'Restarting (1) 3 seconds ago'))!.status, 'critical');
  assert.equal(statusFromPsRow(undefined)!.status, 'critical');
});

test('status: a job that finished cleanly (exit 0) is NOT a crash', () => {
  const r = statusFromPsRow({ ID: 'x', Image: 'i', Names: 'shop-migrate-1', State: 'exited', Status: 'Exited (0) 6 days ago' })!;
  assert.equal(r.status, 'unknown');
  assert.equal(r.exitCode, 0);
});

test('status: running per ps but missing from one stats snapshot is a race, not a failure', () => {
  assert.equal(statusFromPsRow({ ID: 'x', Image: 'i', Names: 'shop-api-1', State: 'running', Status: 'Up 2 hours' }), null);
});

test('status: a recreated container (new id, same service) reads as running, not crashed', () => {
  const rows = [
    { ID: 'old', Image: 'i', Names: 'shop-api-1', State: 'exited', Status: 'Exited (137) 1 minute ago', Labels: 'com.docker.compose.service=api' },
    { ID: 'new', Image: 'i', Names: 'shop-api-1', State: 'running', Status: 'Up 30 seconds', Labels: 'com.docker.compose.service=api' },
  ];
  const byService = indexPsRowsByServiceId('shop', rows);
  assert.equal(byService.get('shop:api')!.ID, 'new');
  assert.equal(statusFromPsRow(byService.get('shop:api')), null);
});

// --- edge weights -----------------------------------------------------------

test('weights: dependency is the share of the caller\'s traffic, so a busy dependency outweighs a rare one', () => {
  const edges = [edge('p:checkout', 'p:payment', 90), edge('p:checkout', 'p:cache', 10)];
  const w = computeEdgeWeights(edges);
  assert.equal(w.get('p:checkout->p:payment')!.dependency, 0.9);
  assert.equal(w.get('p:checkout->p:cache')!.dependency, 0.1);
  assert.equal(w.get('p:checkout->p:payment')!.dependencyBasis, 'activity');
  assert.ok(w.get('p:checkout->p:payment')!.value > w.get('p:checkout->p:cache')!.value);
});

test('weights: confidence follows the evidence behind the edge', () => {
  const edges = [
    edge('p:a', 'p:x', 10),
    edge('p:b', 'p:x', 10, { evidenceSources: ['network-tcp', 'direction:unresolved'] }),
    edge('p:c', 'p:x', undefined, { observed: false, declared: true, evidenceSources: ['compose'] }),
    edge('p:d', 'p:x', undefined, { observed: false, declared: false, evidenceSources: ['network-candidate'] }),
  ];
  const w = computeEdgeWeights(edges);
  assert.equal(w.get('p:a->p:x')!.confidence, CONFIDENCE.listenPort);
  assert.equal(w.get('p:b->p:x')!.confidence, CONFIDENCE.unresolvedDirection);
  assert.equal(w.get('p:c->p:x')!.confidence, CONFIDENCE.declaredOnly);
  // Shared-network membership is not evidence of a dependency at all.
  assert.equal(w.get('p:d->p:x')!.value, 0);
});

test('weights: a caller with no traffic figures splits evenly, and says so', () => {
  const edges = [
    edge('p:a', 'p:x', undefined, { observed: false, declared: true, evidenceSources: ['compose'] }),
    edge('p:a', 'p:y', undefined, { observed: false, declared: true, evidenceSources: ['compose'] }),
  ];
  const w = computeEdgeWeights(edges);
  assert.equal(w.get('p:a->p:x')!.dependency, 0.5);
  assert.equal(w.get('p:a->p:x')!.dependencyBasis, 'uniform');
});

test('weights: request rates are preferred when every one of the caller\'s edges has them', () => {
  const edges = [
    edge('p:a', 'p:x', 500, { metrics: { requestRate: 30 } }),
    edge('p:a', 'p:y', 10, { metrics: { requestRate: 70 } }),
  ];
  const w = computeEdgeWeights(edges);
  assert.equal(w.get('p:a->p:y')!.dependency, 0.7);
  assert.equal(w.get('p:a->p:y')!.dependencyBasis, 'requests');
});

test('weights: stress comes only from measurements on the edge itself', () => {
  const w = computeEdgeWeights([
    edge('p:a', 'p:x', 10, { metrics: { errorRate: 0.1, latency: 200 } }),
    edge('p:a', 'p:y', 10),
  ]);
  assert.equal(w.get('p:a->p:x')!.stress, 1); // 10% errors is past the 5% line
  assert.equal(w.get('p:a->p:y')!.stress, null); // no request-level data: unknown, not calm
});

// --- cascade prediction -----------------------------------------------------

test('cascade: risk flows from a failing dependency to its callers, not the other way', () => {
  // frontend -> orders -> db, db crashed
  const nodes = [node('p:frontend'), node('p:orders'), node('p:db', 'critical')];
  const edges = weigh([edge('p:frontend', 'p:orders', 100), edge('p:orders', 'p:db', 100)]);
  const pred = predictCascade('p', nodes, edges);
  const p = (id: string) => pred.nodes.find(n => n.nodeId === id)!;

  assert.equal(p('p:db').probability, 1);
  // orders relies on db entirely: τ · 1 · 1
  assert.equal(p('p:orders').probability, DEFAULT_TRANSMISSION);
  // frontend one hop further: τ · 1 · τ
  assert.equal(p('p:frontend').probability, Math.round(DEFAULT_TRANSMISSION ** 2 * 1000) / 1000);
  assert.equal(p('p:orders').via!.nodeName, 'db');
  assert.deepEqual(p('p:frontend').path, ['frontend', 'orders', 'db']);
  assert.equal(p('p:frontend').depth, 2);
});

test('cascade: a service with other paths still standing is less exposed', () => {
  // checkout splits traffic 50/50 between two payment providers; one fails.
  const nodes = [node('p:checkout'), node('p:pay-a', 'critical'), node('p:pay-b')];
  const edges = weigh([edge('p:checkout', 'p:pay-a', 50), edge('p:checkout', 'p:pay-b', 50)]);
  const pred = predictCascade('p', nodes, edges);
  const checkout = pred.nodes.find(n => n.nodeId === 'p:checkout')!;
  assert.equal(checkout.probability, Math.round(DEFAULT_TRANSMISSION * 0.5 * 1000) / 1000);
});

test('cascade: nothing failing means nothing predicted', () => {
  const nodes = [node('p:a'), node('p:b')];
  const pred = predictCascade('p', nodes, weigh([edge('p:a', 'p:b', 10)]));
  assert.equal(pred.expectedFailures, 0);
  assert.equal(pred.atRisk.length, 0);
});

test('cascade: "unknown" is not treated as partly failing', () => {
  assert.equal(intrinsicProbability(node('p:x', 'unknown')).p, 0);
});

test('cascade: converges on a dependency cycle and stays within 0..1', () => {
  const nodes = [node('p:a', 'critical'), node('p:b'), node('p:c')];
  const edges = weigh([edge('p:a', 'p:b', 10), edge('p:b', 'p:c', 10), edge('p:c', 'p:a', 10)]);
  const pred = predictCascade('p', nodes, edges);
  assert.ok(pred.converged);
  for (const n of pred.nodes) assert.ok(n.probability >= 0 && n.probability <= 1);
});

test('cascade: "at risk" lists healthy services the model expects to be pulled down', () => {
  const nodes = [node('p:frontend'), node('p:orders'), node('p:db', 'critical')];
  const edges = weigh([edge('p:frontend', 'p:orders', 100), edge('p:orders', 'p:db', 100)]);
  const pred = predictCascade('p', nodes, edges);
  assert.deepEqual(pred.atRisk.map(n => n.nodeName), ['orders', 'frontend']);
});

test('what-if: failing a shared database reaches every caller; failing a leaf reaches nobody', () => {
  const nodes = [node('p:frontend'), node('p:orders'), node('p:catalogue'), node('p:db')];
  const edges = weigh([
    edge('p:frontend', 'p:orders', 100),
    edge('p:frontend', 'p:catalogue', 100),
    edge('p:orders', 'p:db', 100),
    edge('p:catalogue', 'p:db', 100),
  ]);
  const db = simulateFailure('p', 'p:db', nodes, edges)!;
  assert.deepEqual(new Set(db.affected.map(a => a.nodeName)), new Set(['orders', 'catalogue', 'frontend']));
  assert.ok(db.expectedAdditionalFailures > 1.5);

  const leaf = simulateFailure('p', 'p:frontend', nodes, edges)!;
  assert.equal(leaf.affected.length, 0);
  assert.equal(simulateFailure('p', 'p:ghost', nodes, edges), null);
});

// --- root cause -------------------------------------------------------------

test('reach: dependency strength is the product of weights along the strongest path', () => {
  const edges = weigh([edge('p:frontend', 'p:orders', 100), edge('p:orders', 'p:db', 100)]);
  const reach = dependencyReach('p:db', edges, e => e.weight!.value);
  assert.equal(reach.get('p:orders'), 1);
  assert.equal(reach.get('p:frontend'), 1);
  assert.equal(reach.has('p:elsewhere'), false);
});

test('rca: the failure the others follow from is ranked first, and its victims are penalised', () => {
  // db crashed; orders and frontend degraded because they depend on it.
  const nodes = [node('p:frontend', 'degraded'), node('p:orders', 'degraded'), node('p:db', 'critical')];
  const edges = [edge('p:frontend', 'p:orders', 100), edge('p:orders', 'p:db', 100)];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies: [] });

  assert.equal(result.primaryRootCause!.serviceId, 'p:db');
  const factors = (id: string) => result.candidateCauses.find(c => c.serviceId === id)!.scoreBreakdown.map(b => b.factor);
  assert.ok(factors('p:db').includes('explains_failures'));
  assert.ok(factors('p:orders').includes('dependency_failing'));
  assert.ok(!factors('p:db').includes('dependency_failing'));
});

test('rca: propagation runs from the root cause to the services that depend on it', () => {
  const nodes = [node('p:frontend', 'degraded'), node('p:orders', 'degraded'), node('p:db', 'critical')];
  const edges = [edge('p:frontend', 'p:orders', 100), edge('p:orders', 'p:db', 100)];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies: [] });
  assert.deepEqual(result.explanation.propagationPath, ['db', 'orders', 'frontend']);
});

test('rca: a single failing service with no one else failing gets no coverage credit and no penalty', () => {
  const nodes = [node('p:a', 'critical'), node('p:b')];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:b', 'p:a', 10)], anomalies: [] });
  const f = result.primaryRootCause!.scoreBreakdown.map(b => b.factor);
  assert.ok(!f.includes('explains_failures'));
  assert.ok(!f.includes('dependency_failing'));
  assert.ok(result.primaryRootCause!.score >= 0 && result.primaryRootCause!.score <= 1);
});

// --- temporal precedence ----------------------------------------------------

import { AnomalyDetector } from '../../algorithms/detection/AnomalyDetector.js';
import { TemporalAnalyzer } from '../../algorithms/rca/TemporalAnalyzer.js';

function stubMetricStore() {
  // No metric history: only the container-health path produces anomalies,
  // which is enough to test onset tracking.
  return { getHistory: () => [] } as any;
}

test('onset: an ongoing anomaly keeps the time it started, not the time of the latest check', async () => {
  const detector = new AnomalyDetector(stubMetricStore());
  const db = node('p:db', 'critical');
  const first = detector.detectAnomaliesForTarget('p', [db]);
  await new Promise(r => setTimeout(r, 25));
  const second = detector.detectAnomaliesForTarget('p', [db]);
  assert.equal(second[0].timestamp, first[0].timestamp);
});

test('onset: the service that failed first gets precedence, whatever order the map holds them in', async () => {
  const detector = new AnomalyDetector(stubMetricStore());
  // db fails first…
  detector.detectAnomaliesForTarget('p', [node('p:api'), node('p:db', 'critical')]);
  await new Promise(r => setTimeout(r, 1100));
  // …then api. api is listed first in the node array, which used to win.
  const anomalies = detector.detectAnomaliesForTarget('p', [node('p:api', 'critical'), node('p:db', 'critical')]);
  const earliest = new TemporalAnalyzer().findEarliestAnomalousNodes(anomalies);
  assert.deepEqual([...earliest], ['p:db']);
});

test('onset: a cleared anomaly is forgotten, so a recurrence counts as new', async () => {
  const detector = new AnomalyDetector(stubMetricStore());
  const first = detector.detectAnomaliesForTarget('p', [node('p:db', 'critical')]);
  detector.detectAnomaliesForTarget('p', [node('p:db', 'healthy')]);
  await new Promise(r => setTimeout(r, 25));
  const again = detector.detectAnomaliesForTarget('p', [node('p:db', 'critical')]);
  assert.notEqual(again[0].timestamp, first[0].timestamp);
});

test('onset: problems that began in the same cycle are reported as a tie', () => {
  const t = new Date().toISOString();
  const a = (nodeId: string) => ({ id: nodeId, nodeId, targetId: 'p', metric: 'cpu', timestamp: t, observedValue: 1, baselineMean: 0, baselineStdDev: 0, zScore: 5, severity: 'HIGH' as const });
  assert.equal(new TemporalAnalyzer().findEarliestAnomalousNodes([a('p:x'), a('p:y')]).size, 2);
});

test('weights: a link that went silent because its callee died keeps its pre-failure weight', () => {
  // orders normally sends 90 of 140 samples/min to the db. The db has just
  // died, so the live rate on that link is ~0 - but the baseline remembers.
  const edges = [
    edge('p:orders', 'p:db', 1, { activity: { samplesPerMin: 1, windowSec: 60, lastSeen: '', baselinePerMin: 90 } }),
    edge('p:orders', 'p:payment', 30, { activity: { samplesPerMin: 30, windowSec: 60, lastSeen: '', baselinePerMin: 30 } }),
    edge('p:orders', 'p:shipping', 20, { activity: { samplesPerMin: 20, windowSec: 60, lastSeen: '', baselinePerMin: 20 } }),
  ];
  const w = computeEdgeWeights(edges);
  assert.equal(w.get('p:orders->p:db')!.dependency, Math.round(90 / 140 * 1000) / 1000);
});

// --- anomaly detection ------------------------------------------------------

/** A metric store holding `normal` samples from 2–10 minutes ago and `recent`
 *  samples from the last 40 seconds. */
function historyStore(normal: number, recent: number, recentCount: number) {
  const now = Date.now();
  const rows: any[] = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ timestamp: new Date(now - 600_000 + i * 12_000).toISOString(), cpu: normal + (i % 3) - 1, memoryPercent: 30 });
  }
  for (let i = 0; i < recentCount; i++) {
    rows.push({ timestamp: new Date(now - 40_000 + i * 2_000).toISOString(), cpu: recent, memoryPercent: 30 });
  }
  return { getHistory: () => rows } as any;
}

test('anomaly: a sustained spike is still detected once its own samples are in the history', () => {
  // 20 samples at 97% (the last 40s) used to drag the baseline up far enough
  // that 97% stopped looking unusual. Measured on a live simulation: no anomaly.
  const detector = new AnomalyDetector(historyStore(8, 97, 20));
  const anomalies = detector.detectAnomaliesForTarget('p', [node('p:payment', 'degraded', { metrics: { cpu: 97, memoryPercent: 30 } })]);
  const cpu = anomalies.find(a => a.metric === 'cpu');
  assert.ok(cpu, 'expected a CPU anomaly');
  assert.ok(cpu!.baselineMean < 15, `baseline should reflect normal load, got ${cpu!.baselineMean}`);
});

test('anomaly: the absolute limit fires regardless of deviation, as documented', () => {
  // Always ran hot - no deviation from its own history - but past the limit.
  const detector = new AnomalyDetector(historyStore(90, 90, 20));
  const anomalies = detector.detectAnomaliesForTarget('p', [node('p:hot', 'degraded', { metrics: { cpu: 90, memoryPercent: 30 } })]);
  const cpu = anomalies.find(a => a.metric === 'cpu');
  assert.ok(cpu, 'expected the absolute threshold to fire');
  assert.equal(cpu!.evidenceSource, 'absolute-threshold');
  assert.equal(cpu!.severity, 'CRITICAL');
});

test('anomaly: normal load inside its usual range raises nothing', () => {
  const detector = new AnomalyDetector(historyStore(20, 21, 20));
  assert.equal(detector.detectAnomaliesForTarget('p', [node('p:ok', 'healthy', { metrics: { cpu: 21, memoryPercent: 30 } })]).length, 0);
});

// --- found on live targets --------------------------------------------------

import { TELEMETRY_FACTOR } from '../../algorithms/graph/EdgeWeights.js';

test('weights: telemetry export is weighted at a fraction, and does not dilute real dependencies', () => {
  // Live OTel demo: `ad` sends all its outbound traffic to otel-collector and
  // weighed 1.00 on it - a collector outage would have been predicted to take
  // the whole shop down.
  const edges = [
    edge('p:ad', 'p:otel-collector', 40),
    edge('p:payment', 'p:otel-collector', 50),
    edge('p:payment', 'p:db', 10),
  ];
  const w = computeEdgeWeights(edges);
  assert.equal(w.get('p:ad->p:otel-collector')!.kind, 'telemetry');
  assert.equal(w.get('p:ad->p:otel-collector')!.value, TELEMETRY_FACTOR);
  // payment depends on its db completely; its telemetry chatter is separate.
  assert.equal(w.get('p:payment->p:db')!.dependency, 1);
  assert.equal(w.get('p:payment->p:db')!.kind, 'request');
});

test('anomaly: a trivial wobble on a very steady service is not an anomaly', () => {
  // Live: memory 0.4% vs baseline 0.4% read as z = −8, CRITICAL.
  const now = Date.now();
  const rows = Array.from({ length: 40 }, (_, i) => ({ timestamp: new Date(now - 600_000 + i * 12_000).toISOString(), cpu: 0.2, memoryPercent: 0.40 + (i % 2) * 0.01 }));
  const detector = new AnomalyDetector({ getHistory: () => rows } as any);
  const anomalies = detector.detectAnomaliesForTarget('p', [node('p:auth', 'healthy', { metrics: { cpu: 0.3, memoryPercent: 0.5 } })]);
  assert.equal(anomalies.length, 0);
});

test('rca: a service with a real anomaly but not yet degraded can still be the root cause', () => {
  const nodes = [node('p:api'), node('p:db')];
  const anomalies = [{ id: 'a', nodeId: 'p:db', targetId: 'p', metric: 'cpu', timestamp: new Date().toISOString(), observedValue: 60, baselineMean: 10, baselineStdDev: 2, zScore: 25, severity: 'CRITICAL' as const }];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:api', 'p:db', 10)], anomalies });
  assert.equal(result.primaryRootCause?.serviceId, 'p:db');
});

test('rca: evidence names the anomaly, and a running service with no reported state is never called stopped', () => {
  // Live: promtail, running, flagged for a memory spike, was listed as
  // "healthy (stopped)" with "before: unknown" and no mention of memory.
  const nodes = [node('p:api'), node('p:promtail', 'healthy', { metrics: { cpu: 0.2, memoryPercent: 7.84 } })];
  const anomalies = [{ id: 'a', nodeId: 'p:promtail', targetId: 'p', metric: 'memoryPercent', timestamp: new Date().toISOString(), observedValue: 7.84, baselineMean: 3.02, baselineStdDev: 1.1, zScore: 4.36, severity: 'MEDIUM' as const, evidenceSource: 'dynamic-zscore' }];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:api', 'p:promtail', 10)], anomalies });
  const ev = result.evidence.find(e => e.id.startsWith('ev-p:promtail'))!;
  assert.equal(ev.metric, 'memoryPercent');
  assert.equal(ev.beforeValue, 'baseline 3');
  assert.equal(ev.afterValue, '7.8');
  assert.equal(ev.source, 'dynamic-zscore');
  assert.match(ev.description, /^memoryPercent at 7\.8 against a baseline of 3 \(medium, z = 4\.36\)/);
  assert.doesNotMatch(`${ev.afterValue} ${ev.description}`, /stopped/);
});

import { IncidentManager } from '../../server/rca/IncidentManager.js';

test('incident: the remediation is the explanation\'s investigation steps, not a stock "docker start"', () => {
  // Every incident used to get `docker start docker-compose-<name>-1`,
  // whatever its cause, under a container name that need not exist.
  const nodes = [node('p:api', 'degraded'), node('p:db', 'critical', { metadata: { state: 'exited (137)' } })];
  const edges = [edge('p:api', 'p:db', 100)];
  const graphStore = { getGraph: () => ({ nodes, edges }), metricStore: { getHistory: () => [] } } as any;
  const incident = new IncidentManager(graphStore).evaluateTarget('p')!;
  assert.ok(incident, 'a crashed database raises an incident');
  assert.deepEqual(incident.remediationGuide, incident.explanation.recommendedInvestigation);
  assert.ok(incident.remediationGuide.length > 0);
  assert.ok(incident.remediationGuide.every(step => !/docker start/.test(step)));
});

test('rca: two unrelated services running hot are reported as independent, with LOW confidence', () => {
  // Live: grafana (95% memory) was named root cause of opensearch (84%),
  // with no dependency between them.
  const nodes = [node('p:grafana', 'degraded'), node('p:opensearch', 'degraded'), node('p:web')];
  const edges = [edge('p:web', 'p:opensearch', 5)];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies: [] });
  assert.equal(result.confidence, 'LOW');
  assert.match(result.explanation.why, /independent problems/);
});

test('rca: propagation follows real chains only, not every reachable service', () => {
  // db fails; orders depends on it heavily and is degraded. The frontend calls
  // orders lightly and is healthy; reporting is lightly used by nothing failing.
  const nodes = [node('p:db', 'critical'), node('p:orders', 'degraded'), node('p:frontend'), node('p:reporting')];
  const edges = [
    edge('p:orders', 'p:db', 90),
    edge('p:frontend', 'p:orders', 5), edge('p:frontend', 'p:catalogue', 95),
    edge('p:reporting', 'p:db', 1), edge('p:reporting', 'p:warehouse', 99),
  ];
  nodes.push(node('p:catalogue'), node('p:warehouse'));
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies: [] });
  assert.deepEqual(result.explanation.propagationPath, ['db', 'orders']);
});

// --- persistence ------------------------------------------------------------

import { TraceStore } from '../../server/traces/TraceStore.js';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync as readFileSyncFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

test('traces: concurrent saves keep every event, in time order, and write compact JSON', async () => {
  const dir = mkdtempSync(joinPath(osTmpdir(), 'traces-'));
  const cwd = process.cwd();
  process.chdir(dir);
  mkdirSync('data');
  try {
    const store = new TraceStore('t');
    const ev = (ts: string, n: number) => Array.from({ length: n }, () => ({ timestamp: ts, targetId: 't', sourceServiceId: 'a', destServiceId: 'b', destPort: 1, state: 'ESTABLISHED' })) as any[];
    const now = Date.now();
    const t1 = new Date(now - 2000).toISOString();
    const t2 = new Date(now - 1000).toISOString();
    // Two saves in flight at once, the later one carrying the older batch -
    // the case that used to lose events to a read/modify/write race.
    await Promise.all([store.saveEvents(ev(t2, 3)), store.saveEvents(ev(t1, 2))]);
    const all = await store.loadEvents();
    assert.equal(all.length, 5);
    assert.deepEqual(all.map(e => e.timestamp), [t1, t1, t2, t2, t2]);
    assert.equal((await store.loadEvents(t2)).length, 3);

    await store.flush();
    const written = readFileSyncFs(joinPath(dir, 'data', 'traces_t.json'), 'utf8');
    assert.equal(JSON.parse(written).length, 5);
    assert.ok(!written.includes('\n  '), 'expected compact JSON');
    await store.clear();
    assert.equal(existsSync(joinPath(dir, 'data', 'traces_t.json')), false);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- accuracy regressions ---------------------------------------------------

test('weights: a caller\'s traffic shares always sum to exactly 100%', () => {
  // Two links with measured traffic and one declared link never seen in use:
  // the declared one used to get an even share on top of a full measured
  // split, so shares summed to 133%.
  const edges = [
    edge('p:cart', 'p:redis', 300),
    edge('p:cart', 'p:flagd', 100),
    edge('p:cart', 'p:audit', undefined, { observed: false, declared: true, evidenceSources: ['compose'] }),
  ];
  const w = computeEdgeWeights(edges);
  const shares = edges.map(e => w.get(e.id)!.dependency);
  const sum = shares.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.002, `shares sum to ${sum}`);
  // The unmeasured link gets an even slice, 1/N; the measured ones split the
  // rest 3:1 by traffic.
  assert.ok(Math.abs(w.get('p:cart->p:audit')!.dependency - 1 / 3) < 0.002);
  assert.equal(w.get('p:cart->p:audit')!.dependencyBasis, 'uniform');
  assert.ok(Math.abs(w.get('p:cart->p:redis')!.dependency - 0.5) < 0.002);
  assert.ok(Math.abs(w.get('p:cart->p:flagd')!.dependency - 1 / 6) < 0.002);
});

test('rca: a faint telemetry path does not count as explaining other failures', () => {
  // grafana degraded first; checkout and payment degraded on their own. The
  // only path from them to grafana runs through a proxy's telemetry-weighted
  // link: strength well under 10%. That is not an explanation.
  const nodes = [
    node('p:grafana', 'degraded'), node('p:checkout', 'degraded'), node('p:payment', 'degraded'),
    node('p:frontend-proxy'),
  ];
  const edges = [
    edge('p:frontend-proxy', 'p:grafana', 50), edge('p:frontend-proxy', 'p:checkout', 500),
    edge('p:checkout', 'p:frontend-proxy', 5), edge('p:payment', 'p:frontend-proxy', 5),
    edge('p:checkout', 'p:payment', 200),
  ];
  const anomalies = [{ nodeId: 'p:grafana', metric: 'memory', value: 95, timestamp: new Date(Date.now() - 60_000).toISOString(), severity: 'high' }] as any;
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies });
  const graf = result.candidateCauses.find(c => c.serviceId === 'p:grafana')!;
  const explains = graf.scoreBreakdown.find(b => b.factor === 'explains_failures');
  assert.ok(!explains || explains.score >= 0.01, 'a zero-point factor must not be listed');
  // No factor anywhere may read "+0.00".
  for (const c of result.candidateCauses) for (const b of c.scoreBreakdown) assert.ok(!/^\+0\.00/.test(b.reason), b.reason);
});

test('rca: when the top candidate explains none of the others, confidence is LOW and the text says so', () => {
  const nodes = [node('p:a', 'critical'), node('p:b', 'degraded'), node('p:c'), node('p:d')];
  // b calls c; a calls d; nothing depends on a, so a explains nothing about b.
  const edges = [edge('p:b', 'p:c', 100), edge('p:a', 'p:d', 10)];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies: [] });
  assert.equal(result.primaryRootCause!.serviceId, 'p:a');
  assert.equal(result.confidence, 'LOW');
  assert.match(result.explanation.why, /independent problems/);
  assert.doesNotMatch(result.explanation.why, /depend on it/);
});

test('rca: the explanation states how many of the others depend on the cause', () => {
  // db is down; orders depends on it, frontend degraded on its own.
  const nodes = [node('p:db', 'critical'), node('p:orders', 'degraded'), node('p:frontend', 'degraded'), node('p:cdn')];
  const edges = [edge('p:orders', 'p:db', 100), edge('p:frontend', 'p:cdn', 100)];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies: [] });
  assert.equal(result.primaryRootCause!.serviceId, 'p:db');
  assert.match(result.explanation.why, /1 of the 2 other affected services depend on it/);
});

test('rca: affected services are node ids, like every other service reference', () => {
  const nodes = [node('p:db', 'critical'), node('p:orders', 'degraded')];
  const result = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:orders', 'p:db', 100)], anomalies: [] });
  assert.deepEqual([...result.affectedServices].sort(), ['p:db', 'p:orders']);
  // Display names stay names.
  assert.deepEqual([...result.explanation.affectedServices].sort(), ['db', 'orders']);
});

// --- collection precision ---------------------------------------------------

import { decodeProcNetIp, parseNetDev } from '../../server/telemetry-platform/src/collection/MetricCollector.js';

test('proc net: IPv4 and IPv4-mapped IPv6 addresses decode to the same address', () => {
  assert.equal(decodeProcNetIp('0100007F'), '127.0.0.1');
  assert.equal(decodeProcNetIp('050012AC'), '172.18.0.5');
  // ::ffff:172.18.0.5 as tcp6 prints it. This used to decode as 0.0.0.0,
  // which matched no service, so the connection was dropped.
  assert.equal(decodeProcNetIp('0000000000000000FFFF0000050012AC'), '172.18.0.5');
  assert.equal(decodeProcNetIp('0000000000000000ffff0000050012ac'), '172.18.0.5');
  // A genuine IPv6 address is not a container on these networks.
  assert.equal(decodeProcNetIp('B80D01200000000000000000010000000'.slice(0, 32)), '');
  assert.equal(decodeProcNetIp('nonsense'), '');
});

test('proc net: interface byte counters are exact and exclude loopback', () => {
  const dev = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:  901234     100    0    0    0     0          0         0   901234     100    0    0    0     0       0          0',
    '  eth0: 527338211 412345   0    0    0     0          0         0 579104422  398765    0    0    0     0       0          0',
    '  eth1:     1000      10   0    0    0     0          0         0      2000      20    0    0    0     0       0          0',
  ].join('\n');
  assert.deepEqual(parseNetDev(dev), { rxBytes: 527339211, txBytes: 579106422 });
  assert.equal(parseNetDev('no interfaces here'), null);
});

import { cpuShareOfAllowance } from '../../server/telemetry-platform/src/collection/containerHealth.js';

test('cpu: saturation is judged against the container\'s allowance, not one core', () => {
  // 180% of one core on a 4-core host is 45% of what it may use: healthy.
  assert.equal(statusFromSample(sample({ cpuPercent: 180, cpuAllowanceCores: 4 })).status, 'healthy');
  // 60% of one core with a half-core limit is pinned at its limit: degraded,
  // and the reason says against what.
  const pinned = statusFromSample(sample({ cpuPercent: 60, cpuAllowanceCores: 0.5 }));
  assert.equal(pinned.status, 'degraded');
  assert.match(pinned.reason, /CPU 100% of its 0\.5-core allowance/);
  // Allowance unknown: falls back to the per-core figure, as before.
  assert.equal(statusFromSample(sample({ cpuPercent: 85 })).status, 'degraded');
  assert.equal(cpuShareOfAllowance(150, 2), 75);
  assert.equal(cpuShareOfAllowance(null, 2), null);
});

// --- the self-check ---------------------------------------------------------

import { checkConsistency } from '../../algorithms/graph/consistency.js';

test('consistency: correct output passes, and each known fault is named', () => {
  const nodes = [node('p:web'), node('p:api'), node('p:db', 'critical')];
  const edges = weigh([edge('p:web', 'p:api', 100), edge('p:api', 'p:db', 50), edge('p:api', 'p:cache', 50)]);
  nodes.push(node('p:cache'));
  assert.deepEqual(checkConsistency(nodes, edges).violations, []);

  // Shares over 100%.
  const broken = edges.map((e) => ({ ...e, weight: e.weight && { ...e.weight } }));
  broken[1].weight!.dependency = 0.9; broken[1].weight!.value = 0.9;
  assert.ok(checkConsistency(nodes, broken).violations.some((v) => v.rule === 'reliance-sums-to-one'));

  // An incident naming a service by name, not id.
  const incident: any = {
    id: 'inc-1', targetId: 'p', status: 'INCIDENT', rootCauseServiceId: 'p:db', rootCauseScore: 0.8,
    affectedServices: ['db', 'p:api'], candidateCauses: [{ serviceId: 'p:db' }],
  };
  const refs = checkConsistency(nodes, edges, [incident]).violations.filter((v) => v.rule === 'incident-references');
  assert.equal(refs.length, 1);
  assert.match(refs[0].detail, /refers to db/);

  // A cumulative byte total shown as a rate.
  const totals = nodes.map((n) => (n.id === 'p:web' ? { ...n, metrics: { networkRxRate: 527_000_000_000 } } : n));
  assert.ok(checkConsistency(totals as any, edges).violations.some((v) => v.rule === 'rate-not-total'));
});
