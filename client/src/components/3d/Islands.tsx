import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Text } from '@react-three/drei';
import * as THREE from 'three';
import { ISLAND_STYLE, type Island, type Pad, type Road, type Room, type Site, type Track } from './site';
import { glowTexture, grilleTexture, screenTexture, tiledFloor } from './textures';
import type { ZoneSummary } from './SceneHud';

/**
 * Scenery for the islands arrangement: each section of a project is its own
 * raised platform with a lit base, a pool of its colour on the ground around
 * it, and a few props that say what it is (a wall of dashboards on the
 * observability island, a mast on the edge, cooling beside the data). Tracks
 * on the ground join the sections that call each other.
 *
 * Nothing here moves with the data except the alert tint and one blinking
 * light, so it costs draw calls and little else; repeated parts are instanced.
 */

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const PLANE = new THREE.PlaneGeometry(1, 1);
const ROD = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
/** A shallow bowl, scaled into a satellite dish. */
const DISH = new THREE.SphereGeometry(0.5, 20, 8, 0, Math.PI * 2, 0, Math.PI / 3.2);
const ALERT = { critical: '#ff4d6d', degraded: '#ffab40' } as const;

export type IslandAlert = 'critical' | 'degraded' | null;

interface Box { x: number; y: number; z: number; w: number; h: number; d: number }

function Boxes({ boxes, geometry = UNIT_BOX, children, castShadow, receiveShadow }: {
  boxes: Box[];
  geometry?: THREE.BufferGeometry;
  children: ReactNode;
  castShadow?: boolean;
  receiveShadow?: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    boxes.forEach((b, i) => mesh.setMatrixAt(i, m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d))));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [boxes]);
  if (boxes.length === 0) return null;
  return (
    <instancedMesh key={boxes.length} ref={ref} args={[geometry, undefined, boxes.length]} raycast={() => null} castShadow={castShadow} receiveShadow={receiveShadow}>
      {children}
    </instancedMesh>
  );
}

/** A flat decal on the ground (or a platform top), facing up. */
function Decal({ x, y, z, w, d, children }: { x: number; y: number; z: number; w: number; d: number; children: ReactNode }) {
  return (
    <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, 0]} scale={[w, d, 1]} geometry={PLANE} raycast={() => null}>
      {children}
    </mesh>
  );
}

/** Four thin bars round a rectangle at a height: a lit edge. */
function ring(isl: { x0: number; x1: number; z0: number; z1: number }, y: number, t: number, h = 0.06): Box[] {
  const w = isl.x1 - isl.x0, d = isl.z1 - isl.z0, cx = (isl.x0 + isl.x1) / 2, cz = (isl.z0 + isl.z1) / 2;
  return [
    { x: cx, y, z: isl.z0, w: w + t, h, d: t },
    { x: cx, y, z: isl.z1, w: w + t, h, d: t },
    { x: isl.x0, y, z: cz, w: t, h, d },
    { x: isl.x1, y, z: cz, w: t, h, d },
  ];
}

/** The top plate's tiles, with the texture disposed alongside. */
function TopPlate({ isl }: { isl: Island }) {
  const w = isl.x1 - isl.x0 - 0.8, d = isl.z1 - isl.z0 - 0.8;
  const map = useMemo(() => tiledFloor(w / 9, d / 9), [w, d]);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <mesh position={[(isl.x0 + isl.x1) / 2, isl.top + 0.012, (isl.z0 + isl.z1) / 2]} rotation={[-Math.PI / 2, 0, 0]} scale={[w, d, 1]} geometry={PLANE} raycast={() => null} receiveShadow>
      <meshStandardMaterial map={map} color="#c9d2ff" roughness={0.45} metalness={0.5} />
    </mesh>
  );
}

