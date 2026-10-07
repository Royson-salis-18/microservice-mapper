import { useState, useEffect, useCallback } from 'react';

/**
 * The rules that decide what becomes an incident, shown where incidents are.
 *
 * These numbers used to be literals inside AnomalyDetector — a z-score of
 * 2.5, an absolute 85%, a 30-point jump on a flat baseline — so the honest
 * answer to "why did this fire?" was "read the source". They are editable
 * here because the right value depends on the target: a 909MB box that sits
 * pinned at 90% CPU needs different bounds from one that idles at 2%.
 *
 * Nothing on this panel touches the ML pipeline. Incidents are rule-based on
 * purpose — they have to fire on a service discovered a minute ago, on a
 * target whose models were never trained, while the scorer is stopped. What
 * the models think lives under Findings.
 */

interface ThresholdPayload {
  values: Record<string, number>;
  defaults: Record<string, number>;
  limits: Record<string, [number, number]>;
  docs: Record<string, string>;
}

/** Grouped so the panel reads as rules, not as a wall of numbers. */
const GROUPS: { title: string; note: string; keys: string[] }[] = [
  {
    title: 'How far from normal counts',
    note: 'Deviation from each service’s own recent baseline, in standard deviations.',
    keys: ['zScoreAnomaly', 'zScoreHigh', 'zScoreCritical', 'minDeltaPercent'],
  },
  {
    title: 'Absolute limits',
    note: 'Applied regardless of deviation, so a service pinned high is still reported even once that looks normal for it.',
    keys: ['absoluteHighPercent', 'absoluteCriticalPercent'],
  },
  {
    title: 'Flat baselines',
    note: 'A near-zero deviation makes z-scores explode, so a flat baseline is judged on absolute movement instead.',
    keys: ['flatlineStdDev', 'flatlineDeltaPercent', 'flatlineCriticalPercent'],
  },
  {
    title: 'Before judging at all',
    note: 'Guards against alerting on a service that has barely been observed.',
    keys: ['minHistorySamples', 'criticalServicesForCritical'],
  },
];

const LABELS: Record<string, string> = {
  zScoreAnomaly: 'Anomalous at |z| ≥',
  zScoreHigh: 'HIGH at |z| ≥',
  zScoreCritical: 'CRITICAL at |z| ≥',
  minDeltaPercent: 'Must also move by ≥ (points)',
  absoluteHighPercent: 'HIGH above %',
  absoluteCriticalPercent: 'CRITICAL above %',
  flatlineStdDev: 'Flat below std dev',
  flatlineDeltaPercent: 'Flat: anomalous jump (pts)',
  flatlineCriticalPercent: 'Flat: CRITICAL above %',
  minHistorySamples: 'Min history samples',
  criticalServicesForCritical: 'Critical services for CRITICAL',
};

