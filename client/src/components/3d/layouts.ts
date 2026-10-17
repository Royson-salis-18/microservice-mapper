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
  { id: 'halls', label: 'Islands', hint: 'Datacenter halls: each project grouped into physical districts by role' },
  { id: 'flow', label: 'Flow', hint: 'Horizontal request pipeline: Ingress (left) → Services (center) → Queues → Data (right)' },
  { id: 'topology', label: 'Topology', hint: 'Organic network graph: high-traffic microservices cluster together on the grid' },
  { id: 'tiers', label: 'Tiers', hint: 'Stepped amphitheater terrace: presentation at highest step, databases at bedrock' },
  { id: 'clusters', label: 'Clusters', hint: 'One island per project, laid out side by side' },
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
      // Horizontal Request Pipeline (Left-to-Right Conveyor):
      // Stage 1: INGRESS (Frontend, Gateway) -> Left (X = -56)
      // Stage 2: PROCESSING (Core Microservices) -> Center-Left (X = -12)
      // Stage 3: MESSAGING & INFRA (Queues, Brokers, Cache) -> Center-Right (X = +28)
      // Stage 4: DATA BEDROCK (Databases, Datastores) -> Right (X = +64)
      const ingress: LayoutNode[] = [];
      const coreServices: LayoutNode[] = [];
      const asyncInfra: LayoutNode[] = [];
      const storage: LayoutNode[] = [];

      nodes.forEach((node) => {
        if (node.type === 'gateway' || node.type === 'frontend') ingress.push(node);
        else if (node.type === 'database') storage.push(node);
        else if (node.type === 'queue' || node.type === 'cache' || node.type === 'infrastructure' || node.type === 'external' || node.type === 'observability') asyncInfra.push(node);
        else coreServices.push(node);
      });

      const sortByDegree = (arr: LayoutNode[]) => {
        arr.sort((a, b) => b.degree - a.degree);
      };
      sortByDegree(ingress);
      sortByDegree(coreServices);
      sortByDegree(asyncInfra);
      sortByDegree(storage);

      const placeStage = (stageNodes: LayoutNode[], baseX: number, gapZ = 22, maxPerCol = 5) => {
        const count = stageNodes.length;
        if (count === 0) return;
        const cols = Math.ceil(count / maxPerCol);
        const colGapX = 18;
        const startX = baseX - ((cols - 1) * colGapX) / 2;

        stageNodes.forEach((node, i) => {
          const colIndex = Math.floor(i / maxPerCol);
          const inColIndex = i % maxPerCol;
          const itemsInThisCol = Math.min(count - colIndex * maxPerCol, maxPerCol);
          const zOffset = ((itemsInThisCol - 1) * gapZ) / 2;
          const x = startX + colIndex * colGapX;
          const z = inColIndex * gapZ - zOffset;
          // All nodes rest cleanly on ground level y = 0 with zero vertical occlusion
          positions[node.id] = [x, 0, z];
        });
      };

      placeStage(ingress, -56, 22, 5);
      placeStage(coreServices, -12, 22, 5);
      placeStage(asyncInfra, 28, 22, 5);
      placeStage(storage, 64, 22, 5);

      return positions;
    }

    case 'topology': {
      // Organic Network Graph: services group into high-affinity clusters based on live traffic
      const idMap = new Map<string, number>();
      nodes.forEach((node, i) => idMap.set(node.id, i));

      // Build real-time call frequency weights
      const pairWeights = new Map<string, number>();
      for (const e of edges) {
        const src = e.source, tgt = e.target;
        if (idMap.has(src) && idMap.has(tgt)) {
          const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
          const spm = (e.data as any)?.activity?.samplesPerMin || 0;
          const weight = 1.0 + Math.min(8, Math.log10(spm + 1) * 3);
          pairWeights.set(key, (pairWeights.get(key) || 0) + weight);
        }
      }
      for (const [src, tgt] of links) {
        if (idMap.has(src) && idMap.has(tgt)) {
          const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
          if (!pairWeights.has(key)) pairWeights.set(key, 1.8);
        }
      }

      // Initial positions: distribute radially on the floor with generous radius
      const initialRadius = Math.max(32, Math.sqrt(n) * 15);
      const coords: [number, number][] = nodes.map((_, i) => {
        const angle = (i / n) * Math.PI * 2;
        return [Math.cos(angle) * initialRadius, Math.sin(angle) * initialRadius];
      });

      // 2D Force-Directed Simulation on the floor grid (y = 0)
      const iterations = 80;
      const k = 28.0;
      const minDistance = 22.0; // Enforce minimum spacing between services!

      for (let iter = 0; iter < iterations; iter++) {
        const temp = (1 - iter / iterations) * 0.85;
        const disp: [number, number][] = nodes.map(() => [0, 0]);

        // Repulsive forces between all node pairs
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            let dx = coords[i][0] - coords[j][0];
            let dz = coords[i][1] - coords[j][1];
            let distSq = dx * dx + dz * dz + 0.01;
            let dist = Math.sqrt(distSq);

            // Strong repulsive force, extra strong if within minDistance
            let repFactor = dist < minDistance ? (minDistance * minDistance * 2.2) / distSq : (k * k) / distSq;
            let fx = (dx / dist) * repFactor;
            let fz = (dz / dist) * repFactor;

            disp[i][0] += fx; disp[i][1] += fz;
            disp[j][0] -= fx; disp[j][1] -= fz;
          }
        }

        // Attractive forces along edges
        for (const [key, weight] of pairWeights) {
          const [idA, idB] = key.split('|');
          const i = idMap.get(idA)!, j = idMap.get(idB)!;
          let dx = coords[i][0] - coords[j][0];
          let dz = coords[i][1] - coords[j][1];
          let dist = Math.sqrt(dx * dx + dz * dz) + 0.01;
          
          if (dist > minDistance) {
            let att = ((dist * dist) / k) * Math.min(weight, 3.0);
            let fx = (dx / dist) * att;
            let fz = (dz / dist) * att;

            disp[i][0] -= fx; disp[i][1] -= fz;
            disp[j][0] -= fx; disp[j][1] -= fz;
          }
        }

        // Gentle center gravity
        for (let i = 0; i < n; i++) {
          let distFromCenter = Math.sqrt(coords[i][0] * coords[i][0] + coords[i][1] * coords[i][1]) + 0.01;
          disp[i][0] -= (coords[i][0] / distFromCenter) * 0.6;
          disp[i][1] -= (coords[i][0] / distFromCenter) * 0.6;
        }

        // Apply displacement capped by temperature
        for (let i = 0; i < n; i++) {
          let dLen = Math.sqrt(disp[i][0] * disp[i][0] + disp[i][1] * disp[i][1]) + 0.001;
          let step = Math.min(dLen, 14 * temp);
          coords[i][0] += (disp[i][0] / dLen) * step;
          coords[i][1] += (disp[i][1] / dLen) * step;
        }
      }

      // Center the graph
      let cx = 0, cz = 0;
      coords.forEach((c) => { cx += c[0]; cz += c[1]; });
      cx /= n; cz /= n;

      nodes.forEach((node, i) => {
        positions[node.id] = [coords[i][0] - cx, 0, coords[i][1] - cz];
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
      // Stepped Amphitheater Terrace:
      // Ascends in elevation (Y) and steps backward in depth (Z).
      // Presentation tier is highest and stepped forward; databases at bedrock stepped backward.
      // Because each tier steps back in Z as it drops in Y, from the default
      // 45-degree camera angle EVERY node on EVERY tier is 100% visible with ZERO occlusion!
      const byTier = groupBy(nodes, (node) => String(tierOf(node.type)));
      const tiers = Array.from(byTier.keys()).sort((a, b) => Number(a) - Number(b));
      const maxPerRow = 5;
      const gapX = 22; // Generous horizontal spacing
      const gapZ = 20; // Generous depth spacing within a tier

      const tierCount = tiers.length;
      tiers.forEach((tier, tierIndex) => {
        const group = byTier.get(tier)!;
        const rows = Math.ceil(group.length / maxPerRow);
        const zOffset = ((rows - 1) * gapZ) / 2;
        
        // Reverse index: Presentation highest (tierIndex = 0), databases nearest floor
        const stepRank = tierCount - 1 - tierIndex;
        const y = stepRank * 9.0;
        // Step in Z: lower tiers push backward into -Z so upper tiers never cast shadows or block them
        const baseZ = (stepRank - (tierCount - 1) / 2) * 28.0;

        group.forEach((node, i) => {
          const col = i % maxPerRow;
          const row = Math.floor(i / maxPerRow);
          const inThisRow = Math.min(group.length - row * maxPerRow, maxPerRow);
          const xOffset = ((inThisRow - 1) * gapX) / 2;
          positions[node.id] = [
            col * gapX - xOffset,
            y,
            baseZ + (row * gapZ - zOffset),
          ];
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
