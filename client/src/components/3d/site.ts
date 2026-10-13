import type { LayoutNode, Positions } from './layouts';

/**
 * The "islands" arrangement: every project is a district of separate raised
 * platforms, one per role, laid out as a loose flow across the ground rather
 * than a grid.
 *
 * On screen the flow runs left to right the way requests do: edge on the
 * left, services in the middle, data on the right, messaging between edge and
 * services, infrastructure behind, and observability off to one side,
 * because it watches the application rather than serving it. Platforms stand
 * at different heights so each section reads as its own place.
 *
 * Returns the geometry as well as the positions, so the scene can draw the
 * platforms, the districts and the tracks between sections.
 */

export type IslandRole = 'edge' | 'messaging' | 'services' | 'data' | 'infra' | 'observability';

export const ISLAND_STYLE: Record<IslandRole, { label: string; color: string }> = {
  edge:          { label: 'Edge',           color: '#a9b0ba' },
  messaging:     { label: 'Messaging',      color: '#8ab4ff' },
  services:      { label: 'Services',       color: '#8ab4ff' },
  data:          { label: 'Data',           color: '#3ecf8e' },
  infra:         { label: 'Infrastructure', color: '#a9b0ba' },
  observability: { label: 'Observability',  color: '#a9b0ba' },
};

/**
 * Same names as OBSERVABILITY_NAMES in server/graph/serviceRoles.ts, kept in
 * step by hand: the client cannot import server code. Elasticsearch is left
 * out on purpose there, and so here.
 */
const OBSERVABILITY = /(grafana|jaeger|prometheus|opensearch|kibana|zipkin|tempo|loki|otel-?collector|opamp|telemetry-docs|flagd-ui|fluent-?bit|fluentd|logstash|vector-agent)/i;

export function islandRoleOf(node: LayoutNode): IslandRole {
  const name = node.id.includes(':') ? node.id.slice(node.id.indexOf(':') + 1) : node.id;
  if (OBSERVABILITY.test(name)) return 'observability';
  switch (node.type) {
    case 'frontend':
    case 'gateway':
      return 'edge';
    case 'queue':
    case 'cache':
      return 'messaging';
    case 'database':
      return 'data';
    case 'infrastructure':
    case 'external':
      return 'infra';
    default:
      return 'services';
  }
}

export interface Rect { x0: number; z0: number; x1: number; z1: number }
export interface Island extends Rect {
  project: string;
  role: IslandRole;
  count: number;
  /** Height of the platform's top surface: its services stand on it. */
  top: number;
}
/** A project's district: the ground its islands stand on. */
export interface Room extends Rect { project: string; hue: string }
/** A ground track between two sections that call each other. */
export interface Track { project: string; from: IslandRole; to: IslandRole; links: number; points: [number, number][] }
/** An empty pad in the landscape around a district: scenery only. */
export type PadProp = 'panels' | 'crates' | 'tower' | 'dish' | 'none';
export interface Pad extends Rect { hue: string; lit: boolean; prop: PadProp; height: number }
const PAD_PROPS: PadProp[] = ['panels', 'crates', 'tower', 'panels', 'dish', 'none', 'crates', 'panels'];
/** A straight stretch of road across the open ground. */
export interface Road { x0: number; z0: number; x1: number; z1: number }
export interface Site {
  positions: Positions;
  rooms: Room[];
  islands: Island[];
  tracks: Track[];
  pads: Pad[];
  roads: Road[];
  /** Everything, plus a margin: what the camera frames. */
  building: Rect | null;
}

/** Each district's own hue, cool and muted, for its ground tint and name. */
const DISTRICT_HUES = ['#8ab4ff', '#a9b0ba', '#8ab4ff', '#a9b0ba', '#8ab4ff', '#a9b0ba'];

/**
 * Where each role's island sits, in cells, and how high it stands. The
 * camera looks from +x/+z, so screen-left is (-x, +z) and screen-right is
 * (+x, -z): edge on the left, data on the right, observability in front and
 * off to the side.
 */
