import { useState, useEffect, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { ServiceNode, MetricSnapshot } from '../types';

interface TelemetryViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
}

export function TelemetryView({ nodes, edges: _edges, selectedProject }: TelemetryViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<'5m' | '15m' | '30m' | '1h'>('15m');
  const [history, setHistory] = useState<MetricSnapshot[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [rawEvents, setRawEvents] = useState<any[]>([]);

  useEffect(() => {
    const fetchTraffic = () => {
      fetch('/api/traffic?limit=50')
        .then(res => res.json())
        .then(data => { if (Array.isArray(data)) setRawEvents(data); })
        .catch(() => {});
    };
    fetchTraffic();
    const interval = setInterval(fetchTraffic, 2000);
    return () => clearInterval(interval);
  }, []);

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

  useEffect(() => {
    if (selectedNode) {
      fetch(`/api/nodes/${selectedNode.id}/metrics?range=${timeRange}`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) setHistory(data);
        })
        .catch(() => setHistory([]));
    }
  }, [selectedNode, timeRange]);

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

  return (
    <div style={{
      flex: 1,
      height: '100%',
      overflowY: 'auto',
      padding: '24px',
      background: 'var(--color-bg-body)',
      color: 'var(--color-text-main)',
      display: 'flex',
      flexDirection: 'column',
      gap: '24px'
    }}>
      {/* Top Telemetry KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Monitored Services</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: '#fff' }}>{summary.totalServices}</div>
          <div style={{ fontSize: '12px', color: 'var(--color-healthy)', marginTop: '4px' }}>● Live Ingestion Active</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Average CPU Load</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: 'var(--color-accent-cyan)' }}>{summary.avgCpu}%</div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Across all active nodes</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Average Memory Usage</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: 'var(--color-accent-magenta)' }}>{summary.avgMem}%</div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Container RAM utilization</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Network I/O Throughput</div>
          <div style={{ fontSize: '24px', fontWeight: 700, marginTop: '8px', color: '#fff' }}>
            ↓ {summary.netRxMb} MB <span style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>/ ↑ {summary.netTxMb} MB</span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Cumulative socket traffic</div>
        </div>
      </div>

      {/* Raw Traffic Stream */}
      <div style={{ background: '#0d1117', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#fff', fontFamily: 'monospace' }}>
            <span style={{ color: 'var(--color-healthy)', marginRight: '8px' }}>●</span>
            RAW TRAFFIC LOGS
          </h3>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{rawEvents.length} events</div>
        </div>
        <div style={{ 
          background: '#010409', 
          borderRadius: '8px', 
          padding: '16px', 
          height: '200px', 
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#c9d1d9',
          border: '1px solid #30363d'
        }}>
          {rawEvents.length === 0 ? (
            <div style={{ color: '#8b949e', fontStyle: 'italic' }}>Waiting for traffic events...</div>
          ) : (
            rawEvents.map((evt, i) => (
              <div key={i} style={{ marginBottom: '8px', display: 'flex', gap: '12px', borderBottom: '1px solid #21262d', paddingBottom: '4px' }}>
                <span style={{ color: '#8b949e', whiteSpace: 'nowrap' }}>{new Date(evt.timestamp).toISOString().split('T')[1].replace('Z','')}</span>
                <span style={{ color: '#58a6ff', width: '150px', flexShrink: 0, textOverflow: 'ellipsis', overflow: 'hidden' }}>{evt.source} ➔ {evt.target}</span>
                <span style={{ color: evt.statusCode >= 400 ? '#ff7b72' : '#3fb950', width: '50px' }}>{evt.statusCode || 200}</span>
                <span style={{ color: '#d2a8ff', width: '60px' }}>{evt.method || 'TCP'}</span>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{evt.route || '<encrypted>'}</span>
                {evt.latency && <span style={{ color: '#e3b341', width: '60px', textAlign: 'right' }}>{Math.round(evt.latency)}ms</span>}
                {evt.bytesSent && <span style={{ color: '#8b949e', width: '70px', textAlign: 'right' }}>{formatBytes(evt.bytesSent)}</span>}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Telemetry Split View */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '24px', flex: 1, minHeight: '450px' }}>
        {/* Left: Detailed Service Telemetry Table */}
        <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '0.5px' }}>Service Telemetry Stream</h3>
            <input 
              type="text"
              placeholder="Filter services..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                padding: '6px 12px',
                color: '#fff',
                fontSize: '12px',
                outline: 'none',
                width: '200px'
              }}
            />
          </div>

          <div style={{ overflowX: 'auto', flex: 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '10px 12px' }}>Service</th>
                  <th style={{ padding: '10px 12px' }}>Type</th>
                  <th style={{ padding: '10px 12px' }}>Status</th>
                  <th style={{ padding: '10px 12px' }}>CPU Load</th>
                  <th style={{ padding: '10px 12px' }}>Memory Usage</th>
                  <th style={{ padding: '10px 12px' }}>Network RX / TX</th>
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

                  return (
                    <tr 
                      key={node.id}
                      onClick={() => setSelectedNodeId(node.id)}
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        background: isSelected ? 'rgba(0, 212, 255, 0.08)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                      }}
                    >
                      <td style={{ padding: '12px', fontWeight: 600 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: node.status === 'healthy' ? 'var(--color-healthy)' : 'var(--color-critical)' }} />
                          {node.name}
                        </div>
                      </td>
                      <td style={{ padding: '12px', textTransform: 'uppercase', fontSize: '11px', color: 'var(--color-text-muted)' }}>{node.type}</td>
                      <td style={{ padding: '12px' }}>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: 600,
                          background: node.status === 'healthy' ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 23, 68, 0.15)',
                          color: node.status === 'healthy' ? 'var(--color-healthy)' : 'var(--color-critical)'
                        }}>
                          {node.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ width: '60px', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${Math.min(cpu, 100)}%`, background: 'var(--color-accent-cyan)' }} />
                          </div>
                          <span>{cpu.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{ padding: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ width: '60px', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${Math.min(memPct, 100)}%`, background: 'var(--color-accent-magenta)' }} />
                          </div>
                          <span>{memPct.toFixed(1)}% <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>({formatBytes(memRaw)})</span></span>
                        </div>
                      </td>
                      <td style={{ padding: '12px', color: 'var(--color-text-muted)', fontSize: '12px' }}>
                        ↓ {formatBytes(rx)} / ↑ {formatBytes(tx)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Selected Node Telemetry Detail & Historical Chart */}
        <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {selectedNode ? (
            <>
              <div style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: '12px' }}>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>Selected Node</div>
                <h2 style={{ margin: '4px 0 0 0', fontSize: '20px', fontWeight: 700 }}>{selectedNode.name}</h2>
                <div style={{ fontSize: '12px', color: 'var(--color-accent-cyan)', marginTop: '2px' }}>{selectedNode.project.toUpperCase()} • {selectedNode.type.toUpperCase()}</div>
              </div>

              {/* Time Range Selector */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 600 }}>Metrics History</span>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {(['5m', '15m', '30m', '1h'] as const).map(range => (
                    <button
                      key={range}
                      onClick={() => setTimeRange(range)}
                      style={{
                        background: timeRange === range ? 'var(--color-accent-cyan)' : 'rgba(255,255,255,0.05)',
                        color: timeRange === range ? '#000' : 'var(--color-text-muted)',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '4px 8px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      {range}
                    </button>
                  ))}
                </div>
              </div>

              {/* Real-time Metric History Graph Visualizer */}
              <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '16px', border: '1px solid rgba(255,255,255,0.05)', height: '180px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>CPU Load Trend (%)</div>
                {history.length > 0 ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '4px' }}>
                    {history.map((h, idx) => {
                      const val = Math.min((h.cpu || 0), 100);
                      return (
                        <div key={idx} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                          <div 
                            style={{
                              width: '100%',
                              height: `${Math.max(val, 4)}%`,
                              background: 'linear-gradient(180deg, var(--color-accent-cyan) 0%, rgba(0,212,255,0.1) 100%)',
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
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: '12px', fontStyle: 'italic' }}>
                    No historical telemetry data collected yet
                  </div>
                )}
              </div>

              {/* Quick Metadata list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px', marginTop: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>Container ID</span>
                  <span style={{ fontFamily: 'monospace' }}>{selectedNode.metadata?.containerId || 'N/A'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>Image</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{selectedNode.metadata?.image || 'N/A'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>Container State</span>
                  <span style={{ color: 'var(--color-healthy)', fontWeight: 600 }}>{selectedNode.metadata?.state || 'running'}</span>
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', margin: 'auto' }}>
              Select a service from the table to view detailed telemetry
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
