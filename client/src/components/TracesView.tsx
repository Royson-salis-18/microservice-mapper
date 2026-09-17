import { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, Zap, Play, Square, Clock, ArrowRight, ShieldAlert, WifiOff, Circle } from 'lucide-react';

/**
 * Connection Traces View — SSH-sampled TCP connection events.
 * 
 * This is NOT distributed tracing (no OpenTelemetry/Zipkin spans).
 * It shows raw TCP connections between containers, captured by reading
 * /proc/net/tcp on the remote host at collection-cycle granularity.
 * 
 * Limitations:
 * - Samples at ~5s intervals; short-lived connections may be missed
 * - No per-request latency information
 * - Shows connections, not individual HTTP requests
 */

interface ConnectionEvent {
  timestamp: string;
  targetId: string;
  sourceServiceId: string;
  destServiceId: string;
  destPort: number;
  state: string;
}

interface TraceGraphEdge {
  sourceServiceId: string;
  destServiceId: string;
  eventCount: number;
  firstSeen: string;
  lastSeen: string;
  destPorts: string[];
}

interface TraceGraph {
  nodes: string[];
  edges: TraceGraphEdge[];
}

const WINDOW_OPTIONS = [
  { value: 60, label: '1 Minute' },
  { value: 300, label: '5 Minutes' },
  { value: 3600, label: '1 Hour' },
  { value: 86400, label: '24 Hours' },
];

/** Strip the target prefix from a service ID for display, e.g. "sock-shop:catalogue" → "catalogue" */
function shortName(serviceId: string): string {
  const idx = serviceId.indexOf(':');
  return idx >= 0 ? serviceId.substring(idx + 1) : serviceId;
}

/** Generate a stable color for a service name */
function serviceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

