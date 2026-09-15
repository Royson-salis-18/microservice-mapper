import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { DependencyEdge } from '../types';
import { useState } from 'react';

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

  const getEdgeStyle = (edge: DependencyEdge | undefined) => {
    if (!edge) return { color: 'rgba(255,255,255,0.12)', strokeWidth: 1, isDashed: true, isAnimated: false };

    const errRate = edge.metrics?.errorRate ?? 0;
    const latency = edge.metrics?.latency ?? 0;
    let color = 'rgba(255,255,255,0.15)';

    if (edge.status === 'failed' || errRate > 5) {
      color = 'rgba(255,23,68,0.8)';
    } else if (edge.status === 'degraded' || latency > 500) {
      color = 'rgba(255,171,0,0.8)';
    } else if (edge.observed) {
      color = 'rgba(0,212,255,0.7)';
    } else if (edge.declared) {
      color = 'rgba(148,163,184,0.35)';
    }

    const isAnimated = edge.observed && edge.status !== 'failed';

    return {
      color,
      strokeWidth: edge.observed ? 2 : 1,
      isDashed: !edge.observed,
      isAnimated,
    };
  };

  const { color, strokeWidth, isDashed, isAnimated } = getEdgeStyle(edgeData);

  const hasMetrics = edgeData?.metrics && (
    (edgeData.metrics.latency ?? 0) > 0 ||
    (edgeData.metrics.requestRate ?? 0) > 0 ||
    (edgeData.metrics.errorRate ?? 0) > 0
  );

  const evidenceBadge = edgeData?.evidenceSources?.[0];
  const evidenceColor = evidenceBadge === 'compose' ? '#7c4dff' :
    evidenceBadge === 'docker-network' ? '#00d4ff' :
    evidenceBadge === 'network-tcp' ? '#00e676' :
    evidenceBadge === 'http-log' ? '#ffab00' : '#64748b';

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
          filter: isAnimated ? `drop-shadow(0 0 3px ${color})` : 'none',
        }}
      />

      {/* Animated flow dot for observed/active edges */}
      {isAnimated && (
        <circle r="3" fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
          <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}

      {/* Label — only on hover */}
      {hovered && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: 'rgba(10, 13, 24, 0.95)',
              backdropFilter: 'blur(12px)',
              padding: '6px 10px',
              borderRadius: '8px',
              fontSize: '10px',
              fontWeight: 600,
              border: `1px solid ${evidenceColor}44`,
              color: '#fff',
              boxShadow: `0 4px 16px rgba(0,0,0,0.6), 0 0 8px ${evidenceColor}33`,
              pointerEvents: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              minWidth: '100px',
              zIndex: 1000,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: color }} />
              <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '1px', color: evidenceColor }}>
                {evidenceBadge || 'dependency'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', color: 'rgba(255,255,255,0.6)', fontSize: '9px' }}>
              <span>{edgeData?.declared ? '✓ Declared' : '○ Candidate'}</span>
              <span>{edgeData?.observed ? '● Live' : '○ Not seen'}</span>
            </div>
            {hasMetrics && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '4px', display: 'flex', gap: '8px' }}>
                {(edgeData!.metrics!.latency ?? 0) > 0 && (
                  <span style={{ color: '#00d4ff' }}>{edgeData!.metrics!.latency?.toFixed(0)}ms</span>
                )}
                {(edgeData!.metrics!.errorRate ?? 0) > 0 && (
                  <span style={{ color: '#ff1744' }}>{((edgeData!.metrics!.errorRate ?? 0) * 100).toFixed(1)}% err</span>
                )}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
