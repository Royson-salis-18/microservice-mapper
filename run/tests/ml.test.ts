import test from 'node:test';
import assert from 'node:assert/strict';
import { fit, predict } from '../../server/algorithms/learning/logreg.ts';
import { buildRun, labelledRows } from '../../server/algorithms/learning/dataset.ts';
import { evaluate, tuneThreshold } from '../../server/algorithms/learning/evaluate.ts';
import { FEATURE_NAMES } from '../../server/algorithms/detection/features.ts';

test('logistic regression separates a clean signal and is deterministic', () => {
  const X: number[][] = [], y: number[] = [];
  for (let i = 0; i < 200; i++) { const pos = i % 10 === 0; X.push([pos ? 3 + (i % 3) * 0.1 : (i % 7) * 0.1, (i % 5) * 0.2]); y.push(pos ? 1 : 0); }
  const m1 = fit(X, y, ['a', 'b'], 1), m2 = fit(X, y, ['a', 'b'], 1);
  assert.deepEqual(m1.w, m2.w);
  assert.ok(predict(m1, [3.1, 0.2]) > 0.9 && predict(m1, [0.2, 0.2]) < 0.1);
  assert.ok(Math.abs(m1.w[0]) > Math.abs(m1.w[1]));
});

/** A small recorded run: three services, api calls db; a "stop" fault on db from 900 s to 1000 s, a CPU fault on api later. */
function synthetic() {
  const T0 = Date.UTC(2026, 0, 1), at = (s: number) => T0 + s * 1000;
  const ledger = [
    { type: 'fault-start', id: 'f1', class: 'stop', target: 'db', startedAt: at(900), durationSec: 100, truth: { rootCause: 'db', expectedAffected: ['api'], blastShare: 0.3 } },
    { type: 'fault-end', id: 'f1', appliedAt: at(900), healedAt: at(1000) },
    { type: 'fault-start', id: 'f2', class: 'brownout', target: 'api', startedAt: at(1400), durationSec: 120, truth: { rootCause: 'api', expectedAffected: [], blastShare: 0.1 } },
    { type: 'fault-end', id: 'f2', appliedAt: at(1400), healedAt: at(1520) },
  ].map((r) => JSON.stringify({ ts: 0, ...r })).join('\n');
  const lines: string[] = [];
  for (let s = 0; s <= 1800; s += 8) {
    const dbDown = s >= 900 && s <= 1000, apiHot = s >= 1400 && s <= 1520, wob = (s / 8) % 5;
    const metrics: any = {
      api: { state: 'running', cpu: apiHot ? 80 : 5 + wob * 0.3, memoryPercent: 30 + wob * 0.1, networkRxRate: 5000 + wob * 100, requestCount: 40, requestRate: 5, errorRate: dbDown ? 0.6 : 0, latencyP95: dbDown ? 900 : 10 + wob },
      db: dbDown ? { state: 'exited', exitCode: 1 } : { state: 'running', cpu: 2 + wob * 0.2, memoryPercent: 20, networkRxRate: 3000 + wob * 50 },
      web: { state: 'running', cpu: 1 + wob * 0.1, memoryPercent: 10, networkRxRate: 1000 + wob * 20, requestCount: 30, requestRate: 4, errorRate: 0, latencyP95: 5 + wob },
    };
    const status = { api: dbDown ? 'degraded' : 'healthy', db: dbDown ? 'critical' : 'healthy', web: 'healthy' };
    lines.push(JSON.stringify({ ts: at(s), incidents: [], status, metrics, edges: [['api', 'db'], ['web', 'api']] }));
  }
  return buildRun('syn', 'p', ledger, lines.join('\n'));
}

test('dataset: causal features, positive rows only on the faulted service while it is faulted', () => {
  const run = synthetic();
  assert.equal(run.faults.length, 2);
  assert.equal(run.moments[0].X[0].length, FEATURE_NAMES.length);
  const { X, y } = labelledRows(run, { warmupSec: 300 });
  assert.equal(X.length, y.length);
  assert.ok(y.filter((v) => v === 1).length >= 20);
});

test('a model learned on the run catches both faults, names the right service, and raises no false alarm', () => {
  const run = synthetic();
  const { X, y } = labelledRows(run);
  const m = fit(X, y, FEATURE_NAMES, 1);
  const scores = (_r: number, mi: number) => run.moments[mi].X.map((x) => predict(m, x));
  const { threshold } = tuneThreshold([run], scores);
  const r = evaluate([run], scores, threshold);
  assert.equal(r.detected.p, 1);
  assert.equal(r.top1.p, 1);
  assert.equal(r.falseAlarms, 0);
});
