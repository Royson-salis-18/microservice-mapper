import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { ServiceNode, DependencyEdge } from '../types';
import { MiniChart } from './MiniChart';
import { X, Router, Database, Layers, Rows3, Monitor, Box, Cpu, Globe, ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMetrics } from '../hooks/useMetrics';

interface InspectionPanelProps {
  node: ServiceNode | null;
  edges: DependencyEdge[];
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  healthy: '#3ecf8e',
  degraded: '#e8a33d',
  critical: '#ef5f67',
  unknown: '#6b7079'
};

const statusTint: Record<string, string> = {
  healthy: 'rgba(62,207,142,0.1)',
  degraded: 'rgba(232,163,61,0.1)',
  critical: 'rgba(239,95,103,0.1)',
  unknown: 'rgba(107,112,121,0.14)'
};

const typeIcons: Record<string, LucideIcon> = {
  gateway: Router,
  service: Box,
  database: Database,
  cache: Layers,
  queue: Rows3,
  frontend: Monitor,
  infrastructure: Cpu,
  external: Globe,
};

const sentence = (v: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : v);
const meterColor = (v: number) => (v > 95 ? 'var(--color-critical)' : v > 80 ? 'var(--color-degraded)' : 'var(--color-healthy)');
const edgeStatusColor = (st?: string) => (st === 'failed' ? 'var(--color-critical)' : st === 'degraded' ? 'var(--color-degraded)' : 'var(--color-text-dim)');

