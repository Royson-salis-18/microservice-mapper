import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, Legend,
  LineChart, Line, ReferenceLine, ScatterChart, Scatter, ZAxis,
} from 'recharts';
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import { MLExecutionPanel } from './MLExecutionPanel';
import { InfoTip, PageHeader, Panel, Stat as KitStat, StatRow } from './ui/Panel';
import { createContext, useContext } from 'react';

/**
 * Whether the shared chart panels start open.
 *
 * They default to collapsed, which is right on ML Pipeline where the charts
 * are secondary to the controls. On Findings the charts *are* the page, and a
 * results page whose results are all folded away is worse than a busy one —
 * so that page flips the default rather than every component taking a prop.
 */
export const PanelsStartOpen = createContext(false);
import '../styles/ml-pipeline.css';

export interface MLStatus {
  collection: {
    started_at: string;
    last_write_at: string;
    total_rows: number;
    services_seen: number;
    poll_interval_sec: number;
    consecutive_failures: number;
    last_error: string | null;
    per_service: Record<string, { samples: number; first_seen: string }>;
  } | null;
  preprocessing: {
    generated_at: string;
    status: string;
    min_samples_per_service: number;
    raw_rows_read: number;
    feature_rows_written?: number;
    services_with_features?: number;
    nan_zscore_counts?: Record<string, number>;
    per_service: Record<string, { raw_samples: number; feature_samples: number; status: string; zero_variance_features?: string[] }>;
  } | null;
  training: {
    generated_at: string;
    min_training_samples: number;
    contamination: number;
    n_estimators?: number;
    max_samples_fraction?: number;
    holdout_fraction?: number;
    feature_columns?: string[];
    training_window: { since: string | null; until: string | null };
    trained: Record<string, {
      samples: number;
      threshold_p99: number;
      holdout?: { samples: number; flag_rate: number; mean_score: number; max_score: number } | null;
    }>;
    skipped: Record<string, { samples: number }>;
  } | null;
  scoring: {
    started_at: string;
    last_cycle_at: string;
    models_loaded: number;
    services_scored_this_cycle: number;
    persistence_windows_required: number;
    score_interval_sec: number;
    persistent_anomalies_now: string[];
  } | null;
  liveScores: Record<string, {
    anomaly_score: number; raw_score: number; threshold: number;
    above_threshold: boolean; consecutive_windows: number; persistent: boolean; scored_at: string;
  }> | null;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return `${Math.round(diffSec / 3600)}h ago`;
}

function StageCard({ title, ready, subtitle, children }: { title: string; ready: boolean; subtitle: string; children?: React.ReactNode }) {
  return (
    <div className="ml-stage-card">
      <div className="ml-stage-title">
        <span className={`indicator ${ready ? 'ready' : 'not-ready'}`} />
        <span className="text">{title}</span>
      </div>
      <div className="ml-stage-subtitle">{subtitle}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ml-stat-row">
      <span className="ml-stat-label">{label}</span>
      <span className="ml-stat-value">{value}</span>
    </div>
  );
}

function ScoreBar({ score, persistent, aboveThreshold }: { score: number; persistent: boolean; aboveThreshold: boolean }) {
  // Neutral unless the value is actually bad.
  const color = persistent ? 'var(--color-critical)' : aboveThreshold ? 'var(--color-degraded)' : '#9aa3b0';
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '110px' }}>
      <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', width: '32px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
    </div>
  );
}

const AXIS_COLOR = '#5d636c';
const GRID_COLOR = 'rgba(255,255,255,0.05)';
const TOOLTIP_STYLE = {
  background: '#1a1d22', border: '1px solid var(--color-border)', borderRadius: '8px',
  fontSize: '12px', color: 'var(--color-text-main)', fontVariantNumeric: 'tabular-nums' as const,
};
const TOOLTIP_LABEL = { color: 'var(--color-text-muted)', marginBottom: '2px' };
const TOOLTIP_ITEM = { color: 'var(--color-text-main)' };
const LEGEND_STYLE = { fontSize: '11.5px', color: 'var(--color-text-muted)' };
/** Muted categorical palette for charts with several series. */
const SERIES = ['#8ab4ff', '#b4a5ff', '#7dc4c4', '#c9a46b', '#9aa3b0'];

const TH: React.CSSProperties = {
  padding: '0 10px', height: '36px', fontSize: '11.5px', fontWeight: 500,
  color: 'var(--color-text-muted)', textAlign: 'left', whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--color-border)',
};
const TD: React.CSSProperties = {
  padding: '0 10px', height: '40px', fontSize: '13px', fontVariantNumeric: 'tabular-nums',
  borderBottom: '1px solid var(--color-border)',
};
const EMPTY: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
  fontSize: '12px', color: 'var(--color-text-muted)', padding: '0 20px',
};
const FIELD_LABEL: React.CSSProperties = {
  fontSize: '12px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '6px',
};
const INPUT: React.CSSProperties = {
  width: '100%', height: '30px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-border)',
  borderRadius: '8px', padding: '0 10px', fontSize: '13px', color: 'var(--color-text-main)', outline: 'none',
  fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', colorScheme: 'dark',
};
const LOG: React.CSSProperties = {
  margin: '8px 0 0', overflowY: 'auto', background: 'var(--color-bg-body)', border: '1px solid var(--color-border)',
  borderRadius: '8px', padding: '10px 12px', fontSize: '12px', lineHeight: 1.55, color: 'var(--color-text-muted)',
  whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)',
};
const PANEL_TITLE: React.CSSProperties = { margin: 0, fontSize: '14px', fontWeight: 600, letterSpacing: '-0.005em' };

function StatusChip({ tone, children }: { tone: 'healthy' | 'degraded' | 'critical' | 'unknown'; children: React.ReactNode }) {
  const bg = {
    healthy: 'rgba(62,207,142,0.1)', degraded: 'rgba(232,163,61,0.1)',
    critical: 'rgba(239,95,103,0.1)', unknown: 'rgba(255,255,255,0.05)',
  }[tone];
  return (
    <span className="mm-chip" style={{ background: bg, color: `var(--color-${tone === 'unknown' ? 'text-muted' : tone})`, whiteSpace: 'nowrap' }}>
      <i className="mm-dot" style={{ background: tone === 'unknown' ? 'var(--color-unknown)' : 'currentColor' }} />
      {children}
    </span>
  );
}

/**
 * Panel used by every chart on ML Pipeline and Findings.
 *
 * `desc` used to render as a permanently visible paragraph under each title.
 * Individually each one earned its place — they are the difference between a
 * number and a number you can trust — but eight of them stacked down a page
 * turned into a wall of grey text that buried the charts it was explaining.
 *
 * The explanation now lives behind the ⓘ. Nothing is lost, and the data gets
 * to be the loudest thing on the page.
 */
