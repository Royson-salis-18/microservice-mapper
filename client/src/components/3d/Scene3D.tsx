import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera, OrbitControls, Grid, Billboard, Text, ContactShadows, Environment, Lightformer } from '@react-three/drei';
import type { Node, Edge } from '@xyflow/react';
import * as THREE from 'three';
import { Node3D, TYPE_STYLE, type NodeShape } from './Node3D';
import { Edge3D } from './Edge3D';
import { LAYOUTS, computeLayout, type LayoutId, type LayoutNode, type Positions } from './layouts';

interface Scene3DProps {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  onNodeClick: (id: string) => void;
  onPaneClick: () => void;
}

// Module-level so the array keeps its identity: an inline literal is a new prop on every
// telemetry re-render, and R3F would snap the camera back here each time, undoing the fit.
const CAMERA_START: [number, number, number] = [0, 60, 110];

/** Live, mutable positions shared by nodes, edges and the camera fitter. */
export type PositionMap = Map<string, THREE.Vector3>;

/**
 * Eases every node toward the position its layout wants, writing into a
 * shared mutable map.
 *
 * Deliberately not React state: driving setState from useFrame re-renders
 * the scene every frame, which rebuilds the layout, which restarts the
 * animation — a loop that starves the render loop badly enough that
 * nothing inside the Canvas ever draws.
 */
function LayoutDriver({ target, live }: { target: Positions; live: PositionMap }) {
  useFrame((_, delta) => {
    for (const [id, to] of Object.entries(target)) {
      let current = live.get(id);
      if (!current) {
        current = new THREE.Vector3(to[0], to[1], to[2]);
        live.set(id, current);
        continue;
      }
      current.x = THREE.MathUtils.damp(current.x, to[0], 3.2, delta);
      current.y = THREE.MathUtils.damp(current.y, to[1], 3.2, delta);
      current.z = THREE.MathUtils.damp(current.z, to[2], 3.2, delta);
    }
    // Drop nodes that no longer exist so the map can't grow forever.
    if (live.size > Object.keys(target).length) {
      for (const id of live.keys()) if (!(id in target)) live.delete(id);
    }
  });
  return null;
}

/**
 * Frames whatever the current layout produced. Each arrangement has a very
 * different footprint — a helix is tall and narrow, a ring of 45 services is
 * huge and flat — so one fixed camera either buries the scene or leaves it a
 * speck. Refits when the layout or node count changes, never on a metric
 * tick, so it doesn't fight the user's own orbiting.
 */
function FitCamera({ target, trigger }: { target: Positions; trigger: string }) {
  const { camera, controls, scene } = useThree() as any;
  const lastTrigger = useRef<string>('');

  useFrame(() => {
    // The camera and controls are part of the key: on first mount this can run against R3F's
    // built-in camera before <PerspectiveCamera makeDefault> takes over, and the fit was lost.
    const key = `${trigger}:${camera.uuid}:${controls ? 1 : 0}`;
    if (lastTrigger.current === key) return;
    const entries = Object.values(target);
    if (entries.length === 0) return;
    lastTrigger.current = key;

    const box = new THREE.Box3();
    for (const [x, y, z] of entries) box.expandByPoint(new THREE.Vector3(x, y, z));
    const raw = box.getSize(new THREE.Vector3());
    box.expandByScalar(9); // node height and floating labels

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect || 1;

    // Width and height are fitted separately: judging by one "max dimension"
    // against the vertical FOV lets a wide flat ring run off both sides.
    const fitHeight = size.y + size.z * 0.6; // the camera looks down, so depth eats vertical space
    const distForHeight = fitHeight / (2 * Math.tan(fov / 2));
    const distForWidth = size.x / (2 * Math.tan(fov / 2) * aspect);
    const distance = Math.max(distForHeight, distForWidth, 26) * 0.92;

    // Elevation adapts to the shape of the arrangement. A flat one (a ring,
    // a grid) needs a high angle or it collapses into an edge-on line; a
    // tall one (tiers, helix) needs a low angle or the stack foreshortens
    // into a single blob.
    const flatness = raw.y / Math.max(raw.x, raw.z, 1);
    // Flat arrangements get a high three-quarter view, like looking down on a site model.
    const elevation = flatness < 0.25 ? 0.95 : 0.36;
    camera.position.set(center.x, center.y + distance * elevation, center.z + distance * 0.86);
    camera.near = 0.1;
    camera.far = distance * 12;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    if (scene.fog) {
      // Start past the far edge of the content, or the fog erases the very
      // thing the camera was just positioned to show.
      scene.fog.near = distance * 1.6;
      scene.fog.far = distance * 4.5;
    }
  });

  return null;
}

