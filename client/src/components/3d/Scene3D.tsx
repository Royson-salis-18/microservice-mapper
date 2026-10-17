import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import { PerspectiveCamera, OrbitControls, Grid, Billboard, Text, Edges } from '@react-three/drei';
import type { Node, Edge } from '@xyflow/react';
import * as THREE from 'three';
import type { ServiceNode } from '../../types';
import { Node3D, AT_RISK } from './Node3D';
import { Edge3D, type LinkRouting } from './Edge3D';
import { SceneHud, type ZoneSummary } from './SceneHud';
import { Callouts, SelectedCard, type CalloutItem } from './Callouts3D';
import { Backdrop, Bloom } from './Effects';
import { glowTexture, tiledFloor } from './textures';
import { cpuShown } from '../shared/serviceVisuals';
import { computeSite, islandRoleOf, type Rect, type Site } from './site';
import { Islands, type IslandAlert, type IslandCardInfo } from './Islands';
import { LAYOUTS, ZONED_LAYOUTS, LABELLED_LAYOUTS, HALL_PADDING, computeLayout, type LayoutId, type LayoutNode, type Positions } from './layouts';
import { AmbientParticles, type EnvPreset } from './AmbientParticles';
import { FlowPlatforms } from './FlowPlatforms';

interface Scene3DProps {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  onNodeClick: (id: string) => void;
  onPaneClick: () => void;
}

/** Live, mutable positions shared by nodes, edges and the camera. */
export type PositionMap = Map<string, THREE.Vector3>;

/** Most tags hung in the scene at once. Each is a DOM element moved every
 *  frame, and past this many they cover the equipment they point at. */
const MAX_CALLOUTS = 8;

/** The camera looks along the diagonal, from the +x/+z corner. */
const AZIMUTH = Math.PI / 4;
const FOV = 30;


/**
 * Eases every node toward the position its layout wants, writing into a
 * shared mutable map.
 *
 * Deliberately not React state: driving setState from useFrame re-renders
 * the scene every frame, which rebuilds the layout, which restarts the
 * animation, a loop that starves the render loop.
 */
function LayoutDriver({ target, live }: { target: Positions; live: PositionMap }) {
  useFrame((_, delta) => {
    for (const [id, to] of Object.entries(target)) {
      let current = live.get(id);
      if (!current) {
        current = new THREE.Vector3(to[0], to[1], to[2]);
        live.set(id, current);
        continue;
      }
      current.x = THREE.MathUtils.damp(current.x, to[0], 3.2, delta);
      current.y = THREE.MathUtils.damp(current.y, to[1], 3.2, delta);
      current.z = THREE.MathUtils.damp(current.z, to[2], 3.2, delta);
    }
    // Drop nodes that no longer exist so the map can't grow forever.
    if (live.size > Object.keys(target).length) {
      for (const id of live.keys()) if (!(id in target)) live.delete(id);
    }
  });
  return null;
}

export type CameraRequest =
  | { kind: 'all'; nonce: number }
  | { kind: 'zone'; id: string; nonce: number }
  | { kind: 'node'; id: string; nonce: number };

function boundsOf(points: [number, number, number][], pad: number): THREE.Box3 {
  const box = new THREE.Box3();
  for (const [x, y, z] of points) box.expandByPoint(new THREE.Vector3(x, y, z));
  // Equipment is ~5 tall and the tags hang above it.
  box.max.y += 9;
  box.expandByVector(new THREE.Vector3(pad, 0, pad));
  return box;
}

/**
 * Where the camera goes to frame a box from the diagonal.
 *
 * Fitted by projection rather than by formula: the box's corners are pushed
 * through a camera like the real one, and the distance is searched for until
 * they all land inside the part of the canvas the HUD leaves free. A closed
 * form under-framed badly, because under perspective the near corner of a
 * wide site looms much larger than its far one. A second pass re-aims so
 * the content is centred in that free area, not in the whole canvas.
 */
function viewFor(box: THREE.Box3, camera: THREE.PerspectiveCamera, size: { width: number; height: number }) {
  const width = Math.max(size.width, 1);
  const height = Math.max(size.height, 1);
  const extent = box.getSize(new THREE.Vector3());
  const flatness = extent.y / Math.max(extent.x, extent.z, 1);
  // Flat arrangements want a high angle or they collapse into a line; tall
  // ones a low angle or the stack foreshortens into a blob.
  const elevation = flatness < 0.3 ? 0.62 : 0.36;
  const dir = new THREE.Vector3(
    Math.sin(AZIMUTH) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(AZIMUTH) * Math.cos(elevation),
  );

  // Free area: clear of the HUD, which rearranges itself by canvas width
  // (see the @container rules for .scene-wrap). Wide: overview panel on the
  // left, toolbar on top. Medium: narrower panel, toolbar at the bottom.
  // Narrow: panel reduced to a strip across the top.
  const free = width > 980
    ? { left: 300, right: width - 40, top: 72, bottom: height - 28 }
    : width > 640
      ? { left: 258, right: width - 24, top: 16, bottom: height - 64 }
      : { left: 16, right: width - 16, top: 84, bottom: height - 64 };

  const probe = new THREE.PerspectiveCamera(camera.fov, width / height, 0.1, 100000);
  const corners: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const scratch = new THREE.Vector3();

  /** Pixel bounds of the box seen from `distance` along `dir` from `target`. */
  const project = (target: THREE.Vector3, distance: number) => {
    probe.position.copy(target).addScaledVector(dir, distance);
    probe.lookAt(target);
    probe.updateMatrixWorld();
    probe.matrixWorldInverse.copy(probe.matrixWorld).invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let behind = false;
    for (const c of corners) {
      // A corner behind the camera projects to a mirrored point that can
      // look as if it fits; the search must treat it as not fitting.
      if (scratch.copy(c).applyMatrix4(probe.matrixWorldInverse).z > -1) behind = true;
      scratch.copy(c).project(probe);
      const px = (scratch.x + 1) / 2 * width;
      const py = (1 - scratch.y) / 2 * height;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    return { minX, maxX, minY, maxY, behind };
  };

  const fitDistance = (target: THREE.Vector3) => {
    // Size only: compare the projected extent with the free area's extent.
    const freeW = free.right - free.left;
    const freeH = free.bottom - free.top;
    let lo = 5, hi = 20000;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const b = project(target, mid);
      if (!b.behind && b.maxX - b.minX <= freeW && b.maxY - b.minY <= freeH) hi = mid; else lo = mid;
    }
    return Math.max(hi, 30);
  };

  const target = box.getCenter(new THREE.Vector3());
  let distance = fitDistance(target);
  // Re-aim: move the target so the projected box sits in the middle of the
  // free area, then fit again from there.
  for (let pass = 0; pass < 2; pass++) {
    const b = project(target, distance);
    const dx = (b.minX + b.maxX) / 2 - (free.left + free.right) / 2;
    const dy = (b.minY + b.maxY) / 2 - (free.top + free.bottom) / 2;
    const worldPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
    const right = new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 1);
    target.addScaledVector(right, dx * worldPerPx).addScaledVector(up, -dy * worldPerPx);
    distance = fitDistance(target);
  }
  return { position: target.clone().addScaledVector(dir, distance), target, distance };
}

