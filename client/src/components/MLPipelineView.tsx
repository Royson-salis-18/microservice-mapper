import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, Legend,
  LineChart, Line, ReferenceLine, ScatterChart, Scatter, ZAxis,
} from 'recharts';

interface MLStatus {
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
    <div style={{
      background: 'var(--color-bg-panel)',
      border: '1px solid var(--color-border)',
      borderRadius: '10px',
      padding: '16px 18px',
      flex: 1,
      minWidth: '220px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          background: ready ? 'var(--color-healthy)' : 'var(--color-text-muted)',
          boxShadow: ready ? '0 0 6px var(--color-healthy)' : 'none',
        }} />
        <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.3px' }}>{title}</span>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '10px' }}>{subtitle}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '3px 0' }}>
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function ScoreBar({ score, persistent, aboveThreshold }: { score: number; persistent: boolean; aboveThreshold: boolean }) {
  const color = persistent ? 'var(--color-critical)' : aboveThreshold ? 'var(--color-degraded)' : 'var(--color-healthy)';
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100px' }}>
      <div style={{ flex: 1, height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ fontSize: '11px', color, fontWeight: 600, width: '30px', textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

const CHART_PANEL_STYLE: React.CSSProperties = {
  background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)', borderRadius: '10px', padding: '18px',
};
const AXIS_COLOR = 'var(--color-text-muted)';
const GRID_COLOR = 'rgba(255,255,255,0.06)';
const TOOLTIP_STYLE = { background: '#0d1117', border: '1px solid var(--color-border)', borderRadius: '6px', fontSize: '11px' };

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
    <div style={CHART_PANEL_STYLE}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Pipeline funnel by project</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>How many of each project's services have made it through each stage</p>
      <div style={{ height: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="project" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} />
            <YAxis tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Legend wrapperStyle={{ fontSize: '11px' }} />
            <Bar dataKey="collected" name="Collected" fill="#94a3b8" radius={[3, 3, 0, 0]} />
            <Bar dataKey="featureReady" name="Feature-ready" fill="#00d4ff" radius={[3, 3, 0, 0]} />
            <Bar dataKey="trained" name="Trained" fill="#00e676" radius={[3, 3, 0, 0]} />
            <Bar dataKey="scored" name="Scored" fill="#e040fb" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function severityColor(score: { persistent: boolean; above_threshold: boolean }): string {
  if (score.persistent) return '#ff1744';
  if (score.above_threshold) return '#ffab00';
  return '#00e676';
}

function LiveScoresChart({ rows, onSelect, selectedSid }: { rows: Array<{ sid: string; live?: { anomaly_score: number; persistent: boolean; above_threshold: boolean } }>; onSelect: (sid: string) => void; selectedSid: string | null }) {
  const data = rows
    .filter(r => r.live)
    .map(r => ({ sid: r.sid, name: r.sid.includes(':') ? r.sid.split(':').slice(1).join(':') : r.sid, score: Math.round(r.live!.anomaly_score * 100), live: r.live! }))
    .sort((a, b) => b.score - a.score);

  if (data.length === 0) {
    return (
      <div style={CHART_PANEL_STYLE}>
        <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Live anomaly scores</h3>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-text-muted)' }}>No services are being scored yet.</p>
      </div>
    );
  }

  return (
    <div style={CHART_PANEL_STYLE}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Live anomaly scores</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>Click a bar to see its trend below · red = persistent anomaly, amber = above threshold, green = normal</p>
      <div style={{ height: `${Math.max(160, data.length * 26)}px` }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} horizontal={false} />
            <XAxis type="number" domain={[0, 100]} tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} unit="%" />
            <YAxis type="category" dataKey="name" tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} width={140} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(255,255,255,0.03)' }} formatter={(v: any) => [`${v}%`, 'anomaly score']} />
            <Bar dataKey="score" radius={[0, 3, 3, 0]} onClick={(d: any) => onSelect(d.sid)} style={{ cursor: 'pointer' }}>
              {data.map((entry) => (
                <Cell key={entry.sid} fill={severityColor(entry.live)} fillOpacity={entry.sid === selectedSid ? 1 : 0.75} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ScoreHistoryChart({ sid }: { sid: string | null }) {
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
      <div style={CHART_PANEL_STYLE}>
        <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Anomaly score trend</h3>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-text-muted)' }}>Click a service in the chart above (or a row in the table below) to see its trend over time.</p>
      </div>
    );
  }

  const data = history.map(h => ({ ...h, score: Math.round(h.anomaly_score * 100), t: new Date(h.timestamp).toLocaleTimeString() }));

  return (
    <div style={CHART_PANEL_STYLE}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Anomaly score trend — {sid}</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>From score_history.csv, written every scoring cycle</p>
      {data.length < 2 ? (
        <div style={{ height: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          Not enough history yet for this service
        </div>
      ) : (
        <div style={{ height: '200px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
              <XAxis dataKey="t" tick={{ fill: AXIS_COLOR, fontSize: 10 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} minTickGap={30} />
              <YAxis domain={[0, 100]} tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} unit="%" />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [`${v}%`, 'anomaly score']} labelStyle={{ color: AXIS_COLOR }} />
              <ReferenceLine y={100} stroke="#ff1744" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: 'threshold', fill: '#ff1744', fontSize: 10, position: 'insideTopRight' }} />
              <Line type="monotone" dataKey="score" stroke="#00d4ff" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const FEATURE_SERIES = [
  { raw: 'cpu_percent', z: 'z_cpu_percent', label: 'cpu %', color: '#00d4ff' },
  { raw: 'memory_percent', z: 'z_memory_percent', label: 'mem %', color: '#00e676' },
  { raw: 'network_rx_rate', z: 'z_network_rx_rate', label: 'rx B/s', color: '#ffab00' },
  { raw: 'network_tx_rate', z: 'z_network_tx_rate', label: 'tx B/s', color: '#e040fb' },
];

// Shows the exact rows train.py fits on — raw values on the left, the
// z-scores actually fed to the forest on the right — so a score can be
// traced back to the data that produced it instead of taken on faith.
function FeatureExplorer({ serviceIds, sid, onSelect }: { serviceIds: string[]; sid: string | null; onSelect: (sid: string) => void }) {
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
    <div style={CHART_PANEL_STYLE}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>Feature explorer</h3>
          <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>
            The actual rows from features.csv — raw metrics and the normalized z-scores the model is fitted on
          </p>
        </div>
        <select
          value={sid ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            background: 'rgba(0,0,0,0.3)', border: '1px solid var(--color-border)', borderRadius: '6px',
            padding: '5px 8px', fontSize: '11px', color: '#fff', outline: 'none', maxWidth: '280px',
          }}
        >
          <option value="">select a service…</option>
          {serviceIds.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', margin: '10px 0' }}>
        {FEATURE_SERIES.map(f => (
          <label key={f.raw} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', cursor: 'pointer', color: visible.includes(f.raw) ? f.color : 'var(--color-text-muted)' }}>
            <input type="checkbox" checked={visible.includes(f.raw)} onChange={() => toggle(f.raw)} style={{ accentColor: f.color }} />
            {f.label}
          </label>
        ))}
      </div>

      {!sid ? (
        <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          Pick a service to inspect its training features
        </div>
      ) : loading && data.length === 0 ? (
        <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: 'var(--color-text-muted)' }}>Loading features…</div>
      ) : data.length < 2 ? (
        <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          No feature rows for this service yet — it needs more samples, then a Retrain
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>Raw values</div>
            <div style={{ height: '190px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                  <XAxis dataKey="t" tick={{ fill: AXIS_COLOR, fontSize: 10 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fill: AXIS_COLOR, fontSize: 10 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} width={45} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: AXIS_COLOR }} />
                  {FEATURE_SERIES.filter(f => visible.includes(f.raw)).map(f => (
                    <Line key={f.raw} type="monotone" dataKey={f.raw} name={f.label} stroke={f.color} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>Z-scores (model input) — dashed lines at ±3σ</div>
            <div style={{ height: '190px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                  <XAxis dataKey="t" tick={{ fill: AXIS_COLOR, fontSize: 10 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fill: AXIS_COLOR, fontSize: 10 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} width={45} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: AXIS_COLOR }} formatter={(v: any) => (typeof v === 'number' ? v.toFixed(2) : v)} />
                  <ReferenceLine y={3} stroke="#ff1744" strokeDasharray="4 4" strokeOpacity={0.4} />
                  <ReferenceLine y={-3} stroke="#ff1744" strokeDasharray="4 4" strokeOpacity={0.4} />
                  {FEATURE_SERIES.filter(f => visible.includes(f.raw)).map(f => (
                    <Line key={f.z} type="monotone" dataKey={f.z} name={f.label} stroke={f.color} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// How the live scores are spread out right now. A pile-up in the lowest
// bucket is the expected shape for a healthy system; a long right tail is
// what's worth looking at.
function ScoreDistributionChart({ rows }: { rows: Array<{ live?: { anomaly_score: number } }> }) {
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
    <div style={CHART_PANEL_STYLE}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Live score distribution</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>
        {scored} scored service{scored === 1 ? '' : 's'} bucketed by current anomaly score
      </p>
      {scored === 0 ? (
        <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          Nothing scored right now — the scorer needs live metrics from a reachable target
        </div>
      ) : (
        <div style={{ height: '200px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={buckets} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
              <XAxis dataKey="bucket" tick={{ fill: AXIS_COLOR, fontSize: 9 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} interval={0} angle={-30} textAnchor="end" height={45} />
              <YAxis allowDecimals={false} tick={{ fill: AXIS_COLOR, fontSize: 11 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} width={30} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: AXIS_COLOR }} formatter={(v: any) => [`${v} service(s)`, 'count']} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="count" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {buckets.map((b) => (
                  <Cell key={b.bucket} fill={b.index >= 8 ? '#ff1744' : b.index >= 5 ? '#ffab00' : '#00e676'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

interface ModelMeta {
  service_id: string;
  feature_columns: string[];
  trained_on_samples: number;
  trained_at: string;
  contamination: number;
  n_estimators?: number;
  threshold_p99: number;
  holdout?: { samples: number; flag_rate: number; mean_score: number; max_score: number; from: string; to: string } | null;
}

// Training size vs how often the model fires on the held-out tail. The tail
// isn't labelled, so a high rate isn't "wrong" — it means the model fires a
// lot on data it never saw, which is either drift or a non-normal tail.
function ModelQualityChart({ models, onSelect }: { models: ModelMeta[]; onSelect: (sid: string) => void }) {
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
  const colors = ['#00d4ff', '#00e676', '#ffab00', '#e040fb', '#ff1744'];

  return (
    <div style={CHART_PANEL_STYLE}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Model check — holdout firing rate</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>
        Each model trained on the earlier part of its data and scored on the held-out tail. Unlabelled data, so this is a firing rate, not accuracy — compare it to contamination.
      </p>
      {points.length === 0 ? (
        <div style={{ height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic', textAlign: 'center', padding: '0 20px' }}>
          No holdout evaluations yet — set a holdout fraction above 0 and hit Retrain
        </div>
      ) : (
        <div style={{ height: '230px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 5, right: 15, left: 0, bottom: 15 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis
                type="number" dataKey="samples" name="training samples"
                tick={{ fill: AXIS_COLOR, fontSize: 10 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false}
                label={{ value: 'training samples', fill: AXIS_COLOR, fontSize: 10, position: 'insideBottom', offset: -10 }}
              />
              <YAxis
                type="number" dataKey="flagRate" name="holdout flagged" unit="%"
                tick={{ fill: AXIS_COLOR, fontSize: 10 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} width={45}
              />
              <ZAxis type="number" dataKey="holdoutSamples" range={[40, 200]} name="holdout rows" />
              <Tooltip
                contentStyle={TOOLTIP_STYLE} labelStyle={{ color: AXIS_COLOR }} cursor={{ strokeDasharray: '3 3' }}
                formatter={(value: any, name: any) => [value, name]}
                content={({ payload }) => {
                  const p = payload?.[0]?.payload;
                  if (!p) return null;
                  return (
                    <div style={{ ...TOOLTIP_STYLE, padding: '8px 10px', color: '#c9d1d9' }}>
                      <div style={{ fontWeight: 700, marginBottom: '3px' }}>{p.sid}</div>
                      <div>{p.samples} training rows</div>
                      <div>{p.holdoutSamples} holdout rows</div>
                      <div>{p.flagRate}% of holdout flagged</div>
                    </div>
                  );
                }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
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
    </div>
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
    <div style={{ flex: 1, minWidth: '300px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{
            width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
            background: running ? 'var(--color-healthy)' : 'var(--color-text-muted)',
            boxShadow: running ? '0 0 6px var(--color-healthy)' : 'none',
          }} />
          <span style={{ fontSize: '13px', fontWeight: 700 }}>{label}</span>
          <code style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>{proc?.script}</code>
        </div>
        <button
          onClick={() => onAction(running ? 'stop' : 'start')}
          disabled={busy}
          style={{
            background: running ? 'rgba(255, 23, 68, 0.12)' : 'rgba(0, 230, 118, 0.12)',
            color: running ? 'var(--color-critical)' : 'var(--color-healthy)',
            border: `1px solid ${running ? 'rgba(255,23,68,0.3)' : 'rgba(0,230,118,0.3)'}`,
            borderRadius: '6px', padding: '4px 12px', fontSize: '11px', fontWeight: 700,
            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, flexShrink: 0,
          }}
        >
          {busy ? '...' : running ? 'Stop' : 'Start'}
        </button>
      </div>

      <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', margin: '6px 0 8px 0' }}>{description}</div>

      <div style={{ display: 'flex', gap: '14px', fontSize: '11px', flexWrap: 'wrap' }}>
        <span style={{ color: running ? 'var(--color-healthy)' : 'var(--color-text-muted)', fontWeight: 600 }}>
          {running ? 'RUNNING' : 'STOPPED'}
        </span>
        {proc?.pid && <span style={{ color: 'var(--color-text-muted)' }}>pid {proc.pid}</span>}
        {running && !proc?.managed && <span style={{ color: 'var(--color-degraded)' }} title="Started outside this app — can still be stopped here">external</span>}
        {proc?.startedAt && <span style={{ color: 'var(--color-text-muted)' }}>up {timeAgo(proc.startedAt).replace(' ago', '')}</span>}
      </div>

      {(proc?.log.length ?? 0) > 0 && (
        <>
          <button
            onClick={() => setShowLog(v => !v)}
            style={{ marginTop: '8px', background: 'none', border: 'none', color: 'var(--color-accent-cyan)', fontSize: '10px', cursor: 'pointer', padding: 0 }}
          >
            {showLog ? '▾ hide log' : `▸ show log (${proc!.log.length} lines)`}
          </button>
          {showLog && (
            <pre style={{
              marginTop: '6px', maxHeight: '140px', overflowY: 'auto', background: '#010409', border: '1px solid #30363d',
              borderRadius: '6px', padding: '8px', fontSize: '10px', color: '#c9d1d9', whiteSpace: 'pre-wrap',
            }}>
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
    <div style={{ background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)', borderRadius: '10px', padding: '18px' }}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Pipeline processes</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '11px', color: 'var(--color-text-muted)' }}>
        The two long-running stages. If either is stopped, the numbers below are frozen at whatever it last wrote.
      </p>
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
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
      {err && <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--color-critical)' }}>{err}</div>}
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
    <div style={{ background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)', borderRadius: '10px', padding: '18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>Parameters</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            style={{
              background: dirty ? 'var(--color-accent-cyan)' : 'rgba(255,255,255,0.05)',
              color: dirty ? '#000' : 'var(--color-text-muted)',
              border: 'none', borderRadius: '6px', padding: '5px 12px', fontSize: '11px', fontWeight: 700,
              cursor: dirty && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleRetrain}
            disabled={retrain?.running}
            title="Re-runs preprocess.py then train.py with the saved parameters"
            style={{
              background: retrain?.running ? 'rgba(255,255,255,0.05)' : 'rgba(0, 230, 118, 0.12)',
              color: retrain?.running ? 'var(--color-text-muted)' : 'var(--color-healthy)',
              border: `1px solid ${retrain?.running ? 'var(--color-border)' : 'rgba(0,230,118,0.3)'}`,
              borderRadius: '6px', padding: '5px 12px', fontSize: '11px', fontWeight: 700,
              cursor: retrain?.running ? 'not-allowed' : 'pointer',
            }}
          >
            {retrain?.running ? 'Retraining...' : 'Retrain now'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {CONFIG_GROUPS.map(({ group, applies, fields }) => (
          <div key={group}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{group}</span>
              <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>applies {applies}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px 20px' }}>
              {fields.map(({ key, label, step, hint }) => (
                <div key={key}>
                  <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '3px' }} title={hint}>{label}</label>
                  <input
                    type="number"
                    step={step}
                    value={draft[key] as number}
                    onChange={(e) => setDraft({ ...draft, [key]: parseFloat(e.target.value) })}
                    title={hint}
                    style={{
                      width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--color-border)', borderRadius: '6px',
                      padding: '5px 8px', fontSize: '12px', color: '#fff', outline: 'none',
                    }}
                  />
                </div>
              ))}
              {group === 'Training' && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '5px' }}>
                    Features the model trains on (each service is z-scored against its own baseline)
                  </label>
                  <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    {ALL_FEATURE_COLUMNS.map((col) => {
                      const on = (draft.feature_columns ?? ALL_FEATURE_COLUMNS).includes(col);
                      return (
                        <label key={col} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', cursor: 'pointer', color: on ? 'var(--color-text-main)' : 'var(--color-text-muted)' }}>
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
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Training window</span>
            <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
              optional — limit training to a window you know was baseline-only, so stress runs don't teach the model that stress is normal
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px 20px' }}>
            <div>
              <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '3px' }}>From (blank = earliest)</label>
              <input
                type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)}
                style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--color-border)', borderRadius: '6px', padding: '5px 8px', fontSize: '12px', color: '#fff', outline: 'none' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '3px' }}>To (blank = now)</label>
              <input
                type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)}
                style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--color-border)', borderRadius: '6px', padding: '5px 8px', fontSize: '12px', color: '#fff', outline: 'none' }}
              />
            </div>
          </div>
        </div>
      </div>

      {saveMsg && <div style={{ marginTop: '10px', fontSize: '11px', color: saveMsg.startsWith('Failed') ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{saveMsg}</div>}

      {retrain && (retrain.running || retrain.finishedAt) && (
        <div style={{ marginTop: '10px', fontSize: '11px' }}>
          <div style={{ color: retrain.running ? 'var(--color-accent-cyan)' : retrain.exitCode === 0 ? 'var(--color-healthy)' : 'var(--color-critical)' }}>
            {retrain.running ? 'Running preprocess.py + train.py...' : `Last retrain: exit code ${retrain.exitCode} (${timeAgo(retrain.finishedAt)})`}
          </div>
          {retrain.log.length > 0 && (
            <pre style={{
              marginTop: '6px', maxHeight: '120px', overflowY: 'auto', background: '#010409', border: '1px solid #30363d',
              borderRadius: '6px', padding: '8px', fontSize: '10px', color: '#c9d1d9', whiteSpace: 'pre-wrap',
            }}>
              {retrain.log.slice(-30).join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function MLPipelineView() {
  const [status, setStatus] = useState<MLStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);
  const [models, setModels] = useState<ModelMeta[]>([]);

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
    return <div style={{ padding: '24px', color: 'var(--color-critical)' }}>Failed to load ML pipeline status: {error}</div>;
  }
  if (!status) {
    return <div style={{ padding: '24px', color: 'var(--color-text-muted)' }}>Loading...</div>;
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

  const rows = Array.from(allServiceIds).sort().map(sid => {
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

  // Only services that made it through preprocessing have rows in
  // features.csv, so those are the only ones the explorer can chart.
  const featureServiceIds = rows
    .filter(r => r.featured?.status === 'ok')
    .map(r => r.sid);

  return (
    <div style={{
      flex: 1, height: '100%', overflowY: 'auto', padding: '24px',
      background: 'var(--color-bg-body)', color: 'var(--color-text-main)',
      display: 'flex', flexDirection: 'column', gap: '20px',
    }}>
      <div>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>ML Pipeline</h1>
        <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--color-text-muted)' }}>
          Per-service Isolation Forest anomaly detection — data collection, preprocessing, training, and live scoring status.
          Models are trained per project ({projectNames.join(', ') || 'none yet'}) — never mixed.
        </p>
      </div>

      <ProcessPanel />

      <ConfigPanel />

      {/* Stage overview */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <StageCard
          title="1. Collection"
          ready={!!collection && collection.consecutive_failures === 0}
          subtitle={collection ? `polling every ${collection.poll_interval_sec}s` : 'not running'}
        >
          {collection ? (
            <>
              <Stat label="Total rows" value={collection.total_rows.toLocaleString()} />
              <Stat label="Services seen" value={collection.services_seen} />
              <Stat label="Last write" value={timeAgo(collection.last_write_at)} />
              <Stat label="Consecutive failures" value={collection.consecutive_failures} />
              {collection.last_error && (
                <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--color-critical)' }}>{collection.last_error}</div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>collector.py hasn't written a summary yet</div>
          )}
        </StageCard>

        <StageCard
          title="2. Preprocessing"
          ready={preprocessing?.status === 'ok'}
          subtitle={preprocessing ? `last run ${timeAgo(preprocessing.generated_at)}` : 'not run yet'}
        >
          {preprocessing ? (
            <>
              <Stat label="Raw rows read" value={preprocessing.raw_rows_read.toLocaleString()} />
              <Stat label="Feature rows" value={preprocessing.feature_rows_written?.toLocaleString() ?? '—'} />
              <Stat label="Services with features" value={preprocessing.services_with_features ?? 0} />
              <Stat label="Min samples/service" value={preprocessing.min_samples_per_service} />
            </>
          ) : (
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>run: python3 preprocess.py</div>
          )}
        </StageCard>

        <StageCard
          title="3. Training"
          ready={!!training && Object.keys(training.trained).length > 0}
          subtitle={training ? `last run ${timeAgo(training.generated_at)}` : 'not run yet'}
        >
          {training ? (
            <>
              <Stat label="Models trained" value={Object.keys(training.trained).length} />
              <Stat label="Skipped (too few samples)" value={Object.keys(training.skipped).length} />
              <Stat label="Contamination" value={training.contamination} />
              <Stat label="Trees / features" value={`${training.n_estimators ?? '—'} / ${training.feature_columns?.length ?? '—'}`} />
              <Stat
                label="Holdout"
                value={training.holdout_fraction ? `${Math.round(training.holdout_fraction * 100)}% of each series` : 'off'}
              />
              {training.training_window.since && (
                <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--color-text-muted)' }}>
                  window: {training.training_window.since} → {training.training_window.until || 'now'}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>run: python3 train.py</div>
          )}
        </StageCard>

        <StageCard
          title="4. Live Scoring"
          ready={!!scoring}
          subtitle={scoring ? `every ${scoring.score_interval_sec}s` : 'not running'}
        >
          {scoring ? (
            <>
              <Stat label="Models loaded" value={scoring.models_loaded} />
              <Stat label="Scored last cycle" value={scoring.services_scored_this_cycle} />
              <Stat label="Persistence window" value={`${scoring.persistence_windows_required} windows`} />
              <Stat label="Last cycle" value={timeAgo(scoring.last_cycle_at)} />
              <div style={{ marginTop: '6px', fontSize: '11px', color: scoring.persistent_anomalies_now.length > 0 ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
                {scoring.persistent_anomalies_now.length > 0
                  ? `${scoring.persistent_anomalies_now.length} persistent anomaly(s): ${scoring.persistent_anomalies_now.join(', ')}`
                  : 'no persistent anomalies right now'}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>run: python3 score.py</div>
          )}
        </StageCard>
      </div>

      <PipelineFunnelChart projectNames={projectNames} byProject={byProject} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', alignItems: 'start' }}>
        <LiveScoresChart rows={rows} onSelect={setSelectedSid} selectedSid={selectedSid} />
        <ScoreHistoryChart sid={selectedSid} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', alignItems: 'start' }}>
        <ScoreDistributionChart rows={rows} />
        <ModelQualityChart models={models} onSelect={setSelectedSid} />
      </div>

      <FeatureExplorer serviceIds={featureServiceIds} sid={selectedSid} onSelect={setSelectedSid} />

      {/* Per-project pipeline progress — one section per project, never merged */}
      {projectNames.map((project) => {
        const projectRows = byProject.get(project)!;
        const trainedCount = projectRows.filter(r => r.trainedEntry).length;
        const scoredCount = projectRows.filter(r => r.live).length;
        return (
          <div key={project} style={{ background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)', borderRadius: '10px', padding: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{project}</h3>
              <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                {projectRows.length} services · {trainedCount} trained · {scoredCount} scored
              </span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 10px' }}>Service</th>
                  <th style={{ padding: '8px 10px' }}>Collected</th>
                  <th style={{ padding: '8px 10px' }}>Feature-ready</th>
                  <th style={{ padding: '8px 10px' }}>Trained</th>
                  <th style={{ padding: '8px 10px' }} title="Share of the held-out tail this model flagged — unlabelled data, so a firing rate rather than an error rate">Holdout flagged</th>
                  <th style={{ padding: '8px 10px' }}>Threshold</th>
                  <th style={{ padding: '8px 10px' }}>Live score</th>
                  <th style={{ padding: '8px 10px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {projectRows.map(({ sid, collected, featured, trainedEntry, skippedEntry, live }) => {
                  const shortName = sid.includes(':') ? sid.split(':').slice(1).join(':') : sid;
                  return (
                    <tr
                      key={sid}
                      onClick={() => live && setSelectedSid(sid)}
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        background: sid === selectedSid ? 'rgba(0, 212, 255, 0.06)' : 'transparent',
                        cursor: live ? 'pointer' : 'default',
                      }}
                    >
                      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{shortName}</td>
                      <td style={{ padding: '8px 10px' }}>{collected?.samples ?? 0}</td>
                      <td style={{ padding: '8px 10px' }}>
                        {featured?.status === 'ok'
                          ? `${featured.feature_samples}${featured.zero_variance_features?.length ? ` (${featured.zero_variance_features.length} flat)` : ''}`
                          : featured?.status === 'skipped_too_few_samples' ? `${featured.raw_samples} (too few)` : '—'}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        {trainedEntry ? (
                          <span style={{ color: 'var(--color-healthy)' }}>yes ({trainedEntry.samples})</span>
                        ) : skippedEntry ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>no ({skippedEntry.samples} samples)</span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        {trainedEntry?.holdout
                          ? <span title={`${trainedEntry.holdout.samples} held-out rows`}>{(trainedEntry.holdout.flag_rate * 100).toFixed(1)}%</span>
                          : trainedEntry ? <span style={{ color: 'var(--color-text-muted)' }}>no holdout</span> : '—'}
                      </td>
                      <td style={{ padding: '8px 10px' }}>{trainedEntry ? trainedEntry.threshold_p99.toFixed(3) : '—'}</td>
                      <td style={{ padding: '8px 10px' }}>
                        {live ? <ScoreBar score={live.anomaly_score} persistent={live.persistent} aboveThreshold={live.above_threshold} /> : '—'}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        {live?.persistent ? (
                          <span style={{ color: 'var(--color-critical)', fontWeight: 700 }}>PERSISTENT ANOMALY</span>
                        ) : live?.above_threshold ? (
                          <span style={{ color: 'var(--color-degraded)' }}>{live.consecutive_windows}/{scoring?.persistence_windows_required ?? '?'} windows above threshold</span>
                        ) : trainedEntry ? (
                          <span style={{ color: 'var(--color-healthy)' }}>normal</span>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)' }}>not scored yet</span>
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
