import { useState, useEffect, useMemo } from 'react';
import { useWebSocket } from './useWebSocket';
import { computeLayout } from '../utils/graphLayout';

export function useGraphState() {
  const wsUrl = `ws://${window.location.host}/ws`;
  const { data: rawData, isConnected, lastUpdate } = useWebSocket(wsUrl);
  
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [filters, setFilters] = useState({
    projectFilter: 'all',
    typeFilter: 'all',
    statusFilter: 'all',
    searchQuery: '',
    viewMode: 'dependency'
  });

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  
  useEffect(() => {
    if (!rawData) return;
    
    let filteredNodes = Object.values(rawData.services || {}).filter(node => {
      const pFilter = filters.projectFilter === 'all' || node.project === filters.projectFilter;
      const tFilter = filters.typeFilter === 'all' || node.type === filters.typeFilter;
      const sFilter = filters.statusFilter === 'all' || node.status === filters.statusFilter;
      const qFilter = filters.searchQuery === '' || node.name.toLowerCase().includes(filters.searchQuery.toLowerCase());
      return pFilter && tFilter && sFilter && qFilter;
    });

    const rfNodes = filteredNodes.map(node => ({
      id: node.id,
      type: 'service',
      data: node,
      position: { x: 0, y: 0 }
    }));

    const validNodeIds = new Set(rfNodes.map(n => n.id));
    
    const rfEdges = (rawData.dependencies || [])
      .filter(dep => validNodeIds.has(dep.source) && validNodeIds.has(dep.target))
      .map(dep => ({
        id: `${dep.source}-${dep.target}`,
        source: dep.source,
        target: dep.target,
        type: 'dependency',
        data: dep
      }));
      
    const layoutedNodes = computeLayout(rfNodes, rfEdges, 'TB');
    
    setNodes(layoutedNodes);
    setEdges(rfEdges);
    
  }, [rawData, filters]);

  const graphStats = useMemo(() => {
    if (!rawData) return { totalNodes: 0, totalEdges: 0, healthyCount: 0, degradedCount: 0, criticalCount: 0, unknownCount: 0, globalStatus: 'unknown' };
    
    const s = Object.values(rawData.services || {});
    const healthyCount = s.filter(n => n.status === 'healthy').length;
    const degradedCount = s.filter(n => n.status === 'degraded').length;
    const criticalCount = s.filter(n => n.status === 'critical').length;
    const unknownCount = s.filter(n => n.status === 'unknown').length;
    
    let globalStatus = 'healthy';
    if (criticalCount > 0) globalStatus = 'critical';
    else if (degradedCount > 0) globalStatus = 'degraded';
    
    return {
      totalNodes: s.length,
      totalEdges: (rawData.dependencies || []).length,
      healthyCount,
      degradedCount,
      criticalCount,
      unknownCount,
      globalStatus
    };
  }, [rawData]);

  return {
    nodes,
    edges,
    selectedNode,
    selectedEdge,
    setSelectedNode,
    setSelectedEdge,
    filters,
    setFilters,
    isConnected,
    lastUpdate,
    graphStats
  };
}
