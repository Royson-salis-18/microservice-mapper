import { useReactFlow } from '@xyflow/react';
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

const filterColors: Record<string, string> = {
  services: '#00d4ff', // cyan
  databases: '#e040fb', // purple/magenta
  queues: '#ffab00', // amber
  gateways: '#00e676', // green
  infrastructure: '#9e9e9e', // gray
  all: '#ffffff'
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
    <div style={{
      position: 'absolute',
      top: '20px',
      left: '20px',
      zIndex: 10,
      width: '220px',
      maxHeight: 'calc(100vh - 120px)',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      padding: '16px',
      background: 'rgba(12, 12, 24, 0.7)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      color: '#fff',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <style>{`
        .ctrl-btn {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          color: #fff;
          border-radius: 50%;
          width: 32px;
          height: 32px;
          cursor: pointer;
          display: flex;
          justify-content: center;
          align-items: center;
          transition: all 0.2s;
          font-size: 16px;
        }
        .ctrl-btn:hover {
          background: rgba(255,255,255,0.15);
          border-color: rgba(255,255,255,0.2);
          box-shadow: 0 0 10px rgba(255,255,255,0.1);
        }
        .custom-radio {
          display: none;
        }
        .radio-indicator {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.3);
          display: inline-block;
          margin-right: 8px;
          position: relative;
          transition: all 0.2s;
        }
        .custom-radio:checked + .radio-indicator {
          border-color: #00d4ff;
          box-shadow: 0 0 8px rgba(0, 212, 255, 0.4);
        }
        .custom-radio:checked + .radio-indicator::after {
          content: '';
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #00d4ff;
        }
        .custom-checkbox {
          display: none;
        }
      `}</style>
      
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', justifyContent: 'center' }}>
        <button id="btn-fit" onClick={() => fitView()} className="ctrl-btn" title="Fit View">⛶</button>
        <button id="btn-zoom-in" onClick={() => zoomIn()} className="ctrl-btn" title="Zoom In">+</button>
        <button id="btn-zoom-out" onClick={() => zoomOut()} className="ctrl-btn" title="Zoom Out">−</button>
      </div>

      <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)', margin: '12px 0' }} />

      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '12px', fontWeight: 700, letterSpacing: '1px' }}>GRAPH MODE</div>
        {[
          { key: 'architecture', label: 'Architecture (Declared)' },
          { key: 'runtime', label: 'Runtime (Observed)' },
          { key: 'combined', label: 'Combined' },
        ].map(({ key, label }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', fontSize: '12px', marginBottom: '10px', cursor: 'pointer', transition: 'color 0.2s' }}>
            <input 
              type="radio" 
              name="viewMode" 
              className="custom-radio"
              checked={viewMode === key} 
              onChange={() => setViewMode(key)}
            />
            <span className="radio-indicator"></span>
            <span style={{ color: viewMode === key ? '#fff' : 'rgba(255,255,255,0.6)', fontWeight: viewMode === key ? 500 : 400 }}>{label}</span>
          </label>
        ))}
      </div>

      <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)', margin: '12px 0' }} />

      <div>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '12px', fontWeight: 700, letterSpacing: '1px' }}>FILTERS</div>
        {Object.entries(filters).map(([key, value]) => {
          const dotColor = filterColors[key] || filterColors.all;
          return (
            <label key={key} id={`filter-${key}`} style={{ 
              display: 'flex', alignItems: 'center', fontSize: '12px', marginBottom: '10px', cursor: 'pointer',
              opacity: value ? 1 : 0.5, transition: 'opacity 0.2s'
            }}>
              <input 
                type="checkbox" 
                className="custom-checkbox"
                checked={value} 
                onChange={() => handleFilterToggle(key)}
              />
              <div style={{ 
                width: '16px', height: '16px', borderRadius: '4px', border: `1px solid ${value ? dotColor : 'rgba(255,255,255,0.2)'}`,
                display: 'flex', justifyContent: 'center', alignItems: 'center', marginRight: '10px',
                background: value ? `rgba(${dotColor === '#00d4ff' ? '0,212,255' : dotColor === '#e040fb' ? '224,64,251' : dotColor === '#ffab00' ? '255,171,0' : dotColor === '#00e676' ? '0,230,118' : dotColor === '#9e9e9e' ? '158,158,158' : '255,255,255'}, 0.15)` : 'transparent',
                boxShadow: value ? `0 0 8px ${dotColor}40` : 'none',
                transition: 'all 0.2s'
              }}>
                {value && <div style={{ width: '8px', height: '8px', borderRadius: '2px', background: dotColor }} />}
              </div>
              <span style={{ color: value ? '#fff' : 'rgba(255,255,255,0.6)', textTransform: 'capitalize', fontWeight: value ? 500 : 400 }}>
                {key}
              </span>
            </label>
          )
        })}
      </div>

      <LayoutPicker2D layout={layout2d} onChange={setLayout2d} nodeCount={nodeCount} edgeCount={edgeCount} />
    </div>
  );
}
