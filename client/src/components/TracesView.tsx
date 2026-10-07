import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Activity, Zap, Play, Square, Clock, ArrowRight, ShieldAlert, 
  WifiOff, Circle, Search, Filter, RefreshCw, Layers, Grid3X3, 
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
  { value: 60, label: '1 Minute' },
  { value: 300, label: '5 Minutes' },
  { value: 900, label: '15 Minutes' },
  { value: 3600, label: '1 Hour' },
  { value: 86400, label: '24 Hours' },
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
    return { tier: 0, label: 'Gateway & Ingress' };
  }
  if (n.includes('frontend') || n.includes('ui') || n.includes('web')) {
    return { tier: 1, label: 'Frontend Tier' };
  }
  if (n.includes('db') || n.includes('postgres') || n.includes('mysql') || n.includes('mongo') || n.includes('redis') || n.includes('valkey')) {
    return { tier: 3, label: 'Data & Storage' };
  }
  if (n.includes('otel') || n.includes('collector') || n.includes('jaeger') || n.includes('prometheus') || n.includes('grafana') || n.includes('opensearch') || n.includes('flagd') || n.includes('opamp')) {
    return { tier: 4, label: 'Observability & Infra' };
  }
  return { tier: 2, label: 'Core Microservices' };
}

/** Stable color palette generator */
function serviceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