/**
 * Flies the camera to whatever was last asked for: the whole scene when the
 * layout or the service count changes, a project's hall, or one service.
 *
 * A flight eases over about a second and hands control back the moment the
 * user grabs the view, so it never fights their own orbiting. The very first
 * framing is instant, so the scene does not open with a swoop.
 */
/** The four floor corners of a rectangle, and the same raised to wall height. */
function cornersOf(r: Rect, height: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const y of [0, height]) for (const x of [r.x0, r.x1]) for (const z of [r.z0, r.z1]) out.push([x, y, z]);
  return out;
}

function CameraRig({ target, nodes, fitTrigger, request, site }: {
  target: Positions;
  nodes: LayoutNode[];
  fitTrigger: string;
  request: CameraRequest;
  /** In the building arrangement: frame whole rooms and the building, not
   *  just the units in them, so walls and islands are never cut off. */
  site?: Site | null;
}) {
  // Camera, controls and size are read from the frame state, never captured
  // at render: <PerspectiveCamera makeDefault> and <OrbitControls
  // makeDefault> replace the defaults after this component first renders,
  // and a captured camera was R3F's own fallback (fov 75), which nothing
  // renders through. Every framing moved a camera no one could see.
  const controls = useThree((s) => s.controls) as any;
  const flight = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const lastTrigger = useRef('');
  const lastNonce = useRef(-1);
  const framedOnce = useRef(false);
  const lastSize = useRef('');
  /** The user has moved the view since the last framing: leave it alone. */
  const userMoved = useRef(false);
  /** What was framed last, so a resize can reframe the same thing. */
  const lastPlan = useRef<{ points: [number, number, number][]; pad: number } | null>(null);

  useEffect(() => {
    if (!controls) return;
    const onStart = () => { flight.current = null; userMoved.current = true; };
    controls.addEventListener('start', onStart);
    return () => controls.removeEventListener('start', onStart);
  }, [controls]);

  const plan = (state: RootState, points: [number, number, number][], pad: number) => {
    if (points.length === 0) return;
    const camera = state.camera as THREE.PerspectiveCamera;
    const orbit = state.controls as any;
    lastPlan.current = { points, pad };
    userMoved.current = false;
    const view = viewFor(boundsOf(points, pad), camera, state.size);
    const fog = state.scene.fog as THREE.Fog | null;
    if (fog) {
      // Starts past the far side of the content, so it softens the city
      // around the halls and never the halls themselves.
      fog.near = view.distance * 1.15;
      fog.far = view.distance * 3.2;
    }
    camera.far = Math.max(view.distance * 8, 2000);
    camera.updateProjectionMatrix();
    if (!framedOnce.current) {
      framedOnce.current = true;
      camera.position.copy(view.position);
      if (orbit) { orbit.target.copy(view.target); orbit.update(); }
      else camera.lookAt(view.target);
      return;
    }
    flight.current = { position: view.position, target: view.target };
  };

  useFrame((state, delta) => {
    const { size } = state;
    // Wait for the real camera and controls, and for the canvas to be
    // measured: until then it reports the browser default 300x150, and a
    // framing for that aspect is wrong for the real one.
    if (!state.controls || (state.camera as THREE.PerspectiveCamera).fov !== FOV) return;
    if (size.width === 300 && size.height === 150) return;
    const sizeKey = `${size.width}x${size.height}`;
    if (lastSize.current !== sizeKey) {
      const resized = lastSize.current !== '';
      lastSize.current = sizeKey;
      // The inspection panel opening, or the window changing, reframes what
      // was framed, unless the user has since set up their own view.
      if (resized && lastPlan.current && !userMoved.current) plan(state, lastPlan.current.points, lastPlan.current.pad);
    }
    const all = Object.values(target);
    const whole = site?.building ? [...all, ...cornersOf(site.building, 3)] : all;
    if (all.length > 0 && lastTrigger.current !== fitTrigger) {
      lastTrigger.current = fitTrigger;
      plan(state, whole, site ? 1 : 4);
    }
    if (all.length > 0 && lastNonce.current !== request.nonce) {
      lastNonce.current = request.nonce;
      if (request.kind === 'all') plan(state, whole, site ? 1 : 4);
      else if (request.kind === 'zone') {
        const ids = nodes.filter((n) => n.project === request.id).map((n) => n.id);
        const room = site?.rooms.find((r) => r.project === request.id);
        const pts = ids.map((id) => target[id]).filter(Boolean);
        if (room) plan(state, [...pts, ...cornersOf(room, 3)], 1);
        else plan(state, pts, HALL_PADDING + 2);
      } else {
        const p = target[request.id];
        if (p) plan(state, [p], 16);
      }
    }

    const f = flight.current;
    const orbit = state.controls as any;
    if (!f || !orbit) return;
    const camera = state.camera;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, f.position.x, 3.5, delta);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, f.position.y, 3.5, delta);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, f.position.z, 3.5, delta);
    orbit.target.x = THREE.MathUtils.damp(orbit.target.x, f.target.x, 3.5, delta);
    orbit.target.y = THREE.MathUtils.damp(orbit.target.y, f.target.y, 3.5, delta);
    orbit.target.z = THREE.MathUtils.damp(orbit.target.z, f.target.z, 3.5, delta);
    orbit.update();
    if (camera.position.distanceToSquared(f.position) < 0.01 && orbit.target.distanceToSquared(f.target) < 0.01) {
      flight.current = null;
    }
  });

  return null;
}

