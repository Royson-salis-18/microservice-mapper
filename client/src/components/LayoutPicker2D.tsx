import { LAYOUTS_2D, type Layout2DId } from './layouts2d';

interface LayoutPicker2DProps {
  layout: Layout2DId;
  onChange: (layout: Layout2DId) => void;
}

/**
 * Mirrors the 3D scene's arrangement picker so the two views feel like one
 * tool. Rendered inside the GraphControls panel: as a separate absolutely
 * positioned panel it overlapped the filters above it at shorter viewport
 * heights, hiding half the buttons.
 */
export function LayoutPicker2D({ layout, onChange }: LayoutPicker2DProps) {
  const active = LAYOUTS_2D.find((l) => l.id === layout);

  return (
    <>
      <div className="gc-section-title">Arrangement</div>
      <div className="gc-layouts" role="tablist" aria-label="Arrangement">
        {LAYOUTS_2D.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={opt.id === layout}
            className={opt.id === layout ? 'active' : ''}
            onClick={() => onChange(opt.id)}
            title={opt.hint}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {active && <div className="gc-hint">{active.hint}</div>}
    </>
  );
}
