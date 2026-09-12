import React, { useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, Background, MiniMap } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import ServiceNode from './ServiceNode';
import DependencyEdge from './DependencyEdge';

const nodeTypes = {
  service: ServiceNode
};

const edgeTypes = {
  dependency: DependencyEdge
};

export default function GraphView({ nodes, edges, onNodeClick, onEdgeClick, onPaneClick, selectedNode }) {
  
  const nodesWithSelection = useMemo(() => {
    return nodes.map(n => ({
      ...n,
      selected: selectedNode?.id === n.id
    }));
  }, [nodes, selectedNode]);

  const edgesWithSelection = useMemo(() => {
    return edges.map(e => ({
      ...e,
      selected: selectedNode?.id === e.source || selectedNode?.id === e.target
    }));
  }, [edges, selectedNode]);

  return (
    <div className="graph-area">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodesWithSelection}
          edges={edgesWithSelection}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(e, node) => onNodeClick(node)}
          onEdgeClick={(e, edge) => onEdgeClick(edge)}
          onPaneClick={onPaneClick}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ animated: false }}
        >
          <Background variant="dots" gap={20} size={1} color="rgba(255,255,255,0.03)" />
          <MiniMap 
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }} 
            nodeColor="var(--text-muted)" 
            maskColor="rgba(10, 10, 15, 0.8)" 
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
