import { Suspense, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Edges, RoundedBox, Text } from '@react-three/drei';
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

const STATUS_COLORS: Record<string, string> = {
  healthy: '#00e676',
  degraded: '#ffab00',
  critical: '#ff1744',
  unknown: '#64748b',
};

export type NodeShape = 'rack' | 'storage' | 'router' | 'screen' | 'module' | 'pipe';

/**
 * Every category colour here is deliberately COOL (cyan/blue/green/violet).
 * Warm hues — amber and red — are reserved exclusively for trouble, so
 * anything reddish on screen always means a real problem (degraded,
 * critical, or a persistent anomaly) and never just "this is a cache".
 *
 * Each category is a recognisable piece of hardware rather than an abstract
 * solid: a database looks like a disk array, a gateway like a router with
 * antennae, a frontend like a screen. Silhouette does the identifying work
 * so the scene reads as infrastructure you could point at, and colour is a
 * second channel rather than the only one.
 */
export const TYPE_STYLE: Record<string, { color: string; shape: NodeShape; label: string }> = {
  gateway:        { color: '#00e5ff', shape: 'router',  label: 'Gateway' },
  frontend:       { color: '#6f8cff', shape: 'screen',  label: 'Frontend' },
  database:       { color: '#00ff9d', shape: 'storage', label: 'Database' },
  cache:          { color: '#a78bfa', shape: 'module',  label: 'Cache' },
  queue:          { color: '#c084fc', shape: 'pipe',    label: 'Queue' },
  service:        { color: '#4fd1c5', shape: 'rack',    label: 'Service' },
  infrastructure: { color: '#9f8fd6', shape: 'rack',    label: 'Infra' },
  external:       { color: '#cbd5e1', shape: 'module',  label: 'External' },
};

const CHASSIS_COLOR = '#5a6b8c';

/**
 * One shared radial-gradient texture for every node's halo. This used to be
 * built per instance, which meant 60 canvases and 60 GPU textures for a
 * 60-service scene — all of them byte-identical, and all of them tinted at
 * draw time by the sprite's own colour anyway.
 */
let sharedHaloTexture: THREE.CanvasTexture | null = null;
function getHaloTexture(): THREE.CanvasTexture {
  if (sharedHaloTexture) return sharedHaloTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedHaloTexture = tex;
  return tex;
}
const PLATFORM_Y = 0.12;

/** Horizontal lit strips — the "drive bays" that make a box read as a rack. */
function Bays({ count, width, depth, height, color, litRef }: {
  count: number; width: number; depth: number; height: number; color: string;
  litRef: React.MutableRefObject<THREE.Mesh[]>;
}) {
  litRef.current = [];
  const spacing = height / (count + 1);
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <mesh
          key={i}
          position={[0, -height / 2 + spacing * (i + 1), depth / 2 + 0.01]}
          ref={(el) => { if (el) litRef.current[i] = el; }}
        >
          <boxGeometry args={[width * 0.72, spacing * 0.34, 0.04]} />
          <meshBasicMaterial color={color} toneMapped={false} transparent opacity={1} />
        </mesh>
      ))}
    </>
  );
}

