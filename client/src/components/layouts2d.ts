import type { Edge, Node } from '@xyflow/react';

export type Layout2DId =
  | 'clusters'
  | 'hierarchy'
  | 'grid'
  | 'circle'
  | 'polygon'
  | 'radial'
  | 'tiers'
  | 'spiral';

export interface Layout2DOption {
  id: Layout2DId;
  label: string;
  hint: string;
}

export const LAYOUTS_2D: Layout2DOption[] = [
  { id: 'clusters', label: 'Clusters', hint: 'Each project laid out separately, services stacked by role' },
  { id: 'hierarchy', label: 'Hierarchy', hint: 'Flows left to right by dependency depth — entry points first' },
  { id: 'tiers', label: 'Tiers', hint: 'All projects share rows by role: gateways on top, databases at the bottom' },
  { id: 'grid', label: 'Grid', hint: 'Even rows and columns — easiest to scan a lot of services' },
  { id: 'circle', label: 'Circle', hint: 'Single ring, every service equally spaced' },
  { id: 'polygon', label: 'Polygon', hint: 'Distributed along the edges of an n-sided shape' },
  { id: 'radial', label: 'Radial', hint: 'Concentric rings by dependency count — busiest in the middle' },
  { id: 'spiral', label: 'Spiral', hint: 'One continuous outward spiral, good for a long chain' },
];

export type Positions2D = Record<string, { x: number; y: number }>;

// React Flow nodes are ~220px wide and ~110px tall, so spacing is in those
// terms rather than the abstract units the 3D scene uses.
const X_SPACING = 260;
const Y_SPACING = 190;

const TIER_ORDER = ['frontend', 'gateway', 'service', 'queue', 'cache', 'database', 'infrastructure', 'external'];

function tierOf(type: string): number {
  const i = TIER_ORDER.indexOf(type);
  return i === -1 ? TIER_ORDER.indexOf('service') : i;
}

interface Item {
  id: string;
  project: string;
  type: string;
  degree: number;
}

function toItems(nodes: Node[], edges: Edge[]): Item[] {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  return nodes.map((n) => {
    const d = n.data as any;
    return {
      id: n.id,
      project: d?.project || 'unknown',
      type: d?.type || 'service',
      degree: degree.get(n.id) || 0,
    };
  });
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(item);
  }
  return out;
}

/**
 * Left-to-right dependency depth. Sources (nothing depends on them — the
 * entry points) sit in the first column, and each service is placed one
 * column right of its deepest depender. Cycles are common in a real mesh,
 * so depth is computed with a visited set rather than assuming a DAG.
 */
function hierarchyDepths(items: Item[], edges: Edge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const ids = new Set(items.map((i) => i.id));

  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e.target);
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e.source);
  }

  const depth = new Map<string, number>();
  const roots = items.filter((i) => (incoming.get(i.id)?.length ?? 0) === 0);
  // A fully cyclic component has no root; seed it with the most-connected
  // node so those services still get laid out instead of piling at zero.
  const seeds = roots.length > 0 ? roots : [...items].sort((a, b) => b.degree - a.degree).slice(0, 1);

  const queue: Array<{ id: string; d: number }> = seeds.map((s) => ({ id: s.id, d: 0 }));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    if (visited.has(id) && (depth.get(id) ?? 0) >= d) continue;
    visited.add(id);
    depth.set(id, Math.max(depth.get(id) ?? 0, d));
    for (const next of outgoing.get(id) || []) {
      if (!visited.has(next) || (depth.get(next) ?? 0) < d + 1) {
        queue.push({ id: next, d: d + 1 });
      }
    }
  }

  for (const item of items) if (!depth.has(item.id)) depth.set(item.id, 0);
  return depth;
}