function CollapsiblePanel({
  title,
  desc,
  children,
  defaultCollapsed = false,
  headerContent
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  children: React.ReactNode;
  defaultCollapsed?: boolean;
  headerContent?: React.ReactNode;
}) {
  const startOpen = useContext(PanelsStartOpen);
  const [collapsed, setCollapsed] = useState(startOpen ? false : defaultCollapsed);
  return (
    <div className="ml-panel">
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: '10px', marginBottom: collapsed ? 0 : '16px', flexWrap: 'wrap',
      }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '9px', cursor: 'pointer', minWidth: 0 }}
          onClick={() => setCollapsed(!collapsed)}
        >
          <h3 className="ml-chart-title" style={PANEL_TITLE}>{title}</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: 'auto' }} onClick={e => e.stopPropagation()}>
          {desc && <InfoTip>{desc}</InfoTip>}
          {headerContent}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand' : 'Collapse'}
            className="mm-icon-btn"
            style={{ width: '26px', height: '26px', flexShrink: 0 }}
          >
            {collapsed ? <ChevronDown size={15} strokeWidth={1.75} /> : <ChevronUp size={15} strokeWidth={1.75} />}
          </button>
        </div>
      </div>
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

function PipelineFunnelChart({ projectNames, byProject }: { projectNames: string[]; byProject: Map<string, any[]> }) {
  const data = projectNames.map((project) => {
    const rows = byProject.get(project)!;
    return {
      project,
      collected: rows.filter(r => (r.collected?.samples ?? 0) > 0).length,
      featureReady: rows.filter(r => r.featured?.status === 'ok').length,
      trained: rows.filter(r => r.trainedEntry).length,
      scored: rows.filter(r => r.live).length,
    };
  });

  return (
    <CollapsiblePanel 
      title="Pipeline funnel by project" 
      desc="How many of each project's services have made it through each stage"
    >
      <div style={{ height: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="project" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />
            <Bar dataKey="collected" name="Collected" fill={SERIES[4]} radius={[2, 2, 0, 0]} />
            <Bar dataKey="featureReady" name="Feature-ready" fill={SERIES[0]} radius={[2, 2, 0, 0]} />
            <Bar dataKey="trained" name="Trained" fill={SERIES[2]} radius={[2, 2, 0, 0]} />
            <Bar dataKey="scored" name="Scored" fill={SERIES[1]} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </CollapsiblePanel>
  );
}

function severityColor(score: { persistent: boolean; above_threshold: boolean }): string {
  if (score.persistent) return '#ef5f67';
  if (score.above_threshold) return '#e8a33d';
  return '#9aa3b0';
}

export function LiveScoresChart({ rows, onSelect, selectedSid }: { rows: Array<{ sid: string; live?: { anomaly_score: number; persistent: boolean; above_threshold: boolean } }>; onSelect: (sid: string) => void; selectedSid: string | null }) {
  const data = rows
    .filter(r => r.live)
    .map(r => ({ sid: r.sid, name: r.sid.includes(':') ? r.sid.split(':').slice(1).join(':') : r.sid, score: Math.round(r.live!.anomaly_score * 100), live: r.live! }))
    .sort((a, b) => b.score - a.score);

  if (data.length === 0) {
    return (
      <CollapsiblePanel title="Live anomaly scores" desc="No services are being scored yet." defaultCollapsed>
        <div />
      </CollapsiblePanel>
    );
  }

  return (
    <CollapsiblePanel 
      title="Live anomaly scores" 
      desc="Click a bar to see its trend below · Red is a persistent anomaly, amber is above threshold, grey is within baseline"
    >
      <div style={{ height: `${Math.max(160, data.length * 26)}px` }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 0 }}>
            <CartesianGrid stroke={GRID_COLOR} horizontal={false} />
            <XAxis type="number" domain={[0, 100]} tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
            <YAxis type="category" dataKey="name" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} width={140} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'rgba(255,255,255,0.03)' }} formatter={(v: any) => [`${v}%`, 'Anomaly score']} />
            <Bar dataKey="score" radius={[0, 2, 2, 0]} barSize={14} onClick={(d: any) => onSelect(d.sid)} style={{ cursor: 'pointer' }}>
              {data.map((entry) => (
                <Cell key={entry.sid} fill={severityColor(entry.live)} fillOpacity={selectedSid && entry.sid !== selectedSid ? 0.45 : 0.9} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </CollapsiblePanel>
  );
}

export function ScoreHistoryChart({ sid }: { sid: string | null }) {
  const [history, setHistory] = useState<Array<{ timestamp: string; anomaly_score: number; above_threshold: boolean }>>([]);

  useEffect(() => {
    if (!sid) return;
    let cancelled = false;
    const fetchHistory = async () => {
      try {
        const res = await fetch(`/api/ml/score-history?serviceId=${encodeURIComponent(sid)}&limit=200`);
        if (res.ok && !cancelled) setHistory(await res.json());
      } catch { /* leave previous history in place */ }
    };
    fetchHistory();
    const interval = setInterval(fetchHistory, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sid]);

  if (!sid) {
    return (
      <CollapsiblePanel title="Anomaly score trend" desc="Click a service in the chart above (or a row in the table below) to see its trend over time." defaultCollapsed>
        <div />
      </CollapsiblePanel>
    );
  }

  const data = history.map(h => ({ ...h, score: Math.round(h.anomaly_score * 100), t: new Date(h.timestamp).toLocaleTimeString() }));

  return (
    <CollapsiblePanel 
      title={`Anomaly score trend — ${sid}`}
      desc="From score_history.csv, written every scoring cycle"
    >
      {data.length < 2 ? (
        <div style={{ height: '160px', ...EMPTY }}>
          Not enough history yet for this service
        </div>
      ) : (
        <div style={{ height: '200px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis dataKey="t" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={30} />
              <YAxis domain={[0, 100]} tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${v}%`, 'Anomaly score']} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
              <ReferenceLine y={100} stroke="#ef5f67" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: 'Threshold', fill: '#5d636c', fontSize: 11, position: 'insideTopRight' }} />
              <Line type="monotone" dataKey="score" stroke="#8ab4ff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </CollapsiblePanel>
  );
}

const FEATURE_SERIES = [
  { raw: 'cpu_percent', z: 'z_cpu_percent', label: 'CPU %', color: SERIES[0] },
  { raw: 'memory_percent', z: 'z_memory_percent', label: 'Memory %', color: SERIES[1] },
  { raw: 'network_rx_rate', z: 'z_network_rx_rate', label: 'RX B/s', color: SERIES[2] },
  { raw: 'network_tx_rate', z: 'z_network_tx_rate', label: 'TX B/s', color: SERIES[3] },
];

// Shows the exact rows train.py fits on — raw values on the left, the
// z-scores actually fed to the forest on the right — so a score can be
// traced back to the data that produced it instead of taken on faith.
export function FeatureExplorer({ serviceIds, sid, onSelect }: { serviceIds: string[]; sid: string | null; onSelect: (sid: string) => void }) {
  const [rows, setRows] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState<string[]>(FEATURE_SERIES.map(f => f.raw));

  useEffect(() => {
    if (!sid) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/ml/features?serviceId=${encodeURIComponent(sid)}&limit=300`)
      .then(r => r.ok ? r.json() : { rows: [] })
      .then(data => { if (!cancelled) setRows(data.rows || []); })
      .catch(() => { if (!cancelled) setRows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sid]);

  const data = useMemo(() => rows.map(r => ({
    ...r,
    t: r.timestamp ? new Date(String(r.timestamp).replace(' ', 'T')).toLocaleTimeString() : '',
  })), [rows]);

  const toggle = (raw: string) => setVisible(v => v.includes(raw) ? v.filter(x => x !== raw) : [...v, raw]);

  return (
    <CollapsiblePanel 
      title="Feature explorer" 
      desc="The actual rows from features.csv — raw metrics and the normalized z-scores the model is fitted on"
      defaultCollapsed={true}
      headerContent={
        <select
          value={sid ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          style={{ ...INPUT, width: 'auto', maxWidth: '280px', fontSize: '12.5px' }}
        >
          <option value="">Select a service…</option>
          {serviceIds.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      }
    >
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', margin: '0 0 14px' }}>
        {FEATURE_SERIES.map(f => (
          <label key={f.raw} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', color: visible.includes(f.raw) ? 'var(--color-text-main)' : 'var(--color-text-dim)' }}>
            <input type="checkbox" checked={visible.includes(f.raw)} onChange={() => toggle(f.raw)} style={{ accentColor: 'var(--color-accent-cyan)' }} />
            <i className="mm-dot" style={{ background: f.color, opacity: visible.includes(f.raw) ? 1 : 0.35 }} />
            {f.label}
          </label>
        ))}
      </div>

      {!sid ? (
        <div style={{ height: '180px', ...EMPTY }}>
          Pick a service to inspect its training features
        </div>
      ) : loading && data.length === 0 ? (
        <div style={{ height: '180px', ...EMPTY }}>Loading features…</div>
      ) : data.length < 2 ? (
        <div style={{ height: '180px', ...EMPTY }}>
          No feature rows for this service yet. It needs more samples, then a retrain.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '6px' }}>Raw values</div>
            <div style={{ height: '190px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                  <XAxis dataKey="t" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
                  {FEATURE_SERIES.filter(f => visible.includes(f.raw)).map(f => (
                    <Line key={f.raw} type="monotone" dataKey={f.raw} name={f.label} stroke={f.color} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '6px' }}>Z-scores (model input), dashed lines at ±3σ</div>
            <div style={{ height: '190px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_COLOR} vertical={false} />
                  <XAxis dataKey="t" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} formatter={(v: any) => (typeof v === 'number' ? v.toFixed(2) : v)} />
                  <ReferenceLine y={3} stroke="#969ca5" strokeDasharray="4 4" strokeOpacity={0.35} />
                  <ReferenceLine y={-3} stroke="#969ca5" strokeDasharray="4 4" strokeOpacity={0.35} />
                  {FEATURE_SERIES.filter(f => visible.includes(f.raw)).map(f => (
                    <Line key={f.z} type="monotone" dataKey={f.z} name={f.label} stroke={f.color} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </CollapsiblePanel>
  );
}

// How the live scores are spread out right now. A pile-up in the lowest
// bucket is the expected shape for a healthy system; a long right tail is
// what's worth looking at.
export function ScoreDistributionChart({ rows }: { rows: Array<{ live?: { anomaly_score: number } }> }) {
  const buckets = useMemo(() => {
    const counts = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}-${i * 10 + 10}%`, count: 0, index: i }));
    for (const r of rows) {
      if (!r.live) continue;
      const idx = Math.min(9, Math.max(0, Math.floor(r.live.anomaly_score * 10)));
      counts[idx].count += 1;
    }
    return counts;
  }, [rows]);

  const scored = buckets.reduce((sum, b) => sum + b.count, 0);

  return (
    <CollapsiblePanel 
      title="Live score distribution" 
      desc={`${scored} scored service${scored === 1 ? '' : 's'} bucketed by current anomaly score`}
      defaultCollapsed={true}
    >
      {scored === 0 ? (
        <div style={{ height: '180px', ...EMPTY }}>
          Nothing scored right now. The scorer needs live metrics from a reachable target.
        </div>
      ) : (
        <div style={{ height: '200px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={buckets} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis dataKey="bucket" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} interval={0} angle={-30} textAnchor="end" height={45} />
              <YAxis allowDecimals={false} tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} width={30} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} formatter={(v: any) => [`${v} service(s)`, 'Count']} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                {buckets.map((b) => (
                  <Cell key={b.bucket} fill={b.index >= 8 ? '#ef5f67' : b.index >= 5 ? '#e8a33d' : '#9aa3b0'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </CollapsiblePanel>
  );
}

export interface AlgoHoldout { samples: number; flag_rate: number; mean_score: number; max_score: number; from: string; to: string }

export interface AlgoMeta {
  threshold_p99?: number;
  train_score_mean?: number;
  train_score_max?: number;
  holdout?: AlgoHoldout | null;
  artifact?: string;
  /** Present instead of the rest when this detector refused to fit. */
  error?: string;
}

export interface ModelMeta {
  service_id: string;
  project?: string | null;
  feature_columns: string[];
  trained_on_samples: number;
  trained_at: string;
  contamination: number;
  n_estimators?: number;
  threshold_p99: number;
  holdout?: AlgoHoldout | null;
  /** One entry per detector: iforest, lof, ocsvm, zscore. */
  algorithms?: Record<string, AlgoMeta>;
  /** Pairwise, keyed "a|b". */
  agreement?: Record<string, { same_verdict_rate: number; jaccard: number | null; both_flagged: number; either_flagged: number }>;
  data_quality?: {
    rows: number;
    unique_rows: number;
    unique_fraction: number;
    feature_std: Record<string, number>;
  };
}

const ALGO_LABEL: Record<string, string> = {
  iforest: 'Isolation Forest',
  lof: 'Local Outlier Factor',
  ocsvm: 'One-Class SVM',
  zscore: 'Z-score (max|z|)',
};

const ALGO_NOTE: Record<string, string> = {
  iforest: 'Partitioning. Cheap, copes with mixed scales.',
  lof: 'Local density. Catches a point that is normal globally but odd locally.',
  ocsvm: 'Boundary. Fits a frontier around the normal region.',
  zscore: 'Statistical baseline. No fitting — the interpretable number the others must beat.',
};

/**
 * Per-project detector comparison.
 *
 * Four detectors per service is only worth the cost if they can disagree,
 * so this shows, per project: how many services each one actually fitted,
 * how often it fires on the held-out tail, and how much the detectors agree
 * with each other. Agreement near 1.0 everywhere means the extra detectors
 * are adding cost and no information.
 */
export function DetectorComparison({ models }: { models: ModelMeta[] }) {
  const byProject = useMemo(() => {
    const map = new Map<string, ModelMeta[]>();
    for (const m of models) {
      const project = m.project || (m.service_id.includes(':') ? m.service_id.split(':')[0] : '(unknown)');
      if (!map.has(project)) map.set(project, []);
      map.get(project)!.push(m);
    }
    return map;
  }, [models]);

  const projects = Array.from(byProject.keys()).sort();
  if (projects.length === 0) return null;

  const algos = Array.from(
    new Set(models.flatMap(m => Object.keys(m.algorithms || {}))),
  ).sort((a, b) => (a === 'iforest' ? -1 : b === 'iforest' ? 1 : a.localeCompare(b)));

  if (algos.length === 0) return null;

  return (
    <CollapsiblePanel 
      title="Detectors by project" 
      desc={
        <span style={{lineHeight: 1.5}}>
          Each service is fitted independently per project — a sock-shop model never sees death-star data.
          The held-out tail is unlabelled, so a firing rate is not accuracy: it is how often that detector
          fires on data collected after it was fitted.
        </span>
      }
      defaultCollapsed={true}
    >
      {projects.map(project => {
        const rows = byProject.get(project)!;
        return (
          <div key={project} style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-main)', marginBottom: '8px' }}>
              {project} <span style={{ color: 'var(--color-text-dim)', fontWeight: 400, fontSize: '12px' }}>· {rows.length} service{rows.length === 1 ? '' : 's'}</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Detector</th>
                  <th style={TH}>Fitted</th>
                  <th style={TH}>Refused</th>
                  <th style={TH}>Mean firing rate on holdout</th>
                  <th style={TH}>What it measures</th>
                </tr>
              </thead>
              <tbody>
                {algos.map(algo => {
                  const entries = rows.map(r => r.algorithms?.[algo]).filter(Boolean) as AlgoMeta[];
                  const fitted = entries.filter(e => !e.error);
                  const refused = entries.filter(e => e.error);
                  const withHoldout = fitted.filter(e => e.holdout);
                  const meanRate = withHoldout.length
                    ? withHoldout.reduce((acc, e) => acc + (e.holdout!.flag_rate), 0) / withHoldout.length
                    : null;
                  return (
                    <tr key={algo} className="ml-table-row">
                      <td style={{ ...TD, fontWeight: 550 }}>{ALGO_LABEL[algo] || algo}</td>
                      <td style={{ ...TD, color: fitted.length ? 'var(--color-text-main)' : 'var(--color-text-dim)' }}>{fitted.length}</td>
                      <td style={{ ...TD, color: refused.length ? 'var(--color-degraded)' : 'var(--color-text-dim)' }}
                          title={refused[0]?.error || ''}>
                        {refused.length || '—'}
                      </td>
                      <td style={TD}>
                        {meanRate === null ? <span style={{ color: 'var(--color-text-dim)' }}>—</span> : `${(meanRate * 100).toFixed(1)}%`}
                      </td>
                      <td style={{ ...TD, fontSize: '12px', color: 'var(--color-text-muted)' }}>{ALGO_NOTE[algo] || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </CollapsiblePanel>
  );
}

/**
 * Distinct rows vs total rows, per service.
 *
 * The first thing to check when every detector fires on 0% — a detector
 * cannot learn a boundary from a handful of distinct points no matter how
 * many times they were sampled. Measured on sock-shop:front-end: 1568 rows
 * carrying 6 distinct values, because collection polls faster than the
 * metrics actually change.
 */
export function DataQualityPanel({ models }: { models: ModelMeta[] }) {
  const rows = models
    .filter(m => m.data_quality)
    .map(m => ({
      sid: m.service_id,
      project: m.project || m.service_id.split(':')[0],
      ...m.data_quality!,
    }))
    .sort((a, b) => a.unique_fraction - b.unique_fraction);

  if (rows.length === 0) return null;
  const thin = rows.filter(r => r.unique_fraction < 0.05);

  return (
    <CollapsiblePanel 
      title="Distinct signal per service" 
      desc={
        <span style={{lineHeight: 1.5}}>
          How much of each training set is actually distinct. Repeated rows carry no extra information,
          so a low percentage here caps what any detector can learn — and is the reason to look at before
          concluding a model is bad.
          {thin.length > 0 && (
            <strong style={{ color: 'var(--color-degraded)' }}> {thin.length} service{thin.length === 1 ? '' : 's'} below 5%.</strong>
          )}
        </span>
      }
      defaultCollapsed={true}
    >
      <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...TH, position: 'sticky', top: 0, background: 'var(--color-bg-panel)' }}>Service</th>
              <th style={{ ...TH, position: 'sticky', top: 0, background: 'var(--color-bg-panel)' }}>Rows</th>
              <th style={{ ...TH, position: 'sticky', top: 0, background: 'var(--color-bg-panel)' }}>Distinct</th>
              <th style={{ ...TH, position: 'sticky', top: 0, background: 'var(--color-bg-panel)' }}>Distinct share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.sid} className="ml-table-row">
                <td style={TD}>
                  <span style={{ color: 'var(--color-text-dim)' }}>{r.project}:</span>{r.sid.split(':').slice(1).join(':')}
                </td>
                <td style={{ ...TD, color: 'var(--color-text-muted)' }}>{r.rows}</td>
                <td style={TD}>{r.unique_rows}</td>
                <td style={{ ...TD, color: r.unique_fraction < 0.05 ? 'var(--color-degraded)' : 'var(--color-text-main)' }}>
                  {(r.unique_fraction * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsiblePanel>
  );
}

// Training size vs how often the model fires on the held-out tail. The tail
// isn't labelled, so a high rate isn't "wrong" — it means the model fires a
// lot on data it never saw, which is either drift or a non-normal tail.
export function ModelQualityChart({ models, onSelect }: { models: ModelMeta[]; onSelect: (sid: string) => void }) {
  const points = useMemo(() => models
    .filter(m => m.holdout)
    .map(m => ({
      sid: m.service_id,
      project: m.service_id.split(':')[0],
      samples: m.trained_on_samples,
      flagRate: Number((m.holdout!.flag_rate * 100).toFixed(2)),
      holdoutSamples: m.holdout!.samples,
    })), [models]);

  const projects = useMemo(() => Array.from(new Set(points.map(p => p.project))).sort(), [points]);
  const colors = SERIES;

  return (
    <CollapsiblePanel 
      title="Model check: holdout firing rate" 
      desc="Each model trained on the earlier part of its data and scored on the held-out tail. Unlabelled data, so this is a firing rate, not accuracy — compare it to contamination."
      defaultCollapsed={true}
    >
      {points.length === 0 ? (
        <div style={{ height: '200px', ...EMPTY }}>
          No holdout evaluations yet. Set a holdout fraction above 0 and retrain.
        </div>
      ) : (
        <div style={{ height: '230px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 5, right: 15, left: 0, bottom: 15 }}>
              <CartesianGrid stroke={GRID_COLOR} />
              <XAxis
                type="number" dataKey="samples" name="training samples"
                tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false}
                label={{ value: 'Training samples', fill: AXIS_COLOR, fontSize: 11, position: 'insideBottom', offset: -10 }}
              />
              <YAxis
                type="number" dataKey="flagRate" name="holdout flagged" unit="%"
                tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} width={45}
              />
              <ZAxis type="number" dataKey="holdoutSamples" range={[40, 200]} name="holdout rows" />
              <Tooltip
                contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ stroke: 'rgba(255,255,255,0.12)', strokeDasharray: '3 3' }}
                formatter={(value: any, name: any) => [value, name]}
                content={({ payload }) => {
                  const p = payload?.[0]?.payload;
                  if (!p) return null;
                  return (
                    <div style={{ ...TOOLTIP_STYLE, padding: '8px 10px', lineHeight: 1.6 }}>
                      <div style={{ fontWeight: 600, marginBottom: '2px' }}>{p.sid}</div>
                      <div style={{ color: 'var(--color-text-muted)' }}>{p.samples} training rows</div>
                      <div style={{ color: 'var(--color-text-muted)' }}>{p.holdoutSamples} holdout rows</div>
                      <div>{p.flagRate}% of holdout flagged</div>
                    </div>
                  );
                }}
              />
              <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />
              {projects.map((project, i) => (
                <Scatter
                  key={project}
                  name={project}
                  data={points.filter(p => p.project === project)}
                  fill={colors[i % colors.length]}
                  onClick={(d: any) => d?.sid && onSelect(d.sid)}
                  cursor="pointer"
                  isAnimationActive={false}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </CollapsiblePanel>
  );
}

interface MlProcess {
  name: string;
  script: string;
  running: boolean;
  managed: boolean;
  pid: number | null;
  startedAt: string | null;
  log: string[];
}

function ProcessCard({ proc, label, description, onAction, busy }: {
  proc: MlProcess | undefined;
  label: string;
  description: string;
  onAction: (action: 'start' | 'stop') => void;
  busy: boolean;
}) {
  const [showLog, setShowLog] = useState(false);
  const running = proc?.running ?? false;

  return (
    <div className="ml-process-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{ fontSize: '14px', fontWeight: 600 }}>{label}</span>
          <code style={{ fontSize: '11.5px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', padding: '1px 6px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--color-border)', borderRadius: '5px' }}>{proc?.script}</code>
        </div>
        <button
          onClick={() => onAction(running ? 'stop' : 'start')}
          disabled={busy}
          className="mm-btn"
          style={{ opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
        >
          {busy ? 'Working…' : running ? 'Stop' : 'Start'}
        </button>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: '6px 0 12px 0' }}>{description}</div>

      <div style={{ display: 'flex', gap: '12px', fontSize: '11.5px', flexWrap: 'wrap', alignItems: 'center', color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
        <StatusChip tone={running ? 'healthy' : 'unknown'}>{running ? 'Running' : 'Stopped'}</StatusChip>
        {proc?.pid && <span>PID <span style={{ fontFamily: 'var(--font-mono)' }}>{proc.pid}</span></span>}
        {running && !proc?.managed && <span style={{ color: 'var(--color-degraded)' }} title="Started outside this app — can still be stopped here">External</span>}
        {proc?.startedAt && <span>Up {timeAgo(proc.startedAt).replace(' ago', '')}</span>}
      </div>

      {(proc?.log.length ?? 0) > 0 && (
        <>
          <button
            onClick={() => setShowLog(v => !v)}
            style={{ marginTop: '10px', background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: '12px', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: '4px', fontFamily: 'inherit' }}
          >
            {showLog ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
            {showLog ? 'Hide log' : `Show log (${proc!.log.length} lines)`}
          </button>
          {showLog && (
            <pre style={{ ...LOG, maxHeight: '160px' }}>
              {proc!.log.slice(-40).join('\n')}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function ProcessPanel() {
  const [procs, setProcs] = useState<{ collector?: MlProcess; scorer?: MlProcess }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fetchProcs = useCallback(async () => {
    try {
      const res = await fetch('/api/ml/processes');
      if (res.ok) setProcs(await res.json());
    } catch { /* keep last known state */ }
  }, []);

  useEffect(() => {
    fetchProcs();
    const interval = setInterval(fetchProcs, 3000);
    return () => clearInterval(interval);
  }, [fetchProcs]);

  const handleAction = async (name: string, action: 'start' | 'stop') => {
    setBusy(name);
    setErr(null);
    try {
      const res = await fetch(`/api/ml/processes/${name}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await fetchProcs();
    } catch (e: any) {
      setErr(`${name} ${action} failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ml-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <h3 className="ml-chart-title" style={PANEL_TITLE}>Pipeline processes</h3>
        <InfoTip>
          The two long-running stages. The <strong>collector</strong> polls the mapper and appends raw
          metrics; the <strong>scorer</strong> runs live metrics against the trained models each cycle.
          <br /><br />
          If either is stopped, everything downstream is frozen at whatever it last wrote — which is why
          "Collected" and "Scored live" read 0 on this page when they are not running.
        </InfoTip>
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <ProcessCard
          proc={procs.collector}
          label="Collector"
          description="Polls the mapper and appends raw metrics to metrics_raw.csv"
          busy={busy === 'collector'}
          onAction={(a) => handleAction('collector', a)}
        />
        <ProcessCard
          proc={procs.scorer}
          label="Scorer"
          description="Scores live metrics against the trained models every cycle"
          busy={busy === 'scorer'}
          onAction={(a) => handleAction('scorer', a)}
        />
      </div>
      {err && <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--color-critical)' }}>{err}</div>}
    </div>
  );
}

interface MLConfig {
  collect_interval_sec: number;
  min_samples_per_service: number;
  min_training_samples: number;
  contamination: number;
  score_interval_sec: number;
  persistence_windows: number;
  n_estimators: number;
  max_samples_fraction: number;
  holdout_fraction: number;
  feature_columns: string[];
}

type ConfigField = { key: keyof MLConfig; label: string; step: string; hint: string };

const CONFIG_GROUPS: Array<{ group: string; applies: string; fields: ConfigField[] }> = [
  {
    group: 'Collection',
    applies: 'live — collector.py re-reads config each cycle',
    fields: [
      { key: 'collect_interval_sec', label: 'Collect interval (s)', step: '1', hint: 'how often collector.py polls the mapper' },
    ],
  },
  {
    group: 'Preprocessing',
    applies: 'on next Retrain',
    fields: [
      { key: 'min_samples_per_service', label: 'Min samples/service', step: '1', hint: 'below this, a service is skipped when building features' },
    ],
  },
  {
    group: 'Training',
    applies: 'on next Retrain',
    fields: [
      { key: 'min_training_samples', label: 'Min training samples', step: '1', hint: 'below this, a service gets no model' },
      { key: 'contamination', label: 'Contamination', step: '0.001', hint: 'expected fraction of anomalies — sets how aggressive the forest is' },
      { key: 'n_estimators', label: 'Trees (n_estimators)', step: '10', hint: 'number of trees in each Isolation Forest' },
      { key: 'max_samples_fraction', label: 'Max samples fraction', step: '0.05', hint: 'fraction of the training rows each tree draws (1.0 = sklearn auto)' },
      { key: 'holdout_fraction', label: 'Holdout fraction', step: '0.05', hint: 'chronological tail held out of training and scored afterwards (0 = train on everything)' },
    ],
  },
  {
    group: 'Scoring',
    applies: 'live — score.py re-reads config each cycle',
    fields: [
      { key: 'score_interval_sec', label: 'Score interval (s)', step: '1', hint: 'how often score.py re-scores live data' },
      { key: 'persistence_windows', label: 'Persistence windows', step: '1', hint: 'consecutive above-threshold windows before flagging a real anomaly' },
    ],
  },
];

const ALL_FEATURE_COLUMNS = ['z_cpu_percent', 'z_memory_percent', 'z_network_rx_rate', 'z_network_tx_rate'];

function ConfigPanel() {
  const [config, setConfig] = useState<MLConfig | null>(null);
  const [draft, setDraft] = useState<MLConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [retrain, setRetrain] = useState<{ running: boolean; startedAt: string | null; finishedAt: string | null; log: string[]; exitCode: number | null } | null>(null);
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const fetchConfig = async () => {
    const res = await fetch('/api/ml/config');
    if (res.ok) {
      const data = await res.json();
      setConfig(data);
      setDraft((prev) => prev ?? data);
    }
  };
  const fetchRetrainStatus = async () => {
    const res = await fetch('/api/ml/retrain');
    if (res.ok) setRetrain(await res.json());
  };

  useEffect(() => {
    fetchConfig();
    fetchRetrainStatus();
    const interval = setInterval(fetchRetrainStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const dirty = config && draft && JSON.stringify(config) !== JSON.stringify(draft);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/ml/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setConfig(data.config);
      setSaveMsg('Saved — collector.py/score.py pick this up within one cycle. preprocess.py/train.py need a Retrain.');
    } catch (e: any) {
      setSaveMsg(`Failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRetrain = async () => {
    setSaveMsg(null);
    try {
      const body: Record<string, string> = {};
      if (since) body.since = new Date(since).toISOString();
      if (until) body.until = new Date(until).toISOString();
      const res = await fetch('/api/ml/retrain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      fetchRetrainStatus();
    } catch (e: any) {
      setSaveMsg(`Retrain failed to start: ${e.message}`);
    }
  };

  const toggleFeature = (col: string) => {
    if (!draft) return;
    const current = draft.feature_columns ?? ALL_FEATURE_COLUMNS;
    const next = current.includes(col) ? current.filter(c => c !== col) : [...current, col];
    if (next.length === 0) return; // at least one feature is required to fit anything
    setDraft({ ...draft, feature_columns: ALL_FEATURE_COLUMNS.filter(c => next.includes(c)) });
  };

  if (!draft) return null;

  return (
    <div className="ml-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
        <h3 className="ml-chart-title" style={PANEL_TITLE}>Parameters</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleRetrain}
            disabled={retrain?.running}
            title="Re-runs preprocess.py then train.py with the saved parameters"
            className="mm-btn"
            style={{ opacity: retrain?.running ? 0.5 : 1, cursor: retrain?.running ? 'not-allowed' : 'pointer' }}
          >
            {retrain?.running ? 'Retraining…' : 'Retrain now'}
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className={dirty ? 'mm-btn primary' : 'mm-btn'}
            style={{ opacity: dirty && !saving ? 1 : 0.5, cursor: dirty && !saving ? 'pointer' : 'not-allowed' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {CONFIG_GROUPS.map(({ group, applies, fields }) => (
          <div key={group}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
              <span className="mm-eyebrow">{group}</span>
              <span style={{ fontSize: '11.5px', color: 'var(--color-text-dim)' }}>Applies {applies}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px 20px' }}>
              {fields.map(({ key, label, step, hint }) => (
                <div key={key}>
                  <label style={FIELD_LABEL} title={hint}>{label}</label>
                  <input
                    type="number"
                    step={step}
                    value={draft[key] as number}
                    onChange={(e) => setDraft({ ...draft, [key]: parseFloat(e.target.value) })}
                    title={hint}
                    style={INPUT}
                  />
                </div>
              ))}
              {group === 'Training' && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ ...FIELD_LABEL, marginBottom: '8px' }}>
                    Features the model trains on (each service is z-scored against its own baseline)
                  </label>
                  <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    {ALL_FEATURE_COLUMNS.map((col) => {
                      const on = (draft.feature_columns ?? ALL_FEATURE_COLUMNS).includes(col);
                      return (
                        <label key={col} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontFamily: 'var(--font-mono)', cursor: 'pointer', color: on ? 'var(--color-text-main)' : 'var(--color-text-dim)' }}>
                          <input type="checkbox" checked={on} onChange={() => toggleFeature(col)} style={{ accentColor: 'var(--color-accent-cyan)' }} />
                          {col.replace('z_', '')}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <span className="mm-eyebrow">Training window</span>
            <span style={{ fontSize: '11.5px', color: 'var(--color-text-dim)' }}>
              Optional. Limit training to a window you know was baseline-only, so stress runs don't teach the model that stress is normal
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px 20px' }}>
            <div>
              <label style={FIELD_LABEL}>From <span style={{ color: 'var(--color-text-dim)' }}>(blank = earliest)</span></label>
              <input
                type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)}
                style={INPUT}
              />
            </div>
            <div>
              <label style={FIELD_LABEL}>To <span style={{ color: 'var(--color-text-dim)' }}>(blank = now)</span></label>
              <input
                type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)}
                style={INPUT}
              />
            </div>
          </div>
        </div>
      </div>

      {saveMsg && <div style={{ marginTop: '14px', fontSize: '12px', color: saveMsg.startsWith('Failed') ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{saveMsg}</div>}

      {retrain && (retrain.running || retrain.finishedAt) && (
        <div style={{ marginTop: '14px', fontSize: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-muted)' }}>
            <StatusChip tone={retrain.running ? 'unknown' : retrain.exitCode === 0 ? 'healthy' : 'critical'}>
              {retrain.running ? 'Running' : retrain.exitCode === 0 ? 'Succeeded' : 'Failed'}
            </StatusChip>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {retrain.running ? 'Running preprocess.py + train.py…' : `Last retrain: exit code ${retrain.exitCode} (${timeAgo(retrain.finishedAt)})`}
            </span>
          </div>
          {retrain.log.length > 0 && (
            <pre style={{ ...LOG, maxHeight: '140px' }}>
              {retrain.log.slice(-30).join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One line of numbers for whatever is currently in scope.
 *
 * The page is long, and the questions asked most often — how many services
 * are there, how many have a model, how stale is it — were only answerable
 * by scrolling through several panels and adding up rows.
 */
function ScopeSummary({ rows, models, training }: {
  rows: { sid: string; collected?: any; featured?: any; trainedEntry?: any; live?: any }[];
  models: ModelMeta[];
  training?: { generated_at?: string } | null;
}) {
  const services = rows.length;
  const collected = rows.filter(r => r.collected).length;
  const featureReady = rows.filter(r => r.featured?.status === 'ok').length;
  const trained = rows.filter(r => r.trainedEntry).length;
  const scored = rows.filter(r => r.live).length;

  // Detector coverage: a model file exists per detector per service, and
  // some detectors refuse to fit (see the data-quality panel), so "trained"
  // alone hides that one of the four may be missing everywhere.
  const detectorCounts = new Map<string, number>();
  for (const m of models) {
    for (const [algo, info] of Object.entries(m.algorithms || {})) {
      if (!info?.error) detectorCounts.set(algo, (detectorCounts.get(algo) ?? 0) + 1);
    }
  }

  const thinData = models.filter(m => (m.data_quality?.unique_fraction ?? 1) < 0.05).length;

  const age = (() => {
    if (!training?.generated_at) return null;
    const ms = Date.now() - new Date(training.generated_at).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  })();

  return (
    <Panel
      title="At a glance"
      subtitle={`${services} service${services === 1 ? '' : 's'} in scope`}
      about={
        <>
          <strong>Collected</strong> and <strong>scored live</strong> both require a running process —
          if they read 0, the Collector or Scorer is stopped and the rest of this page is a snapshot,
          not live state.
          <br /><br />
          <strong>Detectors fitted</strong> breaks down per algorithm rather than one trained count,
          because a detector can refuse to fit and that would otherwise be invisible here.
          <br /><br />
          <strong>Thin data</strong> counts services whose training set is under 5% distinct rows. It
          caps what any detector can learn, and no hyperparameter fixes it.
        </>
      }
    >
      <StatRow>
        <KitStat label="Services" value={services} />
        <KitStat
          label="Collected"
          value={collected}
          sub={collected ? undefined : 'Collector stopped'}
        />
        <KitStat label="Feature-ready" value={featureReady} />
        <KitStat label="Trained" value={trained} />
        <KitStat
          label="Scored live"
          value={scored}
          sub={scored ? undefined : 'Scorer stopped'}
        />
        {thinData > 0 && (
          <KitStat label="Thin data" value={thinData} sub="Under 5% distinct" />
        )}
        {age && <KitStat label="Last trained" value={<span style={{ fontSize: '17px' }}>{age}</span>} />}
      </StatRow>

      {detectorCounts.size > 0 && (
        <div style={{
          marginTop: '18px', paddingTop: '16px', borderTop: '1px solid var(--color-border)',
          display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span className="mm-eyebrow" style={{ marginRight: '4px' }}>Detectors fitted</span>
          {Array.from(detectorCounts).map(([algo, n]) => (
            <span key={algo} className="mm-chip" style={{
              background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-border)',
              color: 'var(--color-text-main)',
            }}>
              {ALGO_LABEL[algo] || algo} <span style={{ color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

interface MLPipelineViewProps {
  /** The project chosen in the top bar. 'ALL' shows everything. */
  selectedProject?: string;
}

export function MLPipelineView({ selectedProject = 'ALL' }: MLPipelineViewProps) {
  const [status, setStatus] = useState<MLStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);
  const [models, setModels] = useState<ModelMeta[]>([]);

  const scoped = selectedProject !== 'ALL';
  /** Does this "project:service" id belong to the selected project? */
  const inScope = useCallback(
    (sid: string) => !scoped || sid.split(':')[0] === selectedProject,
    [scoped, selectedProject],
  );

  useEffect(() => {
    let cancelled = false;
    const fetchModels = async () => {
      try {
        const res = await fetch('/api/ml/models');
        if (res.ok && !cancelled) setModels(await res.json());
      } catch { /* keep previous models */ }
    };
    fetchModels();
    const interval = setInterval(fetchModels, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/ml/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) { setStatus(data); setError(null); }
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Failed to fetch ML status');
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (error && !status) {
    return <div style={{ padding: '24px', fontSize: '13px', color: 'var(--color-critical)' }}>Failed to load ML pipeline status: {error}</div>;
  }
  if (!status) {
    return <div style={{ padding: '24px', fontSize: '13px', color: 'var(--color-text-muted)' }}>Loading…</div>;
  }

  const { collection, preprocessing, training, scoring, liveScores } = status;

  // union of every service id seen at any stage, so the table shows the
  // full pipeline progress per service, not just whichever stage ran last
  const allServiceIds = new Set<string>();
  Object.keys(collection?.per_service || {}).forEach(s => allServiceIds.add(s));
  Object.keys(preprocessing?.per_service || {}).forEach(s => allServiceIds.add(s));
  Object.keys(training?.trained || {}).forEach(s => allServiceIds.add(s));
  Object.keys(training?.skipped || {}).forEach(s => allServiceIds.add(s));
  Object.keys(liveScores || {}).forEach(s => allServiceIds.add(s));

  const rows = Array.from(allServiceIds).filter(inScope).sort().map(sid => {
    const collected = collection?.per_service?.[sid];
    const featured = preprocessing?.per_service?.[sid];
    const trainedEntry = training?.trained?.[sid];
    const skippedEntry = training?.skipped?.[sid];
    const live = liveScores?.[sid];
    return { sid, collected, featured, trainedEntry, skippedEntry, live };
  });

  // Models are trained per exact service_id ("project:service"), so a
  // sock-shop service's model never sees train-ticket's data or vice versa
  // — nothing is mixed at the data or training level. This just makes that
  // isolation visible: group the table by project instead of one flat list.
  const byProject = new Map<string, typeof rows>();
  for (const row of rows) {
    const project = row.sid.includes(':') ? row.sid.split(':')[0] : '(unknown)';
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project)!.push(row);
  }
  const projectNames = Array.from(byProject.keys()).sort();

  // Everything below renders from these, so the whole page follows the top
  // bar rather than each panel deciding for itself what it shows.
  const scopedModels = models.filter(m => inScope(m.service_id));


  return (
    <div className="ml-pipeline-container">
      <PageHeader title="ML pipeline" scope={selectedProject}>
        {scoped
          ? 'How the pipeline is configured and how far each service has got through it. Model outputs live under Findings.'
          : `Configuration and per-service progress across ${projectNames.join(', ') || 'no projects yet'} — pick one in the top bar to scope this page.`}
      </PageHeader>

      <ScopeSummary rows={rows} models={scopedModels} training={training} />

      <ProcessPanel />

      <MLExecutionPanel selectedProject={selectedProject} />

      <ConfigPanel />

      {/* Stage overview */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <StageCard
          title="1. Collection"
          ready={!!collection && collection.consecutive_failures === 0}
          subtitle={collection ? `Polling every ${collection.poll_interval_sec}s` : 'Not running'}
        >
          {collection ? (
            <>
              <Stat label="Total rows" value={collection.total_rows.toLocaleString()} />
              <Stat label="Services seen" value={collection.services_seen} />
              <Stat label="Last write" value={timeAgo(collection.last_write_at)} />
              <Stat label="Consecutive failures" value={collection.consecutive_failures} />
              {collection.last_error && (
                <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-critical)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>{collection.last_error}</div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}><code style={{ fontFamily: 'var(--font-mono)' }}>collector.py</code> hasn't written a summary yet</div>
          )}
        </StageCard>

        <StageCard
          title="2. Preprocessing"
          ready={preprocessing?.status === 'ok'}
          subtitle={preprocessing ? `Last run ${timeAgo(preprocessing.generated_at)}` : 'Not run yet'}
        >
          {preprocessing ? (
            <>
              <Stat label="Raw rows read" value={preprocessing.raw_rows_read.toLocaleString()} />
              <Stat label="Feature rows" value={preprocessing.feature_rows_written?.toLocaleString() ?? '—'} />
              <Stat label="Services with features" value={preprocessing.services_with_features ?? 0} />
              <Stat label="Min samples/service" value={preprocessing.min_samples_per_service} />
            </>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Run <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-main)' }}>python3 preprocess.py</code></div>
          )}
        </StageCard>

        <StageCard
          title="3. Training"
          ready={!!training && Object.keys(training.trained).length > 0}
          subtitle={training ? `Last run ${timeAgo(training.generated_at)}` : 'Not run yet'}
        >
          {training ? (
            <>
              <Stat label="Models trained" value={Object.keys(training.trained).length} />
              <Stat label="Skipped (too few samples)" value={Object.keys(training.skipped).length} />
              <Stat label="Contamination" value={training.contamination} />
              <Stat label="Trees / features" value={`${training.n_estimators ?? '—'} / ${training.feature_columns?.length ?? '—'}`} />
              <Stat
                label="Holdout"
                value={training.holdout_fraction ? `${Math.round(training.holdout_fraction * 100)}% of each series` : 'Off'}
              />
              {training.training_window.since && (
                <div style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                  Window: {training.training_window.since} → {training.training_window.until || 'now'}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Run <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-main)' }}>python3 train.py</code></div>
          )}
        </StageCard>

        <StageCard
          title="4. Live scoring"
          ready={!!scoring}
          subtitle={scoring ? `Every ${scoring.score_interval_sec}s` : 'Not running'}
        >
          {scoring ? (
            <>
              <Stat label="Models loaded" value={scoring.models_loaded} />
              <Stat label="Scored last cycle" value={scoring.services_scored_this_cycle} />
              <Stat label="Persistence window" value={`${scoring.persistence_windows_required} windows`} />
              <Stat label="Last cycle" value={timeAgo(scoring.last_cycle_at)} />
              <div style={{ marginTop: '8px', fontSize: '12px', color: scoring.persistent_anomalies_now.length > 0 ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
                {scoring.persistent_anomalies_now.length > 0
                  ? `${scoring.persistent_anomalies_now.length} persistent anomaly(s): ${scoring.persistent_anomalies_now.join(', ')}`
                  : 'No persistent anomalies right now'}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Run <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-main)' }}>python3 score.py</code></div>
          )}
        </StageCard>
      </div>

      {/* A funnel with a single bar says nothing the summary strip above does
          not already say, so it only earns its space when comparing projects. */}
      {!scoped && <PipelineFunnelChart projectNames={projectNames} byProject={byProject} />}

      {/* Model outputs — live scores, model quality, detector agreement, data
          quality and the feature explorer — moved to Findings. This page is
          the machine: how the pipeline is configured and how far each service
          has got through it. */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)', padding: '12px 16px', fontSize: '12px',
        color: 'var(--color-text-muted)', lineHeight: 1.6,
      }}>
        Looking for scores, model quality, detector agreement or the feature explorer? Those are model
        <em> outputs</em> and live under <strong style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>Findings</strong>.
        This page covers the pipeline itself — processes, execution, configuration, and how far each
        service has got through collection, preprocessing and training.
      </div>

      {/* Per-project pipeline progress — one section per project, never merged */}
      {projectNames.map((project) => {
        const projectRows = byProject.get(project)!;
        const trainedCount = projectRows.filter(r => r.trainedEntry).length;
        const scoredCount = projectRows.filter(r => r.live).length;
        return (
          <div key={project} className="ml-panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '12px' }}>
              <h3 className="ml-chart-title" style={PANEL_TITLE}>{project}</h3>
              <span style={{ fontSize: '12px', color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                {projectRows.length} services · {trainedCount} trained · {scoredCount} scored
              </span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Service</th>
                  <th style={TH}>Collected</th>
                  <th style={TH}>Feature-ready</th>
                  <th style={TH}>Trained</th>
                  <th style={TH} title="Share of the held-out tail this model flagged — unlabelled data, so a firing rate rather than an error rate">Holdout flagged</th>
                  <th style={TH}>Threshold</th>
                  <th style={TH}>Live score</th>
                  <th style={TH}>Status</th>
                </tr>
              </thead>
              <tbody>
                {projectRows.map(({ sid, collected, featured, trainedEntry, skippedEntry, live }) => {
                  const shortName = sid.includes(':') ? sid.split(':').slice(1).join(':') : sid;
                  return (
                    <tr
                      key={sid}
                      onClick={() => live && setSelectedSid(sid)}
                      className={`ml-table-row ${sid === selectedSid ? 'selected' : ''}`}
                      style={{ cursor: live ? 'pointer' : 'default' }}
                    >
                      <td style={{ ...TD, fontWeight: 550 }}>{shortName}</td>
                      <td style={TD}>{collected?.samples ?? 0}</td>
                      <td style={TD}>
                        {featured?.status === 'ok'
                          ? `${featured.feature_samples}${featured.zero_variance_features?.length ? ` (${featured.zero_variance_features.length} flat)` : ''}`
                          : featured?.status === 'skipped_too_few_samples' ? `${featured.raw_samples} (too few)` : '—'}
                      </td>
                      <td style={TD}>
                        {trainedEntry ? (
                          <span>Yes <span style={{ color: 'var(--color-text-dim)' }}>({trainedEntry.samples})</span></span>
                        ) : skippedEntry ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>No <span style={{ color: 'var(--color-text-dim)' }}>({skippedEntry.samples} samples)</span></span>
                        ) : '—'}
                      </td>
                      <td style={TD}>
                        {trainedEntry?.holdout
                          ? <span title={`${trainedEntry.holdout.samples} held-out rows`}>{(trainedEntry.holdout.flag_rate * 100).toFixed(1)}%</span>
                          : trainedEntry ? <span style={{ color: 'var(--color-text-dim)' }}>No holdout</span> : '—'}
                      </td>
                      <td style={TD}>{trainedEntry ? trainedEntry.threshold_p99.toFixed(3) : '—'}</td>
                      <td style={TD}>
                        {live ? <ScoreBar score={live.anomaly_score} persistent={live.persistent} aboveThreshold={live.above_threshold} /> : '—'}
                      </td>
                      <td style={TD}>
                        {live?.persistent ? (
                          <StatusChip tone="critical">Persistent anomaly</StatusChip>
                        ) : live?.above_threshold ? (
                          <StatusChip tone="degraded">{live.consecutive_windows}/{scoring?.persistence_windows_required ?? '?'} windows above threshold</StatusChip>
                        ) : trainedEntry ? (
                          <StatusChip tone="healthy">Normal</StatusChip>
                        ) : (
                          <span style={{ color: 'var(--color-text-dim)', fontSize: '12px' }}>Not scored yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
