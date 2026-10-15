import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, RotateCcw } from 'lucide-react';

/**
 * The rules that decide what becomes an incident, shown where incidents are.
 *
 * These numbers used to be literals inside AnomalyDetector - a z-score of
 * 2.5, an absolute 85%, a 30-point jump on a flat baseline - so the honest
 * answer to "why did this fire?" was "read the source". They are editable
 * here because the right value depends on the target: a 909MB box that sits
 * pinned at 90% CPU needs different bounds from one that idles at 2%.
 *
 * Nothing on this panel touches the ML pipeline. Incidents are rule-based on
 * purpose - they have to fire on a service discovered a minute ago, on a
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
  zScoreHigh: 'High at |z| ≥',
  zScoreCritical: 'Critical at |z| ≥',
  minDeltaPercent: 'Must also move by ≥ (points)',
  absoluteHighPercent: 'High above %',
  absoluteCriticalPercent: 'Critical above %',
  flatlineStdDev: 'Flat below std dev',
  flatlineDeltaPercent: 'Flat: anomalous jump (pts)',
  flatlineCriticalPercent: 'Flat: critical above %',
  minHistorySamples: 'Min history samples',
  criticalServicesForCritical: 'Critical services for critical',
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
        setMessage(reset ? 'Reset to defaults - applies on the next detection cycle.' : 'Saved - applies on the next detection cycle.');
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
    <div className="mm-card" style={{ padding: 0, marginBottom: '16px', overflow: 'hidden' }}>
      <style>{`
        .mm-ir-head { transition: background var(--transition-fast); }
        .mm-ir-head:hover { background: rgba(255,255,255,.025); }
        .mm-ir-input { width: 100%; height: 30px; background: rgba(255,255,255,0.03); color: var(--color-text-main); border: 1px solid var(--color-border);
          border-radius: 8px; padding: 0 10px; font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; outline: none; transition: border-color var(--transition-fast); }
        .mm-ir-input:hover { border-color: var(--color-border-hover); }
        .mm-ir-input.changed { border-color: rgba(138,180,255,0.3); }
        .mm-ir-input:focus { border-color: rgba(138,180,255,0.45); }
      `}</style>
      <button
        type="button"
        className="mm-ir-head"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', padding: '14px 16px', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', textAlign: 'left',
          color: 'var(--color-text-main)', font: 'inherit',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <ChevronRight
            size={15}
            strokeWidth={1.75}
            color="var(--color-text-dim)"
            style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--transition-fast)', flexShrink: 0 }}
          />
          <span style={{ fontSize: '14px', fontWeight: 600 }}>Detection rules</span>
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            Rule-based, no model involved
          </span>
        </span>
        <span className="mm-chip" style={changedFromDefault.length ? { color: 'var(--color-text-main)' } : { color: 'var(--color-text-dim)' }}>
          {changedFromDefault.length
            ? `${changedFromDefault.length} customised`
            : 'All defaults'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--color-border)' }}>
          <p style={{ margin: '14px 0 18px 0', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: 1.6, maxWidth: '760px' }}>
            An incident fires when a live metric breaks one of these rules - no trained model is consulted,
            which is why incidents work on a target that has never been trained and while the scorer is
            stopped. What the models think is a separate question, under <strong style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>Findings</strong>.
            The right values depend on the target: a box pinned at 90% CPU needs different bounds from one
            that idles at 2%.
          </p>

          {GROUPS.map((group, gi) => (
            <div key={group.title} style={{ padding: '16px 0', borderTop: gi === 0 ? 'none' : '1px solid var(--color-border)' }}>
              <div style={{ fontSize: '13px', fontWeight: 550, color: 'var(--color-text-main)' }}>{group.title}</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: '2px 0 12px 0', lineHeight: 1.5 }}>{group.note}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px 16px' }}>
                {group.keys.map(key => {
                  const [lo, hi] = data.limits[key] || [0, 0];
                  const isDefault = Number(draft[key]) === data.defaults[key];
                  return (
                    <div key={key}>
                      <label style={{
                        fontSize: '12px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '6px',
                      }} title={data.docs[key]}>
                        {LABELS[key] || key}
                      </label>
                      <input
                        type="number"
                        className={`mm-ir-input${isDefault ? '' : ' changed'}`}
                        value={draft[key] ?? ''}
                        min={lo}
                        max={hi}
                        step={key === 'flatlineStdDev' ? 0.0001 : key.startsWith('zScore') ? 0.1 : 1}
                        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                      />
                      <div style={{ fontSize: '11.5px', color: 'var(--color-text-dim)', marginTop: '6px', lineHeight: 1.45 }}>
                        {data.docs[key]}
                        <span style={{ display: 'block', marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
                          Default {data.defaults[key]} · allowed {lo}–{hi}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '14px', borderTop: '1px solid var(--color-border)', flexWrap: 'wrap' }}>
            <button
              type="button" className="mm-btn primary" disabled={busy || !dirty} onClick={() => save(false)}
              style={{ cursor: dirty && !busy ? 'pointer' : 'not-allowed', opacity: dirty && !busy ? 1 : 0.45 }}
            >{busy ? 'Saving…' : 'Save rules'}</button>
            <button
              type="button" className="mm-btn" disabled={busy} onClick={() => save(true)}
              style={{ cursor: busy ? 'not-allowed' : 'pointer', color: 'var(--color-text-muted)' }}
            >
              <RotateCcw size={14} strokeWidth={1.75} />
              Reset to defaults
            </button>
            {message && <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginLeft: '4px' }}>{message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
