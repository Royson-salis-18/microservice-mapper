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
          maskColor="rgba(4, 6, 15, 0.75)"
          style={{ background: 'rgba(8, 12, 22, 0.9)', border: '1px solid rgba(125,211,252,0.18)', borderRadius: '8px' }}
          nodeColor={(n) => {
            // Warm colours are reserved for trouble, matching the 3D scene:
            // anything amber or red on the minimap is a real problem.
            if (n.data?.status === 'degraded') return '#ffab00';
            if (n.data?.status === 'critical') return '#ff1744';
            const type = (n.data as any)?.type;
            if (type === 'gateway') return '#00e5ff';
            if (type === 'frontend') return '#6f8cff';
            if (type === 'database') return '#00ff9d';
            if (type === 'cache') return '#a78bfa';
            if (type === 'queue') return '#c084fc';
            if (type === 'service') return '#4fd1c5';
            return '#9f8fd6';
          }}
        />
      </ReactFlow>
    </div>
  );
}
