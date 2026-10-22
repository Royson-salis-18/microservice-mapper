import { Suspense, useEffect, useMemo } from 'react';
import { Edges, Text, Html } from '@react-three/drei';
import * as THREE from 'three';
import { glowTexture, tiledFloor } from './textures';
import { archTierOf, type LayoutId, type LayoutNode, type Positions } from './layouts';

interface FlowPlatformsProps {
  layout: LayoutId;
  nodes: LayoutNode[];
  positions: Positions;
}

interface PlatformData {
  key: string;
  label: string;
  count: number;
  color: string;
  cx: number;
  cz: number;
  w: number;
  depth: number;
  topY: number;
  slabY: number;
  thickness: number;
  subLabel?: string;
}

interface ConduitTrack {
  x: number;
  z: number;
  len: number;
  color: string;
}

const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1);

/** The raised-floor machine-room panel plate, matching Islands.tsx TopPlate */
function PlatformTopPlate({ w, d, cx, cz, topY }: { w: number; d: number; cx: number; cz: number; topY: number }) {
  const plateW = Math.max(2, w - 0.8);
  const plateD = Math.max(2, d - 0.8);
  const map = useMemo(() => tiledFloor(plateW / 9, plateD / 9), [plateW, plateD]);
  useEffect(() => () => map.dispose(), [map]);

  return (
    <mesh
      position={[cx, topY + 0.012, cz]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[plateW, plateD, 1]}
      geometry={PLANE_GEOMETRY}
      raycast={() => null}
      receiveShadow
    >
      <meshStandardMaterial map={map} color="#dedee0" roughness={0.45} metalness={0.3} emissive="#7d8bb0" emissiveMap={map} emissiveIntensity={0.22} />
    </mesh>
  );
}

/** Lit neon perimeter rim around the platform top edge, matching Islands & Zone */
function NeonRim({ cx, cz, w, d, y, color }: { cx: number; cz: number; w: number; d: number; y: number; color: string }) {
  const t = 0.12;
  const h = 0.05;
  // three.js rejects 8-digit hex, so an alpha suffix is split into an opacity
  const alpha = /^#[0-9a-f]{8}$/i.test(color) ? parseInt(color.slice(7), 16) / 255 : 1;
  const rgb = alpha < 1 || color.length === 9 ? color.slice(0, 7) : color;
  return (
    <group>
      <mesh position={[cx, y, cz - d / 2]} scale={[w + t, h, t]} geometry={BOX_GEOMETRY} raycast={() => null}>
        <meshBasicMaterial color={rgb} opacity={alpha} transparent={alpha < 1} toneMapped={false} />
      </mesh>
      <mesh position={[cx, y, cz + d / 2]} scale={[w + t, h, t]} geometry={BOX_GEOMETRY} raycast={() => null}>
        <meshBasicMaterial color={rgb} opacity={alpha} transparent={alpha < 1} toneMapped={false} />
      </mesh>
      <mesh position={[cx - w / 2, y, cz]} scale={[t, h, d]} geometry={BOX_GEOMETRY} raycast={() => null}>
        <meshBasicMaterial color={rgb} opacity={alpha} transparent={alpha < 1} toneMapped={false} />
      </mesh>
      <mesh position={[cx + w / 2, y, cz]} scale={[t, h, d]} geometry={BOX_GEOMETRY} raycast={() => null}>
        <meshBasicMaterial color={rgb} opacity={alpha} transparent={alpha < 1} toneMapped={false} />
      </mesh>
    </group>
  );
}

const FLOW_STAGES = [
  { key: 'ingress', label: '01 // INGRESS PIPELINE', color: '#8ab4ff' },
  { key: 'services', label: '02 // CORE SERVICES', color: '#38bdf8' },
  { key: 'infra', label: '03 // ASYNC & INFRA', color: '#a855f7' },
  { key: 'data', label: '04 // DATA BEDROCK', color: '#3ecf8e' },
];

const TIER_STAGES = [
  { key: 'ingress', label: 'TIER 04 // PRESENTATION & GATEWAY', color: '#8ab4ff' },
  { key: 'services', label: 'TIER 03 // CORE MICROSERVICES', color: '#38bdf8' },
  { key: 'infra', label: 'TIER 02 // MESSAGING & INFRA', color: '#a855f7' },
  { key: 'data', label: 'TIER 01 // DATA BEDROCK', color: '#3ecf8e' },
];

