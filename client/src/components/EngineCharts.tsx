import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import {
  Bar, BarChart, Brush, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';

/**
 * Charts for the Detection engines page. Every chart sits in a card with an
 * enlarge button: the popup draws the same chart taller, with a range brush
 * to zoom into a stretch of cycles where the chart has a time axis.
 */

export interface History { t: number; rules: number; ml: number; hybrid: number }
export interface Row { id: string; rules: number; level: number; own: number; symptom: number; walk: number; blend: number; hard: boolean; fact?: string }
export interface TrailPoint { t: number; rules: number; own: number; symptom: number; walk: number; blend: number }

export const ENGINE_COLORS = { rules: '#e8a33d', ml: '#8ab4ff', hybrid: '#3ecf8e' } as const;
const GRID = 'rgba(255,255,255,0.06)';
const AXIS = { fontSize: 11, fill: 'var(--color-text-dim)' };
const TIP: CSSProperties = { background: 'rgba(14,16,22,0.96)', border: '1px solid var(--color-border-hover)', borderRadius: 8, fontSize: 12 };
const muted: CSSProperties = { color: 'var(--color-text-muted)' };
const clean = (id: string) => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A chart card with an enlarge button; `render(expanded)` draws the chart for either size. */
export function ChartCard({ title, about, render, footer }: { title: string; about: string; render: (expanded: boolean) => ReactNode; footer?: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div style={{ padding: 14, borderRadius: 10, border: '1px solid var(--color-border)', background: 'rgba(255,255,255,.015)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 11.5, marginTop: 2, ...muted }}>{about}</div>
        </div>
        <button type="button" className="mm-btn" title="Enlarge" aria-label={`Enlarge ${title}`} onClick={() => setOpen(true)} style={{ marginLeft: 'auto', padding: '4px 6px', flexShrink: 0 }}>
          <Maximize2 size={13} />
        </button>
      </div>
      <div onDoubleClick={() => setOpen(true)}>{render(false)}</div>
      {footer && <div style={{ marginTop: 8, fontSize: 11.5, ...muted }}>{footer}</div>}
      {open && createPortal(
        <div role="dialog" aria-modal="true" aria-label={title} onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(4,6,10,0.72)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(1200px, 100%)', maxHeight: '100%', overflow: 'auto', padding: 20, borderRadius: 14, border: '1px solid var(--color-border-hover)', background: 'var(--color-bg-panel, #0e1016)', boxShadow: '0 24px 60px rgba(0,0,0,.6)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
                <div style={{ fontSize: 12.5, marginTop: 3, ...muted }}>{about}</div>
              </div>
              <button type="button" className="mm-btn" aria-label="Close" onClick={() => setOpen(false)} style={{ marginLeft: 'auto', padding: '4px 6px' }}><X size={15} /></button>
            </div>
            {render(true)}
            {footer && <div style={{ marginTop: 10, fontSize: 12, ...muted }}>{footer}</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div style={{ fontSize: 12, padding: '30px 0', textAlign: 'center', ...muted }}>{children}</div>;

/** Each engine's strongest service against that engine's own alarm line, cycle by cycle. */
export function PeaksChart({ history, expanded }: { history: History[]; expanded: boolean }) {
  if (history.length < 2) return <Empty>The chart appears after a few cycles.</Empty>;
  return (
    <ResponsiveContainer width="100%" height={expanded ? 460 : 200}>
      <LineChart data={history} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tickFormatter={clock} tick={AXIS} minTickGap={40} />
        <YAxis tick={AXIS} domain={[0, (max: number) => Math.max(2, Math.ceil(max))]} />
        <Tooltip contentStyle={TIP} labelFormatter={(t) => clock(Number(t))} formatter={(v, k) => [`${Number(v).toFixed(2)}× line`, k === 'ml' ? 'ML' : String(k)[0].toUpperCase() + String(k).slice(1)]} />
        <ReferenceLine y={1} stroke="var(--color-critical)" strokeDasharray="4 4" label={{ value: 'alarm line', position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-text-dim)' }} />
        {(['rules', 'ml', 'hybrid'] as const).map((k) => <Line key={k} dataKey={k} stroke={ENGINE_COLORS[k]} strokeWidth={1.8} dot={false} isAnimationActive={false} />)}
        <Legend wrapperStyle={{ fontSize: 12 }} formatter={(k: string) => (k === 'ml' ? 'ML' : k[0].toUpperCase() + k.slice(1))} />
        {expanded && <Brush dataKey="t" height={22} stroke="#8ab4ff" fill="rgba(255,255,255,0.03)" tickFormatter={clock} />}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** One row per engine, one cell per cycle, lit when that engine was over its line: where they agree and where they do not. */
export function AgreementStrip({ history, expanded }: { history: History[]; expanded: boolean }) {
  if (history.length < 2) return <Empty>The strip appears after a few cycles.</Empty>;
  const rows = ['rules', 'ml', 'hybrid'] as const;
  const cell = expanded ? 22 : 12;
  const all = history.filter((h) => h.rules >= 1 && h.ml >= 1).length;
  const onlyRules = history.filter((h) => h.rules >= 1 && h.ml < 1).length;
  const onlyMl = history.filter((h) => h.ml >= 1 && h.rules < 1).length;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `56px 1fr`, rowGap: 6, alignItems: 'center' }}>
        {rows.map((k) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ fontSize: 12, ...muted }}>{k === 'ml' ? 'ML' : k[0].toUpperCase() + k.slice(1)}</span>
            <div style={{ display: 'flex', gap: 2 }}>
              {history.map((h) => (
                <span key={h.t} title={`${clock(h.t)} · ${h[k].toFixed(2)}× line`}
                  style={{ flex: 1, minWidth: 2, height: cell, borderRadius: 2, background: h[k] >= 1 ? ENGINE_COLORS[k] : `rgba(255,255,255,${0.04 + Math.min(h[k], 1) * 0.14})` }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 10, fontSize: 12, ...muted }}>
        <span>both over the line: <b style={{ color: 'var(--color-text-main)' }}>{all}</b></span>
        <span>rules only: <b style={{ color: ENGINE_COLORS.rules }}>{onlyRules}</b></span>
        <span>ML only: <b style={{ color: ENGINE_COLORS.ml }}>{onlyMl}</b></span>
        <span style={{ marginLeft: 'auto' }}>{history.length} cycles · {clock(history[0].t)} to {clock(history[history.length - 1].t)}</span>
      </div>
    </div>
  );
}

/** Every service, every engine, against the same line. Click a service to follow it below. */
export function ServiceBars({ rows, expanded, onPick, picked }: { rows: Row[]; expanded: boolean; onPick: (id: string) => void; picked: string | null }) {
  const data = useMemo(() => rows.map((r) => ({ id: r.id, name: clean(r.id), rules: Math.min(r.rules, 6), ml: Math.min(r.level, 6), hybrid: Math.min(r.blend, 6) })), [rows]);
  if (!data.length) return <Empty>No services scored yet.</Empty>;
  const shown = expanded ? data : data.slice(0, 10);
  return (
    <ResponsiveContainer width="100%" height={expanded ? 480 : 220}>
      <BarChart data={shown} margin={{ top: 6, right: 8, bottom: expanded ? 40 : 30, left: -18 }} onClick={(e: any) => e?.activePayload?.[0] && onPick(e.activePayload[0].payload.id)}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={{ ...AXIS, fontSize: 10.5 }} interval={0} angle={-30} textAnchor="end" />
        <YAxis tick={AXIS} />
        <Tooltip contentStyle={TIP} cursor={{ fill: 'rgba(255,255,255,0.04)' }} formatter={(v, k) => [`${Number(v).toFixed(2)}× line`, k === 'ml' ? 'ML level' : k === 'hybrid' ? 'Hybrid score' : 'Rules']} />
        <ReferenceLine y={1} stroke="var(--color-critical)" strokeDasharray="4 4" />
        {(['rules', 'ml', 'hybrid'] as const).map((k) => (
          <Bar key={k} dataKey={k} fill={ENGINE_COLORS[k]} radius={[3, 3, 0, 0]} isAnimationActive={false} cursor="pointer">
            {shown.map((d) => <Cell key={d.id} fillOpacity={!picked || picked === d.id ? 0.9 : 0.35} />)}
          </Bar>
        ))}
        <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} formatter={(k: string) => (k === 'ml' ? 'ML level' : k === 'hybrid' ? 'Hybrid score' : 'Rules')} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * The two halves of each service's ML level against each other (own resources vs symptoms). High own level
 * (its CPU, memory) points at a source; high symptom level alone (traffic,
 * errors, latency) points at a victim of something else.
 */
export function SourceVictimScatter({ rows, expanded, onPick }: { rows: Row[]; expanded: boolean; onPick: (id: string) => void }) {
  const data = useMemo(() => rows.map((r) => ({ id: r.id, name: clean(r.id), own: Math.min(r.own, 5), symptom: Math.min(r.symptom, 5), walk: r.walk, hard: r.hard })), [rows]);
  if (!data.length) return <Empty>No services scored yet.</Empty>;
  const max = Math.max(2, Math.ceil(Math.max(...data.map((d) => Math.max(d.own, d.symptom)))));
  return (
    <ResponsiveContainer width="100%" height={expanded ? 480 : 220}>
      <ScatterChart margin={{ top: 8, right: 14, bottom: 14, left: -12 }}>
        <CartesianGrid stroke={GRID} />
        <ReferenceArea x1={1} x2={max} y1={0} y2={1} fill="#e8a33d" fillOpacity={0.05} label={{ value: 'source', position: 'insideBottomRight', fontSize: 10, fill: 'var(--color-text-dim)' }} />
        <ReferenceArea x1={0} x2={1} y1={1} y2={max} fill="#8ab4ff" fillOpacity={0.05} label={{ value: 'victim', position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-text-dim)' }} />
        <XAxis type="number" dataKey="own" name="own level" domain={[0, max]} tick={AXIS} label={{ value: 'own (CPU, memory)', position: 'insideBottom', offset: -8, fontSize: 10.5, fill: 'var(--color-text-dim)' }} />
        <YAxis type="number" dataKey="symptom" name="symptom level" domain={[0, max]} tick={AXIS} />
        <ZAxis type="number" dataKey="walk" range={[40, 380]} />
        <ReferenceLine x={1} stroke="var(--color-critical)" strokeDasharray="4 4" />
        <ReferenceLine y={1} stroke="var(--color-critical)" strokeDasharray="4 4" />
        <Tooltip contentStyle={TIP} cursor={{ strokeDasharray: '3 3' }}
          content={({ payload }) => {
            const d = payload?.[0]?.payload;
            if (!d) return null;
            return <div style={{ ...TIP, padding: '6px 10px' }}><b>{d.name}</b><br />own {d.own.toFixed(2)} · symptom {d.symptom.toFixed(2)}<br />walk blame {(d.walk * 100).toFixed(0)}%{d.hard ? ' · container fact' : ''}</div>;
          }} />
        <Scatter data={data} isAnimationActive={false} onClick={(d: any) => d?.id && onPick(d.id)} cursor="pointer">
          {data.map((d) => <Cell key={d.id} fill={d.hard ? '#ef5f67' : d.own >= 1 ? '#e8a33d' : d.symptom >= 1 ? '#8ab4ff' : '#6b7280'} />)}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/** Where the random walk puts the blame right now. */
export function BlameChart({ rows, expanded, onPick }: { rows: Row[]; expanded: boolean; onPick: (id: string) => void }) {
  const data = useMemo(() => [...rows].sort((a, b) => b.walk - a.walk).slice(0, expanded ? 20 : 8).map((r) => ({ id: r.id, name: clean(r.id), walk: +(r.walk * 100).toFixed(1) })), [rows, expanded]);
  if (!data.length) return <Empty>No services scored yet.</Empty>;
  return (
    <ResponsiveContainer width="100%" height={expanded ? Math.max(300, data.length * 26) : 220}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 12 }} onClick={(e: any) => e?.activePayload?.[0] && onPick(e.activePayload[0].payload.id)}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS} unit="%" domain={[0, (m: number) => Math.max(10, Math.ceil(m))]} />
        <YAxis type="category" dataKey="name" tick={{ ...AXIS, fontSize: 10.5 }} width={96} />
        <Tooltip contentStyle={TIP} cursor={{ fill: 'rgba(255,255,255,0.04)' }} formatter={(v) => [`${v}%`, 'share of the blame']} />
        <Bar dataKey="walk" fill={ENGINE_COLORS.ml} radius={[0, 3, 3, 0]} isAnimationActive={false} cursor="pointer" />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** One service over the last cycles: what each engine made of it. */
export function ServiceTrail({ trail, ids, picked, onPick, expanded }: { trail: Record<string, TrailPoint[]>; ids: string[]; picked: string | null; onPick: (id: string) => void; expanded: boolean }) {
  const id = picked && trail[picked] ? picked : ids.find((x) => trail[x]?.length) ?? null;
  const data = id ? trail[id] : [];
  return (
    <div>
      <select className="mm-input" value={id ?? ''} onChange={(e) => onPick(e.target.value)} style={{ fontSize: 12, padding: '4px 8px', marginBottom: 8, background: 'var(--color-bg-raised)', color: 'var(--color-text-main)', border: '1px solid var(--color-border)', borderRadius: 6, colorScheme: 'dark' }} aria-label="Service to follow">
        {ids.map((x) => <option key={x} value={x}>{clean(x)}</option>)}
      </select>
      {data.length < 2 ? <Empty>This service needs a few cycles of history.</Empty> : (
        <ResponsiveContainer width="100%" height={expanded ? 440 : 200}>
          <LineChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="t" tickFormatter={clock} tick={AXIS} minTickGap={40} />
            <YAxis yAxisId="l" tick={AXIS} domain={[0, (m: number) => Math.max(2, Math.ceil(m))]} />
            <YAxis yAxisId="r" orientation="right" tick={AXIS} unit="%" domain={[0, 100]} hide={!expanded} />
            <Tooltip contentStyle={TIP} labelFormatter={(t) => clock(Number(t))}
              formatter={(v, k) => (k === 'walk' ? [`${Number(v).toFixed(0)}%`, 'walk blame'] : [`${Number(v).toFixed(2)}× line`, LABEL[String(k)] ?? String(k)])} />
            <ReferenceLine yAxisId="l" y={1} stroke="var(--color-critical)" strokeDasharray="4 4" />
            <Line yAxisId="l" dataKey="rules" stroke={ENGINE_COLORS.rules} dot={false} strokeWidth={1.6} isAnimationActive={false} />
            <Line yAxisId="l" dataKey="own" stroke="#c4a7ff" dot={false} strokeWidth={1.6} isAnimationActive={false} />
            <Line yAxisId="l" dataKey="symptom" stroke={ENGINE_COLORS.ml} dot={false} strokeWidth={1.6} isAnimationActive={false} />
            <Line yAxisId="l" dataKey="blend" stroke={ENGINE_COLORS.hybrid} dot={false} strokeWidth={1.8} isAnimationActive={false} />
            {expanded && <Line yAxisId="r" dataKey={(p: TrailPoint) => p.walk * 100} name="walk" stroke="#9ca3af" strokeDasharray="3 3" dot={false} isAnimationActive={false} />}
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={(k: string) => LABEL[k] ?? k} />
            {expanded && <Brush dataKey="t" height={22} stroke="#8ab4ff" fill="rgba(255,255,255,0.03)" tickFormatter={clock} />}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
const LABEL: Record<string, string> = { rules: 'Rules', own: 'ML own', symptom: 'ML symptom', blend: 'Hybrid', walk: 'walk blame' };
