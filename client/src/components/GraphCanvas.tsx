import { useEffect, useMemo, useRef } from 'react';
import { ReactFlow, MiniMap, Background, BackgroundVariant, useReactFlow } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CustomServiceNode } from './ServiceNode';
import { CustomDependencyEdge } from './DependencyEdge';

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
 * completely different footprint - a spiral is compact, a hierarchy is very
 * wide - so without this, switching leaves you staring at empty canvas with
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
        <Background color="rgba(255, 255, 255, 0.06)" variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <MiniMap
          zoomable
          pannable
          maskColor="rgba(10, 11, 13, 0.72)"
          style={{ background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)', borderRadius: '10px' }}
          nodeColor={(n) => {
            // Warm colours are reserved for trouble, matching the 3D scene:
            // anything amber or red on the minimap is a real problem.
            if (n.data?.status === 'degraded') return '#e8a33d';
            if (n.data?.status === 'critical') return '#ef5f67';
            return '#3a3f47';
          }}
        />
      </ReactFlow>
    </div>
  );
}
