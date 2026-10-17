import { RotateCcw } from 'lucide-react';
import { LAYOUTS_2D, type Layout2DId } from './layouts2d';

interface LayoutPicker2DProps {
  layout: Layout2DId;
  onChange: (layout: Layout2DId) => void;
  nodeCount: number;
  edgeCount: number;
  hasCustomPositions?: boolean;
  onResetPositions?: () => void;
}

/**
 * Mirrors the 3D scene's arrangement picker so the two views feel like one
 * tool. Rendered inside the GraphControls panel: as a separate absolutely
 * positioned panel it overlapped the filters above it at shorter viewport
 * heights, hiding half the buttons.
 */
export function LayoutPicker2D({
  layout, onChange, nodeCount, edgeCount, hasCustomPositions, onResetPositions,
}: LayoutPicker2DProps) {
  const active = LAYOUTS_2D.find((l) => l.id === layout);

  return (
    <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className="mm-eyebrow">Arrangement</div>
        {hasCustomPositions && onResetPositions && (
          <button
            type="button"
            className="layout-realign-btn"
            onClick={onResetPositions}
            title="Reset dragged positions back to this layout"
          >
            <RotateCcw size={11} strokeWidth={2.2} />
            <span>Re-align</span>
          </button>
        )}
      </div>

      <div className="mm-seg">
        {LAYOUTS_2D.map((opt) => (
          <button
            key={opt.id}
            className={opt.id === layout ? 'on' : undefined}
            onClick={() => onChange(opt.id)}
            title={opt.hint}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {active && (
        <div style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--color-text-muted)', lineHeight: 1.45 }}>
          {active.hint}
        </div>
      )}

      <div style={{
        marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--color-border)',
        fontSize: '11.5px', color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums'
      }}>
        {nodeCount} services · {edgeCount} dependencies
      </div>
    </div>
  );
}