/** Props that say what an island is for. */
function Props({ isl }: { isl: Island }) {
  const color = ISLAND_STYLE[isl.role].color;
  const blink = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!blink.current) return;
    (blink.current.material as THREE.MeshBasicMaterial).opacity = 0.35 + (Math.sin(clock.elapsedTime * 2.6) + 1) * 0.3;
  });
  const cx = (isl.x0 + isl.x1) / 2;
  const top = isl.top;

  switch (isl.role) {
    case 'observability': {
      // A wall of dashboards along the back edge: the monitoring room.
      const screens = [-1, 0, 1].map((i) => ({ x: cx + i * 3.5, y: top + 3.4, z: isl.z0 + 0.9 }));
      return (
        <group>
          <Boxes boxes={[
            { x: cx - 4.2, y: top + 2.2, z: isl.z0 + 0.7, w: 0.25, h: 4.4, d: 0.25 },
            { x: cx + 4.2, y: top + 2.2, z: isl.z0 + 0.7, w: 0.25, h: 4.4, d: 0.25 },
            { x: cx, y: top + 4.55, z: isl.z0 + 0.7, w: 11, h: 0.18, d: 0.3 },
          ]} castShadow>
            <meshStandardMaterial color="#1a2150" roughness={0.4} metalness={0.6} />
          </Boxes>
          {screens.map((s, i) => (
            <group key={i}>
              <mesh position={[s.x, s.y, s.z - 0.06]} scale={[3.3, 2.1, 0.12]} geometry={UNIT_BOX} castShadow raycast={() => null}>
                <meshStandardMaterial color="#0e1334" roughness={0.4} metalness={0.5} />
              </mesh>
              <mesh position={[s.x, s.y, s.z + 0.01]} scale={[3.1, 1.9, 1]} geometry={PLANE} raycast={() => null}>
                <meshBasicMaterial map={screenTexture()} toneMapped={false} transparent opacity={0.92} />
              </mesh>
            </group>
          ))}
          {/* the screens' light on the platform in front of them */}
          <Decal x={cx} y={top + 0.03} z={isl.z0 + 3.5} w={13} d={7}>
            <meshBasicMaterial map={glowTexture()} color={color} transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </Decal>
        </group>
      );
    }
    case 'edge': {
      // A mast with a beacon at the back corner: the way in.
      const x = isl.x0 + 1.2, z = isl.z0 + 1.2;
      return (
        <group>
          <mesh position={[x, top + 3.6, z]} scale={[0.22, 7.2, 0.22]} geometry={ROD} castShadow raycast={() => null}>
            <meshStandardMaterial color="#2a3468" roughness={0.4} metalness={0.7} />
          </mesh>
          <Boxes boxes={[{ x, y: top + 5.6, z, w: 1.8, h: 0.08, d: 0.08 }, { x, y: top + 6.5, z, w: 0.08, h: 0.08, d: 1.4 }]}>
            <meshStandardMaterial color="#2a3468" roughness={0.4} metalness={0.7} />
          </Boxes>
          <mesh ref={blink} position={[x, top + 7.35, z]} scale={0.34} geometry={ROD} raycast={() => null}>
            <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.8} />
          </mesh>
        </group>
      );
    }
    case 'data': {
      // Cooling beside the storage: a chiller with a fan grille on top.
      const x = isl.x1 - 2.2, z = isl.z0 + 1.6;
      return (
        <group>
          <mesh position={[x, top + 1.1, z]} scale={[3, 2.2, 2]} geometry={UNIT_BOX} castShadow receiveShadow raycast={() => null}>
            <meshStandardMaterial color="#182052" roughness={0.45} metalness={0.5} />
          </mesh>
          <mesh position={[x, top + 2.22, z]} rotation={[-Math.PI / 2, 0, 0]} scale={[2.7, 1.7, 1]} geometry={PLANE} raycast={() => null}>
            <meshStandardMaterial map={grilleTexture()} roughness={0.6} metalness={0.3} />
          </mesh>
        </group>
      );
    }
    case 'messaging': {
      // Two pipes running the length of the back edge.
      const w = isl.x1 - isl.x0 - 1.6;
      return (
        <group>
          {[0.55, 1.25].map((h, i) => (
            <mesh key={i} position={[cx, top + h, isl.z0 + 0.8]} rotation={[0, 0, Math.PI / 2]} scale={[0.36, w, 0.36]} geometry={ROD} castShadow raycast={() => null}>
              <meshStandardMaterial color={i ? '#2b3a7a' : '#3a2f7a'} roughness={0.3} metalness={0.75} />
            </mesh>
          ))}
        </group>
      );
    }
    case 'infra': {
      // A transformer: a block with cooling fins.
      const x = isl.x0 + 2, z = isl.z0 + 1.7;
      return (
        <Boxes boxes={[
          { x, y: top + 0.9, z, w: 2.4, h: 1.8, d: 1.8 },
          ...[-0.8, -0.4, 0, 0.4, 0.8].map((dx) => ({ x: x + dx, y: top + 0.9, z: z + 1.0, w: 0.08, h: 1.5, d: 0.3 })),
        ]} castShadow>
          <meshStandardMaterial color="#1c2350" roughness={0.45} metalness={0.55} />
        </Boxes>
      );
    }
    default:
      return null;
  }
}

