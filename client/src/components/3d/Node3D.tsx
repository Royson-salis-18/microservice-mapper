import { useRef, useState, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { ServiceNode } from '../../types';

interface Node3DProps {
  node: { id: string; data: ServiceNode };
  position: [number, number, number];
  isSelected: boolean;
  onClick: () => void;
}

const typeIcons: Record<string, string> = {
  gateway: '🌐',
  service: '⚡',
  database: '🗄️',
  queue: '📨',
  frontend: '🖥️',
  infrastructure: '🔧',
  external: '☁️',
  unknown: '❓'
};

export function Node3D({ node, position, isSelected, onClick }: Node3DProps) {
  const meshRef = useRef<any>(null);
  const outerRingRef = useRef<any>(null);
  const haloRef = useRef<any>(null);
  const [hovered, setHover] = useState(false);

  const data = node.data;
  
  let color = '#00d4ff'; // default cyan
  let emissiveColor = '#00d4ff';
  if (data.status === 'degraded') { color = '#ffab00'; emissiveColor = '#ffab00'; }
  if (data.status === 'critical') { color = '#ff1744'; emissiveColor = '#ff1744'; }
  if (data.status === 'unknown') { color = '#64748b'; emissiveColor = '#475569'; }

  const cpuPercent = data.metrics ? ((data.metrics as any).cpu || 0) : 0;
  const memPercent = data.metrics ? ((data.metrics as any).memoryPercent || 0) : 0;
  const isCritical = data.status === 'critical';

  useFrame((state, delta) => {
    const time = state.clock.elapsedTime;
    if (meshRef.current) {
      // Floating animation
      meshRef.current.position.y = position[1] + Math.sin(time * 2 + position[0] * 0.5) * 0.25;
      meshRef.current.rotation.y += delta * 0.6;
    }
    if (outerRingRef.current) {
      outerRingRef.current.rotation.z -= delta * 1.2;
      outerRingRef.current.rotation.x = Math.sin(time * 1.5) * 0.2;
    }
    if (haloRef.current) {
      haloRef.current.rotation.y += delta * 0.4;
    }
  });

  const scale = isSelected ? 1.4 : (hovered ? 1.2 : 1.0);
  const isDatabase = data.type === 'database' || data.type === 'queue';
  const isGateway = data.type === 'gateway' || data.type === 'frontend';

  return (
    <group position={position} onClick={(e) => { e.stopPropagation(); onClick(); }} onPointerOver={() => setHover(true)} onPointerOut={() => setHover(false)}>
      {/* Outer Orbiting Halo Ring */}
      <mesh ref={outerRingRef} position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.2 * scale, 0.04, 16, 64]} />
        <meshBasicMaterial color={color} transparent opacity={isSelected || hovered ? 0.9 : 0.4} />
      </mesh>

      {/* Secondary Rotating Halo */}
      <mesh ref={haloRef} position={[0, 0, 0]}>
        <torusGeometry args={[2.6 * scale, 0.02, 12, 48]} />
        <meshBasicMaterial color="#e040fb" transparent opacity={isSelected ? 0.8 : 0.2} />
      </mesh>

      {/* Main 3D Node Core - Cyberpunk Floating Platforms */}
      <group ref={meshRef} scale={scale}>
        
        {/* Floating Base Platform */}
        <mesh position={[0, -0.6, 0]}>
          <cylinderGeometry args={[2.0, 2.2, 0.3, 16]} />
          <meshPhysicalMaterial color="#080c18" roughness={0.6} metalness={0.5} />
        </mesh>
        <mesh position={[0, -0.6, 0]}>
          <cylinderGeometry args={[2.05, 2.25, 0.32, 16]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={isSelected ? 0.6 : 0.2} />
        </mesh>

        {isDatabase ? (
          // Proxy / Database Stack
          <group position={[0, 0.6, 0]}>
            {[-0.6, 0, 0.6].map((y, i) => (
              <mesh key={i} position={[0, y, 0]}>
                <boxGeometry args={[1.6, 0.4, 1.4]} />
                <meshPhysicalMaterial color="#111827" roughness={0.2} metalness={0.8} transparent opacity={0.9} />
              </mesh>
            ))}
            {[-0.6, 0, 0.6].map((y, i) => (
              <mesh key={`glow-${i}`} position={[0, y, 0]}>
                <boxGeometry args={[1.65, 0.45, 1.45]} />
                <meshBasicMaterial color={color} wireframe transparent opacity={0.5} />
              </mesh>
            ))}
          </group>
        ) : isGateway ? (
          // Firewall / Shield
          <group position={[0, 0.8, 0]}>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[2.2, 1.8, 0.4]} />
              <meshPhysicalMaterial color="#111827" roughness={0.8} metalness={0.2} transparent opacity={0.9} />
            </mesh>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[2.25, 1.85, 0.45]} />
              <meshBasicMaterial color={emissiveColor} wireframe transparent opacity={0.8} />
            </mesh>
            <mesh position={[0, 0, 0.3]}>
              <sphereGeometry args={[0.4, 16, 16]} />
              <meshBasicMaterial color={emissiveColor} />
            </mesh>
          </group>
        ) : (
          // Service / AI Cloud Glass Cube
          <group position={[0, 0.8, 0]}>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[1.5, 1.5, 1.5]} />
              <meshPhysicalMaterial color="#000000" roughness={0.1} metalness={0.2} transmission={0.95} thickness={1.5} />
            </mesh>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[1.55, 1.55, 1.55]} />
              <meshBasicMaterial color={color} wireframe transparent opacity={0.4} />
            </mesh>
            {/* Glowing Core */}
            <mesh position={[0, 0, 0]}>
              <icosahedronGeometry args={[0.4, 1]} />
              <meshBasicMaterial color={emissiveColor} />
            </mesh>
          </group>
        )}
      </group>

      {/* Vertical Energy Beam for Critical / Selected Nodes */}
      {(isCritical || isSelected) && (
        <mesh position={[0, 3, 0]}>
          <cylinderGeometry args={[0.08, 0.4, 6, 16, 1, true]} />
          <meshBasicMaterial color={color} transparent opacity={0.4} side={2} />
        </mesh>
      )}

      {/* High-Tech Glass HUD Badge */}
      <Html 
        position={[0, 3.2, 0]} 
        center 
        style={{ pointerEvents: 'none', transition: 'all 0.25s ease' }}
      >
        <div style={{
          background: 'rgba(10, 13, 24, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: `1px solid ${isSelected ? color : 'rgba(255,255,255,0.12)'}`,
          borderLeft: `3px solid ${color}`,
          borderRadius: '4px',
          padding: '6px 12px',
          color: '#fff',
          fontFamily: 'Inter, sans-serif',
          fontSize: '11px',
          whiteSpace: 'nowrap',
          boxShadow: isSelected ? `0 0 20px ${color}60` : '0 4px 20px rgba(0,0,0,0.5)',
          transform: isSelected || hovered ? 'scale(1.1) translateY(-2px)' : 'scale(1)',
          opacity: isSelected || hovered ? 1 : 0.85,
          display: 'flex',
          flexDirection: 'column',
          gap: '3px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>{typeIcons[data.type as string] || typeIcons.unknown}</span>
            <span style={{ fontWeight: 700, letterSpacing: '0.5px', color: '#fff' }}>{data.name.toUpperCase()}</span>
            <span style={{ 
              fontSize: '8px', 
              padding: '1px 5px', 
              borderRadius: '3px', 
              background: 'rgba(255,255,255,0.08)',
              color: color,
              fontWeight: 700,
              textTransform: 'uppercase' 
            }}>
              {data.status}
            </span>
          </div>

          {data.metrics && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', fontSize: '9px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.7)' }}>
              <span>CPU: <strong style={{ color: '#00d4ff' }}>{cpuPercent.toFixed(1)}%</strong></span>
              <span>MEM: <strong style={{ color: '#e040fb' }}>{memPercent.toFixed(1)}%</strong></span>
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

