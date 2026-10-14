import { Suspense, memo, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Edges, RoundedBox, Text } from '@react-three/drei';
import * as THREE from 'three';

import type { ServiceNode } from '../../types';
import { TYPE_VISUAL, cpuShown } from '../shared/serviceVisuals';
import { doorTexture, glowTexture } from './textures';
import type { PositionMap } from './Scene3D';

interface Node3DProps {
  node: { id: string; data: ServiceNode };
  live: PositionMap;
  /** Current load (0..1) per node id, read every frame. Passed as a shared
   *  map rather than a prop so a change in CPU does not re-render the node -
   *  it only changes how fast its lights flicker. */
  loads: Map<string, number>;
  isSelected: boolean;
  onSelect: (id: string) => void;
  showLabel?: boolean;
  /** Something else is selected: fade back so the selection stands out. */
  dimmed?: boolean;
}

/** Every unit is modelled at 1:1 and drawn at this scale. */
export const UNIT_SCALE = 1.2;
/** World height of the top of a unit: where links attach. */
export const UNIT_TOP = 4.6 * UNIT_SCALE;

/** Predicted failure at or above this, on a service that is itself healthy,
 *  gets the at-risk ring: the cascade model expects it to be pulled down. */
export const AT_RISK = 0.4;

/**
 * Status lights. Healthy is the scene's own blue rather than green: a hall of
 * healthy equipment should read as calm and uniform, so that the one unit
 * that changes colour is the one the eye finds. Warm hues mean trouble and
 * nothing else.
 */
export const STATUS_LIGHT: Record<string, string> = {
  healthy: '#3ecf8e',
  degraded: '#e8a33d',
  critical: '#ef5f67',
  unknown: '#6b7079',
};

export type NodeShape = 'rack' | 'storage' | 'router' | 'screen' | 'module' | 'pipe';

/**
 * Category is carried by silhouette first (a database is a disk array, a
 * gateway a router with antennae, a frontend a screen) and by a small tinted
 * cap second. Every tint is cool, so none of them can be mistaken for an
 * alert.
 */
const SHAPE: Record<string, NodeShape> = {
  gateway: 'router', frontend: 'screen', database: 'storage', cache: 'module',
  queue: 'pipe', service: 'rack', infrastructure: 'rack', external: 'module',
};
/** Colours and labels come from the shared palette, so a database is the
 *  same mint here, on its 2D card and on the minimap. */
export const TYPE_STYLE: Record<string, { color: string; shape: NodeShape; label: string }> = Object.fromEntries(
  Object.entries(TYPE_VISUAL).map(([type, v]) => [type, { color: v.color, shape: SHAPE[type] ?? 'rack', label: v.label }]),
);

const CHASSIS = '#262628';
const CHASSIS_EDGE = '#525254';
const SELECT_BLUE = '#8ab4ff';
const ALERT_PINK = '#ef5f67';

/** Geometry shared by every unit. */
const PLINTH = new THREE.BoxGeometry(4.4, 0.14, 4.4);
const PIN = new THREE.ConeGeometry(0.55, 1.3, 16);
const LED = new THREE.SphereGeometry(0.17, 12, 12);
/** Light pool on the floor under a unit, and the rack's small parts. */
const POOL = new THREE.PlaneGeometry(9, 9);
const LED_CHIP = new THREE.BoxGeometry(0.2, 0.09, 0.04);
const NEON_EDGE = new THREE.BoxGeometry(0.05, 3.5, 0.05);
const DOOR = new THREE.PlaneGeometry(1.75, 3.35);

const PLATFORM_Y = 0.14;

/** A column of activity LEDs down the side of a cabinet door. */
function LedColumn({ count, x, top, z, color, litRef }: {
  count: number; x: number; top: number; z: number; color: string;
  litRef: React.MutableRefObject<THREE.Mesh[]>;
}) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <mesh
          key={i}
          geometry={LED_CHIP}
          position={[x, top - i * 0.32, z]}
          ref={(el) => { if (el) litRef.current[i] = el; }}
        >
          <meshBasicMaterial color={color} toneMapped={false} transparent opacity={1} />
        </mesh>
      ))}
    </>
  );
}

