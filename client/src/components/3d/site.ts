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
 * The same scenery serves the flow, topology and tiers arrangements: only
 * what a platform stands for changes (see SiteMode).
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
  /** Unique in the site: `project:group`. */
  key: string;
  project: string;
  /** Decides the props on the platform (a mast for the edge, cooling beside data, ...). */
  role: IslandRole;
  label: string;
  color: string;
  /** One line for the island's card: the fact a debugger would want about this group. */
  note?: string;
  count: number;
  /** Height of the platform's top surface: its services stand on it. */
  top: number;
}
/** A project's district: the ground its islands stand on. */
export interface Room extends Rect { project: string; hue: string }
/** A ground track between two islands whose services call each other. `directed` when every call goes from `from` to `to`. */
export interface Track { project: string; from: string; to: string; links: number; directed: boolean; points: [number, number][] }
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
  /** Which island each service stands on (its key). */
  memberOf: Record<string, string>;
  /** Everything, plus a margin: what the camera frames. */
  building: Rect | null;
}

/**
 * What the platforms of a district stand for.
 *   islands   one platform per role (edge, services, data, ...)
 *   flow      one platform per hop of the request path, entry on the left; a fault reaches everything to its left
 *   topology  blast radius: platforms by how many services depend on their members, the most depended-on standing tallest
 *   tiers     architecture layers as terraces, edge at the top and data at the bottom; calls that go up a layer are counted
 */
export type SiteMode = 'islands' | 'flow' | 'topology' | 'tiers';

/** Each district's own hue, cool and muted, for its ground tint and name. */
// Six distinct, muted, cool tints (project identity). Deliberately none of them is green, amber or red, which mean health.
const DISTRICT_HUES = ['#8ab4ff', '#b4a5ff', '#7dc4c4', '#a9b0ba', '#8fa3c7', '#d3c1ff'];

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
/** Hops past this share the last platform of the flow ("hop 5+"). */
const MAX_HOP = 5;

/** A group of services that becomes one platform, before it is placed. */
interface Group {
  id: string;
  role: IslandRole;
  label: string;
  color: string;
  note?: string;
  /** In display order: the first stand at the front. */
  members: LayoutNode[];
  /** Plan position in cells, and platform height. */
  at: [number, number];
  top: number;
}

interface Draft extends Group {
  cols: number;
  rows: number;
  w: number;
  d: number;
  cx: number;
  cz: number;
}

const shortName = (id: string) => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
const byDegree = (a: LayoutNode, b: LayoutNode) => b.degree - a.degree || a.id.localeCompare(b.id);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function draftIsland(g: Group): Draft {
  const n = g.members.length;
  const cols = n <= 2 ? n : Math.ceil(Math.sqrt(n * 1.5));
  const rows = Math.ceil(n / cols);
  return { ...g, cols, rows, w: (cols - 1) * GAP_X + ISLAND_PAD * 2, d: (rows - 1) * GAP_Z + ISLAND_PAD * 2, cx: 0, cz: 0 };
}

/**
 * Place a project's islands on their plan, then push apart any that overlap
 * until every pair has clear ground between them. Deterministic: the same
 * services always produce the same district.
 */