const PLAN: Record<IslandRole, { at: [number, number]; top: number }> = {
  edge:          { at: [-1.25, 1.15], top: 1.1 },
  messaging:     { at: [-1.0, -0.55], top: 1.5 },
  services:      { at: [0, 0],        top: 1.9 },
  data:          { at: [1.25, -1.2],  top: 0.9 },
  infra:         { at: [-0.35, -1.6], top: 0.7 },
  observability: { at: [1.55, 1.05],  top: 2.3 },
};

const GAP_X = 8.5;        // between units on an island
const GAP_Z = 9;
const ISLAND_PAD = 4.2;   // island edge to outermost unit centre
const MIN_GAP = 7;        // clear ground between two islands
const DISTRICT_PAD = 9;
const DISTRICT_GAP = 26;
const MARGIN = 6;

interface Draft {
  role: IslandRole;
  members: LayoutNode[];
  cols: number;
  rows: number;
  w: number;
  d: number;
  cx: number;
  cz: number;
}

function draftIsland(role: IslandRole, members: LayoutNode[]): Draft {
  const n = members.length;
  const cols = n <= 2 ? n : Math.ceil(Math.sqrt(n * 1.5));
  const rows = Math.ceil(n / cols);
  return {
    role,
    members: [...members].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)),
    cols,
    rows,
    w: (cols - 1) * GAP_X + ISLAND_PAD * 2,
    d: (rows - 1) * GAP_Z + ISLAND_PAD * 2,
    cx: 0,
    cz: 0,
  };
}

/**
 * Place a project's islands on the plan, then push apart any that overlap
 * until every pair has clear ground between them. Deterministic: the same
 * services always produce the same district.
 */
function arrange(islands: Draft[]) {
  const cell = Math.max(...islands.map((i) => Math.max(i.w, i.d))) * 0.55 + 12;
  for (const isl of islands) {
    isl.cx = PLAN[isl.role].at[0] * cell;
    isl.cz = PLAN[isl.role].at[1] * cell;
  }
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let a = 0; a < islands.length; a++) {
      for (let b = a + 1; b < islands.length; b++) {
        const A = islands[a], B = islands[b];
        const ox = (A.w + B.w) / 2 + MIN_GAP - Math.abs(A.cx - B.cx);
        const oz = (A.d + B.d) / 2 + MIN_GAP - Math.abs(A.cz - B.cz);
        if (ox <= 0 || oz <= 0) continue;
        moved = true;
        // Separate along the axis that needs the smaller push.
        if (ox < oz) {
          const s = (A.cx <= B.cx ? -1 : 1) * (ox / 2 + 0.01);
          A.cx += s; B.cx -= s;
        } else {
          const s = (A.cz <= B.cz ? -1 : 1) * (oz / 2 + 0.01);
          A.cz += s; B.cz -= s;
        }
      }
    }
    if (!moved) break;
  }
}