/**
 * Each project gets a footprint on the floor with its name printed along the
 * front edge, like the site plan under an architectural model. In
 * arrangements that mix projects in space (rings, spheres) the footprints
 * would overlap, so those get a small floating caption instead.
 */
function ProjectZones({ nodes, live, flat }: { nodes: LayoutNode[]; live: PositionMap; flat: boolean }) {
  const zoneRefs = useRef<Record<string, THREE.Group | null>>({});
  const labelRefs = useRef<Record<string, THREE.Group | null>>({});

  const projects = useMemo(() => {
    const byProject = new Map<string, string[]>();
    for (const n of nodes) {
      const p = n.project || 'unknown';
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p)!.push(n.id);
    }
    return Array.from(byProject.entries()).map(([project, ids]) => ({ project, ids }));
  }, [nodes]);

  useFrame(() => {
    for (const { project, ids } of projects) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sx = 0, sy = 0, sz = 0, n = 0;
      for (const id of ids) {
        const v = live.get(id);
        if (!v) continue;
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
        sx += v.x; sy += v.y; sz += v.z; n++;
      }
      if (n === 0) continue;
      const pad = 5.5;
      const zone = zoneRefs.current[project];
      if (zone) {
        zone.position.set((minX + maxX) / 2, 0.03, (minZ + maxZ) / 2);
        zone.scale.set(maxX - minX + pad * 2, 1, maxZ - minZ + pad * 2);
      }
      const label = labelRefs.current[project];
      if (label) {
        if (flat) label.position.set(minX - pad + 0.9, 0.08, maxZ + pad - 0.9);
        else label.position.set(sx / n, sy / n + 13, sz / n);
      }
    }
  });

  return (
    <>
      {projects.map(({ project, ids }) => (
        <group key={project}>
          {flat && (
            <group ref={(el) => { zoneRefs.current[project] = el; }}>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[1, 1]} />
                <meshStandardMaterial color="#16171a" roughness={1} />
              </mesh>
              <lineSegments rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                <edgesGeometry args={[new THREE.PlaneGeometry(1, 1)]} />
                <lineBasicMaterial color="#34373d" />
              </lineSegments>
            </group>
          )}
          <group ref={(el) => { labelRefs.current[project] = el; }}>
            {flat ? (
              <group rotation={[-Math.PI / 2, 0, 0]}>
                <Text fontSize={1.5} color="#8d939c" anchorX="left" anchorY="bottom" letterSpacing={-0.01}>{project}</Text>
                <Text position={[0, -0.45, 0]} fontSize={0.8} color="#555a62" anchorX="left" anchorY="top">{`${ids.length} services`}</Text>
              </group>
            ) : (
              <Billboard>
                <Text fontSize={1.6} color="#a3a9b1" anchorX="center" outlineWidth={0.04} outlineColor="#0d0e10">{project}</Text>
                <Text position={[0, -1.7, 0]} fontSize={0.85} color="#60656d" anchorX="center">{`${ids.length} services`}</Text>
              </Billboard>
            )}
          </group>
        </group>
      ))}
    </>
  );
}

/** Soft shadows sized to whatever the layout currently covers. */
function GroundShadows({ target }: { target: Positions }) {
  const { center, size } = useMemo(() => {
    const xs = Object.values(target).map(p => p[0]);
    const zs = Object.values(target).map(p => p[2]);
    if (xs.length === 0) return { center: [0, 0] as [number, number], size: 40 };
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    return { center: [(minX + maxX) / 2, (minZ + maxZ) / 2] as [number, number], size: Math.max(maxX - minX, maxZ - minZ) + 24 };
  }, [target]);
  return (
    <ContactShadows position={[center[0], 0.06, center[1]]} scale={size} resolution={1024} blur={2.2} far={9} opacity={0.62} color="#000000" />
  );
}

