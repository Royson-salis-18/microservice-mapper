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
      width: '180px',
      background: 'var(--color-bg-panel)',
      backgroundImage: `linear-gradient(145deg, ${typeStyle.bg} 0%, rgba(10,13,24,0.95) 100%)`,
      border: `1px solid ${selected ? color : 'rgba(255,255,255,0.08)'}`,
      borderRadius: '8px',
      boxShadow: selected 
        ? `0 8px 24px rgba(0,0,0,0.6), 0 0 16px ${glow}, inset 0 0 8px ${glow}` 
        : '0 4px 16px rgba(0,0,0,0.4)',
      padding: '12px',
      color: 'var(--color-text-main)',
      animation: isCritical ? 'pulse-critical 1.8s infinite' : 'none',
      position: 'relative',
      opacity: nodeOpacity,
      transition: 'all var(--transition-normal)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      transform: selected ? 'translateY(-2px)' : 'none',
      cursor: 'pointer'
    }}
    onMouseEnter={(e) => {
      if (!selected) {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = `0 8px 24px rgba(0,0,0,0.7), 0 0 12px ${glow}`;
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
      }
    }}
    onMouseLeave={(e) => {
      if (!selected) {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
      }
    }}
    >
      <Handle 
        type="target" 
        position={Position.Top} 
        style={{ 
          background: 'var(--color-bg-body)', 
          border: `2px solid ${color}`,
          width: '9px',
          height: '9px',
          borderRadius: '50%',
          boxShadow: `0 0 8px ${color}`
        }} 
      />
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px' }}>{typeIcons[data.type as string] || typeIcons.unknown}</span>
            <span style={{ 
              fontWeight: 700, 
              fontSize: '13px', 
              whiteSpace: 'nowrap', 
              overflow: 'hidden', 
              textOverflow: 'ellipsis',
              letterSpacing: '-0.01em',
              color: '#fff'
            }}>
              {data.name as string}
            </span>
          </div>
          <span style={{ 
            fontSize: '9px', 
            color: typeStyle.tint, 
            textTransform: 'uppercase',
            letterSpacing: '1px',
            fontWeight: 700,
            marginTop: '2px',
            opacity: 0.8
          }}>
            {data.project as string}
          </span>
        </div>
        
        <div style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 8px ${color}`,
          animation: isHealthy ? 'breathe-healthy 3.5s infinite' : 'none',
          marginTop: '4px',
          flexShrink: 0
        }} />
      </div>

      <div style={{ 
        background: 'rgba(0,0,0,0.4)', 
        padding: '6px 8px', 
        borderRadius: '6px', 
        border: '1px solid rgba(255,255,255,0.03)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-muted)', width: '22px', fontFamily: 'var(--font-mono)' }}>CPU</span>
            <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ 
                height: '100%', 
                width: `${Math.min(cpuPercent, 100)}%`, 
                background: cpuPercent > 80 ? 'linear-gradient(90deg, #ff1744, #ff5252)' : cpuPercent > 60 ? 'linear-gradient(90deg, #ffab00, #ffd740)' : 'linear-gradient(90deg, #00d4ff, #00e676)',
                borderRadius: '2px',
                transition: 'width 0.4s ease'
              }} />
            </div>
            <span style={{ fontSize: '9px', color: '#fff', width: '32px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{Number(cpuPercent).toFixed(1)}%</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-muted)', width: '22px', fontFamily: 'var(--font-mono)' }}>MEM</span>
            <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ 
                height: '100%', 
                width: `${Math.min(memPercent, 100)}%`, 
                background: memPercent > 80 ? 'linear-gradient(90deg, #ff1744, #ff5252)' : memPercent > 60 ? 'linear-gradient(90deg, #ffab00, #ffd740)' : 'linear-gradient(90deg, #e040fb, #7c4dff)',
                borderRadius: '2px',
                transition: 'width 0.4s ease'
              }} />
            </div>
            <span style={{ fontSize: '9px', color: '#fff', width: '32px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{Number(memPercent).toFixed(1)}%</span>
          </div>
        </div>
      </div>

      <Handle 
        type="source" 
        position={Position.Bottom} 
        style={{ 
          background: 'var(--color-bg-body)', 
          border: `2px solid ${color}`,
          width: '9px',
          height: '9px',
          borderRadius: '50%',
          boxShadow: `0 0 8px ${color}`
        }} 
      />
    </div>
  );
}