function IslandPlatform({ isl, alert }: { isl: Island; alert: IslandAlert }) {
  const style = ISLAND_STYLE[isl.role];
  const accent = alert ? ALERT[alert] : style.color;
  const w = isl.x1 - isl.x0, d = isl.z1 - isl.z0;
  const cx = (isl.x0 + isl.x1) / 2, cz = (isl.z0 + isl.z1) / 2;
  const base = useMemo(() => ring(isl, 0.05, 0.16, 0.1), [isl]);
  const rim = useMemo(() => ring(isl, isl.top + 0.02, 0.12, 0.05), [isl]);
  // A band across the two sides that face the camera.
  const band = useMemo<Box[]>(() => [
    { x: cx, y: isl.top * 0.55, z: isl.z1 + 0.01, w: w - 0.3, h: 0.08, d: 0.02 },
    { x: isl.x1 + 0.01, y: isl.top * 0.55, z: cz, w: 0.02, h: 0.08, d: d - 0.3 },
  ], [isl, cx, cz, w, d]);

  return (
    <group>
      {/* Its colour on the ground around it */}
      <Decal x={cx} y={0.03} z={cz} w={w * 2 + 10} d={d * 2 + 10}>
        <meshBasicMaterial map={glowTexture()} color={accent} transparent opacity={alert ? 0.3 : 0.2} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </Decal>
      {/* Contact shade, so it stands on the ground */}
      <Decal x={cx} y={0.04} z={cz} w={w * 1.2} d={d * 1.2}>
        <meshBasicMaterial map={glowTexture()} color="#000000" transparent opacity={0.6} depthWrite={false} />
      </Decal>

      <mesh position={[cx, isl.top / 2, cz]} scale={[w, isl.top, d]} geometry={UNIT_BOX} castShadow receiveShadow raycast={() => null}>
        <meshStandardMaterial color="#11173f" roughness={0.45} metalness={0.55} />
      </mesh>
      <TopPlate isl={isl} />

      <Boxes boxes={base}>
        <meshBasicMaterial color={accent} toneMapped={false} transparent opacity={0.85} />
      </Boxes>
      <Boxes boxes={rim}>
        <meshBasicMaterial color={accent} toneMapped={false} transparent opacity={0.55} />
      </Boxes>
      <Boxes boxes={band}>
        <meshBasicMaterial color={accent} toneMapped={false} transparent opacity={0.7} />
      </Boxes>

      <Props isl={isl} />

      <Suspense fallback={null}>
        <Text
          rotation={[-Math.PI / 2, 0, 0]}
          position={[isl.x0 + 0.8, isl.top + 0.04, isl.z1 - 0.6]}
          fontSize={0.85}
          color={style.color}
          fillOpacity={0.9}
          anchorX="left"
          anchorY="bottom"
          letterSpacing={0.12}
        >
          {style.label.toUpperCase()}
        </Text>
      </Suspense>
    </group>
  );
}

/** A walkway on the ground between two sections that call each other, with
 *  a lit post at each end. */