/** Tiny silhouettes for the legend, matching the 3D forms. */
function ShapeGlyph({ shape, color }: { shape: NodeShape; color: string }) {
  const c = color;
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden>
      {shape === 'rack' && <><rect x="4.5" y="1" width="7" height="12" rx="1.4" fill={c} /><path d="M6.5 4h3M6.5 6.5h3M6.5 9h3" stroke="#24272c" strokeWidth="0.9" /></>}
      {shape === 'storage' && <><rect x="3" y="1.5" width="10" height="3" rx="1.5" fill={c} /><rect x="3" y="5.5" width="10" height="3" rx="1.5" fill={c} /><rect x="3" y="9.5" width="10" height="3" rx="1.5" fill={c} /></>}
      {shape === 'router' && <><rect x="1.5" y="7" width="13" height="4.5" rx="1.3" fill={c} /><path d="M4 7V2.5M12 7V2.5" stroke={c} strokeWidth="1.1" /></>}
      {shape === 'screen' && <><rect x="1.5" y="1" width="13" height="8" rx="1" fill={c} /><rect x="2.8" y="2.2" width="10.4" height="5.6" fill="#24272c" /><path d="M8 9v2.5M5 12.5h6" stroke={c} strokeWidth="1.2" /></>}
      {shape === 'module' && <><rect x="3" y="2" width="10" height="10" rx="2" fill={c} /><path d="M5.5 5.5h5M5.5 8h5" stroke="#24272c" strokeWidth="0.9" /></>}
      {shape === 'pipe' && <><rect x="1.5" y="4" width="13" height="6" rx="3" fill={c} /><path d="M5.5 4v6M10.5 4v6" stroke="#24272c" strokeWidth="0.9" /></>}
    </svg>
  );
}

