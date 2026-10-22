import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { PageShell, PageHeader, Panel, Stat, StatRow, EmptyNote } from './ui/Panel';
import { useEngineMode, type EngineMode } from '../hooks/useEngineMode';

/**
 * Detection engines: what each of Rules, ML and Hybrid is, how each is configured, what each is doing on the
 * readings arriving right now, and how each scored offline. The top-bar switch changes which engine decides;
 * this page is where you can see that it does, and why.
 */

interface Shadow {
  moments: number; rulesHot: number; mlHot: number; hybridHot: number;
  now: { rulesTop: number; mlTop: number; hybridMax: number; rulesRanked: string[]; mlRanked: string[]; hybridRanked: string[] };
}
interface Target { targetId: string; ready: boolean; learnedServices: number; services: number; needReadings: number; shadow: Shadow | null; warnings?: { id: string; feature: string; inSec: number | null }[] }
interface Tally { incidents: number; since: string; last: { at: string; target: string; root: string | null; severity: string } | null }
interface EngineScore { detected: number; top1OfDetected: number; caughtAndNamed: number; falseAlarmsPerHour: number; alarmShare: number }
interface Info {
  mode: EngineMode;
  status: { targets: Target[] } | null;
  tally: Record<EngineMode, Tally> | null;
  config: {
    rules: { line: number; thresholds: Record<string, number>; docs: Record<string, string> };
    ml: Record<string, any> & { baseline: Record<string, any>; walk: Record<string, number> };
    hybrid: { detection: string; ranking: string; rulesAlone: number; mlWeight: number };
  };
  offline: { note: string; sets: Record<string, { label: string; faults: number; hours: number; engines: Record<EngineMode, EngineScore> }> } | null;
}

const clean = (id: string) => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const muted: CSSProperties = { color: 'var(--color-text-muted)' };
const th: CSSProperties = { textAlign: 'left', fontWeight: 500, fontSize: 11.5, color: 'var(--color-text-dim)', padding: '6px 12px 6px 0' };
const td: CSSProperties = { padding: '8px 12px 8px 0', fontSize: 12.5, borderTop: '1px solid var(--color-border)', fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' };

const ENGINES: { id: EngineMode; name: string; tag: string; decides: string; names: string; good: string; weak: string }[] = [
  {
    id: 'rules', name: 'Rules', tag: 'Statistical detector',
    decides: 'Each metric is compared with the service\'s own recent history. A service alarms when its deviation score passes the rule line.',
    names: 'Ranks causes by evidence and call-graph position.',
    good: 'Quick on sharp, loud faults. Easy to explain: every alarm is a number against a threshold.',
    weak: 'The most false alarms, and it often blames a victim instead of the source.',
  },
  {
    id: 'ml', name: 'ML', tag: 'Isolation Forest + random walk',
    decides: 'Every service gets two Isolation Forests trained on its own recent normal readings: one for its own resources, one for its symptoms. A service alarms when either stays above its learned line for two cycles in a row.',
    names: 'A random walk over the call graph shares the blame, so a service that only suffers because of its dependency scores low.',
    good: 'Fewest false alarms and the best at naming the true source.',
    weak: 'Needs about 30 readings per service before it judges anything, and only alarms on container facts until then.',
  },
  {
    id: 'hybrid', name: 'Hybrid', tag: 'Both, ML names the source',
    decides: 'An alarm is raised if ANY of these holds: the ML engine alarms, the rule engine reaches 1.25 times its line, or a container is stopped, paused or crash-looping.',
    names: 'The ML engine, so the source is chosen by the random walk, with container facts first.',
    good: 'Catches what either engine catches, and names the source as well as ML does.',
    weak: 'Alarms more often than ML alone, because the rule engine can trigger it too.',
  },
];

const ML_DOCS: [string, string, (c: Info['config']['ml']) => string][] = [
  ['Forests per service', 'One for own resources (CPU, memory, throttling), one for symptoms (traffic, errors, latency, network).', () => '2 × isolation forest'],
  ['Trees per forest', 'More trees give a steadier score.', (c) => String(c.baseline.trees)],
  ['Training window', 'Recent normal readings each forest learns from (one reading about every 5 s).', (c) => `${c.baseline.window} readings`],
  ['Readings before judging', 'A service is not judged until it has this many readings.', (c) => `${c.baseline.minTrain} readings`],
  ['Retrain every', 'How often each forest is refitted on the sliding window.', (c) => `${c.baseline.retrainEvery} readings`],
  ['Alarm line', 'Share of the service\'s own normal readings that fall below this score. Level 1 means exactly at the line.', (c) => `${pct(c.baseline.quantile)} quantile`],
  ['Alarm level', 'Level at which a service counts as alarming (1 is the line).', (c) => String(c.alarmLevel)],
  ['Persistence', 'Cycles in a row a service must stay above the line.', (c) => String(c.servicePersist)],
  ['Direction', 'Only increases in CPU, memory, errors and latency count as trouble; traffic counts both ways.', (c) => (c.baseline.oneSided ? 'one-sided' : 'two-sided')],
  ['Drift', 'Baseline slowly follows a new normal after this many readings above the line.', (c) => `${c.baseline.driftAfter} readings`],
  ['Random walk restart', 'Share of probability that restarts at the anomalous services; higher stays local.', (c) => String(c.walk.alpha)],
  ['Early warning', 'A trend forecast flags a metric heading over its line, when the fit is at least this good.', (c) => `R² ≥ ${c.baseline.forecastR2}`],
];

function useInfo(everyMs = 4000) {
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => fetch('/api/engine/info').then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => { setInfo(d); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => { load(); const t = setInterval(load, everyMs); return () => clearInterval(t); }, [load, everyMs]);
  return { info, failed, reload: load };
}

function Bar({ value, max = 1, color = 'var(--color-accent-blue)' }: { value: number; max?: number; color?: string }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--color-border)', minWidth: 80 }}>
      <div style={{ width: `${Math.min(100, Math.max(0, (value / max) * 100))}%`, height: 6, borderRadius: 3, background: color }} />
    </div>
  );
}