function TrackLine({ track }: { track: Track }) {
  const [[ax, az], [bx, bz]] = track.points;
  const len = Math.hypot(bx - ax, bz - az);
  const width = 0.5 + Math.min(track.links, 8) * 0.08;
  const angle = Math.atan2(bz - az, bx - ax);
  if (len < 0.5) return null;
  return (
    <group>
      <group position={[(ax + bx) / 2, 0, (az + bz) / 2]} rotation={[0, -angle, 0]}>
        <mesh position={[0, 0.05, 0]} scale={[len, 0.1, width + 1.2]} geometry={UNIT_BOX} receiveShadow raycast={() => null}>
          <meshStandardMaterial color="#10163d" roughness={0.5} metalness={0.5} />
        </mesh>
        <mesh position={[0, 0.105, 0]} scale={[len, 0.01, width * 0.35]} geometry={UNIT_BOX} raycast={() => null}>
          <meshBasicMaterial color="#3d7bff" toneMapped={false} transparent opacity={0.55} />
        </mesh>
      </group>
      <Boxes boxes={[{ x: ax, y: 0.6, z: az, w: 0.28, h: 1.2, d: 0.28 }, { x: bx, y: 0.6, z: bz, w: 0.28, h: 1.2, d: 0.28 }]}>
        <meshBasicMaterial color="#5b8cff" toneMapped={false} transparent opacity={0.6} />
      </Boxes>
    </group>
  );
}

/**
 * Empty pads in the landscape, low and unlabelled, each carrying a bit of
 * site equipment: panel arrays, container stacks, a lattice tower, a dish.
 * Scenery only, instanced by kind.
 */
function Pads({ pads }: { pads: Pad[] }) {
  const parts = useMemo(() => {
    const bodies: Box[] = [], edges: Box[] = [], panels: Box[] = [], crates: Box[] = [], lattice: Box[] = [], beacons: Box[] = [], dishes: Box[] = [];
    for (const p of pads) {
      const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, w = p.x1 - p.x0, d = p.z1 - p.z0, top = p.height;
      bodies.push({ x: cx, y: top / 2, z: cz, w, h: top, d });
      if (p.lit) edges.push(...ring(p, top + 0.02, 0.08, 0.03));
      switch (p.prop) {
        case 'panels':
          for (let z = p.z0 + 1.2; z < p.z1 - 0.8; z += 1.7)
            for (let x = p.x0 + 1.2; x < p.x1 - 0.8; x += 2.3) panels.push({ x, y: top + 0.45, z, w: 2, h: 0.08, d: 1.2 });
          break;
        case 'crates':
          crates.push({ x: cx - 1.1, y: top + 0.7, z: cz, w: 2, h: 1.4, d: 1.5 });
          crates.push({ x: cx + 1.1, y: top + 0.6, z: cz + 0.3, w: 1.8, h: 1.2, d: 1.4 });
          crates.push({ x: cx - 0.9, y: top + 1.85, z: cz + 0.1, w: 1.6, h: 0.9, d: 1.2 });
          break;
        case 'tower': {
          const h = 9;
          for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]])
            lattice.push({ x: cx + dx, y: top + h / 2, z: cz + dz, w: 0.12, h, d: 0.12 });
          for (let y = 1.5; y < h; y += 1.8) {
            lattice.push({ x: cx, y: top + y, z: cz - 0.6, w: 1.3, h: 0.08, d: 0.08 });
            lattice.push({ x: cx, y: top + y, z: cz + 0.6, w: 1.3, h: 0.08, d: 0.08 });
          }
          beacons.push({ x: cx, y: top + h + 0.25, z: cz, w: 0.35, h: 0.35, d: 0.35 });
          break;
        }
        case 'dish':
          lattice.push({ x: cx, y: top + 1.1, z: cz, w: 0.2, h: 2.2, d: 0.2 });
          dishes.push({ x: cx, y: top + 2.5, z: cz, w: 2.6, h: 0.35, d: 2.6 });
          break;
        default:
          break;
      }
    }
    return { bodies, edges, panels, crates, lattice, beacons, dishes };
  }, [pads]);

  return (
    <group>
      <Boxes boxes={parts.bodies} castShadow receiveShadow>
        <meshStandardMaterial color="#141b45" roughness={0.5} metalness={0.45} />
      </Boxes>
      <Boxes boxes={parts.edges}>
        <meshBasicMaterial color="#3a52c8" toneMapped={false} transparent opacity={0.45} />
      </Boxes>
      {/* Panel arrays catch the key light like glass */}
      <Boxes boxes={parts.panels} castShadow>
        <meshStandardMaterial color="#1d2a6e" roughness={0.18} metalness={0.85} />
      </Boxes>
      <Boxes boxes={parts.crates} castShadow receiveShadow>
        <meshStandardMaterial color="#161d49" roughness={0.6} metalness={0.35} />
      </Boxes>
      <Boxes boxes={parts.lattice} castShadow>
        <meshStandardMaterial color="#2a3468" roughness={0.4} metalness={0.7} />
      </Boxes>
      <Boxes boxes={parts.beacons}>
        <meshBasicMaterial color="#ff4d6d" toneMapped={false} transparent opacity={0.8} />
      </Boxes>
      <Boxes boxes={parts.dishes} geometry={DISH}>
        <meshStandardMaterial color="#2e3a78" roughness={0.3} metalness={0.7} side={THREE.DoubleSide} />
      </Boxes>
      {pads.filter((p) => p.lit).map((p, i) => (
        <Decal key={i} x={(p.x0 + p.x1) / 2} y={0.03} z={(p.z0 + p.z1) / 2} w={(p.x1 - p.x0) * 2.4} d={(p.z1 - p.z0) * 2.4}>
          <meshBasicMaterial map={glowTexture()} color={p.hue} transparent opacity={0.13} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </Decal>
      ))}
    </group>
  );
}

