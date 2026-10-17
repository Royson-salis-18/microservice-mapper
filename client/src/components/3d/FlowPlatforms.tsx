import { useMemo } from 'react';
import { Billboard, Edges, Text } from '@react-three/drei';
import type { LayoutNode, Positions } from './layouts';

interface FlowPlatformsProps {
  nodes: LayoutNode[];
  positions: Positions;
}

interface DeckMeta {
  key: string;
  label: string;
  deckNumber: string;
  y: number;
  color: string;
}

const DECKS: DeckMeta[] = [
  { key: 'ingress', label: 'INGRESS DECK', deckNumber: 'L3', y: 16, color: '#8ab4ff' },
  { key: 'services', label: 'SERVICES DECK', deckNumber: 'L2', y: 8, color: '#38bdf8' },
  { key: 'data', label: 'DATA BEDROCK', deckNumber: 'L1', y: 0, color: '#3ecf8e' },
  { key: 'wing', label: 'INFRA & QUEUES WING', deckNumber: 'SIDE', y: 4, color: '#94a3b8' },
];

function deckOf(node: LayoutNode): string {
  if (node.type === 'gateway' || node.type === 'frontend') return 'ingress';
  if (node.type === 'database' || node.type === 'cache') return 'data';
  if (node.type === 'queue' || node.type === 'infrastructure' || node.type === 'external' || node.type === 'observability') return 'wing';
  return 'services';
}

/**
 * Physical illuminated deck platforms for the Stepped Architectural Flow layout.
 * Shows the exact tiers of microservice architecture in 3D physical decks.
 */
export function FlowPlatforms({ nodes, positions }: FlowPlatformsProps) {
  const decksData = useMemo(() => {
    const map = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number; count: number }>();
    for (const d of DECKS) {
      map.set(d.key, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, count: 0 });
    }

    for (const n of nodes) {
      const p = positions[n.id];
      if (!p) continue;
      const key = deckOf(n);
      const b = map.get(key);
      if (!b) continue;
      b.minX = Math.min(b.minX, p[0]);
      b.maxX = Math.max(b.maxX, p[0]);
      b.minZ = Math.min(b.minZ, p[2]);
      b.maxZ = Math.max(b.maxZ, p[2]);
      b.count++;
    }

    return DECKS.map((d) => {
      const b = map.get(d.key)!;
      if (b.count === 0) return null;
      const padX = 7;
      const padZ = 6;
      const w = Math.max(22, b.maxX - b.minX + padX * 2);
      const depth = Math.max(16, b.maxZ - b.minZ + padZ * 2);
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      return {
        ...d,
        cx,
        cz,
        w,
        depth,
        count: b.count,
      };
    }).filter(Boolean);
  }, [nodes, positions]);

  return (
    <group>
      {decksData.map((deck) => {
        if (!deck) return null;
        const slabHeight = Math.max(1.2, deck.y * 0.95);
        const slabY = deck.y - slabHeight / 2 - 0.05;

        return (
          <group key={deck.key}>
            {/* The structural deck platform slab */}
            <mesh position={[deck.cx, slabY, deck.cz]} receiveShadow>
              <boxGeometry args={[deck.w, slabHeight, deck.depth]} />
              <meshStandardMaterial
                color="#14161c"
                roughness={0.65}
                metalness={0.45}
              />
              <Edges threshold={20} color={`${deck.color}55`} />
            </mesh>

            {/* Glowing neon edge trim along the platform perimeter */}
            <mesh position={[deck.cx, deck.y + 0.01, deck.cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[deck.w + 0.4, deck.depth + 0.4]} />
              <meshBasicMaterial
                color={deck.color}
                wireframe
                transparent
                opacity={0.35}
              />
            </mesh>

            {/* Front signboard label in 3D */}
            <group position={[deck.cx, deck.y + 1.2, deck.cz + deck.depth / 2 + 1.5]}>
              <Billboard>
                <Text
                  fontSize={1.4}
                  color={deck.color}
                  anchorX="center"
                  outlineWidth={0.06}
                  outlineColor="#0b0c10"
                >
                  {`${deck.label} (${deck.deckNumber})`}
                </Text>
                <Text
                  position={[0, -1.2, 0]}
                  fontSize={0.9}
                  color="rgba(255,255,255,0.45)"
                  anchorX="center"
                >
                  {`${deck.count} service${deck.count === 1 ? '' : 's'}`}
                </Text>
              </Billboard>
            </group>
          </group>
        );
      })}
    </group>
  );
}
