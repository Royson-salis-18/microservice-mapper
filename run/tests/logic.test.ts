/**
 * Tests for the pure logic behind the views: spatial arrangements (2D and
 * 3D) and the shared edge heat scale. These are the pieces where a silent
 * bug is invisible - a layout that quietly drops a node, or a heat band
 * that never triggers, looks like "the data is like that" on screen.
 *
 * Run: npx tsx --test tests/logic.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout2D, LAYOUTS_2D, type Layout2DId } from '../../client/src/components/layouts2d.ts';
import { computeLayout, LAYOUTS, HALL_PADDING, type LayoutId, type LayoutNode } from '../../client/src/components/3d/layouts.ts';
import { edgeAppearance } from '../../client/src/components/shared/edgeHeat.ts';
import type { DependencyEdge } from '../../client/src/types/index.ts';

// --- fixtures ---------------------------------------------------------------

function makeNodes(count: number, project = 'proj') {
  const types = ['gateway', 'frontend', 'service', 'database', 'queue', 'cache', 'infrastructure'];
  return Array.from({ length: count }, (_, i) => ({
    id: `${project}:svc-${i}`,
    position: { x: 0, y: 0 },
    data: { project, type: types[i % types.length], name: `svc-${i}` },
  })) as any[];
}

function makeEdges(nodes: any[], pairs: Array<[number, number]>) {
  return pairs.map(([a, b]) => ({
    id: `${nodes[a].id}->${nodes[b].id}`,
    source: nodes[a].id,
    target: nodes[b].id,
  })) as any[];
}

function finite(v: number) {
  return Number.isFinite(v);
}

// --- 2D layouts -------------------------------------------------------------

test('2D: every layout positions every node, with finite coordinates', () => {
  const nodes = makeNodes(37);
  const edges = makeEdges(nodes, [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5]]);

  for (const { id } of LAYOUTS_2D) {
    const pos = computeLayout2D(id as Layout2DId, nodes, edges);
    assert.equal(Object.keys(pos).length, nodes.length, `${id}: dropped nodes`);
    for (const n of nodes) {
      const p = pos[n.id];
      assert.ok(p, `${id}: missing position for ${n.id}`);
      assert.ok(finite(p.x) && finite(p.y), `${id}: non-finite position ${JSON.stringify(p)}`);
    }
  }
});

test('2D: layouts do not stack nodes on the exact same point', () => {
  const nodes = makeNodes(30);
  const edges = makeEdges(nodes, [[0, 1], [1, 2]]);

  for (const { id } of LAYOUTS_2D) {
    const pos = computeLayout2D(id as Layout2DId, nodes, edges);
    const seen = new Set(Object.values(pos).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
    // Radial deliberately puts one node at the centre; everything else
    // should still be distinct.
    assert.ok(seen.size >= nodes.length - 1, `${id}: ${nodes.length - seen.size} overlapping nodes`);
  }
});

test('2D hierarchy: survives a dependency cycle without dropping nodes', () => {
  const nodes = makeNodes(4);
  // 0 -> 1 -> 2 -> 0 is a cycle, 3 hangs off it
  const edges = makeEdges(nodes, [[0, 1], [1, 2], [2, 0], [1, 3]]);
  const pos = computeLayout2D('hierarchy', nodes, edges);
  assert.equal(Object.keys(pos).length, 4, 'cycle caused nodes to be dropped');
  for (const n of nodes) assert.ok(finite(pos[n.id].x) && finite(pos[n.id].y));
});

test('2D hierarchy: entry points sit left of what they depend on', () => {
  const nodes = makeNodes(3);
  const edges = makeEdges(nodes, [[0, 1], [1, 2]]);
  const pos = computeLayout2D('hierarchy', nodes, edges);
  assert.ok(pos[nodes[0].id].x < pos[nodes[1].id].x, 'root not left of its dependency');
  assert.ok(pos[nodes[1].id].x < pos[nodes[2].id].x, 'depth not increasing left to right');
});

test('2D: wrapping keeps tiers and hierarchy from becoming one huge strip', () => {
  // 40 services of a single type all land in one tier / one depth column.
  const nodes = Array.from({ length: 40 }, (_, i) => ({
    id: `p:svc-${i}`,
    position: { x: 0, y: 0 },
    data: { project: 'p', type: 'service', name: `svc-${i}` },
  })) as any[];

  const tiers = computeLayout2D('tiers', nodes, []);
  const xs = Object.values(tiers).map((p) => p.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 4000, 'tiers row did not wrap');

  const hier = computeLayout2D('hierarchy', nodes, []);
  const ys = Object.values(hier).map((p) => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 4000, 'hierarchy column did not wrap');
});

test('2D: empty input is handled, not crashed on', () => {
  for (const { id } of LAYOUTS_2D) {
    assert.deepEqual(computeLayout2D(id as Layout2DId, [], []), {}, `${id}: empty input`);
  }
});

// --- 3D layouts -------------------------------------------------------------

function make3DNodes(count: number, project = 'proj'): LayoutNode[] {
  const types = ['gateway', 'frontend', 'service', 'database', 'queue', 'cache', 'infrastructure'];
  return Array.from({ length: count }, (_, i) => ({
    id: `${project}:svc-${i}`,
    project,
    type: types[i % types.length],
    degree: i % 5,
  }));
}

test('3D: every layout positions every node, with finite coordinates', () => {
  const nodes = make3DNodes(41);
  for (const { id } of LAYOUTS) {
    const pos = computeLayout(id as LayoutId, nodes);
    assert.equal(Object.keys(pos).length, nodes.length, `${id}: dropped nodes`);
    for (const n of nodes) {
      const p = pos[n.id];
      assert.ok(p, `${id}: missing position for ${n.id}`);
      assert.ok(p.every(finite), `${id}: non-finite position ${JSON.stringify(p)}`);
    }
  }
});

test('3D tiers: wraps instead of forming one flat line', () => {
  // The bug the screenshots caught: 19 services of one role in a single row.
  const nodes = make3DNodes(19).map((n) => ({ ...n, type: 'service' }));
  const pos = computeLayout('tiers', nodes);
  const zs = Object.values(pos).map((p) => p[2]);
  assert.ok(new Set(zs.map((z) => Math.round(z))).size > 1, 'tier did not wrap into rows');
  const xs = Object.values(pos).map((p) => p[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 120, 'tier row is still too wide');
});

test('3D clusters: projects occupy separate regions', () => {
  const nodes = [...make3DNodes(8, 'alpha'), ...make3DNodes(8, 'beta')];
  const pos = computeLayout('clusters', nodes);
  const centre = (project: string) => {
    const pts = nodes.filter((n) => n.project === project).map((n) => pos[n.id]);
    return pts.reduce((a, p) => [a[0] + p[0] / pts.length, 0, a[2] + p[2] / pts.length], [0, 0, 0]);
  };
  const a = centre('alpha');
  const b = centre('beta');
  const gap = Math.hypot(a[0] - b[0], a[2] - b[2]);
  assert.ok(gap > 20, `project islands overlap (centres ${gap.toFixed(1)} apart)`);
});

test('3D halls: no two services share a spot, and halls never overlap', () => {
  const nodes = [...make3DNodes(14, 'alpha'), ...make3DNodes(5, 'beta'), ...make3DNodes(9, 'gamma'), ...make3DNodes(1, 'delta')];
  const pos = computeLayout('halls', nodes);
  const spots = new Set(Object.values(pos).map((p) => `${p[0].toFixed(3)},${p[2].toFixed(3)}`));
  assert.equal(spots.size, nodes.length, 'two services were placed on the same spot');

  // Each hall's footprint, including its padding, must be clear of every other.
  const halls = ['alpha', 'beta', 'gamma', 'delta'].map((project) => {
    const pts = nodes.filter((n) => n.project === project).map((n) => pos[n.id]);
    return {
      project,
      minX: Math.min(...pts.map((p) => p[0])) - HALL_PADDING, maxX: Math.max(...pts.map((p) => p[0])) + HALL_PADDING,
      minZ: Math.min(...pts.map((p) => p[2])) - HALL_PADDING, maxZ: Math.max(...pts.map((p) => p[2])) + HALL_PADDING,
    };
  });
  for (let i = 0; i < halls.length; i++) {
    for (let j = i + 1; j < halls.length; j++) {
      const a = halls[i], b = halls[j];
      const overlap = a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
      assert.ok(!overlap, `halls ${a.project} and ${b.project} overlap`);
    }
  }
});

test('3D halls: entry points stand in front of data stores', () => {
  // The camera looks from +z, so "in front" is larger z.
  const nodes = make3DNodes(14, 'shop');
  const pos = computeLayout('halls', nodes);
  const z = (type: string) => nodes.filter((n) => n.type === type).map((n) => pos[n.id][2]);
  assert.ok(Math.min(...z('frontend')) > Math.max(...z('database')), 'a database stands in front of a frontend');
  assert.ok(Math.min(...z('gateway')) > Math.max(...z('database')), 'a database stands in front of a gateway');
});

test('3D: single node and empty input do not produce NaN', () => {
  for (const { id } of LAYOUTS) {
    assert.deepEqual(computeLayout(id as LayoutId, []), {}, `${id}: empty`);
    const one = computeLayout(id as LayoutId, make3DNodes(1));
    const p = Object.values(one)[0];
    assert.ok(p.every(finite), `${id}: single node gave ${JSON.stringify(p)}`);
  }
});

// --- edge heat --------------------------------------------------------------

function edge(partial: Partial<DependencyEdge>): DependencyEdge {
  return {
    id: 'a->b', source: 'a', target: 'b', type: 'dependency',
    declared: true, observed: false, evidenceSources: [], metrics: null,
    status: 'unknown', ...partial,
  } as DependencyEdge;
}

test('heat: unobserved links are inert grey, never a traffic colour', () => {
  const a = edgeAppearance(edge({ observed: false, declared: true }));
  assert.equal(a.heat, 'idle');
  // Whatever the palette, "declared but never seen" must not share a colour
  // with any band that means traffic was measured.
  const traffic = [5, 100, 500, 5000].map((samplesPerMin) =>
    edgeAppearance(edge({ observed: true, activity: { samplesPerMin, windowSec: 60, lastSeen: new Date().toISOString() } })).color.toLowerCase());
  assert.ok(!traffic.includes(a.color.toLowerCase()), `idle colour ${a.color} is also a traffic colour`);
  // And it is the dimmest of them, so it recedes.
  assert.ok(a.intensity < Math.min(...[5, 100, 500, 5000].map((samplesPerMin) =>
    edgeAppearance(edge({ observed: true, activity: { samplesPerMin, windowSec: 60, lastSeen: new Date().toISOString() } })).intensity)));
});

test('heat: observed but unmeasured is calm, not a fabricated zero', () => {
  const a = edgeAppearance(edge({ observed: true }));
  assert.equal(a.heat, 'calm');
  // Must not claim a rate it does not have.
  assert.doesNotMatch(a.label, /\d+\/min/);
});

test('heat: bands map to the calibrated thresholds', () => {
  const at = (samplesPerMin: number) =>
    edgeAppearance(edge({
      observed: true,
      activity: { samplesPerMin, windowSec: 60, lastSeen: new Date().toISOString() },
    })).heat;

  assert.equal(at(5), 'calm');
  assert.equal(at(60), 'calm');       // boundary: inclusive of calm
  assert.equal(at(61), 'busy');
  assert.equal(at(250), 'busy');
  assert.equal(at(251), 'heavy');
  assert.equal(at(1200), 'heavy');
  assert.equal(at(1201), 'saturated');
  assert.equal(at(5571), 'saturated'); // the real observed maximum
});

test('heat: failure and degradation outrank traffic volume', () => {
  const busy = { samplesPerMin: 5000, windowSec: 60, lastSeen: new Date().toISOString() };
  assert.equal(edgeAppearance(edge({ observed: true, status: 'failed', activity: busy })).heat, 'failed');
  assert.equal(edgeAppearance(edge({ observed: true, status: 'degraded', activity: busy })).heat, 'degraded');
  // A quiet link that is failing still reads as failed.
  assert.equal(edgeAppearance(edge({ observed: true, status: 'failed' })).heat, 'failed');
});

test('heat: latency turns a link orange at 300 ms and red at a second', () => {
  const at = (latency: number) => edgeAppearance(edge({ observed: true, metrics: { latency } })).heat;
  assert.equal(at(120), 'calm');
  assert.equal(at(299), 'calm');
  assert.equal(at(300), 'degraded');
  assert.equal(at(999), 'degraded');
  assert.equal(at(1000), 'failed');
  // p95 is preferred over the mean when both exist: a fast average can hide
  // a slow tail.
  assert.equal(edgeAppearance(edge({ observed: true, metrics: { latency: 80, p95Latency: 1400 } })).heat, 'failed');
});

test('heat: errors turn a link orange at 1% and red at 5%', () => {
  const at = (errorRate: number) => edgeAppearance(edge({ observed: true, metrics: { errorRate } })).heat;
  assert.equal(at(0), 'calm');
  assert.equal(at(0.009), 'calm');
  assert.equal(at(0.01), 'degraded');
  assert.equal(at(0.05), 'failed');
  const red = edgeAppearance(edge({ observed: true, metrics: { errorRate: 0.2 } }));
  assert.match(red.reason ?? '', /20\.0% of requests failing/);
});

test('heat: calling a down service is failing, unless request data says otherwise', () => {
  const busy = { samplesPerMin: 400, windowSec: 60, lastSeen: new Date().toISOString() };
  // No request data: the callee's state is the best evidence there is.
  assert.equal(edgeAppearance(edge({ observed: true, activity: busy }), { targetStatus: 'critical' }).heat, 'failed');
  assert.equal(edgeAppearance(edge({ observed: true, activity: busy }), { targetStatus: 'degraded' }).heat, 'degraded');
  // Measured clean traffic wins over the callee's flag.
  assert.equal(edgeAppearance(edge({ observed: true, activity: busy, metrics: { errorRate: 0, latency: 40 } }), { targetStatus: 'critical' }).heat, 'heavy');
  // A declared link that never carried anything stays inert.
  assert.equal(edgeAppearance(edge({ observed: false }), { targetStatus: 'critical' }).heat, 'idle');
});

test('heat: links are clearly lit, never-seen links recede, and trouble is the brightest', () => {
  // Links were capped at 0.8 to stay clear of glare; with bloom off that read
  // as dull wires. Now: everything observed is clearly lit, a link declared
  // but never seen stays faint, and a failing link is as bright as any.
  const declared = edgeAppearance(edge({ observed: false }));
  const observed = edgeAppearance(edge({ observed: true }));
  const failing = edgeAppearance(edge({ observed: true, status: 'failed' }));
  const busiest = edgeAppearance(edge({ observed: true, activity: { samplesPerMin: 5000, windowSec: 60, lastSeen: '' } } as any));
  for (const a of [declared, observed, failing, busiest]) assert.ok(a.intensity > 0 && a.intensity <= 1, `intensity ${a.intensity} out of range`);
  assert.ok(observed.intensity >= 0.8, `an observed link should be clearly lit, got ${observed.intensity}`);
  assert.ok(declared.intensity < observed.intensity, 'a declared-only link should recede behind observed ones');
  assert.ok(failing.intensity >= busiest.intensity, 'a failing link must be at least as bright as the busiest healthy one');
});

test('heat: undefined edge does not throw', () => {
  const a = edgeAppearance(undefined);
  assert.ok(a.color);
  assert.equal(a.heat, 'idle');
});

// --- auto-restart of crashed containers -------------------------------
//
// These guard the carve-outs in EndpointDiscoveryEngine.restartCrashedContainers.
// The load-generator rule matters most: reviving one resurrects synthetic
// traffic outside the traffic controller, which is load the UI cannot show
// or stop. The regex is duplicated here on purpose - importing the engine
// would pull in ssh2 and a live connection manager.
const LOAD_GENERATOR_NAMES = /(user-sim|usersim|load-?gen|loadgen|loadgenerator|locust|k6|jmeter|gatling|stress|bench|wrk2?\b|siege|vegeta|artillery)/i;

/** Mirrors the decision made per container in restartCrashedContainers. */
function shouldRestart(row: { State: string; Names: string; Status: string }): boolean {
  const state = String(row.State ?? '').toLowerCase();
  if (state !== 'exited' && state !== 'dead') return false;
  const name = String(row.Names ?? '').split(',')[0].trim();
  if (!name) return false;
  const match = /Exited \((\d+)\)/.exec(String(row.Status ?? ''));
  const code = match ? Number(match[1]) : -1;
  if (code === 0) return false;
  if (LOAD_GENERATOR_NAMES.test(name)) return false;
  return true;
}

