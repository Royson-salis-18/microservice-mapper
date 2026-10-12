import { useReactFlow } from '@xyflow/react';
import { Maximize, Plus, Minus, Check, Box, Database, Rows3, Router, Cpu, LayoutGrid } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { LayoutPicker2D } from './LayoutPicker2D';
import type { Layout2DId } from './layouts2d';


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

const filterIcons: Record<string, LucideIcon> = {
  services: Box,
  databases: Database,
  queues: Rows3,
  gateways: Router,
  infrastructure: Cpu,
  all: LayoutGrid,
};

export function GraphControls({ viewMode, setViewMode, filters, setFilters, layout2d, setLayout2d, nodeCount, edgeCount }: GraphControlsProps) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  const handleFilterToggle = (key: string) => {
    if (key === 'all') {
      const newValue = !filters.all;
      setFilters({
        all: newValue,
        services: newValue,
        databases: newValue,
        queues: newValue,
        gateways: newValue,
        infrastructure: newValue,
      });
    } else {
      const newFilters = { ...filters, [key]: !filters[key] };
      newFilters.all = ['services', 'databases', 'queues', 'gateways', 'infrastructure'].every(k => newFilters[k]);
      setFilters(newFilters);
    }
  };

  return (
    <div className="mm-overlay" style={{
      top: '16px',
      left: '16px',
      width: '232px',
      maxHeight: 'calc(100vh - 120px)',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      padding: '14px',
      fontSize: '13px',
    }}>
      <style>{`
        .gc-zoom { display: flex; border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; background: rgba(255,255,255,0.02); width: max-content; }
        .gc-zoom button { width: 30px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; background: transparent;
          color: var(--color-text-muted); cursor: pointer; transition: background var(--transition-fast), color var(--transition-fast); }
        .gc-zoom button + button { border-left: 1px solid var(--color-border); }
        .gc-zoom button:hover { background: rgba(255,255,255,0.05); color: var(--color-text-main); }
        .gc-row { display: flex; align-items: center; gap: 9px; height: 28px; padding: 0 6px; margin: 0 -6px; border-radius: 6px; cursor: pointer;
          font-size: 12.5px; color: var(--color-text-muted); transition: background var(--transition-fast), color var(--transition-fast); user-select: none; }
        .gc-row:hover { background: rgba(255,255,255,0.03); color: var(--color-text-main); }
        .gc-row.on { color: var(--color-text-main); }
        .gc-row input { display: none; }
        .gc-radio { width: 13px; height: 13px; border-radius: 50%; border: 1px solid var(--color-border-hover); position: relative; flex-shrink: 0; transition: border-color var(--transition-fast); }
        .gc-row.on .gc-radio { border-color: var(--color-accent-cyan); }
        .gc-row.on .gc-radio::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--color-accent-cyan); }
        .gc-check { width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--color-border-hover); display: inline-flex; align-items: center; justify-content: center;
          flex-shrink: 0; color: #0b0c0e; transition: background var(--transition-fast), border-color var(--transition-fast); }
        .gc-row.on .gc-check { background: #d9dce0; border-color: #d9dce0; }
        .gc-label { display: inline-block; }
        .gc-label::first-letter { text-transform: uppercase; }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <span className="mm-eyebrow">View</span>
        <div className="gc-zoom">
          <button id="btn-fit" onClick={() => fitView()} title="Fit view" aria-label="Fit view"><Maximize size={14} strokeWidth={1.75} /></button>
          <button id="btn-zoom-in" onClick={() => zoomIn()} title="Zoom in" aria-label="Zoom in"><Plus size={14} strokeWidth={1.75} /></button>
          <button id="btn-zoom-out" onClick={() => zoomOut()} title="Zoom out" aria-label="Zoom out"><Minus size={14} strokeWidth={1.75} /></button>
        </div>
      </div>

      <div style={{ paddingTop: '14px', borderTop: '1px solid var(--color-border)', marginBottom: '14px' }}>
        <div className="mm-eyebrow" style={{ marginBottom: '8px' }}>Graph mode</div>
        {[
          { key: 'architecture', label: 'Architecture (declared)' },
          { key: 'runtime', label: 'Runtime (observed)' },
          { key: 'combined', label: 'Combined' },
        ].map(({ key, label }) => (
          <label key={key} className={`gc-row${viewMode === key ? ' on' : ''}`}>
            <input
              type="radio"
              name="viewMode"
              checked={viewMode === key}
              onChange={() => setViewMode(key)}
            />
            <span className="gc-radio" />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <div style={{ paddingTop: '14px', borderTop: '1px solid var(--color-border)' }}>
        <div className="mm-eyebrow" style={{ marginBottom: '8px' }}>Filters</div>
        {Object.entries(filters).map(([key, value]) => {
          const Icon = filterIcons[key] || LayoutGrid;
          return (
            <label key={key} id={`filter-${key}`} className={`gc-row${value ? ' on' : ''}`}>
              <input
                type="checkbox"
                checked={value}
                onChange={() => handleFilterToggle(key)}
              />
              <span className="gc-check">{value && <Check size={10} strokeWidth={2.5} />}</span>
              <Icon size={14} strokeWidth={1.9} style={{ color: 'var(--color-text-dim)', flexShrink: 0 }} />
              <span className="gc-label">{key}</span>
            </label>
          );
        })}
      </div>

      <LayoutPicker2D layout={layout2d} onChange={setLayout2d} nodeCount={nodeCount} edgeCount={edgeCount} />
    </div>
  );
}
