/**
 * v2 diagnose: unit tests for the classifiers (toy data) and the feature extractor (a tiny handmade trace).
 *   node server/node_modules/tsx/dist/cli.mjs --test v2/diagnose/diagnose.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainTree, trainForest, trainKnn, trainNaiveBayes, gini, evaluate, decisionList, rng } from './models.ts';
import { extractFeatures, findAlarm, FEATURE_NAMES, median } from './features.ts';
import { runbookFor, RUNBOOKS } from './runbook.ts';
import type { Trace, TraceMoment } from '../core/trace.ts';

// two well separated blobs plus a third class on a diagonal line
function toy(seed: number, n = 30) {
  const r = rng(seed);
  const X: number[][] = [], y: string[] = [];
  for (let i = 0; i < n; i++) {
    X.push([r() * 0.5, r() * 0.5]); y.push('a');
    X.push([3 + r() * 0.5, r() * 0.5]); y.push('b');
    X.push([1.5 + r() * 0.5, 3 + r() * 0.5]); y.push('c');
  }
  return { X, y };
}
const acc = (m: { predict(x: number[]): string }, X: number[][], y: string[]) => X.filter((x, i) => m.predict(x) === y[i]).length / X.length;

test('gini impurity', () => {
  assert.equal(gini(new Map([['a', 4]]), 4), 0);
  assert.equal(gini(new Map([['a', 2], ['b', 2]]), 4), 0.5);
  assert.ok(Math.abs(gini(new Map([['a', 1], ['b', 1], ['c', 1]]), 3) - 2 / 3) < 1e-12);
});

test('tree learns an axis split, and an interval with depth 2 but not depth 1', () => {
  const { X, y } = toy(1), test = toy(2);
  assert.equal(acc(trainTree({ maxDepth: 3, minLeaf: 1 })(X, y), test.X, test.y), 1);
  // class "in" when 1 < x < 2: needs two cuts on the same feature
  const xs = Array.from({ length: 30 }, (_, i) => [i / 10]);
  const ys = xs.map(([v]) => (v > 1 && v < 2 ? 'in' : 'out'));
  assert.equal(acc(trainTree({ maxDepth: 2, minLeaf: 1 })(xs, ys), xs, ys), 1);
  assert.ok(acc(trainTree({ maxDepth: 1, minLeaf: 1 })(xs, ys), xs, ys) < 1);
  // depth 0 is a single leaf: predicts the majority class
  const stump = trainTree({ maxDepth: 0, minLeaf: 1 })([[0], [1], [2]], ['x', 'x', 'z']);
  assert.equal(stump.predict([2]), 'x');
});

test('forest is accurate and repeatable with the same seed', () => {
  const { X, y } = toy(3), test = toy(4);
  const p = { trees: 25, maxDepth: 4, minLeaf: 1, seed: 11 };
  const f1 = trainForest(p)(X, y), f2 = trainForest(p)(X, y);
  assert.ok(acc(f1, test.X, test.y) >= 0.97);
  for (const x of test.X) assert.deepEqual([...f1.proba!(x)].sort(), [...f2.proba!(x)].sort());
});

test('kNN: nearest neighbour, and scaling makes a huge-range feature harmless', () => {
  const m = trainKnn(1)([[0, 0], [10, 0]], ['L', 'R']);
  assert.equal(m.predict([1, 0]), 'L');
  assert.equal(m.predict([9, 0]), 'R');
  // feature 2 is noise with a 1000x range; after z-scoring, feature 1 still decides
  const X = [[0, 0], [0, 1000], [1, 500], [1, 0], [10, 900], [10, 100], [11, 400], [11, 600]];
  const y = ['L', 'L', 'L', 'L', 'R', 'R', 'R', 'R'];
  const k3 = trainKnn(3)(X, y);
  assert.equal(k3.predict([0.5, 950]), 'L');
  assert.equal(k3.predict([10.5, 50]), 'R');
});

test('naive Bayes separates Gaussian blobs and returns a distribution', () => {
  const { X, y } = toy(5), test = toy(6);
  const m = trainNaiveBayes(1e-2)(X, y);
  assert.ok(acc(m, test.X, test.y) >= 0.97);
  const p = m.proba!([0.2, 0.2]);
  assert.ok(Math.abs([...p.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(p.get('a')! > 0.9);
});

test('evaluate: accuracy, macro-F1, confusion', () => {
  const r = evaluate(['a', 'a', 'b', 'b'], ['a', 'b', 'b', 'b'], ['a', 'b']);
  assert.equal(r.accuracy, 0.75);
  assert.deepEqual(r.confusion, [[1, 1], [0, 2]]);
  // a: P=1 R=0.5 F1=2/3; b: P=2/3 R=1 F1=0.8
  assert.ok(Math.abs(r.macroF1 - (2 / 3 + 0.8) / 2) < 1e-12);
});

// ---------- feature extractor on a handmade trace ----------
// Two services: "web" calls "db". 100 moments, 5 s apart. From moment 70 to 73 db is exited with code 137, then it
// runs again; db memory doubles from 60 on. web gets slow from 70 on.
function handmade(): Trace {
  const moments: TraceMoment[] = [];
  for (let i = 0; i < 100; i++) {
    const down = i >= 70 && i <= 73;
    const db: Record<string, number | string | boolean> = down
      ? { state: 'exited', exitCode: 137, restartDelta: 0 }
      : { state: 'running', restartDelta: i === 74 ? 1 : 0, memoryPercent: i >= 60 ? 20 : 10, cpu: 0.5, cpuThrottledPct: 0, networkRxRate: 100, networkTxRate: 100, requestRate: 1 };
    const web = { state: 'running', restartDelta: 0, memoryPercent: 5, cpu: 1, cpuThrottledPct: 0, networkRxRate: 500, networkTxRate: 500, requestRate: 2, latencyP95: i >= 70 ? 100 : 10, errorRate: i >= 70 ? 0.5 : 0 };
    moments.push({
      ts: 1_000_000 + i * 5000, services: ['web', 'db'], edges: [['web', 'db']], status: {},
      metrics: { web, db }, ml: { web: [i >= 70 ? 1.5 : 0, 0, 1.5, 1, 0, 0.2], db: [i >= 70 ? 3 : 0, 3, 0, 1, down ? 1 : 0, 0.8] },
      mlRanked: ['db', 'web'], rules: { web: 0, db: 0 },
    });
  }
  return { name: 'toy', subject: 'toy', t0: 1_000_000, t1: 1_000_000 + 99 * 5000, trueCalls: null, moments,
    faults: [{ id: 'f1', class: 'crash', target: 'db', a: 1_000_000 + 70 * 5000, b: 1_000_000 + 75 * 5000, affected: ['web'] }] };
}
const fv = (x: number[], name: (typeof FEATURE_NAMES)[number]) => x[FEATURE_NAMES.indexOf(name)];

test('findAlarm: second of two consecutive alarming moments inside the fault window', () => {
  const t = handmade();
  const engine = (tr: Trace, i: number) => ({ max: i >= 70 ? 2 : 0, ranked: ['db', 'web'] });
  assert.deepEqual(findAlarm(t, t.faults[0], engine), { idx: 71, suspect: 'db' });
  assert.equal(findAlarm(t, t.faults[0], () => ({ max: 0, ranked: [] })), null);
});

test('extractFeatures: state history, exit codes, memory, callers', () => {
  const t = handmade();
  const x = extractFeatures(t, 71, 'db', 6);       // reads moments up to 77
  assert.equal(x.length, FEATURE_NAMES.length);
  assert.ok(x.every(Number.isFinite));
  assert.equal(fv(x, 'st_outages'), 1);           // one outage (70..73); the restart at 74 belongs to it
  assert.equal(fv(x, 'st_longest_down'), Math.log1p(4));
  assert.equal(fv(x, 'exit_nonzero'), 1);
  assert.equal(fv(x, 'exit_zero'), 0);
  assert.equal(fv(x, 'st_down_now'), 0);           // running again at 77
  assert.equal(fv(x, 'restart_events'), Math.log1p(1));
  assert.ok(Math.abs(fv(x, 'mem_ratio') - Math.log(21 / 11)) < 1e-9);   // tail 20 vs baseline 10, eps 1
  assert.equal(fv(x, 'callers_n'), Math.log1p(1));
  assert.equal(fv(x, 'callers_anom'), 1);          // web is over its line in the tail
  assert.ok(Math.abs(fv(x, 'callers_lat_ratio') - Math.log(105 / 15)) < 1e-9);   // web p95 10 -> 100, eps 5
  assert.equal(decisionList(x), 'memory');         // memory doubled, so the rules call it a leak first
  // N = 0 at the alarm: still down, nothing read after moment 71
  const x0 = extractFeatures(t, 71, 'db', 0);
  assert.equal(fv(x0, 'st_down_now'), 1);
  assert.equal(fv(x0, 'restart_events'), 0);
  // nothing after the window leaks in: changing moment 90 does not change the vector
  const t2 = handmade();
  (t2.moments[90].metrics.db as any).state = 'paused';
  assert.deepEqual(extractFeatures(t2, 71, 'db', 6), x);
});

test('median and runbooks', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), undefined);
  for (const [cls, rb] of Object.entries(RUNBOOKS)) {
    assert.ok(rb.checks.length >= 2 && rb.checks.length <= 4, cls);
  }
  assert.ok(runbookFor('pause', 'cart').checks[0].run.includes('cart'));
});
