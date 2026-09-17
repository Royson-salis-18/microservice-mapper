import { useState, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { DependencyEdge } from '../types';
import { pageRootStyle } from './ProjectSections';

interface DependenciesViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
  /** Rendered inside a per-project stack: the wrapper owns scroll + height. */
  embedded?: boolean;
}

export function DependenciesView({ nodes: _nodes, edges, selectedProject, embedded = false }: DependenciesViewProps) {
  const [evidenceFilter, setEvidenceFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const parsedEdges = useMemo(() => {
    return edges
      .map(e => e.data as unknown as DependencyEdge)
      .filter(e => {
        if (!e) return false;
        if (selectedProject !== 'ALL' && !e.id.startsWith(selectedProject.toLowerCase())) return false;
        if (evidenceFilter === 'OBSERVED' && !e.observed) return false;
        if (evidenceFilter === 'DECLARED' && !e.declared) return false;
        if (searchQuery) {
          const matchSrc = e.source.toLowerCase().includes(searchQuery.toLowerCase());
          const matchTgt = e.target.toLowerCase().includes(searchQuery.toLowerCase());
          if (!matchSrc && !matchTgt) return false;
        }
        return true;
      });
  }, [edges, selectedProject, evidenceFilter, searchQuery]);

  const stats = useMemo(() => {
    const total = parsedEdges.length;
    const declared = parsedEdges.filter(e => e.declared).length;
    const observed = parsedEdges.filter(e => e.observed).length;
    const both = parsedEdges.filter(e => e.declared && e.observed).length;
    return { total, declared, observed, both };
  }, [parsedEdges]);

  const getCleanName = (id: string) => {
    if (!id) return '';
    const projPrefix = selectedProject !== 'ALL' ? selectedProject.toLowerCase() : '';
    return id.replace(new RegExp(`^(${projPrefix}|sock-shop|vertikal)-`, 'i'), '');
  };

  return (
    <div style={pageRootStyle(embedded)}>
      {/* Top Dependency KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Total Connections</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: '#fff' }}>{stats.total}</div>
          <div style={{ fontSize: '12px', color: 'var(--color-accent-cyan)', marginTop: '4px' }}>Active Dependency Graph</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Observed TCP Traffic</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: 'var(--color-healthy)' }}>{stats.observed}</div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Verified live sockets</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Declared Compose Edges</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: 'var(--color-accent-magenta)' }}>{stats.declared}</div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Declared in configuration</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Verified & Declared</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: '#ffab00' }}>{stats.both}</div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Dual-evidence confirmed</div>
        </div>
      </div>

      {/* Main Connection Table */}
      <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '0.5px' }}>Microservice Connections & Telemetry Evidence</h3>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.3)', padding: '4px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
              {['ALL', 'OBSERVED', 'DECLARED'].map(mode => (
                <button
                  key={mode}
                  onClick={() => setEvidenceFilter(mode)}
                  style={{
                    background: evidenceFilter === mode ? 'var(--color-accent-cyan)' : 'transparent',
                    color: evidenceFilter === mode ? '#000' : 'var(--color-text-muted)',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '4px 10px',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>

            <input 
              type="text"
              placeholder="Search source or target..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                padding: '6px 12px',
                color: '#fff',
                fontSize: '12px',
                outline: 'none',
                width: '200px'
              }}
            />
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
                <th style={{ padding: '10px 12px' }}>Source Service</th>
                <th style={{ padding: '10px 12px' }}>Direction</th>
                <th style={{ padding: '10px 12px' }}>Target Service</th>
                <th style={{ padding: '10px 12px' }}>Declared</th>
                <th style={{ padding: '10px 12px' }}>Observed</th>
                <th style={{ padding: '10px 12px' }}>Evidence Sources</th>
                <th style={{ padding: '10px 12px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {parsedEdges.map(edge => (
                <tr key={edge.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '12px', fontWeight: 600, color: 'var(--color-accent-cyan)' }}>
                    {getCleanName(edge.source)}
                  </td>
                  <td style={{ padding: '12px', color: 'var(--color-text-muted)' }}>➔</td>
                  <td style={{ padding: '12px', fontWeight: 600, color: 'var(--color-accent-magenta)' }}>
                    {getCleanName(edge.target)}
                  </td>
                  <td style={{ padding: '12px' }}>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      background: edge.declared ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255,255,255,0.05)',
                      color: edge.declared ? 'var(--color-accent-cyan)' : 'var(--color-text-dim)'
                    }}>
                      {edge.declared ? 'YES' : 'NO'}
                    </span>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      background: edge.observed ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 171, 0, 0.15)',
                      color: edge.observed ? 'var(--color-healthy)' : 'var(--color-degraded)'
                    }}>
                      {edge.observed ? 'OBSERVED' : 'UNCONFIRMED'}
                    </span>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {(edge.evidenceSources || ['compose']).map(src => (
                        <span key={src} style={{
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontSize: '10px',
                          background: 'rgba(255,255,255,0.06)',
                          color: 'var(--color-text-muted)',
                          fontFamily: 'monospace'
                        }}>
                          {src}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      background: 'rgba(0, 230, 118, 0.15)',
                      color: 'var(--color-healthy)'
                    }}>
                      {(edge.status || 'ACTIVE').toUpperCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