/** Stable pseudo-random integer for a grid cell. */
function cellHash(x: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

const BLOCK_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/**
 * Distant city skyline blocks:
 * Monolithic dark building forms with modest height in the background and
 * subtle window and roof lights, keeping the background dark and ambient so the
 * architecture remains the clear primary highlight.
 */
function CityBlocks({ target, clearance = 26, preset = 'cyber' }: { target: Positions; clearance?: number; preset?: EnvPreset }) {
  const blocks = useMemo(() => {
    const pts = Object.values(target);
    if (pts.length === 0) return [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, , z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const CELL = 15, MARGIN = clearance, REACH = 210;
    const out: { x: number; z: number; w: number; d: number; h: number; shade: number; inFront: boolean }[] = [];
    for (let gx = Math.floor((minX - REACH) / CELL); gx <= Math.ceil((maxX + REACH) / CELL); gx++) {
      for (let gz = Math.floor((minZ - REACH) / CELL); gz <= Math.ceil((maxZ + REACH) / CELL); gz++) {
        const x = gx * CELL, z = gz * CELL;
        if (x > minX - MARGIN && x < maxX + MARGIN && z > minZ - MARGIN && z < maxZ + MARGIN) continue;
        // Streets every few cells, and the odd empty lot
        if (gx % 4 === 0 || gz % 5 === 0) continue;
        const h = cellHash(gx, gz);
        if (h % 6 === 0) continue;
        const r = ((h >>> 8) % 1000) / 1000;
        const inFront = x > maxX + MARGIN || z > maxZ + MARGIN;
        // Clean height: low foreground so view is never obstructed, taller background blocks up to ~16
        const height = inFront ? 0.4 + r * 1.2 : 1.2 + Math.pow(r, 1.8) * 15;
        out.push({
          x: x + (((h >>> 4) % 5) - 2) * 0.4,
          z: z + (((h >>> 12) % 5) - 2) * 0.4,
          w: CELL * (0.55 + ((h >>> 16) % 6) / 20),
          d: CELL * (0.55 + ((h >>> 20) % 6) / 20),
          h: height,
          shade: 0.8 + ((h >>> 24) % 10) / 25,
          inFront,
        });
      }
    }
    return out;
  }, [target, clearance]);

  // Individual illuminated office window cells (not continuous rows):
  // Dotted across building facades like real skyscrapers at night.
  const windowCells = useMemo(() => {
    const list: { x: number; y: number; z: number; w: number; h: number; d: number; color: string }[] = [];

    // Authentic, harmonious architectural office window palettes (warm whites, pale daylights, soft cool whites)
    const pal = preset === 'holo'
      ? ['#ede9fe', '#e0e7ff', '#f5f3ff', '#f8fafc', '#ddd6fe']
      : preset === 'studio'
        ? ['#fefce8', '#fef9c3', '#f1f5f9', '#e2e8f0', '#cbd5e1']
        : ['#fef3c7', '#fef08a', '#fde68a', '#e0f2fe', '#f1f5f9', '#bae6fd'];

    const WIN_W = 0.55;
    const WIN_H = 0.65;
    const COL_PITCH = 1.35;
    const FLOOR_PITCH = 1.4;

    blocks.forEach((b, bIdx) => {
      // Only background buildings with sufficient height (never foreground)
      if (b.inFront || b.h < 3.2) return;

      const numFloors = Math.floor((b.h - 1.8) / FLOOR_PITCH);
      if (numFloors <= 0) return;

      // 1. Front Facade (facing +Z towards camera viewpoint)
      const numColsFront = Math.floor((b.w - 1.4) / COL_PITCH);
      if (numColsFront > 0) {
        const startX = b.x - ((numColsFront - 1) * COL_PITCH) / 2;
        const frontZ = b.z + b.d / 2 + 0.03;

        for (let fl = 0; fl < numFloors; fl++) {
          const y = 1.2 + fl * FLOOR_PITCH;
          for (let col = 0; col < numColsFront; col++) {
            const h = cellHash(bIdx * 100 + col, fl * 17 + 3);
            // ~35% of office windows are lit
            if ((h % 100) < 36) {
              const x = startX + col * COL_PITCH;
              const color = pal[h % pal.length];
              list.push({
                x,
                y,
                z: frontZ,
                w: WIN_W,
                h: WIN_H,
                d: 0.04,
                color,
              });
            }
          }
        }
      }

      // 2. Side Facade (facing +X towards camera viewpoint)
      const numColsSide = Math.floor((b.d - 1.4) / COL_PITCH);
      if (numColsSide > 0) {
        const startZ = b.z - ((numColsSide - 1) * COL_PITCH) / 2;
        const sideX = b.x + b.w / 2 + 0.03;

        for (let fl = 0; fl < numFloors; fl++) {
          const y = 1.2 + fl * FLOOR_PITCH;
          for (let col = 0; col < numColsSide; col++) {
            const h = cellHash(bIdx * 100 + col + 43, fl * 19 + 7);
            // ~35% of office windows are lit
            if ((h % 100) < 36) {
              const z = startZ + col * COL_PITCH;
              const color = pal[(h >>> 4) % pal.length];
              list.push({
                x: sideX,
                y,
                z,
                w: 0.04,
                h: WIN_H,
                d: WIN_W,
                color,
              });
            }
          }
        }
      }
    });

    return list;
  }, [blocks, preset]);

  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const cellsRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = bodyRef.current;
    if (!mesh || blocks.length === 0) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    blocks.forEach((b, i) => {
      p.set(b.x, b.h / 2 - 0.2, b.z);
      s.set(b.w, b.h, b.d);
      mesh.setMatrixAt(i, m.compose(p, q, s));
      // Dark slate monolith tone — realistic, deep, and harmonious
      mesh.setColorAt(i, c.set('#212123').multiplyScalar(b.shade));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [blocks]);

  useLayoutEffect(() => {
    const mesh = cellsRef.current;
    if (!mesh || windowCells.length === 0) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    windowCells.forEach((cell, i) => {
      p.set(cell.x, cell.y, cell.z);
      s.set(cell.w, cell.h, cell.d);
      mesh.setMatrixAt(i, m.compose(p, q, s));
      mesh.setColorAt(i, c.set(cell.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [windowCells]);

  if (blocks.length === 0) return null;

  return (
    <group>
      <instancedMesh key={`b${blocks.length}`} ref={bodyRef} args={[BLOCK_GEOMETRY, undefined, blocks.length]} raycast={() => null}>
        <meshStandardMaterial color="#ffffff" roughness={0.82} metalness={0.28} />
      </instancedMesh>
      {windowCells.length > 0 && (
        <instancedMesh
          key={`wc${windowCells.length}_${preset}`}
          ref={cellsRef}
          args={[BLOCK_GEOMETRY, undefined, windowCells.length]}
          raycast={() => null}
        >
          <meshBasicMaterial color="#ffffff" toneMapped={false} transparent opacity={0.85} />
        </instancedMesh>
      )}
    </group>
  );
}

const WALL_BACK = 1.5;
const WALL_FRONT = 0.3;
const WALL_THICK = 0.3;
/** Thickness of a hall's neon outline. */
const NEON_T = 0.11;

/**
 * A project's hall: a floor pad with walls, sized each frame to the services
 * standing in it, and the project's name painted on the floor in front.
 * Back walls are taller than the ones facing the camera, like a cutaway
 * plan, so the front row is never hidden.
 */
function Zone({ project, ids, live, focused, summary, showLabel = true }: {
  project: string;
  ids: string[];
  live: PositionMap;
  focused: boolean;
  summary?: ZoneSummary;
  showLabel?: boolean;
}) {
  const slab = useRef<THREE.Mesh>(null);
  const walls = useRef<(THREE.Mesh | null)[]>([]);
  const neon = useRef<(THREE.Mesh | null)[]>([]);
  const label = useRef<THREE.Group>(null);

  useFrame(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = 0;
    for (const id of ids) {
      const p = live.get(id);
      if (!p) continue;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      y = p.y;
    }
    if (!Number.isFinite(minX) || !slab.current) return;
    minX -= HALL_PADDING; maxX += HALL_PADDING; minZ -= HALL_PADDING; maxZ += HALL_PADDING;
    const w = maxX - minX, d = maxZ - minZ, cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    slab.current.position.set(cx, y - 0.06, cz);
    slab.current.scale.set(w, 0.12, d);
    const [back, left, front, right] = walls.current;
    back?.position.set(cx, y + WALL_BACK / 2, minZ);
    back?.scale.set(w + WALL_THICK, WALL_BACK, WALL_THICK);
    left?.position.set(minX, y + WALL_BACK / 2, cz);
    left?.scale.set(WALL_THICK, WALL_BACK, d);
    front?.position.set(cx, y + WALL_FRONT / 2, maxZ);
    front?.scale.set(w + WALL_THICK, WALL_FRONT, WALL_THICK);
    right?.position.set(maxX, y + WALL_FRONT / 2, cz);
    right?.scale.set(WALL_THICK, WALL_FRONT, d);
    // Neon: a lit line round the foot of the hall and along the tops of the
    // two tall walls, the outline that makes a building read on a dark plan.
    const [fb, ff, fl, fr, tb, tl] = neon.current;
    fb?.position.set(cx, y + 0.04, minZ + WALL_THICK); fb?.scale.set(w, NEON_T, NEON_T);
    ff?.position.set(cx, y + 0.04, maxZ - WALL_THICK); ff?.scale.set(w, NEON_T, NEON_T);
    fl?.position.set(minX + WALL_THICK, y + 0.04, cz); fl?.scale.set(NEON_T, NEON_T, d);
    fr?.position.set(maxX - WALL_THICK, y + 0.04, cz); fr?.scale.set(NEON_T, NEON_T, d);
    tb?.position.set(cx, y + WALL_BACK + 0.03, minZ); tb?.scale.set(w + WALL_THICK, NEON_T, NEON_T * 1.6);
    tl?.position.set(minX, y + WALL_BACK + 0.03, cz); tl?.scale.set(NEON_T * 1.6, NEON_T, d);
    label.current?.position.set(minX + 0.4, y + 0.02, maxZ + 1.6);
  });

  const outline = focused ? '#8ab4ff' : '#5b8def';
  const neonColor = summary?.critical ? '#ef5f67' : focused ? '#8ab4ff' : '#8ab4ff';
  return (
    <group>
      <mesh ref={slab} geometry={BLOCK_GEOMETRY} raycast={() => null}>
        <meshStandardMaterial color="#1c1c1e" roughness={0.55} metalness={0.45} />
        <Edges color={outline} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(el) => { walls.current[i] = el; }} geometry={BLOCK_GEOMETRY} raycast={() => null}>
          <meshStandardMaterial color="#29292b" roughness={0.35} metalness={0.5} transparent opacity={0.88} />
          <Edges color={outline} />
        </mesh>
      ))}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <mesh key={`n${i}`} ref={(el) => { neon.current[i] = el; }} geometry={BLOCK_GEOMETRY} raycast={() => null}>
          <meshBasicMaterial color={neonColor} toneMapped={false} />
        </mesh>
      ))}
      {showLabel && (
        <group ref={label}>
          <Suspense fallback={null}>
            <Text rotation={[-Math.PI / 2, 0, 0]} fontSize={2.3} color={focused ? '#cfd3da' : '#8ab4ff'} anchorX="left" anchorY="top" letterSpacing={0.06}>
              {project}
            </Text>
            <Text rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 2.9]} fontSize={1.05} color="#5d636c" anchorX="left" anchorY="top">
              {`${ids.length} services${summary?.alerts ? ` · ${summary.alerts} need attention` : ''}`}
            </Text>
          </Suspense>
        </group>
      )}
    </group>
  );
}

