import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, RoundedBox, Text } from '@react-three/drei';
import * as THREE from 'three';

import type { ServiceNode } from '../../types';
import type { PositionMap } from './Scene3D';

interface Node3DProps {
  node: { id: string; data: ServiceNode };
  live: PositionMap;
  isSelected: boolean;
  onClick: () => void;
  showLabel?: boolean;
  /** Something else is selected: fade back so the selection stands out. */
  dimmed?: boolean;
}

export const STATUS_COLORS: Record<string, string> = {
  healthy: '#3ecf8e',
  degraded: '#e8a33d',
  critical: '#ef5f67',
  unknown: '#6b7079',
};

export type NodeShape = 'rack' | 'storage' | 'router' | 'screen' | 'module' | 'pipe';

/**
 * The scene is an architectural model, not a light show: every service is
 * the same matte clay and is told apart by silhouette alone (a database is a
 * stack of disks, a gateway a flat router, a frontend a screen). Colour is
 * kept for one job, which is health. A healthy service is plain clay, and a
 * degraded or failing one is tinted and ringed, so trouble is the only thing
 * on screen that is coloured.
 */
export const TYPE_STYLE: Record<string, { shape: NodeShape; label: string }> = {
  gateway:        { shape: 'router',  label: 'Gateway' },
  frontend:       { shape: 'screen',  label: 'Frontend' },
  database:       { shape: 'storage', label: 'Database' },
  cache:          { shape: 'module',  label: 'Cache' },
  queue:          { shape: 'pipe',    label: 'Queue' },
  service:        { shape: 'rack',    label: 'Service' },
  infrastructure: { shape: 'rack',    label: 'Infra' },
  external:       { shape: 'module',  label: 'External' },
};

const CLAY = new THREE.Color('#c9ccd2');
const CLAY_NO_DATA = new THREE.Color('#5f646c');
const DETAIL = '#24272c';
const PLINTH = '#17191d';
const DIM_TO = new THREE.Color('#1b1d21');
const LOAD_ON = '#8ab4ff';
const PLATFORM_Y = 0.14;
const RING_GEOM = new THREE.RingGeometry(2.78, 2.92, 64);
const SELECT_GEOM = new THREE.RingGeometry(3.15, 3.24, 64);

function bodyColor(status: string): THREE.Color {
  if (status === 'unknown') return CLAY_NO_DATA.clone();
  if (status === 'critical') return CLAY.clone().lerp(new THREE.Color(STATUS_COLORS.critical), 0.62);
  if (status === 'degraded') return CLAY.clone().lerp(new THREE.Color(STATUS_COLORS.degraded), 0.5);
  return CLAY.clone();
}

/** Grooves on a chassis face; the lower ones light up with load, like a level meter. */
function Slots({ positions, size, lit }: { positions: [number, number, number][]; size: [number, number, number]; lit: number }) {
  return (
    <>
      {positions.map((p, i) => (
        <mesh key={i} position={p}>
          <boxGeometry args={size} />
          {i < lit
            ? <meshStandardMaterial color={LOAD_ON} emissive={LOAD_ON} emissiveIntensity={0.55} roughness={0.4} />
            : <meshStandardMaterial color={DETAIL} roughness={0.8} />}
        </mesh>
      ))}
    </>
  );
}

