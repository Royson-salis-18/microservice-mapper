import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { CSSProperties } from 'react';
import {
  Activity, Play, Square, Clock, ArrowRight, ShieldAlert,
  WifiOff, Search, Filter, RefreshCw, Layers, Grid3X3,
  ListFilter, X, Eye, EyeOff, Columns3, Maximize2
} from 'lucide-react';

export interface ConnectionEvent {
  timestamp: string;
  targetId: string;
  sourceServiceId: string;
  destServiceId: string;
  destPort: number;
  state: string;
}

export interface TraceGraphEdge {
  sourceServiceId: string;
  destServiceId: string;
  eventCount: number;
  firstSeen: string;
  lastSeen: string;
  destPorts: string[];
}

export interface TraceGraph {
  nodes: string[];
  edges: TraceGraphEdge[];
}

const WINDOW_OPTIONS = [
  { value: 60, label: 'Last 1 minute' },
  { value: 300, label: 'Last 5 minutes' },
  { value: 900, label: 'Last 15 minutes' },
  { value: 3600, label: 'Last 1 hour' },
  { value: 86400, label: 'Last 24 hours' },
];

/** Strip target prefix: "open-telemetry:checkout" -> "checkout" */
function shortName(serviceId: string): string {
  if (!serviceId) return '';
  const idx = serviceId.indexOf(':');
  return idx >= 0 ? serviceId.substring(idx + 1) : serviceId;
}

/** Assign logical architectural tiers for layout */
function getServiceTier(name: string): { tier: number; label: string } {
  const n = name.toLowerCase();
  if (n.includes('load-generator') || n.includes('proxy') || n.includes('gateway') || n.includes('ingress')) {
    return { tier: 0, label: 'Gateway & ingress' };
  }
  if (n.includes('frontend') || n.includes('ui') || n.includes('web')) {
    return { tier: 1, label: 'Frontend tier' };
  }
  if (n.includes('db') || n.includes('postgres') || n.includes('mysql') || n.includes('mongo') || n.includes('redis') || n.includes('valkey')) {
    return { tier: 3, label: 'Data & storage' };
  }
  if (n.includes('otel') || n.includes('collector') || n.includes('jaeger') || n.includes('prometheus') || n.includes('grafana') || n.includes('opensearch') || n.includes('flagd') || n.includes('opamp')) {
    return { tier: 4, label: 'Observability & infra' };
  }
  return { tier: 2, label: 'Core microservices' };
}

/** Muted categorical palette (style guide); stable per service name */
const SERVICE_PALETTE = ['#8ab4ff', '#b4a5ff', '#7dc4c4', '#c9a46b', '#9aa3b0'];
function serviceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SERVICE_PALETTE[Math.abs(hash) % SERVICE_PALETTE.length];
}

function relativeTime(iso: string) {
  if (!iso) return 'just now';
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return `${Math.round(diffSec / 3600)}h ago`;
}

/** Display-only: "TIME_WAIT" -> "Time wait" */
function sentenceCase(s: string): string {
  if (!s) return '';
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const ICON = { strokeWidth: 1.75 } as const;
const MONO = 'var(--font-mono)';

const inputStyle: CSSProperties = {
  height: '30px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid var(--color-border)',
  borderRadius: '8px',
  color: 'var(--color-text-main)',
  fontSize: '12.5px',
  outline: 'none',
  boxSizing: 'border-box',
};

const tooltipStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-hover)',
  borderRadius: '8px',
  padding: '10px 12px',
  fontSize: '12px',
  color: 'var(--color-text-main)',
  pointerEvents: 'none',
  boxShadow: 'var(--shadow-2)',
  minWidth: '170px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontVariantNumeric: 'tabular-nums',
};

const kpiValueStyle: CSSProperties = {
  fontSize: '26px',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: 'var(--color-text-main)',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1.1,
};

const emptyStateStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  textAlign: 'center',
};

function TooltipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function TracesView({ targetId, embedded = false }: { targetId: string; embedded?: boolean }) {
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [graph, setGraph] = useState<TraceGraph | null>(null);
  const [windowSec, setWindowSec] = useState(300);
  const [isCollecting, setIsCollecting] = useState(true);
  const [lastEventTime, setLastEventTime] = useState<string | null>(null);
  
  // Views & Layouts
  const [viewMode, setViewMode] = useState<'TOPOLOGY' | 'MATRIX' | 'EVENTS'>('TOPOLOGY');
  const [topoLayout, setTopoLayout] = useState<'CIRCULAR' | 'TIERED'>('CIRCULAR');
  const [showSideStream, setShowSideStream] = useState(true);

  // Filters & State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedState, setSelectedState] = useState<'ALL' | 'ESTABLISHED' | 'TIME_WAIT'>('ALL');
  const [inspectedNode, setInspectedNode] = useState<string | null>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ConnectionEvent | null>(null);

  const eventListRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch initial events + graph data
  const fetchData = useCallback(async () => {
    if (!targetId) return;
    setIsLoading(true);
    try {
      const [eventsRes, graphRes] = await Promise.all([
        fetch(`/api/traces/events?targetId=${targetId}&limit=300`),
        fetch(`/api/traces/graph?targetId=${targetId}&windowSec=${windowSec}`)
      ]);

      if (eventsRes.ok) {
        const data = await eventsRes.json();
        if (Array.isArray(data) && data.length > 0) {
          setEvents(data);
          setLastEventTime(data[data.length - 1]?.timestamp || null);
        }
      }
      if (graphRes.ok) {
        const data = await graphRes.json();
        if (data && Array.isArray(data.nodes)) {
          setGraph(data);
        }
      }
    } catch (e) {
      console.error('Failed to fetch trace data:', e);
    } finally {
      setIsLoading(false);
    }
  }, [targetId, windowSec]);

  // Connect to WebSocket with reconnect logic
  useEffect(() => {
    if (!targetId) return;

    let active = true;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
        wsRef.current = ws;

        ws.onopen = () => {
          // Connected
        };

        ws.onmessage = (event) => {
          if (!active) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'trace-events' && (!msg.data?.targetId || msg.data?.targetId === targetId)) {
              const newEvents: ConnectionEvent[] = msg.data.events || [];
              if (newEvents.length > 0) {
                setEvents(prev => {
                  const updated = [...prev, ...newEvents];
                  return updated.length > 800 ? updated.slice(-800) : updated;
                });
                setLastEventTime(new Date().toISOString());
              }
            }
          } catch {}
        };

        ws.onclose = () => {
          if (active) {
            reconnectTimeout = setTimeout(connect, 3000);
          }
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch {}
    };

    connect();
    fetchData();

    const pollInterval = setInterval(fetchData, 8000);

    return () => {
      active = false;
      clearTimeout(reconnectTimeout);
      clearInterval(pollInterval);
      if (wsRef.current) wsRef.current.close();
    };
  }, [targetId, fetchData]);

  // Auto-scroll event list
  useEffect(() => {
    if (eventListRef.current && isAutoScroll) {
      eventListRef.current.scrollTop = eventListRef.current.scrollHeight;
    }
  }, [events, isAutoScroll]);

  const toggleCollection = useCallback(async () => {
    const endpoint = isCollecting ? '/api/traces/stop' : '/api/traces/start';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId }),
      });
      if (res.ok) setIsCollecting(!isCollecting);
    } catch (e) {
      console.error('Collection toggle failed:', e);
    }
  }, [isCollecting, targetId]);

  // Filtered events
  const filteredEvents = useMemo(() => {
    let result = events;
    if (selectedService) {
      result = result.filter(e => 
        e.sourceServiceId === selectedService || 
        e.destServiceId === selectedService ||
        shortName(e.sourceServiceId) === selectedService ||
        shortName(e.destServiceId) === selectedService
      );
    }
    if (selectedState !== 'ALL') {
      result = result.filter(e => e.state === selectedState);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(e => 
        shortName(e.sourceServiceId).toLowerCase().includes(q) ||
        shortName(e.destServiceId).toLowerCase().includes(q) ||
        String(e.destPort).includes(q) ||
        e.state.toLowerCase().includes(q)
      );
    }
    return result;
  }, [events, selectedService, selectedState, searchQuery]);

  // Derived KPI Stats
  const stats = useMemo(() => {
    const totalEvents = events.length;
    const uniqueServices = new Set<string>();
    const portCounts: Record<number, number> = {};
    const pairCounts: Record<string, number> = {};

    events.forEach(e => {
      uniqueServices.add(shortName(e.sourceServiceId));
      uniqueServices.add(shortName(e.destServiceId));
      portCounts[e.destPort] = (portCounts[e.destPort] || 0) + 1;
      const pair = `${shortName(e.sourceServiceId)} → ${shortName(e.destServiceId)}`;
      pairCounts[pair] = (pairCounts[pair] || 0) + 1;
    });

    let topPair = 'None';
    let topPairCount = 0;
    Object.entries(pairCounts).forEach(([pair, count]) => {
      if (count > topPairCount) {
        topPair = pair;
        topPairCount = count;
      }
    });

    const topPorts = Object.entries(portCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p]) => p);

    return {
      totalEvents,
      activeServicesCount: uniqueServices.size || graph?.nodes.length || 0,
      activeStreamsCount: graph?.edges.length || 0,
      topPair,
      topPairCount,
      topPorts
    };
  }, [events, graph]);

  const isReceivingData = lastEventTime
    ? (Date.now() - new Date(lastEventTime).getTime()) < 45000
    : events.length > 0;

  const maxEventCount = graph ? Math.max(...graph.edges.map(e => e.eventCount), 1) : 1;

  // Unique service names list for dropdown
  const allServiceNames = useMemo(() => {
    const set = new Set<string>();
    if (graph?.nodes) graph.nodes.forEach(n => set.add(shortName(n)));
    events.forEach(e => {
      set.add(shortName(e.sourceServiceId));
      set.add(shortName(e.destServiceId));
    });
    return Array.from(set).sort();
  }, [graph, events]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      padding: embedded ? '8px 24px 20px 24px' : '24px',
      color: 'var(--color-text-main)',
      height: embedded ? '740px' : '100%',
      boxSizing: 'border-box',
      background: 'var(--color-bg-body)',
      overflow: 'hidden'
    }}>
      {/* Top Header & Quick Actions */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em' }}>
              Connection tracing
            </h1>
            {/* Live Status Pill */}
            <span
              className="mm-chip"
              style={{
                background: isReceivingData ? 'rgba(62,207,142,0.1)' : 'rgba(255,255,255,0.03)',
                color: isReceivingData ? 'var(--color-healthy)' : 'var(--color-text-muted)',
                borderColor: isReceivingData ? 'rgba(62,207,142,0.25)' : 'var(--color-border)',
              }}
            >
              <i className="mm-dot" style={{ background: isReceivingData ? 'currentColor' : 'var(--color-unknown)' }} />
              {isReceivingData ? 'Live' : 'Idle'}
            </span>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--color-text-muted)' }}>
            <span style={{ fontFamily: MONO, color: 'var(--color-text-main)' }}>{targetId}</span>
            <span style={{ color: 'var(--color-text-dim)' }}> · </span>
            Kernel TCP socket inspection via <span style={{ fontFamily: MONO }}>/proc/net/tcp</span>
          </p>
        </div>

        {/* Global Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* View Modes */}
          <div className="mm-seg" style={{ gridTemplateColumns: 'repeat(3, auto)' }}>
            <button
              className={viewMode === 'TOPOLOGY' ? 'on' : ''}
              onClick={() => setViewMode('TOPOLOGY')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px' }}
            >
              <Layers size={14} {...ICON} />
              Topology
            </button>
            <button
              className={viewMode === 'MATRIX' ? 'on' : ''}
              onClick={() => setViewMode('MATRIX')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px' }}
            >
              <Grid3X3 size={14} {...ICON} />
              Matrix
            </button>
            <button
              className={viewMode === 'EVENTS' ? 'on' : ''}
              onClick={() => setViewMode('EVENTS')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px' }}
            >
              <ListFilter size={14} {...ICON} />
              Event stream
            </button>
          </div>

          {/* Topology Layout Selector (Circular vs Tiered) */}
          {viewMode === 'TOPOLOGY' && (
            <div className="mm-seg" style={{ gridTemplateColumns: 'repeat(2, auto)' }}>
              <button
                className={topoLayout === 'CIRCULAR' ? 'on' : ''}
                onClick={() => setTopoLayout('CIRCULAR')}
                title="Circular ring layout"
                style={{ padding: '0 10px' }}
              >
                Ring
              </button>
              <button
                className={topoLayout === 'TIERED' ? 'on' : ''}
                onClick={() => setTopoLayout('TIERED')}
                title="Architectural multi-column flow layout"
                style={{ padding: '0 10px' }}
              >
                Tiered
              </button>
            </div>
          )}

          {/* Split Screen / Side Stream Toggle */}
          {viewMode === 'TOPOLOGY' && (
            <button
              className={`mm-btn${showSideStream ? ' active' : ''}`}
              onClick={() => setShowSideStream(!showSideStream)}
              title={showSideStream ? 'Hide side event stream' : 'Show side event stream'}
              style={{ cursor: 'pointer' }}
            >
              {showSideStream ? <Columns3 size={14} {...ICON} /> : <Maximize2 size={14} {...ICON} />}
              {showSideStream ? 'Split view' : 'Full canvas'}
            </button>
          )}

          {/* Time Window */}
          <div style={{
            ...inputStyle,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0 8px 0 10px',
          }}>
            <Clock size={14} {...ICON} color="var(--color-text-dim)" />
            <select
              value={windowSec}
              onChange={(e) => setWindowSec(parseInt(e.target.value))}
              style={{
                background: 'transparent',
                color: 'var(--color-text-main)',
                border: 'none',
                fontSize: '12.5px',
                fontFamily: 'inherit',
                cursor: 'pointer',
                outline: 'none'
              }}
            >
              {WINDOW_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value} style={{ background: 'var(--color-bg-raised)' }}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Refresh */}
          <button
            className="mm-btn"
            onClick={() => fetchData()}
            title="Refresh trace data"
            style={{ width: '30px', padding: 0, justifyContent: 'center', cursor: 'pointer', color: 'var(--color-text-muted)' }}
          >
            <RefreshCw size={14} {...ICON} className={isLoading ? 'mm-spin' : ''} />
          </button>

          {/* Toggle Collection */}
          <button
            className={`mm-btn${isCollecting ? '' : ' primary'}`}
            onClick={toggleCollection}
            style={{ cursor: 'pointer' }}
          >
            {isCollecting ? <Square size={12} {...ICON} /> : <Play size={12} {...ICON} />}
            {isCollecting ? 'Pause collection' : 'Resume collection'}
          </button>
        </div>
      </div>

      {/* KPI Stats Bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '16px'
      }}>
        <div className="mm-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span className="mm-eyebrow">Captured events</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={kpiValueStyle}>{stats.totalEvents.toLocaleString()}</span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>in buffer</span>
          </div>
        </div>

        <div className="mm-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span className="mm-eyebrow">Connected services</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={kpiValueStyle}>{stats.activeServicesCount}</span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>nodes</span>
          </div>
        </div>

        <div className="mm-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span className="mm-eyebrow">Active TCP streams</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={kpiValueStyle}>{stats.activeStreamsCount}</span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>directed links</span>
          </div>
        </div>

        <div className="mm-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
          <span className="mm-eyebrow">Top interaction</span>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minHeight: '29px', display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: '14px', fontWeight: 550, color: 'var(--color-text-main)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {stats.topPair}
            </span>
            {stats.topPairCount > 0 && (
              <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginLeft: '8px', fontVariantNumeric: 'tabular-nums' }}>
                {stats.topPairCount}×
              </span>
            )}
          </div>
        </div>

        <div className="mm-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span className="mm-eyebrow">Common ports</span>
          <div style={{ display: 'flex', gap: '6px', minHeight: '29px', alignItems: 'center', flexWrap: 'wrap' }}>
            {stats.topPorts.map(port => (
              <span key={port} className="mm-chip" style={{ fontFamily: MONO, color: 'var(--color-text-main)' }}>
                :{port}
              </span>
            ))}
            {stats.topPorts.length === 0 && (
              <span style={{ fontSize: '12px', color: 'var(--color-text-dim)' }}>None</span>
            )}
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '240px', flexWrap: 'wrap' }}>
          <div style={{
            ...inputStyle,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '0 10px',
            flex: 1,
            maxWidth: '300px',
            minWidth: '180px'
          }}>
            <Search size={14} {...ICON} color="var(--color-text-dim)" />
            <input
              type="text"
              placeholder="Filter by service or port"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--color-text-main)',
                fontSize: '12.5px',
                fontFamily: 'inherit',
                width: '100%'
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                title="Clear search"
                style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 0, display: 'flex' }}
              >
                <X size={14} {...ICON} />
              </button>
            )}
          </div>

          {/* Service Dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Filter size={14} {...ICON} color="var(--color-text-dim)" />
            <select
              value={selectedService || ''}
              onChange={(e) => setSelectedService(e.target.value || null)}
              style={{
                ...inputStyle,
                padding: '0 8px',
                fontFamily: 'inherit',
                cursor: 'pointer',
                borderColor: selectedService ? 'rgba(138,180,255,0.45)' : 'var(--color-border)',
              }}
            >
              <option value="" style={{ background: 'var(--color-bg-raised)' }}>All services</option>
              {allServiceNames.map(svc => (
                <option key={svc} value={svc} style={{ background: 'var(--color-bg-raised)' }}>{svc}</option>
              ))}
            </select>
          </div>

          {/* State Filter */}
          <div className="mm-seg" style={{ gridTemplateColumns: 'repeat(3, auto)' }}>
            {(['ALL', 'ESTABLISHED', 'TIME_WAIT'] as const).map(st => (
              <button
                key={st}
                className={selectedState === st ? 'on' : ''}
                onClick={() => setSelectedState(st)}
                style={{ padding: '0 10px' }}
              >
                {sentenceCase(st)}
              </button>
            ))}
          </div>
        </div>

        {/* Clear filter */}
        {(selectedService || searchQuery || selectedState !== 'ALL') && (
          <button
            className="mm-btn"
            onClick={() => { setSelectedService(null); setSearchQuery(''); setSelectedState('ALL'); }}
            style={{ cursor: 'pointer', color: 'var(--color-text-muted)' }}
          >
            <X size={14} {...ICON} />
            Reset filters
          </button>
        )}
      </div>

      {/* Main Content Area */}
      <div className="mm-card" style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        overflow: 'hidden',
      }}>
        {viewMode === 'TOPOLOGY' && (
          <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: showSideStream ? '1fr 380px' : '1fr',
            height: '100%',
            overflow: 'hidden'
          }}>
            {/* Left Canvas: Topology Map (Circular or Tiered) */}
            <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
              {topoLayout === 'CIRCULAR' ? (
                <CircularTopologyMap
                  graph={graph}
                  maxEventCount={maxEventCount}
                  onSelectNode={(node) => setInspectedNode(node)}
                  selectedNode={inspectedNode}
                />
              ) : (
                <TieredTopologyMap
                  graph={graph}
                  maxEventCount={maxEventCount}
                  onSelectNode={(node) => setInspectedNode(node)}
                  selectedNode={inspectedNode}
                  filterQuery={searchQuery}
                  targetId={targetId}
                />
              )}
            </div>

            {/* Right: Side Event Stream (when Split Screen is enabled) */}
            {showSideStream && (
              <div style={{
                borderLeft: '1px solid var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                overflow: 'hidden'
              }}>
                <TraceEventStreamView
                  events={filteredEvents}
                  isAutoScroll={isAutoScroll}
                  onToggleAutoScroll={() => setIsAutoScroll(!isAutoScroll)}
                  onSelectEvent={(ev) => setSelectedEvent(ev)}
                  eventListRef={eventListRef}
                />
              </div>
            )}
          </div>
        )}

        {viewMode === 'MATRIX' && (
          <TraceMatrixView
            graph={graph}
            onSelectCell={(src, dst) => {
              setSearchQuery(`${shortName(src)} ${shortName(dst)}`);
              setViewMode('EVENTS');
            }}
          />
        )}

        {viewMode === 'EVENTS' && (
          <TraceEventStreamView
            events={filteredEvents}
            isAutoScroll={isAutoScroll}
            onToggleAutoScroll={() => setIsAutoScroll(!isAutoScroll)}
            onSelectEvent={(ev) => setSelectedEvent(ev)}
            eventListRef={eventListRef}
          />
        )}

        {/* Node Inspector Drawer */}
        {inspectedNode && (
          <NodeInspectorDrawer
            nodeId={inspectedNode}
            graph={graph}
            events={events}
            onClose={() => setInspectedNode(null)}
            onFilterEvents={(node) => {
              setSelectedService(shortName(node));
              setViewMode('EVENTS');
            }}
          />
        )}
      </div>

      {/* Event Details Modal */}
      {selectedEvent && (
        <div
          onClick={() => setSelectedEvent(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-bg-raised)',
              border: '1px solid var(--color-border-hover)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
              maxWidth: '520px',
              width: '90%',
              boxShadow: 'var(--shadow-pop)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Connection event</h3>
              <button
                className="mm-icon-btn"
                onClick={() => setSelectedEvent(null)}
                title="Close"
              >
                <X size={16} {...ICON} />
              </button>
            </div>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              fontSize: '13px',
            }}>
              {([
                ['Source service', <span style={{ fontFamily: MONO, fontSize: '12px' }}>{selectedEvent.sourceServiceId}</span>],
                ['Destination service', <span style={{ fontFamily: MONO, fontSize: '12px' }}>{selectedEvent.destServiceId}</span>],
                ['Destination port', <span style={{ fontFamily: MONO, fontSize: '12px' }}>{selectedEvent.destPort}</span>],
                ['TCP state', (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <i className="mm-dot" style={{ background: selectedEvent.state === 'ESTABLISHED' ? 'var(--color-healthy)' : 'var(--color-unknown)' }} />
                    {sentenceCase(selectedEvent.state)}
                  </span>
                )],
                ['Timestamp', <span style={{ fontFamily: MONO, fontSize: '12px' }}>{new Date(selectedEvent.timestamp).toLocaleString()}</span>],
                ['Target host', <span style={{ fontFamily: MONO, fontSize: '12px' }}>{selectedEvent.targetId}</span>],
              ] as const).map(([label, value], i, arr) => (
                <div key={label} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '16px',
                  minHeight: '36px',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--color-border)' : 'none'
                }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
                  <span style={{ color: 'var(--color-text-main)', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="mm-btn"
                onClick={() => {
                  setSelectedService(shortName(selectedEvent.sourceServiceId));
                  setSelectedEvent(null);
                  setViewMode('EVENTS');
                }}
                style={{ cursor: 'pointer' }}
              >
                <Filter size={14} {...ICON} />
                Filter by source
              </button>
              <button
                className="mm-btn primary"
                onClick={() => setSelectedEvent(null)}
                style={{ cursor: 'pointer' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer Info */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
        fontSize: '11px',
        color: 'var(--color-text-dim)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ShieldAlert size={14} {...ICON} />
          <span>Kernel-level TCP snapshots sampled via SSH every ~5s. Connections shorter than 5s may be aggregated or missed.</span>
        </div>
        <span>Microservice Mapper v1.0</span>
      </div>
    </div>
  );
}

/**
 * The Original Circular Radial Constellation Visualization
 */
function CircularTopologyMap({
  graph,
  maxEventCount,
  onSelectNode,
  selectedNode
}: {
  graph: TraceGraph | null;
  maxEventCount: number;
  onSelectNode: (node: string) => void;
  selectedNode: string | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 450 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<TraceGraphEdge | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const updateDims = () => {
      if (svgRef.current?.parentElement) {
        const rect = svgRef.current.parentElement.getBoundingClientRect();
        setDimensions({ width: rect.width || 600, height: rect.height || 450 });
      }
    };
    updateDims();
    const observer = new ResizeObserver(updateDims);
    if (svgRef.current?.parentElement) {
      observer.observe(svgRef.current.parentElement);
    }
    return () => observer.disconnect();
  }, []);

  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];

  // Simple circular layout around center
  const nodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const cx = dimensions.width / 2;
    const cy = dimensions.height / 2;
    const radius = Math.min(cx, cy) * 0.72;

    nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2;
      map.set(node, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });

    return map;
  }, [nodes, dimensions]);

  const neighborsOf = (nodeId: string) => {
    const set = new Set<string>([nodeId]);
    for (const edge of edges) {
      if (edge.sourceServiceId === nodeId) set.add(edge.destServiceId);
      if (edge.destServiceId === nodeId) set.add(edge.sourceServiceId);
    }
    return set;
  };

  const activeFocus = hoveredNode || selectedNode;
  const highlighted = activeFocus ? neighborsOf(activeFocus) : null;

  if (!graph || nodes.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <WifiOff size={20} {...ICON} color="var(--color-text-dim)" />
        <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No connections observed yet</div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Waiting for TCP connection events from the host</div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        <defs>
          <marker
            id="trace-arrowhead-orig"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L8,3 L0,6 Z" fill="rgba(138,180,255,0.7)" />
          </marker>
        </defs>

        {/* Central Ambient Ring */}
        <circle
          cx={dimensions.width / 2}
          cy={dimensions.height / 2}
          r={Math.min(dimensions.width / 2, dimensions.height / 2) * 0.72}
          fill="none"
          stroke="rgba(255,255,255,0.04)"
          strokeWidth="1"
          strokeDasharray="3 5"
        />

        {/* Edges */}
        {edges.map((edge) => {
          const src = nodePositions.get(edge.sourceServiceId);
          const dst = nodePositions.get(edge.destServiceId);
          if (!src || !dst) return null;

          const isDimmed = !!activeFocus && !(highlighted!.has(edge.sourceServiceId) && highlighted!.has(edge.destServiceId));
          const isEdgeHovered = hoveredEdge === edge;

          const thickness = 1 + (edge.eventCount / Math.max(1, maxEventCount)) * 3;
          const baseOpacity = 0.25 + (edge.eventCount / Math.max(1, maxEventCount)) * 0.45;
          const opacity = isDimmed ? baseOpacity * 0.12 : isEdgeHovered ? 1 : baseOpacity;

          const dx = dst.x - src.x;
          const dy = dst.y - src.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const nodeRadius = 22;
          const endX = dst.x - (dx / len) * nodeRadius;
          const endY = dst.y - (dy / len) * nodeRadius;
          const startX = src.x + (dx / len) * nodeRadius;
          const startY = src.y + (dy / len) * nodeRadius;

          return (
            <g key={`${edge.sourceServiceId}->${edge.destServiceId}`}>
              {/* Wide invisible stroke for hover hit-area */}
              <line
                x1={startX} y1={startY} x2={endX} y2={endY}
                stroke="transparent"
                strokeWidth={Math.max(thickness, 14)}
                onMouseEnter={(e) => {
                  setHoveredEdge(edge);
                  const rect = svgRef.current?.getBoundingClientRect();
                  if (rect) setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onMouseMove={(e) => {
                  const rect = svgRef.current?.getBoundingClientRect();
                  if (rect) setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onMouseLeave={() => setHoveredEdge(null)}
                style={{ cursor: 'pointer' }}
              />
              <line
                x1={startX}
                y1={startY}
                x2={endX}
                y2={endY}
                stroke="#8ab4ff"
                strokeWidth={isEdgeHovered ? thickness + 0.75 : thickness}
                strokeOpacity={opacity}
                markerEnd="url(#trace-arrowhead-orig)"
                style={{ transition: 'stroke-width 0.15s ease, stroke-opacity 0.25s ease', pointerEvents: 'none' }}
              />
              {/* Event count label */}
              <text
                x={(startX + endX) / 2}
                y={(startY + endY) / 2 - 6}
                fill={isDimmed ? 'rgba(255,255,255,0.08)' : '#5d636c'}
                fontSize="10"
                textAnchor="middle"
                style={{ pointerEvents: 'none', transition: 'fill 0.25s ease', fontVariantNumeric: 'tabular-nums' }}
              >
                {edge.eventCount}×
              </text>
            </g>
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const pos = nodePositions.get(node);
          if (!pos) return null;
          const name = shortName(node);
          const color = serviceColor(name);
          const isDimmed = !!activeFocus && !highlighted!.has(node);
          const isHovered = hoveredNode === node;
          const isSelected = selectedNode === node;

          return (
            <g
              key={node}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelectNode(node)}
              onMouseEnter={() => setHoveredNode(node)}
              onMouseLeave={() => setHoveredNode(null)}
              opacity={isDimmed ? 0.22 : 1}
            >
              {/* Selection ring */}
              {(isHovered || isSelected) && (
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={21}
                  fill="none"
                  stroke={isSelected ? '#8ab4ff' : 'rgba(255,255,255,0.15)'}
                  strokeWidth={1}
                />
              )}
              {/* Main Node Circle */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={16}
                fill="#111317"
                stroke={color}
                strokeOpacity={isHovered || isSelected ? 1 : 0.7}
                strokeWidth={1.5}
                style={{ transition: 'stroke-opacity 0.2s ease' }}
              />
              {/* Inner Dot */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r="3.5"
                fill={color}
              />
              {/* Service Label */}
              <text
                x={pos.x}
                y={pos.y + 30}
                fill={isHovered || isSelected ? '#ecedef' : '#969ca5'}
                fontSize="11"
                fontWeight={isHovered || isSelected ? 600 : 500}
                textAnchor="middle"
                style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)', pointerEvents: 'none' }}
              >
                {name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Edge Hover Tooltip */}
      {hoveredEdge && (
        <div style={{
          ...tooltipStyle,
          position: 'absolute',
          left: Math.min(tooltipPos.x + 14, dimensions.width - 190),
          top: Math.max(tooltipPos.y - 10, 8),
          zIndex: 10,
        }}>
          <div style={{ fontWeight: 600, marginBottom: '2px' }}>
            {shortName(hoveredEdge.sourceServiceId)} → {shortName(hoveredEdge.destServiceId)}
          </div>
          <TooltipRow label="Events">{hoveredEdge.eventCount}</TooltipRow>
          <TooltipRow label="Ports"><span style={{ fontFamily: MONO, fontSize: '11.5px' }}>:{hoveredEdge.destPorts?.join(', ')}</span></TooltipRow>
          <TooltipRow label="Last seen">{relativeTime(hoveredEdge.lastSeen)}</TooltipRow>
        </div>
      )}

      {/* Frequency Legend */}
      <div style={{
        position: 'absolute',
        bottom: '12px',
        left: '14px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '11px',
        color: 'var(--color-text-dim)',
        pointerEvents: 'none',
      }}>
        <svg width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="rgba(138,180,255,0.3)" strokeWidth="1" /></svg>
        <span>Low frequency</span>
        <svg width="24" height="6" style={{ marginLeft: '6px' }}><line x1="0" y1="3" x2="24" y2="3" stroke="rgba(138,180,255,0.75)" strokeWidth="3" /></svg>
        <span>High frequency</span>
      </div>
    </div>
  );
}

/**
 * Architectural Tiered Flow Topology
 */
function TieredTopologyMap({
  graph,
  maxEventCount,
  onSelectNode,
  selectedNode,
  filterQuery,
  targetId
}: {
  graph: TraceGraph | null;
  maxEventCount: number;
  onSelectNode: (node: string) => void;
  selectedNode: string | null;
  filterQuery?: string;
  targetId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 450 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<TraceGraphEdge | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setDims({
          width: containerRef.current.clientWidth || 800,
          height: containerRef.current.clientHeight || 450
        });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];

  const tieredNodes = useMemo(() => {
    const tiers: Record<number, string[]> = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    nodes.forEach(n => {
      const t = getServiceTier(shortName(n)).tier;
      tiers[t].push(n);
    });
    return tiers;
  }, [nodes]);

  const nodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const tierColumns = [0, 1, 2, 3, 4];
    const colWidth = dims.width / 5.2;
    const paddingX = dims.width * 0.08;

    tierColumns.forEach((tierIdx) => {
      const list = tieredNodes[tierIdx] || [];
      const colX = paddingX + tierIdx * colWidth;
      const count = list.length;

      list.forEach((node, i) => {
        const totalHeight = dims.height - 80;
        const spacing = totalHeight / Math.max(count + 1, 2);
        const y = 45 + (i + 1) * spacing;
        map.set(node, { x: colX, y });
      });
    });

    return map;
  }, [tieredNodes, dims]);

  const activeFocus = hoveredNode || selectedNode;
  const connectedSet = useMemo(() => {
    if (!activeFocus) return null;
    const set = new Set<string>([activeFocus]);
    edges.forEach(e => {
      if (e.sourceServiceId === activeFocus) set.add(e.destServiceId);
      if (e.destServiceId === activeFocus) set.add(e.sourceServiceId);
    });
    return set;
  }, [activeFocus, edges]);

  if (!graph || nodes.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <WifiOff size={20} {...ICON} color="var(--color-text-dim)" />
        <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No connection topology yet</div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          Waiting for the next telemetry cycle from <span style={{ fontFamily: MONO }}>{targetId}</span>
        </div>
      </div>
    );
  }

  const tierHeaders = [
    { label: 'Gateways', x: dims.width * 0.08 },
    { label: 'Frontend', x: dims.width * 0.08 + (dims.width / 5.2) * 1 },
    { label: 'Core services', x: dims.width * 0.08 + (dims.width / 5.2) * 2 },
    { label: 'Databases', x: dims.width * 0.08 + (dims.width / 5.2) * 3 },
    { label: 'Observability', x: dims.width * 0.08 + (dims.width / 5.2) * 4 },
  ];

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* Column Headers */}
      <div style={{
        position: 'absolute',
        top: '12px',
        left: 0,
        right: 0,
        pointerEvents: 'none',
        display: 'flex',
        zIndex: 2
      }}>
        {tierHeaders.map((th, i) => (
          <div key={i} className="mm-eyebrow" style={{
            position: 'absolute',
            left: `${th.x - 50}px`,
            textAlign: 'center',
            width: '100px'
          }}>
            {th.label}
          </div>
        ))}
      </div>

      <svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0 }}>
        {/* Edges */}
        {edges.map((edge) => {
          const src = nodePositions.get(edge.sourceServiceId);
          const dst = nodePositions.get(edge.destServiceId);
          if (!src || !dst) return null;

          const isEdgeHovered = hoveredEdge === edge;
          const isRelatedToFocus = connectedSet
            ? (connectedSet.has(edge.sourceServiceId) && connectedSet.has(edge.destServiceId))
            : true;

          const opacity = connectedSet
            ? (isRelatedToFocus ? (isEdgeHovered ? 1 : 0.7) : 0.08)
            : (isEdgeHovered ? 1 : 0.35);

          const safeMax = Math.max(1, maxEventCount);
          const thickness = Math.max(1.2, Math.min(5, 1 + (edge.eventCount / safeMax) * 4));

          const dx = dst.x - src.x;
          const curveFactor = Math.abs(dx) * 0.5;
          const pathD = `M ${src.x} ${src.y} C ${src.x + curveFactor} ${src.y}, ${dst.x - curveFactor} ${dst.y}, ${dst.x} ${dst.y}`;

          return (
            <g key={`${edge.sourceServiceId}->${edge.destServiceId}`}>
              <path
                d={pathD}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  setHoveredEdge(edge);
                  setTooltipPos({ x: e.clientX, y: e.clientY });
                }}
                onMouseLeave={() => setHoveredEdge(null)}
              />
              <path
                d={pathD}
                fill="none"
                stroke="#8ab4ff"
                strokeWidth={isEdgeHovered ? thickness + 0.75 : thickness}
                strokeOpacity={opacity}
                style={{ transition: 'stroke-opacity 0.2s, stroke-width 0.2s', pointerEvents: 'none' }}
              />
            </g>
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const pos = nodePositions.get(node);
          if (!pos) return null;

          const name = shortName(node);
          const color = serviceColor(name);
          const isHovered = hoveredNode === node;
          const isSelected = selectedNode === node;
          const isDimmed = connectedSet && !connectedSet.has(node);
          const matchesQuery = filterQuery ? name.toLowerCase().includes(filterQuery.toLowerCase()) : false;

          return (
            <g
              key={node}
              style={{ cursor: 'pointer', transition: 'opacity 0.2s' }}
              opacity={isDimmed ? 0.2 : 1}
              onClick={() => onSelectNode(node)}
              onMouseEnter={() => setHoveredNode(node)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              {(isHovered || isSelected || matchesQuery) && (
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={21}
                  fill="none"
                  stroke={isSelected || matchesQuery ? '#8ab4ff' : 'rgba(255,255,255,0.15)'}
                  strokeWidth={1}
                />
              )}

              <circle
                cx={pos.x}
                cy={pos.y}
                r={16}
                fill="#111317"
                stroke={color}
                strokeOpacity={isHovered || isSelected ? 1 : 0.7}
                strokeWidth={1.5}
              />

              <circle
                cx={pos.x}
                cy={pos.y}
                r={3.5}
                fill={color}
              />

              <text
                x={pos.x}
                y={pos.y + 30}
                fill={isSelected || isHovered ? '#ecedef' : '#969ca5'}
                fontSize="11"
                fontWeight={isSelected || isHovered ? 600 : 500}
                textAnchor="middle"
                style={{
                  pointerEvents: 'none',
                  textShadow: '0 1px 3px rgba(0,0,0,0.8)'
                }}
              >
                {name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Edge Tooltip */}
      {hoveredEdge && (
        <div style={{
          ...tooltipStyle,
          position: 'fixed',
          left: tooltipPos.x + 12,
          top: tooltipPos.y - 10,
          zIndex: 50,
        }}>
          <div style={{ fontWeight: 600, marginBottom: '2px' }}>
            {shortName(hoveredEdge.sourceServiceId)} → {shortName(hoveredEdge.destServiceId)}
          </div>
          <TooltipRow label="Events">{hoveredEdge.eventCount}</TooltipRow>
          <TooltipRow label="Port"><span style={{ fontFamily: MONO, fontSize: '11.5px' }}>:{hoveredEdge.destPorts?.join(', ')}</span></TooltipRow>
        </div>
      )}
    </div>
  );
}

/**
 * Traffic Matrix Heatmap View
 */
function TraceMatrixView({
  graph,
  onSelectCell
}: {
  graph: TraceGraph | null;
  onSelectCell: (src: string, dst: string) => void;
}) {
  const nodes = useMemo(() => {
    return (graph?.nodes || []).map(n => shortName(n)).sort();
  }, [graph]);

  const matrix = useMemo(() => {
    const map = new Map<string, number>();
    graph?.edges.forEach(e => {
      const key = `${shortName(e.sourceServiceId)}|${shortName(e.destServiceId)}`;
      map.set(key, e.eventCount);
    });
    return map;
  }, [graph]);

  if (!graph || nodes.length === 0) {
    return (
      <div style={{ ...emptyStateStyle, position: 'relative', flex: 1 }}>
        <Grid3X3 size={20} {...ICON} color="var(--color-text-dim)" />
        <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No matrix data yet</div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Service-to-service traffic will appear here once connections are captured</div>
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      overflow: 'auto',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600 }}>Communication matrix</div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
          Rows are callers, columns are callees. Click a cell to inspect its events.
        </div>
      </div>

      <div style={{ display: 'inline-block', minWidth: 'max-content' }}>
        {/* Header Row */}
        <div style={{ display: 'flex' }}>
          <div style={{ width: '140px', flexShrink: 0 }} />
          {nodes.map(n => (
            <div key={n} style={{
              width: '32px',
              height: '84px',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              paddingBottom: '6px'
            }}>
              <span style={{
                transform: 'rotate(-45deg)',
                transformOrigin: 'bottom center',
                fontSize: '11px',
                color: 'var(--color-text-muted)',
                whiteSpace: 'nowrap'
              }}>
                {n}
              </span>
            </div>
          ))}
        </div>

        {/* Matrix Rows */}
        {nodes.map(src => (
          <div key={src} style={{ display: 'flex', alignItems: 'center', height: '28px' }}>
            <div style={{
              width: '140px',
              fontSize: '12px',
              color: 'var(--color-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'right',
              paddingRight: '10px',
              boxSizing: 'border-box'
            }}>
              {src}
            </div>

            {nodes.map(dst => {
              const count = matrix.get(`${src}|${dst}`) || 0;
              const hasCalls = count > 0;
              const intensity = hasCalls ? Math.min(0.55, 0.12 + count / 40) : 0;

              return (
                <div
                  key={dst}
                  onClick={() => hasCalls && onSelectCell(src, dst)}
                  title={hasCalls ? `${src} -> ${dst}: ${count} events` : ''}
                  style={{
                    width: '28px',
                    height: '24px',
                    margin: '2px',
                    borderRadius: '4px',
                    background: hasCalls
                      ? `rgba(138,180,255, ${intensity})`
                      : 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--color-border)',
                    boxSizing: 'border-box',
                    cursor: hasCalls ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 550,
                    fontVariantNumeric: 'tabular-nums',
                    color: hasCalls ? 'var(--color-text-main)' : 'transparent',
                    transition: 'background 0.15s'
                  }}
                >
                  {hasCalls ? (count > 99 ? '99+' : count) : ''}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Live Event Stream View
 */
function TraceEventStreamView({
  events,
  isAutoScroll,
  onToggleAutoScroll,
  onSelectEvent,
  eventListRef
}: {
  events: ConnectionEvent[];
  isAutoScroll: boolean;
  onToggleAutoScroll: () => void;
  onSelectEvent: (event: ConnectionEvent) => void;
  eventListRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Stream Controls Bar */}
      <div style={{
        padding: '0 12px 0 16px',
        height: '48px',
        flexShrink: 0,
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity size={14} {...ICON} color="var(--color-text-muted)" />
          <span style={{ fontSize: '14px', fontWeight: 600 }}>Live feed</span>
          <span style={{ fontSize: '12px', color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
            {events.length}
          </span>
        </div>

        <button
          className={`mm-btn${isAutoScroll ? ' active' : ''}`}
          onClick={onToggleAutoScroll}
          style={{ height: '26px', padding: '0 10px', fontSize: '12px', cursor: 'pointer' }}
        >
          {isAutoScroll ? <Eye size={14} {...ICON} /> : <EyeOff size={14} {...ICON} />}
          {isAutoScroll ? 'Auto-scroll' : 'Paused'}
        </button>
      </div>

      {/* Events Table / List */}
      <div
        ref={eventListRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {events.length === 0 ? (
          <div style={{ ...emptyStateStyle, position: 'relative', flex: 1, padding: '30px 16px' }}>
            <ListFilter size={20} {...ICON} color="var(--color-text-dim)" />
            <span style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No events match these filters</span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Clear the search or pick another service</span>
          </div>
        ) : (
          events.slice().reverse().map((ev, idx) => (
            <div
              key={`${ev.timestamp}-${ev.sourceServiceId}-${ev.destServiceId}-${idx}`}
              onClick={() => onSelectEvent(ev)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(h => (h === idx ? null : h))}
              style={{
                display: 'grid',
                gridTemplateColumns: '64px 1fr 14px 1fr 56px',
                alignItems: 'center',
                gap: '8px',
                padding: '0 16px',
                minHeight: '36px',
                flexShrink: 0,
                borderBottom: '1px solid var(--color-border)',
                background: hoveredIdx === idx ? 'rgba(255,255,255,0.025)' : 'transparent',
                fontSize: '12.5px',
                cursor: 'pointer',
                transition: 'background 0.12s'
              }}
            >
              <span style={{ color: 'var(--color-text-dim)', fontSize: '11px', fontFamily: MONO }}>
                {new Date(ev.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>

              <span style={{
                color: 'var(--color-text-main)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {shortName(ev.sourceServiceId)}
              </span>

              <ArrowRight size={12} {...ICON} color="var(--color-text-dim)" />

              <span style={{
                color: 'var(--color-text-main)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {shortName(ev.destServiceId)}
              </span>

              <span style={{
                color: 'var(--color-text-muted)',
                fontFamily: MONO,
                fontSize: '11px',
                textAlign: 'right'
              }}>
                :{ev.destPort}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Node Inspector Drawer (Right Side)
 */
function NodeInspectorDrawer({
  nodeId,
  graph,
  events,
  onClose,
  onFilterEvents
}: {
  nodeId: string;
  graph: TraceGraph | null;
  events: ConnectionEvent[];
  onClose: () => void;
  onFilterEvents: (node: string) => void;
}) {
  const name = shortName(nodeId);
  const color = serviceColor(name);
  const tier = getServiceTier(name);

  const outEdges = (graph?.edges || []).filter(e => e.sourceServiceId === nodeId);
  const inEdges = (graph?.edges || []).filter(e => e.destServiceId === nodeId);

  const recentNodeEvents = (events || [])
    .filter(e => e.sourceServiceId === nodeId || e.destServiceId === nodeId)
    .slice(-4);

  const rowStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '10px',
    minHeight: '32px',
    borderBottom: '1px solid var(--color-border)',
    fontSize: '12.5px'
  };

  return (
    <div style={{
      width: '300px',
      flexShrink: 0,
      borderLeft: '1px solid var(--color-border)',
      background: 'var(--color-bg-panel)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10
    }}>
      <div style={{
        padding: '0 12px 0 16px',
        height: '48px',
        flexShrink: 0,
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <i className="mm-dot" style={{ background: color }} />
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</h3>
        </div>
        <button className="mm-icon-btn" onClick={onClose} title="Close">
          <X size={16} {...ICON} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <div className="mm-eyebrow">Architecture tier</div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-main)', marginTop: '4px' }}>{tier.label}</div>
        </div>

        {/* Outbound Calls */}
        <div>
          <div className="mm-eyebrow" style={{ marginBottom: '4px' }}>
            Outbound connections · {outEdges.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {outEdges.map(e => (
              <div key={e.destServiceId} style={rowStyle}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(e.destServiceId)}</span>
                <span style={{ color: 'var(--color-text-muted)', fontSize: '11.5px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontFamily: MONO }}>:{e.destPorts?.join(',')}</span> · {e.eventCount}×
                </span>
              </div>
            ))}
            {outEdges.length === 0 && <span style={{ fontSize: '12px', color: 'var(--color-text-dim)', paddingTop: '4px' }}>None</span>}
          </div>
        </div>

        {/* Inbound Calls */}
        <div>
          <div className="mm-eyebrow" style={{ marginBottom: '4px' }}>
            Inbound clients · {inEdges.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {inEdges.map(e => (
              <div key={e.sourceServiceId} style={rowStyle}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(e.sourceServiceId)}</span>
                <span style={{ color: 'var(--color-text-muted)', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>
                  {e.eventCount}×
                </span>
              </div>
            ))}
            {inEdges.length === 0 && <span style={{ fontSize: '12px', color: 'var(--color-text-dim)', paddingTop: '4px' }}>None</span>}
          </div>
        </div>

        {/* Recent Traffic Samples */}
        {recentNodeEvents.length > 0 && (
          <div>
            <div className="mm-eyebrow" style={{ marginBottom: '4px' }}>
              Recent snapshots
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recentNodeEvents.map((re, idx) => (
                <div key={idx} style={{ ...rowStyle, fontSize: '12px', color: 'var(--color-text-muted)' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {shortName(re.sourceServiceId)} → {shortName(re.destServiceId)}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', color: 'var(--color-text-main)' }}>
                    <i className="mm-dot" style={{ background: re.state === 'ESTABLISHED' ? 'var(--color-healthy)' : 'var(--color-unknown)' }} />
                    {sentenceCase(re.state)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          className="mm-btn"
          onClick={() => onFilterEvents(nodeId)}
          style={{
            marginTop: 'auto',
            width: '100%',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0
          }}
        >
          <ListFilter size={14} {...ICON} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Filter stream to {name}</span>
        </button>
      </div>
    </div>
  );
}
