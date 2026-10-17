import { useMemo } from 'react';
import { Billboard, Edges, Text } from '@react-three/drei';
import type { LayoutId, LayoutNode, Positions } from './layouts';

interface FlowPlatformsProps {
  layout: LayoutId;
  nodes: LayoutNode[];
  positions: Positions;
}

interface PlatformMeta {
  key: string;
  label: string;
  badge: string;
  color: string;
}

const FLOW_STAGES: PlatformMeta[] = [
  { key: 'ingress', label: '01 // INGRESS PIPELINE', badge: 'GATEWAY', color: '#8ab4ff' },
  { key: 'services', label: '02 // CORE SERVICES', badge: 'LOGIC', color: '#38bdf8' },
  { key: 'async', label: '03 // ASYNC & QUEUES', badge: 'STREAM', color: '#a855f7' },
  { key: 'storage', label: '04 // DATA BEDROCK', badge: 'PERSISTENCE', color: '#3ecf8e' },
];

const TIER_STAGES: PlatformMeta[] = [
  { key: 'tier_frontend', label: 'TIER 04 // PRESENTATION', badge: 'L4', color: '#8ab4ff' },
  { key: 'tier_service', label: 'TIER 03 // CORE SERVICES', badge: 'L3', color: '#38bdf8' },
  { key: 'tier_queue', label: 'TIER 02 // MESSAGING & INFRA', badge: 'L2', color: '#a855f7' },
  { key: 'tier_data', label: 'TIER 01 // DATA BEDROCK', badge: 'L1', color: '#3ecf8e' },
];

function stageOf(node: LayoutNode, layout: LayoutId): string {
  if (layout === 'flow') {
    if (node.type === 'gateway' || node.type === 'frontend') return 'ingress';
    if (node.type === 'database') return 'storage';
    if (node.type === 'queue' || node.type === 'cache' || node.type === 'infrastructure' || node.type === 'external' || node.type === 'observability') return 'async';
    return 'services';
  }
  // tiers
  if (node.type === 'frontend' || node.type === 'gateway') return 'tier_frontend';
  if (node.type === 'database') return 'tier_data';
  if (node.type === 'queue' || node.type === 'cache' || node.type === 'infrastructure' || node.type === 'external' || node.type === 'observability') return 'tier_queue';
  return 'tier_service';
}

/**
 * Architectural ground platforms:
 * - When in Flow layout: sleek, low-profile runway tracks along the horizontal pipeline stages (y=0).
 * - When in Tiers layout: floating illuminated terrace steps under each tier of the amphitheater.
 */
export function FlowPlatforms({ layout, nodes, positions }: FlowPlatformsProps) {
  const isFlow = layout === 'flow';
  const isTiers = layout === 'tiers';

  const stagesList = isFlow ? FLOW_STAGES : isTiers ? TIER_STAGES : [];

  const platformsData = useMemo(() => {
    if (!isFlow && !isTiers) return [];

    const map = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number; count: number }>();
    for (const s of stagesList) {
      map.set(s.key, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 });
    }

    for (const n of nodes) {
      const p = positions[n.id];
      if (!p) continue;
      const key = stageOf(n, layout);
      const b = map.get(key);
      if (!b) continue;
      b.minX = Math.min(b.minX, p[0]);
      b.maxX = Math.max(b.maxX, p[0]);
      b.minZ = Math.min(b.minZ, p[2]);
      b.maxZ = Math.max(b.maxZ, p[2]);
      b.minY = Math.min(b.minY, p[1]);
      b.maxY = Math.max(b.maxY, p[1]);
      b.count++;
    }

    return stagesList.map((s) => {
      const b = map.get(s.key)!;
      if (b.count === 0) return null;
      const padX = isFlow ? 10 : 12;
      const padZ = isFlow ? 12 : 10;
      const w = Math.max(26, b.maxX - b.minX + padX * 2);
      const depth = Math.max(22, b.maxZ - b.minZ + padZ * 2);
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const baseY = b.minY;

      return {
        ...s,
        cx,
        cz,
        baseY,
        w,
        depth,
        count: b.count,
      };
    }).filter(Boolean);
  }, [stagesList, nodes, positions, isFlow, isTiers, layout]);

  if (!isFlow && !isTiers) return null;

  return (
    <group>
      {platformsData.map((plat) => {
        if (!plat) return null;

        // In Flow layout, platforms are low-profile sleek floor pads (y=0.03, thickness 0.08)
        // In Tiers layout, platforms are floating terrace slabs directly beneath each tier's elevation
        const thickness = isFlow ? 0.1 : 0.25;
        const platformY = isFlow ? 0.04 : plat.baseY - thickness / 2 - 0.05;
        const signZ = isFlow ? plat.cz - plat.depth / 2 - 3.8 : plat.cz + plat.depth / 2 + 3.0;
        const signY = isFlow ? 2.0 : plat.baseY + 2.2;

        return (
          <group key={plat.key}>
            {/* The illuminated platform base */}
            <mesh position={[plat.cx, platformY, plat.cz]} receiveShadow>
              <boxGeometry args={[plat.w, thickness, plat.depth]} />
              <meshStandardMaterial
                color="#0e1017"
                roughness={0.7}
                metalness={0.2}
              />
              <Edges threshold={15} color={`${plat.color}66`} />
            </mesh>

            {/* Glowing neon perimeter line on the platform surface */}
            <mesh position={[plat.cx, platformY + thickness / 2 + 0.01, plat.cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[plat.w + 0.2, plat.depth + 0.2]} />
              <meshBasicMaterial
                color={plat.color}
                wireframe
                transparent
                opacity={0.3}
              />
            </mesh>

            {/* Clean 3D Stage / Tier billboard signboard placed clearly outside node bounds */}
            <group position={[plat.cx, signY, signZ]}>
              <Billboard>
                <Text
                  fontSize={1.4}
                  color={plat.color}
                  anchorX="center"
                  outlineWidth={0.06}
                  outlineColor="#07080c"
                >
                  {plat.label}
                </Text>
                <Text
                  position={[0, -1.2, 0]}
                  fontSize={0.95}
                  color="rgba(255,255,255,0.45)"
                  anchorX="center"
                >
                  {`${plat.count} service${plat.count === 1 ? '' : 's'}`}
                </Text>
              </Billboard>
            </group>
          </group>
        );
      })}
    </group>
  );
}
