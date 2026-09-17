/**
 * Tests for the pure logic behind the views: spatial arrangements (2D and
 * 3D) and the shared edge heat scale. These are the pieces where a silent
 * bug is invisible — a layout that quietly drops a node, or a heat band
 * that never triggers, looks like "the data is like that" on screen.
 *
 * Run: npx tsx --test tests/logic.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout2D, LAYOUTS_2D, type Layout2DId } from '../client/src/components/layouts2d.ts';
import { computeLayout, LAYOUTS, type LayoutId, type LayoutNode } from '../client/src/components/3d/layouts.ts';
import { edgeAppearance } from '../client/src/components/shared/edgeHeat.ts';
import type { DependencyEdge } from '../client/src/types/index.ts';

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
  assert.match(a.color, /^#5b6778$/i);
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

test('heat: intensity stays below full so links read as lighting, not glare', () => {
  const all = [
    edgeAppearance(edge({ observed: false })),
    edgeAppearance(edge({ observed: true })),
    edgeAppearance(edge({ observed: true, status: 'failed' })),
  ];
  for (const a of all) {
    assert.ok(a.intensity <= 0.8, `intensity ${a.intensity} is too hot`);
    assert.ok(a.intensity > 0, 'intensity must be visible');
  }
});

test('heat: undefined edge does not throw', () => {
  const a = edgeAppearance(undefined);
  assert.ok(a.color);
  assert.equal(a.heat, 'idle');
});