function relativeTime(iso: string) {
  if (!iso) return 'just now';
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return `${Math.round(diffSec / 3600)}h ago`;
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
      gap: '14px',
      padding: embedded ? '8px 24px 20px 24px' : '18px 28px 24px 28px',
      color: 'var(--color-text-main)',
      height: embedded ? '740px' : '100%',
      boxSizing: 'border-box',
      background: 'radial-gradient(ellipse at 85% 15%, rgba(0, 212, 255, 0.04) 0%, rgba(5, 6, 12, 0.8) 70%)',
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
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, rgba(0, 212, 255, 0.2), rgba(168, 85, 247, 0.2))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid rgba(0, 212, 255, 0.3)'
            }}>
              <Zap size={18} color="var(--color-accent-cyan)" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 800, letterSpacing: '-0.4px', textTransform: 'capitalize' }}>
                  Connection Tracing & Live Flow
                </h1>
                {/* Live Status Pill */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '3px 10px',
                  borderRadius: '16px',
                  fontSize: '10px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.6px',
                  background: isReceivingData ? 'rgba(0, 230, 118, 0.12)' : 'rgba(255, 171, 0, 0.12)',
                  color: isReceivingData ? 'var(--color-healthy)' : 'var(--color-degraded)',
                  border: `1px solid ${isReceivingData ? 'rgba(0, 230, 118, 0.35)' : 'rgba(255, 171, 0, 0.35)'}`,
                }}>
                  <Circle size={6} fill="currentColor" style={{
                    animation: isReceivingData ? 'pulse-critical 1.8s infinite' : 'none'
                  }} />
                  {isReceivingData ? 'LIVE INGESTION' : 'READY / IDLE'}
                </div>
              </div>
              <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>
                Target: <span style={{ color: 'var(--color-accent-cyan)', fontWeight: 600 }}>{targetId}</span> · Real-time kernel TCP socket inspection (/proc/net/tcp)
              </p>
            </div>
          </div>
        </div>

        {/* Global Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* View Modes */}
          <div style={{
            display: 'flex',
            background: 'rgba(255, 255, 255, 0.03)',
            borderRadius: '10px',
            padding: '3px',
            border: '1px solid var(--color-border)'
          }}>
            <button
              onClick={() => setViewMode('TOPOLOGY')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 12px',
                borderRadius: '7px',
                border: 'none',
                background: viewMode === 'TOPOLOGY' ? 'rgba(0, 212, 255, 0.18)' : 'transparent',
                color: viewMode === 'TOPOLOGY' ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              <Layers size={13} />
              Topology
            </button>
            <button
              onClick={() => setViewMode('MATRIX')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 12px',
                borderRadius: '7px',
                border: 'none',
                background: viewMode === 'MATRIX' ? 'rgba(0, 212, 255, 0.18)' : 'transparent',
                color: viewMode === 'MATRIX' ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              <Grid3X3 size={13} />
              Matrix
            </button>
            <button
              onClick={() => setViewMode('EVENTS')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 12px',
                borderRadius: '7px',
                border: 'none',
                background: viewMode === 'EVENTS' ? 'rgba(0, 212, 255, 0.18)' : 'transparent',
                color: viewMode === 'EVENTS' ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              <ListFilter size={13} />
              Event Stream
            </button>
          </div>

          {/* Topology Layout Selector (Circular vs Tiered) */}
          {viewMode === 'TOPOLOGY' && (
            <div style={{
              display: 'flex',
              background: 'rgba(255, 255, 255, 0.03)',
              borderRadius: '10px',
              padding: '3px',
              border: '1px solid var(--color-border)'
            }}>
              <button
                onClick={() => setTopoLayout('CIRCULAR')}
                title="Circular network ring layout from previous version"
                style={{
                  padding: '5px 10px',
                  borderRadius: '7px',
                  border: 'none',
                  background: topoLayout === 'CIRCULAR' ? 'rgba(168, 85, 247, 0.22)' : 'transparent',
                  color: topoLayout === 'CIRCULAR' ? '#c084fc' : 'var(--color-text-muted)',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                Circular Ring
              </button>
              <button
                onClick={() => setTopoLayout('TIERED')}
                title="Architectural multi-column flow layout"
                style={{
                  padding: '5px 10px',
                  borderRadius: '7px',
                  border: 'none',
                  background: topoLayout === 'TIERED' ? 'rgba(0, 212, 255, 0.18)' : 'transparent',
                  color: topoLayout === 'TIERED' ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                Tiered Flow
              </button>
            </div>
          )}

          {/* Split Screen / Side Stream Toggle */}
          {viewMode === 'TOPOLOGY' && (
            <button
              onClick={() => setShowSideStream(!showSideStream)}
              title={showSideStream ? 'Hide Side Event Stream (Full View)' : 'Show Side Event Stream (Split View)'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: showSideStream ? 'rgba(0, 212, 255, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                border: `1px solid ${showSideStream ? 'rgba(0, 212, 255, 0.3)' : 'var(--color-border)'}`,
                color: showSideStream ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
                borderRadius: '8px',
                padding: '6px 10px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {showSideStream ? <Columns3 size={13} /> : <Maximize2 size={13} />}
              {showSideStream ? 'Split Feed' : 'Full Canvas'}
            </button>
          )}

          {/* Time Window */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'rgba(255, 255, 255, 0.03)',
            padding: '5px 10px',
            borderRadius: '10px',
            border: '1px solid var(--color-border)'
          }}>
            <Clock size={12} color="var(--color-text-muted)" />
            <select
              value={windowSec}
              onChange={(e) => setWindowSec(parseInt(e.target.value))}
              style={{
                background: 'transparent',
                color: 'var(--color-text-main)',
                border: 'none',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                outline: 'none'
              }}
            >
              {WINDOW_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value} style={{ background: '#0a0d18' }}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Refresh */}
          <button
            onClick={() => fetchData()}
            title="Refresh Trace Data"
            style={{
              padding: '7px 9px',
              borderRadius: '8px',
              border: '1px solid var(--color-border)',
              background: 'rgba(255,255,255,0.03)',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s'
            }}
          >
            <RefreshCw size={13} className={isLoading ? 'spin' : ''} />
          </button>

          {/* Toggle Collection */}
          <button
            onClick={toggleCollection}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: isCollecting ? 'rgba(255, 23, 68, 0.12)' : 'rgba(0, 212, 255, 0.12)',
              color: isCollecting ? 'var(--color-critical)' : 'var(--color-accent-cyan)',
              border: `1px solid ${isCollecting ? 'rgba(255,23,68,0.35)' : 'rgba(0,212,255,0.35)'}`,
              borderRadius: '8px',
              padding: '6px 12px',
              fontSize: '11px',
              fontWeight: 700,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}
          >
            {isCollecting ? <Square size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
            {isCollecting ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>

      {/* KPI Stats Bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '12px'
      }}>
        <div style={{
          background: 'rgba(14, 18, 34, 0.6)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
            Captured Events
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '4px' }}>
            <span style={{ fontSize: '18px', fontWeight: 800, color: 'var(--color-accent-cyan)' }}>
              {stats.totalEvents.toLocaleString()}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--color-text-dim)' }}>
              in buffer
            </span>
          </div>
        </div>

        <div style={{
          background: 'rgba(14, 18, 34, 0.6)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
            Connected Services
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '4px' }}>
            <span style={{ fontSize: '18px', fontWeight: 800, color: '#38bdf8' }}>
              {stats.activeServicesCount}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--color-text-dim)' }}>
              nodes
            </span>
          </div>
        </div>

        <div style={{
          background: 'rgba(14, 18, 34, 0.6)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
            Active TCP Streams
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '4px' }}>
            <span style={{ fontSize: '18px', fontWeight: 800, color: 'var(--color-healthy)' }}>
              {stats.activeStreamsCount}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--color-text-dim)' }}>
              directed links
            </span>
          </div>
        </div>

        <div style={{
          background: 'rgba(14, 18, 34, 0.6)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
            Top Interaction
          </span>
          <div style={{ marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-accent-magenta)' }}>
              {stats.topPair}
            </span>
            {stats.topPairCount > 0 && (
              <span style={{ fontSize: '10px', color: 'var(--color-text-dim)', marginLeft: '6px' }}>
                ({stats.topPairCount}×)
              </span>
            )}
          </div>
        </div>

        <div style={{
          background: 'rgba(14, 18, 34, 0.6)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
            Common Ports
          </span>
          <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
            {stats.topPorts.map(port => (
              <span key={port} style={{
                background: 'rgba(255,255,255,0.06)',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--color-text-main)',
                fontFamily: 'monospace'
              }}>
                :{port}
              </span>
            ))}
            {stats.topPorts.length === 0 && (
              <span style={{ fontSize: '11px', color: 'var(--color-text-dim)' }}>None</span>
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
        padding: '6px 12px',
        background: 'rgba(10, 13, 24, 0.5)',
        borderRadius: '10px',
        border: '1px solid var(--color-border)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '240px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(0,0,0,0.3)',
            padding: '4px 10px',
            borderRadius: '6px',
            border: '1px solid var(--color-border)',
            flex: 1,
            maxWidth: '300px'
          }}>
            <Search size={13} color="var(--color-text-muted)" />
            <input
              type="text"
              placeholder="Filter by service name or port..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#fff',
                fontSize: '11px',
                width: '100%'
              }}
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 0 }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Service Dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Filter size={12} color="var(--color-text-muted)" />
            <select
              value={selectedService || ''}
              onChange={(e) => setSelectedService(e.target.value || null)}
              style={{
                background: 'rgba(0,0,0,0.3)',
                color: selectedService ? 'var(--color-accent-cyan)' : 'var(--color-text-main)',
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                padding: '4px 8px',
                fontSize: '11px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              <option value="" style={{ background: '#0a0d18' }}>All Services</option>
              {allServiceNames.map(svc => (
                <option key={svc} value={svc} style={{ background: '#0a0d18' }}>{svc}</option>
              ))}
            </select>
          </div>

          {/* State Filter */}
          <div style={{ display: 'flex', gap: '4px' }}>
            {(['ALL', 'ESTABLISHED', 'TIME_WAIT'] as const).map(st => (
              <button
                key={st}
                onClick={() => setSelectedState(st)}
                style={{
                  padding: '3px 8px',
                  borderRadius: '5px',
                  border: 'none',
                  background: selectedState === st ? 'rgba(0, 212, 255, 0.15)' : 'transparent',
                  color: selectedState === st ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
                  fontSize: '10px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        {/* Clear filter */}
        {(selectedService || searchQuery || selectedState !== 'ALL') && (
          <button
            onClick={() => { setSelectedService(null); setSearchQuery(''); setSelectedState('ALL'); }}
            style={{
              background: 'rgba(255, 23, 68, 0.1)',
              border: '1px solid rgba(255, 23, 68, 0.25)',
              borderRadius: '6px',
              padding: '3px 8px',
              color: 'var(--color-critical)',
              fontSize: '10px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Reset Filters
          </button>
        )}
      </div>

      {/* Main Content Area */}
      <div style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        borderRadius: '16px',
        overflow: 'hidden',
        border: '1px solid var(--color-border)',
        background: 'rgba(10, 13, 24, 0.85)',
        backdropFilter: 'blur(20px)'
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
                background: 'rgba(5, 7, 16, 0.8)',
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
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#0a0d18',
              border: '1px solid var(--color-border-glow)',
              borderRadius: '14px',
              padding: '24px',
              maxWidth: '520px',
              width: '90%',
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Zap size={18} color="var(--color-accent-cyan)" />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>Connection Event Details</h3>
              </div>
              <button 
                onClick={() => setSelectedEvent(null)}
                style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              fontSize: '12px',
              fontFamily: 'monospace'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Source Service</span>
                <span style={{ color: serviceColor(shortName(selectedEvent.sourceServiceId)), fontWeight: 700 }}>{selectedEvent.sourceServiceId}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Destination Service</span>
                <span style={{ color: serviceColor(shortName(selectedEvent.destServiceId)), fontWeight: 700 }}>{selectedEvent.destServiceId}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Destination Port</span>
                <span style={{ color: '#fff', fontWeight: 700 }}>{selectedEvent.destPort}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>TCP State</span>
                <span style={{ 
                  color: selectedEvent.state === 'ESTABLISHED' ? 'var(--color-healthy)' : 'var(--color-degraded)', 
                  fontWeight: 700 
                }}>{selectedEvent.state}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Timestamp</span>
                <span style={{ color: 'var(--color-text-main)' }}>{new Date(selectedEvent.timestamp).toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Target Host ID</span>
                <span style={{ color: 'var(--color-accent-cyan)' }}>{selectedEvent.targetId}</span>
              </div>
            </div>

            <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={() => {
                  setSelectedService(shortName(selectedEvent.sourceServiceId));
                  setSelectedEvent(null);
                  setViewMode('EVENTS');
                }}
                style={{
                  background: 'rgba(0, 212, 255, 0.15)',
                  border: '1px solid var(--color-accent-cyan)',
                  color: 'var(--color-accent-cyan)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Filter by Source
              </button>
              <button
                onClick={() => setSelectedEvent(null)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid var(--color-border)',
                  color: '#fff',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
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
        fontSize: '10px',
        color: 'var(--color-text-dim)',
        padding: '0 4px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ShieldAlert size={11} color="var(--color-text-muted)" />
          <span>Kernel-level TCP snapshots sampled via SSH every ~5s. Micro-connections under 5s may be aggregated or missed.</span>
        </div>
        <span>Microservice Mapper v1.0 · OpenTelemetry Engine</span>
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
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-muted)',
        opacity: 0.5
      }}>
        <WifiOff size={44} style={{ marginBottom: '12px' }} />
        <div style={{ fontSize: '14px', fontWeight: 600 }}>No connections observed yet</div>
        <div style={{ fontSize: '11px', marginTop: '4px' }}>Awaiting TCP connection events from host</div>
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
            <path d="M0,0 L8,3 L0,6 Z" fill="rgba(0, 212, 255, 0.75)" />
          </marker>
          <filter id="trace-node-glow-orig">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Central Ambient Ring */}
        <circle
          cx={dimensions.width / 2}
          cy={dimensions.height / 2}
          r={Math.min(dimensions.width / 2, dimensions.height / 2) * 0.72}
          fill="none"
          stroke="rgba(255, 255, 255, 0.03)"
          strokeWidth="1"
          strokeDasharray="4 6"
        />

        {/* Edges */}
        {edges.map((edge) => {
          const src = nodePositions.get(edge.sourceServiceId);
          const dst = nodePositions.get(edge.destServiceId);
          if (!src || !dst) return null;

          const isDimmed = !!activeFocus && !(highlighted!.has(edge.sourceServiceId) && highlighted!.has(edge.destServiceId));
          const isEdgeHovered = hoveredEdge === edge;

          const thickness = 1 + (edge.eventCount / Math.max(1, maxEventCount)) * 4;
          const baseOpacity = 0.3 + (edge.eventCount / Math.max(1, maxEventCount)) * 0.5;
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
                stroke={isEdgeHovered ? 'rgba(0, 230, 255, 0.95)' : 'rgba(0, 212, 255, 0.5)'}
                strokeWidth={isEdgeHovered ? thickness + 1 : thickness}
                strokeOpacity={opacity}
                markerEnd="url(#trace-arrowhead-orig)"
                style={{ transition: 'stroke-width 0.15s ease, stroke-opacity 0.25s ease', pointerEvents: 'none' }}
              />
              {/* Event count label */}
              <text
                x={(startX + endX) / 2}
                y={(startY + endY) / 2 - 6}
                fill={isDimmed ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.45)'}
                fontSize="9"
                textAnchor="middle"
                fontFamily="monospace"
                fontWeight="600"
                style={{ pointerEvents: 'none', transition: 'fill 0.25s ease' }}
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
              {/* Outer Glow */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={isHovered || isSelected ? 24 : 18}
                fill={color}
                opacity={isHovered || isSelected ? 0.22 : 0.08}
                filter="url(#trace-node-glow-orig)"
                style={{ transition: 'r 0.2s ease, opacity 0.2s ease' }}
              />
              {/* Main Node Circle */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={isHovered || isSelected ? 18 : 16}
                fill="rgba(12, 12, 24, 0.92)"
                stroke={color}
                strokeWidth={isSelected ? 3 : (isHovered ? 2.5 : 1.5)}
                style={{ transition: 'all 0.2s ease' }}
              />
              {/* Inner Dot */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r="4"
                fill={color}
                opacity={0.85}
              />
              {/* Service Label */}
              <text
                x={pos.x}
                y={pos.y + 28}
                fill={color}
                fontSize={isHovered || isSelected ? 11 : 10}
                fontWeight={isHovered || isSelected ? 800 : 600}
                textAnchor="middle"
                fontFamily="'Inter', system-ui, sans-serif"
                style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)', transition: 'font-size 0.15s ease' }}
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
          position: 'absolute',
          left: Math.min(tooltipPos.x + 14, dimensions.width - 190),
          top: Math.max(tooltipPos.y - 10, 8),
          background: 'rgba(10, 12, 20, 0.96)',
          border: '1px solid rgba(0, 212, 255, 0.35)',
          borderRadius: '8px',
          padding: '10px 12px',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: '#e6edf3',
          pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          minWidth: '160px',
          zIndex: 10,
        }}>
          <div style={{ fontWeight: 700, marginBottom: '6px', color: 'var(--color-accent-cyan)' }}>
            {shortName(hoveredEdge.sourceServiceId)} → {shortName(hoveredEdge.destServiceId)}
          </div>
          <div style={{ opacity: 0.85 }}>events: <b>{hoveredEdge.eventCount}</b></div>
          <div style={{ opacity: 0.85 }}>ports: :{hoveredEdge.destPorts?.join(', ')}</div>
          <div style={{ opacity: 0.85 }}>last seen: {relativeTime(hoveredEdge.lastSeen)}</div>
        </div>
      )}

      {/* Frequency Legend */}
      <div style={{
        position: 'absolute',
        bottom: '12px',
        left: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '9px',
        color: 'rgba(255,255,255,0.4)',
        fontFamily: 'monospace',
        pointerEvents: 'none',
      }}>
        <svg width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="rgba(0,212,255,0.35)" strokeWidth="1" /></svg>
        <span>low freq</span>
        <svg width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="rgba(0,212,255,0.85)" strokeWidth="3" /></svg>
        <span>high freq</span>
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
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-muted)',
        opacity: 0.5
      }}>
        <WifiOff size={44} style={{ marginBottom: '12px' }} />
        <div style={{ fontSize: '14px', fontWeight: 600 }}>No connection topology found</div>
        <div style={{ fontSize: '11px', marginTop: '4px' }}>Awaiting telemetry cycle from host {targetId}</div>
      </div>
    );
  }

  const tierHeaders = [
    { label: 'Gateways', x: dims.width * 0.08 },
    { label: 'Frontend', x: dims.width * 0.08 + (dims.width / 5.2) * 1 },
    { label: 'Core Services', x: dims.width * 0.08 + (dims.width / 5.2) * 2 },
    { label: 'Databases', x: dims.width * 0.08 + (dims.width / 5.2) * 3 },
    { label: 'Observability', x: dims.width * 0.08 + (dims.width / 5.2) * 4 },
  ];

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* Column Headers */}
      <div style={{
        position: 'absolute',
        top: '10px',
        left: 0,
        right: 0,
        pointerEvents: 'none',
        display: 'flex',
        zIndex: 2
      }}>
        {tierHeaders.map((th, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: `${th.x - 40}px`,
            fontSize: '9px',
            fontWeight: 700,
            color: 'var(--color-text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.8px',
            textAlign: 'center',
            width: '80px'
          }}>
            {th.label}
          </div>
        ))}
      </div>

      <svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0 }}>
        <defs>
          <linearGradient id="edge-grad-tiered" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#a855f7" stopOpacity="0.8" />
          </linearGradient>
          <filter id="glow-node-tiered">
            <feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

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
            ? (isRelatedToFocus ? (isEdgeHovered ? 1 : 0.75) : 0.08)
            : (isEdgeHovered ? 1 : 0.35);

          const safeMax = Math.max(1, maxEventCount);
          const thickness = Math.max(1.2, Math.min(6, 1 + (edge.eventCount / safeMax) * 5));

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
                stroke={isEdgeHovered ? '#00d4ff' : 'url(#edge-grad-tiered)'}
                strokeWidth={isEdgeHovered ? thickness + 1.5 : thickness}
                strokeOpacity={opacity}
                strokeDasharray={isEdgeHovered ? '4 2' : 'none'}
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
                  r={22}
                  fill={color}
                  opacity={0.25}
                  filter="url(#glow-node-tiered)"
                />
              )}

              <circle
                cx={pos.x}
                cy={pos.y}
                r={16}
                fill="#0f1424"
                stroke={color}
                strokeWidth={isSelected ? 3 : (isHovered ? 2.5 : 1.5)}
              />

              <circle
                cx={pos.x}
                cy={pos.y}
                r={5}
                fill={color}
              />

              <text
                x={pos.x}
                y={pos.y + 26}
                fill="#f8fafc"
                fontSize="10"
                fontWeight={isSelected || isHovered ? 700 : 500}
                textAnchor="middle"
                style={{
                  pointerEvents: 'none',
                  textShadow: '0 2px 4px rgba(0,0,0,0.9)'
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
          position: 'fixed',
          left: tooltipPos.x + 12,
          top: tooltipPos.y - 10,
          background: 'rgba(10, 13, 24, 0.95)',
          border: '1px solid var(--color-border-glow)',
          borderRadius: '8px',
          padding: '8px 12px',
          fontSize: '11px',
          fontFamily: 'monospace',
          zIndex: 50,
          pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)'
        }}>
          <div style={{ color: 'var(--color-accent-cyan)', fontWeight: 700, marginBottom: '4px' }}>
            {shortName(hoveredEdge.sourceServiceId)} → {shortName(hoveredEdge.destServiceId)}
          </div>
          <div>Call Count: <b>{hoveredEdge.eventCount}</b> events</div>
          <div>Target Port: <b>:{hoveredEdge.destPorts?.join(', ')}</b></div>
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
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
        No matrix data available.
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      overflow: 'auto',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{ marginBottom: '12px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
        Communication Matrix (Rows: Source caller, Columns: Destination callee). Click any cell to inspect events.
      </div>

      <div style={{ display: 'inline-block', minWidth: 'max-content' }}>
        {/* Header Row */}
        <div style={{ display: 'flex' }}>
          <div style={{ width: '130px', flexShrink: 0 }} />
          {nodes.map(n => (
            <div key={n} style={{
              width: '32px',
              height: '80px',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              paddingBottom: '6px'
            }}>
              <span style={{
                transform: 'rotate(-45deg)',
                transformOrigin: 'bottom center',
                fontSize: '9px',
                color: 'var(--color-text-muted)',
                fontWeight: 600,
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
              width: '130px',
              fontSize: '11px',
              fontWeight: 600,
              color: serviceColor(src),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'right',
              paddingRight: '10px'
            }}>
              {src}
            </div>

            {nodes.map(dst => {
              const count = matrix.get(`${src}|${dst}`) || 0;
              const hasCalls = count > 0;
              const intensity = hasCalls ? Math.min(1, 0.2 + count / 20) : 0;

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
                      ? `rgba(0, 212, 255, ${intensity})` 
                      : 'rgba(255, 255, 255, 0.02)',
                    border: hasCalls 
                      ? '1px solid rgba(0, 212, 255, 0.4)' 
                      : '1px solid rgba(255, 255, 255, 0.04)',
                    cursor: hasCalls ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '9px',
                    fontWeight: 700,
                    color: hasCalls ? '#fff' : 'transparent',
                    transition: 'all 0.15s'
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
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Stream Controls Bar */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'rgba(0,0,0,0.25)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity size={14} color="var(--color-accent-cyan)" />
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Real-time Feed</span>
          <span style={{ fontSize: '10px', color: 'var(--color-text-dim)', marginLeft: '4px' }}>
            ({events.length})
          </span>
        </div>

        <button
          onClick={onToggleAutoScroll}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: isAutoScroll ? 'rgba(0, 212, 255, 0.12)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${isAutoScroll ? 'rgba(0, 212, 255, 0.3)' : 'var(--color-border)'}`,
            color: isAutoScroll ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
            borderRadius: '6px',
            padding: '3px 8px',
            fontSize: '10px',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          {isAutoScroll ? <Eye size={11} /> : <EyeOff size={11} />}
          {isAutoScroll ? 'Auto-scroll' : 'Paused'}
        </button>
      </div>

      {/* Events Table / List */}
      <div
        ref={eventListRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          fontFamily: "'JetBrains Mono', monospace"
        }}
      >
        {events.length === 0 ? (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-muted)',
            opacity: 0.5,
            padding: '30px 0'
          }}>
            <ShieldAlert size={24} style={{ marginBottom: '8px' }} />
            <span style={{ fontSize: '12px', fontWeight: 600 }}>No Events Match Filters</span>
            <span style={{ fontSize: '10px', marginTop: '4px' }}>Clear search query or select another service</span>
          </div>
        ) : (
          events.slice().reverse().map((ev, idx) => (
            <div
              key={`${ev.timestamp}-${ev.sourceServiceId}-${ev.destServiceId}-${idx}`}
              onClick={() => onSelectEvent(ev)}
              style={{
                display: 'grid',
                gridTemplateColumns: '62px 1fr 14px 1fr 50px',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 8px',
                borderRadius: '5px',
                background: idx === 0 ? 'rgba(0, 212, 255, 0.05)' : 'rgba(255,255,255,0.015)',
                border: '1px solid rgba(255, 255, 255, 0.04)',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              <span style={{ color: 'var(--color-text-dim)', fontSize: '9px' }}>
                {new Date(ev.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>

              <span style={{
                color: serviceColor(shortName(ev.sourceServiceId)),
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '10px'
              }}>
                {shortName(ev.sourceServiceId)}
              </span>

              <ArrowRight size={9} color="var(--color-text-dim)" />

              <span style={{
                color: serviceColor(shortName(ev.destServiceId)),
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '10px'
              }}>
                {shortName(ev.destServiceId)}
              </span>

              <span style={{
                color: 'var(--color-text-muted)',
                background: 'rgba(0,0,0,0.3)',
                padding: '1px 4px',
                borderRadius: '3px',
                fontSize: '9px',
                textAlign: 'center'
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

  return (
    <div style={{
      width: '300px',
      borderLeft: '1px solid var(--color-border)',
      background: 'rgba(7, 10, 20, 0.95)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10
    }}>
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
          <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 800 }}>{name}</h3>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}>
          <X size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <span style={{ fontSize: '10px', color: 'var(--color-text-dim)', textTransform: 'uppercase', fontWeight: 600 }}>Architecture Tier</span>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#fff', marginTop: '2px' }}>{tier.label}</div>
        </div>

        {/* Outbound Calls */}
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-accent-cyan)', marginBottom: '8px' }}>
            Outbound Connections ({outEdges.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {outEdges.map(e => (
              <div key={e.destServiceId} style={{
                background: 'rgba(255,255,255,0.03)',
                padding: '6px 10px',
                borderRadius: '6px',
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '11px'
              }}>
                <span>→ {shortName(e.destServiceId)}</span>
                <span style={{ color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>
                  :{e.destPorts?.join(',')} ({e.eventCount}×)
                </span>
              </div>
            ))}
            {outEdges.length === 0 && <span style={{ fontSize: '11px', color: 'var(--color-text-dim)' }}>None</span>}
          </div>
        </div>

        {/* Inbound Calls */}
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-accent-magenta)', marginBottom: '8px' }}>
            Inbound Clients ({inEdges.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {inEdges.map(e => (
              <div key={e.sourceServiceId} style={{
                background: 'rgba(255,255,255,0.03)',
                padding: '6px 10px',
                borderRadius: '6px',
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '11px'
              }}>
                <span>← {shortName(e.sourceServiceId)}</span>
                <span style={{ color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>
                  {e.eventCount}×
                </span>
              </div>
            ))}
            {inEdges.length === 0 && <span style={{ fontSize: '11px', color: 'var(--color-text-dim)' }}>None</span>}
          </div>
        </div>

        {/* Recent Traffic Samples */}
        {recentNodeEvents.length > 0 && (
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', marginBottom: '8px' }}>
              Recent Snapshots
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '10px', fontFamily: 'monospace' }}>
              {recentNodeEvents.map((re, idx) => (
                <div key={idx} style={{
                  background: 'rgba(255,255,255,0.02)',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  color: 'var(--color-text-muted)'
                }}>
                  <span>{shortName(re.sourceServiceId)} → {shortName(re.destServiceId)}</span>
                  <span style={{ color: re.state === 'ESTABLISHED' ? 'var(--color-healthy)' : 'var(--color-degraded)' }}>
                    {re.state}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={() => onFilterEvents(nodeId)}
          style={{
            marginTop: 'auto',
            background: 'rgba(0, 212, 255, 0.15)',
            border: '1px solid var(--color-accent-cyan)',
            color: 'var(--color-accent-cyan)',
            borderRadius: '8px',
            padding: '8px',
            fontSize: '11px',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px'
          }}
        >
          <ListFilter size={13} />
          Filter Stream to {name}
        </button>
      </div>
    </div>
  );
}
