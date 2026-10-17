import { useMemo } from 'react';
import { Billboard, Edges, Text } from '@react-three/drei';
import { archTierOf, type ArchTier, type LayoutId, type LayoutNode, type Positions } from './layouts';

interface FlowPlatformsProps {
  layout: LayoutId;
  nodes: LayoutNode[];
  positions: Positions;
}

interface PlatformMeta {
  key: ArchTier;
  label: string;
  badge: string;
  color: string;
}

const FLOW_STAGES: PlatformMeta[] = [
  { key: 'ingress', label: '01 // INGRESS PIPELINE', badge: 'GATEWAY', color: '#8ab4ff' },
  { key: 'services', label: '02 // CORE SERVICES', badge: 'LOGIC', color: '#38bdf8' },
  { key: 'infra', label: '03 // ASYNC & INFRA', badge: 'STREAM', color: '#a855f7' },
  { key: 'data', label: '04 // DATA BEDROCK', badge: 'PERSISTENCE', color: '#3ecf8e' },
];

const TIER_STAGES: PlatformMeta[] = [
  { key: 'ingress', label: 'TIER 04 // PRESENTATION & GATEWAY', badge: 'L4', color: '#8ab4ff' },
  { key: 'services', label: 'TIER 03 // CORE MICROSERVICES', badge: 'L3', color: '#38bdf8' },
  { key: 'infra', label: 'TIER 02 // MESSAGING & INFRA', badge: 'L2', color: '#a855f7' },
  { key: 'data', label: 'TIER 01 // DATA BEDROCK', badge: 'L1', color: '#3ecf8e' },
];

function stageOf(node: LayoutNode): ArchTier {
  return archTierOf(node.type);
}

/**
 * Architectural ground platforms:
 * - Flow: clean illuminated runway pads along the horizontal conveyor stages (y=0).
 * - Tiers: floating illuminated terrace slabs under each amphitheater step.
 */
export function FlowPlatforms({ layout, nodes, positions }: FlowPlatformsProps) {
  const isFlow = layout === 'flow';
  const isTiers = layout === 'tiers';

  const stagesList = isFlow ? FLOW_STAGES : isTiers ? TIER_STAGES : [];

  const platformsData = useMemo(() => {
    if (!isFlow && !isTiers) return [];

    const map = new Map<ArchTier, { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number; count: number }>();
    for (const s of stagesList) {
      map.set(s.key, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 });
    }

    for (const n of nodes) {
      const p = positions[n.id];
      if (!p) continue;
      const key = stageOf(n);
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
      const w = Math.max(28, b.maxX - b.minX + padX * 2);
      const depth = Math.max(24, b.maxZ - b.minZ + padZ * 2);
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
  }, [stagesList, nodes, positions, isFlow, isTiers]);

  if (!isFlow && !isTiers) return null;

  return (
    <group>
      {platformsData.map((plat) => {
        if (!plat) return null;

        const thickness = isFlow ? 0.12 : 0.35;
        const platformY = isFlow ? 0.05 : plat.baseY - thickness / 2 - 0.05;
        const signX = plat.cx - plat.w / 2 + 3.2;
        const signZ = plat.cz + plat.depth / 2 + 2.0;
        const signY = isFlow ? 1.8 : plat.baseY + 1.8;

        return (
          <group key={plat.key}>
            {/* The illuminated platform base */}
            <mesh position={[plat.cx, platformY, plat.cz]} receiveShadow>
              <boxGeometry args={[plat.w, thickness, plat.depth]} />
              <meshStandardMaterial
                color="#0c0e14"
                roughness={0.65}
                metalness={0.3}
              />
              <Edges threshold={15} color={`${plat.color}99`} lineWidth={1.5} />
            </mesh>

            {/* Glowing translucent floor tint matching the tier color */}
            <mesh position={[plat.cx, platformY + thickness / 2 + 0.005, plat.cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[plat.w - 0.4, plat.depth - 0.4]} />
              <meshBasicMaterial
                color={plat.color}
                transparent
                opacity={isFlow ? 0.06 : 0.08}
              />
            </mesh>

            {/* Clean 3D Stage / Tier billboard signboard placed at front-left edge */}
            <group position={[signX, signY, signZ]}>
              <Billboard>
                <Text
                  fontSize={1.25}
                  color={plat.color}
                  anchorX="left"
                  anchorY="middle"
                  outlineWidth={0.06}
                  outlineColor="#07080c"
                >
                  {plat.label}
                </Text>
                <Text
                  position={[0, -1.05, 0]}
                  fontSize={0.85}
                  color="rgba(255,255,255,0.55)"
                  anchorX="left"
                  anchorY="middle"
                  outlineWidth={0.03}
                  outlineColor="#07080c"
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
