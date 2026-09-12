import { useState, useMemo } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { TopBar } from './components/TopBar';
import { GraphCanvas } from './components/GraphCanvas';
import { Scene3D } from './components/3d/Scene3D';
import { InspectionPanel } from './components/InspectionPanel';
import { GraphControls } from './components/GraphControls';
import { useGraphData } from './hooks/useGraphData';
import { EdgeInspectionPanel } from './components/EdgeInspectionPanel';
import { TrafficControlPanel } from './components/TrafficControlPanel';
import { TelemetryView } from './components/TelemetryView';
import { DependenciesView } from './components/DependenciesView';
import { AnalyticsView } from './components/AnalyticsView';
import { RCAView } from './components/RCAView';
import { ExperimentHistoryPanel } from './components/ExperimentHistoryPanel';
import type { ServiceNode, DependencyEdge } from './types';

export default function App() {
  const { nodes, edges, targets, status, isConnected, lastUpdate, error, onNodesChange } = useGraphData();
  
  const [selectedProjectId, setSelectedProjectId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState('combined');
  const [isTrafficPanelOpen, setIsTrafficPanelOpen] = useState(false);
  
  const [filters, setFilters] = useState<Record<string, boolean>>({
    all: true,
    services: true,
    databases: true,
    queues: true,
    gateways: true,
    infrastructure: true,
  });

  const [activeTab, setActiveTab] = useState('3D Vision');

  const highlightedNodeIds = useMemo(() => {
    if (!selectedNodeId && !selectedEdgeId) return null;
    const ids = new Set<string>();
    if (selectedNodeId) {
      ids.add(selectedNodeId);
      edges.forEach(e => {
        if (e.source === selectedNodeId) ids.add(e.target);
        if (e.target === selectedNodeId) ids.add(e.source);
      });
    }
    if (selectedEdgeId) {
      const edge = edges.find(e => e.id === selectedEdgeId);
      if (edge) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    }
    return ids;
  }, [selectedNodeId, selectedEdgeId, edges]);

  const filteredNodes = useMemo(() => {
    return nodes.filter(node => {
      const data = node.data as unknown as ServiceNode;
      if (selectedProjectId !== 'ALL' && 
          data.project !== selectedProjectId && 
          data.project.toLowerCase() !== selectedProjectId.toLowerCase()) {
        return false;
      }
      if (searchQuery && !data.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      
      if (data.type === 'service' && filters.services) return true;
      if (data.type === 'database' && filters.databases) return true;
      if (data.type === 'queue' && filters.queues) return true;
      if ((data.type === 'gateway' || data.type === 'frontend') && filters.gateways) return true;
      if (data.type === 'infrastructure' && filters.infrastructure) return true;
      
      return false;
    }).map(node => {
      const isHighlighted = highlightedNodeIds === null || highlightedNodeIds.has(node.id);
      return {
        ...node,
        style: {
          ...node.style,
          opacity: isHighlighted ? 1 : 0.2,
          transition: 'opacity 0.3s'
        },
        data: {
          ...node.data,
          viewMode
        }
      };
    });
  }, [nodes, selectedProjectId, searchQuery, filters, viewMode, highlightedNodeIds]);

  const filteredEdges = useMemo(() => {
    const validNodeIds = new Set(filteredNodes.map(n => n.id));
    return edges.filter(edge => {
      if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) return false;
      const data = edge.data as unknown as DependencyEdge;
      if (viewMode === 'architecture' && !data.declared) return false;
      if (viewMode === 'runtime' && !data.observed) return false;
      return true;
    }).map(edge => {
      let isHighlighted = true;
      if (highlightedNodeIds !== null) {
        if (selectedEdgeId) {
          isHighlighted = edge.id === selectedEdgeId;
        } else if (selectedNodeId) {
          isHighlighted = edge.source === selectedNodeId || edge.target === selectedNodeId;
        }
      }
      return {
        ...edge,
        style: {
          ...edge.style,
          opacity: isHighlighted ? 1 : 0.2,
          transition: 'opacity 0.3s'
        }
      };
    });
  }, [edges, filteredNodes, highlightedNodeIds, selectedNodeId, selectedEdgeId]);

  const selectedNodeData = useMemo(() => {
    if (!selectedNodeId) return null;
    const node = nodes.find(n => n.id === selectedNodeId);
    return node ? (node.data as unknown as ServiceNode) : null;
  }, [selectedNodeId, nodes]);

  return (
    <div className="app-container">
      <TopBar 
        status={status}
        targets={targets}
        isConnected={isConnected}
        lastUpdate={lastUpdate}
        selectedProject={selectedProjectId}
        onProjectChange={setSelectedProjectId}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onToggleTrafficPanel={() => setIsTrafficPanelOpen(!isTrafficPanelOpen)}
        isTrafficPanelOpen={isTrafficPanelOpen}
      />
      
      <div className="main-content">
        {activeTab === '3D Vision' ? (
          <Scene3D 
            nodes={filteredNodes}
            edges={filteredEdges}
            selectedNodeId={selectedNodeId}
            onNodeClick={setSelectedNodeId}
            onPaneClick={() => setSelectedNodeId(null)}
          />
        ) : activeTab === 'Telemetry' ? (
          <TelemetryView 
            nodes={filteredNodes}
            edges={filteredEdges}
            selectedProject={selectedProjectId}
          />
        ) : activeTab === 'Dependencies' ? (
          <DependenciesView 
            nodes={filteredNodes}
            edges={filteredEdges}
            selectedProject={selectedProjectId}
          />
        ) : activeTab === 'Analytics' ? (
          <AnalyticsView 
            nodes={filteredNodes}
            edges={filteredEdges}
            selectedProject={selectedProjectId}
          />
        ) : activeTab === 'RCA / INCIDENTS' || activeTab === 'RCA' ? (
          <RCAView 
            nodes={filteredNodes}
            edges={filteredEdges}
            selectedProject={selectedProjectId}
          />
        ) : activeTab === 'EXPERIMENTS' ? (
          <ExperimentHistoryPanel />
        ) : (
          <ReactFlowProvider>
            <GraphControls 
              viewMode={viewMode}
              setViewMode={setViewMode}
              filters={filters}
              setFilters={setFilters}
            />
            
            <GraphCanvas 
              nodes={filteredNodes} 
              edges={filteredEdges}
              onNodesChange={onNodesChange}
              onNodeClick={(n) => {
                setSelectedNodeId(n.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(e) => {
                setSelectedEdgeId(e.id);
                setSelectedNodeId(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
            />
          </ReactFlowProvider>
        )}
        
        {selectedNodeData && (
          <InspectionPanel 
            node={selectedNodeData}
            edges={edges.map(e => e.data as unknown as DependencyEdge)}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
        
        {selectedEdgeId && (
          <EdgeInspectionPanel
            edge={(edges.find(e => e.id === selectedEdgeId)?.data as unknown as DependencyEdge) || null}
            onClose={() => setSelectedEdgeId(null)}
          />
        )}

        {isTrafficPanelOpen && (
          <TrafficControlPanel onClose={() => setIsTrafficPanelOpen(false)} />
        )}
      </div>
      
      {error && (
        <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'var(--color-critical)', color: '#fff', padding: '8px 16px', borderRadius: '4px', zIndex: 100 }}>
          {error}
        </div>
      )}
    </div>
  );
}