function draftDistrict(project: string, nodes: LayoutNode[], links: [string, string][]) {
  const byRole = new Map<IslandRole, LayoutNode[]>();
  const roleOfId = new Map<string, IslandRole>();
  for (const n of nodes) {
    const role = islandRoleOf(n);
    roleOfId.set(n.id, role);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role)!.push(n);
  }
  const drafts = Array.from(byRole.entries()).map(([role, members]) => draftIsland(role, members));
  arrange(drafts);

  const positions: Positions = {};
  const islands: Island[] = [];
  for (const isl of drafts) {
    const x0 = isl.cx - isl.w / 2, z0 = isl.cz - isl.d / 2;
    const top = PLAN[isl.role].top;
    islands.push({ project, role: isl.role, count: isl.members.length, top, x0, z0, x1: x0 + isl.w, z1: z0 + isl.d });
    isl.members.forEach((node, k) => {
      const col = k % isl.cols;
      const row = Math.floor(k / isl.cols);
      // A short last row is centred; the first members stand at the front.
      const inRow = Math.min(isl.members.length - row * isl.cols, isl.cols);
      const px = x0 + ISLAND_PAD + ((isl.cols - inRow) * GAP_X) / 2 + col * GAP_X;
      const pz = z0 + ISLAND_PAD + (isl.rows - 1 - row) * GAP_Z;
      positions[node.id] = [px, top, pz];
    });
  }

  // Tracks between sections that call each other, weighted by how many links.
  const pairs = new Map<string, number>();
  for (const [s, t] of links) {
    const a = roleOfId.get(s), b = roleOfId.get(t);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const byRoleIsland = new Map(islands.map((i) => [i.role, i]));
  const tracks: Track[] = [];
  for (const [key, count] of pairs) {
    const [a, b] = key.split('|') as [IslandRole, IslandRole];
    const A = byRoleIsland.get(a)!, B = byRoleIsland.get(b)!;
    // A straight walkway between the nearest points of the two islands'
    // edges: short, and never passing under a third island.
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const bcx = (B.x0 + B.x1) / 2, bcz = (B.z0 + B.z1) / 2;
    const ax = clamp(bcx, A.x0, A.x1), az = clamp(bcz, A.z0, A.z1);
    const bx = clamp(ax, B.x0, B.x1), bz = clamp(az, B.z0, B.z1);
    tracks.push({ project, from: a, to: b, links: count, points: [[ax, az], [bx, bz]] });
  }

  const x0 = Math.min(...islands.map((i) => i.x0)) - DISTRICT_PAD;
  const x1 = Math.max(...islands.map((i) => i.x1)) + DISTRICT_PAD;
  const z0 = Math.min(...islands.map((i) => i.z0)) - DISTRICT_PAD;
  const z1 = Math.max(...islands.map((i) => i.z1)) + DISTRICT_PAD;
  return { project, positions, islands, tracks, x0, x1, z0, z1 };
}

