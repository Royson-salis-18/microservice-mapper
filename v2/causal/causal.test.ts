// v2/causal unit tests on small synthetic series.
//   node server/node_modules/tsx/dist/cli.mjs --test v2/causal/causal.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceMoment, Trace } from '../core/trace.ts';
import { DirectionLearner, nameBlind, nameRuleDirections, truthOf } from './direction.ts';
import { rankMoment } from './rca.ts';

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface Svc { err?: number; lat?: number; req?: number; anomaly?: number; hard?: boolean; own?: number }
function moment(i: number, svcs: Record<string, Svc>, edges: [string, string][]): TraceMoment {
  const services = Object.keys(svcs).sort();
  const metrics: TraceMoment['metrics'] = {}, ml: TraceMoment['ml'] = {};
  for (const id of services) {
    const s = svcs[id];
    metrics[id] = s.hard ? { state: 'exited' } : { state: 'running', errorRate: s.err ?? 0.01, latencyP95: s.lat ?? 20, requestRate: s.req ?? 5, requestCount: 300, networkRxRate: 1000, networkTxRate: 1000 };
    ml[id] = [0, s.own ?? 0, 0, s.hard ? 1 : s.anomaly ?? 0, s.hard ? 1 : 0, 0];
  }
  return { ts: i * 5000, services, edges, status: {}, metrics, ml, mlRanked: services, rules: {} };
}
const both: [string, string][] = [['a', 'b'], ['b', 'a']];

test('a series that leads another: cross-correlation and Granger point from the follower (caller) to the leader (callee)', () => {
  const r = rng(1), L = new DirectionLearner();
  let prevB = 0;
  for (let i = 0; i < 400; i++) {
    const b = r() < 0.1 ? 1 : 0;                      // the callee's anomaly
    const a = 0.8 * prevB + 0.1 * r();                // the caller follows one step later
    L.observe(moment(i, { a: { anomaly: a }, b: { anomaly: b } }, both));
    prevB = b;
  }
  const s = L.scores('a', 'b')!;
  assert.ok(s['xcorr-anomaly'] > 0.5, `xcorr ${s['xcorr-anomaly']}`);
  assert.ok(s['granger-anomaly'] > 0.5, `granger ${s['granger-anomaly']}`);
  // the same pair asked the other way round gives the opposite sign
  assert.equal(L.scores('b', 'a')!['granger-anomaly'], -s['granger-anomaly']);
});

test('errors travel up and traffic travels down: the learner finds the caller', () => {
  const r = rng(2), L = new DirectionLearner({ weights: { up: 1, down: 1 } });
  for (let i = 0; i < 600; i++) {
    const bDown = i % 150 >= 100 && i % 150 < 110;   // the callee b goes down now and then
    const aDown = i % 150 >= 40 && i % 150 < 50;     // so does the caller a
    const noise = () => 1 + 0.1 * (r() - 0.5);
    L.observe(moment(i, {
      a: aDown ? { hard: true } : { err: bDown ? 0.5 : 0.01 * noise(), lat: 20 * noise(), req: 5 * noise() },
      b: bDown ? { hard: true } : { err: 0.01 * noise(), lat: 20 * noise(), req: (aDown ? 0.5 : 5) * noise() },
    }, both));
  }
  const s = L.scores('a', 'b')!;
  assert.ok(s.up > 0.3, `up ${s.up}`);
  assert.ok(s.down > 0.3, `down ${s.down}`);
  assert.equal(L.direction('a', 'b'), 1);
  assert.equal(L.direction('b', 'a'), -1);
});

test('a pair seen from one end only keeps the collector view; no evidence leaves it unknown', () => {
  const L = new DirectionLearner({ weights: { up: 1 } });
  for (let i = 0; i < 50; i++) L.observe(moment(i, { a: {}, b: {}, c: {} }, [['b', 'a'], ['a', 'c'], ['c', 'a']]));
  assert.equal(L.direction('a', 'b'), -1);
  assert.equal(L.direction('a', 'c'), 0);
  const e = L.walkEdges(moment(50, { a: {}, b: {}, c: {} }, [['b', 'a'], ['a', 'c'], ['c', 'a']]));
  assert.deepEqual(e.filter((x) => !x.mutual).map((x) => `${x.from}>${x.to}`), ['b>a']);
  assert.equal(e.filter((x) => x.mutual).length, 2);
});

test('depth: the service that talks to an unwatched node (the load generator) is the entry', () => {
  const L = new DirectionLearner();
  const edges: [string, string][] = [['lg', 'e'], ['e', 'm'], ['m', 'e'], ['m', 'd'], ['d', 'm']];
  for (let i = 0; i < 5; i++) L.observe(moment(i, { e: {}, m: {}, d: {} }, edges));
  assert.equal(L.scores('e', 'm')!.depth, 1);
  assert.equal(L.scores('d', 'm')!.depth, -1);
});

test('name rule: decides gateway -> db by names, leaves it mutual after renaming', () => {
  const m = moment(0, { gateway: {}, 'orders-db': {} }, [['gateway', 'orders-db'], ['orders-db', 'gateway']]);
  assert.equal(nameRuleDirections(m).get('gateway|orders-db'), 1);
  const t: Trace = { name: 'x', subject: 'x', t0: 0, t1: 1, faults: [{ id: 'f', class: 'stop', target: 'orders-db', a: 0, b: 1, affected: ['gateway'] }], trueCalls: [['gateway', 'orders-db']], moments: [m] };
  const blind = nameBlind(t);
  const [a, b] = blind.trueCalls![0];
  assert.ok(/^s\d+$/.test(a) && /^s\d+$/.test(b));
  assert.equal(blind.faults[0].target, b);
  assert.deepEqual(blind.faults[0].affected, [a]);
  assert.equal([...nameRuleDirections(blind.moments[0]).values()][0], 0);
  assert.equal(truthOf(blind, a, b), 1);
  assert.equal(truthOf(blind, b, a), -1);
});

test('the walk follows the direction: with a -> b and both equally sick, the callee b ranks first', () => {
  const m = moment(0, { a: { anomaly: 1 }, b: { anomaly: 1 }, c: {} }, both);
  assert.equal(rankMoment(m, [{ from: 'a', to: 'b', weight: 1 }])[0], 'b');
  assert.equal(rankMoment(m, [{ from: 'b', to: 'a', weight: 1 }])[0], 'a');
  // a container fact always comes first
  const h = moment(0, { a: { anomaly: 1 }, b: { anomaly: 1 }, c: { hard: true } }, both);
  assert.equal(rankMoment(h, [{ from: 'a', to: 'b', weight: 1 }])[0], 'c');
});