const section: CSSProperties = { padding: '20px', borderBottom: '1px solid var(--color-border)' };
const kpiValue: CSSProperties = { fontSize: '26px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--color-text-main)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 };
const kpiUnit: CSSProperties = { fontSize: '13px', fontWeight: 500, color: 'var(--color-text-muted)', marginLeft: '3px', letterSpacing: 0 };
const row: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', minHeight: '32px', fontSize: '13px' };
const rowLabel: CSSProperties = { color: 'var(--color-text-muted)' };
const rowValue: CSSProperties = { color: 'var(--color-text-main)', fontVariantNumeric: 'tabular-nums', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

function Kpi({ label, value, unit, meter, icon: Icon }: { label: string; value: string; unit?: string; meter?: number; icon?: LucideIcon }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '6px' }}>
        {Icon && <Icon size={14} strokeWidth={1.75} style={{ color: 'var(--color-text-dim)' }} />}
        {label}
      </div>
      <div style={kpiValue}>
        {value}
        {unit && value !== '-' && <span style={kpiUnit}>{unit}</span>}
      </div>
      {meter !== undefined && (
        <div style={{ marginTop: '10px', height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(meter, 100)}%`, background: meterColor(meter), borderRadius: '2px', transition: 'width 0.3s ease' }} />
        </div>
      )}
    </div>
  );
}

function DependencyList({ items, side }: { items: DependencyEdge[]; side: 'source' | 'target' }) {
  if (items.length === 0) {
    return <div style={{ fontSize: '12px', color: 'var(--color-text-dim)' }}>None</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((e, i) => (
        <div key={e.id} style={{
          display: 'flex', alignItems: 'center', gap: '10px', minHeight: '40px', padding: '6px 0',
          borderTop: i === 0 ? 'none' : '1px solid var(--color-border)', fontSize: '13px'
        }}>
          <span className="mm-dot" style={{ background: edgeStatusColor(e.status) }} />
          <span style={{ flex: 1, minWidth: 0, color: 'var(--color-text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e[side]}</span>
          <span style={{ display: 'flex', gap: '10px', fontSize: '12px', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            <span>{sentence(e.type)}</span>
            {e.metrics?.latency !== undefined && e.metrics?.latency !== null && <span>{e.metrics.latency} ms</span>}
            {e.metrics?.errorRate !== undefined && e.metrics?.errorRate !== null && <span style={{ color: e.metrics.errorRate > 5 ? 'var(--color-critical)' : 'inherit' }}>{e.metrics.errorRate}% err</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

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
  const sTint = statusTint[node.status] || statusTint.unknown;
  const TypeIcon = typeIcons[node.type] || Box;
  const isCascade = upstreams.some(e => e.status === 'failed');
  const problemColor = node.status === 'critical' ? 'var(--color-critical)' : 'var(--color-degraded)';

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

      {/* Header */}
      <div style={{ ...section, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <TypeIcon size={16} strokeWidth={1.75} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            <h3 style={{ fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</h3>
          </div>
          <span className="mm-chip" style={{ background: sTint, color: sColor, borderColor: 'transparent' }}>
            <i className="mm-dot" style={{ background: 'currentColor' }} />
            {sentence(node.status)}
          </span>
        </div>
        <button onClick={onClose} className="mm-icon-btn" title="Close" aria-label="Close">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="scroll-container" style={{ overflowY: 'auto', flex: 1 }}>
        {/* RCA Diagnostics Box */}
        {(node.status === 'critical' || node.status === 'degraded') && (
          <div style={section}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <TriangleAlert size={14} strokeWidth={1.75} style={{ color: problemColor }} />
              <span style={{ fontSize: '14px', fontWeight: 600 }}>Root cause analysis</span>
            </div>
            <div style={{
              fontSize: '13px', background: 'var(--color-bg-raised)', padding: '14px', borderRadius: '10px',
              border: '1px solid var(--color-border)', boxShadow: `inset 2px 0 0 ${problemColor}`
            }}>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                {isCascade ? 'Cascading dependency failure' : 'Primary root cause'}
              </div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: '12.5px', lineHeight: 1.5 }}>
                {isCascade
                  ? `Failed due to unreachable upstream dependency (${upstreams.filter(e => e.status === 'failed').map(e => e.source.replace(/^(sock-shop|vertikal)-/, '')).join(', ')})`
                  : `Service runtime anomaly detected (${node.metadata?.state || 'Degraded performance'}).`}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '12px', marginBottom: '6px' }}>Remediation command</div>
              <div style={{
                background: 'var(--color-bg-body)', border: '1px solid var(--color-border)', padding: '7px 10px', borderRadius: '6px',
                fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-text-main)', overflowX: 'auto', whiteSpace: 'nowrap'
              }}>
                docker restart {node.metadata?.containerName || node.metadata?.containerId || node.name}
              </div>
            </div>
          </div>
        )}

        {/* Service Info */}
        <div style={section}>
          <div className="mm-eyebrow" style={{ marginBottom: '8px' }}>Service info</div>
          <div style={row}><span style={rowLabel}>Type</span><span style={rowValue}>{sentence(node.type)}</span></div>
          <div style={row}><span style={rowLabel}>Project</span><span style={rowValue}>{node.project}</span></div>
          <div style={row}>
            <span style={rowLabel}>Container ID</span>
            <span style={{ ...rowValue, fontFamily: node.metadata?.containerId ? 'var(--font-mono)' : undefined, fontSize: node.metadata?.containerId ? '12px' : undefined }}>
              {node.metadata?.containerId?.slice(0,12) || 'Not available'}
            </span>
          </div>
          <div style={row}><span style={rowLabel}>Uptime</span><span style={rowValue}>{node.metadata?.uptime || 'Not available'}</span></div>
        </div>

        {/* Request-level metrics - present only when a Tier 1/2 source
            supplied them. Rendered as its own block, labelled with where it
            came from, rather than mixed in with the cgroup numbers: CPU is
            measured by the kernel and latency is measured by whatever the
            target happens to run, and those are not the same kind of fact. */}
        {node.metrics?.provenance && (
          <div style={section}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span className="mm-eyebrow">Request metrics</span>
              <span className="mm-chip" title={node.metrics.provenance.detail || ''} style={{ height: '20px', fontSize: '11px' }}>
                Tier {node.metrics.provenance.tier} · {node.metrics.provenance.source}
              </span>
            </div>
            {([
              ['p50 latency', node.metrics.latencyP50, 'ms'],
              ['p95 latency', node.metrics.latencyP95, 'ms'],
              ['p99 latency', node.metrics.latencyP99, 'ms'],
              ['Request rate', node.metrics.requestRate, '/s'],
            ] as [string, number | null | undefined, string][]).map(([label, value, unit]) => (
              <div key={label} style={row}>
                <span style={rowLabel}>{label}</span>
                <span style={rowValue}>
                  {value === null || value === undefined
                    ? <span style={{ color: 'var(--color-text-dim)' }}>Not measured</span>
                    : `${value < 10 ? value.toFixed(2) : value.toFixed(1)}${unit === 'ms' ? ' ms' : unit}`}
                </span>
              </div>
            ))}
            <div style={row}>
              <span style={rowLabel}>Error rate</span>
              <span style={{ ...rowValue, color: (node.metrics.errorRate ?? 0) > 0 ? 'var(--color-critical)' : rowValue.color }}>
                {/* null here means "no traffic in the window", which is not
                    the same as 0% and must not be shown as a clean bill. */}
                {node.metrics.errorRate === null || node.metrics.errorRate === undefined
                  ? <span style={{ color: 'var(--color-text-dim)' }}>No traffic in window</span>
                  : `${(node.metrics.errorRate * 100).toFixed(2)}%`}
              </span>
            </div>
          </div>
        )}

        {/* Live Health */}
        <div style={section}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <span className="mm-eyebrow">Live health</span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-dim)' }}>Tier 0 · cgroup</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 16px' }}>
            <Kpi label="CPU" value={node.metrics?.cpu !== undefined ? `${node.metrics.cpu}` : '-'} unit="%" meter={node.metrics?.cpu || 0} />
            <Kpi label="Memory" value={node.metrics?.memoryPercent !== undefined ? `${node.metrics.memoryPercent}` : '-'} unit="%" meter={node.metrics?.memoryPercent || 0} />
            <Kpi label="Network RX" icon={ArrowDown} value={node.metrics?.networkRx !== undefined ? formatBytes(node.metrics.networkRx).split(' ')[0] : '-'} unit={node.metrics?.networkRx !== undefined ? `${formatBytes(node.metrics.networkRx).split(' ')[1]}/s` : undefined} />
            <Kpi label="Network TX" icon={ArrowUp} value={node.metrics?.networkTx !== undefined ? formatBytes(node.metrics.networkTx).split(' ')[0] : '-'} unit={node.metrics?.networkTx !== undefined ? `${formatBytes(node.metrics.networkTx).split(' ')[1]}/s` : undefined} />
          </div>
        </div>

        {/* Metrics History */}
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <span className="mm-eyebrow">Metrics history</span>
            <div className="mm-seg" style={{ gridTemplateColumns: 'repeat(4, 40px)' }}>
              {['5m', '15m', '30m', '1h'].map(t => (
                <button key={t} className={timeRange === t ? 'on' : undefined} onClick={() => setTimeRange(t)} style={{ height: '22px', fontSize: '11.5px' }}>{t}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>CPU usage</div>
            <MiniChart data={metrics} dataKey="cpu" color="#8ab4ff" />
          </div>

          <div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '8px' }}>Memory usage</div>
            <MiniChart data={metrics} dataKey="memoryPercent" color="#b4a5ff" />
          </div>
        </div>

        {/* Upstream Dependencies */}
        <div style={section}>
          <div className="mm-eyebrow" style={{ marginBottom: '8px' }}>Upstream dependencies</div>
          <DependencyList items={upstreams} side="source" />
        </div>

        {/* Downstream Dependencies */}
        <div style={{ padding: '20px' }}>
          <div className="mm-eyebrow" style={{ marginBottom: '8px' }}>Downstream dependencies</div>
          <DependencyList items={downstreams} side="target" />
        </div>

      </div>
    </div>
  );
}
