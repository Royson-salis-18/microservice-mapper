import React, { useState } from 'react';
import { X } from 'lucide-react';
import StatusBadge from './StatusBadge';
import MetricSparkline from './MetricSparkline';
import { formatBytes, formatPercent, formatUptime } from '../utils/formatters';

export default function InspectionPanel({ node, edges, onClose, metricHistory }) {
  const [timeRange, setTimeRange] = useState('5m');
  
  if (!node) return null;
  const { name, type, status, project, metadata = {}, metrics = {} } = node.data;
  
  const ranges = ['5m', '15m', '30m', '1h'];

  const SectionTitle = ({ children }) => (
    <h3 style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '24px 0 12px 0', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '4px' }}>
      {children}
    </h3>
  );

  return (
    <div className="inspection-panel">
      <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>{name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <StatusBadge status={status} size="sm" pulse={status === 'critical'} />
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>•</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{type}</span>
            {project && (
              <>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>•</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-accent)' }}>{project}</span>
              </>
            )}
          </div>
        </div>
        <button className="btn-ghost" onClick={onClose} style={{ padding: '4px' }}>
          <X size={20} />
        </button>
      </div>

      <div style={{ padding: '0 16px 24px 16px', overflowY: 'auto', flex: 1 }}>
        <SectionTitle>Service Info</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '8px', fontSize: '0.85rem' }}>
          <div style={{ color: 'var(--text-muted)' }}>Container ID</div>
          <div className="text-mono" style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{metadata.containerId || 'N/A'}</div>
          
          <div style={{ color: 'var(--text-muted)' }}>Image</div>
          <div className="text-mono" style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={metadata.image}>{metadata.image || 'N/A'}</div>
          
          <div style={{ color: 'var(--text-muted)' }}>Uptime</div>
          <div style={{ color: 'var(--text-primary)' }}>{formatUptime(metadata.createdTimestamp)}</div>
        </div>

        <SectionTitle>Live Health</SectionTitle>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {ranges.map(r => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              style={{
                background: timeRange === r ? 'var(--bg-hover)' : 'transparent',
                color: timeRange === r ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '12px',
                padding: '2px 8px',
                fontSize: '0.7rem',
                cursor: 'pointer'
              }}
            >
              {r}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="panel" style={{ padding: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>CPU Usage</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
              {metrics.cpu != null ? formatPercent(metrics.cpu) : 'Not available'}
            </div>
            <MetricSparkline data={metricHistory?.cpu} color="var(--color-accent)" height={40} label="cpu" unit="%" />
          </div>
          
          <div className="panel" style={{ padding: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Memory</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
              {metrics.memoryPercent != null ? formatPercent(metrics.memoryPercent) : 'Not available'}
            </div>
            <MetricSparkline data={metricHistory?.memory} color="var(--color-healthy)" height={40} label="mem" unit="%" />
          </div>

          <div className="panel" style={{ padding: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Network RX</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 500, color: 'var(--text-primary)' }}>
              {metrics.networkRx != null ? formatBytes(metrics.networkRx) : 'Not available'}
            </div>
          </div>

          <div className="panel" style={{ padding: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Network TX</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 500, color: 'var(--text-primary)' }}>
              {metrics.networkTx != null ? formatBytes(metrics.networkTx) : 'Not available'}
            </div>
          </div>
        </div>

        <SectionTitle>Request Telemetry</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="panel" style={{ padding: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Request Rate</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>Not available</div>
          </div>
          <div className="panel" style={{ padding: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Error Rate</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>Not available</div>
          </div>
          <div className="panel" style={{ padding: '12px', gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Avg Latency</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>Not available</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>P95</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>N/A</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>P99</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>N/A</div>
            </div>
          </div>
        </div>

        <SectionTitle>Dependencies</SectionTitle>
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>Upstream (Connects to this)</div>
          {edges.upstream.length === 0 ? (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No dependencies found</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {edges.upstream.map(edge => (
                <div key={edge.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-panel)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--color-${edge.data.status === 'error' ? 'critical' : 'healthy'})` }} />
                    <span style={{ color: 'var(--text-primary)' }}>{edge.sourceNodeName || edge.source}</span>
                  </div>
                  {edge.data.protocol && (
                    <span style={{ fontSize: '0.65rem', background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border-subtle)' }}>{edge.data.protocol}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>Downstream (This connects to)</div>
          {edges.downstream.length === 0 ? (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No dependencies found</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {edges.downstream.map(edge => (
                <div key={edge.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-panel)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--color-${edge.data.status === 'error' ? 'critical' : 'healthy'})` }} />
                    <span style={{ color: 'var(--text-primary)' }}>{edge.targetNodeName || edge.target}</span>
                  </div>
                  {edge.data.protocol && (
                    <span style={{ fontSize: '0.65rem', background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border-subtle)' }}>{edge.data.protocol}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <SectionTitle>Recent Events</SectionTitle>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '12px', background: 'var(--bg-panel)', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border-subtle)', textAlign: 'center' }}>
          No events captured yet
        </div>
      </div>
    </div>
  );
}
