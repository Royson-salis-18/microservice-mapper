import { useState, useMemo, type CSSProperties } from 'react';
import { ArrowRight, Network, Search } from 'lucide-react';
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

  const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
  const num: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
  const kpiValue: CSSProperties = { fontSize: '26px', fontWeight: 600, letterSpacing: '-0.02em', marginTop: '8px', color: 'var(--color-text-main)', ...num };
  const kpiSub: CSSProperties = { fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' };
  const th: CSSProperties = { padding: '0 12px', height: '36px', fontSize: '11.5px', fontWeight: 500, color: 'var(--color-text-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
  const td: CSSProperties = { padding: '0 12px', height: '42px' };
  const statusTone = (status: string) => {
    const s = status.toLowerCase();
    if (s === 'active' || s === 'healthy') return { fg: 'var(--color-healthy)', bg: 'rgba(62,207,142,.1)' };
    if (s === 'degraded' || s === 'slow') return { fg: 'var(--color-degraded)', bg: 'rgba(232,163,61,.1)' };
    if (s === 'critical' || s === 'failing' || s === 'broken' || s === 'down') return { fg: 'var(--color-critical)', bg: 'rgba(239,95,103,.1)' };
    return { fg: 'var(--color-unknown)', bg: 'rgba(255,255,255,.04)' };
  };

  return (
    <div style={pageRootStyle(embedded)}>
      {/* Top dependency KPI cards */}
      <div className="mm-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Total connections</div>
          <div style={kpiValue}>{stats.total}</div>
          <div style={kpiSub}>Active dependency graph</div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Observed TCP traffic</div>
          <div style={kpiValue}>{stats.observed}</div>
          <div style={kpiSub}>Verified live sockets</div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Declared compose edges</div>
          <div style={kpiValue}>{stats.declared}</div>
          <div style={kpiSub}>Declared in configuration</div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Verified and declared</div>
          <div style={kpiValue}>{stats.both}</div>
          <div style={kpiSub}>Dual-evidence confirmed</div>
        </div>
      </div>

      {/* Main connection table */}
      <div className="mm-card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Connections</h3>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>Service dependencies and the evidence behind each one</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="mm-seg" style={{ gridTemplateColumns: 'repeat(3, auto)' }}>
              {['ALL', 'OBSERVED', 'DECLARED'].map(mode => (
                <button
                  key={mode}
                  className={evidenceFilter === mode ? 'on' : undefined}
                  onClick={() => setEvidenceFilter(mode)}
                  style={{ padding: '0 10px' }}
                >
                  {sentence(mode)}
                </button>
              ))}
            </div>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={14} strokeWidth={1.75} color="var(--color-text-dim)" style={{ position: 'absolute', left: '9px', pointerEvents: 'none' }} />
              <input
                type="text"
                placeholder="Search source or target"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(138,180,255,.45)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}
                style={{
                  height: '30px',
                  background: 'rgba(255,255,255,.03)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  padding: '0 10px 0 28px',
                  color: 'var(--color-text-main)',
                  fontSize: '12.5px',
                  fontFamily: 'inherit',
                  outline: 'none',
                  width: '220px',
                  transition: 'border-color var(--transition-fast)',
                }}
              />
            </div>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={th}>Source service</th>
                <th style={{ ...th, width: '32px' }}></th>
                <th style={th}>Target service</th>
                <th style={th}>Declared</th>
                <th style={th}>Observed</th>
                <th style={th}>Evidence sources</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {parsedEdges.map(edge => {
                const status = edge.status || 'ACTIVE';
                const tone = statusTone(status);
                return (
                  <tr
                    key={edge.id}
                    style={{ borderBottom: '1px solid var(--color-border)', transition: 'background var(--transition-fast)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.025)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ ...td, fontWeight: 500, color: 'var(--color-text-main)' }}>
                      {getCleanName(edge.source)}
                    </td>
                    <td style={{ ...td, color: 'var(--color-text-dim)' }}>
                      <ArrowRight size={14} strokeWidth={1.75} style={{ display: 'block' }} />
                    </td>
                    <td style={{ ...td, fontWeight: 500, color: 'var(--color-text-main)' }}>
                      {getCleanName(edge.target)}
                    </td>
                    <td style={{ ...td, color: edge.declared ? 'var(--color-text-main)' : 'var(--color-text-dim)' }}>
                      {edge.declared ? 'Yes' : 'No'}
                    </td>
                    <td style={td}>
                      {edge.observed ? (
                        <span className="mm-chip" style={{ background: 'rgba(62,207,142,.1)', color: 'var(--color-healthy)', border: 'none' }}>
                          <i className="mm-dot" style={{ background: 'currentColor' }} />Observed
                        </span>
                      ) : (
                        <span className="mm-chip" style={{ background: 'rgba(232,163,61,.1)', color: 'var(--color-degraded)', border: 'none' }}>
                          <i className="mm-dot" style={{ background: 'currentColor' }} />Unconfirmed
                        </span>
                      )}
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {(edge.evidenceSources || ['compose']).map(src => (
                          <span key={src} style={{
                            padding: '1px 6px',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '11px',
                            background: 'rgba(255,255,255,.04)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-muted)',
                            fontFamily: 'var(--font-mono)'
                          }}>
                            {src}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td style={td}>
                      <span className="mm-chip" style={{ background: tone.bg, color: tone.fg, border: 'none' }}>
                        <i className="mm-dot" style={{ background: 'currentColor' }} />
                        {sentence(status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {parsedEdges.length === 0 && (
            <div style={{ padding: '36px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', textAlign: 'center' }}>
              <Network size={20} strokeWidth={1.75} color="var(--color-text-dim)" />
              <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No connections match</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Try a different filter or search term</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
