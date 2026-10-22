import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { DependencyEdge } from '../../types';
import type { PositionMap } from './Scene3D';
import { edgeAppearance } from '../shared/edgeHeat';
import { UNIT_TOP } from './Node3D';
import { linkFlow } from '../shared/linkFlow';

/**
 * How a link travels between two services.
 *   conduit  up out of the caller, along overhead trays at right angles, and
 *            down into the callee - the way cable runs in a real hall. Links
 *            that share a corridor bundle together instead of crossing at
 *            random angles, which is what keeps a busy hall legible.
 *   arc      a single raised curve straight across.
 */
export type LinkRouting = 'conduit' | 'arc';

interface Edge3DProps {
  edge: { id: string; data: DependencyEdge };
  sourceId: string;
  targetId: string;
  live: PositionMap;
  routing: LinkRouting;
  /** Status of the service being called: a link into a down service reads
   *  as failing when no request data covers it. */
  targetStatus?: string;
  /** Something else is selected: recede so the selection reads clearly. */
  dimmed?: boolean;
}

// Links leave from the top of the hardware. Attaching mid-chassis buried a
// link inside the unit it left from.
const NODE_HEIGHT = UNIT_TOP;

/** Shared by every packet and arrowhead on every link. */
const PACKET_GEOMETRY = new THREE.CapsuleGeometry(0.13, 0.6, 3, 8);
const ARROW_GEOMETRY = new THREE.ConeGeometry(0.36, 0.95, 12);
const UP = new THREE.Vector3(0, 1, 0);
/** Travel speed a pulse aims for, in world units per second. The actual
 *  speed is adjusted a little so the arrival rate is exact. */
const PACKET_SPEED = 9;
/** Most pulses on one link at once; past this they travel faster instead. */
const PACKET_POOL = 12;

/** Stable small integer from the link id: picks a tray height and turn order,
 *  so links that would share a corridor separate instead of z-fighting. */
function hashOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A polyline with each interior corner replaced by a short bend. */
function roundedPath(points: THREE.Vector3[], radius: number): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  let cursor = points[0].clone();
  for (let i = 1; i < points.length - 1; i++) {
    const corner = points[i];
    const inDir = corner.clone().sub(points[i - 1]);
    const outDir = points[i + 1].clone().sub(corner);
    const r = Math.min(radius, inDir.length() * 0.45, outDir.length() * 0.45);
    const start = corner.clone().addScaledVector(inDir.normalize(), -r);
    const end = corner.clone().addScaledVector(outDir.normalize(), r);
    if (cursor.distanceToSquared(start) > 1e-6) path.add(new THREE.LineCurve3(cursor, start));
    path.add(new THREE.QuadraticBezierCurve3(start, corner.clone(), end));
    cursor = end;
  }
  const last = points[points.length - 1];
  if (cursor.distanceToSquared(last) > 1e-6) path.add(new THREE.LineCurve3(cursor, last.clone()));
  return path;
}

function buildCurve(from: THREE.Vector3, to: THREE.Vector3, routing: LinkRouting, hash: number): THREE.Curve<THREE.Vector3> {
  const a = new THREE.Vector3(from.x, from.y + NODE_HEIGHT, from.z);
  const b = new THREE.Vector3(to.x, to.y + NODE_HEIGHT, to.z);
  if (a.distanceTo(b) < 0.01) b.x += 0.01; // TubeGeometry dies on zero-length curves

  if (routing === 'arc') {
    const mid = a.clone().lerp(b, 0.5);
    // Enough lift to clear the units it passes over, capped so long links
    // across a big layout don't become tall loops.
    mid.y += Math.min(3 + a.distanceTo(b) * 0.16, 14);
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  }

  const tray = Math.max(a.y, b.y) + 1.8 + (hash % 5) * 0.5;
  // Every cable turns the same way (along x, then z), so cables between the
  // same two places share one run and bundle like a real tray instead of
  // splitting into rectangles. Their tray heights still differ by link.
  const xFirst = true;
  const raw = [
    a,
    new THREE.Vector3(a.x, tray, a.z),
    xFirst ? new THREE.Vector3(b.x, tray, a.z) : new THREE.Vector3(a.x, tray, b.z),
    new THREE.Vector3(b.x, tray, b.z),
    b,
  ];
  const points = raw.filter((p, i) => i === 0 || p.distanceToSquared(raw[i - 1]) > 1e-4);
  return roundedPath(points, 1.4);
}

