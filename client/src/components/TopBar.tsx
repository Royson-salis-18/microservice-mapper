import { useEffect, useRef, useState } from 'react';
import { RotateCw, Search, Gauge, TerminalSquare, Settings2, ChevronDown } from 'lucide-react';
import type { GlobalStatus, Target } from '../types';
import { useModelStatus, learningText } from '../hooks/useModelStatus';
import { useEngineMode } from '../hooks/useEngineMode';

interface TopBarProps {
  status: GlobalStatus | null;
  targets: Target[];
  isConnected: boolean;
  lastUpdate: string | null;
  selectedProject: string;
  onProjectChange: (project: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onToggleTrafficPanel?: () => void;
  isTrafficPanelOpen?: boolean;
  onToggleTerminal?: () => void;
  isTerminalOpen?: boolean;
  onEditProject?: (projectId: string) => void;
  onReloadGraph?: (targetId: string) => Promise<void>;
  activeTab?: string;
  /** Open the Detection engines page, where each engine's settings and results are shown. */
  onOpenEngines?: () => void;
}

const SECTION: Record<string, string> = {
  '3D Vision': 'Spatial view', Architecture: 'Architecture', Dependencies: 'Dependencies', Telemetry: 'Telemetry',
  TRACES: 'Traces', Analytics: 'Analytics', 'RCA / INCIDENTS': 'Incidents & cascade', RCA: 'Incidents & cascade', RELIABILITY: 'Cascade risk', FINDINGS: 'Findings',
  'ML PIPELINE': 'ML pipeline', EXPERIMENTS: 'Experiments', ENGINES: 'Detection engines',
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function TopBar({ status, targets, isConnected, lastUpdate, selectedProject, onProjectChange, searchQuery, onSearchChange, onToggleTrafficPanel, isTrafficPanelOpen, onToggleTerminal, isTerminalOpen, onEditProject, onReloadGraph, activeTab, onOpenEngines }: TopBarProps) {
  const [isReloading, setIsReloading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const model = useModelStatus(selectedProject);
  const engine = useEngineMode();

  // Cmd/Ctrl+K or "/" focuses search, as in most tools people already use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) searchRef.current?.blur();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleRefresh = async () => {
    if (selectedProject !== 'ALL' && onReloadGraph) {
      setIsReloading(true);
      try {
        await onReloadGraph(selectedProject);
      } catch (e) {
        console.error('Failed to refresh architecture', e);
      } finally {
        setIsReloading(false);
      }
    }
  };

  const currentTarget = targets.find(t => t.targetId === selectedProject);
  const feed = currentTarget ? currentTarget.status : (isConnected ? 'LIVE' : 'OFFLINE');
  const feedColor = feed === 'LIVE' ? 'var(--color-healthy)' : feed === 'STALE' ? 'var(--color-degraded)'
    : feed === 'OFFLINE' ? 'var(--color-critical)' : 'var(--color-unknown)';
  const feedLabel = feed === 'LIVE' ? 'Live' : feed === 'STALE' ? 'Stale' : feed === 'OFFLINE' ? (currentTarget ? 'Offline' : 'Disconnected') : 'No data';
  const seen = currentTarget?.lastSeen ?? lastUpdate;
  const showCounts = status && (selectedProject === 'ALL' || currentTarget?.status === 'LIVE');

  return (
    <header className="mm-top">
      <div className="mm-crumb">
        <span>{SECTION[activeTab ?? ''] ?? activeTab ?? 'Overview'}</span>
        <span style={{ color: 'var(--color-text-dim)' }}>/</span>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <select className="mm-select" value={selectedProject} onChange={e => onProjectChange(e.target.value)} aria-label="Project">
            <option value="ALL">All projects</option>
            {targets.map(t => (
              <option key={t.targetId} value={t.targetId}>{t.displayName || t.targetId}</option>
            ))}
          </select>
          <ChevronDown size={13} style={{ position: 'absolute', right: 7, pointerEvents: 'none', color: 'var(--color-text-dim)' }} />
        </div>
        {selectedProject !== 'ALL' && onReloadGraph && (
          <button className="mm-icon-btn" onClick={handleRefresh} disabled={isReloading}
            title={isReloading ? 'Rediscovering services and calls…' : 'Rediscover services and calls'} aria-label="Reload architecture">
            <RotateCw size={14} strokeWidth={1.75} className={isReloading ? 'mm-spin' : undefined} />
          </button>
        )}
      </div>

      {showCounts && status && (
        <div className="mm-health" title="Services by current health">
          <span className={status.healthy ? '' : 'zero'}><i className="mm-dot" style={{ background: 'var(--color-healthy)' }} />{status.healthy} healthy</span>
          <span className={status.degraded ? '' : 'zero'}><i className="mm-dot" style={{ background: status.degraded ? 'var(--color-degraded)' : 'var(--color-text-dim)' }} />{status.degraded} degraded</span>
          <span className={status.critical ? '' : 'zero'} style={status.critical ? { color: 'var(--color-critical)' } : undefined}>
            <i className="mm-dot" style={{ background: status.critical ? 'var(--color-critical)' : 'var(--color-text-dim)' }} />{status.critical} critical
          </span>
        </div>
      )}
      {!showCounts && currentTarget && (
        <div className="mm-health"><span className="zero">No live data for this project yet</span></div>
      )}

      {model?.state === 'learning' && (
        <span className="mm-chip" style={{ marginLeft: 12, height: 24, background: 'rgba(138,180,255,0.1)', color: '#b4c8ff' }}
          title="The model for this project is learning what normal looks like from its own data. Until it has enough baseline, only stopped, paused or restarting containers raise an incident.">
          Learning baseline · {learningText(model)}
        </span>
      )}

      <div style={{ flex: 1 }} />

      <label className="mm-search">
        <Search size={14} strokeWidth={1.75} />
        <input ref={searchRef} type="text" placeholder="Find a service" value={searchQuery} onChange={e => onSearchChange(e.target.value)} />
        {!searchQuery && <span className="mm-kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>}
      </label>

      <div style={{ display: 'flex', gap: 2 }}>
        {onToggleTrafficPanel && (
          <button className={`mm-icon-btn${isTrafficPanelOpen ? ' on' : ''}`} onClick={onToggleTrafficPanel} title="Traffic generator" aria-label="Traffic generator">
            <Gauge size={16} strokeWidth={1.75} />
          </button>
        )}
        {onToggleTerminal && (
          <button className={`mm-icon-btn${isTerminalOpen ? ' on' : ''}`} onClick={onToggleTerminal} title="Remote terminal" aria-label="Remote terminal">
            <TerminalSquare size={16} strokeWidth={1.75} />
          </button>
        )}
        {onEditProject && selectedProject !== 'ALL' && (
          <button className="mm-icon-btn" onClick={() => onEditProject(selectedProject)} title="Project settings" aria-label="Project settings">
            <Settings2 size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {engine.mode && (
        <div className="mm-engine" role="group" aria-label="Detection engine" title="Which engine decides incidents. Rules: statistical detector. ML: each service against what the current load predicts for it, with a random walk on the call graph to find the source. Hybrid (default): either engine can raise the alarm, the ML engine names the source.">
          {(['rules', 'hybrid', 'ml'] as const).map((m) => (
            <button key={m} className={engine.mode === m ? 'on' : ''} disabled={engine.busy} onClick={() => engine.change(m)} aria-pressed={engine.mode === m}>
              {m === 'rules' ? 'Rules' : m === 'hybrid' ? 'Hybrid' : 'ML'}
            </button>
          ))}
          {onOpenEngines && <button onClick={onOpenEngines} title="See what each engine does, its settings and its results" aria-label="Open the Detection engines page">?</button>}
        </div>
      )}

      <div className="mm-live" title={seen ? `Last sample ${new Date(seen).toLocaleString()}` : undefined}>
        <i className={`mm-dot${feed === 'LIVE' ? ' on' : ''}`} style={{ background: feedColor, color: feedColor }} />
        <span style={{ color: 'var(--color-text-main)' }}>{feedLabel}</span>
        {seen && <span style={{ color: 'var(--color-text-dim)' }}>{new Date(seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
      </div>
    </header>
  );
}
