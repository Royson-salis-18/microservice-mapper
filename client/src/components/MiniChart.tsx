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
        fontSize: '12px',
        color: 'var(--color-text-dim)',
      }}>
        Not enough data yet
      </div>
    );
  }

  return (
    <div style={{ height: '80px', width: '100%', position: 'relative' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
          <Tooltip
            contentStyle={{ background: '#1a1d22', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}
            itemStyle={{ color: 'var(--color-text-main)' }}
            labelStyle={{ display: 'none' }}
            cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }}
          />
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.1} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