/**
 * How a link looks, from what is measured about it.
 *
 * Two channels, matching the 2D canvas:
 *   colour     the shared heat scale: blue through near-white for volume,
 *              amber and red only for a link that is actually in trouble
 *   thickness  the dependency weight: how much the caller relies on it
 *
 * Telemetry links (exporting to a collector, being scraped by a monitoring
 * system) are drawn thin and faint with no packets: on the OTel demo they are
 * the majority of all links and drowned out the dependencies that actually
 * carry the application.
 */
function edgeLook(data: DependencyEdge | undefined, dimmed: boolean, targetStatus?: string) {
  const appearance = edgeAppearance(data, { targetStatus });
  const observed = data?.observed ?? false;
  const telemetry = data?.weight?.kind === 'telemetry';
  const w = data?.weight?.value;

  let radius: number;
  if (telemetry) radius = 0.04;
  // Bucketed to tenths: weights drift a little with every traffic reading,
  // and a raw radius would rebuild the tube geometry on nearly every push.
  else if (typeof w === 'number') radius = 0.04 + 0.085 * Math.round(Math.min(Math.max(w, 0), 1) * 10) / 10;
  else radius = !observed ? 0.05
    : appearance.heat === 'saturated' || appearance.heat === 'failed' ? 0.15
    : appearance.heat === 'heavy' || appearance.heat === 'degraded' ? 0.12
    : appearance.heat === 'busy' ? 0.1
    : 0.08;

  const baseIntensity = telemetry ? appearance.intensity * 0.35 : appearance.intensity;
  const intensity = dimmed ? baseIntensity * 0.12 : baseIntensity;
  // Pulses show traffic flowing caller -> callee, arriving at a rate set by
  // the link's own rate: requests per second where measured, socket activity
  // otherwise (see linkFlow). Rounded to tenths so a small wobble in the
  // rate does not re-render the link.
  const flow = linkFlow(data);
  const pulses = !observed || telemetry || dimmed || !flow ? 0 : Math.round(flow.pulses * 10) / 10;

  return {
    core: appearance.color,
    glow: appearance.glow,
    intensity: Math.round(intensity * 100) / 100,
    radius: Math.round(radius * 1000) / 1000,
    pulses,
    observed,
    // An arrowhead on every link that is not faded out, so direction reads
    // even where nothing is moving.
    arrow: !dimmed && !telemetry,
  };
}

