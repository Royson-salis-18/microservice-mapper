import { useMemo } from 'react';
import { ReactFlow, MiniMap, Background, BackgroundVariant } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CustomServiceNode } from './ServiceNode';
import { CustomDependencyEdge } from './DependencyEdge';

interface GraphCanvasProps {
  nodes: Node[];
  edges: Edge[];
  onNodeClick: (node: Node) => void;
  onEdgeClick?: (edge: Edge) => void;
  onPaneClick: () => void;
  onNodesChange: (changes: any) => void;
}

export function GraphCanvas({ nodes, edges, onNodeClick, onEdgeClick, onPaneClick, onNodesChange }: GraphCanvasProps) {
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
        minZoom={0.1}
        maxZoom={4}
      >
        <Background color="rgba(255,255,255,0.05)" variant={BackgroundVariant.Dots} gap={20} size={1} />
        <MiniMap zoomable pannable nodeColor={(n) => {
          if (n.data?.status === 'healthy') return '#00e676';
          if (n.data?.status === 'degraded') return '#ffab00';
          if (n.data?.status === 'critical') return '#ff1744';
          return '#616161';
        }} />
      </ReactFlow>
    </div>
  );
}