export function Scene3D({ nodes, edges, selectedNodeId, onNodeClick, onPaneClick }: Scene3DProps) {
  const [layout, setLayout] = useState<LayoutId>(() => {
    return (localStorage.getItem('mm.scene3d.layout') as LayoutId) || 'clusters';
  });
  const [showLabels, setShowLabels] = useState(true);
  const [fitNonce, setFitNonce] = useState(0);
  const live = useRef<PositionMap>(new Map()).current;
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  // onPointerMissed can fire in the same gesture as a node click, which
  // would select and then immediately deselect — the selection panel would
  // flash and vanish. Ignore a "missed" that lands right after a real hit.
  const lastNodeClick = useRef(0);

  useEffect(() => {
    try { localStorage.setItem('mm.scene3d.layout', layout); } catch { /* private mode */ }
  }, [layout]);

  // R3F sizes its canvas from a measured container. When this view mounts
  // while the layout is still settling — a tab switch, a panel opening, the
  // first paint — that measurement can come back stale, and the canvas stays
  // at the browser default 300x150 with the renderer never initialised. The
  // scene then appears completely blank: no grid, no nodes, no errors, and a
  // healthy WebGL context. Nudging a resize after mount forces a real
  // measurement. This was the cause of every "3D is blank" episode.
  useEffect(() => {
    const nudge = () => window.dispatchEvent(new Event('resize'));
    const raf = requestAnimationFrame(nudge);
    const timer = setTimeout(nudge, 250); // covers slower first paints
    const observer = new ResizeObserver(nudge);
    if (canvasWrapRef.current) observer.observe(canvasWrapRef.current);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onPaneClick(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPaneClick]);

  // Keyed on a stable signature rather than the nodes array identity, which
  // changes on every telemetry tick — otherwise the layout is recomputed
  // several times a second for no reason.
  const layoutSignature = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    return nodes
      .map((n) => {
        const d = n.data as any;
        return `${n.id}|${d?.project || ''}|${d?.type || ''}|${degree.get(n.id) || 0}`;
      })
      .sort()
      .join(';');
  }, [nodes, edges]);

  const layoutNodes: LayoutNode[] = useMemo(() => {
    if (!layoutSignature) return [];
    return layoutSignature.split(';').map((entry) => {
      const [id, project, type, degree] = entry.split('|');
      return { id, project, type, degree: Number(degree) || 0 };
    });
  }, [layoutSignature]);

  const targetPositions = useMemo(() => computeLayout(layout, layoutNodes), [layout, layoutNodes]);

  // Focus mode: with something selected, only it and its immediate
  // neighbours stay lit. Everything else dims so the question "what does
  // this talk to" is answerable at a glance instead of by tracing lines
  // through a crowded scene.
  const focus = useMemo(() => {
    if (!selectedNodeId) return null;
    const related = new Set<string>([selectedNodeId]);
    const relatedEdges = new Set<string>();
    for (const e of edges) {
      if (e.source === selectedNodeId || e.target === selectedNodeId) {
        related.add(e.source);
        related.add(e.target);
        relatedEdges.add(e.id);
      }
    }
    return { related, relatedEdges };
  }, [selectedNodeId, edges]);

  // Only legend the categories actually present, so the key doesn't list
  // shapes that aren't on screen.
  const presentTypes = useMemo(() => {
    const seen = new Set(layoutNodes.map((n) => n.type));
    return Object.entries(TYPE_STYLE).filter(([type]) => seen.has(type));
  }, [layoutNodes]);

  // Past ~24 services the floating labels overlap into an unreadable mat, so
  // default them off and leave the toggle.
  useEffect(() => {
    setShowLabels(nodes.length <= 24);
  }, [nodes.length]);

  const activeLayout = LAYOUTS.find((l) => l.id === layout);
  const typeById = useMemo(() => new Map(layoutNodes.map(n => [n.id, n.type])), [layoutNodes]);

  // Critical first, then degraded; drives the "needs attention" pill.
  const troubled = useMemo(() => nodes
    .map(n => ({ id: n.id, name: String((n.data as any)?.name || n.id), status: (n.data as any)?.status as string }))
    .filter(n => n.status === 'critical' || n.status === 'degraded')
    .sort((a, b) => (a.status === 'critical' ? 0 : 1) - (b.status === 'critical' ? 0 : 1)), [nodes]);

  return (
    <div
      ref={canvasWrapRef}
      // minWidth/minHeight: 0 override the flexbox "automatic minimum size"
      // rule. main-content is a flex row with this wrapper (flex:1) beside
      // InspectionPanel (400px, flexShrink:0). The R3F <canvas> inside sets
      // real width/height *attributes* on itself (see the resize-nudge
      // effect below) the first time it measures — before any panel is
      // open, so at full main-content width. That canvas pixel size then
      // becomes this div's content-based minimum width, and a flex item is
      // never shrunk below that minimum unless min-width is overridden —
      // so opening the panel just pushed it 400px past the right edge of
      // the viewport instead of the canvas making room for it. Without
      // this, the fix below (InspectionPanel's own flexShrink:0) is
      // necessary but not sufficient: the panel gets its correct 400px,
      // but the canvas never gives up the space for it to appear in.
      style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: '#0d0e10', position: 'relative' }}
      onClick={(e) => { if (e.target === e.currentTarget) onPaneClick(); }}
    >
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
        onPointerMissed={() => {
          if (Date.now() - lastNodeClick.current < 150) return;
          onPaneClick();
        }}
      >
        <Suspense fallback={null}>
          <color attach="background" args={['#0d0e10']} />
          <fog attach="fog" args={['#0d0e10', 200, 900]} />

          <PerspectiveCamera makeDefault position={CAMERA_START} fov={35} near={0.1} far={4000} />
          <OrbitControls
            makeDefault
            enableRotate
            enablePan
            enableZoom
            minDistance={6}
            maxDistance={1200}
            maxPolarAngle={Math.PI / 2 - 0.08}
            dampingFactor={0.08}
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
          />

          {/* Studio lighting: a broad soft key from above-left, a cool rim from
              behind, and a procedural softbox environment for the satin sheen.
              Everything is generated locally, nothing is fetched. */}
          <hemisphereLight args={['#eef2f8', '#0d0e10', 0.6]} />
          <directionalLight position={[-45, 80, 50]} intensity={1.35} color="#fff7ec" />
          <directionalLight position={[50, 35, -60]} intensity={0.55} color="#cdd9ff" />
          <Environment resolution={128} frames={1}>
            <Lightformer form="rect" intensity={1.6} color="#ffffff" scale={[60, 30, 1]} position={[0, 40, 10]} rotation={[Math.PI / 2, 0, 0]} />
            <Lightformer form="rect" intensity={0.5} color="#dfe7ff" scale={[40, 6, 1]} position={[-40, 10, 0]} rotation={[0, Math.PI / 2, 0]} />
            <Lightformer form="rect" intensity={0.35} color="#fff2e0" scale={[40, 6, 1]} position={[40, 10, 0]} rotation={[0, -Math.PI / 2, 0]} />
          </Environment>

          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
            <planeGeometry args={[4000, 4000]} />
            <meshStandardMaterial color="#0f1012" roughness={1} metalness={0} />
          </mesh>
          <Grid
            position={[0, 0.002, 0]}
            args={[10, 10]}
            cellSize={5}
            cellThickness={0.6}
            cellColor="#17191c"
            sectionSize={25}
            sectionThickness={0.9}
            sectionColor="#1f2226"
            fadeDistance={420}
            fadeStrength={2}
            infiniteGrid
          />
          <GroundShadows target={targetPositions} />

          <LayoutDriver target={targetPositions} live={live} />
          <FitCamera target={targetPositions} trigger={`${layout}:${layoutNodes.length}:${fitNonce}`} />

          {edges.map((edge) => (
            <Edge3D
              key={edge.id}
              edge={edge as any}
              sourceId={edge.source}
              targetId={edge.target}
              live={live}
              dimmed={focus ? !focus.relatedEdges.has(edge.id) : false}
              sourceType={typeById.get(edge.source)}
            />
          ))}

          {nodes.map((node) => (
            <Node3D
              key={node.id}
              node={node as any}
              live={live}
              isSelected={node.id === selectedNodeId}
              onClick={() => {
                lastNodeClick.current = Date.now();
                if (node.id === selectedNodeId) onPaneClick();
                else onNodeClick(node.id);
              }}
              // With a selection active, label the neighbours regardless of
              // the global toggle — they're the ones being asked about.
              showLabel={focus ? focus.related.has(node.id) : showLabels}
              dimmed={focus ? !focus.related.has(node.id) : false}
            />
          ))}

          {/* Its own boundary: troika's Text suspends while it fetches a
              font, and if that request hangs a shared boundary takes the
              entire scene — grid, nodes and all — down with it. */}
          <Suspense fallback={null}>
            <ProjectZones nodes={layoutNodes} live={live} flat={layout === 'clusters' || layout === 'grid'} />
          </Suspense>
        </Suspense>
      </Canvas>

      <div className="mm-overlay" style={{ top: 16, left: 16, width: 236, padding: '14px 14px 12px' }}>
        <div className="mm-eyebrow" style={{ marginBottom: 8 }}>Arrangement</div>
        <div className="mm-seg">
          {LAYOUTS.map((opt) => (
            <button key={opt.id} className={opt.id === layout ? 'on' : undefined} onClick={() => setLayout(opt.id)} title={opt.hint}>
              {opt.label}
            </button>
          ))}
        </div>
        {activeLayout && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--color-text-dim)', lineHeight: 1.45 }}>{activeLayout.hint}</div>
        )}
        <hr />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          <span>Labels <span style={{ color: 'var(--color-text-dim)' }}>· {nodes.length} services</span></span>
          <button className={`mm-switch${showLabels ? ' on' : ''}`} onClick={() => setShowLabels(v => !v)} aria-pressed={showLabels} aria-label="Show labels" />
        </div>

        {presentTypes.length > 0 && (
          <>
            <hr />
            <div className="mm-eyebrow" style={{ marginBottom: 8 }}>Service types</div>
            <div className="mm-legend">
              {presentTypes.map(([type, style]) => (
                <div key={type}><ShapeGlyph shape={style.shape} color="#b9bdc4" />{style.label}</div>
              ))}
            </div>
          </>
        )}
        <hr />
        <div className="mm-eyebrow" style={{ marginBottom: 8 }}>Health</div>
        <div className="mm-legend">
          <div><i className="mm-dot" style={{ background: 'var(--color-healthy)' }} />Healthy</div>
          <div><i className="mm-dot" style={{ background: '#6b7079' }} />No data</div>
          <div><i className="mm-dot" style={{ background: 'var(--color-degraded)' }} />Degraded</div>
          <div><i className="mm-dot" style={{ background: 'var(--color-critical)' }} />Critical</div>
          <div><svg width="16" height="6"><path d="M1 3h14" stroke="#3ecf8e" strokeWidth="2.2" strokeLinecap="round" /></svg>Live link</div>
          <div><svg width="16" height="6"><path d="M1 3h14" stroke="#4a4f57" strokeWidth="1.2" strokeLinecap="round" /></svg>Declared</div>
        </div>
      </div>

      {troubled.length > 0 && !selectedNodeId && (
        <div className="mm-overlay mm-alert" style={{ top: 16, left: '50%', transform: 'translateX(-50%)' }}>
          <i className="mm-dot" style={{ background: 'var(--color-critical)' }} />
          <span>
            {troubled.length === 1 ? <><b style={{ fontWeight: 600 }}>{troubled[0].name}</b> needs attention</> : <>{troubled.length} services need attention</>}
          </span>
          <button onClick={() => onNodeClick(troubled[0].id)}>Inspect</button>
        </div>
      )}

      <div className="mm-hint" style={{ position: 'absolute', left: 18, bottom: 14, zIndex: 10, pointerEvents: 'none' }}>
        <span>Drag to orbit</span><span>Right-drag to pan</span><span>Scroll to zoom</span>
        {selectedNodeId && <span><span className="mm-kbd">Esc</span> clear selection</span>}
      </div>
      <button className="mm-btn" style={{ position: 'absolute', right: 16, top: 16, zIndex: 10 }} onClick={() => setFitNonce(n => n + 1)}>
        Recenter
      </button>
    </div>
  );
}