test('restart: a crashed service is restarted', () => {
  assert.equal(shouldRestart({ State: 'exited', Names: 'docker-compose-carts-1', Status: 'Exited (137) 2 hours ago' }), true);
  assert.equal(shouldRestart({ State: 'dead', Names: 'docker-compose-orders-1', Status: 'Dead' }), true);
});

test('restart: a job that finished on purpose is left alone', () => {
  // Real row from sock-shop; restarting it would re-run a stress job.
  assert.equal(shouldRestart({ State: 'exited', Names: 'sock-shop-stress-1', Status: 'Exited (0) 6 days ago' }), false);
  assert.equal(shouldRestart({ State: 'exited', Names: 'db-migrate-1', Status: 'Exited (0) 3 days ago' }), false);
});

test('restart: load generators are never revived, even when they crashed', () => {
  // Real row from sock-shop: exit 137 is a genuine kill, but restarting it
  // would start synthetic traffic nothing in the UI could stop.
  assert.equal(shouldRestart({ State: 'exited', Names: 'docker-compose-user-sim-1', Status: 'Exited (137) 6 days ago' }), false);
  for (const name of ['loadgenerator', 'otel-load-generator-1', 'locust-worker', 'k6-runner', 'my-stress-test']) {
    assert.equal(shouldRestart({ State: 'exited', Names: name, Status: 'Exited (1) 1 hour ago' }), false, `${name} must not be revived`);
  }
});

