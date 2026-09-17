import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera, OrbitControls, Grid, Billboard, Text, MeshReflectorMaterial } from '@react-three/drei';
import type { Node, Edge } from '@xyflow/react';
import * as THREE from 'three';
import { Node3D, TYPE_STYLE } from './Node3D';
import { Edge3D } from './Edge3D';
import { LAYOUTS, computeLayout, type LayoutId, type LayoutNode, type Positions } from './layouts';

interface Scene3DProps {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  onNodeClick: (id: string) => void;
  onPaneClick: () => void;
}

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
    if (lastTrigger.current === trigger) return;
    const entries = Object.values(target);
    if (entries.length === 0) return;
    lastTrigger.current = trigger;

    const box = new THREE.Box3();
    for (const [x, y, z] of entries) box.expandByPoint(new THREE.Vector3(x, y, z));
    box.expandByScalar(10); // node height, halos, floating labels

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
    const flatness = size.y / Math.max(size.x, size.z, 1);
    const elevation = flatness < 0.25 ? 0.62 : 0.34;
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

function ProjectLabels({ nodes, live }: { nodes: LayoutNode[]; live: PositionMap }) {
  const groupRefs = useRef<Record<string, THREE.Group | null>>({});

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
      const group = groupRefs.current[project];
      if (!group) continue;
      let x = 0, y = 0, z = 0, n = 0;
      for (const id of ids) {
        const v = live.get(id);
        if (!v) continue;
        x += v.x; y += v.y; z += v.z; n++;
      }
      if (n === 0) continue;
      group.position.set(x / n, y / n + 16, z / n);
    }
  });

  return (
    <>
      {projects.map(({ project, ids }) => (
        <group key={project} ref={(el) => { groupRefs.current[project] = el; }}>
          <Billboard>
            <Text fontSize={2.2} color="#7dd3fc" anchorX="center" outlineWidth={0.09} outlineColor="#05070e">
              {project.toUpperCase()}
            </Text>
            <Text position={[0, -2.3, 0]} fontSize={1.1} color="#64748b" anchorX="center">
              {`${ids.length} services`}
            </Text>
          </Billboard>
        </group>
      ))}
    </>
  );
}

