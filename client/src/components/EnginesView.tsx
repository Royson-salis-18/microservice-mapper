import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { PageShell, PageHeader, Panel, Stat, StatRow, EmptyNote } from './ui/Panel';
import { useEngineMode, type EngineMode } from '../hooks/useEngineMode';
import { AgreementStrip, BlameChart, ChartCard, PeaksChart, ServiceBars, ServiceTrail, SourceVictimScatter, type TrailPoint } from './EngineCharts';

/**
 * Detection engines: what each of Rules, ML and Hybrid is, how each is configured, what each is doing on the
 * readings arriving right now, and how each scored offline. The top-bar switch changes which engine decides;
 * this page is where you can see that it does, and why.
 */

interface Verdict { alarm: boolean; peak: number; suspects: { id: string; score: number; fact?: string; why?: string }[] }
interface ServiceRow { id: string; rules: number; level: number; own: number; symptom: number; walk: number; blend: number; hard: boolean; fact?: string }
interface Shadow {
  workload?: { change: number; services: number; shifted: boolean } | null;
  moments: number; rulesHot: number; mlHot: number; hybridHot: number; at: string;
  engines: { rules: Verdict; ml: Verdict; hybrid: Verdict };
  services: ServiceRow[];
  history: { t: number; rules: number; ml: number; hybrid: number }[];
  trail?: Record<string, TrailPoint[]>;
}
interface Target {
  targetId: string; ready: boolean; learnedServices: number; services: number; needReadings: number; shadow: Shadow | null;
  warnings?: { id: string; feature: string; inSec: number | null }[]; cascade?: { id: string; risk: number }[];
}
interface Tally { incidents: number; since: string; last: { at: string; target: string; root: string | null; severity: string } | null }
interface EngineScore { detected: number; top1OfDetected: number; caughtAndNamed: number; falseAlarmsPerHour: number; alarmShare: number }
interface Info {
  mode: EngineMode;
  status: { targets: Target[] } | null;
  tally: Record<EngineMode, Tally> | null;
  config: {
    rules: { line: number; thresholds: Record<string, number>; docs: Record<string, string> };
    ml: Record<string, any> & { baseline: Record<string, any>; load: Record<string, any> & { prior: number[] }; walk: Record<string, number> };
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
    id: 'ml', name: 'ML', tag: 'Load-aware baseline + random walk',
    decides: 'The work all services share (the load) is estimated and explained away. Each service is then compared with its own recent normal readings, adjusted for that load. A service alarms when a signal stays well above what the load predicts for two cycles in a row.',
    names: 'A random walk over the call graph shares the blame, so a service that only suffers because of its dependency scores low. A change of workload alone raises no alarm.',
    good: 'Fewest false alarms and the best at naming the true source.',
    weak: 'Needs about 30 readings per service before it judges anything, and only alarms on container facts until then. A fault that happens during a big load change can be masked.',
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
  ['Model', 'Each service is judged against its own recent normal readings, after the load every service shares is taken out. No labels, nothing installed on the host.', () => 'load-aware residual'],
  ['Workload', 'The median shift of the signals that carry traffic (network, requests, CPU) over all busy services. A fault in a few services cannot move a median.', () => 'median of busy services'],
  ['Load response', 'Each signal is tried as ignoring the load and as following it with the slope the project shows; it is unusual only if neither explains it.', (c) => `slope prior ${c.load.prior[2]}, learned (ridge ${c.load.ridge})`],
  ['Training window', 'Recent normal readings each service learns from (one reading about every 5 s).', (c) => `${c.load.window} readings`],
  ['Slow reference', 'The median of this many recent readings is what a shift is measured from, so a short quiet spell does not move it.', (c) => `${c.load.slow} readings`],
  ['Readings before judging', 'A service is not judged until it has this many readings.', (c) => `${c.load.minTrain} readings`],
  ['Alarm line', 'Robust spreads from the load-adjusted median that count as level 1. The spread is at least the distance to the 90th percentile, so bursty signals are not scored as if they were Gaussian.', (c) => `${c.load.zLine} spreads`],
  ['Alarm level', 'Level at which a service counts as alarming (1 is the line).', (c) => String(c.alarmLevel)],
  ['Persistence', 'Cycles in a row a service must stay above the line.', (c) => String(c.servicePersist)],
  ['Direction', 'Only increases in CPU, memory, errors, latency and throttling count as trouble; traffic counts both ways.', (c) => (c.load.oneSided ? 'one-sided' : 'two-sided')],
  ['Drift', 'The baseline follows a new normal after this many readings above the line (a mild shift after 24).', (c) => `${c.load.driftAfter} readings`],
  ['Random walk restart', 'Share of probability that restarts at the anomalous services; higher stays local.', (c) => String(c.walk.alpha)],
  ['Early warning', 'A trend forecast flags a signal heading over its line, when the fit is at least this good.', (c) => `R² ≥ ${c.load.forecastR2}`],
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

const COLORS = { rules: '#e8a33d', ml: '#8ab4ff', hybrid: '#3ecf8e' } as const;

function EngineColumn({ id, name, active, v: raw, warnings, next, hot, moments }: { id: EngineMode; name: string; active: boolean; v: Verdict; warnings?: Target['warnings']; next?: Target['cascade']; hot: number; moments: number }) {
  const col = COLORS[id];
  const forecasts = id !== 'rules';
  // a service at zero is not a suspect: listing it would rank noise
  const v: Verdict = { ...raw, suspects: raw.suspects.filter((x) => x.score >= 0.005) };
  return (
    <div style={{ padding: 14, borderRadius: 10, border: `1px solid ${active ? col : 'var(--color-border)'}`, background: 'rgba(255,255,255,.015)', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <i className="mm-dot" style={{ background: col }} /><b style={{ fontSize: 14 }}>{name}</b>
        {active && <span style={{ fontSize: 11, ...muted }}>active</span>}
        <span className="mm-chip" style={{ marginLeft: 'auto', color: v.alarm ? 'var(--color-critical)' : 'var(--color-text-muted)', borderColor: v.alarm ? 'rgba(239,95,103,.4)' : undefined }}>{v.alarm ? 'ALARM' : 'quiet'}</span>
      </div>

      <div>
        <div className="mm-eyebrow">Detected</div>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          {v.alarm
            ? <>Something is wrong. Most likely source: <b>{v.suspects[0] ? clean(v.suspects[0].id) : 'unclear'}</b>{v.suspects[0]?.fact ? <span style={{ color: 'var(--color-critical)' }}> ({v.suspects[0].fact})</span> : null}{v.suspects[0]?.why ? <span style={muted}> · {v.suspects[0].why}</span> : null}</>
            : <span style={muted}>Nothing over the line on two cycles in a row.</span>}
        </div>
        <div style={{ fontSize: 11.5, marginTop: 4, ...muted }}>Peak {v.peak.toFixed(2)}× its line · over the line on {hot} of {moments} cycles ({moments ? pct(hot / moments) : '0%'})</div>
      </div>

      <div>
        <div className="mm-eyebrow">Computed: ranked suspects</div>
        {!v.suspects.length ? <div style={{ fontSize: 12.5, marginTop: 4, ...muted }}>Every service is at zero.</div> : (
          <div style={{ marginTop: 6, display: 'grid', gap: 5 }}>
            {v.suspects.map((x, i) => (
              <div key={x.id} style={{ display: 'grid', gridTemplateColumns: '18px minmax(60px,1fr) minmax(50px,90px) 44px', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                <span style={muted}>{i + 1}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: i === 0 ? 600 : 400 }}>{clean(x.id)}</span>
                <Bar value={x.score} max={id === 'ml' ? 1 : Math.max(2, v.suspects[0].score)} color={col} />
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{id === 'ml' ? pct(x.score) : `${x.score.toFixed(2)}×`}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, marginTop: 6, ...muted }}>{id === 'ml' ? 'Share of the random-walk blame over the call graph.' : id === 'rules' ? 'Rule score against the rule line.' : 'Ranked by the ML blame (container facts first); the number is the fused rules + ML score.'}</div>
      </div>

      <div>
        <div className="mm-eyebrow">Predicted</div>
        {!forecasts ? <div style={{ fontSize: 12.5, marginTop: 4, ...muted }}>Nothing. Rules compare the present with the past and do not forecast.</div> : (
          <div style={{ fontSize: 12.5, marginTop: 4, display: 'grid', gap: 4 }}>
            {warnings?.length ? warnings.map((w) => <div key={w.id + w.feature}>Early warning: <b>{clean(w.id)}</b> {w.feature} heading over its line{w.inSec !== null ? ` in about ${w.inSec} s` : ''}</div>) : <div style={muted}>No metric is trending over its line.</div>}
            {next?.length ? <div>Likely next to be hit: {next.map((c) => `${clean(c.id)} ${pct(c.risk)}`).join(', ')}</div> : <div style={muted}>No service has a cascade risk above 50%.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function ParallelTarget({ t, mode }: { t: Target; mode: EngineMode | null }) {
  const s = t.shadow;
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12, marginBottom: 8, ...muted }}>
        <b style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>{t.targetId}</b> · ML has learned {t.learnedServices} of {t.services} services
        {t.ready ? '' : ` · each needs about ${t.needReadings} readings first, until then only container facts count for ML`}
        {s?.at ? ` · updated ${new Date(s.at).toLocaleTimeString()}` : ''}
        {s?.workload && (
          <span className="mm-chip" style={{ marginLeft: 8, color: s.workload.shifted ? 'var(--color-accent-blue)' : undefined }}
            title="The change of load all busy services share, measured against their own recent median. ML explains it away instead of judging it.">
            {s.workload.shifted ? `workload moved: traffic ×${s.workload.change.toFixed(2)}, explained, not a fault` : 'workload steady'}
          </span>
        )}
      </div>
      {!s?.engines ? <div style={{ fontSize: 12.5, ...muted }}>Waiting for the first reading.</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <EngineColumn id="rules" name="Rules" active={mode === 'rules'} v={s.engines.rules} hot={s.rulesHot} moments={s.moments} />
            <EngineColumn id="ml" name="ML" active={mode === 'ml'} v={s.engines.ml} warnings={t.warnings} next={t.cascade} hot={s.mlHot} moments={s.moments} />
            <EngineColumn id="hybrid" name="Hybrid" active={mode === 'hybrid'} v={s.engines.hybrid} warnings={t.warnings} next={t.cascade} hot={s.hybridHot} moments={s.moments} />
          </div>
          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
            <ChartCard title="Peak against the alarm line" about="Each engine's strongest service, cycle by cycle; 1.0 is the line. Enlarge to zoom into a stretch of time."
              render={(x) => <PeaksChart history={s.history} expanded={x} />} />
            <ChartCard title="Where the engines agree" about="One cell per cycle, lit when that engine was over its line. Hover a cell for its time and value."
              render={(x) => <AgreementStrip history={s.history} expanded={x} />} />
            <ChartCard title="Every service, every engine" about="Rules, ML level and Hybrid score per service against the same line. Click a service to follow it."
              render={(x) => <ServiceBars rows={s.services} expanded={x} onPick={setPicked} picked={picked} />} />
            <ChartCard title="Source or victim" about="ML's two forests per service: high own level points at a source, high symptoms alone at a victim. Dot size is the walk blame."
              render={(x) => <SourceVictimScatter rows={s.services} expanded={x} onPick={setPicked} />}
              footer={<>red: container fact · amber: own resources over the line · blue: symptoms over the line · grey: calm</>} />
            <ChartCard title="Who the random walk blames" about="Share of the blame over the call graph right now; the top one is ML's named source."
              render={(x) => <BlameChart rows={s.services} expanded={x} onPick={setPicked} />} />
            <ChartCard title="Follow one service" about="What each engine made of one service over the last cycles. Pick it here or click it in any chart."
              render={(x) => <ServiceTrail trail={s.trail ?? {}} ids={s.services.map((r) => r.id)} picked={picked} onPick={setPicked} expanded={x} />} />
          </div>
          <div style={{ marginTop: 16, overflowX: 'auto' }}>
            <div className="mm-eyebrow" style={{ marginBottom: 6 }}>Every service, every engine</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Service</th><th style={th}>Rules (× line)</th><th style={th}>ML level (own / symptom)</th><th style={th}>ML blame</th><th style={th}>Hybrid score</th></tr></thead>
              <tbody>
                {s.services.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...td, fontWeight: r.hard ? 600 : 400, color: r.hard ? 'var(--color-critical)' : undefined }}>{clean(r.id)}{r.fact ? <span style={{ fontWeight: 400 }}> · {r.fact}</span> : null}</td>
                    <td style={{ ...td, color: r.rules >= 1 ? COLORS.rules : undefined }}>{r.rules.toFixed(2)}</td>
                    <td style={{ ...td, color: r.level >= 1 ? COLORS.ml : undefined }}>{r.level.toFixed(2)} <span style={muted}>({r.own.toFixed(1)} / {r.symptom.toFixed(1)})</span></td>
                    <td style={td}>{pct(r.walk)}</td>
                    <td style={{ ...td, color: r.blend >= 1 ? COLORS.hybrid : undefined }}>{r.blend.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
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

      <Panel title="All three engines, in parallel" subtitle="Computed together on every cycle, whichever one is active"
        about="Every cycle the server steps the ML engine and scores the same readings with the rules and with the fused rule. Peak is the strongest service against that engine's own alarm line: 1.0 is exactly the line. An engine alarms when it is over its line on two cycles in a row. The columns show what each detected, what it computed (its ranked suspects) and what it predicts.">
        {!targets.length && <EmptyNote>No readings yet. Once a project is sending telemetry this fills in.</EmptyNote>}
        {targets.map((t) => <ParallelTarget key={t.targetId} t={t} mode={mode} />)}
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
