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

export type ArchTier = 'ingress' | 'services' | 'infra' | 'data';

export function archTierOf(type: string): ArchTier {
  if (type === 'gateway' || type === 'frontend') return 'ingress';
  if (type === 'database') return 'data';
  if (type === 'queue' || type === 'cache' || type === 'infrastructure' || type === 'external' || type === 'observability') return 'infra';
  return 'services';
}

export const ARCH_TIERS: { id: ArchTier; label: string; badge: string; color: string }[] = [
  { id: 'ingress', label: 'TIER 04 // PRESENTATION & GATEWAY', badge: 'L4', color: '#8ab4ff' },
  { id: 'services', label: 'TIER 03 // CORE MICROSERVICES', badge: 'L3', color: '#38bdf8' },
  { id: 'infra', label: 'TIER 02 // MESSAGING & INFRA', badge: 'L2', color: '#a855f7' },
  { id: 'data', label: 'TIER 01 // DATA BEDROCK', badge: 'L1', color: '#3ecf8e' },
];

/** Layouts that keep each project in its own patch of floor, so a zone can
 *  be drawn under it without overlapping another project's. */
export const ZONED_LAYOUTS: ReadonlySet<LayoutId> = new Set<LayoutId>(['halls', 'clusters']);

/** Layouts where each project's services sit together, so a floating name
 *  over their centre points at them. In the rest (tiers, radial, sphere,
 *  helix) projects interleave and every name lands in the same spot. */
export const LABELLED_LAYOUTS: ReadonlySet<LayoutId> = new Set<LayoutId>(['grid', 'circle', 'polygon', 'flow', 'topology']);