test('restart: containers that never ran are left alone', () => {
  // sock-shop carries ~15 of these from failed `docker run` attempts;
  // starting them would add services the stack never had.
  assert.equal(shouldRestart({ State: 'created', Names: 'quirky_raman', Status: 'Created' }), false);
});

test('restart: running and healthy containers are untouched', () => {
  assert.equal(shouldRestart({ State: 'running', Names: 'docker-compose-front-end-1', Status: 'Up 6 minutes' }), false);
  assert.equal(shouldRestart({ State: 'running', Names: 'vertikal-studio', Status: 'Up 4 minutes (unhealthy)' }), false);
});

// --- incident detection thresholds ------------------------------------
//
// Incidents are rule-based and must keep working when the ML pipeline
// cannot, so the rules have to survive a bad edit. Clamping is the safety
// property: no posted value should be able to disable detection or make
// every service alert. Mirrors the LIMITS table in server/rca/thresholds.ts.
const THRESHOLD_LIMITS: Record<string, [number, number]> = {
  minHistorySamples: [2, 1000],
  zScoreAnomaly: [0.5, 10],
  zScoreHigh: [0.5, 15],
  zScoreCritical: [0.5, 20],
  absoluteHighPercent: [1, 100],
  absoluteCriticalPercent: [1, 100],
  flatlineStdDev: [0.0000001, 10],
  flatlineDeltaPercent: [1, 100],
  flatlineCriticalPercent: [1, 100],
  criticalServicesForCritical: [1, 1000],
};

