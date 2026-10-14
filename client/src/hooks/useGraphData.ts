import { useState, useEffect, useCallback, useRef } from 'react';
import { applyNodeChanges, type Node, type Edge, type NodeChange } from '@xyflow/react';
import type { ServiceNode, DependencyEdge, GlobalStatus, GraphData, Target } from '../types';
import { shareById } from './shareById';

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

/** Terminal lines kept in memory. Every agent log line is pushed here, and
 *  this array used to grow without limit for the life of the tab. */
const MAX_TERMINAL_LINES = 500;

/**
 * Numeric fields compared at the precision they are shown at. On live data
 * nearly every node and edge differs from the previous push in some digit -
 * CPU jitter, ever-growing byte counters, an activity rate recomputed over a
 * slightly longer window - so comparing raw values found everything changed
 * every time and nothing was ever reused. A node whose CPU still reads 12.3%
 * has not changed in any way anyone can see.
 */
const DISPLAY_PRECISION: Record<string, number> = {
  cpu: 10, memoryPercent: 10,              // shown to one decimal
  memory: 1 / 1_048_576,                   // bytes, to the MiB
  networkRx: 1 / 1_048_576, networkTx: 1 / 1_048_576,
  samplesPerMin: 1, baselinePerMin: 1,      // drives colour bands and weights
  value: 100, dependency: 100, volume: 100, confidence: 100, stress: 100,
  anomalyScore: 100, failureProbability: 100, affectedProbability: 100,
  riskScore: 100, healthScore: 100, criticality: 100, centrality: 100,
};

/**
 * Content signature for structural sharing: volatile timestamps dropped,
 * volatile numbers rounded to display precision.
 */
function contentKey(value: unknown): string {
  return JSON.stringify(value, (k, v) => {
    if (k === 'lastSeen' || k === 'windowSec' || k === 'observedAt' || k === 'timestamp') return undefined;
    const scale = DISPLAY_PRECISION[k];
    return scale !== undefined && typeof v === 'number' ? Math.round(v * scale) : v;
  });
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
  /** Content signature of each node/edge data object, for structural
   *  sharing. Keyed by the data object, not the id: see shareById for why
   *  that is what keeps a service's new status from being dropped. */
  const contentKeys = useRef(new WeakMap<object, string>());
  const appendLog = (line: string) =>
    setTerminalLogs(prev => (prev.length >= MAX_TERMINAL_LINES ? [...prev.slice(-(MAX_TERMINAL_LINES - 1)), line] : [...prev, line]));

  // Arrangement is owned by the view (App picks a layout from layouts2d,
  // the 3D scene has its own), so this only wraps the raw nodes for React
  // Flow. Positions here are placeholders that the selected layout
  // overwrites - computing a second layout in here would just fight it.
  const calculateLayout = (backendNodes: ServiceNode[]): Node[] =>
    backendNodes.map((node, i) => ({
      id: node.id,
      type: 'customServiceNode',
      data: node as ServiceNode & Record<string, unknown>,
      position: { x: (i % 8) * 260, y: Math.floor(i / 8) * 190 },
    }));

  const parseEdges = (backendEdges: DependencyEdge[]): Edge[] => {
    return backendEdges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'customDependencyEdge',
      data: edge as DependencyEdge & Record<string, unknown>,
      // Not React Flow's `animated`: that runs a dash animation on every path
      // of the edge. Our edge draws its own flow packet, and sets
      // strokeDasharray itself (dashed = declared only), so the animation was
      // invisible - but it still repainted every filtered path every frame,
      // which on 75 services held the 2D canvas at ~9 fps.
      animated: false,
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

          // Structural sharing: a node or edge whose content has not changed
          // keeps its previous object, and if nothing changed at all the
          // previous array is returned so React skips the update entirely.
          // Every push used to hand every component a brand-new object, so
          // everything re-rendered on every update whether or not it changed.
          const incomingNodes = new Map<string, ServiceNode>(newNodes.map((n: ServiceNode) => [n.id, n]));
          const nodeKeysById = new Map<string, string>(newNodes.map((n: ServiceNode) => [n.id, contentKey(n)]));
          const nodeIds = newNodes.map((n: ServiceNode) => n.id);
          setNodes(prevNodes => shareById(prevNodes, nodeIds, nodeKeysById, contentKeys.current, (id, i, prev) => {
            const n = incomingNodes.get(id)!;
            // Spread the previous object rather than building a new one:
            // React Flow keeps its own state on it - measured size, position,
            // selection - and dropping `measured` made it re-measure the node
            // and withhold every edge touching it until it had. With pushes
            // arriving every second, links vanished from the canvas.
            if (prev) return { ...prev, data: n as ServiceNode & Record<string, unknown> };
            return { ...calculateLayout([n])[0], position: { x: (i % 8) * 260, y: Math.floor(i / 8) * 190 } };
          }));
          const parsedEdges = new Map(parseEdges(newEdges).map(e => [e.id, e]));
          const edgeKeysById = new Map<string, string>(newEdges.map((e: DependencyEdge) => [e.id, contentKey(e)]));
          const edgeIds = newEdges.map((e: DependencyEdge) => e.id);
          setEdges(prevEdges => shareById(prevEdges, edgeIds, edgeKeysById, contentKeys.current, (id) => parsedEdges.get(id)!));
          if (newTargets) setTargets(newTargets);
          setLastUpdate(new Date().toISOString());
        } else if (message.type === 'TERMINAL_LOG') {
          appendLog(message.data);
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
      appendLog(`$ ${cmd}`);
      wsRef.current.send(JSON.stringify({ type: 'TERMINAL_EXEC', data: { cmd, targetId } }));
    }
  }, []);

  const addTerminalLog = useCallback((log: string) => {
    appendLog(log);
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
