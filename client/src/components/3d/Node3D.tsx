import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';

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
  
  // Base colors: Green for databases/queues, Light Blue for everything else
  let baseColor = '#00d4ff'; // Light Blue / Neon Cyan
  
  if (data.type === 'database' || data.type === 'queue') {
    baseColor = '#00e676'; // Neon Green
  }
  
  const nodeIdentityColor = baseColor;
  
  // Status color dictates the outer rings, beams, and HUD badges
  let statusColor = '#00e676'; // healthy
  if (data.status === 'degraded') statusColor = '#ffab00'; 
  if (data.status === 'critical') statusColor = '#ff1744'; 
  if (data.status === 'unknown') statusColor = '#64748b';  

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
      {/* Outer Orbiting Halo Ring shows STATUS */}
      <mesh ref={outerRingRef} position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.2 * scale, 0.04, 16, 64]} />
        <meshBasicMaterial color={statusColor} toneMapped={false} transparent opacity={isSelected || hovered ? 1.0 : 0.8} />
      </mesh>

      {/* Secondary Rotating Halo shows NODE IDENTITY */}
      <mesh ref={haloRef} position={[0, 0, 0]}>
        <torusGeometry args={[2.6 * scale, 0.02, 12, 48]} />
        <meshBasicMaterial color={nodeIdentityColor} toneMapped={false} transparent opacity={isSelected ? 1.0 : 0.5} />
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
          <meshBasicMaterial color={nodeIdentityColor} toneMapped={false} wireframe transparent opacity={isSelected ? 0.9 : 0.4} />
        </mesh>

        {isDatabase ? (
          // Proxy / Database Stack
          <group position={[0, 0.6, 0]}>
            {[-0.6, 0, 0.6].map((y, i) => (
              <mesh key={i} position={[0, y, 0]}>
                <boxGeometry args={[1.6, 0.4, 1.4]} />
                <meshPhysicalMaterial color="#0b1020" roughness={0.1} metalness={0.9} transparent opacity={0.95} />
              </mesh>
            ))}
            {[-0.6, 0, 0.6].map((y, i) => (
              <mesh key={`glow-${i}`} position={[0, y, 0]}>
                <boxGeometry args={[1.65, 0.45, 1.45]} />
                <meshBasicMaterial color={nodeIdentityColor} toneMapped={false} wireframe transparent opacity={0.8} />
              </mesh>
            ))}
          </group>
        ) : isGateway ? (
          // Firewall / Shield
          <group position={[0, 0.8, 0]}>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[2.2, 1.8, 0.4]} />
              <meshPhysicalMaterial color="#0b1020" roughness={0.8} metalness={0.2} transparent opacity={0.95} />
            </mesh>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[2.25, 1.85, 0.45]} />
              <meshBasicMaterial color={nodeIdentityColor} toneMapped={false} wireframe transparent opacity={0.9} />
            </mesh>
            <mesh position={[0, 0, 0.3]}>
              <sphereGeometry args={[0.4, 16, 16]} />
              <meshBasicMaterial color={nodeIdentityColor} toneMapped={false} />
            </mesh>
          </group>
        ) : (
          // Service / AI Cloud Glass Cube
          <group position={[0, 0.8, 0]}>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[1.5, 1.5, 1.5]} />
              <meshPhysicalMaterial color="#000000" roughness={0.0} metalness={0.1} transmission={0.98} thickness={2.0} />
            </mesh>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[1.55, 1.55, 1.55]} />
              <meshBasicMaterial color={nodeIdentityColor} toneMapped={false} wireframe transparent opacity={0.7} />
            </mesh>
            {/* Glowing Core */}
            <mesh position={[0, 0, 0]}>
              <icosahedronGeometry args={[0.4, 1]} />
              <meshBasicMaterial color={nodeIdentityColor} toneMapped={false} />
            </mesh>
          </group>
        )}
      </group>

      {/* Vertical Energy Beam for Critical / Selected Nodes */}
      {(isCritical || isSelected) && (
        <mesh position={[0, 3, 0]}>
          <cylinderGeometry args={[0.08, 0.4, 6, 16, 1, true]} />
          <meshBasicMaterial color={statusColor} transparent opacity={0.4} side={2} />
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
          border: `1px solid ${isSelected ? statusColor : 'rgba(255,255,255,0.12)'}`,
          borderLeft: `3px solid ${statusColor}`,
          borderRadius: '4px',
          padding: '6px 12px',
          color: '#fff',
          fontFamily: 'Inter, sans-serif',
          fontSize: '11px',
          whiteSpace: 'nowrap',
          boxShadow: isSelected ? `0 0 20px ${statusColor}60` : '0 4px 20px rgba(0,0,0,0.5)',
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
              color: statusColor,
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

