import React, { useState } from 'react';

export default function MetricSparkline({ data = [], color = 'var(--color-healthy)', height = 50, label, unit = '%', showTooltip = true }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  if (!data || data.length === 0 || data.every(d => d.value === null)) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
        No data available
      </div>
    );
  }

  const validData = data.filter(d => d.value !== null);
  const values = validData.map(d => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const w = 300;
  const h = height;

  const getX = (index) => (index / (data.length - 1)) * w;
  const getY = (val) => h - ((val - min) / range) * (h * 0.8) - (h * 0.1);

  const points = data.map((d, i) => {
    if (d.value === null) return null;
    return `${getX(i)},${getY(d.value)}`;
  }).filter(Boolean);

  const pathD = `M ${points.join(' L ')}`;
  const areaD = `${pathD} L ${getX(data.length - 1)},${h} L 0,${h} Z`;

  return (
    <div style={{ position: 'relative', height, width: '100%', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}
         onMouseLeave={() => setHoverIdx(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
        <defs>
          <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#grad-${label})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth="2" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
        
        {data.map((d, i) => {
          if (d.value === null) return null;
          return (
            <rect key={i} x={getX(i) - 5} y={0} width={10} height={h} fill="transparent"
                  onMouseEnter={() => setHoverIdx(i)} />
          );
        })}

        {hoverIdx !== null && data[hoverIdx]?.value !== null && (
          <line x1={getX(hoverIdx)} y1={0} x2={getX(hoverIdx)} y2={h} stroke="var(--border-medium)" strokeWidth="1" strokeDasharray="2 2" />
        )}
      </svg>
      
      {showTooltip && hoverIdx !== null && data[hoverIdx]?.value !== null && (
        <div style={{
          position: 'absolute',
          top: 4,
          left: getX(hoverIdx) > w / 2 ? 'auto' : `${(getX(hoverIdx) / w) * 100}%`,
          right: getX(hoverIdx) > w / 2 ? `${100 - (getX(hoverIdx) / w) * 100}%` : 'auto',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-medium)',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '0.75rem',
          color: 'var(--text-primary)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          zIndex: 10
        }}>
          <div>{new Date(data[hoverIdx].timestamp).toLocaleTimeString()}</div>
          <div style={{ color, fontWeight: 'bold' }}>{data[hoverIdx].value.toFixed(2)}{unit}</div>
        </div>
      )}
    </div>
  );
}