export function Node3D({ node, live, isSelected, onClick, showLabel = true, dimmed = false }: Node3DProps) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const ledRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Sprite>(null);
  const rimRef = useRef<THREE.Mesh>(null);
  const bays = useRef<THREE.Mesh[]>([]);
  const [hovered, setHover] = useState(false);

  const data = node.data;
  const status = data.status || 'unknown';
  const statusColor = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  const style = TYPE_STYLE[data.type as string] || TYPE_STYLE.service;

  const metrics = (data.metrics || {}) as any;
  const cpu = Math.max(0, Math.min(100, metrics.cpu ?? 0));
  const mem = Math.max(0, Math.min(100, metrics.memoryPercent ?? 0));
  const loadRef = useRef(0);
  loadRef.current = Math.max(cpu, mem) / 100;
  const anomalous = Boolean((data as any).analytics?.anomalyPersistent);

  const shortName = useMemo(() => {
    const raw = (data as any).name || node.id;
    const s = String(raw);
    return s.length > 20 ? `${s.slice(0, 19)}…` : s;
  }, [data, node.id]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const highlight = isSelected || hovered;
    const load = loadRef.current;

    const pos = live.get(node.id);
    if (rootRef.current && pos) rootRef.current.position.copy(pos);

    if (bodyRef.current) {
      // Hardware sits on its platform; only selection lifts it, so the scene
      // reads as a floor of equipment rather than drifting objects.
      const lift = highlight ? 0.55 : 0;
      bodyRef.current.position.y = THREE.MathUtils.damp(bodyRef.current.position.y, lift, 8, delta);
      const target = isSelected ? 1.14 : hovered ? 1.07 : 1;
      const s = THREE.MathUtils.damp(bodyRef.current.scale.x, target, 8, delta);
      bodyRef.current.scale.setScalar(s);
      bodyRef.current.rotation.y = THREE.MathUtils.damp(
        bodyRef.current.rotation.y, highlight ? 0.35 : 0, 6, delta
      );
    }

    // Bay lights flicker like real activity LEDs, at a rate set by load.
    const fade = dimmed ? 0.16 : 1;
    for (let i = 0; i < bays.current.length; i++) {
      const mesh = bays.current[i];
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const phase = t * (1.2 + load * 5) + i * 1.7;
      const active = load > 0.02 ? (Math.sin(phase) + 1) / 2 : 0.25;
      mat.opacity = (0.25 + active * 0.75) * fade;
    }

    if (ledRef.current) {
      const mat = ledRef.current.material as THREE.MeshBasicMaterial;
      const blink = (dimmed ? 0.12 : 1) * (anomalous
        ? Math.abs(Math.sin(t * 6))
        : status === 'healthy' ? 0.75 + Math.sin(t * 2) * 0.25 : Math.abs(Math.sin(t * 3)));
      mat.opacity = 0.35 + blink * 0.65;
    }

    if (haloRef.current) {
      const mat = haloRef.current.material as THREE.SpriteMaterial;
      const base = anomalous ? 0.5 + Math.abs(Math.sin(t * 5)) * 0.4 : 0.14 + load * 0.3;
      mat.opacity = THREE.MathUtils.damp(mat.opacity, highlight ? base + 0.18 : base, 5, delta);
    }

    if (rimRef.current) {
      const mat = rimRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.35 + load * 0.3 + (highlight ? 0.3 : 0);
    }
  });

  const highlight = isSelected || hovered;
  const glowColor = anomalous ? '#ff1744' : statusColor;

  return (
    <group ref={rootRef}>
      {/* Glass platform, like the plinths in the reference renders */}
      <mesh position={[0, PLATFORM_Y / 2, 0]}>
        <boxGeometry args={[5, PLATFORM_Y, 5]} />
        <Edges threshold={18} color={style.color} scale={1.002} />
        <meshStandardMaterial color="#111a2e" roughness={0.25} metalness={0.7} emissive={style.color} emissiveIntensity={0.12} transparent opacity={0.9} />
      </mesh>
      <mesh ref={rimRef} position={[0, PLATFORM_Y + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.35, 2.62, 4, 1]} />
        <meshBasicMaterial color={style.color} transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[3.6, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.07} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <group
        ref={bodyRef}
        position={[0, 0, 0]}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
        onPointerOut={() => setHover(false)}
      >
        <sprite ref={haloRef} position={[0, 2.2, 0]} scale={7}>
          <spriteMaterial map={getHaloTexture()} color={glowColor} transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} />
        </sprite>

        {/* ---- SERVICE / INFRA: a server rack with drive bays ---- */}
        {style.shape === 'rack' && (
          <group position={[0, PLATFORM_Y + 1.8, 0]}>
            <RoundedBox args={[2.3, 3.6, 1.8]} radius={0.09} smoothness={3}>
              <meshStandardMaterial color={CHASSIS_COLOR} roughness={0.22} metalness={0.9} emissive={style.color} emissiveIntensity={0.55} />
              <Edges threshold={18} color={highlight ? '#ffffff' : style.color} scale={1.004} />
            </RoundedBox>
            {/* Top vent grille + lit seam: detail that survives at distance */}
            <mesh position={[0, 1.81, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1.9, 1.4]} />
              <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.28} />
            </mesh>
            <mesh position={[0, 0, 0.92]}>
              <boxGeometry args={[2.32, 0.05, 0.02]} />
              <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.75} />
            </mesh>
            <Bays count={5} width={2.3} depth={1.8} height={3.6} color={style.color} litRef={bays} />
          </group>
        )}

        {/* ---- DATABASE: stacked disk array ---- */}
        {style.shape === 'storage' && (
          <group position={[0, PLATFORM_Y + 1.5, 0]}>
            {[0, 1, 2].map((i) => (
              <group key={i} position={[0, -1.05 + i * 1.05, 0]}>
                <mesh>
                  <cylinderGeometry args={[1.35, 1.35, 0.8, 28]} />
                  <meshStandardMaterial color={CHASSIS_COLOR} roughness={0.22} metalness={0.9} emissive={style.color} emissiveIntensity={0.55} />
                  <Edges threshold={22} color={highlight ? '#ffffff' : style.color} scale={1.005} />
                </mesh>
                <mesh position={[0, 0.42, 0]}>
                  <torusGeometry args={[1.36, 0.045, 8, 36]} />
                  <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.8} />
                </mesh>
              </group>
            ))}
          </group>
        )}

        {/* ---- GATEWAY: flat router with antennae ---- */}
        {style.shape === 'router' && (
          <group position={[0, PLATFORM_Y + 0.9, 0]}>
            <RoundedBox args={[3.4, 0.85, 2.4]} radius={0.12} smoothness={3}>
              <meshStandardMaterial color={CHASSIS_COLOR} roughness={0.22} metalness={0.9} emissive={style.color} emissiveIntensity={0.55} />
              <Edges threshold={18} color={highlight ? '#ffffff' : style.color} scale={1.004} />
            </RoundedBox>
            {/* port lights along the front */}
            {[-1.1, -0.55, 0, 0.55, 1.1].map((x, i) => (
              <mesh key={i} position={[x, -0.12, 1.21]} ref={(el) => { if (el) bays.current[i] = el; }}>
                <boxGeometry args={[0.28, 0.14, 0.05]} />
                <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.9} />
              </mesh>
            ))}
            {[-1.3, 1.3].map((x, i) => (
              <group key={i} position={[x, 0.42, -0.8]}>
                <mesh position={[0, 0.75, 0]}>
                  <cylinderGeometry args={[0.055, 0.055, 1.5, 8]} />
                  <meshStandardMaterial color="#334155" roughness={0.5} metalness={0.7} />
                </mesh>
                <mesh position={[0, 1.55, 0]}>
                  <sphereGeometry args={[0.13, 12, 12]} />
                  <meshBasicMaterial color={style.color} toneMapped={false} />
                </mesh>
              </group>
            ))}
          </group>
        )}

        {/* ---- FRONTEND: a screen on a stand ---- */}
        {style.shape === 'screen' && (
          <group position={[0, PLATFORM_Y, 0]}>
            <mesh position={[0, 0.35, 0]}>
              <cylinderGeometry args={[0.7, 0.85, 0.22, 20]} />
              <meshStandardMaterial color={CHASSIS_COLOR} roughness={0.22} metalness={0.9} emissive={style.color} emissiveIntensity={0.55} />
            </mesh>
            <mesh position={[0, 1.1, 0]}>
              <cylinderGeometry args={[0.16, 0.16, 1.3, 12]} />
              <meshStandardMaterial color="#334155" roughness={0.5} metalness={0.7} />
            </mesh>
            <group position={[0, 2.5, 0]}>
              <RoundedBox args={[3.4, 2.1, 0.22]} radius={0.08} smoothness={3}>
                <meshStandardMaterial color={CHASSIS_COLOR} roughness={0.22} metalness={0.9} emissive={style.color} emissiveIntensity={0.55} />
                <Edges threshold={18} color={highlight ? '#ffffff' : style.color} scale={1.004} />
              </RoundedBox>
              <mesh position={[0, 0, 0.13]} ref={(el) => { if (el) bays.current[0] = el; }}>
                <planeGeometry args={[3.05, 1.75]} />
                <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.8} />
              </mesh>
            </group>
          </group>
        )}

        {/* ---- QUEUE: a segmented pipe ---- */}
        {style.shape === 'pipe' && (
          <group position={[0, PLATFORM_Y + 1.3, 0]} rotation={[0, 0, Math.PI / 2]}>
            <mesh>
              <cylinderGeometry args={[0.95, 0.95, 3.6, 24]} />
              <meshStandardMaterial color={CHASSIS_COLOR} roughness={0.22} metalness={0.9} emissive={style.color} emissiveIntensity={0.55} />
              <Edges threshold={22} color={highlight ? '#ffffff' : style.color} scale={1.005} />
            </mesh>
            {[-1.1, 0, 1.1].map((y, i) => (
              <mesh key={i} position={[0, y, 0]} ref={(el) => { if (el) bays.current[i] = el; }}>
                <torusGeometry args={[0.99, 0.07, 8, 28]} />
                <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.85} />
              </mesh>
            ))}
          </group>
        )}

        {/* ---- CACHE / EXTERNAL: a compact vented module ---- */}
        {style.shape === 'module' && (
          <group position={[0, PLATFORM_Y + 1.1, 0]}>
            <RoundedBox args={[2.2, 2.2, 2.2]} radius={0.16} smoothness={3}>
              <meshStandardMaterial color={CHASSIS_COLOR} roughness={0.22} metalness={0.9} emissive={style.color} emissiveIntensity={0.55} />
              <Edges threshold={18} color={highlight ? '#ffffff' : style.color} scale={1.004} />
            </RoundedBox>
            {[-0.55, 0, 0.55].map((y, i) => (
              <mesh key={i} position={[0, y, 1.12]} ref={(el) => { if (el) bays.current[i] = el; }}>
                <boxGeometry args={[1.5, 0.16, 0.05]} />
                <meshBasicMaterial color={style.color} toneMapped={false} transparent opacity={0.85} />
              </mesh>
            ))}
          </group>
        )}

        {/* Status LED sits on top of every chassis */}
        <mesh ref={ledRef} position={[0, 4.35, 0]}>
          <sphereGeometry args={[0.2, 14, 14]} />
          <meshBasicMaterial color={statusColor} toneMapped={false} transparent opacity={0.9} />
        </mesh>

        {highlight && (
          <mesh position={[0, 2.1, 0]}>
            <boxGeometry args={[4.4, 4.6, 3.4]} />
            <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.16} depthWrite={false} />
          </mesh>
        )}

        {showLabel && (
          // Isolated boundary — troika fetches a font, and a hang here must
          // never take the rest of the scene down with it.
          <Suspense fallback={null}>
            <Billboard position={[0, 5.6, 0]}>
              <Text fontSize={highlight ? 0.92 : 0.78} color={highlight ? '#ffffff' : '#dbeafe'} anchorX="center" anchorY="middle" outlineWidth={0.05} outlineColor="#04060d">
                {shortName}
              </Text>
              <Text position={[0, -0.95, 0]} fontSize={0.55} color={statusColor} anchorX="center" anchorY="middle" outlineWidth={0.03} outlineColor="#04060d">
                {`${Math.round(cpu)}% cpu · ${Math.round(mem)}% mem`}
              </Text>
            </Billboard>
          </Suspense>
        )}
      </group>
    </group>
  );
}