/**
 * Streets across the open ground: dark paving with a faint dashed centre line
 * and lit kerbs, fading into the fog at the edges of the view.
 */
function Roads({ roads }: { roads: Road[] }) {
  const parts = useMemo(() => {
    const paving: Box[] = [], dashes: Box[] = [], kerbs: Box[] = [];
    const W = 5;
    for (const r of roads) {
      const horizontal = r.z0 === r.z1;
      const len = horizontal ? r.x1 - r.x0 : r.z1 - r.z0;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      paving.push(horizontal ? { x: cx, y: 0.01, z: cz, w: len, h: 0.02, d: W } : { x: cx, y: 0.01, z: cz, w: W, h: 0.02, d: len });
      for (const side of [-1, 1]) {
        kerbs.push(horizontal ? { x: cx, y: 0.025, z: cz + side * W / 2, w: len, h: 0.01, d: 0.1 } : { x: cx + side * W / 2, y: 0.025, z: cz, w: 0.1, h: 0.01, d: len });
      }
      for (let t = 1.5; t < len - 1; t += 4) {
        dashes.push(horizontal ? { x: r.x0 + t, y: 0.03, z: cz, w: 1.8, h: 0.01, d: 0.16 } : { x: cx, y: 0.03, z: r.z0 + t, w: 0.16, h: 0.01, d: 1.8 });
      }
    }
    return { paving, dashes, kerbs };
  }, [roads]);
  return (
    <group>
      <Boxes boxes={parts.paving} receiveShadow>
        <meshStandardMaterial color="#080c22" roughness={0.85} metalness={0.2} />
      </Boxes>
      <Boxes boxes={parts.kerbs}>
        <meshBasicMaterial color="#27368f" toneMapped={false} transparent opacity={0.55} />
      </Boxes>
      <Boxes boxes={parts.dashes}>
        <meshBasicMaterial color="#5a6fc4" toneMapped={false} transparent opacity={0.4} />
      </Boxes>
    </group>
  );
}

