import type { CSSProperties } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { LayoutPicker2D } from './LayoutPicker2D';
import type { Layout2DId } from './layouts2d';
import { TYPE_VISUAL } from './shared/serviceVisuals';
import { LINK_THRESHOLDS } from './shared/edgeHeat';

interface GraphControlsProps {
  viewMode: string;
  setViewMode: (mode: string) => void;
  filters: Record<string, boolean>;
  setFilters: (filters: Record<string, boolean>) => void;
  layout2d: Layout2DId;
  setLayout2d: (layout: Layout2DId) => void;
  nodeCount: number;
  edgeCount: number;
}

/** Filter chip colours are the category colours the cards use. */
const FILTER_COLOR: Record<string, string> = {
  services: TYPE_VISUAL.service.color,
  databases: TYPE_VISUAL.database.color,
  queues: TYPE_VISUAL.queue.color,
  gateways: TYPE_VISUAL.gateway.color,
  infrastructure: TYPE_VISUAL.infrastructure.color,
};

const MODES = [
  { key: 'architecture', label: 'Declared', hint: 'Only links declared in config (compose depends_on and similar)' },
  { key: 'runtime', label: 'Observed', hint: 'Only links seen carrying traffic' },
  { key: 'combined', label: 'Both', hint: 'Declared and observed links together' },
];

function LinkSwatch({ color, dashed, width = 2.4 }: { color: string; dashed?: boolean; width?: number }) {
  return (
    <svg width="26" height="8" aria-hidden="true">
      <line x1="1" y1="4" x2="25" y2="4" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? '4 4' : undefined} />
    </svg>
  );
}

export function GraphControls({ viewMode, setViewMode, filters, setFilters, layout2d, setLayout2d, nodeCount, edgeCount }: GraphControlsProps) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  const toggle = (key: string) => {
    const next = { ...filters, [key]: !filters[key] };
    next.all = Object.keys(FILTER_COLOR).every((k) => next[k]);
    setFilters(next);
  };

  return (
    <div className="gc-panel">
      <div className="gc-head">
        <div>
          <div className="gc-title">Architecture</div>
          <div className="gc-sub">{nodeCount} services · {edgeCount} links</div>
        </div>
        <div className="gc-icon-row">
          <button type="button" className="gc-icon-btn" onClick={() => fitView({ padding: 0.18, duration: 500 })} title="Fit to screen" aria-label="Fit to screen"><Maximize size={13} /></button>
          <button type="button" className="gc-icon-btn" onClick={() => zoomIn({ duration: 200 })} title="Zoom in" aria-label="Zoom in"><Plus size={14} /></button>
          <button type="button" className="gc-icon-btn" onClick={() => zoomOut({ duration: 200 })} title="Zoom out" aria-label="Zoom out"><Minus size={14} /></button>
        </div>
      </div>

      <div className="gc-section-title">Links shown</div>
      <div className="gc-segment" role="tablist" aria-label="Links shown">
        {MODES.map((m) => (
          <button key={m.key} type="button" role="tab" aria-selected={viewMode === m.key} className={viewMode === m.key ? 'active' : ''} title={m.hint} onClick={() => setViewMode(m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="gc-section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Services</span>
        <button
          type="button"
          onClick={() => setFilters(Object.fromEntries([['all', !filters.all], ...Object.keys(FILTER_COLOR).map((k) => [k, !filters.all])]))}
          style={{ background: 'none', border: 'none', color: 'var(--color-accent-cyan)', fontSize: 9.5, fontWeight: 700, cursor: 'pointer', letterSpacing: 0.6, fontFamily: 'inherit' }}
        >
          {filters.all ? 'NONE' : 'ALL'}
        </button>
      </div>
      <div className="gc-chips">
        {Object.entries(FILTER_COLOR).map(([key, color]) => (
          <button
            key={key}
            type="button"
            className={`gc-chip ${filters[key] ? 'on' : ''}`}
            style={{ '--chip': color } as CSSProperties}
            aria-pressed={filters[key]}
            onClick={() => toggle(key)}
          >
            <span className="gc-chip-dot" />
            {key === 'infrastructure' ? 'infra' : key}
          </button>
        ))}
      </div>

      <LayoutPicker2D layout={layout2d} onChange={setLayout2d} />

      <div className="gc-section-title">Link colour</div>
      <div className="gc-legend-row"><LinkSwatch color="#4f7dff" />calm</div>
      <div className="gc-legend-row"><LinkSwatch color="#2f9bff" />busy</div>
      <div className="gc-legend-row"><LinkSwatch color="#1fd1ff" />heavy</div>
      <div className="gc-legend-row" title={`p95 ≥ ${LINK_THRESHOLDS.slowMs} ms, errors ≥ ${LINK_THRESHOLDS.errorWarn * 100}%, or calling a degraded service`}>
        <LinkSwatch color="#ff9a3c" />slow or erroring
      </div>
      <div className="gc-legend-row" title={`p95 ≥ ${LINK_THRESHOLDS.verySlowMs} ms, errors ≥ ${LINK_THRESHOLDS.errorCritical * 100}%, or calling a service that is down`}>
        <LinkSwatch color="#ff3d5e" />failing
      </div>
      <div className="gc-legend-row"><LinkSwatch color="#5b6aa0" dashed />declared, never seen</div>
      <div className="gc-hint">Thickness is reliance: how much of the caller's traffic goes over the link. Arrows point from caller to callee. The moving pulses arrive at the link's rate: requests per second where measured, socket activity otherwise.</div>
    </div>
  );
}
