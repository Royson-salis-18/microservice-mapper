import test from 'node:test';
import assert from 'node:assert/strict';
import { fitForest, scoreForest, cFactor, rng } from '../../server/algorithms/ml/isolationForest.ts';
import { ServiceBaseline, readingVector, BASELINE_DEFAULTS } from '../../server/algorithms/ml/serviceBaseline.ts';
import { rootCauseWalk } from '../../server/algorithms/ml/randomWalk.ts';
import { MLEngine, ENGINE_DEFAULTS, resolveDirections, tierOf } from '../../server/algorithms/ml/mlEngine.ts';

const normal = (seed: number, n: number, mu = 10, sd = 0.5) => { const r = rng(seed); return Array.from({ length: n }, () => { const u = Math.max(1e-9, r()), v = r(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }); };
const reading = (cpu: number, extra: Record<string, number> = {}) => ({ timestamp: '', cpu, memoryPercent: 30, networkRxRate: 5000, networkTxRate: 4000, requestRate: 20, requestCount: 200, errorRate: 0, p95Latency: 40, cpuThrottledPct: 0, ...extra });

test('isolation forest: c(n) matches the textbook values', () => {
  assert.equal(cFactor(2), 1);
  // the paper approximates the harmonic number H(i) by ln(i) + 0.5772, which gives 2.71 for n = 6 (exact: 2.9)
  assert.ok(Math.abs(cFactor(6) - 2.707) < 0.01);
});

test('isolation forest: an outlier scores higher than a normal point, and the result is repeatable', () => {
  const X = normal(1, 200).map((v, i) => [v, normal(2, 200)[i]]);
  const f = fitForest(X, { seed: 3 });
  assert.ok(scoreForest(f, [30, 10]) > scoreForest(f, [10, 10]) + 0.1);
  assert.equal(scoreForest(fitForest(X, { seed: 3 }), [30, 10]), scoreForest(f, [30, 10]));
});

test('baseline: no verdict before enough history (cold start)', () => {
  const b = new ServiceBaseline(1);
  const v = b.observe(readingVector(reading(10)));
  assert.equal(v.ready, false);
  assert.equal(v.level, 0);
});

test('baseline: a jump is flagged and is NOT learned as normal', () => {
  const b = new ServiceBaseline(1);
  for (const c of normal(5, 80)) b.observe(readingVector(reading(c)));
  const before = b.size;
  const v = b.observe(readingVector(reading(60)));
  assert.ok(v.level >= 1, `level ${v.level}`);
  assert.equal(v.accepted, false);
  assert.equal(b.size, before);
  // ordinary readings keep being learned
  assert.equal(b.observe(readingVector(reading(10))).accepted, true);
});

test('baseline: a jump in a feature that never moved (error share) is still caught', () => {
  const b = new ServiceBaseline(2);
  for (const c of normal(6, 80)) b.observe(readingVector(reading(c)));
  const v = b.observe(readingVector(reading(10, { errorRate: 0.4, p95Latency: 400 })));
  assert.ok(v.symptom >= 1, `symptom level ${v.symptom}`);
});

test('baseline: a long-lasting change is eventually accepted as the new normal (drift)', () => {
  const b = new ServiceBaseline(3, { ...BASELINE_DEFAULTS, driftAfter: 5 });
  for (const c of normal(7, 60)) b.observe(readingVector(reading(c)));
  const verdicts = Array.from({ length: 8 }, () => b.observe(readingVector(reading(40))));
  assert.ok(verdicts.some((v) => v.accepted));
});

test('random walk: the source of a chain collects the most time, not its callers', () => {
  // web -> orders -> db, db broken, callers show inherited symptoms
  const rank = rootCauseWalk(['web', 'orders', 'db'], new Map([['web', 0.6], ['orders', 0.7], ['db', 0.9]]),
    [{ from: 'web', to: 'orders', weight: 1 }, { from: 'orders', to: 'db', weight: 1 }]);
  assert.ok(rank.get('db')! > rank.get('orders')! && rank.get('orders')! > 0);
  assert.ok(Math.abs([...rank.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('random walk: a caller with its own resource trouble keeps the walker', () => {
  const a = new Map([['web', 0.8], ['db', 0.8]]);
  const edges = [{ from: 'web', to: 'db', weight: 1 }];
  const plain = rootCauseWalk(['web', 'db'], a, edges);
  const withOwn = rootCauseWalk(['web', 'db'], a, edges, {}, new Map([['web', 0.9]]));
  assert.ok(withOwn.get('web')! > plain.get('web')!);
});

test('random walk: nothing anomalous gives no ranking mass', () => {
  const r = rootCauseWalk(['a', 'b'], new Map(), [{ from: 'a', to: 'b', weight: 1 }]);
  assert.equal(r.get('a'), 0);
});

test('directions: a pair seen from both ends keeps the downward direction', () => {
  const nodes = new Map([['api-gateway', { id: 'api-gateway', name: 'api-gateway' }], ['orders', { id: 'orders', name: 'orders' }], ['orders-db', { id: 'orders-db', name: 'orders-db' }]]);
  assert.equal(tierOf(nodes.get('api-gateway')), 0);
  assert.equal(tierOf(nodes.get('orders-db')), 2);
  const out = resolveDirections([{ source: 'orders', target: 'orders-db' }, { source: 'orders-db', target: 'orders' }, { source: 'api-gateway', target: 'orders' }, { source: 'orders', target: 'api-gateway' }], (id) => nodes.get(id));
  assert.deepEqual(out.map((e) => `${e.from}>${e.to}`).sort(), ['api-gateway>orders', 'orders>orders-db']);
});

test('engine: a stopped container is ranked first and raises the alarm', () => {
  const e = new MLEngine(ENGINE_DEFAULTS);
  const nodes = [{ id: 'web', name: 'web' }, { id: 'db', name: 'db', status: 'critical', metadata: { state: 'exited', exitCode: 137 } }];
  const r = e.step(nodes, [{ source: 'web', target: 'db' }], new Map());
  assert.equal(r.ranked[0], 'db');
  assert.ok(r.hot);
});

test('engine: a quiet, healthy system raises nothing once learned', () => {
  const e = new MLEngine(ENGINE_DEFAULTS);
  const nodes = [{ id: 'web', name: 'web' }, { id: 'api', name: 'api' }];
  const cpu = normal(9, 120);
  let r: any;
  for (let i = 0; i < 120; i++) r = e.step(nodes, [{ source: 'web', target: 'api' }], new Map([['web', [reading(cpu[i])]], ['api', [reading(cpu[(i + 7) % 120])]]]));
  assert.ok(r.ready);
  assert.equal(r.services.get('web').hard, false);
});

test('engine: docker stop (exit code 0) of a service that was running counts as down', () => {
  const e = new MLEngine(ENGINE_DEFAULTS);
  const run = { id: 'db', name: 'db', metadata: { state: 'running' } };
  for (let i = 0; i < 15; i++) e.step([{ id: 'web', name: 'web' }, run], [{ source: 'web', target: 'db' }], new Map());
  const r = e.step([{ id: 'web', name: 'web' }, { id: 'db', name: 'db', metadata: { state: 'exited', exitCode: 0 } }], [{ source: 'web', target: 'db' }], new Map());
  assert.equal(r.ranked[0], 'db');
  assert.equal(r.services.get('db')!.fact, 'stopped');
  // a one-shot job that exits 0 without ever having run for long is still benign
  const job = new MLEngine(ENGINE_DEFAULTS).step([{ id: 'migrate', name: 'migrate', metadata: { state: 'exited', exitCode: 0 } }], [], new Map());
  assert.equal(job.services.get('migrate')!.hard, false);
});

test('engine: a crash loop stays the prime suspect between kills', () => {
  const e = new MLEngine(ENGINE_DEFAULTS);
  const nodes = (state: string) => [{ id: 'web', name: 'web', metadata: { state: 'running' } }, { id: 'api', name: 'api', metadata: { state, exitCode: 137 } }];
  const edges = [{ source: 'web', target: 'api' }];
  for (const s of ['running', 'exited', 'running', 'running', 'exited', 'running']) e.step(nodes(s), edges, new Map());
  const r = e.step(nodes('running'), edges, new Map());
  assert.equal(r.ranked[0], 'api');
  assert.equal(r.services.get('api')!.fact, 'crash loop');
  assert.ok(r.hot);
});
