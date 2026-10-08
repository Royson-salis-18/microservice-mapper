/**
 * Incident detection and root-cause ranking. These rules had no tests, and the
 * first ones written found two real bugs (victims ranked above the failing
 * service; anomalies on running services produced incidents with no cause).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AnomalyDetector } from '../server/rca/AnomalyDetector.ts';
import { RCAEngine } from '../server/rca/RCAEngine.ts';
import { DEFAULT_THRESHOLDS } from '../server/rca/thresholds.ts';

const T = DEFAULT_THRESHOLDS;
const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i * 10)).toISOString();

function node(id: string, extra: Record<string, unknown> = {}): any {
  return { id, name: id, project: 'p', status: 'healthy', metrics: {}, metadata: { state: 'running' }, ...extra };
}
function edge(source: string, target: string): any {
  return { id: `p:${source}->${target}`, source, target, type: 'http', declared: false, observed: true, evidenceSources: [], status: 'active', metrics: null };
}
function detector(series: Record<string, (number | undefined)[]>) {
  const store: any = { getHistory: (id: string) => (series[id] ?? []).map((cpu, i) => ({ timestamp: ts(i), cpu, memoryPercent: 20 })) };
  return new AnomalyDetector(store);
}
// healthy CPU around 20% with realistic jitter
const healthy = (n: number) => Array.from({ length: n }, (_, i) => 20 + ((i * 7) % 5) - 2);

test('detector: one spike is not an incident (persistence)', () => {
  const s = [...healthy(40), 95];
  const d = detector({ a: s });
  const out = d.detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 95, memoryPercent: 20 } })]);
  assert.equal(out.filter(x => x.metric === 'cpu').length, 0);
});

test('detector: two consecutive deviating samples are an incident', () => {
  const s = [...healthy(40), 90, 95];
  const d = detector({ a: s });
  const out = d.detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 95, memoryPercent: 20 } })]);
  const cpu = out.filter(x => x.metric === 'cpu');
  assert.equal(cpu.length, 1);
  assert.equal(cpu[0].reason, 'robust-zscore-persistent');
});

test('detector: a missing reading is unknown, not a drop to 0', () => {
  const s: (number | undefined)[] = [...healthy(40), undefined, undefined, 20, 21];
  const d = detector({ a: s });
  const out = d.detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 21, memoryPercent: 20 } })]);
  assert.equal(out.filter(x => x.metric === 'cpu').length, 0);
});

test('detector: the samples being judged are not part of their own baseline', () => {
  const d = new AnomalyDetector({ getHistory: () => [] } as any);
  // baseline 20 +- 2; recent [60, 60]: with the anomaly averaged in, the old code's z shrank
  const r = d.calculateZScore(healthy(30), [60, 60], 'cpu', 'a', 'p', ts(0), T);
  assert.ok(r && r.zScore !== null && r.zScore > 10);
});

test('detector: a paused container is a container-health anomaly', () => {
  const d = detector({});
  const out = d.detectAnomaliesForTarget('p', [node('a', { metadata: { state: 'paused' } })]);
  assert.equal(out[0]?.reason, 'container-paused');
});

test('rca: the failing service outranks the caller that fails because of it', () => {
  // gateway -> orders -> db ; db crashed, orders and gateway fail as victims
  const nodes = [node('gateway', { status: 'degraded' }), node('orders', { status: 'critical' }), node('db', { status: 'critical', metadata: { state: 'exited' } })];
  const edges = [edge('gateway', 'orders'), edge('orders', 'db')];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies: [] });
  assert.equal(res.primaryRootCause?.serviceId, 'db');
  const victim = res.candidateCauses.find(c => c.serviceId === 'orders')!;
  assert.ok(victim.scoreBreakdown.some(b => b.factor === 'likely_victim'));
});

test('rca: an anomaly on a running service makes it a candidate', () => {
  const nodes = [node('a'), node('b')];
  const anomalies: any[] = [{ id: 'x', nodeId: 'b', targetId: 'p', metric: 'cpu', timestamp: ts(1), observedValue: 95, baselineMean: 20, baselineStdDev: 2, zScore: 30, severity: 'CRITICAL' }];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('a', 'b')], anomalies });
  assert.equal(res.incidentDetected, true);
  assert.equal(res.primaryRootCause?.serviceId, 'b');
});

test('rca: the propagation path runs from the cause to its callers', () => {
  const nodes = [node('gateway', { status: 'degraded' }), node('orders', { status: 'critical' }), node('db', { status: 'critical', metadata: { state: 'exited' } })];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('gateway', 'orders'), edge('orders', 'db')], anomalies: [] });
  assert.deepEqual(res.propagation.map(s => [s.sourceId, s.targetId]), [['db', 'orders'], ['orders', 'gateway']]);
});

test('rca: scores stay within 0..1 after the victim penalty', () => {
  const nodes = [node('a', { status: 'degraded' }), node('b', { status: 'critical' })];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('a', 'b')], anomalies: [] });
  for (const c of res.candidateCauses) assert.ok(c.score >= 0 && c.score <= 1);
});
