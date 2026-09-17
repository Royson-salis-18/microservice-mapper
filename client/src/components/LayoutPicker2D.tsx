import { LAYOUTS_2D, type Layout2DId } from './layouts2d';

interface LayoutPicker2DProps {
  layout: Layout2DId;
  onChange: (layout: Layout2DId) => void;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Mirrors the 3D scene's arrangement picker so the two views feel like one
 * tool. Rendered inside the GraphControls panel: as a separate absolutely
 * positioned panel it overlapped the filters above it at shorter viewport
 * heights, hiding half the buttons.
 */
export function LayoutPicker2D({ layout, onChange, nodeCount, edgeCount }: LayoutPicker2DProps) {
  const active = LAYOUTS_2D.find((l) => l.id === layout);

  return (
    <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1.2px', color: '#7dd3fc', textTransform: 'uppercase', marginBottom: '8px' }}>
        Arrangement
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' }}>
        {LAYOUTS_2D.map((opt) => {
          const isActive = opt.id === layout;
          return (
            <button
              key={opt.id}
              onClick={() => onChange(opt.id)}
              title={opt.hint}
              style={{
                padding: '6px 4px',
                background: isActive ? 'rgba(0, 212, 255, 0.18)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${isActive ? 'rgba(0,212,255,0.55)' : 'rgba(255,255,255,0.08)'}`,
                color: isActive ? '#e0f2fe' : '#94a3b8',
                borderRadius: '6px',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.4px',
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {active && (
        <div style={{ marginTop: '8px', fontSize: '10px', color: '#64748b', lineHeight: 1.4 }}>
          {active.hint}
        </div>
      )}

      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: '10px', color: '#475569' }}>
        {nodeCount} services · {edgeCount} dependencies
      </div>
    </div>
  );
}