export function computeLayout2D(layout: Layout2DId, nodes: Node[], edges: Edge[]): Positions2D {
  const items = toItems(nodes, edges);
  const positions: Positions2D = {};
  const n = items.length;
  if (n === 0) return positions;

  switch (layout) {
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(n));
      items.forEach((item, i) => {
        positions[item.id] = {
          x: (i % cols) * X_SPACING,
          y: Math.floor(i / cols) * Y_SPACING,
        };
      });
      return positions;
    }

    case 'circle': {
      const radius = Math.max(320, (n * X_SPACING * 0.6) / (2 * Math.PI));
      items.forEach((item, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        positions[item.id] = { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
      });
      return positions;
    }

    case 'polygon': {
      const sides = Math.min(8, Math.max(3, Math.round(Math.sqrt(n))));
      const radius = Math.max(360, (n * X_SPACING * 0.55) / (2 * Math.PI));
      const perSide = Math.ceil(n / sides);
      items.forEach((item, i) => {
        const side = Math.floor(i / perSide) % sides;
        const along = (i % perSide) / perSide;
        const a1 = (side / sides) * Math.PI * 2 - Math.PI / 2;
        const a2 = ((side + 1) / sides) * Math.PI * 2 - Math.PI / 2;
        const x1 = Math.cos(a1) * radius, y1 = Math.sin(a1) * radius;
        const x2 = Math.cos(a2) * radius, y2 = Math.sin(a2) * radius;
        positions[item.id] = { x: x1 + (x2 - x1) * along, y: y1 + (y2 - y1) * along };
      });
      return positions;
    }

    case 'radial': {
      const sorted = [...items].sort((a, b) => b.degree - a.degree);
      let placed = 0;
      let ring = 0;
      while (placed < sorted.length) {
        const capacity = ring === 0 ? 1 : Math.max(6, ring * 6);
        const count = Math.min(capacity, sorted.length - placed);
        const radius = ring * 300;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + ring * 0.4;
          positions[sorted[placed + i].id] = ring === 0
            ? { x: 0, y: 0 }
            : { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
        }
        placed += count;
        ring++;
      }
      return positions;
    }

    case 'spiral': {
      items.forEach((item, i) => {
        const a = i * 0.5;
        const radius = 120 + i * 26;
        positions[item.id] = { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
      });
      return positions;
    }

    case 'tiers': {
      // Wrapped: with 60 services one role can hold 35+ of them, and an
      // unwrapped row stretches the canvas to ~10,000px of horizontal pan.
      const maxPerRow = 10;
      const byTier = groupBy(items, (i) => String(tierOf(i.type)));
      const tiers = Array.from(byTier.keys()).sort((a, b) => Number(a) - Number(b));
      let cursorY = 0;
      for (const tier of tiers) {
        const group = byTier.get(tier)!;
        const rows = Math.ceil(group.length / maxPerRow);
        for (let row = 0; row < rows; row++) {
          const rowItems = group.slice(row * maxPerRow, row * maxPerRow + maxPerRow);
          const offset = ((rowItems.length - 1) * X_SPACING) / 2;
          rowItems.forEach((item, i) => {
            positions[item.id] = { x: i * X_SPACING - offset, y: cursorY + row * Y_SPACING };
          });
        }
        cursorY += rows * Y_SPACING + 70;
      }
      return positions;
    }

    case 'hierarchy': {
      const depth = hierarchyDepths(items, edges);
      const byDepth = groupBy(items, (i) => String(depth.get(i.id) ?? 0));
      const columns = Array.from(byDepth.keys()).sort((a, b) => Number(a) - Number(b));
      // Columns wrap too: a depth level holding 35 services becomes a
      // 7,000px vertical strip otherwise. Overflow splits into sub-columns
      // beside the main one, keeping the left-to-right flow readable.
      const maxPerColumn = 12;
      let cursorX = 0;
      columns.forEach((col) => {
        const group = byDepth.get(col)!;
        const subColumns = Math.ceil(group.length / maxPerColumn);
        for (let sc = 0; sc < subColumns; sc++) {
          const colItems = group.slice(sc * maxPerColumn, sc * maxPerColumn + maxPerColumn);
          const offset = ((colItems.length - 1) * Y_SPACING) / 2;
          colItems.forEach((item, i) => {
            positions[item.id] = { x: cursorX + sc * X_SPACING, y: i * Y_SPACING - offset };
          });
        }
        cursorX += subColumns * X_SPACING + X_SPACING * 0.6;
      });
      return positions;
    }

    case 'clusters':
    default: {
      // Project blocks side by side; within a block, rows by role. Rows wrap
      // so one wide layer can't stretch a project into an unreadable strip.
      const maxPerRow = 6;
      const byProject = groupBy(items, (i) => i.project);
      const projects = Array.from(byProject.keys()).sort();
      let cursorX = 0;

      for (const project of projects) {
        const group = byProject.get(project)!;
        const byTier = groupBy(group, (i) => String(tierOf(i.type)));
        const tiers = Array.from(byTier.keys()).sort((a, b) => Number(a) - Number(b));
        const blockWidth = Math.max(
          ...tiers.map((t) => Math.min(byTier.get(t)!.length, maxPerRow)),
          1
        ) * X_SPACING;

        let cursorY = 0;
        for (const tier of tiers) {
          const tierNodes = byTier.get(tier)!;
          const rows = Math.ceil(tierNodes.length / maxPerRow);
          for (let row = 0; row < rows; row++) {
            const rowNodes = tierNodes.slice(row * maxPerRow, row * maxPerRow + maxPerRow);
            const startX = cursorX + (blockWidth - (rowNodes.length - 1) * X_SPACING) / 2;
            rowNodes.forEach((item, i) => {
              positions[item.id] = { x: startX + i * X_SPACING, y: cursorY + row * Y_SPACING };
            });
          }
          cursorY += rows * Y_SPACING + 70;
        }
        cursorX += blockWidth + 260;
      }
      return positions;
    }
  }
}