/**
 * One light that follows the selected unit and spills blue onto its
 * neighbours and the floor. Always mounted, at zero when nothing is
 * selected: adding and removing a light would recompile every lit material
 * in the scene.
 */
function SelectionLight({ live, selectedId }: { live: PositionMap; selectedId: string | null }) {
  const ref = useRef<THREE.PointLight>(null);
  useFrame((_, delta) => {
    const light = ref.current;
    if (!light) return;
    const p = selectedId ? live.get(selectedId) : undefined;
    if (p) light.position.set(p.x, p.y + 4.5, p.z + 1.5);
    light.intensity = THREE.MathUtils.damp(light.intensity, p ? 120 : 0, 6, delta);
  });
  return <pointLight ref={ref} color="#8ab4ff" intensity={0} distance={34} decay={2} />;
}

/**
 * The main light, from above and to the camera's left. In the building
 * arrangement it casts shadows, with its shadow camera fitted to the floor:
 * units, walls and islands throwing shade on the floor is most of what makes
 * the room read as a real space.
 */
function KeyLight({ site, preset = 'cyber' }: { site: Site | null; preset?: EnvPreset }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  const fit = useMemo(() => {
    if (!site?.building) return null;
    const b = site.building;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const half = Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2 + 8;
    return { cx, cz, half };
  }, [site]);
  useLayoutEffect(() => {
    const light = ref.current;
    if (!light || !fit) return;
    light.position.set(fit.cx - 70, 120, fit.cz + 55);
    light.target.position.set(fit.cx, 0, fit.cz);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = -fit.half; cam.right = fit.half; cam.top = fit.half; cam.bottom = -fit.half;
    cam.near = 10; cam.far = 400;
    cam.updateProjectionMatrix();
    light.shadow.needsUpdate = true;
  }, [fit]);
  const color = preset === 'holo' ? '#e0e7ff' : preset === 'studio' ? '#ffffff' : '#f8fafc';
  const intensity = preset === 'studio' ? (site ? 2.2 : 1.6) : (site ? 2.8 : 2.0);
  return (
    <directionalLight
      ref={ref}
      position={[-60, 110, 50]}
      intensity={intensity}
      color={color}
      castShadow={Boolean(fit)}
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.04}
    />
  );
}