export function Node3D({ node, live, isSelected, onClick, showLabel = true, dimmed = false }: Node3DProps) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const [hovered, setHover] = useState(false);

  const data = node.data;
  const status = data.status || 'unknown';
  const statusColor = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  const style = TYPE_STYLE[data.type as string] || TYPE_STYLE.service;
  const anomalous = Boolean((data as any).analytics?.anomalyPersistent);
  const troubled = status === 'critical' || status === 'degraded' || anomalous;
  const ringColor = status === 'critical' ? STATUS_COLORS.critical : status === 'degraded' || anomalous ? STATUS_COLORS.degraded : null;

  const metrics = (data.metrics || {}) as any;
  const cpu = Math.max(0, Math.min(100, metrics.cpu ?? 0));
  const mem = Math.max(0, Math.min(100, metrics.memoryPercent ?? 0));
  const load = Math.max(cpu, mem) / 100;
  const lit = (n: number) => (status === 'unknown' ? 0 : Math.min(n, Math.round(load * n + (load > 0.02 ? 0.5 : 0))));

  // One material for the whole chassis, so dimming and health are a single colour change.
  const clay = useMemo(() => new THREE.MeshStandardMaterial({ color: bodyColor(status), roughness: 0.58, metalness: 0.04 }), [status]);
  const clayTarget = useMemo(() => bodyColor(status), [status]);
  useEffect(() => () => clay.dispose(), [clay]);

  const shortName = useMemo(() => {
    const s = String((data as any).name || node.id);
    return s.length > 22 ? `${s.slice(0, 21)}…` : s;
  }, [data, node.id]);

  useFrame((state, delta) => {
    const pos = live.get(node.id);
    if (rootRef.current && pos) rootRef.current.position.copy(pos);

    if (bodyRef.current) {
      const lift = isSelected ? 0.5 : hovered ? 0.25 : 0;
      bodyRef.current.position.y = THREE.MathUtils.damp(bodyRef.current.position.y, lift, 9, delta);
    }

    const want = dimmed ? clayTarget.clone().lerp(DIM_TO, 0.78) : clayTarget;
    clay.color.lerp(want, 1 - Math.exp(-8 * delta));

    // A failing service sends a slow ripple across the floor: visible from any angle, never flashing.
    if (pulseRef.current) {
      const p = (state.clock.elapsedTime * (status === 'critical' ? 0.55 : 0.35)) % 1;
      pulseRef.current.scale.setScalar(1 + p * 1.6);
      (pulseRef.current.material as THREE.MeshBasicMaterial).opacity = (dimmed ? 0.15 : 0.55) * (1 - p) ** 2;
    }
  });

  const highlight = isSelected || hovered;
  const labelColor = dimmed ? '#4a4f57' : highlight ? '#ffffff' : '#e3e5e8';
  const subText = status === 'unknown' ? 'no data'
    : status !== 'healthy' ? `${status} · ${Math.round(cpu)}% cpu`
    : anomalous ? `unusual · ${Math.round(cpu)}% cpu`
    : `${Math.round(cpu)}% cpu · ${Math.round(mem)}% mem`;
  const subColor = dimmed ? '#3a3e45' : troubled ? (ringColor ?? statusColor) : '#80868f';

  return (
    <group ref={rootRef}>
      {/* plinth */}
      <RoundedBox args={[4.9, PLATFORM_Y, 4.9]} radius={0.05} smoothness={2} position={[0, PLATFORM_Y / 2, 0]}>
        <meshStandardMaterial color={PLINTH} roughness={0.92} metalness={0} />
      </RoundedBox>

      {ringColor && (
        <>
          <mesh geometry={RING_GEOM} position={[0, 0.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <meshBasicMaterial color={ringColor} transparent opacity={dimmed ? 0.25 : 0.95} depthWrite={false} />
          </mesh>
          <mesh ref={pulseRef} geometry={RING_GEOM} position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <meshBasicMaterial color={ringColor} transparent opacity={0.4} depthWrite={false} />
          </mesh>
        </>
      )}
      {isSelected && (
        <mesh geometry={SELECT_GEOM} position={[0, 0.11, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color="#ffffff" transparent opacity={0.9} depthWrite={false} />
        </mesh>
      )}

      <group
        ref={bodyRef}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
      >
        {style.shape === 'rack' && (
          <group position={[0, PLATFORM_Y + 1.75, 0]}>
            <RoundedBox args={[2.2, 3.5, 1.8]} radius={0.14} smoothness={4} material={clay} />
            <Slots positions={[0, 1, 2, 3, 4].map(i => [0, -1.25 + i * 0.6, 0.905] as [number, number, number])} size={[1.5, 0.12, 0.02]} lit={lit(5)} />
          </group>
        )}

        {style.shape === 'storage' && (
          <group position={[0, PLATFORM_Y + 0.42, 0]}>
            {[0, 1, 2].map(i => (
              <group key={i} position={[0, i * 0.94, 0]}>
                <mesh material={clay}><cylinderGeometry args={[1.32, 1.32, 0.8, 48]} /></mesh>
                <mesh position={[0, 0.43, 0]}><cylinderGeometry args={[1.22, 1.22, 0.06, 48]} /><meshStandardMaterial color={DETAIL} roughness={0.8} /></mesh>
              </group>
            ))}
            <Slots positions={[0, 1, 2].map(i => [0, i * 0.94, 1.325] as [number, number, number])} size={[0.5, 0.1, 0.02]} lit={lit(3)} />
          </group>
        )}

        {style.shape === 'router' && (
          <group position={[0, PLATFORM_Y + 0.5, 0]}>
            <RoundedBox args={[3.4, 0.9, 2.4]} radius={0.16} smoothness={4} material={clay} />
            <Slots positions={[-1.1, -0.55, 0, 0.55, 1.1].map(x => [x, -0.05, 1.205] as [number, number, number])} size={[0.32, 0.14, 0.02]} lit={lit(5)} />
            {[-1.25, 1.25].map(x => (
              <group key={x} position={[x, 0.45, -0.85]}>
                <mesh position={[0, 0.7, 0]} material={clay}><cylinderGeometry args={[0.06, 0.06, 1.4, 12]} /></mesh>
                <mesh position={[0, 1.42, 0]} material={clay}><sphereGeometry args={[0.12, 16, 16]} /></mesh>
              </group>
            ))}
          </group>
        )}

        {style.shape === 'screen' && (
          <group position={[0, PLATFORM_Y, 0]}>
            <mesh position={[0, 0.1, 0]} material={clay}><cylinderGeometry args={[0.85, 0.95, 0.2, 40]} /></mesh>
            <mesh position={[0, 0.9, 0.05]} material={clay}><boxGeometry args={[0.28, 1.4, 0.18]} /></mesh>
            <group position={[0, 2.45, 0]}>
              <RoundedBox args={[3.4, 2.1, 0.2]} radius={0.08} smoothness={4} material={clay} />
              <mesh position={[0, 0, 0.105]}>
                <planeGeometry args={[3.12, 1.82]} />
                <meshStandardMaterial color="#1d2025" roughness={0.35} metalness={0.1} />
              </mesh>
              <Slots positions={[0, 1, 2, 3].map(i => [-0.95 + i * 0.63, -0.55, 0.11] as [number, number, number])} size={[0.46, 0.06, 0.005]} lit={lit(4)} />
              <mesh position={[-0.55, 0.45, 0.11]}><planeGeometry args={[1.6, 0.12]} /><meshBasicMaterial color="#3a3e45" /></mesh>
              <mesh position={[-0.8, 0.2, 0.11]}><planeGeometry args={[1.1, 0.08]} /><meshBasicMaterial color="#2c3036" /></mesh>
            </group>
          </group>
        )}

        {style.shape === 'pipe' && (
          <group position={[0, PLATFORM_Y + 1.05, 0]} rotation={[0, 0, Math.PI / 2]}>
            <mesh material={clay}><capsuleGeometry args={[0.9, 2.6, 12, 40]} /></mesh>
            {[-0.9, 0, 0.9].map((y, i) => (
              <mesh key={i} position={[0, y, 0]}>
                <torusGeometry args={[0.905, 0.045, 10, 48]} />
                {i < lit(3)
                  ? <meshStandardMaterial color={LOAD_ON} emissive={LOAD_ON} emissiveIntensity={0.55} />
                  : <meshStandardMaterial color={DETAIL} roughness={0.8} />}
              </mesh>
            ))}
          </group>
        )}

        {style.shape === 'module' && (
          <group position={[0, PLATFORM_Y + 1.05, 0]}>
            <RoundedBox args={[2.1, 2.1, 2.1]} radius={0.22} smoothness={4} material={clay} />
            <Slots positions={[-0.5, 0, 0.5].map(y => [0, y, 1.055] as [number, number, number])} size={[1.3, 0.12, 0.02]} lit={lit(3)} />
          </group>
        )}

        {showLabel && (
          // Isolated boundary: troika fetches a font, and a hang must never take the scene down with it.
          <Suspense fallback={null}>
            <Billboard position={[0, 5.9, 0]}>
              <Text fontSize={highlight ? 0.78 : 0.7} color={labelColor} anchorX="center" anchorY="middle" letterSpacing={-0.01}
                outlineWidth={0.035} outlineColor="#0d0e10" outlineOpacity={0.85}>
                {shortName}
              </Text>
              {(highlight || troubled || status === 'unknown') && <Text position={[0, -0.82, 0]} fontSize={0.48} color={subColor} anchorX="center" anchorY="middle"
                outlineWidth={0.025} outlineColor="#0d0e10" outlineOpacity={0.85}>
                {subText}
              </Text>}
            </Billboard>
          </Suspense>
        )}
      </group>
    </group>
  );
}