function Node3DInner({ node, live, loads, isSelected, onSelect, showLabel = true, dimmed = false }: Node3DProps) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const ledRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Sprite>(null);
  const riskRef = useRef<THREE.Mesh>(null);
  const alertRef = useRef<THREE.Mesh>(null);
  const pinRef = useRef<THREE.Mesh>(null);
  const poolRef = useRef<THREE.Mesh>(null);
  const bays = useRef<THREE.Mesh[]>([]);
  const chassisMats = useRef<THREE.MeshStandardMaterial[]>([]);
  const [hovered, setHover] = useState(false);

  const data = node.data;
  const status = data.status || 'unknown';
  const light = STATUS_LIGHT[status] || STATUS_LIGHT.unknown;
  const style = TYPE_STYLE[data.type as string] || TYPE_STYLE.service;

  const metrics = (data.metrics || {}) as any;
  const cpu = Math.max(0, Math.min(100, cpuShown(metrics) ?? 0));
  const mem = Math.max(0, Math.min(100, metrics.memoryPercent ?? 0));
  const analytics = (data as any).analytics ?? {};
  const anomalous = Boolean(analytics.anomalyPersistent);
  const predicted: number = typeof analytics.failureProbability === 'number' ? analytics.failureProbability : 0;
  const atRisk = status === 'healthy' && predicted >= AT_RISK;
  const riskColor = predicted >= 0.7 ? '#ef5f67' : '#e8a33d';
  // The alert volume: a translucent block around the unit, pink for a unit
  // that is down or that the ML ensemble flags, amber for degraded.
  const alert = status === 'critical' || anomalous ? ALERT_PINK : status === 'degraded' ? '#e8a33d' : null;
  const pinned = status === 'critical' || anomalous;

  const shortName = useMemo(() => {
    const s = String((data as any).name || node.id);
    return s.length > 20 ? `${s.slice(0, 19)}…` : s;
  }, [data, node.id]);

  // Collected from the chassis meshes so the render loop can light the body
  // up on selection without a re-render. Reset each render; refs refill it.
  chassisMats.current = [];
  const chassisRef = (el: THREE.MeshStandardMaterial | null) => { if (el) chassisMats.current.push(el); };
  bays.current = [];

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const load = loads.get(node.id) ?? 0;
    const fade = dimmed ? 0.16 : 1;

    const pos = live.get(node.id);
    if (rootRef.current && pos) rootRef.current.position.copy(pos);

    if (bodyRef.current) {
      // Equipment stays on the floor; only selection lifts it.
      const lift = isSelected ? 0.45 : hovered ? 0.2 : 0;
      bodyRef.current.position.y = THREE.MathUtils.damp(bodyRef.current.position.y, lift, 8, delta);
    }

    // The body itself glows blue when selected, the way a picked unit lights
    // up in a facility view; hover is a softer version of the same.
    const glowTarget = isSelected ? 0.9 : hovered ? 0.45 : 0;
    for (const mat of chassisMats.current) {
      mat.emissiveIntensity = THREE.MathUtils.damp(mat.emissiveIntensity, glowTarget, 7, delta);
      // Transparent only while faded: an always-transparent body goes into
      // the sorted blending pass with no early depth rejection, which on an
      // integrated GPU is the difference that matters with 60+ units.
      mat.transparent = dimmed;
      mat.opacity = dimmed ? 0.35 : 1;
    }

    // Bay lights flicker like activity LEDs, at a rate set by load.
    for (let i = 0; i < bays.current.length; i++) {
      const mesh = bays.current[i];
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const phase = t * (1.2 + load * 5) + i * 1.7;
      const active = load > 0.02 ? (Math.sin(phase) + 1) / 2 : 0.3;
      mat.opacity = (0.3 + active * 0.7) * fade;
    }

    if (ledRef.current) {
      const mat = ledRef.current.material as THREE.MeshBasicMaterial;
      const blink = fade * (status === 'healthy' && !anomalous ? 0.75 + Math.sin(t * 2) * 0.25 : Math.abs(Math.sin(t * 4)));
      mat.opacity = 0.3 + blink * 0.7;
    }

    if (haloRef.current) {
      const mat = haloRef.current.material as THREE.SpriteMaterial;
      const base = alert ? 0.14 + Math.abs(Math.sin(t * 3)) * 0.08 : 0.03 + load * 0.07;
      mat.opacity = THREE.MathUtils.damp(mat.opacity, (isSelected ? 0.3 : hovered ? base + 0.08 : base) * fade, 5, delta);
    }

    if (alertRef.current) {
      const mat = alertRef.current.material as THREE.MeshBasicMaterial;
      const pulse = (Math.sin(t * 3.2) + 1) / 2;
      mat.opacity = (0.07 + pulse * 0.08) * fade;
    }

    if (poolRef.current) {
      // The light a unit throws on the floor: bright blue when selected (the
      // picked cabinet lighting up the aisle), its alert colour when in
      // trouble, a faint load-dependent blue otherwise.
      const mat = poolRef.current.material as THREE.MeshBasicMaterial;
      const target = isSelected ? 0.6
        : alert ? 0.2 + Math.abs(Math.sin(t * 3)) * 0.1
        : (hovered ? 0.2 : 0.05 + load * 0.07);
      mat.opacity = THREE.MathUtils.damp(mat.opacity, target * fade, 6, delta);
    }

    if (pinRef.current) {
      pinRef.current.position.y = 7.3 + Math.sin(t * 2.4) * 0.25;
      pinRef.current.rotation.y = t * 1.5;
    }

    if (riskRef.current) {
      // A slow, wide pulse, distinct from the fast alert blink, because this
      // is a prediction about a healthy service rather than a fault on it.
      const mat = riskRef.current.material as THREE.MeshBasicMaterial;
      const pulse = (Math.sin(t * 2.2) + 1) / 2;
      mat.opacity = (0.35 + pulse * 0.5) * fade;
      riskRef.current.scale.setScalar(1 + pulse * 0.08);
    }
  });

  const highlight = isSelected || hovered;
  const edgeColor = isSelected ? '#cfd3da' : hovered ? '#8ab4ff' : CHASSIS_EDGE;
  const haloColor = isSelected ? SELECT_BLUE : alert ?? light;
  const poolColor = isSelected ? SELECT_BLUE : alert ?? '#8ab4ff';

  const chassis = (
    <meshStandardMaterial
      ref={chassisRef}
      color={CHASSIS}
      roughness={0.42}
      metalness={0.55}
      emissive={SELECT_BLUE}
      emissiveIntensity={0}
      transparent={dimmed}
    />
  );

  return (
    <group ref={rootRef} scale={UNIT_SCALE}>
      {/* Floor plinth, outlined like a footprint on a plan */}
      <mesh geometry={PLINTH} position={[0, PLATFORM_Y / 2, 0]} raycast={() => null} receiveShadow>
        <meshStandardMaterial color="#1c1c1e" roughness={0.8} metalness={0.3} />
        <Edges threshold={18} color={highlight ? '#8ab4ff' : '#424244'} />
      </mesh>
      <mesh ref={poolRef} geometry={POOL} position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <meshBasicMaterial map={glowTexture()} color={poolColor} toneMapped={false} transparent opacity={0.15} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      {atRisk && (
        <mesh ref={riskRef} position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <ringGeometry args={[2.9, 3.2, 48, 1]} />
          <meshBasicMaterial color={riskColor} toneMapped={false} transparent opacity={0.6} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      <group
        ref={bodyRef}
        onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
      >
        <sprite ref={haloRef} position={[0, 2.2, 0]} scale={7.5} raycast={() => null}>
          <spriteMaterial map={glowTexture()} color={haloColor} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} />
        </sprite>

        {/* ---- SERVICE / INFRA: a server cabinet with drive bays ---- */}
        {style.shape === 'rack' && (
          <group position={[0, PLATFORM_Y + 1.9, 0]}>
            <RoundedBox castShadow args={[2.3, 3.8, 1.9]} radius={0.07} smoothness={2}>
              {chassis}
              <Edges threshold={18} color={edgeColor} />
            </RoundedBox>
            <mesh position={[0, 1.91, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1.9, 1.5]} />
              <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.4} />
            </mesh>
            {/* Perforated door, set just proud of the front face */}
            <mesh geometry={DOOR} position={[-0.18, 0, 0.955]}>
              <meshStandardMaterial map={doorTexture()} color="#ffffff" roughness={0.35} metalness={0.6} emissive={SELECT_BLUE} emissiveIntensity={isSelected ? 0.35 : 0} />
            </mesh>
            <LedColumn count={6} x={0.88} top={1.45} z={0.97} color={light} litRef={bays} />
            {/* Neon strip down the front edge, in the status colour */}
            <mesh geometry={NEON_EDGE} position={[-1.12, 0, 0.93]}>
              <meshBasicMaterial color={alert ?? light} toneMapped={false} />
            </mesh>
          </group>
        )}

        {/* ---- DATABASE: stacked disk array ---- */}
        {style.shape === 'storage' && (
          <group position={[0, PLATFORM_Y + 1.5, 0]}>
            {[0, 1, 2].map((i) => (
              <group key={i} position={[0, -1.05 + i * 1.05, 0]}>
                <mesh castShadow>
                  <cylinderGeometry args={[1.35, 1.35, 0.82, 32]} />
                  {chassis}
                  <Edges threshold={22} color={edgeColor} />
                </mesh>
                <mesh position={[0, 0.42, 0]} ref={(el) => { if (el) bays.current[i] = el; }}>
                  <torusGeometry args={[1.36, 0.045, 8, 40]} />
                  <meshBasicMaterial color={light} toneMapped={false} transparent opacity={0.85} />
                </mesh>
              </group>
            ))}
            <mesh position={[0, 1.48, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[1.0, 32]} />
              <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.45} />
            </mesh>
          </group>
        )}

        {/* ---- GATEWAY: flat router with antennae ---- */}
        {style.shape === 'router' && (
          <group position={[0, PLATFORM_Y + 0.9, 0]}>
            <RoundedBox castShadow args={[3.4, 0.85, 2.4]} radius={0.1} smoothness={2}>
              {chassis}
              <Edges threshold={18} color={edgeColor} />
            </RoundedBox>
            {[-1.1, -0.55, 0, 0.55, 1.1].map((x, i) => (
              <mesh key={i} position={[x, -0.12, 1.21]} ref={(el) => { if (el) bays.current[i] = el; }}>
                <boxGeometry args={[0.28, 0.12, 0.05]} />
                <meshBasicMaterial color={light} toneMapped={false} transparent opacity={0.9} />
              </mesh>
            ))}
            <mesh position={[0, 0.44, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[2.8, 1.8]} />
              <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.35} />
            </mesh>
            {[-1.3, 1.3].map((x, i) => (
              <group key={i} position={[x, 0.42, -0.8]}>
                <mesh position={[0, 0.75, 0]}>
                  <cylinderGeometry args={[0.05, 0.05, 1.5, 8]} />
                  <meshStandardMaterial color="#2a2d33" roughness={0.5} metalness={0.7} />
                </mesh>
                <mesh position={[0, 1.55, 0]}>
                  <sphereGeometry args={[0.12, 12, 12]} />
                  <meshBasicMaterial color={style.color} toneMapped={false} />
                </mesh>
              </group>
            ))}
          </group>
        )}

        {/* ---- FRONTEND: a screen on a stand ---- */}
        {style.shape === 'screen' && (
          <group position={[0, PLATFORM_Y, 0]}>
            <mesh position={[0, 0.3, 0]}>
              <cylinderGeometry args={[0.7, 0.85, 0.2, 24]} />
              {chassis}
            </mesh>
            <mesh position={[0, 1.1, 0]}>
              <cylinderGeometry args={[0.14, 0.14, 1.4, 12]} />
              <meshStandardMaterial color="#2a2d33" roughness={0.5} metalness={0.7} />
            </mesh>
            <group position={[0, 2.55, 0]}>
              <RoundedBox castShadow args={[3.4, 2.1, 0.22]} radius={0.07} smoothness={2}>
                {chassis}
                <Edges threshold={18} color={edgeColor} />
              </RoundedBox>
              <mesh position={[0, 0, 0.13]} ref={(el) => { if (el) bays.current[0] = el; }}>
                <planeGeometry args={[3.05, 1.75]} />
                <meshBasicMaterial color={light} toneMapped={false} transparent opacity={0.7} />
              </mesh>
            </group>
          </group>
        )}

        {/* ---- QUEUE: a segmented pipe ---- */}
        {style.shape === 'pipe' && (
          <group position={[0, PLATFORM_Y + 1.3, 0]} rotation={[0, 0, Math.PI / 2]}>
            <mesh castShadow>
              <cylinderGeometry args={[0.95, 0.95, 3.6, 28]} />
              {chassis}
              <Edges threshold={22} color={edgeColor} />
            </mesh>
            {[-1.1, 0, 1.1].map((y, i) => (
              <mesh key={i} position={[0, y, 0]} ref={(el) => { if (el) bays.current[i] = el; }}>
                <torusGeometry args={[0.99, 0.06, 8, 32]} />
                <meshBasicMaterial color={light} toneMapped={false} transparent opacity={0.85} />
              </mesh>
            ))}
            {[-1.82, 1.82].map((y, i) => (
              <mesh key={i} position={[0, y, 0]}>
                <cylinderGeometry args={[0.7, 0.7, 0.06, 24]} />
                <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.5} />
              </mesh>
            ))}
          </group>
        )}

        {/* ---- CACHE / EXTERNAL: a compact vented module ---- */}
        {style.shape === 'module' && (
          <group position={[0, PLATFORM_Y + 1.1, 0]}>
            <RoundedBox castShadow args={[2.2, 2.2, 2.2]} radius={0.12} smoothness={2}>
              {chassis}
              <Edges threshold={18} color={edgeColor} />
            </RoundedBox>
            {[-0.55, 0, 0.55].map((y, i) => (
              <mesh key={i} position={[0, y, 1.11]} ref={(el) => { if (el) bays.current[i] = el; }}>
                <boxGeometry args={[1.5, 0.13, 0.05]} />
                <meshBasicMaterial color={light} toneMapped={false} transparent opacity={0.85} />
              </mesh>
            ))}
            <mesh position={[0, 1.11, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1.7, 1.7]} />
              <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.4} />
            </mesh>
          </group>
        )}

        {/* Status LED on top of every unit */}
        <mesh ref={ledRef} geometry={LED} position={[0, 4.45, 0]} raycast={() => null}>
          <meshBasicMaterial color={alert ?? light} toneMapped={false} transparent opacity={0.9} />
        </mesh>

        {/* Alert volume: a translucent block around the unit, like a room
            highlighted on a building plan. */}
        {alert && (
          <mesh ref={alertRef} position={[0, 2.35, 0]} raycast={() => null}>
            <boxGeometry args={[3.9, 4.7, 3.5]} />
            <meshBasicMaterial color={alert} toneMapped={false} transparent opacity={0.2} depthWrite={false} />
            <Edges threshold={18} color={alert} lineWidth={1.5} />
          </mesh>
        )}

        {/* Location pin over a unit that is down or anomalous */}
        {pinned && (
          <mesh ref={pinRef} geometry={PIN} position={[0, 7.3, 0]} rotation={[Math.PI, 0, 0]} raycast={() => null}>
            <meshBasicMaterial color={ALERT_PINK} toneMapped={false} />
          </mesh>
        )}

        {showLabel && (
          // Isolated boundary: troika fetches a font, and a hang here must
          // never take the rest of the scene down with it.
          <Suspense fallback={null}>
            <Billboard position={[0, pinned ? 9.4 : 6.1, 0]}>
              <Text fontSize={highlight ? 0.9 : 0.76} color={highlight ? '#ffffff' : '#e6e8ec'} anchorX="center" anchorY="middle" outlineWidth={0.05} outlineColor="#0d0e10">
                {shortName}
              </Text>
              <Text position={[0, -0.92, 0]} fontSize={0.52} color="#8ab4ff" anchorX="center" anchorY="middle" outlineWidth={0.03} outlineColor="#0d0e10">
                {`${Math.round(cpu)}% cpu · ${Math.round(mem)}% mem`}
              </Text>
              {atRisk && (
                <Text position={[0, -1.7, 0]} fontSize={0.5} color={riskColor} anchorX="center" anchorY="middle" outlineWidth={0.03} outlineColor="#0d0e10">
                  {`at risk ${Math.round(predicted * 100)}%${analytics.cascadeVia ? ` via ${String(analytics.cascadeVia).split(':').pop()}` : ''}`}
                </Text>
              )}
            </Billboard>
          </Suspense>
        )}
      </group>
    </group>
  );
}

