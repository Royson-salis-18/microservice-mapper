import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export type EnvPreset = 'cyber' | 'studio' | 'holo';

interface AmbientParticlesProps {
  preset: EnvPreset;
}

/**
 * Ambient floating data particles that give palpable atmospheric depth
 * to the 3D scene. Single draw-call with vertex colors for rich multicolor embers.
 */
export function AmbientParticles({ preset }: AmbientParticlesProps) {
  const pointsRef = useRef<THREE.Points>(null);

  const count = preset === 'holo' ? 360 : preset === 'cyber' ? 260 : 100;

  const [positions, colors, speeds] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const spd = new Float32Array(count * 3);

    const c = new THREE.Color();
    const holoPalette = ['#c084fc', '#e879f9', '#22d3ee', '#f43f5e'];
    const cyberPalette = ['#00f0ff', '#38bdf8', '#7dd3fc', '#a5f3fc', '#818cf8'];
    const studioPalette = ['#94a3b8', '#cbd5e1', '#e2e8f0'];

    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 440;
      pos[i * 3 + 1] = Math.random() * 52 + 1;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 440;

      spd[i * 3] = (Math.random() - 0.5) * 0.06;
      spd[i * 3 + 1] = Math.random() * (preset === 'holo' ? 0.055 : 0.035) + 0.015;
      spd[i * 3 + 2] = (Math.random() - 0.5) * 0.06;

      const pal = preset === 'holo' ? holoPalette : preset === 'studio' ? studioPalette : cyberPalette;
      c.set(pal[i % pal.length]);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    return [pos, col, spd];
  }, [count, preset]);

  useFrame(() => {
    if (!pointsRef.current) return;
    const geo = pointsRef.current.geometry;
    const posAttr = geo.attributes.position;
    const arr = posAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      arr[i * 3] += speeds[i * 3];
      arr[i * 3 + 1] += speeds[i * 3 + 1];
      arr[i * 3 + 2] += speeds[i * 3 + 2];

      if (arr[i * 3 + 1] > 54) arr[i * 3 + 1] = 1;
      if (arr[i * 3] > 220) arr[i * 3] = -220;
      if (arr[i * 3] < -220) arr[i * 3] = 220;
      if (arr[i * 3 + 2] > 220) arr[i * 3 + 2] = -220;
      if (arr[i * 3 + 2] < -220) arr[i * 3 + 2] = 220;
    }
    posAttr.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={preset === 'holo' ? 1.8 : preset === 'cyber' ? 1.5 : 1.0}
        vertexColors
        transparent
        opacity={preset === 'holo' ? 0.65 : preset === 'cyber' ? 0.55 : 0.25}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        sizeAttenuation
      />
    </points>
  );
}
