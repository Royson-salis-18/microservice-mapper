import type { DependencyEdge } from '../types';

interface EdgeInspectionPanelProps {
  edge: DependencyEdge | null;
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  healthy: '#00e676',
  degraded: '#ffab00',
  failed: '#ff1744',
  unknown: '#616161'
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export function EdgeInspectionPanel({ edge, onClose }: EdgeInspectionPanelProps) {
  if (!edge) return null;

  const errRate = edge.metrics?.errorRate ?? 0;
  const isCritical = errRate > 0.05 || edge.status === 'failed';
  const isDegraded = !isCritical && (edge.status === 'degraded' || (edge.metrics?.latency ?? 0) > 500);
  
  const statusColor = isCritical ? statusColors.failed : isDegraded ? statusColors.degraded : edge.observed ? statusColors.healthy : statusColors.unknown;

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
        @keyframes pulseArrow {
          0% { transform: translateX(0); opacity: 0.5; }
          50% { transform: translateX(4px); opacity: 1; }
          100% { transform: translateX(0); opacity: 0.5; }
        }
        .scroll-container::-webkit-scrollbar { width: 6px; }
        .scroll-container::-webkit-scrollbar-track { background: transparent; }
        .scroll-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      `}</style>
      
      <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '1px', marginBottom: '8px' }}>CONNECTION</div>
          <h3 style={{ fontSize: '18px', fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: '8px', textShadow: '0 0 10px rgba(255,255,255,0.2)' }}>
            <span style={{ color: '#fff' }}>{edge.source}</span> 
            <span style={{ 
              color: statusColor, 
              animation: edge.observed ? 'pulseArrow 2s infinite' : 'none',
              display: 'inline-block',
              textShadow: `0 0 8px ${statusColor}`
            }}>→</span> 
            <span style={{ color: '#fff' }}>{edge.target}</span>
          </h3>
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
        <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: '16px', letterSpacing: '1px' }}>INTERACTION DETAILS</div>
          
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
            <div style={{ background: 'rgba(0, 212, 255, 0.1)', border: '1px solid rgba(0, 212, 255, 0.3)', color: '#00d4ff', padding: '4px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, textTransform: 'capitalize' }}>
              Type: {edge.type}
            </div>
            <div style={{ background: 'rgba(224, 64, 251, 0.1)', border: '1px solid rgba(224, 64, 251, 0.3)', color: '#e040fb', padding: '4px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }}>
              Protocol: {edge.protocol || 'Unknown'}
            </div>
            {edge.evidenceSources?.map(src => (
              <div key={src} style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', color: 'rgba(255,255,255,0.8)', padding: '4px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                {src}
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '13px' }}>
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>First seen</div>
              <div>{edge.firstSeen ? new Date(edge.firstSeen).toLocaleString() : 'N/A'}</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px' }}>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>Last seen</div>
              <div>{edge.lastSeen ? new Date(edge.lastSeen).toLocaleString() : 'N/A'}</div>
            </div>
          </div>
        </div>

        <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', marginBottom: '16px', letterSpacing: '1px' }}>RUNTIME TELEMETRY</div>
          
          {!edge.observed ? (
            <div style={{ 
              background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.1)', 
              borderRadius: '8px', padding: '24px', textAlign: 'center', color: 'rgba(255,255,255,0.4)' 
            }}>
              <div style={{ fontSize: '24px', marginBottom: '8px' }}>📡</div>
              <div style={{ fontSize: '13px' }}>No runtime telemetry available</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '13px' }}>
              
              {/* Highlight Cards */}
              <div style={{ background: 'linear-gradient(145deg, rgba(79, 140, 255, 0.1), rgba(0, 212, 255, 0.05))', border: '1px solid rgba(0, 212, 255, 0.2)', padding: '16px', borderRadius: '8px', boxShadow: 'inset 0 0 20px rgba(0, 212, 255, 0.05)' }}>
                <div style={{ color: '#00d4ff', marginBottom: '8px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }}>Request Rate</div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#fff', textShadow: '0 0 10px rgba(0, 212, 255, 0.3)' }}>
                  {edge.metrics?.requestRate !== undefined && edge.metrics?.requestRate !== null ? `${edge.metrics.requestRate.toFixed(2)}` : 'N/A'}
                  <span style={{ fontSize: '12px', fontWeight: 400, color: 'rgba(255,255,255,0.5)', marginLeft: '4px' }}>req/s</span>
                </div>
              </div>
              
              <div style={{ background: errRate > 0.05 ? 'linear-gradient(145deg, rgba(255, 23, 68, 0.1), rgba(255, 23, 68, 0.02))' : 'rgba(255,255,255,0.03)', border: `1px solid ${errRate > 0.05 ? 'rgba(255, 23, 68, 0.3)' : 'rgba(255,255,255,0.05)'}`, padding: '16px', borderRadius: '8px' }}>
                <div style={{ color: errRate > 0.05 ? '#ff1744' : 'rgba(255,255,255,0.5)', marginBottom: '8px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }}>Error Rate</div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: errRate > 0.05 ? '#ff1744' : '#fff', textShadow: errRate > 0.05 ? '0 0 10px rgba(255, 23, 68, 0.4)' : 'none' }}>
                  {edge.metrics?.errorRate !== undefined && edge.metrics?.errorRate !== null ? `${(errRate * 100).toFixed(2)}%` : 'N/A'}
                </div>
              </div>
              
              {/* Latency Percentiles */}
              <div style={{ gridColumn: '1 / -1', marginTop: '4px' }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', marginBottom: '8px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }}>Latency Percentiles</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)', padding: '12px', borderRadius: '8px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '11px', color: '#00e676', marginBottom: '4px', fontWeight: 600 }}>P50</div>
                    <div style={{ fontSize: '15px', fontWeight: 500 }}>{edge.metrics?.p50Latency !== undefined && edge.metrics?.p50Latency !== null ? `${edge.metrics.p50Latency}ms` : '-'}</div>
                  </div>
                  <div style={{ textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.1)', borderRight: '1px solid rgba(255,255,255,0.1)' }}>
                    <div style={{ fontSize: '11px', color: '#ffab00', marginBottom: '4px', fontWeight: 600 }}>P95</div>
                    <div style={{ fontSize: '15px', fontWeight: 500 }}>{edge.metrics?.p95Latency !== undefined && edge.metrics?.p95Latency !== null ? `${edge.metrics.p95Latency}ms` : '-'}</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '11px', color: '#ff1744', marginBottom: '4px', fontWeight: 600 }}>P99</div>
                    <div style={{ fontSize: '15px', fontWeight: 500 }}>{edge.metrics?.p99Latency !== undefined && edge.metrics?.p99Latency !== null ? `${edge.metrics.p99Latency}ms` : '-'}</div>
                  </div>
                </div>
              </div>
              
              {/* Compact Stats */}
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '6px', marginTop: '4px' }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>Total Requests</div>
                <div style={{ fontSize: '15px', fontWeight: 600 }}>{edge.metrics?.requestCount !== undefined && edge.metrics?.requestCount !== null ? edge.metrics.requestCount.toLocaleString() : 'N/A'}</div>
              </div>
              
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '6px', marginTop: '4px' }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', marginBottom: '4px' }}>Total Errors</div>
                <div style={{ fontSize: '15px', fontWeight: 600, color: edge.metrics?.errorCount && edge.metrics.errorCount > 0 ? '#ff1744' : 'inherit' }}>
                  {edge.metrics?.errorCount !== undefined && edge.metrics?.errorCount !== null ? edge.metrics.errorCount.toLocaleString() : 'N/A'}
                </div>
              </div>
              
              <div style={{ gridColumn: '1 / -1', background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ background: 'rgba(224, 64, 251, 0.1)', color: '#e040fb', padding: '6px', borderRadius: '4px' }}>💾</div>
                  <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', fontWeight: 600 }}>DATA TRANSFERRED</div>
                </div>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>
                  {edge.metrics?.bytesSent !== undefined && edge.metrics?.bytesSent !== null 
                    ? formatBytes(edge.metrics.bytesSent) 
                    : 'N/A'}
                </div>
              </div>
              
              <div style={{ gridColumn: '1 / -1', background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ background: 'rgba(0, 212, 255, 0.1)', color: '#00d4ff', padding: '6px', borderRadius: '4px' }}>⚡</div>
                  <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px', fontWeight: 600 }}>THROUGHPUT</div>
                </div>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>
                  {edge.metrics?.throughput !== undefined && edge.metrics?.throughput !== null 
                    ? `${formatBytes(edge.metrics.throughput)}/s` 
                    : 'N/A'}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
