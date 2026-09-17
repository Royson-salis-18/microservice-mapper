import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { DependencyEdge } from '../../types';
import type { PositionMap } from './Scene3D';
import { edgeAppearance } from '../shared/edgeHeat';

interface Edge3DProps {
  edge: { id: string; data: DependencyEdge };
  sourceId: string;
  targetId: string;
  live: PositionMap;
  /** Something else is selected: recede so the selection reads clearly. */
  dimmed?: boolean;
}

const PACKET_COUNT = 5;
// Chassis tops sit around y=4.3, so links leave from above the hardware.
// Attaching at mid-chassis (2.1) buried them: a link would enter one unit,
// pass through its body and come out the far side, so most live links were
// hidden behind equipment in 3D while the same links were plainly visible
// in the 2D canvas, which always draws edges on top.
const NODE_HEIGHT = 4.6;

export function Edge3D({ edge, sourceId, targetId, live, dimmed = false }: Edge3DProps) {
  const coreRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const packetsRef = useRef<THREE.Group>(null);
  const curveRef = useRef(
    new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3())
  );
  const lastFrom = useRef(new THREE.Vector3());
  const lastTo = useRef(new THREE.Vector3());
  const coreGeom = useRef<THREE.TubeGeometry | null>(null);
  const glowGeom = useRef<THREE.TubeGeometry | null>(null);
  const built = useRef(false);

  const data = edge.data;
  const isObserved = data?.observed ?? false;
  const appearance = useMemo(() => edgeAppearance(data), [data]);
  const core = appearance.color;
  const glow = appearance.glow;
  const intensity = dimmed ? appearance.intensity * 0.12 : appearance.intensity;
  // Hotter links are physically thicker, so heat reads even in monochrome
  // or at a distance where hue is hard to judge.
  const radius = !data?.observed ? 0.08
    : appearance.heat === 'saturated' ? 0.2
    : appearance.heat === 'heavy' || appearance.heat === 'degraded' ? 0.17
    : appearance.heat === 'busy' ? 0.15
    : appearance.heat === 'failed' ? 0.2
    : 0.13;

  const coreMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: core, toneMapped: false, transparent: true, opacity: intensity }),
    [core, intensity]
  );
  // A wider, additive sheath around the core is what reads as a glowing
  // conduit rather than a wireframe line.
  const glowMat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: glow,
      toneMapped: false,
      transparent: true,
      opacity: intensity * 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    }),
    [glow, intensity]
  );

  useEffect(() => () => {
    coreGeom.current?.dispose();
    glowGeom.current?.dispose();
    coreMat.dispose();
    glowMat.dispose();
  }, [coreMat, glowMat]);

  useFrame((state) => {
    const from = live.get(sourceId);
    const to = live.get(targetId);
    if (!from || !to || !coreRef.current) return;

    // Rebuild only when an endpoint actually moved. During a layout
    // transition that's every frame; once settled it costs nothing.
    const moved =
      !built.current ||
      from.distanceToSquared(lastFrom.current) > 0.0004 ||
      to.distanceToSquared(lastTo.current) > 0.0004;

    if (moved) {
      built.current = true;
      lastFrom.current.copy(from);
      lastTo.current.copy(to);

      const v1 = new THREE.Vector3(from.x, from.y + NODE_HEIGHT, from.z);
      const v2 = new THREE.Vector3(to.x, to.y + NODE_HEIGHT, to.z);
      if (v1.distanceTo(v2) < 0.01) v2.x += 0.01; // TubeGeometry dies on zero-length curves

      const mid = v1.clone().lerp(v2, 0.5);
      // Enough lift to clear the units it passes over, capped so long links
      // across a big layout don't become tall loops.
      mid.y += Math.min(3 + v1.distanceTo(v2) * 0.16, 14);
      curveRef.current = new THREE.QuadraticBezierCurve3(v1, mid, v2);

      const nextCore = new THREE.TubeGeometry(curveRef.current, 26, radius, 6, false);
      const staleCore = coreGeom.current;
      coreGeom.current = nextCore;
      coreRef.current.geometry = nextCore;
      staleCore?.dispose();

      if (glowRef.current) {
        const nextGlow = new THREE.TubeGeometry(curveRef.current, 26, radius * 3.4, 6, false);
        const staleGlow = glowGeom.current;
        glowGeom.current = nextGlow;
        glowRef.current.geometry = nextGlow;
        staleGlow?.dispose();
      }
    }

    if (isObserved && !dimmed && packetsRef.current) {
      const t = state.clock.elapsedTime * 0.5;
      packetsRef.current.children.forEach((child, i) => {
        const u = (t + i / PACKET_COUNT) % 1;
        child.position.copy(curveRef.current.getPointAt(u));
        // Fade in and out at the ends so pulses emerge and arrive rather
        // than popping into existence mid-air.
        const fade = Math.sin(u * Math.PI);
        child.scale.setScalar(0.5 + fade * 0.85);
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = 0.25 + fade * 0.75;
      });
    }
  });

  return (
    <group>
      <mesh ref={glowRef} material={glowMat} />
      <mesh ref={coreRef} material={coreMat} />
      {isObserved && !dimmed && (
        <group ref={packetsRef}>
          {Array.from({ length: PACKET_COUNT }).map((_, i) => (
            <mesh key={i}>
              <sphereGeometry args={[0.26, 10, 10]} />
              <meshBasicMaterial color={glow} toneMapped={false} transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}
