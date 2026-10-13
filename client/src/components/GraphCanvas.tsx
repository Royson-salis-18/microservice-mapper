import { useEffect, useMemo, useRef } from 'react';
import { ReactFlow, MiniMap, Background, BackgroundVariant, useReactFlow } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CustomServiceNode } from './ServiceNode';
import { CustomDependencyEdge } from './DependencyEdge';
import { statusVisual, typeVisual } from './shared/serviceVisuals';

interface GraphCanvasProps {
  nodes: Node[];
  edges: Edge[];
  /** Changes when the arrangement changes, so the view can refit. */
  layoutKey?: string;
  onNodeClick: (node: Node) => void;
  onEdgeClick?: (edge: Edge) => void;
  onPaneClick: () => void;
  onNodesChange: (changes: any) => void;
}

/**
 * Refits the viewport when the arrangement changes. Each layout occupies a
 * completely different footprint — a spiral is compact, a hierarchy is very
 * wide — so without this, switching leaves you staring at empty canvas with
 * the graph off-screen.
 */
function RefitOnLayoutChange({ layoutKey, nodeCount }: { layoutKey?: string; nodeCount: number }) {
  const { fitView } = useReactFlow();
  const last = useRef<string>('');

  useEffect(() => {
    const key = `${layoutKey}:${nodeCount}`;
    if (!layoutKey || nodeCount === 0 || last.current === key) return;
    last.current = key;
    // One frame later, so React Flow has measured the new positions.
    const id = requestAnimationFrame(() => {
      fitView({ padding: 0.18, duration: 600 });
    });
    return () => cancelAnimationFrame(id);
  }, [layoutKey, nodeCount, fitView]);

  return null;
}

export function GraphCanvas({ nodes, edges, layoutKey, onNodeClick, onEdgeClick, onPaneClick, onNodesChange }: GraphCanvasProps) {
  const nodeTypes = useMemo(() => ({ customServiceNode: CustomServiceNode }), []);
  const edgeTypes = useMemo(() => ({ customDependencyEdge: CustomDependencyEdge }), []);

  return (
    <div className="graph-container">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onNodeClick(node)}
        onEdgeClick={(_, edge) => onEdgeClick?.(edge)}
        onPaneClick={onPaneClick}
        fitView
        colorMode="dark"
        minZoom={0.05}
        maxZoom={4}
        proOptions={{ hideAttribution: false }}
      >
        <RefitOnLayoutChange layoutKey={layoutKey} nodeCount={nodes.length} />
        <Background color="rgba(125, 211, 252, 0.07)" variant={BackgroundVariant.Dots} gap={24} size={1.4} />
        <MiniMap
          zoomable
          pannable
          maskColor="rgba(7, 9, 20, 0.75)"
          style={{ background: 'rgba(20, 22, 30, 0.92)', border: '1px solid rgba(148,163,255,0.14)', borderRadius: '10px' }}
          nodeColor={(n) => {
            // Warm colours are reserved for trouble, matching the 3D scene:
            // anything amber or red on the minimap is a real problem. The
            // category tints are the 3D scene's (TYPE_STYLE in 3d/Node3D).
            const status = (n.data as any)?.status;
            if (status === 'degraded' || status === 'critical') return statusVisual(status).color;
            return typeVisual((n.data as any)?.type).color;
          }}
        />
      </ReactFlow>
    </div>
  );
}
