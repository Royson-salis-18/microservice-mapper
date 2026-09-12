import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { DependencyEdge } from '../../types';

interface Edge3DProps {
  edge: { id: string; data: DependencyEdge };
  startPos: [number, number, number];
  endPos: [number, number, number];
}

export function Edge3D({ edge, startPos, endPos }: Edge3DProps) {
  // References for our moving data packets
  const packetsRef = useRef<THREE.Group>(null);
  
  const edgeData = edge.data;
  const isObserved = edgeData?.observed ?? false;
  const isCritical = edgeData?.status === 'failed' || (edgeData?.metrics?.errorRate ?? 0) > 5;
  const isDegraded = edgeData?.status === 'degraded';

  const color = isCritical ? '#ff1744' : isDegraded ? '#ffab00' : isObserved ? '#00d4ff' : '#2b3b5c';
  const packetCount = 4; // Number of packets flying along the edge

  // Create a 3D Bezier curve
  const curve = useMemo(() => {
    const v1 = new THREE.Vector3(...startPos);
    const v2 = new THREE.Vector3(...endPos);
    if (v1.distanceTo(v2) < 0.01) {
      // Offset slightly to prevent TubeGeometry crash on 0-length curves
      v2.x += 0.01;
    }
    const dist = v1.distanceTo(v2);
    const mid = v1.clone().lerp(v2, 0.5);
    mid.y += Math.min(dist * 0.2, 5); 
    return new THREE.QuadraticBezierCurve3(v1, mid, v2);
  }, [startPos, endPos]);

  // Midpoint for the label
  const midPoint = useMemo(() => curve.getPointAt(0.5), [curve]);

  // Thin wire geometry for the path
  const tubeGeometry = useMemo(() => {
    return new THREE.TubeGeometry(curve, 32, 0.02, 4, false);
  }, [curve]);

  useFrame((state) => {
    if (isObserved && packetsRef.current) {
      // Rapid animation speed for data flow
      const time = state.clock.elapsedTime * 1.5;
      
      packetsRef.current.children.forEach((child, i) => {
        // Offset each packet along the curve
        const t = (time + i / packetCount) % 1;
        child.position.copy(curve.getPointAt(t));
        // Small rotation for effect
        child.rotation.x = time * 2;
        child.rotation.y = time * 2;
      });
    }
  });

  return (
    <group>
      {/* Faint static connection wire */}
      <mesh geometry={tubeGeometry}>
        <meshBasicMaterial 
          color={color} 
          toneMapped={false}
          transparent 
          opacity={isObserved ? 0.3 : 0.1}
        />
      </mesh>
      
      {/* Moving Data Packets (Glowing Cubes) */}
      {isObserved && (
        <group ref={packetsRef}>
          {Array.from({ length: packetCount }).map((_, i) => (
            <mesh key={i}>
              <boxGeometry args={[0.2, 0.2, 0.2]} />
              <meshBasicMaterial color={color} toneMapped={false} />
            </mesh>
          ))}
        </group>
      )}

      {/* Network Traffic Label */}
      {isObserved && edgeData?.metrics && (edgeData.metrics.requestRate !== undefined && edgeData.metrics.requestRate !== null) && (
        <Html position={midPoint} center distanceFactor={15}>
          <div style={{
            background: 'rgba(5, 8, 15, 0.8)',
            border: `1px solid ${color}`,
            padding: '2px 6px',
            borderRadius: '4px',
            color: '#fff',
            fontSize: '9px',
            whiteSpace: 'nowrap',
            fontFamily: 'monospace',
            textShadow: '0 0 4px rgba(255,255,255,0.5)',
            boxShadow: `0 0 8px ${color}40`,
            pointerEvents: 'none',
            display: 'flex',
            gap: '6px'
          }}>
            <span style={{ color: '#00d4ff' }}>{edgeData.metrics.requestRate.toFixed(1)} req/s</span>
            {(edgeData.metrics.errorRate && edgeData.metrics.errorRate > 0) ? (
              <span style={{ color: '#ff1744' }}>{edgeData.metrics.errorRate.toFixed(1)} err/s</span>
            ) : null}
            {edgeData.metrics.latency ? (
              <span style={{ color: '#e040fb' }}>{edgeData.metrics.latency.toFixed(0)}ms</span>
            ) : null}
          </div>
        </Html>
      )}
    </group>
  );
}