/**
 * Re-render only when something visible changes.
 *
 * App rebuilds every node object on every update, and pushes arrive every few
 * seconds with CPU and memory moving on nearly every service. Default
 * comparison therefore re-rendered the whole scene on every push; measured on
 * the live OTel demo, a ~120 ms main-thread stall every ~1.7 s. Load is read
 * from `loads` each frame, so it never needs a re-render; the label's
 * CPU/memory text only does when the rounded value it shows changes.
 */
function sameNode(a: Node3DProps, b: Node3DProps): boolean {
  if (a.node.id !== b.node.id || a.isSelected !== b.isSelected || a.showLabel !== b.showLabel || a.dimmed !== b.dimmed) return false;
  if (a.live !== b.live || a.loads !== b.loads || a.onSelect !== b.onSelect) return false;
  const da = a.node.data as any;
  const db = b.node.data as any;
  if (da.status !== db.status || da.type !== db.type || da.name !== db.name) return false;
  const aa = da.analytics ?? {};
  const ab = db.analytics ?? {};
  if (Boolean(aa.anomalyPersistent) !== Boolean(ab.anomalyPersistent)) return false;
  const pa = typeof aa.failureProbability === 'number' ? Math.round(aa.failureProbability * 100) : -1;
  const pb = typeof ab.failureProbability === 'number' ? Math.round(ab.failureProbability * 100) : -1;
  if (pa !== pb || aa.cascadeVia !== ab.cascadeVia) return false;
  if (a.showLabel) {
    const ma = da.metrics ?? {};
    const mb = db.metrics ?? {};
    if (Math.round(cpuShown(ma) ?? 0) !== Math.round(cpuShown(mb) ?? 0) || Math.round(ma.memoryPercent ?? 0) !== Math.round(mb.memoryPercent ?? 0)) return false;
  }
  return true;
}

export const Node3D = memo(Node3DInner, sameNode);
