import React from 'react';
import { Maximize, RotateCcw, ZoomIn, ZoomOut, GitBranch, Activity, AlertTriangle, Server, Database, MessageSquare, Globe, Monitor } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';

export default function LeftPanel({ filters, setFilters, graphStats }) {
  const flow = useReactFlow();

  const handleFit = () => flow.fitView({ duration: 800 });
  const handleZoomIn = () => flow.zoomIn({ duration: 300 });
  const handleZoomOut = () => flow.zoomOut({ duration: 300 });

  const viewModes = [
    { id: 'dependency', label: 'Dependency', icon: GitBranch },
    { id: 'telemetry', label: 'Telemetry', icon: Activity },
    { id: 'failure', label: 'Failure', icon: AlertTriangle }
  ];

  const typeFilters = [
    { id: 'all', label: 'All Types' },
    { id: 'service', label: 'Services', icon: Server },
    { id: 'database', label: 'Databases', icon: Database },
    { id: 'queue', label: 'Queues', icon: MessageSquare },
    { id: 'gateway', label: 'Gateways', icon: Globe },
    { id: 'frontend', label: 'Frontend', icon: Monitor }
  ];

  const Section = ({ title, children }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{title}</div>
      {children}
    </div>
  );

  return (
    <div className="left-panel">
      <Section title="Graph Controls">
        <button className="btn-ghost" onClick={handleFit}><Maximize size={16} /> Fit Graph</button>
        <button className="btn-ghost"><RotateCcw size={16} /> Reset Layout</button>
        <button className="btn-ghost" onClick={handleZoomIn}><ZoomIn size={16} /> Zoom In</button>
        <button className="btn-ghost" onClick={handleZoomOut}><ZoomOut size={16} /> Zoom Out</button>
      </Section>

      <Section title="View Mode">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {viewModes.map(mode => (
            <button
              key={mode.id}
              className="btn-ghost"
              onClick={() => setFilters(f => ({ ...f, viewMode: mode.id }))}
              style={{
                background: filters.viewMode === mode.id ? 'var(--bg-hover)' : 'transparent',
                color: filters.viewMode === mode.id ? 'var(--text-primary)' : 'var(--text-secondary)'
              }}
            >
              <mode.icon size={16} /> {mode.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Filters">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {typeFilters.map(tf => (
            <button
              key={tf.id}
              className="btn-ghost"
              onClick={() => setFilters(f => ({ ...f, typeFilter: tf.id }))}
              style={{
                background: filters.typeFilter === tf.id ? 'var(--bg-hover)' : 'transparent',
                color: filters.typeFilter === tf.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                justifyContent: 'space-between'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {tf.icon && <tf.icon size={16} />}
                {tf.label}
              </div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Status">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {['healthy', 'degraded', 'critical'].map(status => (
            <div key={status} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} onClick={() => setFilters(f => ({ ...f, statusFilter: f.statusFilter === status ? 'all' : status }))}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: `var(--color-${status})` }} />
                <span style={{ textTransform: 'capitalize', color: 'var(--text-secondary)', fontWeight: filters.statusFilter === status ? 600 : 400 }}>{status}</span>
              </div>
              <span style={{ color: 'var(--text-muted)' }}>{graphStats[`${status}Count`]}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
