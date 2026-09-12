import React from 'react';

export default function StatusBadge({ status = 'unknown', size = 'md', showLabel = true, pulse = false }) {
  const sizeMap = { sm: 8, md: 10, lg: 12 };
  const d = sizeMap[size] || 10;
  
  let colorVar = `var(--color-${status})`;
  let animClass = '';
  
  if (pulse && status === 'critical') animClass = 'pulse-critical';
  if (pulse && status === 'healthy') animClass = 'pulse-healthy';
  
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <div 
        style={{
          width: d,
          height: d,
          borderRadius: '50%',
          backgroundColor: colorVar,
          animation: animClass ? `${animClass} 2s infinite` : 'none'
        }}
      />
      {showLabel && (
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textTransform: 'capitalize' }}>
          {status}
        </span>
      )}
    </div>
  );
}