/** Margin between a hall's outermost services and its walls. */
export const HALL_PADDING = 6;

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
  _edges: any[] = [],
  _links: [string, string][] = []
): Positions {
  const positions: Positions = {};
  const n = nodes.length;
  if (n === 0) return positions;

  switch (layout) {
    case 'flow': {
      // Horizontal Request Pipeline (Left-to-Right Conveyor):
      // Stage 1: INGRESS (Left)
      // Stage 2: CORE MICROSERVICES (Center-Left)
      // Stage 3: MESSAGING & INFRA (Center-Right)
      // Stage 4: DATA BEDROCK (Right)
      const ingress: LayoutNode[] = [];
      const coreServices: LayoutNode[] = [];
      const asyncInfra: LayoutNode[] = [];
      const storage: LayoutNode[] = [];

      nodes.forEach((node) => {
        const t = archTierOf(node.type);
        if (t === 'ingress') ingress.push(node);
        else if (t === 'data') storage.push(node);
        else if (t === 'infra') asyncInfra.push(node);
        else coreServices.push(node);
      });

      const sortByDegree = (arr: LayoutNode[]) => arr.sort((a, b) => b.degree - a.degree);
      sortByDegree(ingress);
      sortByDegree(coreServices);
      sortByDegree(asyncInfra);
      sortByDegree(storage);

      const stages = [
        { nodes: ingress, maxPerCol: 4, gapX: 24, gapZ: 22 },
        { nodes: coreServices, maxPerCol: 5, gapX: 24, gapZ: 22 },
        { nodes: asyncInfra, maxPerCol: 4, gapX: 24, gapZ: 22 },
        { nodes: storage, maxPerCol: 4, gapX: 24, gapZ: 22 },
      ];

      // Dynamically calculate stage widths so consecutive platforms never collide
      const stageWidths = stages.map((s) => {
        if (s.nodes.length === 0) return 0;
        const cols = Math.ceil(s.nodes.length / s.maxPerCol);
        return Math.max(28, (cols - 1) * s.gapX + 28);
      });

      const STAGE_GAP = 20; // Clear runway gap between consecutive platforms
      let totalWidth = 0;
      const validStages = stageWidths.filter((w) => w > 0);
      if (validStages.length > 0) {
        totalWidth = validStages.reduce((sum, w) => sum + w, 0) + (validStages.length - 1) * STAGE_GAP;
      }

      let currentLeft = -totalWidth / 2;
      stages.forEach((stage, sIdx) => {
        const count = stage.nodes.length;
        if (count === 0) return;
        const w = stageWidths[sIdx];
        const stageCenterX = currentLeft + w / 2;
        currentLeft += w + STAGE_GAP;

        const cols = Math.ceil(count / stage.maxPerCol);
        const startX = stageCenterX - ((cols - 1) * stage.gapX) / 2;

        stage.nodes.forEach((node, i) => {
          const colIndex = Math.floor(i / stage.maxPerCol);
          const inColIndex = i % stage.maxPerCol;
          const itemsInThisCol = Math.min(count - colIndex * stage.maxPerCol, stage.maxPerCol);
          const zOffset = ((itemsInThisCol - 1) * stage.gapZ) / 2;
          const x = startX + colIndex * stage.gapX;
          const z = inColIndex * stage.gapZ - zOffset;
          positions[node.id] = [x, 0, z];
        });
      });

      return positions;
    }

    case 'topology': {
      // Cohesive Network Graph:
      // Groups services into balanced domain pods on the 2D plane (Y=0).
      // If multiple projects exist, pod by project.
      // If single project, pod by architectural role: Ingress, Core Services, Data, Infra/Observability.
      const byProject = groupBy(nodes, (n) => n.project || 'core');
      const projectList = Array.from(byProject.entries());

      type Pod = { id: string; nodes: LayoutNode[]; center: [number, number] };
      const pods: Pod[] = [];

      if (projectList.length > 1) {
        // Multi-project: pod by project
        const numPods = projectList.length;
        const ringRad = Math.max(32, numPods * 14);
        projectList.forEach(([proj, pNodes], idx) => {
          const angle = (idx / numPods) * Math.PI * 2 - Math.PI / 2;
          pods.push({
            id: proj,
            nodes: pNodes,
            center: [Math.cos(angle) * ringRad, Math.sin(angle) * ringRad],
          });
        });
      } else {
        // Single project: pod by architectural role
        const ingress: LayoutNode[] = [];
        const coreServices: LayoutNode[] = [];
        const asyncInfra: LayoutNode[] = [];
        const storage: LayoutNode[] = [];

        nodes.forEach((node) => {
          const t = archTierOf(node.type);
          if (t === 'ingress') ingress.push(node);
          else if (t === 'data') storage.push(node);
          else if (t === 'infra') asyncInfra.push(node);
          else coreServices.push(node);
        });

        // Symmetrical 4-quadrant layout:
        // Ingress at West/Front (-34, +14)
        // Core Services at Center/North (0, -18)
        // Storage at East/North (+36, -14)
        // Infra & Telemetry at South (+4, +26)
        if (ingress.length > 0) pods.push({ id: 'ingress', nodes: ingress, center: [-34, 14] });
        if (coreServices.length > 0) pods.push({ id: 'services', nodes: coreServices, center: [0, -18] });
        if (storage.length > 0) pods.push({ id: 'data', nodes: storage, center: [36, -14] });
        if (asyncInfra.length > 0) pods.push({ id: 'infra', nodes: asyncInfra, center: [4, 26] });
      }

      const idMap = new Map<string, number>();
      nodes.forEach((node, i) => idMap.set(node.id, i));
      const coords: [number, number][] = nodes.map(() => [0, 0]);

      // Distribute nodes in each pod around the pod center
      pods.forEach((pod) => {
        const [cx, cz] = pod.center;
        pod.nodes.sort((a, b) => b.degree - a.degree);
        const count = pod.nodes.length;
        const podRadius = Math.max(10, Math.sqrt(count) * 8.5);

        pod.nodes.forEach((node, idx) => {
          const nodeIdx = idMap.get(node.id)!;
          if (idx === 0 && count > 1) {
            coords[nodeIdx] = [cx, cz];
          } else {
            const angle = ((idx - (count > 1 ? 1 : 0)) / Math.max(1, count - 1)) * Math.PI * 2;
            coords[nodeIdx] = [
              cx + Math.cos(angle) * podRadius,
              cz + Math.sin(angle) * podRadius,
            ];
          }
        });
      });

      // Relaxation pass: ensure 22-unit minimum separation so labels never overlap
      const minDistance = 22.0;
      for (let iter = 0; iter < 24; iter++) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            let dx = coords[i][0] - coords[j][0];
            let dz = coords[i][1] - coords[j][1];
            let distSq = dx * dx + dz * dz + 0.001;
            let dist = Math.sqrt(distSq);
            if (dist < minDistance) {
              let overlap = (minDistance - dist) / 2;
              let nx = (dx / dist) * overlap;
              let nz = (dz / dist) * overlap;
              coords[i][0] += nx; coords[i][1] += nz;
              coords[j][0] -= nx; coords[j][1] -= nz;
            }
          }
        }
      }

      // Center the entire graph
      let avgX = 0, avgZ = 0;
      coords.forEach((c) => { avgX += c[0]; avgZ += c[1]; });
      avgX /= n; avgZ /= n;

      nodes.forEach((node, i) => {
        positions[node.id] = [coords[i][0] - avgX, 0, coords[i][1] - avgZ];
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
      // Ascends in elevation (Y) and steps backward into depth (-Z).
      // Bedrock / Data is in front (Z = +36, ground level Y = 0).
      // Messaging & Infra is step 1 (Z = +10, elevated Y = 8).
      // Core Microservices is step 2 (Z = -18, elevated Y = 16).
      // Presentation & Gateway is the highest terrace at the back (Z = -46, highest Y = 24).
      // From the default camera angle (viewing from +Z, +Y looking toward -Z),
      // each terrace rises upward behind the foreground like an amphitheater!
      // Every server and tier label is 100% visible with ZERO occlusion!
      const byTier = groupBy(nodes, (node) => archTierOf(node.type));
      
      const tierConfig: Record<ArchTier, { y: number; z: number; maxCols: number; gapX: number; gapZ: number }> = {
        data:     { y:  0, z:  36, maxCols: 4, gapX: 26, gapZ: 22 },
        infra:    { y:  8, z:  10, maxCols: 5, gapX: 26, gapZ: 22 },
        services: { y: 16, z: -18, maxCols: 6, gapX: 24, gapZ: 22 },
        ingress:  { y: 24, z: -46, maxCols: 4, gapX: 26, gapZ: 22 },
      };

      (Object.keys(tierConfig) as ArchTier[]).forEach((tierId) => {
        const group = byTier.get(tierId) || [];
        const count = group.length;
        if (count === 0) return;

        const cfg = tierConfig[tierId];
        group.sort((a, b) => b.degree - a.degree);

        const cols = Math.min(count, cfg.maxCols);
        const rows = Math.ceil(count / cols);
        const zTotalOffset = ((rows - 1) * cfg.gapZ) / 2;

        group.forEach((node, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const inThisRow = Math.min(count - row * cols, cols);
          const xOffset = ((inThisRow - 1) * cfg.gapX) / 2;
          positions[node.id] = [
            col * cfg.gapX - xOffset,
            cfg.y,
            cfg.z + (row * cfg.gapZ - zTotalOffset),
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
