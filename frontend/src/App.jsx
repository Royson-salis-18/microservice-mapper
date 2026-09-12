import React, { useState, useEffect } from 'react';
import { useGraphState } from './hooks/useGraphState';
import TopBar from './components/TopBar';
import LeftPanel from './components/LeftPanel';
import GraphView from './components/GraphView';
import InspectionPanel from './components/InspectionPanel';
import SearchOverlay from './components/SearchOverlay';

export default function App() {
  const {
    nodes,
    edges,
    selectedNode,
    setSelectedNode,
    filters,
    setFilters,
    isConnected,
    lastUpdate,
    graphStats
  } = useGraphState();

  const [metricHistory, setMetricHistory] = useState(null);

  useEffect(() => {
    if (selectedNode) {
      setMetricHistory(null);
      fetch(`/api/services/${selectedNode.id}/metrics?range=5m`)
        .then(res => {
          if (!res.ok) throw new Error('API not available');
          return res.json();
        })
        .then(data => setMetricHistory(data))
        .catch(() => {
          console.log('Using placeholder metric history due to backend unavailability.');
        });
    }
  }, [selectedNode]);

  const handleNodeClick = (node) => {
    setSelectedNode(node);
  };

  const handlePaneClick = () => {
    setSelectedNode(null);
  };

  const selectedNodeEdges = {
    upstream: edges.filter(e => e.target === selectedNode?.id).map(e => {
      const sourceNode = nodes.find(n => n.id === e.source);
      return { ...e, sourceNodeName: sourceNode?.data?.name };
    }),
    downstream: edges.filter(e => e.source === selectedNode?.id).map(e => {
      const targetNode = nodes.find(n => n.id === e.target);
      return { ...e, targetNodeName: targetNode?.data?.name };
    })
  };

  const searchResults = filters.searchQuery
    ? nodes.map(n => n.data).filter(d => d.name.toLowerCase().includes(filters.searchQuery.toLowerCase()))
    : [];

  return (
    <div className="app-layout">
      <TopBar 
        filters={filters} 
        setFilters={setFilters} 
        graphStats={graphStats} 
        isConnected={isConnected} 
        lastUpdate={lastUpdate} 
      />
      
      {filters.searchQuery && (
        <SearchOverlay 
          query={filters.searchQuery} 
          results={searchResults} 
          onSelect={(data) => {
            const node = nodes.find(n => n.id === data.id);
            if (node) setSelectedNode(node);
            setFilters(f => ({ ...f, searchQuery: '' }));
          }}
          onClose={() => setFilters(f => ({ ...f, searchQuery: '' }))} 
        />
      )}

      <LeftPanel 
        filters={filters} 
        setFilters={setFilters} 
        graphStats={graphStats} 
      />
      
      <GraphView 
        nodes={nodes} 
        edges={edges} 
        onNodeClick={handleNodeClick} 
        onEdgeClick={() => {}} 
        onPaneClick={handlePaneClick}
        selectedNode={selectedNode}
      />
      
      {selectedNode && (
        <InspectionPanel 
          node={selectedNode} 
          edges={selectedNodeEdges} 
          onClose={() => setSelectedNode(null)} 
          metricHistory={metricHistory}
        />
      )}
    </div>
  );
}
