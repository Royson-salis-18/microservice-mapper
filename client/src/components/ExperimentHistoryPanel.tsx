import { useState, useEffect, Fragment } from 'react';
import type { Target } from '../types';
import { FlaskConical, AlertTriangle } from 'lucide-react';

const sentence = (s: string) => {
  const t = String(s ?? '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
};

const statusTone = (status: string): React.CSSProperties =>
  status === 'COMPLETED'
    ? { background: 'rgba(62,207,142,.1)', color: 'var(--color-healthy)', borderColor: 'transparent' }
    : status === 'ABORTED_SAFETY'
      ? { background: 'rgba(239,95,103,.1)', color: 'var(--color-critical)', borderColor: 'transparent' }
      : {};

const th: React.CSSProperties = {
  textAlign: 'left', fontSize: '11.5px', fontWeight: 500, color: 'var(--color-text-muted)',
  padding: '0 12px', height: '36px', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '0 12px', height: '44px', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-main)' };


export function ExperimentHistoryPanel() {
  const [experiments, setExperiments] = useState<any[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<string>('all');
  const [targets, setTargets] = useState<Target[]>([]);

  useEffect(() => {
    fetch('/api/targets').then(r => r.json()).then(setTargets).catch(console.error);
    fetchExperiments('all');
  }, []);

  const fetchExperiments = async (targetId: string) => {
    try {
      const url = targetId === 'all' ? '/api/experiments' : `/api/experiments?targetId=${targetId}`;
      const res = await fetch(url);
      if (res.ok) {
        setExperiments(await res.json());
      }
    } catch (e) {
      console.error('Failed to fetch experiments', e);
    }
  };

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      padding: '24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      overflowY: 'auto',
      background: 'var(--color-bg-body)',
      fontFamily: 'var(--font-family)',
    }}>
      <style>{`
        .mm-exp-row { transition: background var(--transition-fast); }
        .mm-exp-row:hover { background: rgba(255,255,255,.025); }
        .mm-exp-select { height: 30px; background: rgba(255,255,255,0.03); color: var(--color-text-main); border: 1px solid var(--color-border);
          border-radius: 8px; padding: 0 10px; font: inherit; font-size: 12.5px; outline: none; cursor: pointer; }
        .mm-exp-select:hover { border-color: var(--color-border-hover); }
        .mm-exp-select:focus { border-color: rgba(138,180,255,0.45); }
        .mm-exp-select option { background: var(--color-bg-raised); }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--color-text-main)', fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em' }}>Experiments</h2>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
            Workload runs from the traffic generator, with what the targets did under load.
          </div>
        </div>

        <select
          className="mm-exp-select"
          value={selectedTarget}
          onChange={(e) => {
            setSelectedTarget(e.target.value);
            fetchExperiments(e.target.value);
          }}
        >
          <option value="all">All targets</option>
          {targets.map(t => <option key={t.targetId} value={t.targetId}>{t.displayName || t.targetId}</option>)}
        </select>
      </div>

      <div className="mm-card" style={{ overflow: 'hidden' }}>
        {experiments.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', padding: '48px 16px', textAlign: 'center' }}>
            <FlaskConical size={20} strokeWidth={1.75} color="var(--color-text-dim)" />
            <div style={{ fontSize: '13px', color: 'var(--color-text-main)', marginTop: '4px' }}>No experiments yet</div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Runs started from the traffic generator will appear here.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', color: 'var(--color-text-main)' }}>
              <thead>
                <tr>
                  <th style={th}>Status</th>
                  <th style={th}>Target / source</th>
                  <th style={th}>Profile</th>
                  <th style={th}>Started</th>
                  <th style={{ ...th, textAlign: 'right' }}>Attempted</th>
                  <th style={{ ...th, textAlign: 'right' }}>Successful</th>
                  <th style={{ ...th, textAlign: 'right' }}>Failed</th>
                  <th style={{ ...th, textAlign: 'right' }}>Peak rate</th>
                  <th style={{ ...th, textAlign: 'right' }}>Peak CPU</th>
                  <th style={{ ...th, textAlign: 'right' }}>Peak memory</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map(exp => {
                  const aborted = exp.status === 'ABORTED_SAFETY';
                  const sep = '1px solid var(--color-border)';
                  return (
                    <Fragment key={exp.experimentId}>
                      <tr className="mm-exp-row" style={{ borderBottom: aborted ? 'none' : sep }}>
                        <td style={td}>
                          <span className="mm-chip" style={statusTone(exp.status)}>
                            <i className="mm-dot" style={{ background: 'currentColor' }} />
                            {sentence(exp.status)}
                          </span>
                        </td>
                        <td style={td}>
                          <span style={{ fontWeight: 500 }}>{exp.targetId}</span>
                          <span style={{ color: 'var(--color-text-dim)' }}> / </span>
                          <span style={{ color: 'var(--color-text-muted)' }}>{exp.workloadSource}</span>
                        </td>
                        <td style={{ ...td, color: 'var(--color-text-muted)' }}>{sentence(exp.profile)}</td>
                        <td style={{ ...td, fontSize: '12px', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                          {new Date(exp.startedAt).toLocaleString()}
                          {exp.stoppedAt && (
                            <span style={{ color: 'var(--color-text-dim)' }}>{` · stopped ${new Date(exp.stoppedAt).toLocaleTimeString()}`}</span>
                          )}
                        </td>
                        <td style={num}>{exp.trafficStatistics.requestsAttempted}</td>
                        <td style={num}>{exp.trafficStatistics.requestsSuccessful}</td>
                        <td style={{ ...num, color: exp.trafficStatistics.requestsFailed > 0 ? 'var(--color-critical)' : 'var(--color-text-dim)' }}>
                          {exp.trafficStatistics.requestsFailed}
                        </td>
                        <td style={num}>{exp.trafficStatistics.peakRate}<span style={{ color: 'var(--color-text-dim)' }}>/s</span></td>
                        <td style={num}>{exp.peakObservedMetrics.cpuPercent.toFixed(1)}<span style={{ color: 'var(--color-text-dim)' }}>%</span></td>
                        <td style={num}>{exp.peakObservedMetrics.memoryPercent.toFixed(1)}<span style={{ color: 'var(--color-text-dim)' }}>%</span></td>
                      </tr>
                      {aborted && (
                        <tr style={{ borderBottom: sep }}>
                          <td colSpan={10} style={{ padding: '0 12px 12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--color-critical)' }}>
                              <AlertTriangle size={14} strokeWidth={1.75} />
                              Automatically aborted because it exceeded safety limits.
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
