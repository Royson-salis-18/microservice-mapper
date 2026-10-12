import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { DependencyEdge } from '../../types';
import type { PositionMap } from './Scene3D';
import { edgeAppearance } from '../shared/edgeHeat';
import { typeColor } from '../shared/palette';

interface Edge3DProps {
  edge: { id: string; data: DependencyEdge };
  sourceId: string;
  targetId: string;
  live: PositionMap;
  /** Something else is selected: recede so the selection reads clearly. */
  dimmed?: boolean;
  /** Category of the calling service; its colour tints the link and its packets. */
  sourceType?: string;
}

// Links leave from just above the chassis tops (about y=4.3) so they never pass through equipment.
const NODE_HEIGHT = 4.4;
const MAX_PACKETS = 4;

export function Edge3D({ edge, sourceId, targetId, live, dimmed = false, sourceType }: Edge3DProps) {
  const coreRef = useRef<THREE.Mesh>(null);
  const packetsRef = useRef<THREE.Group>(null);
  const curveRef = useRef(
    new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3())
  );
  const lastFrom = useRef(new THREE.Vector3());
  const lastTo = useRef(new THREE.Vector3());
  const coreGeom = useRef<THREE.TubeGeometry | null>(null);
  const built = useRef(false);

  const data = edge.data;
  const isObserved = data?.observed ?? false;
  const appearance = useMemo(() => edgeAppearance(data), [data]);
  const heat = appearance.heat;
  const opacity = dimmed ? 0.08 : appearance.intensity;
  // Busier links are a little thicker and carry more, faster packets; colour stays for trouble.
  const radius = heat === 'idle' ? 0.04
    : heat === 'saturated' || heat === 'failed' ? 0.12
    : heat === 'heavy' || heat === 'degraded' ? 0.095
    : heat === 'busy' ? 0.075 : 0.06;
  const packets = !isObserved || heat === 'failed' ? 0
    : heat === 'saturated' ? 4 : heat === 'heavy' ? 3 : heat === 'busy' ? 2 : 1;
  const speed = heat === 'saturated' ? 0.42 : heat === 'heavy' ? 0.34 : 0.26;

  // Healthy observed links carry the caller's colour; failing/degraded keep their warning colour,
  // and declared-only links stay grey.
  const trouble = heat === 'failed' || heat === 'degraded';
  const lineColor = trouble || heat === 'idle' ? appearance.color
    : new THREE.Color(appearance.color).lerp(new THREE.Color(typeColor(sourceType)), 0.55).getStyle();
  const packetColor = trouble || heat === 'idle' ? appearance.glow : typeColor(sourceType);
  const coreMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: lineColor, transparent: true, opacity, depthWrite: opacity > 0.5 }),
    [lineColor, opacity]
  );

  useEffect(() => () => {
    coreGeom.current?.dispose();
    coreMat.dispose();
  }, [coreMat]);

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
      mid.y += Math.min(2 + v1.distanceTo(v2) * 0.12, 10);
      curveRef.current = new THREE.QuadraticBezierCurve3(v1, mid, v2);

      const nextCore = new THREE.TubeGeometry(curveRef.current, 40, radius, 8, false);
      const staleCore = coreGeom.current;
      coreGeom.current = nextCore;
      coreRef.current.geometry = nextCore;
      staleCore?.dispose();

    }

    if (packets > 0 && !dimmed && packetsRef.current) {
      const t = state.clock.elapsedTime * speed;
      packetsRef.current.children.forEach((child, i) => {
        const u = (t + i / packets) % 1;
        child.position.copy(curveRef.current.getPointAt(u));
        // Emerge and arrive rather than popping into existence mid-air.
        const fade = Math.sin(u * Math.PI);
        child.scale.setScalar(0.6 + fade * 0.4);
        ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = fade * 0.95;
      });
    }
  });

  return (
    <group>
      <mesh ref={coreRef} material={coreMat} />
      {packets > 0 && !dimmed && (
        <group ref={packetsRef}>
          {Array.from({ length: Math.min(packets, MAX_PACKETS) }).map((_, i) => (
            <mesh key={i}>
              <sphereGeometry args={[radius * 1.9 + 0.05, 12, 12]} />
              <meshBasicMaterial color={packetColor} transparent opacity={0.9} depthWrite={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}
