import React from 'react';
import { BaseEdge, getBezierPath, EdgeLabelRenderer } from '@xyflow/react';

export default function DependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected
}) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const { status, protocol, sourceOfTruth } = data || {};
  
  let stroke = 'var(--text-tertiary)';
  if (status === 'error') stroke = 'var(--color-critical)';
  if (status === 'inactive') stroke = 'var(--text-muted)';
  
  const isDashed = sourceOfTruth === 'config';
  const strokeWidth = selected ? 2.5 : 1.5;

  return (
    <>
      <BaseEdge 
        id={id} 
        path={edgePath} 
        style={{
          stroke,
          strokeWidth,
          strokeDasharray: isDashed ? '5,5' : 'none',
          filter: selected ? `drop-shadow(0 0 4px ${stroke})` : 'none'
        }} 
      />
      
      {status === 'active' && !isDashed && (
        <BaseEdge
          path={edgePath}
          style={{
            stroke: 'var(--text-primary)',
            strokeWidth: 2,
            strokeDasharray: '4, 16',
            animation: 'flow-dash 1s linear infinite'
          }}
        />
      )}

      {protocol && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: 'var(--bg-secondary)',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '0.65rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
              pointerEvents: 'none',
            }}
          >
            {protocol}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