/** Light posts either side of every walkway, each with a small pool of light. */
function LightPosts({ tracks }: { tracks: Track[] }) {
  const posts = useMemo(() => {
    const out: { x: number; z: number }[] = [];
    for (const t of tracks) {
      const [[ax, az], [bx, bz]] = t.points;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 6) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      for (let s = 3; s < len - 2; s += 7) {
        for (const side of [-1, 1]) out.push({ x: ax + ux * s - uz * side * 1.4, z: az + uz * s + ux * side * 1.4 });
      }
    }
    return out;
  }, [tracks]);
  const poles = useMemo<Box[]>(() => posts.map((p) => ({ x: p.x, y: 1.1, z: p.z, w: 0.1, h: 2.2, d: 0.1 })), [posts]);
  const lamps = useMemo<Box[]>(() => posts.map((p) => ({ x: p.x, y: 2.25, z: p.z, w: 0.26, h: 0.12, d: 0.26 })), [posts]);
  return (
    <group>
      <Boxes boxes={poles}>
        <meshStandardMaterial color="#26306a" roughness={0.4} metalness={0.7} />
      </Boxes>
      <Boxes boxes={lamps}>
        <meshBasicMaterial color="#9db1ff" toneMapped={false} transparent opacity={0.85} />
      </Boxes>
      {posts.map((p, i) => (
        <Decal key={i} x={p.x} y={0.04} z={p.z} w={4.5} d={4.5}>
          <meshBasicMaterial map={glowTexture()} color="#6f8dff" transparent opacity={0.14} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </Decal>
      ))}
    </group>
  );
}

/**
 * Motes drifting slowly upward through the air over the site: the one thing
 * in the scenery that is always moving, so the scene never looks frozen.
 */
function Motes({ bounds }: { bounds: { x0: number; x1: number; z0: number; z1: number } }) {
  const COUNT = 420;
  const ref = useRef<THREE.Points>(null);
  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3);
    const speeds = new Float32Array(COUNT);
    const w = bounds.x1 - bounds.x0 + 60, d = bounds.z1 - bounds.z0 + 60;
    for (let i = 0; i < COUNT; i++) {
      const h = Math.imul(i + 1, 2654435761) >>> 0;
      positions[i * 3] = bounds.x0 - 30 + ((h % 1000) / 1000) * w;
      positions[i * 3 + 1] = ((h >>> 10) % 1000) / 1000 * 26;
      positions[i * 3 + 2] = bounds.z0 - 30 + (((h >>> 20) % 1000) / 1000) * d;
      speeds[i] = 0.25 + ((h >>> 4) % 100) / 180;
    }
    return { positions, speeds };
  }, [bounds]);
  useFrame((_, delta) => {
    const pts = ref.current;
    if (!pts) return;
    const arr = pts.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      arr[i * 3 + 1] += speeds[i] * delta;
      if (arr[i * 3 + 1] > 26) arr[i * 3 + 1] = 0;
    }
    pts.geometry.attributes.position.needsUpdate = true;
  });
  return (
    <points ref={ref} raycast={() => null}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial map={glowTexture()} color="#7f9bff" size={1.5} sizeAttenuation transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </points>
  );
}

/** A project's ground: a faint wash of its hue and its name. */
function District({ room, summary, focused }: { room: Room; summary?: ZoneSummary; focused: boolean }) {
  const w = room.x1 - room.x0, d = room.z1 - room.z0;
  const outline = useMemo(() => ring(room, 0.025, 0.12, 0.01), [room]);
  return (
    <group>
      {/* The district marked out on the ground, like a zone on a site plan */}
      <Boxes boxes={outline}>
        <meshBasicMaterial color={room.hue} toneMapped={false} transparent opacity={focused ? 0.7 : 0.3} />
      </Boxes>
      <Decal x={(room.x0 + room.x1) / 2} y={0.02} z={(room.z0 + room.z1) / 2} w={w * 1.35} d={d * 1.35}>
        <meshBasicMaterial map={glowTexture()} color={room.hue} transparent opacity={focused ? 0.14 : 0.08} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </Decal>
      <Suspense fallback={null}>
        <group position={[room.x0 + 1, 0.05, room.z1 - 0.5]}>
          <Text rotation={[-Math.PI / 2, 0, 0]} fontSize={2.6} color={focused ? '#dfe5ff' : room.hue} fillOpacity={0.85} anchorX="left" anchorY="bottom" letterSpacing={0.08}>
            {room.project.toUpperCase()}
          </Text>
          <Text rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1.7]} fontSize={1.05} color="#56629a" anchorX="left" anchorY="bottom">
            {`${summary?.services ?? 0} services${summary?.alerts ? ` · ${summary.alerts} need attention` : ''}`}
          </Text>
        </group>
      </Suspense>
    </group>
  );
}

