import { Handle, Position } from '@xyflow/react';
import type { ServiceNode } from '../types';

interface ServiceNodeProps {
  data: ServiceNode;
  selected: boolean;
}

const typeIcons: Record<string, string> = {
  gateway: '🌐',
  service: '⚡',
  database: '🗄️',
  queue: '📨',
  frontend: '🖥️',
  infrastructure: '🔧',
  external: '☁️',
  unknown: '❓'
};

const getTypeColors = (type: string) => {
  switch (type) {
    case 'database': return { bg: 'rgba(224, 64, 251, 0.05)', tint: '#e040fb' };
    case 'gateway': return { bg: 'rgba(0, 212, 255, 0.05)', tint: '#00d4ff' };
    case 'queue': return { bg: 'rgba(255, 171, 0, 0.05)', tint: '#ffab00' };
    case 'frontend': return { bg: 'rgba(59, 130, 246, 0.05)', tint: '#3b82f6' };
    case 'service': return { bg: 'rgba(255, 255, 255, 0.03)', tint: '#94a3b8' };
    default: return { bg: 'rgba(255, 255, 255, 0.02)', tint: '#64748b' };
  }
};

export function CustomServiceNode({ data, selected }: ServiceNodeProps) {
  const getStatusColor = (s: string) => {
    if (s === 'healthy') return 'var(--color-healthy)';
    if (s === 'degraded') return 'var(--color-degraded)';
    if (s === 'critical') return 'var(--color-critical)';
    return 'var(--color-unknown)';
  };
  
  const getStatusGlow = (s: string) => {
    if (s === 'healthy') return 'var(--color-healthy-glow)';
    if (s === 'degraded') return 'var(--color-degraded-glow)';
    if (s === 'critical') return 'var(--color-critical-glow)';
    return 'rgba(255,255,255,0.1)';
  };

  const color = getStatusColor(data.status);
  const glow = getStatusGlow(data.status);
  const isCritical = data.status === 'critical';
  const typeStyle = getTypeColors(data.type as string);

  const viewMode = ((data as any).viewMode as string) || 'dependency';
  const isHealthy = data.status === 'healthy';

  let nodeOpacity = 1;
  if (viewMode === 'failure' && isHealthy) {
    nodeOpacity = 0.35;
  }

  const cpuPercent = data.metrics ? ((data.metrics as any).cpu || 0) : 0;
  const memPercent = data.metrics ? ((data.metrics as any).memoryPercent || 0) : 0;

  return (
    <div style={{
      width: '250px',
      background: 'rgba(10, 13, 24, 0.85)',
      backgroundImage: `linear-gradient(145deg, ${typeStyle.bg} 0%, rgba(10,13,24,0.95) 100%)`,
      border: `1px solid ${selected ? color : 'rgba(255,255,255,0.08)'}`,
      borderLeft: `4px solid ${color}`,
      borderRadius: '12px',
      boxShadow: selected 
        ? `0 12px 36px rgba(0,0,0,0.6), 0 0 24px ${glow}, inset 0 0 12px ${glow}` 
        : '0 8px 32px rgba(0,0,0,0.4)',
      padding: '14px',
      color: 'var(--color-text-main)',
      animation: isCritical ? 'pulse-critical 1.8s infinite' : 'none',
      position: 'relative',
      opacity: nodeOpacity,
      transition: 'all var(--transition-normal)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      transform: selected ? 'translateY(-3px)' : 'none',
      cursor: 'pointer'
    }}
    onMouseEnter={(e) => {
      if (!selected) {
        e.currentTarget.style.transform = 'translateY(-3px)';
        e.currentTarget.style.boxShadow = `0 14px 44px rgba(0,0,0,0.7), 0 0 18px ${glow}`;
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
      }
    }}
    onMouseLeave={(e) => {
      if (!selected) {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = '0 8px 32px rgba(0,0,0,0.4)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
      }
    }}
    >
      {/* Top Handle */}
      <Handle 
        type="target" 
        position={Position.Top} 
        style={{ 
          background: 'var(--color-bg-body)', 
          border: `2px solid ${color}`,
          width: '11px',
          height: '11px',
          borderRadius: '50%',
          boxShadow: `0 0 10px ${color}`
        }} 
      />
      
      {/* Status Dot Top Right */}
      <div style={{
        position: 'absolute',
        top: '12px',
        right: '12px',
        width: '9px',
        height: '9px',
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 10px ${color}`,
        animation: isHealthy ? 'breathe-healthy 3.5s infinite' : 'none'
      }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '34px',
          height: '34px',
          background: typeStyle.bg,
          border: `1px solid rgba(255,255,255,0.08)`,
          borderRadius: '9px',
          fontSize: '17px',
          boxShadow: 'inset 0 1px 3px rgba(255,255,255,0.05)'
        }}>
          {typeIcons[data.type as string] || typeIcons.unknown}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <span style={{ 
            fontWeight: 700, 
            fontSize: '14px', 
            whiteSpace: 'nowrap', 
            overflow: 'hidden', 
            textOverflow: 'ellipsis',
            letterSpacing: '-0.01em',
            color: '#fff'
          }}>
            {data.name as string}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
            <span style={{ 
              fontSize: '9px', 
              color: typeStyle.tint, 
              textTransform: 'uppercase',
              letterSpacing: '1px',
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: '4px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              {data.project as string}
            </span>
          </div>
        </div>
      </div>

      <div style={{ 
        marginTop: '8px',
        background: 'rgba(0,0,0,0.35)', 
        padding: '8px 10px', 
        borderRadius: '8px', 
        border: '1px solid rgba(255,255,255,0.04)',
        boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.3)'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-muted)', width: '26px', fontFamily: 'var(--font-mono)' }}>CPU</span>
            <div style={{ flex: 1, height: '5px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ 
                height: '100%', 
                width: `${Math.min(cpuPercent, 100)}%`, 
                background: cpuPercent > 80 ? 'linear-gradient(90deg, #ff1744, #ff5252)' : cpuPercent > 60 ? 'linear-gradient(90deg, #ffab00, #ffd740)' : 'linear-gradient(90deg, #00d4ff, #00e676)',
                borderRadius: '3px',
                transition: 'width 0.4s ease'
              }} />
            </div>
            <span style={{ fontSize: '9px', color: '#fff', width: '34px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{Number(cpuPercent).toFixed(1)}%</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-muted)', width: '26px', fontFamily: 'var(--font-mono)' }}>MEM</span>
            <div style={{ flex: 1, height: '5px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ 
                height: '100%', 
                width: `${Math.min(memPercent, 100)}%`, 
                background: memPercent > 80 ? 'linear-gradient(90deg, #ff1744, #ff5252)' : memPercent > 60 ? 'linear-gradient(90deg, #ffab00, #ffd740)' : 'linear-gradient(90deg, #e040fb, #7c4dff)',
                borderRadius: '3px',
                transition: 'width 0.4s ease'
              }} />
            </div>
            <span style={{ fontSize: '9px', color: '#fff', width: '34px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{Number(memPercent).toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Bottom Handle */}
      <Handle 
        type="source" 
        position={Position.Bottom} 
        style={{ 
          background: 'var(--color-bg-body)', 
          border: `2px solid ${color}`,
          width: '11px',
          height: '11px',
          borderRadius: '50%',
          boxShadow: `0 0 10px ${color}`
        }} 
      />
    </div>
  );
}