export function TracesView({ targetId, embedded = false }: { targetId: string; embedded?: boolean }) {
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [graph, setGraph] = useState<TraceGraph | null>(null);
  const [windowSec, setWindowSec] = useState(300);
  const [isCollecting, setIsCollecting] = useState(false);
  const [lastEventTime, setLastEventTime] = useState<string | null>(null);
  const eventListRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Connect to WebSocket for real-time trace events
  useEffect(() => {
    if (!targetId) return;

    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'trace-events' && msg.data?.targetId === targetId) {
          const newEvents: ConnectionEvent[] = msg.data.events || [];
          if (newEvents.length > 0) {
            setEvents(prev => {
              const updated = [...prev, ...newEvents];
              // Keep last 500 events in memory
              return updated.length > 500 ? updated.slice(-500) : updated;
            });
            setLastEventTime(new Date().toISOString());
          }
        }
      } catch (e) {}
    };

    return () => {
      ws.close();
    };
  }, [targetId]);

  // Fetch initial events + graph data
  useEffect(() => {
    if (!targetId) return;

    const fetchData = async () => {
      try {
        const [eventsRes, graphRes] = await Promise.all([
          fetch(`/api/traces/events?targetId=${targetId}&limit=200`),
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
          setGraph(data);
        }
      } catch (e) {
        console.error('Failed to fetch trace data:', e);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [targetId, windowSec]);

  // Auto-scroll event list
  useEffect(() => {
    if (eventListRef.current && isCollecting) {
      eventListRef.current.scrollTop = eventListRef.current.scrollHeight;
    }
  }, [events, isCollecting]);

  // Determine if we're receiving data
  const isReceivingData = lastEventTime
    ? (Date.now() - new Date(lastEventTime).getTime()) < 30000
    : false;

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

  // Auto-start collecting when view opens
  useEffect(() => {
    if (targetId && !isCollecting) {
      setIsCollecting(true);
      fetch('/api/traces/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId }),
      }).catch(() => {});
    }
  }, [targetId]);

  const maxEventCount = graph ? Math.max(...graph.edges.map(e => e.eventCount), 1) : 1;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      padding: embedded ? '8px 32px 24px 32px' : '28px 32px',
      color: 'var(--color-text-main)',
      // This view's internals (a minmax(0,1fr) grid over a scrolling event
      // list) are built for a fixed-height viewport. Left to grow with
      // `auto` inside a per-project stack, the event list stops scrolling
      // and stretches the section to thousands of pixels — so keep it a
      // fixed pane there and let it scroll internally as it does full-page.
      height: embedded ? '720px' : '100%',
      boxSizing: 'border-box',
      background: 'radial-gradient(circle at top right, rgba(0,212,255,0.04), transparent 50%)'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
            <Zap size={24} color="var(--color-accent-cyan)" />
            <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 800, letterSpacing: '-0.5px' }}>
              Connection Traces
            </h1>
            {/* Status pill */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 12px',
              borderRadius: '20px',
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              background: isReceivingData
                ? 'rgba(0, 255, 136, 0.1)'
                : 'rgba(255, 170, 0, 0.1)',
              color: isReceivingData
                ? 'var(--color-healthy)'
                : 'var(--color-warning, #ffaa00)',
              border: `1px solid ${isReceivingData ? 'rgba(0, 255, 136, 0.3)' : 'rgba(255, 170, 0, 0.3)'}`,
            }}>
              <Circle size={6} fill="currentColor" style={{
                animation: isReceivingData ? 'pulse-critical 2s infinite' : 'none',
              }} />
              {isReceivingData ? 'RECEIVING' : 'WAITING'}
            </div>
          </div>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-text-muted)', fontWeight: 400 }}>
            SSH-sampled TCP connections from <span style={{ color: 'var(--color-accent-cyan)', fontWeight: 600 }}>{targetId}</span>
            <span style={{ opacity: 0.5 }}> · Not distributed tracing — connection-level snapshots only</span>
          </p>
        </div>

        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          background: 'var(--color-bg-glass)',
          padding: '8px 16px',
          borderRadius: '12px',
          border: '1px solid var(--color-border)',
          backdropFilter: 'blur(10px)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Clock size={14} color="var(--color-text-muted)" />
            <select
              value={windowSec}
              onChange={(e) => setWindowSec(parseInt(e.target.value))}
              style={{
                background: 'transparent',
                color: 'var(--color-text-main)',
                border: 'none',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                outline: 'none',
                padding: '4px 0'
              }}
            >
              {WINDOW_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div style={{ width: '1px', height: '20px', background: 'var(--color-border)' }} />

          <button
            onClick={toggleCollection}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: isCollecting ? 'rgba(255, 37, 63, 0.12)' : 'rgba(0, 212, 255, 0.12)',
              color: isCollecting ? 'var(--color-critical)' : 'var(--color-accent-cyan)',
              border: `1px solid ${isCollecting ? 'rgba(255,37,63,0.3)' : 'rgba(0,212,255,0.3)'}`,
              borderRadius: '8px',
              padding: '6px 16px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.2s',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}
          >
            {isCollecting ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
            {isCollecting ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      {/* Main Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 420px',
        gridTemplateRows: 'minmax(0, 1fr)',
        gap: '20px',
        flex: 1,
        minHeight: 0
      }}>
        {/* Left: Topology Map */}
        <div style={{
          background: 'var(--color-bg-glass)',
          borderRadius: '20px',
          border: '1px solid var(--color-border)',
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          backdropFilter: 'blur(20px)'
        }}>
          <div style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={16} color="var(--color-accent-cyan)" />
              <span style={{ fontSize: '14px', fontWeight: 700, opacity: 0.9 }}>
                Observed Connections
                <span style={{ fontWeight: 400, opacity: 0.5, marginLeft: '6px', fontSize: '11px' }}>SSH-sampled</span>
              </span>
            </div>
            <div style={{
              fontSize: '11px',
              padding: '3px 10px',
              borderRadius: '16px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-muted)',
              fontWeight: 600,
            }}>
              {graph?.nodes.length || 0} nodes · {graph?.edges.length || 0} edges
            </div>
          </div>

          {/* SVG Topology */}
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {graph && graph.nodes.length > 0 ? (
              <TraceTopologyMap graph={graph} maxEventCount={maxEventCount} />
            ) : (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                textAlign: 'center',
                opacity: 0.3,
                pointerEvents: 'none'
              }}>
                <WifiOff size={48} color="var(--color-text-muted)" style={{ marginBottom: '12px', opacity: 0.3 }} />
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                  No connections observed yet
                </div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                  Connection events will appear when the remote collector sends data
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Event Stream */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%'
        }}>
          <div style={{
            background: 'var(--color-bg-glass)',
            borderRadius: '20px',
            border: '1px solid var(--color-border)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flex: 1,
            backdropFilter: 'blur(20px)'
          }}>
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Activity size={16} color="var(--color-accent-cyan)" />
                <span style={{ fontSize: '14px', fontWeight: 700, opacity: 0.9 }}>Live Event Stream</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  color: 'var(--color-text-muted)',
                  opacity: 0.6,
                }}>{events.length} events</span>
                <div style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: isReceivingData ? 'var(--color-healthy)' : 'var(--color-text-muted)',
                  boxShadow: isReceivingData ? '0 0 8px var(--color-healthy)' : 'none',
                  transition: 'all 0.3s',
                }} />
              </div>
            </div>

            <div
              ref={eventListRef}
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
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
                  opacity: 0.4,
                  textAlign: 'center',
                  padding: '40px 20px',
                }}>
                  <ShieldAlert size={28} style={{ marginBottom: '12px', opacity: 0.4 }} />
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>No Connection Events</div>
                  <div style={{ fontSize: '11px', marginTop: '6px', lineHeight: '1.5' }}>
                    Waiting for the remote collector to send<br />TCP connection snapshots
                  </div>
                </div>
              ) : (
                events.slice().reverse().slice(0, 200).map((event, i) => (
                  <div key={`${event.timestamp}-${event.sourceServiceId}-${event.destServiceId}-${i}`} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    background: i === 0 ? 'rgba(0, 212, 255, 0.04)' : 'rgba(255,255,255,0.015)',
                    border: `1px solid ${i === 0 ? 'rgba(0, 212, 255, 0.08)' : 'rgba(255,255,255,0.03)'}`,
                    transition: 'all 0.15s',
                    fontSize: '11px',
                  }}>
                    <span style={{
                      color: 'var(--color-text-muted)',
                      width: '55px',
                      flexShrink: 0,
                      opacity: 0.5,
                      fontSize: '10px',
                    }}>
                      {new Date(event.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>

                    <span style={{
                      fontWeight: 700,
                      color: serviceColor(shortName(event.sourceServiceId)),
                      flex: '1 1 0',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}>
                      {shortName(event.sourceServiceId)}
                    </span>

                    <ArrowRight size={10} color="var(--color-text-muted)" style={{ opacity: 0.4, flexShrink: 0 }} />

                    <span style={{
                      fontWeight: 700,
                      color: serviceColor(shortName(event.destServiceId)),
                      flex: '1 1 0',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}>
                      {shortName(event.destServiceId)}
                    </span>

                    <span style={{
                      fontWeight: 600,
                      background: 'rgba(0,0,0,0.3)',
                      padding: '1px 6px',
                      borderRadius: '4px',
                      color: 'var(--color-text-muted)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      fontSize: '10px',
                      flexShrink: 0,
                    }}>
                      :{event.destPort}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '11px',
        opacity: 0.35,
        color: 'var(--color-text-muted)',
        padding: '0 4px',
      }}>
        <ShieldAlert size={12} />
        <span>
          SSH-sampled connection data from /proc/net/tcp. Sampling granularity: ~5s.
          Short-lived connections may be missed. No per-request latency.
          This is not distributed tracing.
        </span>
      </div>
    </div>
  );
}


/**
 * SVG-based topology visualization of the trace graph.
 * Renders nodes in a force-directed-ish layout with directed edges
 * whose thickness reflects event_count.
 */
function TraceTopologyMap({ graph, maxEventCount }: { graph: TraceGraph; maxEventCount: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<TraceGraphEdge | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const updateDims = () => {
      if (svgRef.current?.parentElement) {
        const rect = svgRef.current.parentElement.getBoundingClientRect();
        setDimensions({ width: rect.width, height: rect.height });
      }
    };
    updateDims();
    const observer = new ResizeObserver(updateDims);
    if (svgRef.current?.parentElement) {
      observer.observe(svgRef.current.parentElement);
    }
    return () => observer.disconnect();
  }, []);

  // Simple circular layout
  const nodePositions = new Map<string, { x: number; y: number }>();
  const cx = dimensions.width / 2;
  const cy = dimensions.height / 2;
  const radius = Math.min(cx, cy) * 0.7;

  graph.nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / graph.nodes.length - Math.PI / 2;
    nodePositions.set(node, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  const neighborsOf = (nodeId: string) => {
    const set = new Set<string>([nodeId]);
    for (const edge of graph.edges) {
      if (edge.sourceServiceId === nodeId) set.add(edge.destServiceId);
      if (edge.destServiceId === nodeId) set.add(edge.sourceServiceId);
    }
    return set;
  };
  const highlighted = hoveredNode ? neighborsOf(hoveredNode) : null;

  const relativeTime = (iso: string) => {
    const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    return `${Math.round(diffSec / 3600)}h ago`;
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        <defs>
          <marker
            id="trace-arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L8,3 L0,6 Z" fill="rgba(0, 212, 255, 0.7)" />
          </marker>
          <filter id="trace-node-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Edges */}
        {graph.edges.map((edge) => {
          const src = nodePositions.get(edge.sourceServiceId);
          const dst = nodePositions.get(edge.destServiceId);
          if (!src || !dst) return null;

          const isDimmed = !!hoveredNode && !(highlighted!.has(edge.sourceServiceId) && highlighted!.has(edge.destServiceId));
          const isEdgeHovered = hoveredEdge === edge;

          const thickness = 1 + (edge.eventCount / maxEventCount) * 4;
          const baseOpacity = 0.3 + (edge.eventCount / maxEventCount) * 0.5;
          const opacity = isDimmed ? baseOpacity * 0.15 : isEdgeHovered ? 1 : baseOpacity;

          // Offset the line end slightly so the arrowhead is visible outside the node circle
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
              {/* Wider invisible hit area for easier hover */}
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
                markerEnd="url(#trace-arrowhead)"
                style={{ transition: 'stroke-width 0.15s ease, stroke-opacity 0.3s ease', pointerEvents: 'none' }}
              />
              {/* Event count label */}
              <text
                x={(startX + endX) / 2}
                y={(startY + endY) / 2 - 6}
                fill={isDimmed ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.4)'}
                fontSize="9"
                textAnchor="middle"
                fontFamily="monospace"
                fontWeight="600"
                style={{ pointerEvents: 'none', transition: 'fill 0.3s ease' }}
              >
                {edge.eventCount}×
              </text>
            </g>
          );
        })}

        {/* Nodes */}
        {graph.nodes.map((node) => {
          const pos = nodePositions.get(node);
          if (!pos) return null;
          const name = shortName(node);
          const color = serviceColor(name);
          const isDimmed = !!hoveredNode && !highlighted!.has(node);
          const isHovered = hoveredNode === node;

          return (
            <g
              key={node}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredNode(node)}
              onMouseLeave={() => setHoveredNode(null)}
              opacity={isDimmed ? 0.25 : 1}
            >
              {/* Glow */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={isHovered ? 24 : 18}
                fill={color}
                opacity={isHovered ? 0.18 : 0.08}
                filter="url(#trace-node-glow)"
                style={{ transition: 'r 0.2s ease, opacity 0.2s ease' }}
              />
              {/* Node circle */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={isHovered ? 18 : 16}
                fill="rgba(12, 12, 24, 0.9)"
                stroke={color}
                strokeWidth={isHovered ? 3 : 2}
                style={{ transition: 'all 0.2s ease' }}
              />
              {/* Inner dot */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r="4"
                fill={color}
                opacity={0.8}
              />
              {/* Label */}
              <text
                x={pos.x}
                y={pos.y + 30}
                fill={color}
                fontSize={isHovered ? 11 : 10}
                fontWeight={isHovered ? 800 : 600}
                textAnchor="middle"
                fontFamily="'Inter', system-ui, sans-serif"
                style={{ textShadow: '0 1px 4px rgba(0,0,0,0.8)', transition: 'font-size 0.15s ease' }}
              >
                {name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Edge tooltip */}
      {hoveredEdge && (
        <div style={{
          position: 'absolute',
          left: Math.min(tooltipPos.x + 14, dimensions.width - 190),
          top: Math.max(tooltipPos.y - 10, 8),
          background: 'rgba(10, 12, 20, 0.96)',
          border: '1px solid rgba(0, 212, 255, 0.3)',
          borderRadius: '8px',
          padding: '10px 12px',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: '#e6edf3',
          pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          minWidth: '160px',
          zIndex: 10,
        }}>
          <div style={{ fontWeight: 700, marginBottom: '6px', color: 'var(--color-accent-cyan)' }}>
            {shortName(hoveredEdge.sourceServiceId)} → {shortName(hoveredEdge.destServiceId)}
          </div>
          <div style={{ opacity: 0.8 }}>events: <b>{hoveredEdge.eventCount}</b></div>
          <div style={{ opacity: 0.8 }}>ports: {hoveredEdge.destPorts.join(', ')}</div>
          <div style={{ opacity: 0.8 }}>last seen: {relativeTime(hoveredEdge.lastSeen)}</div>
        </div>
      )}

      {/* Legend */}
      <div style={{
        position: 'absolute',
        bottom: '10px',
        left: '10px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        fontSize: '9px',
        color: 'rgba(255,255,255,0.35)',
        fontFamily: 'monospace',
        pointerEvents: 'none',
      }}>
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="rgba(0,212,255,0.35)" strokeWidth="1" /></svg>
        <span>low freq</span>
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="rgba(0,212,255,0.85)" strokeWidth="4" /></svg>
        <span>high freq</span>
      </div>
    </div>
  );
}