/**
 * Architectural platforms for Flow, Topology, and Tiers:
 * Built with the authentic raised machine-room floor panels (tiledFloor),
 * solid chamfered slabs, perimeter neon rims, and flat floor typography
 * used in Islands and Clusters. Completely non-overlapping to guarantee zero glitches.
 */
export function FlowPlatforms({ layout, nodes, positions }: FlowPlatformsProps) {
  const isFlow = layout === 'flow';
  const isTiers = layout === 'tiers';
  const isTopology = layout === 'topology';

  const { platforms, conduits, topologySubPods } = useMemo(() => {
    if (!isFlow && !isTiers && !isTopology) return { platforms: [], conduits: [], topologySubPods: [] };

    // --- 1. FLOW LAYOUT: 4 horizontal non-overlapping conveyor pads ---
    if (isFlow) {
      const map = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number; count: number }>();
      FLOW_STAGES.forEach((s) => map.set(s.key, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, count: 0 }));

      for (const n of nodes) {
        const p = positions[n.id];
        if (!p) continue;
        const key = archTierOf(nodeType(n));
        const b = map.get(key);
        if (!b) continue;
        b.minX = Math.min(b.minX, p[0]);
        b.maxX = Math.max(b.maxX, p[0]);
        b.minZ = Math.min(b.minZ, p[2]);
        b.maxZ = Math.max(b.maxZ, p[2]);
        b.count++;
      }

      const out: PlatformData[] = [];
      FLOW_STAGES.forEach((s) => {
        const b = map.get(s.key)!;
        if (b.count === 0) return;
        const padX = 8, padZ = 8;
        const w = Math.max(26, b.maxX - b.minX + padX * 2);
        const depth = Math.max(24, b.maxZ - b.minZ + padZ * 2);
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        out.push({
          key: s.key,
          label: s.label,
          count: b.count,
          color: s.color,
          cx,
          cz,
          w,
          depth,
          topY: 0,
          slabY: -0.16,
          thickness: 0.32,
        });
      });

      // Ground data conduit walkways bridging consecutive stages
      const tracks: ConduitTrack[] = [];
      for (let i = 0; i < out.length - 1; i++) {
        const cur = out[i];
        const nxt = out[i + 1];
        const rightEdgeCur = cur.cx + cur.w / 2;
        const leftEdgeNxt = nxt.cx - nxt.w / 2;
        const gap = leftEdgeNxt - rightEdgeCur;
        if (gap > 0.5) {
          tracks.push({
            x: (rightEdgeCur + leftEdgeNxt) / 2,
            z: (cur.cz + nxt.cz) / 2,
            len: gap + 0.6,
            color: '#38bdf8',
          });
        }
      }

      return { platforms: out, conduits: tracks, topologySubPods: [] };
    }

    // --- 2. TIERS LAYOUT: 4 stepped amphitheater terrace platforms ---
    // Grounded monolithic terrace podiums reaching down to ground level (Y = 0)
    if (isTiers) {
      const map = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; count: number }>();
      TIER_STAGES.forEach((s) => map.set(s.key, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, count: 0 }));

      for (const n of nodes) {
        const p = positions[n.id];
        if (!p) continue;
        const key = archTierOf(nodeType(n));
        const b = map.get(key);
        if (!b) continue;
        b.minX = Math.min(b.minX, p[0]);
        b.maxX = Math.max(b.maxX, p[0]);
        b.minZ = Math.min(b.minZ, p[2]);
        b.maxZ = Math.max(b.maxZ, p[2]);
        b.minY = Math.min(b.minY, p[1]);
        b.count++;
      }

      const out: PlatformData[] = [];
      TIER_STAGES.forEach((s) => {
        const b = map.get(s.key)!;
        if (b.count === 0) return;
        const padX = 10, padZ = 8;
        const w = Math.max(28, b.maxX - b.minX + padX * 2);
        const depth = Math.max(20, b.maxZ - b.minZ + padZ * 2);
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        const topY = b.minY;
        // Slim floating deck per tier; a full-height block hid the tiers behind it
        const thickness = Math.min(2.2, Math.max(0.35, topY + 0.35));
        const slabY = topY - thickness / 2;
        out.push({
          key: s.key,
          label: s.label,
          count: b.count,
          color: s.color,
          cx,
          cz,
          w,
          depth,
          topY,
          slabY,
          thickness,
        });
      });
      return { platforms: out, conduits: [], topologySubPods: [] };
    }

    // --- 3. TOPOLOGY LAYOUT: Unified Master Datacenter Facility Platform ---
    // Houses the entire interconnected network graph on a solid raised panel floor,
    // with sub-district ground markings for each role, guaranteeing zero glitches.
    if (isTopology) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const n of nodes) {
        const p = positions[n.id];
        if (!p) continue;
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[2]);
        maxZ = Math.max(maxZ, p[2]);
      }

      if (!Number.isFinite(minX)) return { platforms: [], conduits: [], topologySubPods: [] };

      const pad = 9;
      const w = maxX - minX + pad * 2;
      const depth = maxZ - minZ + pad * 2;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;

      const masterPlatform: PlatformData = {
        key: 'topology-master',
        label: 'TOPOLOGY // NETWORK MESH',
        count: nodes.length,
        color: '#5b8def',
        cx,
        cz,
        w,
        depth,
        topY: 0,
        slabY: -0.16,
        thickness: 0.32,
        subLabel: 'unified datacenter mesh',
      };

      // Subtle district outline rings painted on the floor inside the master platform
      const roleMap = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number; count: number }>();
      FLOW_STAGES.forEach((s) => roleMap.set(s.key, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, count: 0 }));

      for (const n of nodes) {
        const p = positions[n.id];
        if (!p) continue;
        const key = archTierOf(nodeType(n));
        const b = roleMap.get(key);
        if (!b) continue;
        b.minX = Math.min(b.minX, p[0]);
        b.maxX = Math.max(b.maxX, p[0]);
        b.minZ = Math.min(b.minZ, p[2]);
        b.maxZ = Math.max(b.maxZ, p[2]);
        b.count++;
      }

      const subPods: { key: string; label: string; count: number; color: string; cx: number; cz: number; w: number; depth: number }[] = [];
      FLOW_STAGES.forEach((s) => {
        const b = roleMap.get(s.key)!;
        if (b.count === 0) return;
        const pPad = 4.5;
        subPods.push({
          key: s.key,
          label: s.label,
          count: b.count,
          color: s.color,
          cx: (b.minX + b.maxX) / 2,
          cz: (b.minZ + b.maxZ) / 2,
          w: Math.max(16, b.maxX - b.minX + pPad * 2),
          depth: Math.max(14, b.maxZ - b.minZ + pPad * 2),
        });
      });

      return { platforms: [masterPlatform], conduits: [], topologySubPods: subPods };
    }

    return { platforms: [], conduits: [], topologySubPods: [] };
  }, [layout, nodes, positions, isFlow, isTiers, isTopology]);

  if (platforms.length === 0) return null;

  return (
    <group>
      {/* 1. Conduit walkways connecting consecutive Flow conveyor stages */}
      {isFlow && conduits.map((c, idx) => (
        <group key={`cond_${idx}`}>
          {/* Conduit base track */}
          <mesh position={[c.x, 0.04, c.z]} scale={[c.len, 0.08, 3.2]} geometry={BOX_GEOMETRY} raycast={() => null} receiveShadow>
            <meshStandardMaterial color="#212123" roughness={0.5} metalness={0.5} />
            <Edges color="#38bdf8" threshold={20} />
          </mesh>
          {/* Lit center neon pulse bar */}
          <mesh position={[c.x, 0.085, c.z]} scale={[c.len, 0.015, 0.55]} geometry={BOX_GEOMETRY} raycast={() => null}>
            <meshBasicMaterial color={c.color} toneMapped={false} transparent opacity={0.8} />
          </mesh>
        </group>
      ))}

      {/* 2. Platform bodies with raised tiled floors, rims, and typography */}
      {platforms.map((plat) => {
                return (
          <group key={plat.key}>
            {/* Soft color glow spill decal on ground around the platform */}
            <mesh position={[plat.cx, 0.02, plat.cz]} rotation={[-Math.PI / 2, 0, 0]} scale={[plat.w + 6, plat.depth + 6, 1]} geometry={PLANE_GEOMETRY} raycast={() => null}>
              <meshBasicMaterial map={glowTexture()} color={plat.color} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
            </mesh>

            {/* Dark contact shadow decal underneath so platform sits solidly grounded */}
            <mesh position={[plat.cx, 0.03, plat.cz]} rotation={[-Math.PI / 2, 0, 0]} scale={[plat.w * 1.08, plat.depth * 1.08, 1]} geometry={PLANE_GEOMETRY} raycast={() => null}>
              <meshBasicMaterial map={glowTexture()} color="#000000" transparent opacity={0.65} depthWrite={false} />
            </mesh>

            {/* Solid architectural slab with chamfered outline edges (matching Clusters Zone) */}
            <mesh position={[plat.cx, plat.slabY, plat.cz]} scale={[plat.w, plat.thickness, plat.depth]} geometry={BOX_GEOMETRY} raycast={() => null} receiveShadow>
              <meshStandardMaterial color="#202737" roughness={0.5} metalness={0.4} />
              <Edges color={plat.color} threshold={15} />
            </mesh>

            {/* Camera-facing neon accent bands on the slab facade, matching Islands */}
            <mesh
              position={[plat.cx, plat.topY - Math.min(plat.thickness, 2) * 0.45, plat.cz + plat.depth / 2 + 0.015]}
              scale={[plat.w - 0.4, 0.07, 0.02]}
              geometry={BOX_GEOMETRY}
              raycast={() => null}
            >
              <meshBasicMaterial color={plat.color} toneMapped={false} />
            </mesh>
            <mesh
              position={[plat.cx + plat.w / 2 + 0.015, plat.topY - Math.min(plat.thickness, 2) * 0.45, plat.cz]}
              scale={[0.02, 0.07, plat.depth - 0.4]}
              geometry={BOX_GEOMETRY}
              raycast={() => null}
            >
              <meshBasicMaterial color={plat.color} toneMapped={false} />
            </mesh>

            {/* Ground perimeter neon base rim */}
            <NeonRim cx={plat.cx} cz={plat.cz} w={plat.w} d={plat.depth} y={0.04} color={`${plat.color}99`} />

            {/* Authentic machine-room tiled floor top plate (matching Islands TopPlate) */}
            <PlatformTopPlate w={plat.w} d={plat.depth} cx={plat.cx} cz={plat.cz} topY={plat.topY} />

            {/* Lit neon rim perimeter around the platform top edge */}
            <NeonRim cx={plat.cx} cz={plat.cz} w={plat.w} d={plat.depth} y={plat.topY + 0.025} color={plat.color} />

            {/* Tier badge: a crisp HTML chip on the front edge, readable at any zoom */}
            <Html position={[plat.cx - plat.w / 2 + 1.2, plat.topY + 0.2, plat.key === 'topology-master' ? plat.cz - plat.depth / 2 : plat.cz + plat.depth / 2]} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
              <div className="plat-badge" style={{ ['--plat' as string]: plat.color }}>
                <span className="plat-badge-dot" />
                <span className="plat-badge-name">{plat.label.replace(/^(TIER|0)\d* ?\/\/ ?/i, '').replace(/^TIER \d+ \/\/ /, '')}</span>
                <span className="plat-badge-count">{plat.subLabel ?? `${plat.count}`}</span>
              </div>
            </Html>
          </group>
        );
      })}

      {/* 3. For Topology: subtle district floor outlines and district titles marking each pod */}
      {isTopology && topologySubPods.map((sub) => {
                return (
          <group key={`sub_${sub.key}`}>
            <mesh position={[sub.cx, 0.025, sub.cz]} rotation={[-Math.PI / 2, 0, 0]} scale={[sub.w, sub.depth, 1]} geometry={PLANE_GEOMETRY} raycast={() => null}>
              <meshBasicMaterial map={glowTexture()} color={sub.color} transparent opacity={0.06} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
            </mesh>
            <NeonRim cx={sub.cx} cz={sub.cz} w={sub.w} d={sub.depth} y={0.028} color={`${sub.color}77`} />
            <Html position={[sub.cx - sub.w / 2 + 0.6, 0.2, sub.cz - sub.depth / 2]} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
              <div className="plat-badge plat-badge-small" style={{ ['--plat' as string]: sub.color }}>
                <span className="plat-badge-dot" />
                <span className="plat-badge-name">{sub.label.replace(/^\d+ \/\/ /, '')}</span>
                <span className="plat-badge-count">{sub.count}</span>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function nodeType(node: LayoutNode): string {
  return node.type || '';
}

