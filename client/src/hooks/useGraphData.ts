import { useState, useEffect, useCallback, useRef } from 'react';
import { applyNodeChanges, type Node, type Edge, type NodeChange } from '@xyflow/react';
import type { ServiceNode, DependencyEdge, GlobalStatus, GraphData, Target } from '../types';

interface UseGraphDataReturn {
  nodes: Node[];
  edges: Edge[];
  targets: Target[];
  status: GlobalStatus | null;
  isConnected: boolean;
  lastUpdate: string | null;
  error: string | null;
  onNodesChange: (changes: NodeChange[]) => void;
}

export function useGraphData(): UseGraphDataReturn {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [status, setStatus] = useState<GlobalStatus | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const calculateLayout = (backendNodes: ServiceNode[]): Node[] => {
    const gateways = backendNodes.filter(n => n.type === 'gateway' || n.type === 'frontend');
    const services = backendNodes.filter(n => n.type === 'service');
    const databases = backendNodes.filter(n => n.type === 'database' || n.type === 'queue');
    const others = backendNodes.filter(n => n.type === 'external' || n.type === 'infrastructure' || (n.type as string) === 'unknown');

    const createLayoutForLayer = (layerNodes: ServiceNode[], yBase: number): Node[] => {
      const xSpacing = 250;
      const startX = -((layerNodes.length - 1) * xSpacing) / 2;
      return layerNodes.map((node, i) => ({
        id: node.id,
        type: 'customServiceNode',
        data: node as ServiceNode & Record<string, unknown>,
        position: { x: startX + i * xSpacing, y: yBase },
      }));
    };

    return [
      ...createLayoutForLayer(gateways, 0),
      ...createLayoutForLayer(services, 250),
      ...createLayoutForLayer(databases, 500),
      ...createLayoutForLayer(others, 750),
    ];
  };

  const parseEdges = (backendEdges: DependencyEdge[]): Edge[] => {
    return backendEdges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'customDependencyEdge',
      data: edge as DependencyEdge & Record<string, unknown>,
      animated: edge.status === 'active',
    }));
  };

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const fetchInitialData = async () => {
    try {
      const [graphRes, statusRes] = await Promise.all([
        fetch('/api/graph'),
        fetch('/api/status'),
      ]);
      if (!graphRes.ok || !statusRes.ok) throw new Error('Failed to fetch data');
      
      const graphData: GraphData = await graphRes.json();
      const statusData: GlobalStatus & { targets: Target[] } = await statusRes.json();
      
      setNodes(calculateLayout(graphData.nodes));
      setEdges(parseEdges(graphData.edges));
      setTargets(graphData.targets || statusData.targets || []);
      setStatus(statusData);
      setLastUpdate(new Date().toISOString());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const connectWs = useCallback(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'graph-update') {
          const { nodes: newNodes, edges: newEdges, targets: newTargets } = message.data;
          setNodes(prevNodes => {
            const layouted = calculateLayout(newNodes);
            return layouted.map(ln => {
              const prev = prevNodes.find(p => p.id === ln.id);
              return prev ? { ...ln, position: prev.position } : ln;
            });
          });
          setEdges(parseEdges(newEdges));
          if (newTargets) setTargets(newTargets);
          setLastUpdate(new Date().toISOString());
        }
      } catch (err) {
        console.error('Error parsing WS message', err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setTimeout(connectWs, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    fetchInitialData();
    connectWs();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWs]);

  return { nodes, edges, targets, status, isConnected, lastUpdate, error, onNodesChange };
}
