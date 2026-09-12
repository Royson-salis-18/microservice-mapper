import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { DependencyEdge } from '../types';

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

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const getEdgeStyle = (edge: DependencyEdge | undefined) => {
    if (!edge) return { color: '#616161', strokeDasharray: 'none', animation: 'none', strokeWidth: 1.5, dropShadow: 'none' };
    
    const errRate = edge.metrics?.errorRate ?? 0;
    const latency = edge.metrics?.latency ?? 0;
    let color = '#616161';
    let dropShadow = 'none';
    
    if (edge.status === 'failed' || errRate > 5) {
      color = '#ff1744'; // critical
      dropShadow = `drop-shadow(0 0 4px rgba(255, 23, 68, 0.6))`;
    } else if (edge.status === 'degraded' || latency > 500) {
      color = '#ffab00'; // degraded
      dropShadow = `drop-shadow(0 0 4px rgba(255, 171, 0, 0.6))`;
    } else if (edge.observed) {
      color = '#00d4ff'; // cyan accent
      dropShadow = `drop-shadow(0 0 4px rgba(0, 212, 255, 0.6))`;
    }

    const isDeclaredOnly = edge.declared && !edge.observed;
    
    return {
      color,
      dropShadow,
      strokeWidth: isDeclaredOnly ? 1 : (edge.observed ? 2.5 : 2),
      strokeDasharray: edge.observed ? '12 12' : (isDeclaredOnly ? '5 5' : 'none'),
      animation: edge.observed ? 'flow-active 1s linear infinite' : 'none'
    };
  };

  const { color, strokeWidth, strokeDasharray, animation, dropShadow } = getEdgeStyle(edgeData);

  return (
    <>
      <svg>
        <defs>
          <filter id={`glow-${edgeData?.id || 'default'}`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
      </svg>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={20}
        style={{
          ...style,
          strokeWidth,
          stroke: color,
          animation,
          strokeDasharray,
          transition: 'stroke 0.3s, opacity 0.3s',
          filter: edgeData?.observed ? `url(#glow-${edgeData.id})` : 'none',
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: 'rgba(12, 12, 24, 0.75)',
            backdropFilter: 'blur(8px)',
            padding: '4px 8px',
            borderRadius: '6px',
            fontSize: '10px',
            fontWeight: 600,
            border: `1px solid rgba(255,255,255,0.1)`,
            color: color,
            boxShadow: `0 0 10px rgba(0,0,0,0.5), ${dropShadow.replace('drop-shadow', '').replace(')', '').replace('(', '')}`,
            pointerEvents: 'all',
            cursor: 'pointer',
            opacity: style?.opacity,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'all 0.2s ease'
          }}
          className="nodrag nopan"
        >
          <span style={{ letterSpacing: '0.5px' }}>DEPENDENCY</span>
          {edgeData?.evidenceSources && edgeData.evidenceSources.length > 0 && (
            <div style={{ display: 'flex', gap: '3px' }}>
              {edgeData.evidenceSources.map((src, i) => (
                <span key={i} style={{
                  background: `rgba(255,255,255,0.1)`,
                  padding: '1px 4px',
                  borderRadius: '3px',
                  fontSize: '8px',
                  color: '#fff'
                }}>
                  {src.substring(0, 1).toUpperCase()}
                </span>
              ))}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