/**
 * The ground. Paved in authentic datacenter panels across the entire site,
 * providing the rich raised-floor texture used in islands and clusters.
 */
function Ground({ y, tiled = true, preset = 'cyber' }: { y: number; tiled?: boolean; preset?: EnvPreset }) {
  const map = useMemo(() => (tiled ? tiledFloor(4000 / 14, 4000 / 14) : null), [tiled]);
  useEffect(() => () => map?.dispose(), [map]);
  // Sleek dark panel tones so architectural lights, neon, and floor slabs stand out with high contrast
  const groundColor = preset === 'holo' ? '#0d041a'
    : preset === 'studio' ? '#14161d'
    : '#090d15';
  const roughness = preset === 'studio' ? 0.92 : 0.85;
  const metalness = preset === 'studio' ? 0.08 : 0.22;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} raycast={() => null} receiveShadow>
      <planeGeometry args={[4000, 4000]} />
      <meshStandardMaterial map={map} color={groundColor} roughness={roughness} metalness={metalness} />
    </mesh>
  );
}

/** A broad, faint blue/accent light spill on the ground under the whole site. */
function SiteGlow({ target, y, spread, color = '#8ab4ff', preset = 'cyber' }: { target: Positions; y: number; spread: number; color?: string; preset?: EnvPreset }) {
  const bounds = useMemo(() => {
    const pts = Object.values(target);
    if (pts.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, , z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const w = Math.max(maxX - minX + spread, 140);
    const d = Math.max(maxZ - minZ + spread, 140);
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w, d };
  }, [target, spread]);
  if (!bounds || preset === 'studio') return null;
  const glowColor = preset === 'holo' ? '#a855f7' : color;
  return (
    <mesh position={[bounds.cx, y, bounds.cz]} rotation={[-Math.PI / 2, 0, 0]} scale={[bounds.w, bounds.d, 1]} raycast={() => null}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={glowTexture()} color={glowColor} transparent opacity={preset === 'holo' ? 0.16 : 0.12} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/** Floating project names, for arrangements that mix projects together. */
function ProjectLabels({ nodes, live }: { nodes: LayoutNode[]; live: PositionMap }) {
  const groupRefs = useRef<Record<string, THREE.Group | null>>({});

  const projects = useMemo(() => {
    const byProject = new Map<string, string[]>();
    for (const n of nodes) {
      const p = n.project || 'unknown';
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p)!.push(n.id);
    }
    return Array.from(byProject.entries()).map(([project, ids]) => ({ project, ids }));
  }, [nodes]);

  useFrame(() => {
    for (const { project, ids } of projects) {
      const group = groupRefs.current[project];
      if (!group) continue;
      let x = 0, y = 0, z = 0, n = 0;
      for (const id of ids) {
        const v = live.get(id);
        if (!v) continue;
        x += v.x; y += v.y; z += v.z; n++;
      }
      if (n === 0) continue;
      group.position.set(x / n, y / n + 16, z / n);
    }
  });

  return (
    <>
      {projects.map(({ project, ids }) => (
        <group key={project} ref={(el) => { groupRefs.current[project] = el; }}>
          <Billboard>
            <Text fontSize={2.2} color="#cfd3da" anchorX="center" outlineWidth={0.09} outlineColor="#0d0e10">
              {project}
            </Text>
            <Text position={[0, -2.3, 0]} fontSize={1.1} color="#5d636c" anchorX="center">
              {`${ids.length} services`}
            </Text>
          </Billboard>
        </group>
      ))}
    </>
  );
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function shortId(id: string | null | undefined): string {
  return id ? String(id).split(':').pop() ?? String(id) : '';
}

export function Scene3D({ nodes, edges, selectedNodeId, onNodeClick, onPaneClick }: Scene3DProps) {
  const [layout, setLayout] = useState<LayoutId>(() => readStored('mm.scene3d.layout', LAYOUTS.map((l) => l.id), 'halls'));
  const [envPreset, setEnvPreset] = useState<EnvPreset>(() => readStored('mm.scene3d.env', ['cyber', 'studio', 'holo'] as const, 'cyber'));
  const [routing, setRouting] = useState<LinkRouting>(() => readStored('mm.scene3d.routing', ['conduit', 'arc'] as const, 'conduit'));
  const [showLabels, setShowLabels] = useState(true);
  const [showCards, setShowCards] = useState<boolean>(() => readStored('mm.scene3d.cards', ['on', 'off'] as const, 'on') === 'on');
  // Bloom is opt-in: at full strength it washed the scene out, and it costs
  // a few full-screen passes per frame. Off unless switched on in the HUD.
  const [glow, setGlow] = useState<boolean>(() => readStored('mm.scene3d.bloom', ['on', 'off'] as const, 'off') === 'on');
  const [focusZone, setFocusZone] = useState<string | null>(null);
  const [cameraRequest, setCameraRequest] = useState<CameraRequest>({ kind: 'all', nonce: 0 });
  const alertCursor = useRef(-1);
  const live = useRef<PositionMap>(new Map()).current;
  // Load per node for the render loop: see Node3D's `loads` prop. Refreshed
  // on every render, read every frame, never a reason to re-render a node.
  const loads = useRef(new Map<string, number>()).current;
  for (const n of nodes) {
    const m = ((n.data as any)?.metrics ?? {}) as { cpu?: number; cpuOfAllowance?: number; memoryPercent?: number };
    loads.set(n.id, Math.max(Math.min(Math.max(cpuShown(m) ?? 0, 0), 100), Math.min(Math.max(m.memoryPercent ?? 0, 0), 100)) / 100);
  }
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  // onPointerMissed can fire in the same gesture as a node click, which
  // would select and then immediately deselect. Ignore a "missed" that lands
  // right after a real hit.
  const lastNodeClick = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem('mm.scene3d.layout', layout);
      localStorage.setItem('mm.scene3d.env', envPreset);
      localStorage.setItem('mm.scene3d.routing', routing);
      localStorage.setItem('mm.scene3d.bloom', glow ? 'on' : 'off');
      localStorage.setItem('mm.scene3d.cards', showCards ? 'on' : 'off');
    } catch { /* private mode */ }
  }, [layout, envPreset, routing, glow, showCards]);

  // R3F sizes its canvas from a measured container. When this view mounts
  // while the layout is still settling (a tab switch, a panel opening, the
  // first paint) that measurement can come back stale, and the canvas stays
  // at the browser default 300x150 with nothing drawn. Nudging a resize after
  // mount forces a real measurement.
  useEffect(() => {
    const nudge = () => window.dispatchEvent(new Event('resize'));
    const raf = requestAnimationFrame(nudge);
    const timer = setTimeout(nudge, 250);
    const observer = new ResizeObserver(nudge);
    if (canvasWrapRef.current) observer.observe(canvasWrapRef.current);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onPaneClick(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPaneClick]);

  // Keyed on a stable signature rather than the nodes array identity, which
  // changes on every telemetry tick.
  const layoutSignature = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    return nodes
      .map((n) => {
        const d = n.data as any;
        return `${n.id}|${d?.project || ''}|${d?.type || ''}|${degree.get(n.id) || 0}`;
      })
      .sort()
      .join(';');
  }, [nodes, edges]);

  const layoutNodes: LayoutNode[] = useMemo(() => {
    if (!layoutSignature) return [];
    return layoutSignature.split(';').map((entry) => {
      const [id, project, type, degree] = entry.split('|');
      return { id, project, type, degree: Number(degree) || 0 };
    });
  }, [layoutSignature]);

  // Which services call which, for the tracks between islands. Keyed on a
  // signature, so a traffic update that changes no link does not rebuild it.
  const linkSignature = useMemo(() => edges.map((e) => `${e.source}>${e.target}`).sort().join('|'), [edges]);
  const links = useMemo<[string, string][]>(
    () => (linkSignature ? linkSignature.split('|').map((p) => p.split('>') as [string, string]) : []),
    [linkSignature]
  );
  // The islands arrangement returns its platforms, districts and tracks as
  // well, for the scene to draw; every other arrangement is just positions.
  const site = useMemo(() => (layout === 'halls' ? computeSite(layoutNodes, links) : null), [layout, layoutNodes, links]);
  const targetPositions = useMemo(
    () => site?.positions ?? computeLayout(layout, layoutNodes, edges, links),
    [site, layout, layoutNodes, edges, links]
  );

  // A new arrangement starts from the whole view (the rig refits on the
  // layout change by itself).
  const onLayout = useCallback((next: LayoutId) => {
    setLayout(next);
    setFocusZone(null);
  }, []);

  // Focus mode: with something selected, only it and its immediate
  // neighbours stay lit.
  const focus = useMemo(() => {
    if (!selectedNodeId) return null;
    const related = new Set<string>([selectedNodeId]);
    const relatedEdges = new Set<string>();
    for (const e of edges) {
      if (e.source === selectedNodeId || e.target === selectedNodeId) {
        related.add(e.source);
        related.add(e.target);
        relatedEdges.add(e.id);
      }
    }
    return { related, relatedEdges };
  }, [selectedNodeId, edges]);

  // Past ~24 services the floating labels overlap into an unreadable mat, so
  // default them off and leave the toggle.
  useEffect(() => {
    setShowLabels(nodes.length <= 24);
  }, [nodes.length]);

  // Stable across updates so memoised nodes are not re-rendered just because
  // a fresh click handler was created.
  const handleSelect = useCallback((id: string) => {
    lastNodeClick.current = Date.now();
    if (id === selectedNodeId) onPaneClick();
    else onNodeClick(id);
  }, [selectedNodeId, onNodeClick, onPaneClick]);

  const byId = useMemo(() => {
    const m = new Map<string, ServiceNode>();
    for (const n of nodes) m.set(n.id, n.data as unknown as ServiceNode);
    return m;
  }, [nodes]);

  // Every service that needs attention, most urgent first: down, then
  // flagged by the ML ensemble, then degraded, then predicted to be pulled
  // down by a dependency.
  const alerts: CalloutItem[] = useMemo(() => {
    const out: (CalloutItem & { rank: number; p: number })[] = [];
    for (const d of byId.values()) {
      const p = typeof d.analytics?.failureProbability === 'number' ? d.analytics.failureProbability : 0;
      const reason = d.metadata?.statusReason ? String(d.metadata.statusReason) : null;
      if (d.status === 'critical') {
        out.push({ id: d.id, kind: 'critical', title: d.name, sub: reason ?? 'down', rank: 0, p });
      } else if (d.analytics?.anomalyPersistent) {
        out.push({ id: d.id, kind: 'anomaly', title: d.name, sub: `ML anomaly · score ${Math.round((d.analytics.anomalyScore ?? 0) * 100)}%`, rank: 1, p });
      } else if (d.status === 'degraded') {
        out.push({ id: d.id, kind: 'degraded', title: d.name, sub: reason ?? `degraded · cpu ${Math.round(cpuShown(d.metrics) ?? 0)}%`, rank: 2, p });
      } else if (d.status === 'healthy' && p >= AT_RISK) {
        const via = shortId(d.analytics?.cascadeVia);
        out.push({ id: d.id, kind: 'risk', title: d.name, sub: `at risk ${Math.round(p * 100)}%${via ? ` via ${via}` : ''}`, rank: 3, p });
      }
    }
    out.sort((a, b) => a.rank - b.rank || b.p - a.p || a.id.localeCompare(b.id));
    return out.map(({ rank: _rank, p: _p, ...item }) => item);
  }, [byId]);

  // Which alerts get a tag. Seen from overview distance, tags for every
  // degraded or at-risk service pile into an unreadable stack, so the
  // overview tags only services that are down or ML-flagged; the rest still
  // show their amber volume or risk ring. Focusing a hall, or selecting a
  // service, tags everything in view.
  const callouts = useMemo(() => {
    const visible = alerts.filter((a) => {
      if (a.id === selectedNodeId) return false;
      if (focus) return focus.related.has(a.id);
      if (focusZone) return byId.get(a.id)?.project === focusZone;
      return a.kind === 'critical' || a.kind === 'anomaly';
    });
    return visible.slice(0, MAX_CALLOUTS);
  }, [alerts, selectedNodeId, focus, focusZone, byId]);
  const calloutIds = useMemo(() => new Set(callouts.map((c) => c.id)), [callouts]);

  const zones: ZoneSummary[] = useMemo(() => {
    const m = new Map<string, ZoneSummary>();
    for (const d of byId.values()) {
      const z = m.get(d.project) ?? { id: d.project, services: 0, alerts: 0, critical: 0 };
      z.services++;
      if (d.status === 'critical') z.critical++;
      if (d.status === 'critical' || d.status === 'degraded' || d.analytics?.anomalyPersistent) z.alerts++;
      m.set(d.project, z);
    }
    return Array.from(m.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [byId]);
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);

  // Per island: the worst state among its services (tints the platform) and
  // counts for its floating card. Cards only while they fit on screen: at
  // most a dozen islands, or those of the district in focus.
  const { islandAlerts, islandCards } = useMemo(() => {
    const alertsOut = new Map<string, IslandAlert>();
    const counts = new Map<string, IslandCardInfo>();
    if (!site) return { islandAlerts: alertsOut, islandCards: null };
    for (const n of layoutNodes) {
      const key = `${n.project}:${islandRoleOf(n)}`;
      const d = byId.get(n.id);
      const status = d?.status;
      const c = counts.get(key) ?? { healthy: 0, degraded: 0, critical: 0, flagged: 0, atRisk: 0 };
      if (status === 'critical') c.critical++;
      else if (status === 'degraded') c.degraded++;
      else c.healthy++;
      // The same tests the units themselves are drawn with (Node3D).
      if (status === 'healthy' && d?.analytics?.anomalyPersistent) c.flagged++;
      else if (status === 'healthy' && (d?.analytics?.failureProbability ?? 0) >= AT_RISK) c.atRisk++;
      counts.set(key, c);
      const prev = alertsOut.get(key) ?? null;
      if (status === 'critical') alertsOut.set(key, 'critical');
      else if (status === 'degraded' && prev !== 'critical') alertsOut.set(key, 'degraded');
      else if (!alertsOut.has(key)) alertsOut.set(key, null);
    }
    if (!showCards) return { islandAlerts: alertsOut, islandCards: null };
    let cards: Map<string, IslandCardInfo> | null = counts;
    if (focusZone) cards = new Map([...counts].filter(([k]) => k.startsWith(`${focusZone}:`)));
    return { islandAlerts: alertsOut, islandCards: cards };
  }, [site, showCards, layoutNodes, byId, focusZone]);

  const zoneMembers = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of layoutNodes) {
      if (!m.has(n.project)) m.set(n.project, []);
      m.get(n.project)!.push(n.id);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [layoutNodes]);

  const onFocusZone = useCallback((zone: string | null) => {
    setFocusZone(zone);
    setCameraRequest((r) => (zone ? { kind: 'zone', id: zone, nonce: r.nonce + 1 } : { kind: 'all', nonce: r.nonce + 1 }));
  }, []);

  // The alarm walks through the alerts in order: select the next one and fly
  // to it.
  const onNextAlert = useCallback(() => {
    if (alerts.length === 0) return;
    alertCursor.current = (alertCursor.current + 1) % alerts.length;
    const id = alerts[alertCursor.current].id;
    lastNodeClick.current = Date.now();
    onNodeClick(id);
    setCameraRequest((r) => ({ kind: 'node', id, nonce: r.nonce + 1 }));
  }, [alerts, onNodeClick]);

  // One alert picked from the bell's list: select it and fly there, and let
  // "next" carry on from it.
  const onAlertSelect = useCallback((id: string) => {
    const i = alerts.findIndex((a) => a.id === id);
    if (i >= 0) alertCursor.current = i;
    lastNodeClick.current = Date.now();
    onNodeClick(id);
    setCameraRequest((r) => ({ kind: 'node', id, nonce: r.nonce + 1 }));
  }, [alerts, onNodeClick]);

  const selected = selectedNodeId ? byId.get(selectedNodeId) : undefined;
  const groundY = -0.2;
  const zoned = ZONED_LAYOUTS.has(layout);

  return (
    <div
      ref={canvasWrapRef}
      // .scene-wrap sets min-width/min-height 0 to override the flexbox
      // automatic minimum size: the canvas sets real width/height attributes
      // on itself, and without the override the wrapper refused to shrink
      // when the inspection panel opened beside it, pushing the panel
      // off-screen.
      className="scene-wrap"
      onClick={(e) => { if (e.target === e.currentTarget) onPaneClick(); }}
    >
      <Canvas
        // PCF. Plain `shadows` asks for PCFSoftShadowMap, which three r0.186
        // removed: it fell back to PCF anyway and warned on every mount.
        shadows="percentage"
        dpr={[1, 1.75]}
        gl={{ alpha: false, antialias: true, powerPreference: 'high-performance' }}
        resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
        onPointerMissed={() => {
          if (Date.now() - lastNodeClick.current < 150) return;
          onPaneClick();
        }}
      >
        <Suspense fallback={null}>
          <Backdrop preset={envPreset} />
          <fog attach="fog" args={[envPreset === 'studio' ? '#0c0d10' : envPreset === 'holo' ? '#070210' : '#05070e', 380, 1350]} />
          {glow && (
            <Bloom
              strength={envPreset === 'holo' ? 0.72 : envPreset === 'cyber' ? 0.58 : 0.32}
              radius={envPreset === 'holo' ? 0.26 : envPreset === 'cyber' ? 0.22 : 0.14}
              threshold={envPreset === 'holo' ? 0.76 : envPreset === 'cyber' ? 0.80 : 0.88}
            />
          )}

          <PerspectiveCamera makeDefault position={[120, 110, 120]} fov={FOV} near={0.5} far={4000} />
          <OrbitControls
            makeDefault
            enableRotate
            enablePan
            enableZoom
            minDistance={8}
            maxDistance={1500}
            maxPolarAngle={Math.PI / 2 - 0.06}
            dampingFactor={0.08}
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
          />

          {/* Theme-adaptive ambient and directional lighting:
              Background stays pleasantly dark while architecture and neon lamps pop */}
          <ambientLight
            intensity={envPreset === 'studio' ? 0.42 : 0.26}
            color={envPreset === 'studio' ? '#f1f5f9' : envPreset === 'holo' ? '#d8b4fe' : '#b9e6fe'}
          />
          <hemisphereLight
            args={[
              envPreset === 'holo' ? '#a855f7' : envPreset === 'studio' ? '#94a3b8' : '#38bdf8',
              envPreset === 'holo' ? '#070210' : envPreset === 'studio' ? '#08090d' : '#030509',
              envPreset === 'studio' ? 0.5 : 0.4,
            ]}
          />
          <KeyLight site={site} preset={envPreset} />
          {/* Main Key Light */}
          <directionalLight
            position={[80, 48, -40]}
            intensity={envPreset === 'studio' ? 0.75 : envPreset === 'holo' ? 1.05 : 0.95}
            color={envPreset === 'holo' ? '#e879f9' : envPreset === 'studio' ? '#f8fafc' : '#7dd3fc'}
          />
          {/* Subtle Backlight Rim */}
          <directionalLight
            position={[-70, 32, 75]}
            intensity={envPreset === 'studio' ? 0.25 : 0.45}
            color={envPreset === 'holo' ? '#22d3ee' : envPreset === 'studio' ? '#94a3b8' : '#f43f5e'}
          />

          {/* Floor uses authentic datacenter tiled panels across all layouts (Islands, Clusters, Flow, Topology, Tiers) */}
          <Ground y={groundY - 0.02} tiled={true} preset={envPreset} />
          <Grid
            position={[0, groundY, 0]}
            args={[10, 10]}
            cellSize={5}
            cellThickness={envPreset === 'studio' ? 0.45 : 0.55}
            cellColor={envPreset === 'studio' ? '#222530' : envPreset === 'holo' ? '#2e1254' : '#112233'}
            sectionSize={30}
            sectionThickness={envPreset === 'studio' ? 0.75 : envPreset === 'holo' ? 0.95 : 0.85}
            sectionColor={envPreset === 'studio' ? '#475569' : envPreset === 'holo' ? '#9333ea' : '#0284c7'}
            fadeDistance={520}
            fadeStrength={2}
            infiniteGrid
          />

          <SiteGlow target={targetPositions} y={groundY + 0.03} spread={site ? 120 : 90} preset={envPreset} />
          {/* Atmospheric floating data dust */}
          <AmbientParticles preset={envPreset} />
          {/* Architectural platforms for Flow, Topology, and Tiers styled like Islands & Clusters */}
          {(layout === 'flow' || layout === 'tiers' || layout === 'topology') && <FlowPlatforms layout={layout} nodes={layoutNodes} positions={targetPositions} />}
          {/* Distant city skyline blocks */}
          <CityBlocks target={targetPositions} clearance={site ? 80 : 60} preset={envPreset} />

          <SelectionLight live={live} selectedId={selectedNodeId} />

          <LayoutDriver target={targetPositions} live={live} />
          <CameraRig
            target={targetPositions}
            nodes={layoutNodes}
            fitTrigger={`${layout}:${layoutNodes.length}`}
            request={cameraRequest}
            site={site}
          />

          {site && (
            <Islands
              site={site}
              focusZone={focusZone}
              summaries={zoneById}
              alerts={islandAlerts}
              cards={islandCards}
              onToggleCards={() => setShowCards(false)}
            />
          )}

          {zoned && !site && zoneMembers.map(([project, ids]) => (
            <Zone
              key={project}
              project={project}
              ids={ids}
              live={live}
              focused={focusZone === project}
              summary={zoneById.get(project)}
              showLabel={showCards}
            />
          ))}

          {edges.map((edge) => (
            <Edge3D
              key={edge.id}
              edge={edge as any}
              sourceId={edge.source}
              targetId={edge.target}
              live={live}
              routing={routing}
              targetStatus={byId.get(edge.target)?.status}
              dimmed={focus ? !focus.relatedEdges.has(edge.id) : false}
            />
          ))}

          {nodes.map((node) => (
            <Node3D
              key={node.id}
              node={node as any}
              live={live}
              loads={loads}
              isSelected={node.id === selectedNodeId}
              onSelect={handleSelect}
              // With a selection active, label the neighbours regardless of
              // the global toggle; they're the ones being asked about. A
              // service with a tag or card over it already shows its name.
              showLabel={(focus ? focus.related.has(node.id) : showLabels) && !calloutIds.has(node.id) && node.id !== selectedNodeId}
              dimmed={focus ? !focus.related.has(node.id) : false}
            />
          ))}

          <Callouts items={callouts} live={live} onSelect={handleSelect} />
          {selected && (
            <SelectedCard node={selected} live={live} pinned={selected.status === 'critical' || Boolean(selected.analytics?.anomalyPersistent)} />
          )}

          {/* Its own boundary: troika's Text suspends while it fetches a
              font, and if that request hangs a shared boundary takes the
              whole scene down with it. */}
          {LABELLED_LAYOUTS.has(layout) && showCards && (
            <Suspense fallback={null}>
              <ProjectLabels nodes={layoutNodes} live={live} />
            </Suspense>
          )}
        </Suspense>
      </Canvas>

      <SceneHud
        nodes={nodes}
        edges={edges}
        layout={layout}
        onLayout={onLayout}
        routing={routing}
        onRouting={setRouting}
        showLabels={showLabels}
        onShowLabels={setShowLabels}
        showCards={showCards}
        onShowCards={setShowCards}
        glow={glow}
        onGlow={setGlow}
        envPreset={envPreset}
        onEnvPreset={setEnvPreset}
        zones={zones}
        focusZone={focusZone}
        onFocusZone={onFocusZone}
        alerts={alerts}
        onAlertSelect={onAlertSelect}
        onNextAlert={onNextAlert}
      />
    </div>
  );
}
