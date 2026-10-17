import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Billboard, Edges, Text } from '@react-three/drei';
import { archTierOf, type LayoutId, type LayoutNode, type Positions } from './layouts';
import { glowTexture, tiledFloor } from './textures';

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
  { key: 'infra', label: '03 // ASYNC & INFRA', badge: 'STREAM', color: '#a855f7' },
  { key: 'data', label: '04 // DATA BEDROCK', badge: 'PERSISTENCE', color: '#3ecf8e' },
];

const TIER_STAGES: PlatformMeta[] = [
  { key: 'ingress', label: 'TIER 04 // PRESENTATION & GATEWAY', badge: 'L4', color: '#8ab4ff' },
  { key: 'services', label: 'TIER 03 // CORE MICROSERVICES', badge: 'L3', color: '#38bdf8' },
  { key: 'infra', label: 'TIER 02 // MESSAGING & INFRA', badge: 'L2', color: '#a855f7' },
  { key: 'data', label: 'TIER 01 // DATA BEDROCK', badge: 'L1', color: '#3ecf8e' },
];

const PROJECT_PALETTE = ['#38bdf8', '#a855f7', '#3ecf8e', '#f59e0b', '#ec4899', '#8ab4ff'];

/**
 * Tiled top floor plate on the platform surface, exactly like Islands/Clusters.
 */
function PlatformTopPlate({ cx, cz, topY, w, d, color }: { cx: number; cz: number; topY: number; w: number; d: number; color: string }) {
  const map = useMemo(() => tiledFloor(Math.max(1, w / 8), Math.max(1, d / 8)), [w, d]);
  useEffect(() => () => map.dispose(), [map]);

  return (
    <group>
      <mesh position={[cx, topY + 0.003, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w - 0.6, d - 0.6]} />
        <meshStandardMaterial map={map} color="#c5c5c8" roughness={0.42} metalness={0.48} />
      </mesh>
      <mesh position={[cx, topY + 0.006, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w - 0.6, d - 0.6]} />
        <meshBasicMaterial color={color} transparent opacity={0.07} />
      </mesh>
    </group>
  );
}

/**
 * Architectural ground platforms:
 * - Employs the rich visual language of Islands and Clusters:
 *   - Raised solid metal/composite plinth
 *   - Radiant ground glow pool beneath each island
 *   - Tiled datacenter floor plate
 *   - Architectural neon perimeter edges and cutaway kerb
 *   - Floor typography and front-left billboard signboard
 * - Rendered across Flow (horizontal pipeline runways), Tiers (stepped amphitheater terraces),
 *   and Topology (domain cluster pods).
 */
