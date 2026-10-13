import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Node, Edge } from '@xyflow/react';
import { Activity, AlertTriangle, BellRing, Bell, Brain, Link2, Radar, Server, ServerCrash, Sparkles, Spline, Tags, Waypoints } from 'lucide-react';
import type { DependencyEdge, ServiceNode } from '../../types';
import { LAYOUTS, type LayoutId } from './layouts';
import type { LinkRouting } from './Edge3D';
import { AT_RISK, STATUS_LIGHT, TYPE_STYLE } from './Node3D';
import type { CalloutItem, CalloutKind } from './Callouts3D';

export interface ZoneSummary {
  id: string;
  services: number;
  /** Services down, degraded or flagged: drives the dot beside the name. */
  alerts: number;
  critical: number;
}

interface SceneHudProps {
  nodes: Node[];
  edges: Edge[];
  layout: LayoutId;
  onLayout: (layout: LayoutId) => void;
  routing: LinkRouting;
  onRouting: (routing: LinkRouting) => void;
  showLabels: boolean;
  onShowLabels: (show: boolean) => void;
  glow: boolean;
  onGlow: (on: boolean) => void;
  zones: ZoneSummary[];
  focusZone: string | null;
  onFocusZone: (zone: string | null) => void;
  /** Everything that needs attention, most urgent first. */
  alerts: CalloutItem[];
  /** Select one alert's service and fly to it. */
  onAlertSelect: (id: string) => void;
  onNextAlert: () => void;
}

/** How each kind of alert is shown in the bell's list, in the order listed. */
const ALERT_GROUPS: { kind: CalloutKind; label: string; color: string; icon: typeof Server; why: string }[] = [
  { kind: 'critical', label: 'Down', color: '#ef5f67', icon: ServerCrash, why: 'container exited, dead or crash-looping' },
  { kind: 'degraded', label: 'Degraded', color: '#e8a33d', icon: AlertTriangle, why: 'over 80% of its CPU allowance or memory, paused, or just restarted' },
  { kind: 'anomaly', label: 'ML-flagged', color: '#8ab4ff', icon: Brain, why: 'the ML ensemble has called it anomalous for several scoring windows in a row' },
  { kind: 'risk', label: 'At risk', color: '#8ab4ff', icon: Radar, why: `healthy, but the cascade model puts its failure risk at ${Math.round(AT_RISK * 100)}% or more` },
];

const projectOf = (id: string) => (id.includes(':') ? id.slice(0, id.indexOf(':')) : '');

/** Arrangements that answer a question about the system; the rest (circle,
 *  polygon, sphere, helix) are alternative shapes, kept one click further. */
const PRIMARY_LAYOUTS: ReadonlySet<LayoutId> = new Set<LayoutId>(['halls', 'clusters', 'grid', 'radial', 'tiers']);

function formatRate(perMin: number): string {
  if (perMin >= 10_000) return `${(perMin / 1000).toFixed(0)}k`;
  if (perMin >= 1000) return `${(perMin / 1000).toFixed(1)}k`;
  return String(Math.round(perMin));
}

/**
 * Everything drawn over the 3D canvas: the overview panel, the arrangement
 * tabs, the zone focus column, the alarm, and the key.
 *
 * Every figure here is a count or a sum of what is already on the nodes and
 * edges; nothing is estimated for the sake of the panel.
 */
interface ConsistencyReport {
  rulesChecked: number;
  violations: { rule: string; subject: string; detail: string }[];
}

/**
 * The server's own consistency check (/api/diagnostics/consistency), polled
 * while the scene is open: whether everything it is publishing agrees with
 * itself. Shown so that a regression is visible in the product, not only in
 * the test suite.
 */
function useConsistency(): ConsistencyReport | null {
  const [report, setReport] = useState<ConsistencyReport | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/diagnostics/consistency');
        if (res.ok && alive) setReport(await res.json());
      } catch { /* the chip just stays absent */ }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return report;
}

