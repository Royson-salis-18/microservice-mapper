import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { Server, Database, MessageSquare, Globe, Monitor, Cloud, Cpu, MemoryStick as Memory } from 'lucide-react';
import { formatPercent } from '../utils/formatters';
import StatusBadge from './StatusBadge';

const typeIcons = {
  service: Server,
  database: Database,
  queue: MessageSquare,
  gateway: Globe,
  frontend: Monitor,
  external: Cloud
};

export default function ServiceNode({ data, selected }) {
  const { name, type, status, project, metrics = {}, metadata = {} } = data;
  
  const Icon = typeIcons[type] || Server;
  const isCritical = status === 'critical';
  
  let borderColor = `var(--color-${status})`;
  if (status === 'unknown') borderColor = 'var(--border-subtle)';
  
  const projColor = project === 'sock-shop' ? 'var(--color-accent)' : '#ec4899';

  return (
    <div style={{
      width: 220,
      background: 'var(--bg-card)',
      borderRadius: 'var(--radius-md)',
      border: `1px solid ${selected ? borderColor : 'var(--border-subtle)'}`,
      padding: '12px',
      boxShadow: selected ? `0 0 15px var(--color-${status}-glow)` : 'none',
      animation: (isCritical && !selected) ? 'pulse-critical 2s infinite' : 'none',
      position: 'relative',
      color: 'var(--text-primary)',
      backdropFilter: 'blur(8px)',
      transition: 'var(--transition-fast)'
    }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      
      <div style={{ position: 'absolute', top: 8, right: 8 }}>
        <StatusBadge status={status} showLabel={false} size="sm" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <Icon size={18} color="var(--text-secondary)" />
        <div style={{ fontWeight: 500, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '150px' }}>
          {name}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
        {project && (
          <span style={{ fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px', background: `${projColor}20`, color: projColor, border: `1px solid ${projColor}40`, textTransform: 'uppercase', fontWeight: 600 }}>
            {project}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', paddingTop: '8px' }}>
        {metrics.cpu != null || metrics.memoryPercent != null ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Cpu size={12} /> {formatPercent(metrics.cpu)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Memory size={12} /> {formatPercent(metrics.memoryPercent)}
            </div>
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>No metrics</span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