function Edge3DInner({ edge, sourceId, targetId, live, routing, targetStatus, dimmed = false }: Edge3DProps) {
  const coreRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const arrowRef = useRef<THREE.Mesh>(null);
  const packetsRef = useRef<THREE.InstancedMesh>(null);
  /** Where the pulse train is along the link, 0..1, advanced every frame. */
  const phase = useRef(0);
  const pulseMatrix = useRef({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3() }).current;
  const curveRef = useRef<THREE.Curve<THREE.Vector3>>(
    new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3())
  );
  const lengthRef = useRef(1);
  const lastFrom = useRef(new THREE.Vector3());
  const lastTo = useRef(new THREE.Vector3());
  const coreGeom = useRef<THREE.TubeGeometry | null>(null);
  const glowGeom = useRef<THREE.TubeGeometry | null>(null);
  const built = useRef<{ radius: number; routing: LinkRouting; arrow: boolean } | null>(null);
  const scratch = useRef({ p: new THREE.Vector3(), t: new THREE.Vector3() }).current;
  const hash = useMemo(() => hashOf(edge.id), [edge.id]);

  const look = edgeLook(edge.data, dimmed, targetStatus);
  const { core, glow, intensity, radius, pulses, arrow } = look;

  const coreMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: core, toneMapped: false, transparent: true, opacity: Math.min(1, intensity) }),
    [core, intensity]
  );
  // A wider, additive sheath around the core is what reads as a lit conduit
  // rather than a wireframe line.
  const glowMat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: glow,
      toneMapped: false,
      transparent: true,
      // Visible without bloom: at 0.08 the sheath all but vanished and links
      // read as dull wires on the dark ground.
      opacity: intensity * 0.14,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    }),
    [glow, intensity]
  );
  const packetMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: glow, toneMapped: false, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
    [glow]
  );

  // Materials are replaced when their colour or intensity changes, so each is
  // disposed when superseded; the tube geometries only on unmount.
  useEffect(() => () => coreMat.dispose(), [coreMat]);
  useEffect(() => () => glowMat.dispose(), [glowMat]);
  useEffect(() => () => packetMat.dispose(), [packetMat]);
  useEffect(() => () => {
    coreGeom.current?.dispose();
    glowGeom.current?.dispose();
  }, []);

  useFrame((_, delta) => {
    const from = live.get(sourceId);
    const to = live.get(targetId);
    if (!from || !to || !coreRef.current) return;

    // Rebuild when an endpoint moved (every frame during a layout transition,
    // never once settled), or the thickness or routing changed, or the
    // arrowhead just mounted and has not been placed yet.
    const stale =
      built.current === null ||
      built.current.radius !== radius ||
      built.current.routing !== routing ||
      built.current.arrow !== arrow ||
      from.distanceToSquared(lastFrom.current) > 0.0004 ||
      to.distanceToSquared(lastTo.current) > 0.0004;

    if (stale) {
      built.current = { radius, routing, arrow };
      lastFrom.current.copy(from);
      lastTo.current.copy(to);

      const curve = buildCurve(from, to, routing, hash);
      curveRef.current = curve;
      lengthRef.current = Math.max(curve.getLength(), 0.01);
      const segments = routing === 'conduit' ? 72 : 28;

      const nextCore = new THREE.TubeGeometry(curve, segments, radius, 6, false);
      const staleCore = coreGeom.current;
      coreGeom.current = nextCore;
      coreRef.current.geometry = nextCore;
      staleCore?.dispose();

      if (glowRef.current) {
        const nextGlow = new THREE.TubeGeometry(curve, segments, radius * 2.1, 6, false);
        const staleGlow = glowGeom.current;
        glowGeom.current = nextGlow;
        glowRef.current.geometry = nextGlow;
        staleGlow?.dispose();
      }

      if (arrowRef.current) {
        // Tip lands on the callee; the cone's centre sits half its height back.
        const back = Math.min(0.5, 0.55 / lengthRef.current);
        curve.getPointAt(1 - back, scratch.p);
        curve.getTangentAt(1 - back, scratch.t);
        arrowRef.current.position.copy(scratch.p);
        arrowRef.current.quaternion.setFromUnitVectors(UP, scratch.t.normalize());
        arrowRef.current.scale.setScalar(0.75 + radius * 2.5);
      }
    }

    const mesh = packetsRef.current;
    if (pulses > 0 && mesh) {
      // `pulses` arrive per second. With k evenly spaced pulses on a link of
      // length L moving at speed v, arrivals per second are k·v/L, so pick k
      // for a speed near PACKET_SPEED and then set v to make it exact.
      const curve = curveRef.current;
      const L = lengthRef.current;
      const k = Math.min(PACKET_POOL, Math.max(1, Math.round((pulses * L) / PACKET_SPEED)));
      const v = (pulses * L) / k;
      phase.current = (phase.current + (delta * v) / L) % 1;
      mesh.count = k;
      for (let i = 0; i < k; i++) {
        const u = (phase.current + i / k) % 1;
        curve.getPointAt(u, scratch.p);
        curve.getTangentAt(u, scratch.t);
        pulseMatrix.q.setFromUnitVectors(UP, scratch.t.normalize());
        // Grow in and shrink out at the ends, so pulses emerge and arrive
        // rather than popping into existence.
        pulseMatrix.s.setScalar(0.35 + Math.sin(u * Math.PI) * 0.9);
        mesh.setMatrixAt(i, pulseMatrix.m.compose(scratch.p, pulseMatrix.q, pulseMatrix.s));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      <mesh ref={glowRef} material={glowMat} raycast={() => null} />
      <mesh ref={coreRef} material={coreMat} raycast={() => null} />
      {arrow && <mesh ref={arrowRef} geometry={ARROW_GEOMETRY} material={coreMat} raycast={() => null} />}
      {/* One instanced pool per link: however many pulses are on it, one
          draw call. Culling is off because the pulses move every frame and
          the pool's bounds are never recomputed. */}
      {pulses > 0 && (
        <instancedMesh ref={packetsRef} args={[PACKET_GEOMETRY, packetMat, PACKET_POOL]} frustumCulled={false} raycast={() => null} />
      )}
    </group>
  );
}

/**
 * Re-render only when the link's look changes (colour band, thickness, pulse
 * rate to a tenth, dimming, routing), not on every push. The activity rate behind the
 * colour moves on nearly every update, but it only changes what is drawn when
 * it crosses into a different band.
 */
function sameEdge(a: Edge3DProps, b: Edge3DProps): boolean {
  if (a.edge.id !== b.edge.id || a.sourceId !== b.sourceId || a.targetId !== b.targetId) return false;
  if (a.live !== b.live || a.dimmed !== b.dimmed || a.routing !== b.routing) return false;
  const la = edgeLook(a.edge.data, !!a.dimmed, a.targetStatus);
  const lb = edgeLook(b.edge.data, !!b.dimmed, b.targetStatus);
  return la.core === lb.core && la.glow === lb.glow && la.intensity === lb.intensity
    && la.radius === lb.radius && la.pulses === lb.pulses && la.observed === lb.observed && la.arrow === lb.arrow;
}

export const Edge3D = memo(Edge3DInner, sameEdge);