export function IncidentRulesPanel() {
  const [data, setData] = useState<ThresholdPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/incidents/thresholds');
      if (!res.ok) return;
      const body: ThresholdPayload = await res.json();
      setData(body);
      setDraft(Object.fromEntries(Object.entries(body.values).map(([k, v]) => [k, String(v)])));
    } catch {
      // Panel stays collapsed and empty; detection is unaffected.
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (reset = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const body = reset
        ? { reset: true }
        : Object.fromEntries(
            Object.entries(draft)
              .map(([k, v]) => [k, Number(v)])
              .filter(([, v]) => Number.isFinite(v as number)),
          );
      const res = await fetch('/api/incidents/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) {
        setMessage(out.error || `Save failed (HTTP ${res.status})`);
      } else {
        setData(prev => (prev ? { ...prev, values: out.values } : prev));
        setDraft(Object.fromEntries(Object.entries(out.values).map(([k, v]) => [k, String(v)])));
        setMessage(reset ? 'Reset to defaults — applies on the next detection cycle.' : 'Saved — applies on the next detection cycle.');
      }
    } catch (e: any) {
      setMessage(e?.message || 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;

  const dirty = Object.entries(draft).some(([k, v]) => Number(v) !== data.values[k]);
  const changedFromDefault = Object.entries(data.values).filter(([k, v]) => v !== data.defaults[k]);

  return (
    <div style={{
      background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)',
      borderRadius: '12px', padding: '16px', marginBottom: '16px',
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left',
          color: 'var(--color-text-main)',
        }}
      >
        <span>
          <span style={{ fontSize: '14px', fontWeight: 700 }}>{open ? '▾' : '▸'} Detection rules</span>
          <span style={{ marginLeft: '10px', fontSize: '11px', color: 'var(--color-text-muted)' }}>
            rule-based · no model involved
          </span>
        </span>
        <span style={{ fontSize: '10px', color: changedFromDefault.length ? 'var(--color-degraded)' : 'var(--color-text-dim)' }}>
          {changedFromDefault.length
            ? `${changedFromDefault.length} rule(s) customised`
            : 'all defaults'}
        </span>
      </button>

      {open && (
        <>
          <p style={{ margin: '10px 0 14px 0', fontSize: '11px', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            An incident fires when a live metric breaks one of these rules — no trained model is consulted,
            which is why incidents work on a target that has never been trained and while the scorer is
            stopped. What the models think is a separate question, under <strong>Findings</strong>.
            The right values depend on the target: a box pinned at 90% CPU needs different bounds from one
            that idles at 2%.
          </p>

          {GROUPS.map(group => (
            <div key={group.title} style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-accent-cyan)' }}>{group.title}</div>
              <div style={{ fontSize: '10px', color: 'var(--color-text-dim)', margin: '2px 0 8px 0', lineHeight: 1.5 }}>{group.note}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px' }}>
                {group.keys.map(key => {
                  const [lo, hi] = data.limits[key] || [0, 0];
                  const isDefault = Number(draft[key]) === data.defaults[key];
                  return (
                    <div key={key}>
                      <label style={{
                        fontSize: '10px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '3px',
                      }} title={data.docs[key]}>
                        {LABELS[key] || key}
                      </label>
                      <input
                        type="number"
                        value={draft[key] ?? ''}
                        min={lo}
                        max={hi}
                        step={key === 'flatlineStdDev' ? 0.0001 : key.startsWith('zScore') ? 0.1 : 1}
                        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                        style={{
                          width: '100%', background: 'rgba(0,0,0,0.35)', color: '#fff',
                          border: `1px solid ${isDefault ? 'var(--color-border)' : 'var(--color-degraded)'}`,
                          borderRadius: '6px', padding: '5px 8px', fontSize: '11px', outline: 'none',
                        }}
                      />
                      <div style={{ fontSize: '9px', color: 'var(--color-text-dim)', marginTop: '3px', lineHeight: 1.45 }}>
                        {data.docs[key]}
                        <span style={{ display: 'block', marginTop: '2px' }}>
                          default {data.defaults[key]} · allowed {lo}–{hi}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button
              type="button" disabled={busy || !dirty} onClick={() => save(false)}
              style={{
                background: dirty && !busy ? 'rgba(0,212,255,0.18)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${dirty && !busy ? 'var(--color-accent-cyan)' : 'var(--color-border)'}`,
                color: dirty && !busy ? '#fff' : 'var(--color-text-dim)',
                borderRadius: '6px', padding: '6px 14px', fontSize: '11px', fontWeight: 700,
                cursor: dirty && !busy ? 'pointer' : 'not-allowed',
              }}
            >{busy ? 'SAVING…' : 'SAVE RULES'}</button>
            <button
              type="button" disabled={busy} onClick={() => save(true)}
              style={{
                background: 'transparent', border: '1px solid var(--color-border)',
                color: 'var(--color-text-muted)', borderRadius: '6px', padding: '6px 12px',
                fontSize: '11px', cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >Reset to defaults</button>
            {message && <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>{message}</span>}
          </div>
        </>
      )}
    </div>
  );
}
