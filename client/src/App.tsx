import { useState, useMemo, useEffect, useCallback } from 'react';
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
import { ReliabilityView } from './components/ReliabilityView';
import { ExperimentHistoryPanel } from './components/ExperimentHistoryPanel';
import { RemoteConfigPanel } from './components/RemoteConfigPanel';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Sidebar } from './components/Sidebar';
import { TerminalPanel } from './components/TerminalPanel';
import { TracesView } from './components/TracesView';
import { MLPipelineView } from './components/MLPipelineView';
import { FindingsView } from './components/FindingsView';
import { ProjectSections } from './components/ProjectSections';
import { computeLayout2D, type Layout2DId } from './components/layouts2d';
import type { ServiceNode, DependencyEdge } from './types';

export default function App() {
  const { 
    nodes, edges, targets, status, isConnected, lastUpdate, error, isLoading, onNodesChange,
    terminalLogs, sendTerminalCommand, reloadGraph
  } = useGraphData();
  
  const [selectedProjectId, setSelectedProjectId] = useState<string>('ALL');
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState('combined');
  const [layout2d, setLayout2d] = useState<Layout2DId>(() => {
    return (localStorage.getItem('mm.graph.layout2d') as Layout2DId) || 'clusters';
  });
  const [isTrafficPanelOpen, setIsTrafficPanelOpen] = useState(false);
  const [isAwsPanelOpen, setIsAwsPanelOpen] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [isTerminalVisible, setIsTerminalVisible] = useState(false);
  const [terminalPosition, setTerminalPosition] = useState({ x: window.innerWidth - 340, y: window.innerHeight - 440 });
  
  const [filters, setFilters] = useState<Record<string, boolean>>({
    all: true,
    services: true,
    databases: true,
    queues: true,
    gateways: true,
    infrastructure: true,
  });

  const [activeTab, setActiveTab] = useState('3D Vision');

  // Auto-select newly discovered project
  useEffect(() => {
    if (pendingTargetId && targets.some(t => t.targetId === pendingTargetId)) {
      setSelectedProjectId(pendingTargetId);
      setPendingTargetId(null);
      setIsAwsPanelOpen(false);
      setActiveTab('3D Vision');
    }
  }, [targets, pendingTargetId]);

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

  const statusById = useMemo(
    () => new Map(filteredNodes.map(n => [n.id, (n.data as unknown as ServiceNode).status])),
    [filteredNodes]
  );
  const filteredEdges = useMemo(() => {
    const validNodeIds = new Set(filteredNodes.map(n => n.id));
    return edges.filter(edge => {
      if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) return false;
      const data = edge.data as unknown as DependencyEdge;
      if (viewMode === 'combined' && !data.observed && !data.declared) return false;
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
      // A call into a broken service is a broken call: the link takes the callee's health
      // (critical -> failed, degraded -> degraded) unless the edge already reports worse.
      const data = edge.data as unknown as DependencyEdge;
      const calleeStatus = statusById.get(edge.target);
      const derived = calleeStatus === 'critical' ? 'failed' : calleeStatus === 'degraded' && data.status !== 'failed' ? 'degraded' : null;
      return {
        ...edge,
        data: derived && data.status !== 'failed' ? { ...edge.data, status: derived } : edge.data,
        style: {
          ...edge.style,
          opacity: isHighlighted ? 1 : 0.2,
          transition: 'opacity 0.3s'
        }
      };
    });
  }, [edges, filteredNodes, highlightedNodeIds, selectedNodeId, selectedEdgeId, viewMode, statusById]);

  // Projects that actually have nodes right now, so the per-project stack
  // never renders an empty section for a target that's down or not yet
  // discovered. Falls back to the configured targets before the first graph
  // arrives.
  const projectIds = useMemo(() => {
    const fromNodes = new Set(
      nodes.map(n => (n.data as unknown as ServiceNode).project).filter(Boolean)
    );
    if (fromNodes.size > 0) return Array.from(fromNodes).sort();
    return targets.map(t => t.targetId).sort();
  }, [nodes, targets]);

  useEffect(() => {
    try { localStorage.setItem('mm.graph.layout2d', layout2d); } catch { /* private mode */ }
  }, [layout2d]);

  // Layout only depends on which services and links exist, not on their
  // metrics. filteredNodes/filteredEdges get fresh identities on every
  // telemetry poll, so keying the layout off them recomputed every node
  // position several times a second for no visible change.
  const layoutSignature2d = useMemo(() => {
    const nodePart = filteredNodes
      .map((n) => {
        const d = n.data as any;
        return `${n.id}:${d?.type || ''}:${d?.project || ''}`;
      })
      .sort()
      .join('|');
    const edgePart = filteredEdges.map((e) => `${e.source}>${e.target}`).sort().join('|');
    return `${nodePart}||${edgePart}`;
  }, [filteredNodes, filteredEdges]);

  const layoutPositions2d = useMemo(
    () => computeLayout2D(layout2d, filteredNodes, filteredEdges),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the
    // signature deliberately; the arrays themselves change every poll.
    [layout2d, layoutSignature2d]
  );

  // User manual node dragging / rearrangements in 2D Architecture tab
  const [draggedPositions, setDraggedPositions] = useState<Record<string, { x: number; y: number }>>({});

  const handleNodesChange = useCallback((changes: any[]) => {
    onNodesChange(changes);
    let hasMovement = false;
    const updates: Record<string, { x: number; y: number }> = {};
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        updates[c.id] = c.position;
        hasMovement = true;
      }
    }
    if (hasMovement) {
      setDraggedPositions((prev) => ({ ...prev, ...updates }));
    }
  }, [onNodesChange]);

  const handleLayout2DChange = useCallback((newLayout: Layout2DId) => {
    setLayout2d(newLayout);
    // Reset manual drags when switching arrangement layout so the new layout is cleanly applied
    setDraggedPositions({});
  }, []);

  const handleResetArrangement = useCallback(() => {
    setDraggedPositions({});
  }, []);

  // Positions come from the manual drag position (if user rearranged), or the selected
  // arrangement layout. When the user rearranges nodes, their custom positions persist
  // across telemetry polls.
  const arrangedNodes = useMemo(() => {
    return filteredNodes.map((n) => {
      const p = draggedPositions[n.id] ?? layoutPositions2d[n.id];
      return p ? { ...n, position: p } : n;
    });
  }, [filteredNodes, layoutPositions2d, draggedPositions]);

  const projectSummary = useCallback((project: string) => {
    const projectNodes = nodes.filter(
      n => (n.data as unknown as ServiceNode).project?.toLowerCase() === project.toLowerCase()
    );
    const ids = new Set(projectNodes.map(n => n.id));
    const edgeCount = edges.filter(e => ids.has(e.source) && ids.has(e.target)).length;
    const unhealthy = projectNodes.filter(
      n => (n.data as unknown as ServiceNode).status !== 'healthy'
    ).length;
    return `${projectNodes.length} services · ${edgeCount} edges${unhealthy > 0 ? ` · ${unhealthy} not healthy` : ''}`;
  }, [nodes, edges]);

  const selectedNodeData = useMemo(() => {
    if (!selectedNodeId) return null;
    const node = nodes.find(n => n.id === selectedNodeId);
    return node ? (node.data as unknown as ServiceNode) : null;
  }, [selectedNodeId, nodes]);

  /**
   * Keep the floating terminal clear of the inspection sidebar.
   *
   * The sidebar docks against the right edge and takes real layout width
   * (main-content is a flex row, so the canvas shrinks to make room). The
   * terminal floats above everything at z-index 1000 and defaults to
   * `window.innerWidth - 340`, which is inside that same column - so it
   * landed squarely on top of the sidebar, opaque, every time. Clicking a
   * node did open the sidebar; it was just behind the terminal, which is
   * indistinguishable from nothing happening.
   *
   * Clamping only while the inspector is open means the terminal slides
   * left to make room and returns to wherever it was once the sidebar is
   * closed, and a deliberate drag still wins inside the remaining space.
   */
  const INSPECTOR_WIDTH = 400;
  const TERMINAL_WIDTH = 300;
  const isInspectorOpen = Boolean(selectedNodeData || selectedEdgeId);
  const terminalLeft = isInspectorOpen
    ? Math.min(
        terminalPosition.x,
        Math.max(0, window.innerWidth - INSPECTOR_WIDTH - TERMINAL_WIDTH - 16),
      )
    : terminalPosition.x;



  // /api/status counts every target on the host; when one project is selected, count that project's services only.
  const scopedStatus = useMemo(() => {
    if (!status || selectedProjectId === 'ALL') return status;
    const mine = nodes.filter((n) => (n.data as unknown as ServiceNode).project === selectedProjectId);
    const count = (k: string) => mine.filter((n) => (n.data as unknown as ServiceNode).status === k).length;
    const critical = count('critical'), degraded = count('degraded'), healthy = count('healthy'), unknown = count('unknown');
    return { ...status, healthy, degraded, critical, unknown, status: (critical ? 'critical' : degraded ? 'degraded' : healthy ? 'healthy' : 'unknown') as typeof status.status };
  }, [status, nodes, selectedProjectId]);

  return (
    <div className="app-container" style={{ display: 'flex', flexDirection: 'row', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <Sidebar 
        activeTab={activeTab} 
        onTabChange={setActiveTab} 
        status={scopedStatus}
        onAddProject={() => {
          setEditingProjectId(null);
          setIsAwsPanelOpen(true);
        }}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar 
          status={scopedStatus}
          targets={targets}
          isConnected={isConnected}
          lastUpdate={lastUpdate}
          selectedProject={selectedProjectId}
          onProjectChange={setSelectedProjectId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onToggleTrafficPanel={() => { setIsTrafficPanelOpen(!isTrafficPanelOpen); setIsAwsPanelOpen(false); }}
          isTrafficPanelOpen={isTrafficPanelOpen}
          onToggleTerminal={() => setIsTerminalVisible(!isTerminalVisible)}
          isTerminalOpen={isTerminalVisible}
          onReloadGraph={reloadGraph}
          activeTab={activeTab}
          onEditProject={(projectId) => { 
            setEditingProjectId(projectId);
            setIsAwsPanelOpen(true); 
            setIsTrafficPanelOpen(false); 
          }}
        />
        
        <div className="main-content" style={{ flex: 1, position: 'relative' }}>
        {isLoading ? (
          <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
            Loading telemetry…
          </div>
        ) : targets.length === 0 && !error ? (
          <WelcomeScreen onAddProject={() => { setEditingProjectId(null); setIsAwsPanelOpen(true); }} />
        ) : activeTab === '3D Vision' ? (
          <Scene3D 
            nodes={filteredNodes}
            edges={filteredEdges}
            selectedNodeId={selectedNodeId}
            onNodeClick={setSelectedNodeId}
            onPaneClick={() => setSelectedNodeId(null)}
          />
        ) : activeTab === 'Telemetry' ? (
          <ProjectSections selectedProject={selectedProjectId} projects={projectIds} summary={projectSummary}>
            {(project) => (
              <TelemetryView
                nodes={filteredNodes}
                edges={filteredEdges}
                selectedProject={project}
                embedded={selectedProjectId === 'ALL'}
              />
            )}
          </ProjectSections>
        ) : activeTab === 'Dependencies' ? (
          <ProjectSections selectedProject={selectedProjectId} projects={projectIds} summary={projectSummary}>
            {(project) => (
              <DependenciesView
                nodes={filteredNodes}
                edges={filteredEdges}
                selectedProject={project}
                embedded={selectedProjectId === 'ALL'}
              />
            )}
          </ProjectSections>
        ) : activeTab === 'TRACES' ? (
          <ProjectSections selectedProject={selectedProjectId} projects={projectIds} summary={projectSummary}>
            {(project) => <TracesView targetId={project} embedded={selectedProjectId === 'ALL'} />}
          </ProjectSections>
        ) : activeTab === 'Analytics' ? (
          <ProjectSections selectedProject={selectedProjectId} projects={projectIds} summary={projectSummary}>
            {(project) => (
              <AnalyticsView
                nodes={filteredNodes}
                edges={filteredEdges}
                selectedProject={project}
                embedded={selectedProjectId === 'ALL'}
              />
            )}
          </ProjectSections>
        ) : activeTab === 'RCA / INCIDENTS' || activeTab === 'RCA' ? (
          <ProjectSections selectedProject={selectedProjectId} projects={projectIds} summary={projectSummary}>
            {(project) => (
              <RCAView
                nodes={filteredNodes}
                edges={filteredEdges}
                selectedProject={project}
                embedded={selectedProjectId === 'ALL'}
              />
            )}
          </ProjectSections>
        ) : activeTab === 'RELIABILITY' ? (
          <ReliabilityView selectedProject={selectedProjectId} nodes={filteredNodes} />
        ) : activeTab === 'EXPERIMENTS' ? (
          <ExperimentHistoryPanel />
        ) : activeTab === 'ML PIPELINE' ? (
          <MLPipelineView selectedProject={selectedProjectId} />
        ) : activeTab === 'FINDINGS' ? (
          <FindingsView selectedProject={selectedProjectId} />
        ) : (
          <ReactFlowProvider>
            <GraphControls 
              viewMode={viewMode}
              setViewMode={setViewMode}
              filters={filters}
              setFilters={setFilters}
              layout2d={layout2d}
              setLayout2d={handleLayout2DChange}
              nodeCount={arrangedNodes.length}
              edgeCount={filteredEdges.length}
              hasCustomPositions={Object.keys(draggedPositions).length > 0}
              onResetPositions={handleResetArrangement}
            />
            
            <GraphCanvas
              nodes={arrangedNodes}
              edges={filteredEdges}
              layoutKey={layout2d}
              onNodesChange={handleNodesChange}
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

        {isAwsPanelOpen && (
          <RemoteConfigPanel 
            onClose={() => setIsAwsPanelOpen(false)} 
            editTargetId={editingProjectId} 
            onDiscoveryStart={(targetId) => {
              setPendingTargetId(targetId);
              setIsTerminalVisible(true);
            }}
          />
        )}
      </div>
      
      {/* Terminal: opened from the top bar, draggable, closed by its header. */}
      {isTerminalVisible && <div style={{
        position: 'absolute',
        left: terminalLeft,
        top: terminalPosition.y,
        width: `${TERMINAL_WIDTH}px`,
        height: isTerminalVisible ? '400px' : '40px',
        background: 'rgba(17, 19, 23, 0.97)',
                border: '1px solid var(--color-border)',
        borderRadius: '12px',
        overflow: 'hidden',
        zIndex: 1000,
        transition: 'height 0.3s ease',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: 'var(--shadow-pop)'
      }} onMouseDown={isTerminalVisible ? (e => {
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('terminal-content')) {
          const startX = e.clientX - terminalPosition.x;
          const startY = e.clientY - terminalPosition.y;

          const onMouseMove = (moveEvent: MouseEvent) => {
            setTerminalPosition({
              x: Math.max(0, Math.min(moveEvent.clientX - startX, window.innerWidth - 300)),
              y: Math.max(0, Math.min(moveEvent.clientY - startY, window.innerHeight - 40))
            });
          };

          const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
          };

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        }
      }) : undefined}
      >
        {/* Terminal Header Tab */}
        <div
          onClick={() => setIsTerminalVisible(!isTerminalVisible)}
          style={{
            height: '40px',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: isTerminalVisible ? 'move' : 'pointer',
            borderBottom: isTerminalVisible ? '1px solid var(--color-border)' : 'none',
            background: 'rgba(255,255,255,0.02)',
            borderTopLeftRadius: '12px',
            borderTopRightRadius: '12px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}>$</span>
            <span style={{ fontSize: '12px', fontWeight: 550 }}>Terminal</span>
          </div>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>{isTerminalVisible ? '▼' : '▲'}</span>
        </div>

        {/* Terminal Content */}
        {isTerminalVisible && (
          <div style={{ flex: 1, overflow: 'hidden' }} className="terminal-content">
            <TerminalPanel
              logs={terminalLogs}
              onCommandSubmit={(cmd) => sendTerminalCommand(cmd, selectedProjectId)}
              isActive={true}
            />
          </div>
        )}
      </div>}
      
      {error && (
        <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'var(--color-critical)', color: '#fff', padding: '8px 16px', borderRadius: '4px', zIndex: 100 }}>
          {error}
        </div>
      )}
      </div>
    </div>
  );
}
