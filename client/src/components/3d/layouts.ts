import { computeSite } from './site';

export type LayoutId =
  | 'halls'
  | 'flow'
  | 'topology'
  | 'clusters'
  | 'grid'
  | 'tiers'
  | 'radial'
  | 'circle'
  | 'polygon'
  | 'sphere'
  | 'helix';

export interface LayoutOption {
  id: LayoutId;
  label: string;
  hint: string;
}

export const LAYOUTS: LayoutOption[] = [
  { id: 'halls', label: 'Islands', hint: 'Each project a district of platforms by role: edge, services, data, messaging, with observability set apart' },
  { id: 'flow', label: 'Flow', hint: 'Stepped architectural decks: Ingress on upper deck, services in mid-deck, and data on illuminated bedrock' },
  { id: 'topology', label: 'Topology', hint: 'Organic 3D force simulation: communicating services physically cluster by real-time call frequency' },
  { id: 'clusters', label: 'Clusters', hint: 'One island per project, laid out side by side' },
  { id: 'tiers', label: 'Tiers', hint: 'Stacked by role: gateways on top, databases at the bottom' },
  { id: 'radial', label: 'Radial', hint: 'Concentric rings by dependency count - busiest in the middle' },
  { id: 'grid', label: 'Grid', hint: 'Even rows and columns - easiest to scan a lot of services' },
  { id: 'circle', label: 'Circle', hint: 'Single ring, every service equally spaced' },
  { id: 'polygon', label: 'Polygon', hint: 'Services distributed along the edges of an n-sided shape' },
  { id: 'sphere', label: 'Sphere', hint: 'Even spread over a sphere (Fibonacci)' },
  { id: 'helix', label: 'Helix', hint: 'Rising spiral - good for spotting one long chain' },
];

export interface LayoutNode {
  id: string;
  project: string;
  type: string;
  /** Number of edges touching this node, used by the radial layout. */
  degree: number;
}

export type Positions = Record<string, [number, number, number]>;

const TIER_ORDER = ['frontend', 'gateway', 'service', 'queue', 'cache', 'database', 'infrastructure'];

/** Layouts that keep each project in its own patch of floor, so a zone can
 *  be drawn under it without overlapping another project's. */
export const ZONED_LAYOUTS: ReadonlySet<LayoutId> = new Set<LayoutId>(['halls', 'clusters']);

/** Layouts where each project's services sit together, so a floating name
 *  over their centre points at them. In the rest (tiers, radial, sphere,
 *  helix) projects interleave and every name lands in the same spot. */
export const LABELLED_LAYOUTS: ReadonlySet<LayoutId> = new Set<LayoutId>(['grid', 'circle', 'polygon', 'flow', 'topology']);

/** Margin between a hall's outermost services and its walls. */
export const HALL_PADDING = 6;

