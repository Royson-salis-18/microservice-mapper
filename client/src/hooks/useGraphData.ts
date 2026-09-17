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
  isLoading: boolean;
  terminalLogs: string[];
  sendTerminalCommand: (cmd: string, ip?: string, key?: string) => void;
  addTerminalLog: (log: string) => void;
  reloadGraph: (targetId: string) => Promise<void>;
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
  const [isLoading, setIsLoading] = useState<boolean>(true);
  
  // Global Terminal State
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // Lays each project (target) out as its own side-by-side cluster instead
  // of merging every project's nodes into shared global rows — with two
  // projects up at once, interleaving them produced long crossing edges
  // between unrelated services that just happened to land in the same row.
  const calculateLayout = (backendNodes: ServiceNode[]): Node[] => {
    const xSpacing = 250;
    const ySpacing = 180;
    const projectGap = 220;
    const maxPerRow = 6; // wrap a layer instead of stretching it into one huge row

    const layerIndex = (n: ServiceNode) => {
      if (n.type === 'gateway' || n.type === 'frontend') return 0;
      if (n.type === 'service') return 1;
      if (n.type === 'database' || n.type === 'queue') return 2;
      return 3; // external / infrastructure / unknown
    };

    const projects = Array.from(new Set(backendNodes.map(n => n.project || 'unknown')));
    const result: Node[] = [];
    let cursorX = 0;

    for (const project of projects) {
      const layers: ServiceNode[][] = [[], [], [], []];
      for (const n of backendNodes) {
        if ((n.project || 'unknown') === project) layers[layerIndex(n)].push(n);
      }

      const blockWidth = Math.max(...layers.map(l => Math.min(l.length, maxPerRow)), 1) * xSpacing;

      let cursorY = 0;
      for (const layerNodes of layers) {
        if (layerNodes.length === 0) continue;
        const rows = Math.ceil(layerNodes.length / maxPerRow);
        for (let row = 0; row < rows; row++) {
          const rowNodes = layerNodes.slice(row * maxPerRow, row * maxPerRow + maxPerRow);
          const startX = cursorX + (blockWidth - (rowNodes.length - 1) * xSpacing) / 2;
          rowNodes.forEach((node, i) => {
            result.push({
              id: node.id,
              type: 'customServiceNode',
              data: node as ServiceNode & Record<string, unknown>,
              position: { x: startX + i * xSpacing, y: cursorY + row * ySpacing },
            });
          });
        }
        cursorY += rows * ySpacing + 60;
      }

      cursorX += blockWidth + projectGap;
    }

    return result;
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
    } finally {
      setIsLoading(false);
    }
  };

  const reloadGraph = async (targetId: string): Promise<void> => {
    const refreshRes = await fetch('/api/discovery/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId }),
    });
    if (!refreshRes.ok) throw new Error('Failed to refresh discovery');
    await fetchInitialData();
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
            // Only recalculate layout if the set of node IDs changed
            const prevIds = new Set<string>(prevNodes.map(n => n.id));
            const newIds = new Set<string>(newNodes.map((n: ServiceNode) => n.id));
            const sameNodeSet = prevIds.size === newIds.size && Array.from(newIds).every((id: string) => prevIds.has(id));
            
            if (sameNodeSet && prevNodes.length > 0) {
              // Same nodes — preserve positions, just update data
              return prevNodes.map(prev => {
                const updated = newNodes.find((n: ServiceNode) => n.id === prev.id);
                if (updated) {
                  return { ...prev, data: updated as ServiceNode & Record<string, unknown> };
                }
                return prev;
              });
            } else {
              // New nodes appeared or removed — recalculate layout but keep existing positions
              const layouted = calculateLayout(newNodes);
              return layouted.map(ln => {
                const prev = prevNodes.find(p => p.id === ln.id);
                return prev ? { ...ln, position: prev.position } : ln;
              });
            }
          });
          setEdges(parseEdges(newEdges));
          if (newTargets) setTargets(newTargets);
          setLastUpdate(new Date().toISOString());
        } else if (message.type === 'TERMINAL_LOG') {
          setTerminalLogs(prev => [...prev, message.data]);
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

  const sendTerminalCommand = useCallback((cmd: string, targetId?: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setTerminalLogs(prev => [...prev, `$ ${cmd}`]);
      wsRef.current.send(JSON.stringify({ type: 'TERMINAL_EXEC', data: { cmd, targetId } }));
    }
  }, []);

  const addTerminalLog = useCallback((log: string) => {
    setTerminalLogs(prev => [...prev, log]);
  }, []);

  useEffect(() => {
    fetchInitialData();
    connectWs();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWs]);

  return { 
    nodes, 
    edges, 
    targets, 
    status, 
    isConnected, 
    lastUpdate, 
    error, 
    isLoading, 
    terminalLogs,
    sendTerminalCommand,
    addTerminalLog,
    reloadGraph,
    onNodesChange 
  };
}