const DEFAULT_THRESHOLDS: Record<string, number> = {
  minHistorySamples: 3,
  zScoreAnomaly: 2.5,
  zScoreHigh: 3.0,
  zScoreCritical: 4.0,
  absoluteHighPercent: 70,
  absoluteCriticalPercent: 85,
  flatlineStdDev: 0.001,
  flatlineDeltaPercent: 30,
  flatlineCriticalPercent: 80,
  criticalServicesForCritical: 2,
};

/** Mirrors toNumber() in server/rca/thresholds.ts. Number(null) and
 *  Number([]) are both 0, so a bare Number.isFinite guard would accept them
 *  and clamp to the minimum - the most sensitive possible setting. */
function toThresholdNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Mirrors the merge in loadThresholds/saveThresholds. */
function clampThresholds(patch: Record<string, unknown>): Record<string, number> {
  const next = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    if (!(key in patch)) continue;
    const value = toThresholdNumber(patch[key]);
    if (value === null) continue;
    const [lo, hi] = THRESHOLD_LIMITS[key];
    next[key] = Math.min(Math.max(value, lo), hi);
  }
  return next;
}

test('thresholds: an absurd value is clamped, not stored', () => {
  assert.equal(clampThresholds({ absoluteCriticalPercent: 999 }).absoluteCriticalPercent, 100);
  assert.equal(clampThresholds({ absoluteCriticalPercent: -5 }).absoluteCriticalPercent, 1);
  // A z-score of 0 would make every sample anomalous.
  assert.equal(clampThresholds({ zScoreAnomaly: 0 }).zScoreAnomaly, 0.5);
  // And an enormous one would mean nothing ever fires.
  assert.equal(clampThresholds({ zScoreAnomaly: 1e9 }).zScoreAnomaly, 10);
});

test('thresholds: junk is ignored and the default stands', () => {
  for (const bad of ['abc', null, undefined, NaN, {}, []]) {
    assert.equal(clampThresholds({ zScoreAnomaly: bad }).zScoreAnomaly, 2.5, `${String(bad)} must not take effect`);
  }
});

test('thresholds: an unrelated key cannot inject itself', () => {
  const out = clampThresholds({ zScoreAnomaly: 3, somethingElse: 42 } as any);
  assert.equal(out.zScoreAnomaly, 3);
  assert.ok(!('somethingElse' in out));
});

test('thresholds: severity bounds stay ordered so a band cannot vanish', () => {
  // Not enforced by clamping - this documents that the ordering is the
  // operator's to keep, and that each bound is independently in range.
  const t = clampThresholds({ zScoreAnomaly: 2.5, zScoreHigh: 3, zScoreCritical: 4 });
  assert.ok(t.zScoreAnomaly <= t.zScoreHigh && t.zScoreHigh <= t.zScoreCritical);
});

