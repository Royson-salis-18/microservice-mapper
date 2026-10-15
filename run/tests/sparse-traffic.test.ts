import test from 'node:test';
import assert from 'node:assert/strict';
import { AnomalyDetector } from '../../server/algorithms/detection/AnomalyDetector.ts';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const node = { id: 'p:svc', name: 'svc', project: 'p', status: 'healthy', type: 'service', metadata: { state: 'running' } } as any;
const detect = (history: any[]) => new AnomalyDetector({ getHistory: () => history } as any).detectAnomaliesForTarget('p', [node]);
const sample = (i: number, over: Record<string, unknown>) => ({ timestamp: new Date(T0 + i * 8000).toISOString(), cpu: 1, networkRxRate: 500, networkTxRate: 500, ...over });

test('a service that gets a request every few seconds is not "silent" for three quiet samples', () => {
  // bursty traffic: runs of up to three quiet samples are ordinary here
  const h = Array.from({ length: 60 }, (_, i) => sample(i, { requestRate: i % 7 < 3 ? 0 : 0.4, requestCount: i % 7 < 3 ? 0 : 3, cpu: 0.2, networkRxRate: 0, networkTxRate: 0 }));
  for (let i = 60; i < 63; i++) h.push(sample(i, { requestRate: 0, requestCount: 0, cpu: 0.2, networkRxRate: 0, networkTxRate: 0 }));
  assert.equal(detect(h).filter((a) => a.metric === 'silence').length, 0);
});

test('a busy service that stops receiving requests IS silent', () => {
  const h = Array.from({ length: 60 }, (_, i) => sample(i, { requestRate: 5 + (i % 3) * 0.2, requestCount: 40 }));
  for (let i = 60; i < 64; i++) h.push(sample(i, { requestRate: 0, requestCount: 0 }));
  assert.equal(detect(h).filter((a) => a.metric === 'silence').length, 1);
});

test('p95 from a handful of requests is not a trend', () => {
  const h = Array.from({ length: 60 }, (_, i) => sample(i, { requestRate: 0.3, requestCount: 2, p95Latency: 5 }));
  h.push(sample(60, { requestRate: 0.3, requestCount: 2, p95Latency: 900 }), sample(61, { requestRate: 0.3, requestCount: 2, p95Latency: 900 }));
  assert.equal(detect(h).filter((a) => a.metric === 'latency').length, 0);
});

test('p95 from plenty of requests that jumps IS reported', () => {
  const h = Array.from({ length: 60 }, (_, i) => sample(i, { requestRate: 5, requestCount: 40, p95Latency: 5 + (i % 3) }));
  h.push(sample(60, { requestRate: 5, requestCount: 40, p95Latency: 900 }), sample(61, { requestRate: 5, requestCount: 40, p95Latency: 950 }));
  assert.equal(detect(h).filter((a) => a.metric === 'latency').length, 1);
});

test('a CPU limit that starts holding the service back is its own evidence (brownout on the culprit)', () => {
  const h = Array.from({ length: 40 }, (_, i) => sample(i, { cpuThrottledPct: i % 4 }));
  h.push(sample(40, { cpuThrottledPct: 70 }), sample(41, { cpuThrottledPct: 75 }));
  const a = detect(h).find((x) => x.metric === 'cpuThrottledPct');
  assert.ok(a && a.evidence === 'own');
});