function tierOf(type: string): number {
  const i = TIER_ORDER.indexOf(type);
  return i === -1 ? TIER_ORDER.indexOf('service') : i;
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
 * Every layout returns ground-plane positions (x, 0, z) except the ones
 * that are deliberately vertical (tiers, sphere, helix). Spacing is scaled
 * by node count so a 15-service target and a 60-service one both stay
 * readable without the camera having to move.
 */
export function computeLayout(
  layout: LayoutId,
  nodes: LayoutNode[],
  edges: any[] = [],
  links: [string, string][] = []
): Positions {
  const positions: Positions = {};
  const n = nodes.length;
  if (n === 0) return positions;

  switch (layout) {
    case 'flow': {
      // Stepped Architectural Flow:
      // Ingress on Deck 3 (y=16), Services on Deck 2 (y=8), Data on Bedrock Deck 1 (y=0),
      // and Side Wing for Queues/Infra (y=4).
      const ingress: LayoutNode[] = [];
      const services: LayoutNode[] = [];
      const data: LayoutNode[] = [];
      const wing: LayoutNode[] = [];

      nodes.forEach((node) => {
        if (node.type === 'gateway' || node.type === 'frontend') ingress.push(node);
        else if (node.type === 'database' || node.type === 'cache') data.push(node);
        else if (node.type === 'queue' || node.type === 'infrastructure' || node.type === 'external' || node.type === 'observability') wing.push(node);
        else services.push(node);
      });

      ingress.sort((a, b) => b.degree - a.degree);
      services.sort((a, b) => b.degree - a.degree);
      data.sort((a, b) => b.degree - a.degree);
      wing.sort((a, b) => b.degree - a.degree);

      const placeDeck = (deckNodes: LayoutNode[], y: number, centerZ: number, gapX = 14, gapZ = 12, maxCols = 5) => {
        const count = deckNodes.length;
        if (count === 0) return;
        const cols = Math.min(count, maxCols);
        const rows = Math.ceil(count / cols);
        const zOffset = ((rows - 1) * gapZ) / 2;

        deckNodes.forEach((node, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const inThisRow = Math.min(count - row * cols, cols);
          const xOffset = ((inThisRow - 1) * gapX) / 2;
          positions[node.id] = [
            col * gapX - xOffset,
            y,
            centerZ + (row * gapZ - zOffset)
          ];
        });
      };

      // Ingress closest to camera along +Z at elevation y=16
      placeDeck(ingress, 16, 26, 14, 12, 4);
      // Processing services in mid-deck at y=8, z=0
      placeDeck(services, 8, 0, 13, 12, 6);
      // Data stores at bedrock level y=0, z=-26
      placeDeck(data, 0, -26, 14, 12, 4);
      // Side wing placed laterally
      if (wing.length > 0) {
        const wingX = -32 - Math.sqrt(services.length) * 4;
        wing.forEach((node, i) => {
          positions[node.id] = [wingX, 4, -10 + i * 11];
        });
      }

      return positions;
    }

    case 'topology': {
      // Real-time 3D Force-Directed Simulation based on actual dependency weights
      const idMap = new Map<string, number>();
      nodes.forEach((node, i) => idMap.set(node.id, i));

      const pairWeights = new Map<string, number>();
      for (const e of edges) {
        const src = e.source, tgt = e.target;
        if (idMap.has(src) && idMap.has(tgt)) {
          const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
          const spm = (e.data as any)?.activity?.samplesPerMin || 0;
          const weight = 1.0 + Math.min(10, Math.log10(spm + 1) * 2.5);
          pairWeights.set(key, (pairWeights.get(key) || 0) + weight);
        }
      }
      for (const [src, tgt] of links) {
        if (idMap.has(src) && idMap.has(tgt)) {
          const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
          if (!pairWeights.has(key)) pairWeights.set(key, 1.5);
        }
      }

      const coords: [number, number, number][] = nodes.map((_, i) => {
        const angle = (i / n) * Math.PI * 2;
        const rad = Math.max(16, Math.sqrt(n) * 7);
        const y = ((i % 3) - 1) * 5 + 6;
        return [Math.cos(angle) * rad, y, Math.sin(angle) * rad];
      });

      const iterations = 60;
      const k = 16.0;
      for (let iter = 0; iter < iterations; iter++) {
        const temp = (1 - iter / iterations) * 0.9;
        const disp: [number, number, number][] = nodes.map(() => [0, 0, 0]);

        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            let dx = coords[i][0] - coords[j][0];
            let dy = coords[i][1] - coords[j][1];
            let dz = coords[i][2] - coords[j][2];
            let distSq = dx * dx + dy * dy + dz * dz + 0.04;
            let dist = Math.sqrt(distSq);
            let rep = (k * k) / distSq;
            let fx = (dx / dist) * rep;
            let fy = (dy / dist) * rep * 0.5;
            let fz = (dz / dist) * rep;

            disp[i][0] += fx; disp[i][1] += fy; disp[i][2] += fz;
            disp[j][0] -= fx; disp[j][1] -= fy; disp[j][2] -= fz;
          }
        }

        for (const [key, weight] of pairWeights) {
          const [idA, idB] = key.split('|');
          const i = idMap.get(idA)!, j = idMap.get(idB)!;
          let dx = coords[i][0] - coords[j][0];
          let dy = coords[i][1] - coords[j][1];
          let dz = coords[i][2] - coords[j][2];
          let dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
          let att = ((dist * dist) / k) * Math.min(weight, 3.5);
          let fx = (dx / dist) * att;
          let fy = (dy / dist) * att * 0.5;
          let fz = (dz / dist) * att;

          disp[i][0] -= fx; disp[i][1] += fy; disp[i][2] += fz;
          disp[j][0] += fx; disp[j][1] += fy; disp[j][2] += fz;
        }

        for (let i = 0; i < n; i++) {
          let dLen = Math.sqrt(disp[i][0] * disp[i][0] + disp[i][1] * disp[i][1] + disp[i][2] * disp[i][2]) + 0.001;
          let step = Math.min(dLen, 12 * temp);
          coords[i][0] += (disp[i][0] / dLen) * step;
          coords[i][1] = Math.max(0, Math.min(24, coords[i][1] + (disp[i][1] / dLen) * step));
          coords[i][2] += (disp[i][2] / dLen) * step;
        }
      }

      let cx = 0, cz = 0;
      coords.forEach((c) => { cx += c[0]; cz += c[2]; });
      cx /= n; cz /= n;

      nodes.forEach((node, i) => {
        positions[node.id] = [coords[i][0] - cx, coords[i][1], coords[i][2] - cz];
      });

      return positions;
    }

    case 'grid': {
      const cols = Math.ceil(Math.sqrt(n));
      const gap = 12;
      const offset = ((cols - 1) * gap) / 2;
      nodes.forEach((node, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        positions[node.id] = [col * gap - offset, 0, row * gap - offset];
      });
      return positions;
    }

    case 'circle': {
      // Keep arc length between neighbours roughly constant, so the ring
      // grows with the service count instead of crowding.
      const radius = Math.max(18, (n * 8.5) / (2 * Math.PI));
      nodes.forEach((node, i) => {
        const angle = (i / n) * Math.PI * 2;
        positions[node.id] = [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
      });
      return positions;
    }

    case 'polygon': {
      const sides = Math.min(8, Math.max(3, Math.round(Math.sqrt(n))));
      const radius = Math.max(20, (n * 8) / (2 * Math.PI));
      const perSide = Math.ceil(n / sides);
      nodes.forEach((node, i) => {
        const side = Math.floor(i / perSide) % sides;
        const alongSide = (i % perSide) / perSide;
        const a1 = (side / sides) * Math.PI * 2;
        const a2 = ((side + 1) / sides) * Math.PI * 2;
        const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
        const x2 = Math.cos(a2) * radius, z2 = Math.sin(a2) * radius;
        positions[node.id] = [x1 + (x2 - x1) * alongSide, 0, z1 + (z2 - z1) * alongSide];
      });
      return positions;
    }

    case 'radial': {
      // Most-connected services in the centre, leaves pushed outward - the
      // shape itself then says which services are load-bearing.
      const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
      let placed = 0;
      let ring = 0;
      while (placed < sorted.length) {
        const capacity = ring === 0 ? 1 : Math.max(6, ring * 6);
        const count = Math.min(capacity, sorted.length - placed);
        const radius = ring * 14;
        for (let i = 0; i < count; i++) {
          const angle = (i / count) * Math.PI * 2 + ring * 0.4;
          const node = sorted[placed + i];
          positions[node.id] = ring === 0
            ? [0, 0, 0]
            : [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
        }
        placed += count;
        ring++;
      }
      return positions;
    }

    case 'tiers': {
      // Each tier is a wrapped slab in the XZ plane at its own height, not a
      // single row. Unwrapped, a 19-service tier became one flat line 220
      // units wide that reads as a wall from any normal camera angle - the
      // 2D view wraps for the same reason.
      const byTier = groupBy(nodes, (node) => String(tierOf(node.type)));
      const tiers = Array.from(byTier.keys()).sort((a, b) => Number(a) - Number(b));
      const maxPerRow = 7;
      const gapX = 12;
      const gapZ = 12;
      tiers.forEach((tier, tierIndex) => {
        const group = byTier.get(tier)!;
        const rows = Math.ceil(group.length / maxPerRow);
        const zOffset = ((rows - 1) * gapZ) / 2;
        // Top tier (frontend) highest, databases nearest the floor.
        const y = (tiers.length - 1 - tierIndex) * 15;
        group.forEach((node, i) => {
          const col = i % maxPerRow;
          const row = Math.floor(i / maxPerRow);
          const inThisRow = Math.min(group.length - row * maxPerRow, maxPerRow);
          const xOffset = ((inThisRow - 1) * gapX) / 2;
          positions[node.id] = [col * gapX - xOffset, y, row * gapZ - zOffset];
        });
      });
      return positions;
    }

    case 'sphere': {
      // Fibonacci sphere: even spacing without clumping at the poles.
      const radius = Math.max(20, n * 1.3);
      const golden = Math.PI * (3 - Math.sqrt(5));
      nodes.forEach((node, i) => {
        const y = 1 - (i / Math.max(1, n - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        positions[node.id] = [
          Math.cos(theta) * r * radius,
          y * radius * 0.6 + radius * 0.65,
          Math.sin(theta) * r * radius,
        ];
      });
      return positions;
    }

    case 'helix': {
      const radius = 24;
      const turns = Math.max(1.5, n / 12);
      nodes.forEach((node, i) => {
        const t = i / Math.max(1, n - 1);
        const angle = t * Math.PI * 2 * turns;
        positions[node.id] = [Math.cos(angle) * radius, t * (n * 1.2), Math.sin(angle) * radius];
      });
      return positions;
    }

    case 'halls':
      // Islands: a district per project, a platform per role. The geometry
      // lives in site.ts, which the scene also uses to draw it.
      return computeSite(nodes).positions;

    case 'clusters':
    default: {
      // Project islands: each project gets its own ring, and the islands
      // themselves are placed around a larger circle so no two overlap.
      const byProject = groupBy(nodes, (node) => node.project || 'unknown');
      const projects = Array.from(byProject.keys()).sort();
      const islandRadii = projects.map(p => {
        const count = byProject.get(p)!.length;
        return Math.max(11, (count * 8) / (2 * Math.PI));
      });
      const ringRadius = projects.length <= 1
        ? 0
        : Math.max(...islandRadii) * 2.2 + projects.length * 9;

      projects.forEach((project, pIndex) => {
        const group = byProject.get(project)!;
        const islandRadius = islandRadii[pIndex];
        const centerAngle = (pIndex / projects.length) * Math.PI * 2;
        const cx = Math.cos(centerAngle) * ringRadius;
        const cz = Math.sin(centerAngle) * ringRadius;

        if (group.length === 1) {
          positions[group[0].id] = [cx, 0, cz];
          return;
        }
        group.forEach((node, i) => {
          const angle = (i / group.length) * Math.PI * 2;
          positions[node.id] = [
            cx + Math.cos(angle) * islandRadius,
            0,
            cz + Math.sin(angle) * islandRadius,
          ];
        });
      });
      return positions;
    }
  }
}
