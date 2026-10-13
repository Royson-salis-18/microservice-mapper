import { useId } from 'react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import type { MetricSnapshot } from '../types';

interface MiniChartProps {
  data: MetricSnapshot[];
  dataKey: string;
  color: string;
}

export function MiniChart({ data, dataKey, color }: MiniChartProps) {
  // Unique per chart: two charts sharing a gradient id paint each other's fill.
  const gradientId = `mini-${useId().replace(/:/g, '')}`;

  if (!data || data.length < 2) {
    return (
      <div style={{
        height: '72px',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.18)',
        border: '1px dashed rgba(148,163,255,0.12)',
        borderRadius: '9px',
        fontSize: '11px',
        color: 'var(--color-text-dim)',
      }}>
        Collecting history…
      </div>
    );
  }

  return (
    <div style={{ height: '72px', width: '100%', position: 'relative', background: 'rgba(0,0,0,0.18)', borderRadius: '9px', overflow: 'hidden' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.42} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, (max: number) => Math.max(10, Math.ceil(max * 1.15))]} />
          <Tooltip
            cursor={{ stroke: 'rgba(148,163,255,0.3)', strokeWidth: 1 }}
            contentStyle={{ background: '#181a24', border: '1px solid rgba(148,163,255,0.18)', borderRadius: '8px', fontSize: '11px', padding: '4px 8px' }}
            itemStyle={{ color: '#e8ecff' }}
            labelStyle={{ display: 'none' }}
            formatter={(v: any) => [`${Number(v).toFixed(1)}%`, dataKey === 'cpu' ? 'CPU' : 'Memory']}
          />
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fillOpacity={1} fill={`url(#${gradientId})`} isAnimationActive={false} dot={false} activeDot={{ r: 3, fill: color, stroke: '#0b0d16' }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
