import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Activity, ArrowDown, ArrowUp, MousePointerClick, Search } from 'lucide-react';
import type { Node, Edge } from '@xyflow/react';
import type { ServiceNode, MetricSnapshot } from '../types';
import { pageRootStyle } from './ProjectSections';

interface TelemetryViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
  /** Rendered inside a per-project stack: the wrapper owns scroll + height. */
  embedded?: boolean;
}

export function TelemetryView({ nodes, edges: _edges, selectedProject, embedded = false }: TelemetryViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<'5m' | '15m' | '30m' | '1h'>('15m');
  const [history, setHistory] = useState<MetricSnapshot[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [rawEvents, setRawEvents] = useState<any[]>([]);
  // 'http' = parsed from access logs (has route/status/latency);
  // 'connection' = observed sockets (no route, no status).
  const [rawEventKind, setRawEventKind] = useState<'http' | 'connection'>('connection');
  const [serviceLogs, setServiceLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logTail, setLogTail] = useState(200);
  const [autoRefreshLogs, setAutoRefreshLogs] = useState(true);
  const logListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchTraffic = async () => {
      try {
        const scope = selectedProject && selectedProject !== 'ALL' ? `&targetId=${encodeURIComponent(selectedProject)}` : '';
        const res = await fetch(`/api/traffic?limit=50${scope}`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        // The endpoint returns { kind, events }; it used to return a bare
        // array, so keep accepting that rather than breaking on a stale server.
        if (Array.isArray(data)) {
          setRawEvents(data);
        } else if (data && Array.isArray(data.events)) {
          setRawEvents(data.events);
          if (data.kind === 'http' || data.kind === 'connection') setRawEventKind(data.kind);
        } else {
          console.error('Unexpected response format from /api/traffic:', data);
        }
      } catch (e) {
        console.error('Failed to fetch traffic logs:', e);
      }
    };

    fetchTraffic();
    const interval = setInterval(fetchTraffic, 2000);
    return () => clearInterval(interval);
    // Re-subscribe when the project changes: with an empty dependency list
    // this kept polling the project that was selected when the view mounted.
  }, [selectedProject]);

  const serviceNodes = useMemo(() => {
    return nodes
      .map(n => n.data as unknown as ServiceNode)
      .filter(n => {
        if (selectedProject !== 'ALL' && n.project !== selectedProject.toLowerCase()) return false;
        if (searchQuery && !n.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
      });
  }, [nodes, selectedProject, searchQuery]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return serviceNodes[0] || null;
    return serviceNodes.find(n => n.id === selectedNodeId) || serviceNodes[0] || null;
  }, [selectedNodeId, serviceNodes]);

  const activeNodeId = selectedNode?.id;

  useEffect(() => {
    if (activeNodeId) {
      fetch(`/api/nodes/${activeNodeId}/metrics?range=${timeRange}`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) setHistory(data);
        })
        .catch(() => setHistory([]));
    }
    // selectedNode is a fresh object reference on every websocket tick (it's
    // re-derived from `nodes` via useMemo/.find()); depending on it directly
    // would tear down and restart this effect several times a minute even
    // though the actually-selected service hasn't changed. Depend on the
    // stable id instead.
  }, [activeNodeId, timeRange]);

  useEffect(() => {
    if (!activeNodeId || !autoRefreshLogs) return;

    let cancelled = false;
    const fetchLogs = async () => {
      setLogsLoading(true);
      try {
        const res = await fetch(`/api/nodes/${activeNodeId}/logs?tail=${logTail}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLogsError(data.error || `HTTP ${res.status}`);
          setServiceLogs([]);
        } else {
          setLogsError(null);
          setServiceLogs(data.lines || []);
        }
      } catch (e: any) {
        if (!cancelled) {
          setLogsError(e.message || 'Failed to fetch logs');
          setServiceLogs([]);
        }
      } finally {
        if (!cancelled) setLogsLoading(false);
      }
    };

    fetchLogs();
    // Kept well above the 1s connection-scan interval on the server so this
    // on-demand fetch doesn't compete with it for the SSH connection's
    // limited concurrent-channel budget.
    const interval = setInterval(fetchLogs, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeNodeId, logTail, autoRefreshLogs]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [serviceLogs]);

  const summary = useMemo(() => {
    let totalCpu = 0;
    let totalMem = 0;
    let totalRx = 0;
    let totalTx = 0;
    let activeCount = 0;

    serviceNodes.forEach(n => {
      if (n.metrics) {
        totalCpu += n.metrics.cpu || 0;
        totalMem += n.metrics.memoryPercent || 0;
        totalRx += n.metrics.networkRx || 0;
        totalTx += n.metrics.networkTx || 0;
        activeCount++;
      }
    });

    const avgCpu = activeCount > 0 ? (totalCpu / activeCount).toFixed(1) : '0.0';
    const avgMem = activeCount > 0 ? (totalMem / activeCount).toFixed(1) : '0.0';
    const netRxMb = (totalRx / (1024 * 1024)).toFixed(2);
    const netTxMb = (totalTx / (1024 * 1024)).toFixed(2);

    return { avgCpu, avgMem, netRxMb, netTxMb, totalServices: serviceNodes.length };
  }, [serviceNodes]);

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
  const num: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
  const kpiValue: CSSProperties = { fontSize: '26px', fontWeight: 600, letterSpacing: '-0.02em', marginTop: '8px', color: 'var(--color-text-main)', ...num };
  const kpiSub: CSSProperties = { fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' };
  const cardTitle: CSSProperties = { margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--color-text-main)' };
  const cardSub: CSSProperties = { fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' };
  const th: CSSProperties = { padding: '0 12px', height: '36px', fontSize: '11.5px', fontWeight: 500, color: 'var(--color-text-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
  const td: CSSProperties = { padding: '0 12px', height: '42px' };
  const logBox: CSSProperties = {
    background: 'var(--color-bg-body)',
    borderRadius: '8px',
    border: '1px solid var(--color-border)',
    overflowY: 'auto',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--color-text-main)',
  };
  const statusTone = (status: string) => {
    if (status === 'healthy') return { fg: 'var(--color-healthy)', bg: 'rgba(62,207,142,.1)' };
    if (status === 'degraded') return { fg: 'var(--color-degraded)', bg: 'rgba(232,163,61,.1)' };
    if (status === 'critical' || status === 'down' || status === 'unhealthy') return { fg: 'var(--color-critical)', bg: 'rgba(239,95,103,.1)' };
    return { fg: 'var(--color-unknown)', bg: 'rgba(255,255,255,.04)' };
  };
  const meter = (pct: number, color = '#9aa3b0') => (
    <div style={{ width: '60px', height: '4px', background: 'rgba(255,255,255,.06)', borderRadius: '2px', overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: color }} />
    </div>
  );
  const meterColor = (pct: number) => (pct >= 90 ? 'var(--color-critical)' : pct >= 75 ? 'var(--color-degraded)' : 'var(--color-healthy)');

  return (
    <div style={pageRootStyle(embedded)}>
      {/* Top telemetry KPI cards */}
      <div className="mm-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Monitored services</div>
          <div style={kpiValue}>{summary.totalServices}</div>
          <div style={{ ...kpiSub, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <i className="mm-dot" style={{ background: 'var(--color-healthy)' }} />
            <span style={{ color: 'var(--color-healthy)' }}>Live ingestion active</span>
          </div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Average CPU load</div>
          <div style={kpiValue}>{summary.avgCpu}%</div>
          <div style={kpiSub}>Across all active nodes</div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Average memory usage</div>
          <div style={kpiValue}>{summary.avgMem}%</div>
          <div style={kpiSub}>Container RAM utilization</div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Network I/O throughput</div>
          <div style={{ ...kpiValue, display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <ArrowDown size={16} strokeWidth={1.75} color="var(--color-text-dim)" />{summary.netRxMb} MB
            </span>
            <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text-muted)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
              <ArrowUp size={14} strokeWidth={1.75} />{summary.netTxMb} MB
            </span>
          </div>
          <div style={kpiSub}>Cumulative socket traffic</div>
        </div>
      </div>

      {/* Traffic log */}
      <div className="mm-card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <h3 style={cardTitle}>Traffic log</h3>
            <div style={cardSub}>
              {rawEventKind === 'http' ? 'HTTP interactions from access logs' : 'Observed socket connections'}
            </div>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-dim)', ...num }}>{rawEvents.length} events</div>
        </div>
        <div style={{ ...logBox, height: '200px', padding: '6px 0' }}>
          {rawEvents.length === 0 ? (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '0 24px', textAlign: 'center', fontFamily: 'var(--font-family)' }}>
              <Activity size={20} strokeWidth={1.75} color="var(--color-text-dim)" />
              <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No traffic observed for this project yet</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', maxWidth: '72ch', lineHeight: 1.55 }}>
                HTTP rows need a service that writes a parseable access log to stdout; otherwise this falls back to
                socket connections seen by the /proc/net/tcp scanner after at least one discovery cycle.
              </div>
            </div>
          ) : (
            rawEvents.map((evt, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px', height: '26px', padding: '0 14px', borderBottom: '1px solid rgba(255,255,255,.03)', whiteSpace: 'nowrap', ...num }}>
                <span style={{ color: 'var(--color-text-dim)', flexShrink: 0 }}>{new Date(evt.timestamp).toISOString().split('T')[1].replace('Z','')}</span>
                <span
                  title={`${evt.source} → ${evt.target}`}
                  style={{ color: 'var(--color-text-main)', width: '220px', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >{evt.source} <span style={{ color: 'var(--color-text-dim)' }}>→</span> {evt.target}</span>
                {/* No status invented for a socket observation: the scanner
                    sees a connection, not a response. This used to print 200
                    for every TCP row, which reads as "the request succeeded"
                    when nothing observed a request at all. */}
                <span style={{
                  width: '36px', flexShrink: 0,
                  color: evt.statusCode == null ? 'var(--color-text-dim)'
                    : evt.statusCode >= 500 ? 'var(--color-critical)'
                    : evt.statusCode >= 400 ? 'var(--color-degraded)'
                    : 'var(--color-text-muted)',
                }}>
                  {evt.statusCode ?? '—'}
                </span>
                <span style={{ color: 'var(--color-text-muted)', width: '52px', flexShrink: 0 }}>{evt.method || 'TCP'}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{evt.route || '—'}</span>
                {evt.latency && <span style={{ color: 'var(--color-text-muted)', width: '60px', flexShrink: 0, textAlign: 'right' }}>{Math.round(evt.latency)}ms</span>}
                {evt.bytesSent && <span style={{ color: 'var(--color-text-dim)', width: '70px', flexShrink: 0, textAlign: 'right' }}>{formatBytes(evt.bytesSent)}</span>}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main telemetry split view */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gridTemplateRows: 'minmax(450px, auto)', gap: '16px', flex: 1 }}>
        {/* Left: service telemetry table */}
        <div className="mm-card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <h3 style={cardTitle}>Service telemetry</h3>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={14} strokeWidth={1.75} color="var(--color-text-dim)" style={{ position: 'absolute', left: '9px', pointerEvents: 'none' }} />
              <input
                type="text"
                placeholder="Filter services"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(138,180,255,.45)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}
                style={{
                  height: '30px',
                  background: 'rgba(255,255,255,.03)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  padding: '0 10px 0 28px',
                  color: 'var(--color-text-main)',
                  fontSize: '12.5px',
                  fontFamily: 'inherit',
                  outline: 'none',
                  width: '200px',
                  transition: 'border-color var(--transition-fast)',
                }}
              />
            </div>
          </div>

          <div style={{ overflowX: 'auto', flex: 1, minHeight: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <th style={th}>Service</th>
                  <th style={th}>Type</th>
                  <th style={th}>Status</th>
                  <th style={th}>CPU load</th>
                  <th style={th}>Memory usage</th>
                  <th style={th}>Network RX / TX</th>
                </tr>
              </thead>
              <tbody>
                {serviceNodes.map(node => {
                  const isSelected = selectedNode?.id === node.id;
                  const cpu = node.metrics?.cpu || 0;
                  const memPct = node.metrics?.memoryPercent || 0;
                  const memRaw = node.metrics?.memory || 0;
                  const rx = node.metrics?.networkRx || 0;
                  const tx = node.metrics?.networkTx || 0;
                  const tone = statusTone(node.status);

                  return (
                    <tr
                      key={node.id}
                      onClick={() => setSelectedNodeId(node.id)}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,.025)'; }}
                      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                      style={{
                        borderBottom: '1px solid var(--color-border)',
                        background: isSelected ? 'rgba(138,180,255,.07)' : 'transparent',
                        boxShadow: isSelected ? 'inset 2px 0 0 var(--color-accent-cyan)' : undefined,
                        cursor: 'pointer',
                        transition: 'background var(--transition-fast)'
                      }}
                    >
                      <td style={{ ...td, fontWeight: 500, color: 'var(--color-text-main)' }}>{node.name}</td>
                      <td style={{ ...td, fontSize: '12px', color: 'var(--color-text-muted)' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <i style={{ width: 8, height: 8, borderRadius: 2, background: '#5d636c', display: 'inline-block' }} />{sentence(node.type)}
                        </span>
                      </td>
                      <td style={td}>
                        <span className="mm-chip" style={{ background: tone.bg, color: tone.fg, border: 'none' }}>
                          <i className="mm-dot" style={{ background: 'currentColor' }} />
                          {sentence(node.status)}
                        </span>
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', ...num }}>
                          {meter(cpu, meterColor(cpu))}
                          <span>{cpu.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', ...num }}>
                          {meter(memPct, meterColor(memPct))}
                          <span>{memPct.toFixed(1)}% <span style={{ fontSize: '11.5px', color: 'var(--color-text-dim)' }}>({formatBytes(memRaw)})</span></span>
                        </div>
                      </td>
                      <td style={{ ...td, color: 'var(--color-text-muted)', fontSize: '12px', whiteSpace: 'nowrap', ...num }}>
                        ↓ {formatBytes(rx)} <span style={{ color: 'var(--color-text-dim)' }}>/</span> ↑ {formatBytes(tx)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: selected node detail and history chart */}
        <div className="mm-card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 }}>
          {selectedNode ? (
            <>
              <div style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: '14px' }}>
                <div className="mm-eyebrow">Selected service</div>
                <h2 style={{ margin: '6px 0 0 0', fontSize: '16px', fontWeight: 600, letterSpacing: '-0.01em' }}>{selectedNode.name}</h2>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>{selectedNode.project} · {selectedNode.type}</div>
              </div>

              {/* Time range selector */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>Metrics history</span>
                <div className="mm-seg" style={{ gridTemplateColumns: 'repeat(4, 1fr)', width: '168px' }}>
                  {(['5m', '15m', '30m', '1h'] as const).map(range => (
                    <button
                      key={range}
                      className={timeRange === range ? 'on' : undefined}
                      onClick={() => setTimeRange(range)}
                      style={num}
                    >
                      {range}
                    </button>
                  ))}
                </div>
              </div>

              {/* CPU history chart */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>CPU load (%)</div>
                <div style={{
                  height: '150px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                  backgroundImage: 'linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px)',
                  backgroundSize: '100% 25%',
                  borderBottom: '1px solid rgba(255,255,255,.05)',
                }}>
                  {history.length > 0 ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '3px' }}>
                      {history.map((h, idx) => {
                        const val = Math.min((h.cpu || 0), 100);
                        return (
                          <div key={idx} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                            <div
                              style={{
                                width: '100%',
                                height: `${Math.max(val, 2)}%`,
                                background: 'var(--color-accent-cyan)',
                                opacity: 0.75,
                                borderRadius: '2px 2px 0 0',
                                transition: 'height 0.3s'
                              }}
                              title={`CPU: ${val.toFixed(1)}%`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', textAlign: 'center' }}>
                      <Activity size={20} strokeWidth={1.75} color="var(--color-text-dim)" />
                      <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No history yet</div>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Telemetry appears after the first samples are collected</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Quick metadata list */}
              <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12.5px', marginTop: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border)', height: '34px', gap: '8px' }}>
                  <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>Container ID</span>
                  <span
                    title={selectedNode.metadata?.containerId || 'N/A'}
                    style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontSize: '12px' }}
                  >
                    {selectedNode.metadata?.containerId ? selectedNode.metadata.containerId.slice(0, 12) : 'N/A'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border)', height: '34px', gap: '8px' }}>
                  <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>Image</span>
                  <span
                    title={selectedNode.metadata?.image || 'N/A'}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
                  >
                    {selectedNode.metadata?.image || 'N/A'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '34px' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>Container state</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--color-text-main)' }}>
                    <i className="mm-dot" style={{ background: (selectedNode.metadata?.state || 'running') === 'running' ? 'var(--color-healthy)' : 'var(--color-unknown)' }} />
                    {sentence(selectedNode.metadata?.state || 'running')}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div style={{ margin: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', textAlign: 'center' }}>
              <MousePointerClick size={20} strokeWidth={1.75} color="var(--color-text-dim)" />
              <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No service selected</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Select a service from the table to view its telemetry</div>
            </div>
          )}
        </div>
      </div>

      {/* Service logs */}
      <div className="mm-card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={cardTitle}>Service logs</h3>
            <div style={{ ...cardSub, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <i className="mm-dot" style={{ background: logsLoading ? 'var(--color-degraded)' : autoRefreshLogs ? 'var(--color-healthy)' : 'var(--color-unknown)' }} />
              {selectedNode ? selectedNode.name : 'No service selected'}
              <span style={{ color: 'var(--color-text-dim)', ...num }}>· {serviceLogs.length} lines</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <select
              value={logTail}
              onChange={(e) => setLogTail(parseInt(e.target.value))}
              style={{ height: '30px', background: 'rgba(255,255,255,.03)', color: 'var(--color-text-main)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0 8px', fontSize: '12.5px', fontFamily: 'inherit', outline: 'none' }}
            >
              {[100, 200, 500, 1000].map(n => <option key={n} value={n}>Last {n}</option>)}
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--color-text-muted)', cursor: 'pointer' }}>
              <button
                type="button"
                aria-pressed={autoRefreshLogs}
                className={`mm-switch${autoRefreshLogs ? ' on' : ''}`}
                onClick={() => setAutoRefreshLogs(v => !v)}
              />
              {autoRefreshLogs ? 'Live' : 'Paused'}
            </label>
          </div>
        </div>
        <div
          ref={logListRef}
          style={{
            ...logBox,
            padding: '10px 14px',
            height: '320px',
            lineHeight: '1.6',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}
        >
          {!selectedNode ? (
            <div style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-family)' }}>Select a service to view its logs</div>
          ) : logsError ? (
            <div style={{ color: 'var(--color-critical)' }}>Failed to fetch logs: {logsError}</div>
          ) : serviceLogs.length === 0 ? (
            <div style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-family)' }}>{logsLoading ? 'Loading logs…' : 'No log lines returned'}</div>
          ) : (
            serviceLogs.map((line, i) => (
              <div key={i} style={{ borderBottom: '1px solid rgba(255,255,255,.03)', padding: '2px 0' }}>
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
