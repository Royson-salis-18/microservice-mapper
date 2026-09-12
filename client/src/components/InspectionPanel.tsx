import { useState } from 'react';
import type { ServiceNode, DependencyEdge } from '../types';
import { MiniChart } from './MiniChart';
import { useMetrics } from '../hooks/useMetrics';

interface InspectionPanelProps {
  node: ServiceNode | null;
  edges: DependencyEdge[];
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  healthy: '#00e676',
  degraded: '#ffab00',
  critical: '#ff1744',
  unknown: '#616161'
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export function InspectionPanel({ node, edges, onClose }: InspectionPanelProps) {
  const [timeRange, setTimeRange] = useState('15m');
  const { data: metrics } = useMetrics(node?.id || null, timeRange);

  const upstreams = node ? edges.filter(e => e.target === node.id) : [];
  const downstreams = node ? edges.filter(e => e.source === node.id) : [];

  if (!node) return null;

  const sColor = statusColors[node.status] || statusColors.unknown;

  return (
    <div style={{
      width: '400px',
      background: 'rgba(12, 12, 24, 0.85)',
      backdropFilter: 'blur(12px)',
      borderLeft: '1px solid rgba(255,255,255,0.1)',
      boxShadow: '-10px 0 30px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      animation: 'slideInRight 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)',
      overflowY: 'auto',
      color: '#fff',
      height: '100%',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .scroll-container::-webkit-scrollbar { width: 6px; }
        .scroll-container::-webkit-scrollbar-track { background: transparent; }
        .scroll-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      `}</style>
      
      {/* Header */}
      <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontSize: '18px' }}>
              {node.type === 'service' ? '⚙️' : node.type === 'database' ? '🗄️' : node.type === 'queue' ? '📨' : '📦'}
            </span>
            <h3 style={{ fontSize: '18px', fontWeight: 600, margin: 0, textShadow: '0 0 10px rgba(255,255,255,0.3)' }}>{node.name}</h3>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: `rgba(${sColor === '#00e676' ? '0,230,118' : sColor === '#ffab00' ? '255,171,0' : sColor === '#ff1744' ? '255,23,68' : '97,97,97'}, 0.1)`, padding: '2px 8px', borderRadius: '12px', border: `1px solid ${sColor}40`, boxShadow: `0 0 8px ${sColor}40` }}>
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: sColor, boxShadow: `0 0 5px ${sColor}` }} />
            <span style={{ fontSize: '11px', fontWeight: 600, color: sColor, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{node.status}</span>
          </div>
        </div>
        <button onClick={onClose} style={{ 
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', 
          cursor: 'pointer', width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.2s'
        }}
        onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
        onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
        >✕</button>
      </div>

      <div className="scroll-container" style={{ overflowY: 'auto', flex: 1 }}>
        {/* RCA Diagnostics Box */}
        {(node.status === 'critical' || node.status === 'degraded') && (
          <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: node.status === 'critical' ? 'rgba(255,23,68,0.08)' : 'rgba(255,171,0,0.08)' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: node.status === 'critical' ? 'var(--color-critical)' : 'var(--color-degraded)', marginBottom: '12px', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>🚨</span> ROOT CAUSE ANALYSIS (RCA)
            </div>
            <div style={{ fontSize: '13px', background: 'rgba(0,0,0,0.4)', padding: '12px', borderRadius: '8px', border: `1px solid ${node.status === 'critical' ? 'rgba(255,23,68,0.2)' : 'rgba(255,171,0,0.2)'}` }}>
              <div style={{ fontWeight: 700, color: '#fff', marginBottom: '4px' }}>
                Classification: {upstreams.some(e => e.status === 'failed') ? 'CASCADING DEPENDENCY FAILURE' : 'PRIMARY ROOT CAUSE'}
              </div>
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '12px', marginBottom: '8px' }}>
                {upstreams.some(e => e.status === 'failed') 
                  ? `Failed due to unreachable upstream dependency (${upstreams.filter(e => e.status === 'failed').map(e => e.source.replace(/^(sock-shop|vertikal)-/, '')).join(', ')})`
                  : `Service runtime anomaly detected (${node.metadata?.state || 'Degraded performance'}).`}
              </div>
              <div style={{ fontSize: '11px', color: '#00d4ff', fontWeight: 600, marginTop: '8px' }}>Remediation Command:</div>
              <div style={{ background: '#000', padding: '6px 8px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '11px', color: '#00e676', marginTop: '4px' }}>
                docker restart docker-compose-{node.name}-1
              </div>
            </div>
          </div>
        )}

        {/* Service Info */}
        <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: '16px', letterSpacing: '1px' }}>SERVICE INFO</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '13px' }}>
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>Type</div>
              <div style={{ textTransform: 'capitalize', color: '#00d4ff' }}>{node.type}</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>Project</div>
              <div style={{ color: '#e040fb' }}>{node.project}</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)', gridColumn: '1 / -1' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>Container ID</div>
              <div style={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)' }}>{node.metadata?.containerId?.slice(0,12) || 'Not available'}</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)', gridColumn: '1 / -1' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>Uptime</div>
              <div style={{ color: 'rgba(255,255,255,0.8)' }}>{node.metadata?.uptime || 'Not available'}</div>
            </div>
          </div>
        </div>

        {/* Live Health */}
        <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: '16px', letterSpacing: '1px' }}>LIVE HEALTH</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }}>
            
            {/* CPU Bar */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>CPU Usage</span>
                <span style={{ fontWeight: 600 }}>{node.metrics?.cpu !== undefined ? `${node.metrics.cpu}%` : 'N/A'}</span>
              </div>
              <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ 
                  height: '100%', 
                  width: `${node.metrics?.cpu || 0}%`, 
                  background: 'linear-gradient(90deg, #4f8cff, #00d4ff)',
                  boxShadow: '0 0 10px rgba(0, 212, 255, 0.5)',
                  transition: 'width 0.3s ease'
                }} />
              </div>
            </div>

            {/* Memory Bar */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Memory</span>
                <span style={{ fontWeight: 600 }}>{node.metrics?.memoryPercent !== undefined ? `${node.metrics.memoryPercent}%` : 'N/A'}</span>
              </div>
              <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ 
                  height: '100%', 
                  width: `${node.metrics?.memoryPercent || 0}%`, 
                  background: 'linear-gradient(90deg, #9c27b0, #e040fb)',
                  boxShadow: '0 0 10px rgba(224, 64, 251, 0.5)',
                  transition: 'width 0.3s ease'
                }} />
              </div>
            </div>

            {/* Network */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '4px' }}>
              <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ color: '#00e676', background: 'rgba(0,230,118,0.1)', padding: '4px', borderRadius: '4px' }}>↓</div>
                <div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>Network RX</div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{node.metrics?.networkRx !== undefined ? formatBytes(node.metrics.networkRx) + '/s' : 'N/A'}</div>
                </div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ color: '#00d4ff', background: 'rgba(0,212,255,0.1)', padding: '4px', borderRadius: '4px' }}>↑</div>
                <div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>Network TX</div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{node.metrics?.networkTx !== undefined ? formatBytes(node.metrics.networkTx) + '/s' : 'N/A'}</div>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* Metrics History */}
        <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '1px' }}>METRICS HISTORY</div>
            <div style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.05)', padding: '2px', borderRadius: '12px' }}>
              {['5m', '15m', '30m', '1h'].map(t => (
                <button key={t} onClick={() => setTimeRange(t)} style={{
                  background: timeRange === t ? 'rgba(0, 212, 255, 0.2)' : 'transparent',
                  color: timeRange === t ? '#00d4ff' : 'rgba(255,255,255,0.5)',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontWeight: timeRange === t ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  boxShadow: timeRange === t ? '0 0 8px rgba(0,212,255,0.3)' : 'none'
                }}>{t}</button>
              ))}
            </div>
          </div>
          
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginBottom: '8px' }}>CPU Usage</div>
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <MiniChart data={metrics} dataKey="cpu" color="#00d4ff" />
            </div>
          </div>
          
          <div>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginBottom: '8px' }}>Memory Usage</div>
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <MiniChart data={metrics} dataKey="memoryPercent" color="#e040fb" />
            </div>
          </div>
        </div>

        {/* Upstream Dependencies */}
        <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: '12px', letterSpacing: '1px' }}>UPSTREAM DEPENDENCIES</div>
          {upstreams.length === 0 ? (
            <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '13px', fontStyle: 'italic', padding: '10px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>None</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {upstreams.map(u => (
                <div key={u.id} style={{ 
                  background: 'rgba(255,255,255,0.02)', 
                  padding: '12px', 
                  borderRadius: '6px', 
                  fontSize: '13px',
                  borderLeft: `3px solid ${u.status === 'failed' ? '#ff1744' : u.status === 'degraded' ? '#ffab00' : '#4f8cff'}`,
                  transition: 'background 0.2s',
                  cursor: 'default'
                }}
                onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                >
                  <div style={{ fontWeight: 600, color: '#fff' }}>{u.source}</div>
                  <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', display: 'flex', gap: '8px', marginTop: '6px' }}>
                    <span style={{ textTransform: 'capitalize', color: 'rgba(255,255,255,0.8)' }}>{u.type}</span>
                    {u.metrics?.latency !== undefined && u.metrics?.latency !== null && <span>• {u.metrics.latency}ms</span>}
                    {u.metrics?.errorRate !== undefined && u.metrics?.errorRate !== null && <span style={{ color: u.metrics.errorRate > 5 ? '#ff1744' : 'inherit' }}>• err {u.metrics.errorRate}%</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Downstream Dependencies */}
        <div style={{ padding: '20px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: '12px', letterSpacing: '1px' }}>DOWNSTREAM DEPENDENCIES</div>
          {downstreams.length === 0 ? (
            <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '13px', fontStyle: 'italic', padding: '10px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>None</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {downstreams.map(d => (
                <div key={d.id} style={{ 
                  background: 'rgba(255,255,255,0.02)', 
                  padding: '12px', 
                  borderRadius: '6px', 
                  fontSize: '13px',
                  borderLeft: `3px solid ${d.status === 'failed' ? '#ff1744' : d.status === 'degraded' ? '#ffab00' : '#e040fb'}`,
                  transition: 'background 0.2s',
                  cursor: 'default'
                }}
                onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                >
                  <div style={{ fontWeight: 600, color: '#fff' }}>{d.target}</div>
                  <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', display: 'flex', gap: '8px', marginTop: '6px' }}>
                    <span style={{ textTransform: 'capitalize', color: 'rgba(255,255,255,0.8)' }}>{d.type}</span>
                    {d.metrics?.latency !== undefined && d.metrics?.latency !== null && <span>• {d.metrics.latency}ms</span>}
                    {d.metrics?.errorRate !== undefined && d.metrics?.errorRate !== null && <span style={{ color: d.metrics.errorRate > 5 ? '#ff1744' : 'inherit' }}>• err {d.metrics.errorRate}%</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
