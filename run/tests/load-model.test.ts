/**
 * The load-aware model must not read a change of workload as a fault, and must still see a fault.
 * Both are checked on a small simulated project: ten services, a few busy ones whose network follows the load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadModel, LOAD_DEFAULTS, F } from '../../server/algorithms/ml/loadModel.ts';

const IDLE_NET = Math.log(2000);
const wobble = (k: number, i: number) => Math.sin(k * 1.7 + i * 2.3) * 0.04;

/** One round of readings. `load` multiplies the traffic of services 0..2 (log scale); `cpuBoost` is added to service 5's cpu. */
function round(k: number, load: number, cpuBoost = 0) {
  const m = new Map<string, (number | null)[]>();
  for (let i = 0; i < 10; i++) {
    const busy = i < 3;
    const v: (number | null)[] = [Math.log(5 + 2), Math.log(1 + 20), IDLE_NET, IDLE_NET, null, null, null, 0];
    if (busy) { v[F.netIn] = Math.log(2000 + 6000 * Math.exp(load)) + wobble(k, i); v[F.netOut] = Math.log(2000 + 6000 * Math.exp(load)) + wobble(k, i + 5); }
    v[F.cpu] = Math.log(5 + 2 + (i === 5 ? cpuBoost : 0)) + wobble(k, i);
    m.set(`s${i}`, v);
  }
  return m;
}
const maxLevel = (model: LoadModel, k: number, load: number, boost = 0) => Math.max(...[...model.round(round(k, load, boost)).values()].map((l) => l.level));

test('load model: a steady project reads as normal', () => {
  const model = new LoadModel(LOAD_DEFAULTS);
  let worst = 0;
  for (let k = 0; k < 150; k++) worst = Math.max(worst, k > 40 ? maxLevel(model, k, 0) : (maxLevel(model, k, 0), 0));
  assert.ok(worst < 1, `worst level ${worst}`);
});

test('load model: traffic stopping or jumping for everyone is not a fault', () => {
  const model = new LoadModel(LOAD_DEFAULTS);
  for (let k = 0; k < 80; k++) model.round(round(k, 0));
  let worst = 0;
  for (let k = 80; k < 140; k++) worst = Math.max(worst, maxLevel(model, k, -2.5));   // traffic falls to a twelfth
  for (let k = 140; k < 200; k++) worst = Math.max(worst, maxLevel(model, k, 1.5));    // then rises to four times
  assert.ok(worst < 2, `a change of load reached level ${worst}`);
});

test('load model: a fault in one service is still seen during a load change', () => {
  const model = new LoadModel(LOAD_DEFAULTS);
  for (let k = 0; k < 80; k++) model.round(round(k, 0));
  let seen = 0;
  for (let k = 80; k < 120; k++) {
    const res = model.round(round(k, 0.8, 60));         // load up and service 5's CPU +60 points
    const l = res.get('s5')!;
    if (l.level >= 2) seen++;
    assert.ok([...res].filter(([id]) => id !== 's5').every(([, v]) => v.level < 2));
  }
  assert.ok(seen >= 30, `the faulty service reached level 2 on ${seen} of 40 rounds`);
});

test('load model: a missing signal is skipped, never scored as zero', () => {
  const model = new LoadModel(LOAD_DEFAULTS);
  for (let k = 0; k < 60; k++) model.round(round(k, 0));
  const r = round(60, 0); r.get('s1')![F.cpu] = null;
  assert.equal(model.round(r).get('s1')!.level < 1, true);
});
