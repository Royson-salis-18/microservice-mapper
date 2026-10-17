import { useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Router, Database, Layers, Rows3, Monitor, Box, Cpu, Globe } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ServiceNode } from '../types';
import { tint, STATE_HEX } from './shared/palette';

interface ServiceNodeProps {
  data: ServiceNode;
  selected: boolean;
}

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

const meterColor = (v: number) => (v > 95 ? 'var(--color-critical)' : v > 80 ? 'var(--color-degraded)' : 'var(--color-healthy)');

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontSize: '10.5px', color: 'var(--color-text-dim)', width: '26px' }}>{label}</span>
      <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${Math.min(value, 100)}%`,
          background: meterColor(value),
          borderRadius: '2px',
          transition: 'width 0.4s ease'
        }} />
      </div>
      <span style={{ fontSize: '10.5px', color: 'var(--color-text-muted)', width: '36px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {Number(value).toFixed(1)}%
      </span>
    </div>
  );
}

export function CustomServiceNode({ data, selected }: ServiceNodeProps) {
  const [hovered, setHovered] = useState(false);

  const getStatusColor = (s: string) => {
    if (s === 'healthy') return 'var(--color-healthy)';
    if (s === 'degraded') return 'var(--color-degraded)';
    if (s === 'critical') return 'var(--color-critical)';
    return 'var(--color-unknown)';
  };

  const color = getStatusColor(data.status);
  const isCritical = data.status === 'critical';
  const isHealthy = data.status === 'healthy';
  const TypeIcon = typeIcons[data.type as string] || Box;
  const stateHex = STATE_HEX[data.status as string] ?? STATE_HEX.unknown;

  const viewMode = ((data as any).viewMode as string) || 'dependency';

  let nodeOpacity = 1;
  if (viewMode === 'failure' && isHealthy) {
    nodeOpacity = 0.35;
  }

  const cpuPercent = data.metrics ? ((data.metrics as any).cpu || 0) : 0;
  const memPercent = data.metrics ? ((data.metrics as any).memoryPercent || 0) : 0;

  const borderColor = selected
    ? 'rgba(138,180,255,0.6)'
    : hovered ? 'var(--color-border-hover)' : 'var(--color-border)';

  const shadows: string[] = [];
  if (!isHealthy) shadows.push(`inset 2px 0 0 ${color}`);
  if (selected) shadows.push('0 0 0 3px rgba(138,180,255,0.12)');
  shadows.push('0 1px 2px rgba(0,0,0,0.4)');

  const handleStyle = {
    background: 'var(--color-bg-panel)',
    border: '1px solid var(--color-border-hover)',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
  };

  return (
    <div
      style={{
        width: '180px',
        background: `linear-gradient(180deg, ${tint(stateHex, hovered ? 0.1 : 0.06)}, transparent 60%), ${hovered && !selected ? 'var(--color-bg-panel-hover)' : 'var(--color-bg-panel)'}`,
        border: `1px solid ${borderColor}`,
        borderTop: `2px solid ${selected ? borderColor : tint(stateHex, 0.75)}`,
        borderRadius: '10px',
        boxShadow: shadows.join(', '),
        padding: '12px',
        color: 'var(--color-text-main)',
        position: 'relative',
        opacity: nodeOpacity,
        transition: 'border-color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast), opacity var(--transition-normal)',
        cursor: 'grab'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />

      {data.analytics?.anomalyPersistent && (
        <span
          className="mm-chip"
          title={`Isolation Forest: anomaly score ${((data.analytics?.anomalyScore ?? 0) * 100).toFixed(0)}%, sustained over multiple windows`}
          style={{
            position: 'absolute',
            top: '-11px',
            right: '8px',
            height: '20px',
            fontSize: '10.5px',
            background: 'var(--color-bg-raised)',
            border: '1px solid rgba(239,95,103,0.35)',
            color: 'var(--color-critical)',
            zIndex: 2,
          }}
        >
          Anomaly
        </span>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center',
              background: tint(stateHex, 0.14), border: `1px solid ${tint(stateHex, 0.3)}` }}>
              <TypeIcon size={13} strokeWidth={1.9} style={{ color: stateHex }} />
            </span>
            <span style={{
              fontWeight: 600,
              fontSize: '13px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              letterSpacing: '-0.01em',
              color: 'var(--color-text-main)'
            }}>
              {data.name as string}
            </span>
          </div>
          <span style={{
            fontSize: '11px',
            color: 'var(--color-text-dim)',
            marginTop: '3px',
            paddingLeft: '21px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {data.project as string}
          </span>
        </div>

        <span
          className="mm-dot"
          style={{
            background: color,
            animation: isCritical ? 'pulse-critical 1.8s infinite' : isHealthy ? 'breathe-healthy 3.5s infinite' : 'none',
            marginTop: '5px',
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        <Meter label="CPU" value={cpuPercent} />
        <Meter label="Mem" value={memPercent} />
      </div>

      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}
