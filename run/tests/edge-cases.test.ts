import test from 'node:test';
import assert from 'node:assert/strict';
import { containerFact } from '../../algorithms/detection/containerFacts.ts';
import { RCAEngine } from '../../algorithms/rca/RCAEngine.ts';
import { AnomalyDetector } from '../../algorithms/detection/AnomalyDetector.ts';
import { computeProjectRisk as computeRisk } from '../../server/graph/RiskEngine.ts';

const node = (id: string, status: any = 'healthy', metadata: any = {}, metrics: any = null) => {
  const [project, name] = id.split(':'); return { id, name, type: 'service', project, status, metadata, metrics } as any;
};
const edge = (s: string, t: string) => ({ id: `${s}->${t}`, source: s, target: t, type: 'dependency', declared: false, observed: true, evidenceSources: ['network-tcp'], metrics: null, activity: { samplesPerMin: 60, windowSec: 60, lastSeen: new Date().toISOString() }, status: 'active' }) as any;
const anomaly = (nodeId: string, metric: string, z: number, evidence = 'symptom') => ({ id: `a-${nodeId}-${metric}`, nodeId, targetId: 'p', metric, timestamp: new Date().toISOString(), observedValue: 1, baselineMean: 0, baselineStdDev: 1, zScore: z, reason: 'robust-zscore-persistent', severity: 'HIGH', evidenceSource: 'dynamic-zscore', evidence }) as any;

test('container facts: a finished job, a never-started container and a switched-off load generator are not failures', () => {
  assert.equal(containerFact(node('p:migrate', 'unknown', { state: 'exited (0)' })), 'benign');
  assert.equal(containerFact(node('p:migrate', 'critical', { state: 'exited', exitCode: 0 })), 'benign');
  assert.equal(containerFact(node('p:init', 'unknown', { state: 'created' })), 'benign');
  assert.equal(containerFact(node('p:traffic', 'critical', { state: 'exited', exitCode: 137 })), 'benign');
  assert.equal(containerFact(node('p:orders', 'critical', { state: 'exited (137)' })), 'down');      // SSH path label: still a crash
  assert.equal(containerFact(node('p:orders', 'critical', { state: 'exited', exitCode: 1 })), 'down');
  assert.equal(containerFact(node('p:db', 'critical', { state: 'running', networkDetached: true })), 'detached');
  assert.equal(containerFact(node('p:db', 'degraded', { state: 'paused' })), 'paused');
  assert.equal(containerFact(node('p:db', 'healthy', { state: 'running' })), null);
});

test('a finished job raises no anomaly and no incident', () => {
  const det = new AnomalyDetector({ getHistory: () => [] } as any);
  assert.equal(det.detectAnomaliesForTarget('p', [node('p:migrate', 'unknown', { state: 'exited (0)' })]).length, 0);
});

test('a node with no data is not blamed on one noisy caller', () => {
  const nodes = [node('p:api', 'healthy', { state: 'running' }, { cpu: 3 }), node('p:db', 'unknown', { state: 'running' }, null)];
  const r = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:api', 'p:db')], anomalies: [anomaly('p:api', 'latency', 3.6)] });
  assert.notEqual(r.primaryRootCause?.serviceId, 'p:db');
});

test('a node with no data CAN be inferred when two callers suffer and nothing else explains it', () => {
  const nodes = [node('p:a', 'healthy', { state: 'running' }, { cpu: 3 }), node('p:b', 'healthy', { state: 'running' }, { cpu: 3 }), node('p:db', 'unknown', { state: 'running' }, null)];
  const r = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:a', 'p:db'), edge('p:b', 'p:db')], anomalies: [anomaly('p:a', 'errorRate', 4), anomaly('p:b', 'errorRate', 4)] });
  assert.ok(r.candidateCauses.some((c) => c.serviceId === 'p:db'));
});

test('a host that stopped sending data blames no service', () => {
  const nodes = [node('p:a', 'critical', { state: 'exited (1)' }), node('p:b'), node('p:c')];
  const r = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [], anomalies: [], hostSilent: true });
  assert.equal(r.primaryRootCause, null);
  assert.equal(r.monitoringGap, true);
  assert.match(r.explanation.whatHappened, /No telemetry/);
});

test('no data is no evidence: an unmeasured service does not look riskier than a healthy one', () => {
  const nodes = [node('p:a', 'healthy'), node('p:b', 'unknown')];
  const risk = computeRisk(nodes, [edge('p:a', 'p:b')], []);
  const of = (id: string) => risk.get(id)!;
  assert.ok(of('p:b').healthScore >= of('p:a').healthScore - 1e-9, `${of('p:b').healthScore} vs ${of('p:a').healthScore}`);
});

test('with a learned model, its probabilities decide the alarm and the order, and the breakdown names the features', () => {
  const nodes = [node('p:api', 'healthy', { state: 'running' }, { cpu: 3 }), node('p:db', 'healthy', { state: 'running' }, { cpu: 3 })];
  const p = new Map([['p:api', 0.2], ['p:db', 0.93]]);
  const why = new Map([['p:db', [{ feature: 'throttle', value: 2.1 }, { feature: 'callersSymptomMax', value: 1.2 }]], ['p:api', [{ feature: 'latRise', value: 0.9 }]]]);
  const quiet = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:api', 'p:db')], anomalies: [], learned: { p, why, alarm: false, threshold: 0.6, labels: {} } });
  assert.equal(quiet.incidentDetected, false);
  const r = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('p:api', 'p:db')], anomalies: [], learned: { p, why, alarm: true, threshold: 0.6, labels: { throttle: 'held back by its CPU limit' } } });
  assert.equal(r.primaryRootCause?.serviceId, 'p:db');
  assert.equal(r.primaryRootCause?.score, 0.93);
  assert.match(r.primaryRootCause!.scoreBreakdown[0].reason, /CPU limit/);
});
