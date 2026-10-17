import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export type EnvPreset = 'cyber' | 'studio' | 'holo';

interface AmbientParticlesProps {
  preset: EnvPreset;
}

/**
 * Ambient floating data particles that give palpable atmospheric depth
 * to the 3D scene. Single draw-call with buffer geometry for maximum 60fps performance.
 */
export function AmbientParticles({ preset }: AmbientParticlesProps) {
  const pointsRef = useRef<THREE.Points>(null);

  const count = preset === 'holo' ? 240 : 160;
  const color = preset === 'holo' ? '#c084fc' : '#38bdf8';

  const [positions, speeds] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const spd = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 400;
      pos[i * 3 + 1] = Math.random() * 45 + 1;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 400;

      spd[i * 3] = (Math.random() - 0.5) * 0.05;
      spd[i * 3 + 1] = Math.random() * 0.035 + 0.012; // gentle upward drift
      spd[i * 3 + 2] = (Math.random() - 0.5) * 0.05;
    }
    return [pos, spd];
  }, [count]);

  useFrame(() => {
    if (!pointsRef.current || preset === 'studio') return;
    const geo = pointsRef.current.geometry;
    const posAttr = geo.attributes.position;
    const arr = posAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      arr[i * 3] += speeds[i * 3];
      arr[i * 3 + 1] += speeds[i * 3 + 1];
      arr[i * 3 + 2] += speeds[i * 3 + 2];

      if (arr[i * 3 + 1] > 48) arr[i * 3 + 1] = 1;
      if (arr[i * 3] > 200) arr[i * 3] = -200;
      if (arr[i * 3] < -200) arr[i * 3] = 200;
      if (arr[i * 3 + 2] > 200) arr[i * 3 + 2] = -200;
      if (arr[i * 3 + 2] < -200) arr[i * 3 + 2] = 200;
    }
    posAttr.needsUpdate = true;
  });

  if (preset === 'studio') return null;

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={preset === 'holo' ? 1.8 : 1.4}
        color={color}
        transparent
        opacity={preset === 'holo' ? 0.45 : 0.35}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        sizeAttenuation
      />
    </points>
  );
}