export function Scene3D({ nodes, edges, selectedNodeId, onNodeClick, onPaneClick }: Scene3DProps) {
  const [layout, setLayout] = useState<LayoutId>(() => {
    return (localStorage.getItem('mm.scene3d.layout') as LayoutId) || 'clusters';
  });
  const [showLabels, setShowLabels] = useState(true);
  const live = useRef<PositionMap>(new Map()).current;
  // onPointerMissed can fire in the same gesture as a node click, which
  // would select and then immediately deselect — the selection panel would
  // flash and vanish. Ignore a "missed" that lands right after a real hit.
  const lastNodeClick = useRef(0);

  useEffect(() => {
    try { localStorage.setItem('mm.scene3d.layout', layout); } catch { /* private mode */ }
  }, [layout]);

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

  return (
    <div
      style={{ width: '100%', height: '100%', background: '#04060f', position: 'relative' }}
      onClick={(e) => { if (e.target === e.currentTarget) onPaneClick(); }}
    >
      <Canvas
        dpr={[1, 1.75]}
        onPointerMissed={() => {
          if (Date.now() - lastNodeClick.current < 150) return;
          onPaneClick();
        }}
      >
        <Suspense fallback={null}>
          <color attach="background" args={['#04060f']} />
          <fog attach="fog" args={['#04060f', 200, 900]} />

          <PerspectiveCamera makeDefault position={[0, 60, 110]} fov={42} near={0.1} far={4000} />
          <OrbitControls
            makeDefault
            enableRotate
            enablePan
            enableZoom
            minDistance={6}
            maxDistance={1200}
            maxPolarAngle={Math.PI / 2 - 0.03}
            dampingFactor={0.08}
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
          />

          <ambientLight intensity={0.85} />
          <directionalLight position={[30, 60, 30]} intensity={1.6} color="#bae6fd" />
          <directionalLight position={[-35, 30, -20]} intensity={0.8} color="#34d399" />
          {/* Low warm fill from the front so chassis faces aren't flat black */}
          <directionalLight position={[0, 14, 70]} intensity={0.7} color="#ffffff" />

          {/* Reflective floor: the equipment glow bounces back up, which is
              what stops a dark scene reading as flat silhouettes. */}
          {/* Kept deliberately cheap: a 4000-unit plane at 1024 with heavy
              blur stalls the first frames badly enough to look like a broken
              scene. This is the same effect at a fraction of the cost. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]}>
            <planeGeometry args={[900, 900]} />
            <MeshReflectorMaterial
              blur={[120, 40]}
              resolution={512}
              mixBlur={1}
              mixStrength={16}
              roughness={0.9}
              depthScale={0.9}
              minDepthThreshold={0.4}
              maxDepthThreshold={1.2}
              color="#0a111c"
              metalness={0.6}
              mirror={0.3}
            />
          </mesh>

          {/* Sits clear of the reflector below it, with coarser cells and a
              shorter fade — a dense infinite grid aliases into moiré once the
              camera pulls back to frame a large layout. */}
          <Grid
            position={[0, 0.01, 0]}
            args={[10, 10]}
            cellSize={10}
            cellThickness={0.5}
            cellColor="#15384f"
            sectionSize={50}
            sectionThickness={1}
            sectionColor="#236b8a"
            fadeDistance={380}
            fadeStrength={1.6}
            infiniteGrid
          />

          <LayoutDriver target={targetPositions} live={live} />
          <FitCamera target={targetPositions} trigger={`${layout}:${layoutNodes.length}`} />

          {edges.map((edge) => (
            <Edge3D
              key={edge.id}
              edge={edge as any}
              sourceId={edge.source}
              targetId={edge.target}
              live={live}
              dimmed={focus ? !focus.relatedEdges.has(edge.id) : false}
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
            <ProjectLabels nodes={layoutNodes} live={live} />
          </Suspense>
        </Suspense>
      </Canvas>

      <div
        style={{
          position: 'absolute', top: '16px', left: '16px', zIndex: 10,
          background: 'rgba(8, 12, 22, 0.82)', backdropFilter: 'blur(14px)',
          border: '1px solid rgba(125, 211, 252, 0.18)', borderRadius: '10px',
          padding: '12px 14px', width: '218px',
        }}
      >
        <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1.2px', color: '#7dd3fc', textTransform: 'uppercase', marginBottom: '8px' }}>
          Spatial arrangement
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' }}>
          {LAYOUTS.map((opt) => {
            const active = opt.id === layout;
            return (
              <button
                key={opt.id}
                onClick={() => setLayout(opt.id)}
                title={opt.hint}
                style={{
                  padding: '6px 4px',
                  background: active ? 'rgba(0, 212, 255, 0.18)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${active ? 'rgba(0,212,255,0.55)' : 'rgba(255,255,255,0.08)'}`,
                  color: active ? '#e0f2fe' : '#94a3b8',
                  borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.4px', cursor: 'pointer',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {activeLayout && (
          <div style={{ marginTop: '8px', fontSize: '10px', color: '#64748b', lineHeight: 1.4 }}>
            {activeLayout.hint}
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', fontSize: '10px', color: '#94a3b8', cursor: 'pointer' }}>
          <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} style={{ accentColor: '#00d4ff' }} />
          Show labels ({nodes.length} services)
        </label>

        {presentTypes.length > 0 && (
          <div style={{ marginTop: '10px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '8px' }}>
            <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', color: '#64748b', textTransform: 'uppercase', marginBottom: '6px' }}>
              Category
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 6px' }}>
              {presentTypes.map(([type, style]) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '9px', color: '#94a3b8' }}>
                  <span style={{
                    // Echo the 3D silhouette so the key maps to the hardware
                    // on screen: tall for racks, round for disk stacks, wide
                    // and flat for routers, screen-shaped for frontends.
                    width: style.shape === 'router' || style.shape === 'screen' ? '11px' : style.shape === 'rack' ? '6px' : '8px',
                    height: style.shape === 'rack' ? '10px' : style.shape === 'router' ? '5px' : '8px',
                    flexShrink: 0,
                    background: style.color,
                    boxShadow: `0 0 6px ${style.color}`,
                    borderRadius: style.shape === 'storage' || style.shape === 'pipe' ? '50%' : '2px',
                  }} />
                  {style.label}
                </div>
              ))}
            </div>
            <div style={{ marginTop: '6px', fontSize: '9px', color: '#475569', lineHeight: 1.4 }}>
              Colour + shape = category. Ring colour = health. Glow = live load.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