test('thresholds: defaults are all inside their own limits', () => {
  for (const [key, value] of Object.entries(DEFAULT_THRESHOLDS)) {
    const [lo, hi] = THRESHOLD_LIMITS[key];
    assert.ok(value >= lo && value <= hi, `${key} default ${value} outside ${lo}-${hi}`);
  }
});

// --- Tier 2: PrometheusSource -----------------------------------------
//
// Driven by responses captured from the live open-telemetry target on
// 2026-09-18, so this exercises the shapes Prometheus actually returned
// rather than shapes invented to make the parser pass. The targets rotate
// IPs constantly, so a stubbed exec is also the only way this stays runnable.
import { PrometheusSource } from '../../server/telemetry-sources/PrometheusSource.js';

/** Builds a fake remote exec that answers by matching the query text. */
function stubExec(routes: { match: RegExp; reply: string }[]) {
  return async (cmd: string) => {
    for (const r of routes) if (r.match.test(cmd)) return r.reply;
    return JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } });
  };
}

const NAME_VALUES = JSON.stringify({
  status: 'success',
  data: [
    'http_server_request_duration_seconds_bucket',
    'http_server_request_duration_seconds_count',
    'demo_cart_get_cart_latency_seconds_bucket',
    'up',
  ],
});

const vector = (rows: [Record<string, string>, string][]) => JSON.stringify({
  status: 'success',
  data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [1789744887, v] })) },
});

test('prometheus: probe finds the duration family the target actually emits', async () => {
  const src = new PrometheusSource('open-telemetry', stubExec([
    { match: /__name__/, reply: NAME_VALUES },
  ]));
  const status = await src.probe();
  assert.equal(status.available, true);
  assert.equal(status.kind, 'prometheus');
});

test('prometheus: an up instance with no request histograms is unavailable, with a usable reason', async () => {
  const src = new PrometheusSource('sock-shop', stubExec([
    { match: /__name__/, reply: JSON.stringify({ status: 'success', data: ['up', 'node_cpu_seconds_total'] }) },
  ]));
  const status = await src.probe();
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /not HTTP\/RPC instrumented/);
});

