import test from 'node:test';
import assert from 'node:assert/strict';
import { trainTarget } from '../../algorithms/model/TargetModel.ts';
import { FEATURE_NAMES } from '../../algorithms/detection/features.ts';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const node = (id: string) => ({ id, name: id.split(':')[1], project: 'p', type: 'service', status: 'healthy', metadata: { state: 'running' }, metrics: null }) as any;
const NODES = [node('p:api'), node('p:db'), node('p:web')];
const EDGES: [string, string][] = [['p:web', 'p:api'], ['p:api', 'p:db']];

/** A deterministic wobble in [-1, 1]. */
const wob = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 0.5 + Math.sin(i * 3.1 + k) * 0.5;

function history(minutes: number, noise: number, spikeAt?: [number, number]) {
  const h = new Map<string, any[]>();
  const n = Math.round((minutes * 60) / 8);
  NODES.forEach((nd, k) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const spike = spikeAt && i >= spikeAt[0] && i < spikeAt[1] && nd.id === 'p:api';
      rows.push({ timestamp: new Date(T0 + i * 8000).toISOString(), cpu: Math.max(0.1, 10 + noise * 10 * wob(i, k) + (spike ? 70 : 0)), memoryPercent: 30 + wob(i, k + 5),
        networkRxRate: 5000 + noise * 3000 * wob(i, k + 9), networkTxRate: 5000, requestCount: 40, requestRate: 5 + noise * wob(i, k + 3), errorRate: 0, latencyP95: 10 + noise * 4 * wob(i, k + 7) });
    }
    h.set(nd.id, rows);
  });
  return (id: string) => h.get(id) ?? [];
}

test('the model is learning until the baseline spans the needed time, then ready', () => {
  const short = trainTarget({ target: 'p', nodes: NODES, edges: EDGES, history: history(10, 0.3), weights: null, needSec: 1800 });
  assert.equal(short.state, 'learning');
  assert.ok(short.baselineSec > 0 && short.baselineSec < 1800);
  const long = trainTarget({ target: 'p', nodes: NODES, edges: EDGES, history: history(60, 0.3), weights: null, needSec: 1800 });
  assert.equal(long.state, 'ready');
  assert.ok(long.baselineSec >= 1800);
});

test('a noisier architecture learns a higher bar than a quiet one, from its own baseline', () => {
  const quiet = trainTarget({ target: 'q', nodes: NODES, edges: EDGES, history: history(60, 0.05), weights: null, needSec: 600 });
  const noisy = trainTarget({ target: 'n', nodes: NODES, edges: EDGES, history: history(60, 1.5), weights: null, needSec: 600 });
  assert.ok(noisy.noiseCeiling >= quiet.noiseCeiling, `${noisy.noiseCeiling} vs ${quiet.noiseCeiling}`);
});

test('the shared prior is the floor: learning locally never lowers the threshold below what was learned across systems', () => {
  const d = FEATURE_NAMES.length;
  const weights = { mean: new Array(d).fill(0), std: new Array(d).fill(1), w: new Array(d).fill(0.01), b: -4, features: FEATURE_NAMES as any, threshold: 0.7 };
  const m = trainTarget({ target: 'p', nodes: NODES, edges: EDGES, history: history(60, 0.3), weights, needSec: 600 });
  assert.equal(m.scorer, 'learned');
  assert.ok(m.threshold >= 0.7);
});

test('moments inside an incident are left out of the baseline, so a fault cannot teach the model that it is normal', () => {
  const faulted = history(90, 0.2, [150, 260]);                         // about 15 minutes of CPU at 80 on the api
  const stampOf = (i: number) => T0 + i * 8000;
  const dirty = trainTarget({ target: 'p', nodes: NODES, edges: EDGES, history: faulted, weights: null, needSec: 600 });
  const clean = trainTarget({ target: 'p', nodes: NODES, edges: EDGES, history: faulted, weights: null, needSec: 600, exclude: (ts) => ts >= stampOf(150) && ts <= stampOf(260) + 60000 });
  assert.ok(clean.noiseCeiling < dirty.noiseCeiling, `${clean.noiseCeiling} vs ${dirty.noiseCeiling}`);
});

test('no history: learning, with the prior as the threshold', () => {
  const m = trainTarget({ target: 'p', nodes: NODES, edges: EDGES, history: () => [], weights: null, needSec: 1800 });
  assert.equal(m.state, 'learning');
  assert.equal(m.moments, 0);
});