export function SceneHud({
  nodes, edges, layout, onLayout, routing, onRouting, showLabels, onShowLabels, glow, onGlow,
  zones, focusZone, onFocusZone, alerts, onAlertSelect, onNextAlert,
}: SceneHudProps) {
  const alertCount = alerts.length;
  // The bell takes the colour of the worst thing on its list: red only when
  // something is down, amber for degraded, calm violet when all it holds are
  // ML flags and predictions. It used to pulse red for any of them.
  const alarmTone = alerts.some((a) => a.kind === 'critical') ? 'hot'
    : alerts.some((a) => a.kind === 'degraded') ? 'warn'
    : alertCount > 0 ? 'info' : '';
  const [alarmOpen, setAlarmOpen] = useState(false);
  const alarmRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The list is portalled to the page body: the floating terminal sits above
  // the whole app (z-index 1000) and would otherwise cover it. Anchored under
  // the bell, re-measured on resize.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!alarmOpen) return;
    const place = () => {
      const r = alarmRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: r.bottom + 10, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [alarmOpen]);
  useEffect(() => {
    if (!alarmOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAlarmOpen(false); };
    const inside = (el: HTMLElement | null, t: EventTarget | null) => !!el && el.contains(t as globalThis.Node);
    const onDown = (e: MouseEvent) => { if (!inside(alarmRef.current, e.target) && !inside(panelRef.current, e.target)) setAlarmOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [alarmOpen]);
  const stats = useMemo(() => {
    let healthy = 0, degraded = 0, critical = 0, atRisk = 0, anomalies = 0;
    for (const n of nodes) {
      const d = n.data as unknown as ServiceNode;
      if (d.status === 'healthy') healthy++;
      else if (d.status === 'degraded') degraded++;
      else if (d.status === 'critical') critical++;
      if (d.analytics?.anomalyPersistent) anomalies++;
      if (d.status === 'healthy' && (d.analytics?.failureProbability ?? 0) >= AT_RISK) atRisk++;
    }
    let observed = 0, perMin = 0;
    for (const e of edges) {
      const d = e.data as unknown as DependencyEdge;
      if (!d?.observed) continue;
      observed++;
      perMin += d.activity?.samplesPerMin ?? 0;
    }
    return { total: nodes.length, healthy, degraded, critical, atRisk, anomalies, observed, links: edges.length, perMin };
  }, [nodes, edges]);

  const consistency = useConsistency();

  const presentTypes = useMemo(() => {
    const seen = new Set(nodes.map((n) => (n.data as unknown as ServiceNode).type as string));
    return Object.entries(TYPE_STYLE).filter(([type]) => seen.has(type));
  }, [nodes]);

  const cards: { label: string; value: string | number; sub: string; icon: typeof Server; color: string }[] = [
    { label: 'Services', value: stats.total, sub: `${stats.healthy} healthy`, icon: Server, color: '#8ab4ff' },
    { label: 'Down', value: stats.critical, sub: 'critical right now', icon: ServerCrash, color: stats.critical > 0 ? '#ef5f67' : '#3a3e45' },
    { label: 'Degraded', value: stats.degraded, sub: 'slow or restarting', icon: AlertTriangle, color: stats.degraded > 0 ? '#e8a33d' : '#3a3e45' },
    { label: 'At risk', value: stats.atRisk, sub: `cascade ≥ ${Math.round(AT_RISK * 100)}%`, icon: Radar, color: stats.atRisk > 0 ? '#8ab4ff' : '#3a3e45' },
    { label: 'Live links', value: stats.observed, sub: `of ${stats.links} shown`, icon: Link2, color: '#3ecf8e' },
    { label: 'Link activity', value: formatRate(stats.perMin), sub: 'relative activity index', icon: Activity, color: '#8ab4ff' },
  ];

  return (
    <>
      <div className="scene-panel scene-overview">
        <div className="scene-overview-title">Live overview</div>
        <div className="scene-chip-row">
          <div className="scene-chip" title="Services whose containers are down or crash-looping">
            Down
            <span className={`scene-chip-count ${stats.critical > 0 ? 'hot' : ''}`}>{stats.critical}</span>
          </div>
          <div className="scene-chip" title="Services the ML ensemble has flagged over several scoring windows">
            <Brain size={11} style={{ marginRight: -3 }} /> Anomalies
            <span className={`scene-chip-count ${stats.anomalies > 0 ? 'hot' : ''}`}>{stats.anomalies}</span>
          </div>
          {consistency && (
            <div
              className="scene-chip"
              title={consistency.violations.length === 0
                ? `All ${consistency.rulesChecked} consistency checks pass: shares sum to 100%, weights match their formula, incidents refer to real services, rates are rates.`
                : consistency.violations.slice(0, 8).map((v) => `${v.rule}: ${v.subject}: ${v.detail}`).join('\n')}
              style={{ color: consistency.violations.length === 0 ? '#3ecf8e' : '#f58a90' }}
            >
              {consistency.violations.length === 0 ? '✓ consistent' : `${consistency.violations.length} data issue${consistency.violations.length === 1 ? '' : 's'}`}
            </div>
          )}
        </div>
        <div className="scene-stat-grid">
          {cards.map((c) => {
            const Icon = c.icon;
            return (
              <div key={c.label} className="scene-stat">
                <div className="scene-stat-head">{c.label}</div>
                <div className="scene-stat-body">
                  <span className="scene-stat-icon" style={{ background: c.color, boxShadow: c.color === '#3a3e45' ? 'none' : `0 4px 14px ${c.color}55` }}>
                    <Icon size={15} strokeWidth={2.3} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="scene-stat-value">{c.value}</div>
                    <div className="scene-stat-sub">{c.sub}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="scene-toolbar">
        <div className="scene-pill-group" role="tablist" aria-label="Arrangement">
          {LAYOUTS.filter((opt) => PRIMARY_LAYOUTS.has(opt.id)).map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={opt.id === layout}
              className={`scene-pill ${opt.id === layout ? 'active' : ''}`}
              title={opt.hint}
              onClick={() => onLayout(opt.id)}
            >
              {opt.label}
            </button>
          ))}
          {/* The decorative shapes live behind one control, so the bar fits
              beside the overview panel even with the inspector open. */}
          <select
            className={`scene-pill scene-pill-select ${PRIMARY_LAYOUTS.has(layout) ? '' : 'active'}`}
            value={PRIMARY_LAYOUTS.has(layout) ? '' : layout}
            onChange={(e) => { if (e.target.value) onLayout(e.target.value as LayoutId); }}
            aria-label="More arrangements"
            title={PRIMARY_LAYOUTS.has(layout) ? 'More arrangements' : LAYOUTS.find((l) => l.id === layout)?.hint}
          >
            <option value="">More</option>
            {LAYOUTS.filter((opt) => !PRIMARY_LAYOUTS.has(opt.id)).map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="scene-pill-group" aria-label="Link style">
          <button
            type="button"
            className={`scene-pill ${routing === 'conduit' ? 'active' : ''}`}
            title="Links run in overhead trays at right angles, like cabling in a hall"
            onClick={() => onRouting('conduit')}
          >
            <Waypoints size={12} style={{ verticalAlign: '-2px' }} />
          </button>
          <button
            type="button"
            className={`scene-pill ${routing === 'arc' ? 'active' : ''}`}
            title="Links arc straight across"
            onClick={() => onRouting('arc')}
          >
            <Spline size={12} style={{ verticalAlign: '-2px' }} />
          </button>
          <button
            type="button"
            className={`scene-pill ${showLabels ? 'active' : ''}`}
            title={`Name labels on every service (${nodes.length})`}
            onClick={() => onShowLabels(!showLabels)}
          >
            <Tags size={12} style={{ verticalAlign: '-2px' }} />
          </button>
          <button
            type="button"
            className={`scene-pill ${glow ? 'active' : ''}`}
            title={glow ? 'Neon glow on. Switch off on a slow GPU.' : 'Neon glow off'}
            aria-pressed={glow}
            onClick={() => onGlow(!glow)}
          >
            <Sparkles size={12} style={{ verticalAlign: '-2px' }} />
          </button>
        </div>
      </div>

      <div className="scene-alarm-wrap" ref={alarmRef}>
        <button
          type="button"
          className={`scene-alarm ${alarmTone}`}
          onClick={() => setAlarmOpen((o) => !o)}
          aria-expanded={alarmOpen}
          aria-haspopup="dialog"
          title={alertCount > 0 ? `${alertCount} service${alertCount === 1 ? '' : 's'} need attention. Click to see them.` : 'Nothing needs attention'}
          aria-label={alertCount > 0 ? `${alertCount} alerts, show list` : 'No alerts'}
        >
          {alertCount > 0 ? <BellRing size={19} /> : <Bell size={18} style={{ opacity: 0.6 }} />}
          {alertCount > 0 && <span className="scene-alarm-count">{alertCount}</span>}
        </button>

        {alarmOpen && anchor && createPortal(
          <div
            ref={panelRef}
            className="scene-alarm-panel"
            role="dialog"
            aria-label="What needs attention"
            style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 1100 }}
          >
            <div className="scene-alarm-head">
              <span>Needs attention <b>{alertCount}</b></span>
              {alertCount > 1 && (
                <button type="button" className="scene-alarm-next" onClick={onNextAlert} title="Fly to each in turn">Next ›</button>
              )}
            </div>
            {alertCount === 0 ? (
              <div className="scene-alarm-empty">Nothing needs attention right now.</div>
            ) : (
              <div className="scene-alarm-list">
                {ALERT_GROUPS.map((g) => {
                  const items = alerts.filter((a) => a.kind === g.kind);
                  if (items.length === 0) return null;
                  const Icon = g.icon;
                  return (
                    <div key={g.kind} className="scene-alarm-group">
                      <div className="scene-alarm-group-head" style={{ color: g.color }} title={g.why}>
                        <Icon size={12} /> {g.label} <span>{items.length}</span>
                      </div>
                      {items.map((a) => (
                        <button key={a.id} type="button" className="scene-alarm-item" onClick={() => onAlertSelect(a.id)} title="Select it and fly there">
                          <span className="scene-alarm-dot" style={{ background: g.color, boxShadow: `0 0 6px ${g.color}` }} />
                          <span className="scene-alarm-name">{a.title}<em>{projectOf(a.id)}</em></span>
                          <span className="scene-alarm-why">{a.sub}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="scene-alarm-foot">
              Listed most urgent first. ML flags only appear while the scorer is running; risk is a model estimate, not a measurement.
            </div>
          </div>,
          document.body,
        )}
      </div>

      {zones.length > 1 && (
        <div className="scene-focus" role="tablist" aria-label="Focus on a project">
          <button
            type="button"
            className={`scene-pill ${focusZone === null ? 'active' : ''}`}
            onClick={() => onFocusZone(null)}
          >
            All
          </button>
          {zones.map((z) => (
            <button
              key={z.id}
              type="button"
              className={`scene-pill ${focusZone === z.id ? 'active' : ''}`}
              onClick={() => onFocusZone(z.id)}
              title={`${z.services} services${z.alerts ? ` · ${z.alerts} need attention` : ''}`}
            >
              {z.id}
              <span
                className="scene-focus-dot"
                style={{ background: z.critical > 0 ? '#ef5f67' : z.alerts > 0 ? '#e8a33d' : '#3ecf8e' }}
              />
            </button>
          ))}
        </div>
      )}

      <div className="scene-panel scene-legend">
        {presentTypes.length > 0 && (
          <div>
            <div className="scene-legend-title">Unit</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '0 12px' }}>
              {presentTypes.map(([type, s]) => (
                <div key={type} className="scene-legend-row">
                  <span
                    className="scene-legend-swatch"
                    style={{
                      // Echo the silhouette: tall for cabinets, round for disk
                      // stacks and pipes, wide for routers and screens.
                      width: s.shape === 'router' || s.shape === 'screen' ? 11 : s.shape === 'rack' ? 6 : 8,
                      height: s.shape === 'rack' ? 10 : s.shape === 'router' ? 5 : 8,
                      borderRadius: s.shape === 'storage' || s.shape === 'pipe' ? '50%' : 2,
                      background: s.color,
                    }}
                  />
                  {s.label}
                </div>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="scene-legend-title">Status light</div>
          {(['healthy', 'degraded', 'critical'] as const).map((s) => (
            <div key={s} className="scene-legend-row">
              <span className="scene-legend-swatch" style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_LIGHT[s], boxShadow: `0 0 6px ${STATUS_LIGHT[s]}` }} />
              {s === 'critical' ? 'down (pinned)' : s}
            </div>
          ))}
          <div className="scene-legend-row">
            <span className="scene-legend-swatch" style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #e8a33d' }} />
            at risk (ring)
          </div>
        </div>
        <div>
          <div className="scene-legend-title">Link</div>
          {[
            ['#2f9e6f', 'calm'],
            ['#3ecf8e', 'busy'],
            ['#4fdc9c', 'heavy'],
            ['#7fe8b8', 'very heavy'],
            ['#e8a33d', 'slow / erroring'],
            ['#ef5f67', 'failing'],
          ].map(([color, label]) => (
            <div key={label} className="scene-legend-row">
              <span className="scene-legend-swatch" style={{ width: 14, height: 3, background: color, boxShadow: `0 0 5px ${color}` }} />
              {label}
            </div>
          ))}
          <div className="scene-legend-row" style={{ color: 'var(--color-text-dim)' }}>thickness = reliance</div>
          <div className="scene-legend-row" style={{ color: 'var(--color-text-dim)' }} title="Requests per second where a request-level source measures the link; socket activity otherwise">pulses = rate per second</div>
        </div>
      </div>
    </>
  );
}