export function FlowPlatforms({ layout, nodes, positions }: FlowPlatformsProps) {
  const isFlow = layout === 'flow';
  const isTiers = layout === 'tiers';
  const isTopology = layout === 'topology';

  const projects = useMemo(() => Array.from(new Set(nodes.map((n) => n.project).filter(Boolean))), [nodes]);
  const isMultiProject = projects.length > 1;

  const topologyStages = useMemo<PlatformMeta[]>(() => {
    if (!isTopology) return [];
    if (isMultiProject) {
      return projects.map((p, idx) => ({
        key: p,
        label: p.toUpperCase(),
        badge: 'POD',
        color: PROJECT_PALETTE[idx % PROJECT_PALETTE.length],
      }));
    }
    return [
      { key: 'ingress', label: '01 // INGRESS & EDGE', badge: 'GATEWAY', color: '#8ab4ff' },
      { key: 'services', label: '02 // CORE SERVICES', badge: 'LOGIC', color: '#38bdf8' },
      { key: 'infra', label: '03 // INFRA & TELEMETRY', badge: 'OPS', color: '#a855f7' },
      { key: 'data', label: '04 // DATA BEDROCK', badge: 'PERSISTENCE', color: '#3ecf8e' },
    ];
  }, [isTopology, isMultiProject, projects]);

  const stagesList = useMemo(() => {
    if (isFlow) return FLOW_STAGES;
    if (isTiers) return TIER_STAGES;
    if (isTopology) return topologyStages;
    return [];
  }, [isFlow, isTiers, isTopology, topologyStages]);

  const stageOf = (node: LayoutNode): string => {
    if (isTopology && isMultiProject) {
      return node.project || 'core';
    }
    return archTierOf(node.type);
  };

  const platformsData = useMemo(() => {
    if (!isFlow && !isTiers && !isTopology) return [];

    const map = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number; count: number }>();
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
      if (!b || b.count === 0) return null;
      const padX = isFlow ? 10 : isTiers ? 12 : 10;
      const padZ = isFlow ? 12 : isTiers ? 10 : 10;
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
  }, [stagesList, nodes, positions, isFlow, isTiers, isTopology, isMultiProject]);

  if (!isFlow && !isTiers && !isTopology) return null;

  return (
    <group>
      {platformsData.map((plat) => {
        if (!plat) return null;

        const thickness = isFlow ? 0.16 : 0.28;
        const platformY = plat.baseY + 0.03 - thickness / 2;
        const topY = plat.baseY + 0.03;

        // Position signboard cleanly at the front-left corner
        const signX = plat.cx - plat.w / 2 + 3.2;
        const signZ = plat.cz + plat.depth / 2 + 2.0;
        const signY = isFlow || isTopology ? 1.8 : plat.baseY + 1.8;

        return (
          <group key={plat.key}>
            {/* 1. Radiant ground glow pool beneath the platform (Islands style) */}
            <mesh position={[plat.cx, plat.baseY + 0.018, plat.cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[plat.w + 14, plat.depth + 14]} />
              <meshBasicMaterial
                map={glowTexture()}
                color={plat.color}
                transparent
                opacity={0.18}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>

            {/* 2. Contact shadow under platform plinth */}
            <mesh position={[plat.cx, plat.baseY + 0.022, plat.cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[plat.w + 2, plat.depth + 2]} />
              <meshBasicMaterial
                map={glowTexture()}
                color="#000000"
                transparent
                opacity={0.5}
                depthWrite={false}
              />
            </mesh>

            {/* 3. Main solid raised architectural plinth slab */}
            <mesh position={[plat.cx, platformY, plat.cz]} receiveShadow castShadow>
              <boxGeometry args={[plat.w, thickness, plat.depth]} />
              <meshStandardMaterial
                color="#1a1a1e"
                roughness={0.45}
                metalness={0.55}
              />
              <Edges threshold={15} color={`${plat.color}cc`} lineWidth={1.6} />
            </mesh>

            {/* 4. Tiled floor plate on the top surface (Islands TopPlate) */}
            <PlatformTopPlate
              cx={plat.cx}
              cz={plat.cz}
              topY={topY}
              w={plat.w}
              d={plat.depth}
              color={plat.color}
            />

            {/* 5. Sleek low architectural kerb on the back edge (Clusters/Zone style) */}
            <mesh position={[plat.cx, topY + 0.08, plat.cz - plat.depth / 2 + 0.18]}>
              <boxGeometry args={[plat.w - 0.4, 0.16, 0.36]} />
              <meshStandardMaterial color="#26262a" roughness={0.4} metalness={0.6} />
              <Edges threshold={15} color={plat.color} lineWidth={1.2} />
            </mesh>

            {/* 6. Floor typography painted onto the platform surface (Islands style) */}
            <Text
              rotation={[-Math.PI / 2, 0, 0]}
              position={[plat.cx - plat.w / 2 + 1.2, topY + 0.012, plat.cz + plat.depth / 2 - 1.2]}
              fontSize={0.9}
              color={plat.color}
              fillOpacity={0.88}
              anchorX="left"
              anchorY="bottom"
              letterSpacing={0.08}
            >
              {plat.label}
            </Text>

            {/* 7. 3D Stage / Pod billboard signboard placed at front-left corner */}
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
                  color="rgba(255,255,255,0.6)"
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