function arrange(islands: Draft[]) {
  const cell = Math.max(...islands.map((i) => Math.max(i.w, i.d))) * 0.55 + 12;
  for (const isl of islands) {
    isl.cx = isl.at[0] * cell;
    isl.cz = isl.at[1] * cell;
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

/** Calls inside one project: who each service calls, and who calls it. */
function callGraph(nodes: LayoutNode[], links: [string, string][]) {
  const out = new Map<string, Set<string>>(), inn = new Map<string, Set<string>>();
  for (const n of nodes) { out.set(n.id, new Set()); inn.set(n.id, new Set()); }
  for (const [s, t] of links) {
    if (s === t || !out.has(s) || !out.has(t)) continue;
    out.get(s)!.add(t);
    inn.get(t)!.add(s);
  }
  return { out, inn };
}

/** Everything reachable from `start` along `next`, not counting `start`. */
function reach(start: string, next: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) for (const v of next.get(queue.shift()!) ?? []) if (!seen.has(v)) { seen.add(v); queue.push(v); }
  seen.delete(start);
  return seen;
}

/** The role most members have, for the props on a mixed platform. */
function dominantRole(members: LayoutNode[]): IslandRole {
  const count = new Map<IslandRole, number>();
  for (const m of members) count.set(islandRoleOf(m), (count.get(islandRoleOf(m)) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function islandGroups(nodes: LayoutNode[]): Group[] {
  const byRole = new Map<IslandRole, LayoutNode[]>();
  for (const n of nodes) {
    const role = islandRoleOf(n);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role)!.push(n);
  }
  return [...byRole.entries()].map(([role, members]) => ({
    id: role, role, label: ISLAND_STYLE[role].label, color: ISLAND_STYLE[role].color,
    members: [...members].sort(byDegree), at: PLAN[role].at, top: PLAN[role].top,
  }));
}

/**
 * Request path. Entry points are the edge services and anything that calls
 * without being called (a load generator, a cron job); every other service
 * stands on the platform of its shortest hop count from an entry. Services
 * no entry reaches get their own platform in front: background workers, or
 * something that has gone quiet.
 */
function flowGroups(nodes: LayoutNode[], links: [string, string][]): Group[] {
  const { out, inn } = callGraph(nodes, links);
  let entries = nodes.filter((n) => islandRoleOf(n) === 'edge' || (inn.get(n.id)!.size === 0 && out.get(n.id)!.size > 0));
  if (entries.length === 0) entries = [[...nodes].sort((a, b) => out.get(b.id)!.size - out.get(a.id)!.size || a.id.localeCompare(b.id))[0]];
  const hop = new Map<string, number>(entries.map((n) => [n.id, 0]));
  const queue = entries.map((n) => n.id);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of out.get(v)!) if (!hop.has(w)) { hop.set(w, hop.get(v)! + 1); queue.push(w); }
  }
  const stages = new Map<number, LayoutNode[]>();
  const offPath: LayoutNode[] = [];
  for (const n of nodes) {
    const h = hop.get(n.id);
    if (h === undefined) { offPath.push(n); continue; }
    const k = Math.min(h, MAX_HOP);
    if (!stages.has(k)) stages.set(k, []);
    stages.get(k)!.push(n);
  }
  const deepest = Math.max(...hop.values());
  const order = [...stages.keys()].sort((a, b) => a - b);
  const mid = (order.length - 1) / 2;
  const groups: Group[] = order.map((k, i) => {
    const members = stages.get(k)!.sort(byDegree);
    const ids = new Set(members.map((m) => m.id));
    const callers = new Set<string>();
    for (const m of members) for (const c of reach(m.id, inn)) if (!ids.has(c)) callers.add(c);
    return {
      id: `hop${k}`,
      role: k === 0 ? 'edge' : dominantRole(members),
      label: k === 0 ? 'Entry' : k === MAX_HOP && deepest > MAX_HOP ? `Hop ${k}+` : `Hop ${k}`,
      color: k === 0 ? ISLAND_STYLE.edge.color : '#8ab4ff',
      note: k === 0 ? `${plural(members.length, 'entry point')}: requests start here` : `a fault here can reach ${plural(callers.size, 'caller')}`,
      members,
      at: [(i - mid) * 1.55, -(i - mid) * 1.55],
      top: Math.min(0.9 + i * 0.35, 2.6),
    };
  });
  if (offPath.length) {
    groups.push({
      id: 'offpath', role: dominantRole(offPath), label: 'Off the request path', color: '#7dc4c4',
      note: 'no entry point reaches these: background work, or gone quiet',
      members: offPath.sort(byDegree), at: [0.5, 1.9], top: 0.6,
    });
  }
  return groups;
}

/**
 * Blast radius. A service's dependents are everything that calls it,
 * directly or through others: everything its failure can reach. Platforms
 * stand taller the more depends on their members, so the services to watch
 * are the highest ones.
 */
function topologyGroups(nodes: LayoutNode[], links: [string, string][]): Group[] {
  const { out, inn } = callGraph(nodes, links);
  const dependents = new Map(nodes.map((n) => [n.id, reach(n.id, inn).size]));
  const peak = Math.max(...dependents.values());
  const hubCut = Math.max(2, Math.ceil(peak * 0.6));
  const bands: Record<'hub' | 'shared' | 'callers' | 'alone', LayoutNode[]> = { hub: [], shared: [], callers: [], alone: [] };
  for (const n of nodes) {
    const d = dependents.get(n.id)!;
    if (d >= hubCut) bands.hub.push(n);
    else if (d > 0) bands.shared.push(n);
    else if (out.get(n.id)!.size > 0) bands.callers.push(n);
    else bands.alone.push(n);
  }
  const sortByBlast = (list: LayoutNode[]) => list.sort((a, b) => dependents.get(b.id)! - dependents.get(a.id)! || byDegree(a, b));
  const top = (list: LayoutNode[]) => list[0] ? `${shortName(list[0].id)}: ${plural(dependents.get(list[0].id)!, 'service')} depend on it` : '';
  const spec = [
    { id: 'hub', label: 'Most depended on', color: '#d3c1ff', at: [0, 0] as [number, number], top: 2.8, note: top },
    { id: 'shared', label: 'Depended on', color: '#8ab4ff', at: [-1.3, 1.0] as [number, number], top: 1.7, note: top },
    { id: 'callers', label: 'Nothing depends on these', color: '#a9b0ba', at: [1.3, -1.0] as [number, number], top: 0.9, note: () => 'a fault here hurts no other service' },
    { id: 'alone', label: 'Not connected', color: '#7dc4c4', at: [1.2, 1.7] as [number, number], top: 0.5, note: () => 'no calls observed in or out' },
  ] as const;
  return spec
    .filter((s) => bands[s.id].length > 0)
    .map((s) => {
      const members = sortByBlast(bands[s.id]);
      return { id: s.id, role: dominantRole(members), label: s.label, color: s.color, note: s.note(members), members, at: s.at, top: s.top };
    });
}

const LAYER: Partial<Record<IslandRole, number>> = { edge: 4, services: 3, messaging: 2, infra: 2, data: 1 };

/**
 * Architecture layers as terraces climbing away from the camera: data at the
 * front and lowest, the edge at the back and highest. A call normally goes
 * down a layer; one that goes up (a database calling a service, a service
 * calling the gateway) is counted on the card, because it usually means a
 * callback or a misplaced service.
 */
function tierGroups(nodes: LayoutNode[], links: [string, string][]): Group[] {
  const ids = new Set(nodes.map((n) => n.id));
  const layerOf = new Map(nodes.map((n) => [n.id, LAYER[islandRoleOf(n)] ?? 0]));
  const calls = new Map<number, { in: number; out: number; up: number }>();
  for (const l of [0, 1, 2, 3, 4]) calls.set(l, { in: 0, out: 0, up: 0 });
  for (const [s, t] of links) {
    if (!ids.has(s) || !ids.has(t)) continue;
    const a = layerOf.get(s)!, b = layerOf.get(t)!;
    if (a === b || a === 0 || b === 0) continue;
    calls.get(a)!.out++;
    calls.get(b)!.in++;
    if (b > a) calls.get(a)!.up++;
  }
  const spec = [
    { layer: 1, id: 'data', role: 'data', label: 'L1 · Data', color: ISLAND_STYLE.data.color, t: 0 },
    { layer: 2, id: 'messaging', role: 'messaging', label: 'L2 · Messaging & infra', color: '#8fa3c7', t: 1 },
    { layer: 3, id: 'services', role: 'services', label: 'L3 · Services', color: '#8ab4ff', t: 2 },
    { layer: 4, id: 'edge', role: 'edge', label: 'L4 · Edge', color: ISLAND_STYLE.edge.color, t: 3 },
  ] as const;
  const groups: Group[] = [];
  for (const s of spec) {
    const members = nodes.filter((n) => layerOf.get(n.id) === s.layer).sort(byDegree);
    if (!members.length) continue;
    const c = calls.get(s.layer)!;
    groups.push({
      id: s.id, role: s.role, label: s.label, color: s.color, members,
      note: `${plural(c.in, 'call')} in · ${c.out} out${c.up ? ` · ${c.up} go up a layer` : ''}`,
      at: [(1.5 - s.t) * 1.05, (1.5 - s.t) * 1.05],
      top: 0.9 + s.t * 2.3,
    });
  }
  const watchers = nodes.filter((n) => layerOf.get(n.id) === 0).sort(byDegree);
  if (watchers.length) {
    groups.push({
      id: 'observability', role: 'observability', label: 'Observability', color: ISLAND_STYLE.observability.color,
      note: 'watches the layers; not on the request path', members: watchers, at: [1.9, -1.9], top: 1.2,
    });
  }
  return groups;
}

function draftDistrict(project: string, nodes: LayoutNode[], links: [string, string][], mode: SiteMode) {
  const groups = mode === 'flow' ? flowGroups(nodes, links)
    : mode === 'topology' ? topologyGroups(nodes, links)
    : mode === 'tiers' ? tierGroups(nodes, links)
    : islandGroups(nodes);
  const drafts = groups.map(draftIsland);
  arrange(drafts);

  const positions: Positions = {};
  const memberOf: Record<string, string> = {};
  const islands: Island[] = [];
  for (const isl of drafts) {
    const x0 = isl.cx - isl.w / 2, z0 = isl.cz - isl.d / 2;
    const key = `${project}:${isl.id}`;
    islands.push({ key, project, role: isl.role, label: isl.label, color: isl.color, note: isl.note, count: isl.members.length, top: isl.top, x0, z0, x1: x0 + isl.w, z1: z0 + isl.d });
    isl.members.forEach((node, k) => {
      const col = k % isl.cols;
      const row = Math.floor(k / isl.cols);
      // A short last row is centred; the first members stand at the front.
      const inRow = Math.min(isl.members.length - row * isl.cols, isl.cols);
      const px = x0 + ISLAND_PAD + ((isl.cols - inRow) * GAP_X) / 2 + col * GAP_X;
      const pz = z0 + ISLAND_PAD + (isl.rows - 1 - row) * GAP_Z;
      positions[node.id] = [px, isl.top, pz];
      memberOf[node.id] = key;
    });
  }

  // Tracks between islands that call each other, weighted by how many links,
  // and marked with the direction when every call goes the same way.
  const pairs = new Map<string, { a: string; b: string; ab: number; ba: number }>();
  for (const [s, t] of links) {
    const a = memberOf[s], b = memberOf[t];
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const p = pairs.get(key) ?? { a: a < b ? a : b, b: a < b ? b : a, ab: 0, ba: 0 };
    if (a < b) p.ab++; else p.ba++;
    pairs.set(key, p);
  }
  const byKey = new Map(islands.map((i) => [i.key, i]));
  const tracks: Track[] = [];
  for (const p of pairs.values()) {
    const [from, to] = p.ab >= p.ba ? [p.a, p.b] : [p.b, p.a];
    const A = byKey.get(from)!, B = byKey.get(to)!;
    // A straight walkway between the nearest points of the two islands'
    // edges: short, and never passing under a third island.
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const bcx = (B.x0 + B.x1) / 2, bcz = (B.z0 + B.z1) / 2;
    const ax = clamp(bcx, A.x0, A.x1), az = clamp(bcz, A.z0, A.z1);
    const bx = clamp(ax, B.x0, B.x1), bz = clamp(az, B.z0, B.z1);
    tracks.push({ project, from, to, links: p.ab + p.ba, directed: p.ab === 0 || p.ba === 0, points: [[ax, az], [bx, bz]] });
  }

  const x0 = Math.min(...islands.map((i) => i.x0)) - DISTRICT_PAD;
  const x1 = Math.max(...islands.map((i) => i.x1)) + DISTRICT_PAD;
  const z0 = Math.min(...islands.map((i) => i.z0)) - DISTRICT_PAD;
  const z1 = Math.max(...islands.map((i) => i.z1)) + DISTRICT_PAD;
  return { project, positions, memberOf, islands, tracks, x0, x1, z0, z1 };
}

export function computeSite(nodes: LayoutNode[], links: [string, string][] = [], mode: SiteMode = 'islands'): Site {
  if (nodes.length === 0) return { positions: {}, rooms: [], islands: [], tracks: [], pads: [], roads: [], memberOf: {}, building: null };

  const byProject = new Map<string, LayoutNode[]>();
  for (const n of nodes) {
    const p = n.project || 'unknown';
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p)!.push(n);
  }
  const drafts = Array.from(byProject.keys()).sort().map((p) => draftDistrict(p, byProject.get(p)!, links, mode));

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
  const memberOf: Record<string, string> = {};
  const rooms: Room[] = [];
  const islands: Island[] = [];
  const tracks: Track[] = [];
  placed.forEach(({ draft, x0, z0 }, i) => {
    // Shift the district from its own coordinates to its packed place.
    const dx = x0 - draft.x0 - ox, dz = z0 - draft.z0 - oz;
    for (const [id, [px, py, pz]] of Object.entries(draft.positions)) positions[id] = [px + dx, py, pz + dz];
    Object.assign(memberOf, draft.memberOf);
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
  return { positions, rooms, islands, tracks, pads, roads, memberOf, building };
}