export interface IslandCardInfo {
  healthy: number;
  degraded: number;
  critical: number;
  /** Status healthy, but the ML ensemble flags it as persistently anomalous. */
  flagged: number;
  /** Status healthy, but the cascade model puts it at risk from a dependency. */
  atRisk: number;
}

/** A floating card over an island's back corner, as in a facility dashboard. */
function IslandCard({ isl, info }: { isl: Island; info: IslandCardInfo }) {
  const style = ISLAND_STYLE[isl.role];
  // Everything the services on this island are showing, so the card never
  // says "all healthy" over a unit drawn as flagged or at risk.
  const parts = [
    info.critical ? { text: `${info.critical} down`, color: '#ff4d6d' } : null,
    info.degraded ? { text: `${info.degraded} degraded`, color: '#ffab40' } : null,
    info.flagged ? { text: `${info.flagged} ML-flagged`, color: '#ec4899' } : null,
    info.atRisk ? { text: `${info.atRisk} at risk`, color: '#a78bfa' } : null,
  ].filter((x): x is { text: string; color: string } => x !== null);
  const status = parts.length ? parts : [{ text: 'all healthy', color: '#25e3a3' }];
  return (
    // Beside the island's front-left corner, clear of the tags hung over
    // its services.
    <group position={[isl.x0, isl.top * 0.5, isl.z1]}>
      <Html zIndexRange={[4, 0]} pointerEvents="none">
        <div className="island-card" style={{ borderColor: `${style.color}55` }}>
          <div className="island-card-title">
            <span style={{ background: style.color, boxShadow: `0 0 8px ${style.color}` }} />
            {style.label}
          </div>
          <div className="island-card-row">
            <b>{isl.count}</b> service{isl.count === 1 ? '' : 's'}
            {status.length === 1 && <em style={{ color: status[0].color }}>{status[0].text}</em>}
          </div>
          {/* More than one state: a line of their own, so the card stays
              narrow instead of running into its neighbour's. */}
          {status.length > 1 && (
            <div className="island-card-states">
              {status.map((st) => <em key={st.text} style={{ color: st.color }}>{st.text}</em>)}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

export function Islands({ site, focusZone, summaries, alerts, cards }: {
  site: Site;
  focusZone: string | null;
  summaries: Map<string, ZoneSummary>;
  /** Worst state on each island, keyed `project:role`. */
  alerts: Map<string, IslandAlert>;
  /** Per-island counts for the floating cards; absent to hide the cards. */
  cards: Map<string, IslandCardInfo> | null;
}) {
  return (
    <group>
      {site.rooms.map((room) => (
        <District key={room.project} room={room} summary={summaries.get(room.project)} focused={focusZone === room.project} />
      ))}
      <Roads roads={site.roads} />
      <Pads pads={site.pads} />
      <LightPosts tracks={site.tracks} />
      {site.building && <Motes bounds={site.building} />}
      {site.tracks.map((t) => <TrackLine key={`${t.project}:${t.from}:${t.to}`} track={t} />)}
      {site.islands.map((isl) => {
        const key = `${isl.project}:${isl.role}`;
        return <IslandPlatform key={key} isl={isl} alert={alerts.get(key) ?? null} />;
      })}
      {cards && site.islands.map((isl) => {
        const key = `${isl.project}:${isl.role}`;
        const info = cards.get(key);
        return info ? <IslandCard key={`card:${key}`} isl={isl} info={info} /> : null;
      })}
    </group>
  );
}
