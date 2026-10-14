import type { CSSProperties } from 'react';
import { X, ArrowRight, RadioTower, HardDrive, Gauge } from 'lucide-react';
import type { DependencyEdge } from '../types';

interface EdgeInspectionPanelProps {
  edge: DependencyEdge | null;
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  healthy: '#3ecf8e',
  degraded: '#e8a33d',
  failed: '#ef5f67',
  unknown: '#6b7079'
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const section: CSSProperties = { padding: '20px', borderBottom: '1px solid var(--color-border)' };
const kpiValue: CSSProperties = { fontSize: '26px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--color-text-main)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 };
const kpiUnit: CSSProperties = { fontSize: '13px', fontWeight: 500, color: 'var(--color-text-muted)', marginLeft: '4px', letterSpacing: 0 };
const kpiLabel: CSSProperties = { fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '6px' };
const row: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', minHeight: '32px', fontSize: '13px' };
const rowLabel: CSSProperties = { display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--color-text-muted)' };
const rowValue: CSSProperties = { color: 'var(--color-text-main)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };

export function EdgeInspectionPanel({ edge, onClose }: EdgeInspectionPanelProps) {
  if (!edge) return null;

  const errRate = edge.metrics?.errorRate ?? 0;
  const isCritical = errRate > 0.05 || edge.status === 'failed';
  const isDegraded = !isCritical && (edge.status === 'degraded' || (edge.metrics?.latency ?? 0) > 500);

  const statusColor = isCritical ? statusColors.failed : isDegraded ? statusColors.degraded : edge.observed ? statusColors.healthy : statusColors.unknown;
  const statusLabel = isCritical ? 'Failing' : isDegraded ? 'Degraded' : edge.observed ? 'Healthy' : 'Not observed';
  const statusTint = isCritical ? 'rgba(239,95,103,0.1)' : isDegraded ? 'rgba(232,163,61,0.1)' : edge.observed ? 'rgba(62,207,142,0.1)' : 'rgba(107,112,121,0.14)';
  const typeLabel = edge.type ? edge.type.charAt(0).toUpperCase() + edge.type.slice(1) : edge.type;

  const latency = (v: number | null | undefined) => (v !== undefined && v !== null ? <>{v}<span style={kpiUnit}>ms</span></> : '-');

  return (
    <div style={{
      width: '400px',
      // main-content is a flex row (Scene3D/canvas + this panel as siblings);
      // without flexShrink:0 the flex algorithm crushes this panel toward 0
      // width instead of shrinking the canvas side, so it rendered off the
      // right edge of the viewport at ~40px wide with all its content
      // still there but invisible. flexShrink:0 makes the 400px authoritative.
      flexShrink: 0,
      background: 'var(--color-bg-panel)',
      borderLeft: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      animation: 'slideInRight 0.24s cubic-bezier(0.2, 0, 0, 1)',
      overflowY: 'auto',
      color: 'var(--color-text-main)',
      height: '100%',
      fontFamily: 'var(--font-family)'
    }}>
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(16px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .scroll-container::-webkit-scrollbar { width: 6px; }
        .scroll-container::-webkit-scrollbar-track { background: transparent; }
        .scroll-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      `}</style>

      <div style={{ ...section, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
        <div style={{ minWidth: 0 }}>
          <div className="mm-eyebrow" style={{ marginBottom: '8px' }}>Connection</div>
          <h3 style={{ fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span>{edge.source}</span>
            <ArrowRight size={16} strokeWidth={1.75} style={{ color: 'var(--color-text-dim)', flexShrink: 0 }} />
            <span>{edge.target}</span>
          </h3>
          <span className="mm-chip" style={{ background: statusTint, color: statusColor, borderColor: 'transparent' }}>
            <i className="mm-dot" style={{ background: 'currentColor' }} />
            {statusLabel}
          </span>
        </div>
        <button onClick={onClose} className="mm-icon-btn" title="Close" aria-label="Close">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="scroll-container" style={{ overflowY: 'auto', flex: 1 }}>
        <div style={section}>
          <div className="mm-eyebrow" style={{ marginBottom: '12px' }}>Interaction details</div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
            <span className="mm-chip">Type: {typeLabel}</span>
            <span className="mm-chip">Protocol: {edge.protocol || 'Unknown'}</span>
            {edge.evidenceSources?.map(src => (
              <span key={src} className="mm-chip" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{src}</span>
            ))}
          </div>

          <div style={row}><span style={rowLabel}>First seen</span><span style={rowValue}>{edge.firstSeen ? new Date(edge.firstSeen).toLocaleString() : 'Not available'}</span></div>
          <div style={row}><span style={rowLabel}>Last seen</span><span style={rowValue}>{edge.lastSeen ? new Date(edge.lastSeen).toLocaleString() : 'Not available'}</span></div>
        </div>

        <div style={section}>
          <div className="mm-eyebrow" style={{ marginBottom: '16px' }}>Runtime telemetry</div>

          {!edge.observed ? (
            <div style={{ padding: '24px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', textAlign: 'center' }}>
              <RadioTower size={20} strokeWidth={1.75} style={{ color: 'var(--color-text-dim)', marginBottom: '4px' }} />
              <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No runtime telemetry</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>This link is declared but no traffic has been observed.</div>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 16px', marginBottom: '20px' }}>
                <div>
                  <div style={kpiLabel}>Request rate</div>
                  <div style={kpiValue}>
                    {edge.metrics?.requestRate !== undefined && edge.metrics?.requestRate !== null
                      ? <>{edge.metrics.requestRate.toFixed(2)}<span style={kpiUnit}>req/s</span></>
                      : '-'}
                  </div>
                </div>
                <div>
                  <div style={kpiLabel}>Error rate</div>
                  <div style={{ ...kpiValue, color: errRate > 0.05 ? 'var(--color-critical)' : kpiValue.color }}>
                    {edge.metrics?.errorRate !== undefined && edge.metrics?.errorRate !== null ? `${(errRate * 100).toFixed(2)}%` : '-'}
                  </div>
                </div>
              </div>

              <div style={{ ...kpiLabel, marginBottom: '8px' }}>Latency percentiles</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', border: '1px solid var(--color-border)', borderRadius: '10px', marginBottom: '16px' }}>
                {([
                  ['p50', edge.metrics?.p50Latency],
                  ['p95', edge.metrics?.p95Latency],
                  ['p99', edge.metrics?.p99Latency],
                ] as [string, number | null | undefined][]).map(([label, v], i) => (
                  <div key={label} style={{ padding: '12px 14px', borderLeft: i === 0 ? 'none' : '1px solid var(--color-border)' }}>
                    <div style={{ fontSize: '11.5px', color: 'var(--color-text-dim)', marginBottom: '4px' }}>{label}</div>
                    <div style={{ fontSize: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{latency(v)}</div>
                  </div>
                ))}
              </div>

              <div style={row}>
                <span style={rowLabel}>Total requests</span>
                <span style={rowValue}>{edge.metrics?.requestCount !== undefined && edge.metrics?.requestCount !== null ? edge.metrics.requestCount.toLocaleString() : 'Not available'}</span>
              </div>
              <div style={{ ...row, borderTop: '1px solid var(--color-border)' }}>
                <span style={rowLabel}>Total errors</span>
                <span style={{ ...rowValue, color: edge.metrics?.errorCount && edge.metrics.errorCount > 0 ? 'var(--color-critical)' : rowValue.color }}>
                  {edge.metrics?.errorCount !== undefined && edge.metrics?.errorCount !== null ? edge.metrics.errorCount.toLocaleString() : 'Not available'}
                </span>
              </div>
              <div style={{ ...row, borderTop: '1px solid var(--color-border)' }}>
                <span style={rowLabel}><HardDrive size={14} strokeWidth={1.75} style={{ color: 'var(--color-text-dim)' }} />Data transferred</span>
                <span style={rowValue}>
                  {edge.metrics?.bytesSent !== undefined && edge.metrics?.bytesSent !== null
                    ? formatBytes(edge.metrics.bytesSent)
                    : 'Not available'}
                </span>
              </div>
              <div style={{ ...row, borderTop: '1px solid var(--color-border)' }}>
                <span style={rowLabel}><Gauge size={14} strokeWidth={1.75} style={{ color: 'var(--color-text-dim)' }} />Throughput</span>
                <span style={rowValue}>
                  {edge.metrics?.throughput !== undefined && edge.metrics?.throughput !== null
                    ? `${formatBytes(edge.metrics.throughput)}/s`
                    : 'Not available'}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
