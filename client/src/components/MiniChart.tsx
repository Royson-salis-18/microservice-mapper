import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts';
import type { MetricSnapshot } from '../types';

interface MiniChartProps {
  data: MetricSnapshot[];
  dataKey: string;
  color: string;
}

export function MiniChart({ data, dataKey, color }: MiniChartProps) {
  if (!data || data.length < 2) {
    return (
      <div style={{ 
        height: '80px', 
        width: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--color-border)',
        borderRadius: '4px',
        fontSize: '11px',
        color: 'var(--color-text-dim)',
        fontStyle: 'italic'
      }}>
        Insufficient data
      </div>
    );
  }

  return (
    <div style={{ height: '80px', width: '100%', position: 'relative' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`color-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3}/>
              <stop offset="95%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <Tooltip 
            contentStyle={{ background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)', borderRadius: '4px', fontSize: '11px' }}
            itemStyle={{ color: 'var(--color-text-main)' }}
            labelStyle={{ display: 'none' }}
          />
          <Area type="monotone" dataKey={dataKey} stroke={color} fillOpacity={1} fill={`url(#color-${dataKey})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
