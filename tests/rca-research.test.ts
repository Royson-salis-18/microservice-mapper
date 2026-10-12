/**
 * The research method ported into the mapper (new-repo/core): silence, noise normalisation, one-sided scoring,
 * self-healing baseline, source-vs-victim attribution, blind spots, monitoring outages and cascade risk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AnomalyDetector, robustScore } from '../server/rca/AnomalyDetector.ts';
import { RCAEngine } from '../server/rca/RCAEngine.ts';
import { IncidentManager } from '../server/rca/IncidentManager.ts';
import { DEFAULT_THRESHOLDS } from '../server/rca/thresholds.ts';

const T = DEFAULT_THRESHOLDS;
const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i * 5)).toISOString();
const node = (id: string, extra: Record<string, unknown> = {}): any =>
  ({ id, name: id, project: 'p', status: 'healthy', metrics: { cpu: 10 }, metadata: { state: 'running' }, ...extra });
const edge = (source: string, target: string): any =>
  ({ id: `${source}->${target}`, source, target, type: 'http', declared: false, observed: true, evidenceSources: [], status: 'active', metrics: null });
const anomaly = (nodeId: string, metric: string, z: number, evidence: 'own' | 'symptom' | 'hard'): any =>
  ({ id: `${nodeId}-${metric}`, nodeId, targetId: 'p', metric, timestamp: ts(1), observedValue: 1, baselineMean: 0, baselineStdDev: 1,
     zScore: z, severity: 'HIGH', evidence });
const store = (series: Record<string, any[]>): any => ({ getHistory: (id: string) => (series[id] ?? []).map((h, i) => ({ timestamp: ts(i), ...h })) });
const wobble = (n: number, base: number, amp: number) => Array.from({ length: n }, (_, i) => base + amp * (((i * 7) % 5) - 2) / 2);

// ---------------------------------------------------------------- detector

test('silence: a busy service that suddenly does nothing is caught (a frozen process sends no errors)', () => {
  const busy = wobble(40, 20, 4).map(cpu => ({ cpu, networkRxRate: 5000, networkTxRate: 4000 }));
  const frozen = [...busy, ...Array(3).fill({ cpu: 0, networkRxRate: 0, networkTxRate: 0 })];
  const out = new AnomalyDetector(store({ a: frozen })).detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 0 } })]);
  const s = out.find(x => x.metric === 'silence');
  assert.ok(s, 'silence anomaly expected');
  assert.equal(s!.evidence, 'own');
});

test('silence: a service that is idle most of the time going quiet is NOT an anomaly', () => {
  const idle = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? { cpu: 3, networkRxRate: 100 } : { cpu: 0, networkRxRate: 0 }));
  const out = new AnomalyDetector(store({ a: [...idle, ...Array(3).fill({ cpu: 0, networkRxRate: 0 })] }))
    .detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 0 } })]);
  assert.equal(out.filter(x => x.metric === 'silence').length, 0);
});

test('one-sided: latency getting FASTER is never an anomaly, getting slower is', () => {
  const base = wobble(40, 100, 6).map(latency => ({ latency, cpu: 10 }));
  const faster = new AnomalyDetector(store({ a: [...base, { latency: 10 }, { latency: 10 }] }))
    .detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 10, latency: 10 } })]);
  assert.equal(faster.filter(x => x.metric === 'latency').length, 0);
  const slower = new AnomalyDetector(store({ a: [...base, { latency: 900 }, { latency: 900 }] }))
    .detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 10, latency: 900 } })]);
  const l = slower.find(x => x.metric === 'latency');
  assert.ok(l && l.evidence === 'symptom');
});

test('traffic is judged as a DROP (requests falling), errors as a rise', () => {
  const base = wobble(40, 50, 4).map(requestRate => ({ requestRate, errorRate: 0.01 }));
  const out = new AnomalyDetector(store({ a: [...base, { requestRate: 2, errorRate: 0.4 }, { requestRate: 2, errorRate: 0.5 }] }))
    .detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 10, requestRate: 2, errorRate: 0.5 } })]);
  assert.ok(out.some(x => x.metric === 'requestRate'));
  assert.ok(out.some(x => x.metric === 'errorRate'));
});

test('noise normalisation: a series that is jumpy when healthy needs a bigger jump to alarm', () => {
  const spec = { direction: 1 as const, scale: 'log' as const, unit: 1, floor: 0.15 };
  const calm = robustScore(wobble(60, 100, 2), [160, 160], spec, 12)!;
  const spiky = wobble(60, 100, 2); spiky[20] = 400; spiky[45] = 380;                    // healthy history with one-off spikes
  const jumpy = robustScore(spiky, [160, 160], spec, 12)!;
  assert.ok(calm.z[1] > jumpy.z[1], `calm ${calm.z[1]} should exceed jumpy ${jumpy.z[1]}`);
});

test('self-healing baseline: an earlier anomaly does not become "normal"', () => {
  const spec = { direction: 1 as const, scale: 'log' as const, unit: 1, floor: 0.15 };
  const withOldFault = robustScore([...wobble(40, 100, 3), ...Array(8).fill(900)], [900, 900], spec, 12)!;
  assert.ok(withOldFault.z[1] >= T.zScoreAnomaly, `still anomalous: z=${withOldFault.z[1]}`);
});

test('cold start: too little history says nothing', () => {
  const out = new AnomalyDetector(store({ a: [{ cpu: 1 }, { cpu: 99 }, { cpu: 99 }] })).detectAnomaliesForTarget('p', [node('a', { metrics: { cpu: 99 } })]);
  assert.equal(out.filter(x => x.metric === 'cpu').length, 0);
});

test('a restart since the last sample is hard evidence', () => {
  const h = [...wobble(20, 10, 1).map(cpu => ({ cpu })), { cpu: 10, restartDelta: 1 }];
  const out = new AnomalyDetector(store({ a: h })).detectAnomaliesForTarget('p', [node('a')]);
  assert.ok(out.some(x => x.metric === 'restarts' && x.evidence === 'hard'));
});

// ---------------------------------------------------------------- RCA

test('rca: the source outranks callers whose errors it explains (explain-away)', () => {
  // gateway -> orders -> db. db is slow on its OWN time; orders and gateway only show inherited errors.
  const nodes = [node('gateway'), node('orders'), node('db')];
  const edges = [edge('gateway', 'orders'), edge('orders', 'db')];
  const anomalies = [anomaly('db', 'cpu', 9, 'own'), anomaly('orders', 'errorRate', 12, 'symptom'), anomaly('gateway', 'errorRate', 10, 'symptom')];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges, anomalies });
  assert.equal(res.primaryRootCause?.serviceId, 'db');
  const orders = res.candidateCauses.find(c => c.serviceId === 'orders')!;
  assert.ok(orders.scoreBreakdown.some(b => b.factor === 'likely_victim'));
});

test('rca: with gamma = 0 the ranking is plain "most abnormal"', () => {
  const nodes = [node('gateway'), node('orders'), node('db')];
  const anomalies = [anomaly('db', 'cpu', 9, 'own'), anomaly('orders', 'errorRate', 12, 'symptom')];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('gateway', 'orders'), edge('orders', 'db')], anomalies,
    thresholds: { ...T, explainAwayGamma: 0 } });
  assert.equal(res.primaryRootCause?.serviceId, 'orders');
});

test('rca: a paused container is hard evidence and wins with HIGH confidence', () => {
  const nodes = [node('front'), node('cart', { status: 'critical', metadata: { state: 'paused' } })];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('front', 'cart')],
    anomalies: [anomaly('front', 'latency', 15, 'symptom'), anomaly('cart', 'container-health', 0, 'hard')] });
  assert.equal(res.primaryRootCause?.serviceId, 'cart');
  assert.equal(res.primaryRootCause?.confidence, 'HIGH');
});

test('rca: a silent service is not blamed when a service it calls broke loudly (quiet is inherited)', () => {
  const nodes = [node('api'), node('db', { status: 'critical', metadata: { state: 'exited' } })];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('api', 'db')],
    anomalies: [anomaly('api', 'silence', 20, 'own')] });
  assert.equal(res.primaryRootCause?.serviceId, 'db');
});

test('rca: a service with NO telemetry whose callers fail unexplained is inferred (blind spot)', () => {
  const nodes = [node('web'), node('hidden', { metrics: null })];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('web', 'hidden')], anomalies: [anomaly('web', 'errorRate', 10, 'symptom')] });
  const hidden = res.candidateCauses.find(c => c.serviceId === 'hidden');
  assert.ok(hidden && hidden.scoreBreakdown.some(b => b.factor === 'blind_spot'));
});

test('rca: most services silent at once is a monitoring outage, nobody is blamed', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(id => node(id));
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [], anomalies: ['a', 'b', 'c', 'd', 'e'].map(id => anomaly(id, 'silence', 20, 'own')) });
  assert.equal(res.monitoringGap, true);
  assert.equal(res.primaryRootCause, null);
});

test('rca: healthy callers of a broken service are listed as at risk (cascade)', () => {
  // web -> api -> db ; db down, api not (yet) affected, web further away
  const nodes = [node('web'), node('api'), node('db', { status: 'critical', metadata: { state: 'exited' } })];
  const res = new RCAEngine().analyzeIncident({ targetId: 'p', nodes, edges: [edge('web', 'api'), edge('api', 'db')], anomalies: [] });
  assert.deepEqual(res.atRisk.map(a => a.serviceId), ['api']);
  assert.ok(res.atRisk[0].risk > 0 && res.atRisk[0].risk <= 1);
  assert.deepEqual(res.atRisk[0].via, ['db']);
});

test('incident: remediation names the real container and the right command', () => {
  const nodes = [node('cart', { status: 'critical', metadata: { state: 'paused', containerName: 'shopflow-cart-1' } })];
  const graphStore: any = { metricStore: { getHistory: () => [] }, getGraph: () => ({ nodes, edges: [] }) };
  const inc = new IncidentManager(graphStore).evaluateTarget('p')!;
  assert.equal(inc.rootCauseServiceId, 'cart');
  assert.equal(inc.remediationGuide[0], 'docker unpause shopflow-cart-1');
});