export function computeSite(nodes: LayoutNode[], links: [string, string][] = []): Site {
  if (nodes.length === 0) return { positions: {}, rooms: [], islands: [], tracks: [], pads: [], roads: [], building: null };

  const byProject = new Map<string, LayoutNode[]>();
  for (const n of nodes) {
    const p = n.project || 'unknown';
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p)!.push(n);
  }
  const drafts = Array.from(byProject.keys()).sort().map((p) => draftDistrict(p, byProject.get(p)!, links));

  // Districts shelf-packed into rows, with open ground between.
  const size = (d: (typeof drafts)[number]) => ({ w: d.x1 - d.x0, d: d.z1 - d.z0 });
  const area = drafts.reduce((s, d) => s + (size(d).w + DISTRICT_GAP) * (size(d).d + DISTRICT_GAP), 0);
  const maxRowWidth = Math.max(Math.sqrt(area) * 1.3, ...drafts.map((d) => size(d).w));
  const placed: { draft: (typeof drafts)[number]; x0: number; z0: number }[] = [];
  let x = 0, z = 0, rowDepth = 0;
  for (const draft of drafts) {
    const { w, d } = size(draft);
    if (x > 0 && x + w > maxRowWidth) {
      x = 0;
      z += rowDepth + DISTRICT_GAP;
      rowDepth = 0;
    }
    placed.push({ draft, x0: x, z0: z });
    x += w + DISTRICT_GAP;
    rowDepth = Math.max(rowDepth, d);
  }

  const ox = Math.max(...placed.map((p) => p.x0 + size(p.draft).w)) / 2;
  const oz = Math.max(...placed.map((p) => p.z0 + size(p.draft).d)) / 2;
  const positions: Positions = {};
  const rooms: Room[] = [];
  const islands: Island[] = [];
  const tracks: Track[] = [];
  placed.forEach(({ draft, x0, z0 }, i) => {
    // Shift the district from its own coordinates to its packed place.
    const dx = x0 - draft.x0 - ox, dz = z0 - draft.z0 - oz;
    for (const [id, [px, py, pz]] of Object.entries(draft.positions)) positions[id] = [px + dx, py, pz + dz];
    for (const isl of draft.islands) islands.push({ ...isl, x0: isl.x0 + dx, x1: isl.x1 + dx, z0: isl.z0 + dz, z1: isl.z1 + dz });
    for (const t of draft.tracks) tracks.push({ ...t, points: t.points.map(([px, pz]) => [px + dx, pz + dz] as [number, number]) });
    rooms.push({ project: draft.project, hue: DISTRICT_HUES[i % DISTRICT_HUES.length], x0: draft.x0 + dx, x1: draft.x1 + dx, z0: draft.z0 + dz, z1: draft.z1 + dz });
  });

  // Scenery: a scatter of low empty pads in the open ground round each
  // district, placed by hash so they never move, and kept off the islands.
  const pads: Pad[] = [];
  const clear = (r: Rect) => [...islands, ...rooms].every((o) =>
    r.x1 + 4 < o.x0 || r.x0 - 4 > o.x1 || r.z1 + 4 < o.z0 || r.z0 - 4 > o.z1);
  rooms.forEach((room, ri) => {
    for (let k = 0; k < 60 && pads.length < (ri + 1) * 16; k++) {
      const h = Math.imul(ri * 131 + k * 977 + 17, 2654435761) >>> 0;
      const angle = (h % 360) * (Math.PI / 180);
      const w = 6 + (h % 8), d = 5 + ((h >>> 5) % 7);
      const cx = (room.x0 + room.x1) / 2, cz = (room.z0 + room.z1) / 2;
      const reach = Math.max(room.x1 - room.x0, room.z1 - room.z0) / 2 + 2 + ((h >>> 9) % 40);
      const px = cx + Math.cos(angle) * reach, pz = cz + Math.sin(angle) * reach;
      const pad: Pad = {
        x0: px - w / 2, x1: px + w / 2, z0: pz - d / 2, z1: pz + d / 2,
        hue: room.hue,
        lit: (h >>> 13) % 3 === 0,
        prop: PAD_PROPS[(h >>> 17) % PAD_PROPS.length],
        height: 0.3 + ((h >>> 21) % 4) * 0.25,
      };
      if (clear(pad) && pads.every((p) => pad.x1 + 3 < p.x0 || pad.x0 - 3 > p.x1 || pad.z1 + 3 < p.z0 || pad.z0 - 3 > p.z1)) pads.push(pad);
    }
  });

  // Roads: a grid across the open ground, broken wherever it would cross a
  // district or a pad, so it reads as streets between the sites.
  const roads: Road[] = [];
  const bx0 = Math.min(...rooms.map((r) => r.x0)) - 90, bx1 = Math.max(...rooms.map((r) => r.x1)) + 90;
  const bz0 = Math.min(...rooms.map((r) => r.z0)) - 90, bz1 = Math.max(...rooms.map((r) => r.z1)) + 90;
  const blocked = (x: number, z: number) =>
    rooms.some((r) => x > r.x0 - 5 && x < r.x1 + 5 && z > r.z0 - 5 && z < r.z1 + 5) ||
    pads.some((p) => x > p.x0 - 3 && x < p.x1 + 3 && z > p.z0 - 3 && z < p.z1 + 3);
  const SPACING = 38;
  const runs = (fixed: number, from: number, to: number, horizontal: boolean) => {
    let start: number | null = null;
    for (let t = from; t <= to; t += 1) {
      const free = !blocked(horizontal ? t : fixed, horizontal ? fixed : t);
      if (free && start === null) start = t;
      if ((!free || t + 1 > to) && start !== null) {
        const end = free ? t : t - 1;
        if (end - start > 8) roads.push(horizontal ? { x0: start, z0: fixed, x1: end, z1: fixed } : { x0: fixed, z0: start, x1: fixed, z1: end });
        start = null;
      }
    }
  };
  for (let z = Math.ceil(bz0 / SPACING) * SPACING; z <= bz1; z += SPACING) runs(z, bx0, bx1, true);
  for (let x = Math.ceil(bx0 / SPACING) * SPACING; x <= bx1; x += SPACING) runs(x, bz0, bz1, false);

  const building = {
    x0: Math.min(...rooms.map((r) => r.x0)) - MARGIN,
    z0: Math.min(...rooms.map((r) => r.z0)) - MARGIN,
    x1: Math.max(...rooms.map((r) => r.x1)) + MARGIN,
    z1: Math.max(...rooms.map((r) => r.z1)) + MARGIN,
  };
  return { positions, rooms, islands, tracks, pads, roads, building };
}