export function EnginesView({ selectedProject }: { selectedProject?: string }) {
  const { info, failed, reload } = useInfo();
  const engine = useEngineMode();
  const mode = info?.mode ?? engine.mode;
  const targets = (info?.status?.targets ?? []).filter((t) => !selectedProject || selectedProject === 'ALL' || t.targetId === selectedProject);

  const choose = async (m: EngineMode) => { await engine.change(m); reload(); };

  return (
    <PageShell>
      <PageHeader title="Detection engines" scope={selectedProject}>
        Three ways to decide that something is wrong. Pick one in the top bar or here, and see below what it is doing.
      </PageHeader>

      {failed && !info && <EmptyNote>The server did not answer. Start it and this page fills in.</EmptyNote>}

      <Panel title="Which engine is deciding" subtitle={mode ? `Active: ${ENGINES.find((e) => e.id === mode)?.name}` : undefined}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          {ENGINES.map((e) => {
            const on = mode === e.id;
            const t = info?.tally?.[e.id];
            return (
              <div key={e.id} style={{ padding: 14, borderRadius: 10, border: `1px solid ${on ? 'rgba(138,180,255,.5)' : 'var(--color-border)'}`, background: on ? 'rgba(138,180,255,.06)' : 'rgba(255,255,255,.015)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <b style={{ fontSize: 15 }}>{e.name}</b>
                  <span style={{ fontSize: 11.5, ...muted }}>{e.tag}</span>
                  {on && <span className="mm-chip" style={{ marginLeft: 'auto' }}>active</span>}
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.55 }}><b style={{ fontWeight: 550 }}>Decides.</b> <span style={muted}>{e.decides}</span></div>
                <div style={{ fontSize: 12.5, lineHeight: 1.55 }}><b style={{ fontWeight: 550 }}>Names the source.</b> <span style={muted}>{e.names}</span></div>
                <div style={{ fontSize: 12.5, lineHeight: 1.55 }}><b style={{ fontWeight: 550 }}>Strength.</b> <span style={muted}>{e.good}</span></div>
                <div style={{ fontSize: 12.5, lineHeight: 1.55 }}><b style={{ fontWeight: 550 }}>Weakness.</b> <span style={muted}>{e.weak}</span></div>
                <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, ...muted }}>
                  <span>{t ? `${t.incidents} incident${t.incidents === 1 ? '' : 's'} opened under it since the server started` : ''}</span>
                  {!on && <button className="mm-btn" style={{ marginLeft: 'auto' }} disabled={engine.busy} onClick={() => choose(e.id)}>Use {e.name}</button>}
                </div>
                {t?.last && <div style={{ fontSize: 11.5, ...muted }}>Last: {clean(t.last.root ?? 'no single cause')} on {t.last.target}, {t.last.severity.toLowerCase()}, {new Date(t.last.at).toLocaleTimeString()}</div>}
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="What Hybrid means" subtitle="Either engine can raise the alarm. ML names the source.">
        <div style={{ fontSize: 13, lineHeight: 1.65, ...muted }}>
          <p style={{ margin: '0 0 8px' }}>
            Rules and ML fail in different ways. Rules react fast to loud faults but also fire on ordinary noise, and often blame a service that is only
            suffering. ML ignores noise it has seen before and is good at finding the source, but it has to learn each service first.
          </p>
          <p style={{ margin: '0 0 8px', color: 'var(--color-text-main)' }}>
            <b>Alarm</b> = ML alarms &nbsp;OR&nbsp; rules reach {info?.config.hybrid.rulesAlone ?? 1.25}× their line &nbsp;OR&nbsp; a container is down, paused or crash-looping.
            <br /><b>Source</b> = container facts first, then the ML random walk over the call graph.
          </p>
          <p style={{ margin: 0 }}>
            Rules alone must reach {info?.config.hybrid.rulesAlone ?? 1.25}× their usual line, not 1×, so that Hybrid does not inherit all of the rule engine&apos;s false alarms.
            The value was chosen from a sweep on recorded runs; the table at the bottom shows how Hybrid scored.
          </p>
        </div>
      </Panel>

      <Panel title="The three engines on the same readings, right now" subtitle="Live, from this server"
        about="While the ML or Hybrid engine is active, the server also scores each moment with the rule engine and the fused rule, so you can see what each would have said. Peak is the strongest service against its own alarm line: 1.0 means exactly at the line. Over the line is the share of cycles since the server started in which that engine alone was above it.">
        {mode === 'rules' && <EmptyNote>The rule engine is active, so only it is running. Switch to ML or Hybrid to see the three side by side.</EmptyNote>}
        {mode !== 'rules' && !targets.length && <EmptyNote>No readings yet. Once a project is sending telemetry this fills in.</EmptyNote>}
        {mode !== 'rules' && targets.map((t) => {
          const s = t.shadow;
          return (
            <div key={t.targetId} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, marginBottom: 6, ...muted }}>
                <b style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>{t.targetId}</b> · ML has learned {t.learnedServices} of {t.services} services
                {t.ready ? '' : ` · each needs about ${t.needReadings} readings first, until then only container facts count`}
              </div>
              {!s ? <div style={{ fontSize: 12.5, ...muted }}>Waiting for the first reading.</div> : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Engine</th><th style={th}>Peak vs its line</th><th style={th}>Would alarm now</th><th style={th}>Names as source</th><th style={th}>Over the line, all cycles</th></tr></thead>
                  <tbody>
                    {([['Rules', s.now.rulesTop, 1, s.now.rulesRanked, s.rulesHot], ['ML', s.now.mlTop, 1, s.now.mlRanked, s.mlHot], ['Hybrid', s.now.hybridMax, 1, s.now.hybridRanked, s.hybridHot]] as const).map(([name, peak, line, ranked, hot]) => (
                      <tr key={name}>
                        <td style={{ ...td, fontWeight: 550 }}>{name}{mode === name.toLowerCase() ? <span style={{ ...muted, fontWeight: 400 }}> · active</span> : ''}</td>
                        <td style={td}>
                          <div style={{ display: 'grid', gridTemplateColumns: '44px minmax(80px,1fr)', gap: 8, alignItems: 'center' }}>
                            <span>{peak.toFixed(2)}×</span><Bar value={peak} max={Math.max(2, peak)} color={peak >= line ? 'var(--color-degraded)' : 'var(--color-accent-blue)'} />
                          </div>
                        </td>
                        <td style={{ ...td, color: peak >= line ? 'var(--color-degraded)' : 'var(--color-text-muted)' }}>{peak >= line ? 'yes' : 'no'}</td>
                        <td style={td}>{ranked.length && peak >= line ? ranked.map(clean).join(', ') : <span style={muted}>nobody (nothing over the line)</span>}</td>
                        <td style={td}>{hot} of {s.moments} <span style={muted}>({s.moments ? pct(hot / s.moments) : '0%'})</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!!t.warnings?.length && (
                <div style={{ fontSize: 12.5, margin: '8px 0 0', padding: '8px 10px', borderRadius: 8, background: 'var(--color-degraded-glow)' }}>
                  <b style={{ fontWeight: 550 }}>Early warning</b> (ML trend forecast): {t.warnings.map((w) => `${clean(w.id)} ${w.feature} heading over its line${w.inSec !== null ? ` in about ${w.inSec} s` : ''}`).join('; ')}
                </div>
              )}
            </div>
          );
        })}
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Panel title="Rules configuration" subtitle="Rule-based, no model involved">
          {info && (
            <>
              <StatRow>
                <Stat label="Rule line" value={info.config.rules.line} sub="deviation score that counts as an alarm" />
                <Stat label="Hybrid trigger" value={`${info.config.hybrid.rulesAlone}×`} sub="rules alone alarm Hybrid above this" />
              </StatRow>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
                <thead><tr><th style={th}>Setting</th><th style={th}>Value</th><th style={th}>Meaning</th></tr></thead>
                <tbody>
                  {Object.entries(info.config.rules.thresholds).map(([k, v]) => (
                    <tr key={k}><td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{k}</td><td style={td}>{String(v)}</td><td style={{ ...td, ...muted }}>{info.config.rules.docs[k] ?? ''}</td></tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 11.5, marginTop: 10, ...muted }}>These can be changed on the Incidents page under Detection rules.</div>
            </>
          )}
        </Panel>

        <Panel title="ML configuration" subtitle="Learned per service, from its own readings">
          {info && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Setting</th><th style={th}>Value</th><th style={th}>Meaning</th></tr></thead>
              <tbody>
                {ML_DOCS.map(([label, doc, val]) => (
                  <tr key={label}><td style={{ ...td, fontWeight: 550 }}>{label}</td><td style={td}>{val(info.config.ml)}</td><td style={{ ...td, ...muted }}>{doc}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="How each engine scored offline" subtitle="Recorded runs with injected faults, not this server's own history"
        about={info?.offline?.note}>
        {!info?.offline && <EmptyNote>The evaluation summary is not shipped with this build.</EmptyNote>}
        {info?.offline && Object.entries(info.offline.sets).map(([key, set]) => (
          <div key={key} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, marginBottom: 6, ...muted }}><b style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>{set.label}</b> · {set.faults} faults over {set.hours.toFixed(1)} h</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Engine</th><th style={th}>Faults detected</th><th style={th}>True source ranked first</th><th style={th}>Detected and named</th><th style={th}>False alarms per hour</th></tr></thead>
              <tbody>
                {(['rules', 'ml', 'hybrid'] as const).map((id) => {
                  const r = set.engines[id];
                  const best = (f: (x: EngineScore) => number, low = false) => { const v = (['rules', 'ml', 'hybrid'] as const).map((k) => f(set.engines[k])); return f(r) === (low ? Math.min(...v) : Math.max(...v)); };
                  const cell = (v: number, text: string, win: boolean, max = 1) => (
                    <div style={{ display: 'grid', gridTemplateColumns: '46px minmax(70px,1fr)', gap: 8, alignItems: 'center', fontWeight: win ? 600 : 400 }}>
                      <span>{text}</span><Bar value={v} max={max} color={win ? 'var(--color-healthy)' : 'var(--color-accent-blue)'} />
                    </div>
                  );
                  return (
                    <tr key={id}>
                      <td style={{ ...td, fontWeight: 550 }}>{ENGINES.find((e) => e.id === id)?.name}</td>
                      <td style={td}>{cell(r.detected, pct(r.detected), best((x) => x.detected))}</td>
                      <td style={td}>{cell(r.top1OfDetected, pct(r.top1OfDetected), best((x) => x.top1OfDetected))}</td>
                      <td style={td}>{cell(r.caughtAndNamed, pct(r.caughtAndNamed), best((x) => x.caughtAndNamed))}</td>
                      <td style={td}>{cell(r.falseAlarmsPerHour, r.falseAlarmsPerHour.toFixed(1), best((x) => x.falseAlarmsPerHour, true), 10)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        <div style={{ fontSize: 12, ...muted }}>Green marks the best of the three in each column. Hybrid has the best detected-and-named score; ML has the fewest false alarms.</div>
      </Panel>
    </PageShell>
  );
}