test('prometheus: seconds are converted to ms, not reported raw', async () => {
  // 0.0829s is the real p95 measured for cart.get_cart. Reporting it as
  // "0.08 ms" instead of "82.9 ms" would be off by 1000x and look plausible.
  const src = new PrometheusSource('open-telemetry', stubExec([
    { match: /__name__/, reply: NAME_VALUES },
    { match: /label\/service_name\/values/, reply: JSON.stringify({ status: 'success', data: ['cart'] }) },
    { match: /histogram_quantile\(0\.95/, reply: vector([[{ service_name: 'cart' }, '0.0829']]) },
    { match: /rate\(http_server_request_duration_seconds_count/, reply: vector([[{ service_name: 'cart' }, '2.5']]) },
  ]));
  await src.probe();
  const snap = await src.collect(1800);
  const cart = snap.services.find(s => s.serviceName === 'cart');
  assert.ok(cart, 'cart should be present');
  assert.ok(Math.abs((cart!.latencyP95Ms ?? 0) - 82.9) < 0.01, `expected ~82.9ms, got ${cart!.latencyP95Ms}`);
  assert.equal(cart!.requestRate, 2.5);
});

test('prometheus: NaN quantile is dropped, never recorded as zero latency', async () => {
  // histogram_quantile returns NaN when no observations fall in the window.
  // Zero would read as "instant", the opposite of "unknown".
  const src = new PrometheusSource('open-telemetry', stubExec([
    { match: /__name__/, reply: NAME_VALUES },
    { match: /label\/service_name\/values/, reply: JSON.stringify({ status: 'success', data: ['idle-svc'] }) },
    { match: /histogram_quantile/, reply: vector([[{ service_name: 'idle-svc' }, 'NaN']]) },
  ]));
  await src.probe();
  const snap = await src.collect(300);
  const svc = snap.services.find(s => s.serviceName === 'idle-svc');
  assert.ok(svc === undefined || svc.latencyP95Ms === undefined, 'NaN must not become a number');
});

test('prometheus: error rate with no traffic is unknown, not 0%', async () => {
  const src = new PrometheusSource('open-telemetry', stubExec([
    { match: /__name__/, reply: NAME_VALUES },
    { match: /label\/service_name\/values/, reply: JSON.stringify({ status: 'success', data: ['quiet'] }) },
    { match: /label\/http_response_status_code\/values/, reply: JSON.stringify({ status: 'success', data: ['200', '500'] }) },
    { match: /histogram_quantile\(0\.95/, reply: vector([[{ service_name: 'quiet' }, '0.01']]) },
    // no request rate returned -> denominator is zero
  ]));
  await src.probe();
  const snap = await src.collect(300);
  const svc = snap.services.find(s => s.serviceName === 'quiet');
  assert.ok(svc, 'service present');
  assert.equal(svc!.errorRate, null, '0 requests must give unknown error rate, not 0');
});

test('prometheus: error rate is a ratio of the measured request rate', async () => {
  const src = new PrometheusSource('open-telemetry', stubExec([
    { match: /__name__/, reply: NAME_VALUES },
    { match: /label\/service_name\/values/, reply: JSON.stringify({ status: 'success', data: ['shipping'] }) },
    { match: /label\/http_response_status_code\/values/, reply: JSON.stringify({ status: 'success', data: ['200', '500'] }) },
    { match: /5\.\./, reply: vector([[{ service_name: 'shipping' }, '1.0']]) },
    { match: /rate\(http_server_request_duration_seconds_count\[/, reply: vector([[{ service_name: 'shipping' }, '4.0']]) },
  ]));
  await src.probe();
  const snap = await src.collect(300);
  const svc = snap.services.find(s => s.serviceName === 'shipping');
  assert.equal(svc?.errorRate, 0.25, '1 of 4 req/s failing is 25%');
});

test('prometheus: never claims caller -> callee attribution it cannot support', async () => {
  const src = new PrometheusSource('open-telemetry', stubExec([
    { match: /__name__/, reply: NAME_VALUES },
    { match: /label\/service_name\/values/, reply: JSON.stringify({ status: 'success', data: ['cart'] }) },
    { match: /histogram_quantile/, reply: vector([[{ service_name: 'cart' }, '0.05']]) },
  ]));
  await src.probe();
  const snap = await src.collect(300);
  assert.deepEqual(snap.edges, [], 'server-side metrics cannot say who called');
});

test('prometheus: malformed output fails loudly rather than producing numbers', async () => {
  const src = new PrometheusSource('open-telemetry', stubExec([
    { match: /__name__/, reply: NAME_VALUES },
    { match: /label\/service_name\/values/, reply: JSON.stringify({ status: 'success', data: ['cart'] }) },
    { match: /histogram_quantile/, reply: '<html>502 Bad Gateway</html>' },
  ]));
  await src.probe();
  const snap = await src.collect(300);
  assert.ok(snap.warnings.some(w => /did not return JSON/.test(w)), `expected a warning, got ${JSON.stringify(snap.warnings)}`);
});

// --- Tier 2 merge into the graph --------------------------------------
//
// The dangerous failure here is not a wrong number, it is a *silently wiped*
// one: a cycle where the optional source was unavailable must not clear the
// Tier 0 resource metrics collected in the same cycle. Mirrors the merge in
// GraphStore.ingestRemote.
function mergeNodeMetrics(
  existing: Record<string, any> | null,
  incomingRequestMetrics: Record<string, any> | undefined,
): Record<string, any> | null {
  if (!incomingRequestMetrics) return existing;
  return { ...(existing ?? {}), ...incomingRequestMetrics };
}

test('tier2 merge: request metrics are added without losing cgroup metrics', () => {
  const before = { cpu: 12.5, memoryPercent: 40, networkRx: 900 };
  const after = mergeNodeMetrics(before, {
    latencyP95: 82.9,
    requestRate: 2.5,
    errorRate: 0,
    provenance: { source: 'prometheus', tier: 2, observedAt: 'now' },
  });
  assert.equal(after!.cpu, 12.5, 'cgroup CPU must survive');
  assert.equal(after!.memoryPercent, 40);
  assert.equal(after!.latencyP95, 82.9);
  assert.equal(after!.provenance.tier, 2);
});

test('tier2 merge: an unavailable source leaves tier 0 untouched', () => {
  const before = { cpu: 12.5, memoryPercent: 40 };
  const after = mergeNodeMetrics(before, undefined);
  assert.deepEqual(after, before, 'no Tier 2 data must not clear Tier 0');
});

test('tier2 merge: a node with no prior metrics still gets request metrics', () => {
  const after = mergeNodeMetrics(null, { requestRate: 1.1, provenance: { source: 'prometheus', tier: 2, observedAt: 'now' } });
  assert.equal(after!.requestRate, 1.1);
});

test('provenance: a source may not fill a field it cannot measure', async () => {
  const { SOURCE_CAPABILITIES, SOURCE_TIER } = await import('../../server/models/MetricProvenance.js');
  // The whole point of the capability table: a socket scan sees connections,
  // not requests, so it must never be allowed to populate latency.
  assert.equal(SOURCE_CAPABILITIES['socket-scan'].latency, false);
  assert.equal(SOURCE_CAPABILITIES['socket-scan'].errorRate, false);
  assert.equal(SOURCE_CAPABILITIES['cgroup'].latency, false, 'docker stats cannot see latency');
  assert.equal(SOURCE_CAPABILITIES['prometheus'].latency, true);
  assert.equal(SOURCE_TIER['cgroup'], 0);
  assert.equal(SOURCE_TIER['access-log'], 1);
  assert.equal(SOURCE_TIER['prometheus'], 2);
});

// --- tailCsv: read the end of a big file without loading it -----------
//
// The optimisation is only worth anything if it returns exactly what the
// naive full-read returned. These compare the two directly on a generated
// file, including the awkward cases: a chunk boundary landing mid-line, a
// filter matching nothing, and a file smaller than one chunk.
import { tailCsvLines, readCsvHeader, fieldAt } from '../../server/util/tailCsv.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function withCsv(rows: string[], fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'tailcsv-'));
  const path = join(dir, 'f.csv');
  writeFileSync(path, ['ts,service_id,value', ...rows].join('\n') + '\n');
  try { fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What the old implementation did, kept as the oracle. */
function naiveTail(rows: string[], limit: number, serviceId?: string) {
  return rows.filter(l => !serviceId || l.split(',')[1] === serviceId).slice(-limit);
}

test('tailCsv: header is read without touching the body', () => {
  withCsv(['1,a,10'], (path) => {
    assert.deepEqual(readCsvHeader(path), ['ts', 'service_id', 'value']);
  });
});

test('tailCsv: matches the naive full-read, including across chunk boundaries', () => {
  // 5000 rows forces several 256KB chunks and lands boundaries mid-line.
  const rows = Array.from({ length: 5000 }, (_, i) => `${i},svc-${i % 7},${i * 3}`);
  withCsv(rows, (path) => {
    for (const limit of [1, 10, 300, 4999, 5000, 6000]) {
      assert.deepEqual(
        tailCsvLines(path, { limit }),
        naiveTail(rows, limit),
        `limit ${limit} must match the full read`,
      );
    }
  });
});

test('tailCsv: filtering by service matches the naive result', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => `${i},svc-${i % 5},${i}`);
  withCsv(rows, (path) => {
    const match = (line: string) => fieldAt(line, 1) === 'svc-3';
    assert.deepEqual(
      tailCsvLines(path, { limit: 50, match }),
      naiveTail(rows, 50, 'svc-3'),
    );
  });
});

test('tailCsv: the header is never returned as a data row', () => {
  withCsv(['1,a,10', '2,b,20'], (path) => {
    const out = tailCsvLines(path, { limit: 99 });
    assert.equal(out.length, 2);
    assert.ok(!out.some(l => l.startsWith('ts,')), 'header must not appear as data');
  });
});

test('tailCsv: a filter matching nothing terminates instead of scanning forever', () => {
  const rows = Array.from({ length: 4000 }, (_, i) => `${i},svc,${i}`);
  withCsv(rows, (path) => {
    const out = tailCsvLines(path, { limit: 10, match: () => false, maxBytes: 64 * 1024 });
    assert.deepEqual(out, [], 'no matches is an empty result, not a hang');
  });
});

test('tailCsv: empty and tiny files are handled', () => {
  withCsv([], (path) => assert.deepEqual(tailCsvLines(path, { limit: 10 }), []));
  withCsv(['1,a,10'], (path) => assert.deepEqual(tailCsvLines(path, { limit: 10 }), ['1,a,10']));
});

test('fieldAt: reads one column without splitting the line', () => {
  assert.equal(fieldAt('a,b,c,d', 0), 'a');
  assert.equal(fieldAt('a,b,c,d', 2), 'c');
  assert.equal(fieldAt('a,b,c,d', 3), 'd', 'last column has no trailing comma');
  assert.equal(fieldAt('a,b,c,d', 9), '', 'past the end is empty, not a throw');
  assert.equal(fieldAt('a,b,c,d', -1), '');
});

// --- structural sharing -------------------------------------------------------

import { shareById } from '../../client/src/hooks/shareById.ts';

type Item = { id: string; data: { status: string } };

test('shareById: a changed item survives the updater running twice (React StrictMode)', () => {
  const keys = new WeakMap<object, string>();
  const first = shareById<Item>([], ['a', 'b'], new Map([['a', 'healthy'], ['b', 'healthy']]), keys,
    (id) => ({ id, data: { status: 'healthy' } }));

  const incoming = new Map([['a', { status: 'critical' }], ['b', { status: 'healthy' }]]);
  const keyById = new Map([['a', 'critical'], ['b', 'healthy']]);
  const build = (id: string, _i: number, prev?: Item) => ({ ...(prev ?? { id }), id, data: incoming.get(id)! });

  // StrictMode calls the updater twice with the same previous state and keeps
  // one result. Both must carry the change; the second used to return the
  // previous state, and a service that went down stayed drawn healthy.
  const run1 = shareById(first, ['a', 'b'], keyById, keys, build);
  const run2 = shareById(first, ['a', 'b'], keyById, keys, build);
  for (const run of [run1, run2]) {
    assert.notEqual(run, first, 'update was dropped');
    assert.equal(run.find((x) => x.id === 'a')!.data.status, 'critical');
    assert.equal(run.find((x) => x.id === 'b'), first.find((x) => x.id === 'b'), 'unchanged item was rebuilt');
  }
});

test('shareById: nothing changed returns the previous array itself', () => {
  const keys = new WeakMap<object, string>();
  const keyById = new Map([['a', 'k1']]);
  const first = shareById<Item>([], ['a'], keyById, keys, (id) => ({ id, data: { status: 'healthy' } }));
  const again = shareById<Item>(first, ['a'], keyById, keys, (id) => ({ id, data: { status: 'healthy' } }));
  assert.equal(again, first);
});

// --- 3D building ----------------------------------------------------------------

import { computeSite, islandRoleOf } from '../../client/src/components/3d/site.ts';

test('3D islands: every service stands inside its own island, on top of it', () => {
  const nodes = [
    ...make3DNodes(14, 'shop'),
    { id: 'shop:grafana', project: 'shop', type: 'service', degree: 1 },
    { id: 'shop:otel-collector', project: 'shop', type: 'infrastructure', degree: 9 },
    ...make3DNodes(5, 'bank'),
  ];
  const site = computeSite(nodes);
  for (const n of nodes) {
    const [x, y, z] = site.positions[n.id];
    const island = site.islands.find((i) => i.project === n.project && i.role === islandRoleOf(n));
    assert.ok(island, `${n.id}: no ${islandRoleOf(n)} island`);
    assert.ok(x > island!.x0 && x < island!.x1 && z > island!.z0 && z < island!.z1, `${n.id} is outside its island`);
    assert.equal(y, island!.top, `${n.id} is not standing on its island`);
  }
  // Monitoring tools are grouped on their own island, whatever their type.
  assert.equal(islandRoleOf({ id: 'shop:grafana', project: 'shop', type: 'service', degree: 1 }), 'observability');
  assert.equal(islandRoleOf({ id: 'shop:otel-collector', project: 'shop', type: 'infrastructure', degree: 9 }), 'observability');
});

test('3D islands: islands, districts and scenery never overlap, and tracks join real islands', () => {
  const nodes = [...make3DNodes(20, 'a'), ...make3DNodes(7, 'b'), ...make3DNodes(3, 'c'), ...make3DNodes(1, 'd')];
  const site = computeSite(nodes);
  const overlap = (p: { x0: number; x1: number; z0: number; z1: number }, q: typeof p) =>
    p.x0 < q.x1 && q.x0 < p.x1 && p.z0 < q.z1 && q.z0 < p.z1;
  for (let i = 0; i < site.islands.length; i++)
    for (let j = i + 1; j < site.islands.length; j++)
      assert.ok(!overlap(site.islands[i], site.islands[j]), `islands ${site.islands[i].project}/${site.islands[i].role} and ${site.islands[j].project}/${site.islands[j].role} overlap`);
  for (let i = 0; i < site.rooms.length; i++)
    for (let j = i + 1; j < site.rooms.length; j++)
      assert.ok(!overlap(site.rooms[i], site.rooms[j]), `rooms ${site.rooms[i].project} and ${site.rooms[j].project} overlap`);
  const b = site.building!;
  for (const r of site.rooms) assert.ok(r.x0 > b.x0 && r.x1 < b.x1 && r.z0 > b.z0 && r.z1 < b.z1, `district ${r.project} leaves the framed area`);
  // Scenery pads never sit on a district, so they cannot be mistaken for one.
  for (const p of site.pads)
    for (const r of site.rooms) assert.ok(!overlap(p, r), `a scenery pad overlaps district ${r.project}`);
  // Neighbouring rooms are told apart by colour.
  assert.equal(new Set(site.rooms.map((r) => r.hue)).size, site.rooms.length);
});

test('3D islands: tracks only join sections that call each other', () => {
  const nodes = [
    { id: 'p:web', project: 'p', type: 'frontend', degree: 1 },
    { id: 'p:api', project: 'p', type: 'service', degree: 2 },
    { id: 'p:db', project: 'p', type: 'database', degree: 1 },
    { id: 'p:grafana', project: 'p', type: 'service', degree: 0 },
  ];
  const site = computeSite(nodes, [['p:web', 'p:api'], ['p:api', 'p:db'], ['p:api', 'p:api']]);
  const pairs = site.tracks.map((t) => [t.from, t.to].sort().join('-')).sort();
  assert.deepEqual(pairs, ['data-services', 'edge-services']);
});

test('3D islands: empty input is an empty site', () => {
  const site = computeSite([]);
  assert.deepEqual(site.positions, {});
  assert.equal(site.building, null);
});

// --- link flow ------------------------------------------------------------------

import { formatFlow, linkFlow, pulsesFor, svgPulses } from '../../client/src/components/shared/linkFlow.ts';

test('flow: pulses rise with the rate, monotonically and within bounds', () => {
  const rates = [0, 0.1, 1, 2, 10, 30, 100, 500, 5000];
  const pulses = rates.map(pulsesFor);
  for (let i = 1; i < pulses.length; i++) assert.ok(pulses[i] >= pulses[i - 1], `pulses fell between ${rates[i - 1]} and ${rates[i]}/s`);
  assert.ok(pulses[0] >= 0.25 && pulses[pulses.length - 1] <= 5);
  // A busy link visibly out-pulses a quiet one.
  assert.ok(pulsesFor(100) > pulsesFor(1) * 2.5);
});

test('flow: measured requests win over socket activity, and labels say which they are', () => {
  const base = { id: 'a->b', source: 'a', target: 'b', type: 'dependency', declared: true, observed: true, evidenceSources: [], status: 'active' } as const;
  const activity = { samplesPerMin: 600, windowSec: 60, lastSeen: new Date().toISOString(), openConnections: 2, newConnectionsPerMin: 8 };
  const bySockets = linkFlow({ ...base, metrics: null, activity } as any)!;
  assert.equal(bySockets.basis, 'activity');
  assert.equal(bySockets.requestsPerSecond, null);
  // Shown as distinct connections, never as a per-second rate of anything.
  assert.equal(formatFlow({ ...base, metrics: null, activity } as any), '2 open · 8 new/min');
  assert.doesNotMatch(formatFlow({ ...base, metrics: null, activity } as any), /\/s/);
  const byRequests = linkFlow({ ...base, metrics: { requestRate: 42 }, activity } as any)!;
  assert.equal(byRequests.basis, 'requests');
  assert.equal(byRequests.requestsPerSecond, 42);
  assert.equal(formatFlow({ ...base, metrics: { requestRate: 42 }, activity } as any), '42.0 req/s');
  assert.equal(linkFlow({ ...base, metrics: null } as any), null);
});

test('flow: svg timing delivers exactly the pulse rate', () => {
  for (const [pulses, length] of [[0.4, 300], [2.7, 180], [5, 900], [1, 40]] as const) {
    const { count, dur } = svgPulses(pulses, length);
    assert.ok(Math.abs(count / dur - pulses) < 1e-9, `${pulses}/s over ${length}px gave ${count / dur}/s`);
    assert.ok(count >= 1 && count <= 8);
  }
});

// --- one definition of a troubled link --------------------------------------

import { LINK_THRESHOLDS } from '../../client/src/components/shared/edgeHeat.ts';
import { LINK_THRESHOLDS as SERVER_LINK_THRESHOLDS, linkStatus } from '../../server/algorithms/graph/linkThresholds.ts';

test('links: the server\'s status and the client\'s colours use the same thresholds', () => {
  assert.deepEqual({ ...SERVER_LINK_THRESHOLDS }, { ...LINK_THRESHOLDS });
  // And agree case by case: status failed <=> colour red, degraded <=> orange.
  const cases: [number | null, number | null][] = [[0, 50], [0.009, 299], [0.01, 50], [0, 300], [0.049, 999], [0.05, 10], [0, 1000], [null, null]];
  for (const [errorRate, latency] of cases) {
    const heat = edgeAppearance(edge({ observed: true, metrics: { errorRate, latency } as any })).heat;
    const status = linkStatus(errorRate, latency);
    const expected = status === 'failed' ? 'failed' : status === 'degraded' ? 'degraded' : heat;
    assert.equal(heat, expected, `errors ${errorRate}, latency ${latency}: status ${status} but colour ${heat}`);
  }
});
