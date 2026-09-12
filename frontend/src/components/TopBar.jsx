import React from 'react';
import { Network, Search } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { formatTimestamp } from '../utils/formatters';

export default function TopBar({ filters, setFilters, graphStats, isConnected, lastUpdate }) {
  const projects = ['all', 'sock-shop', 'vertikal'];

  return (
    <div className="top-bar">
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Network color="var(--color-accent)" size={24} />
        <span style={{ fontSize: '1.1rem', fontWeight: 600, letterSpacing: '-0.5px' }}>MicroMapper</span>
      </div>

      <div style={{ display: 'flex', gap: '24px', color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 500 }}>
        <span style={{ color: 'var(--text-primary)', borderBottom: '2px solid var(--color-accent)' }}>Architecture</span>
        <span>Telemetry</span>
        <span>Dependencies</span>
        <span>Analytics</span>
      </div>

      <div style={{ display: 'flex', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)', padding: '4px' }}>
        {projects.map(p => (
          <button
            key={p}
            onClick={() => setFilters(f => ({ ...f, projectFilter: p }))}
            style={{
              background: filters.projectFilter === p ? 'var(--bg-hover)' : 'transparent',
              color: filters.projectFilter === p ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: 'none',
              padding: '6px 12px',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              fontWeight: 500,
              textTransform: 'uppercase',
              fontSize: '0.75rem',
              transition: 'var(--transition-fast)'
            }}
          >
            {p}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <StatusBadge status={graphStats.globalStatus} showLabel={false} pulse={true} size="lg" />
        
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: '10px' }} />
          <input
            type="text"
            placeholder="Search..."
            value={filters.searchQuery}
            onChange={(e) => setFilters(f => ({ ...f, searchQuery: e.target.value }))}
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              padding: '6px 12px 6px 32px',
              borderRadius: 'var(--radius-md)',
              outline: 'none',
              width: '200px',
              fontSize: '0.85rem'
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.75rem', fontWeight: 600 }}>
          {isConnected ? (
            <>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-healthy)', animation: 'pulse-live 2s infinite' }} />
              <span style={{ color: 'var(--color-healthy)' }}>LIVE</span>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{formatTimestamp(lastUpdate)}</span>
            </>
          ) : (
            <>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-critical)' }} />
              <span style={{ color: 'var(--color-critical)' }}>DISCONNECTED</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
