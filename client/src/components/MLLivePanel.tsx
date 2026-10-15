import { useEngineStatus } from '../hooks/useEngineStatus';

const clean = (id: string) => id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;

/** Live view of the ML engine: what each service's forests say right now and where the random walk puts the blame. */
export function MLLivePanel({ selectedProject }: { selectedProject?: string | null }) {
  const { mode, targets } = useEngineStatus();
  const shown = targets.filter((t) => !selectedProject || t.targetId === selectedProject);
  const h3: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.005em' };
  const sub: React.CSSProperties = { fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.5 };
  const th: React.CSSProperties = { textAlign: 'left', fontWeight: 500, fontSize: 11.5, color: 'var(--color-text-dim)', padding: '6px 8px 6px 0' };
  const td: React.CSSProperties = { padding: '7px 8px 7px 0', fontSize: 12.5, borderTop: '1px solid var(--color-border)', fontVariantNumeric: 'tabular-nums' };
  const tone = (v: number) => (v >= 1 ? 'var(--color-degraded)' : 'var(--color-text-main)');

  if (mode !== 'ml' && mode !== 'hybrid') {
    return (
      <section className="mm-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={h3}>ML engine</h3>
        <div style={sub}>Switch the engine to ML in the top bar to see what each service has learned and how the random walk ranks the root cause.</div>
      </section>
    );
  }
  return (
    <section className="mm-card" style={{ padding: 20, marginBottom: 16, marginTop: 16 }}>
      <h3 style={h3}>{mode === 'hybrid' ? 'What the hybrid engine sees' : 'What the ML engine sees'}</h3>
      <div style={sub}>
        Every service has two Isolation Forests trained on its own recent normal readings. Level 0 is typical, 1 is that service's alarm line.
        Own = CPU, memory, throttling (a dependency cannot cause these). Symptom = traffic, errors, latency (can be inherited).
        Blame = share of the random walk over the call graph. A container that is down, stopped or crash-looping is a fact and goes first.
      </div>
      {!shown.length && <div style={{ ...sub, marginTop: 12 }}>No readings yet.</div>}
      {shown.map((t) => (
        <div key={t.targetId} style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>
            <b style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>{t.targetId}</b> · learned {t.learnedServices} of {t.services} services{t.ready ? '' : ` · each needs about ${t.needReadings} readings first`}
            {mode === 'hybrid' && typeof t.rulesTop === 'number' && <> · rule engine: strongest service at {t.rulesTop.toFixed(1)}× its line (alarms on its own above 1.25×)</>}
          </div>
          {!!t.warnings?.length && (
            <div style={{ fontSize: 12.5, margin: '8px 0', padding: '8px 10px', borderRadius: 8, background: 'var(--color-degraded-glow)', color: 'var(--color-text-main)' }}>
              <b style={{ fontWeight: 550 }}>Early warning</b> (trend forecast): {t.warnings.map((w) => `${clean(w.id)} ${w.feature} heading over its line${w.inSec !== null ? ` in about ${w.inSec} s` : ''}`).join('; ')}
            </div>
          )}
          {!!t.cascade?.length && (
            <div style={{ fontSize: 12.5, margin: '8px 0', color: 'var(--color-text-muted)' }}>
              <b style={{ fontWeight: 550, color: 'var(--color-text-main)' }}>Likely next</b> (learned from how trouble spread here before): {t.cascade.map((c) => `${clean(c.id)} ${Math.round(c.risk * 100)}%`).join(', ')}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Service</th><th style={th}>Baseline</th><th style={th}>Own</th><th style={th}>Symptom</th><th style={{ ...th, width: '34%' }}>Blame</th></tr></thead>
            <tbody>
              {t.detail.slice(0, 12).map((r) => (
                <tr key={r.id}>
                  <td style={{ ...td, color: r.hard ? 'var(--color-critical)' : undefined, fontWeight: r.hard ? 550 : 400 }}>{clean(r.id)}{r.fact ? <span style={{ color: 'var(--color-critical)', fontWeight: 400 }}> · {r.fact}</span> : null}</td>
                  <td style={{ ...td, color: 'var(--color-text-muted)' }}>{r.ready ? 'learned' : 'learning'}</td>
                  <td style={{ ...td, color: tone(r.own) }}>{r.own.toFixed(1)}</td>
                  <td style={{ ...td, color: tone(r.symptom) }}>{r.symptom.toFixed(1)}</td>
                  <td style={td}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 36px', gap: 8, alignItems: 'center' }}>
                      <div style={{ height: 6, borderRadius: 3, background: 'var(--color-border)' }}>
                        <div style={{ width: `${Math.round(r.walk * 100)}%`, height: 6, borderRadius: 3, background: r.hard ? 'var(--color-critical)' : 'var(--color-accent-blue)' }} />
                      </div>
                      <span style={{ textAlign: 'right' }}>{Math.round(r.walk * 100)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
