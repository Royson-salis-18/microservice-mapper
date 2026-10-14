import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { DependencyEdge } from '../types';
import { useState } from 'react';
import { edgeAppearance } from './shared/edgeHeat';

export function CustomDependencyEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const edgeData = data as unknown as DependencyEdge | undefined;
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Shared with the 3D scene so a link reads the same in both views.
  const getEdgeStyle = (edge: DependencyEdge | undefined) => {
    const a = edgeAppearance(edge);
    const observed = edge?.observed ?? false;
    const hot = a.heat === 'busy' || a.heat === 'heavy' || a.heat === 'saturated';
    return {
      color: a.color,
      strokeWidth: !observed ? 1 : a.heat === 'saturated' || a.heat === 'failed' ? 3.4 : hot || a.heat === 'degraded' ? 2.6 : 2,
      isDashed: !observed,
      isAnimated: observed && a.heat !== 'failed',
      heatLabel: a.label,
    };
  };

  const { color, strokeWidth, isDashed, isAnimated, heatLabel } = getEdgeStyle(edgeData);

  const hasMetrics = edgeData?.metrics && (
    (edgeData.metrics.latency ?? 0) > 0 ||
    (edgeData.metrics.requestRate ?? 0) > 0 ||
    (edgeData.metrics.errorRate ?? 0) > 0
  );

  const evidenceBadge = edgeData?.evidenceSources?.[0];

  return (
    <>
      {/* Invisible wide hit area for hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={0}
        style={{
          ...style,
          strokeWidth,
          stroke: hovered ? color.replace(/[\d.]+\)$/, '1)') : color,
          strokeDasharray: isDashed ? '6 6' : 'none',
          transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.3s',
        }}
      />

      {/* Animated flow dot for observed/active edges */}
      {isAnimated && (
        <circle r="2.5" fill={color}>
          <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}

      {/* Label - only on hover */}
      {hovered && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: 'var(--color-bg-raised)',
              padding: '8px 10px',
              borderRadius: '8px',
              fontSize: '11.5px',
              border: '1px solid var(--color-border-hover)',
              color: 'var(--color-text-main)',
              boxShadow: 'var(--shadow-2)',
              pointerEvents: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              minWidth: '120px',
              zIndex: 1000,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              <span className="mm-dot" style={{ background: color }} />
              <span style={{ fontWeight: 550 }}>{evidenceBadge || 'Dependency'}</span>
            </div>
            <div style={{ display: 'flex', gap: '10px', color: 'var(--color-text-muted)', fontSize: '11px' }}>
              <span>{edgeData?.declared ? 'Declared' : 'Candidate'}</span>
              <span>{edgeData?.observed ? heatLabel.charAt(0).toUpperCase() + heatLabel.slice(1) : 'Not seen'}</span>
            </div>
            {hasMetrics && (
              <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '6px', display: 'flex', gap: '10px', fontSize: '11px', color: 'var(--color-text-muted)' }}>
                {(edgeData!.metrics!.latency ?? 0) > 0 && (
                  <span>{edgeData!.metrics!.latency?.toFixed(0)} ms</span>
                )}
                {(edgeData!.metrics!.errorRate ?? 0) > 0 && (
                  <span style={{ color: 'var(--color-critical)' }}>{((edgeData!.metrics!.errorRate ?? 0) * 100).toFixed(1)}% errors</span>
                )}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
