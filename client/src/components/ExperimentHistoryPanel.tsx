import { useState, useEffect } from 'react';
import type { Target } from '../types';

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
      top: '70px',
      left: '30px',
      right: '30px',
      bottom: '30px',
      background: 'rgba(12, 12, 24, 0.95)',
      borderRadius: '16px',
      border: '1px solid var(--color-border)',
      padding: '24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      overflowY: 'auto'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, color: '#fff', fontSize: '24px', fontWeight: 600 }}>Workload Experiments History</h2>
        
        <select 
          value={selectedTarget}
          onChange={(e) => {
            setSelectedTarget(e.target.value);
            fetchExperiments(e.target.value);
          }}
          style={{
            background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid var(--color-border)',
            padding: '8px 16px', borderRadius: '8px', fontSize: '14px', outline: 'none'
          }}
        >
          <option value="all">All Targets</option>
          {targets.map(t => <option key={t.targetId} value={t.targetId}>{t.displayName || t.targetId}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {experiments.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--color-text-dim)' }}>
            No experiments recorded.
          </div>
        ) : experiments.map(exp => (
          <div key={exp.experimentId} style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--color-border)',
            borderRadius: '12px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ 
                  padding: '4px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: exp.status === 'COMPLETED' ? 'rgba(0,230,118,0.1)' : exp.status === 'ABORTED_SAFETY' ? 'rgba(255,23,68,0.1)' : 'rgba(255,255,255,0.1)',
                  color: exp.status === 'COMPLETED' ? 'var(--color-healthy)' : exp.status === 'ABORTED_SAFETY' ? 'var(--color-critical)' : '#fff'
                }}>
                  {exp.status}
                </span>
                <span style={{ fontSize: '14px', fontWeight: 700, color: '#fff' }}>{exp.targetId} / {exp.workloadSource}</span>
                <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Profile: <span style={{color:'#fff'}}>{exp.profile.toUpperCase()}</span></span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-dim)' }}>
                Started: {new Date(exp.startedAt).toLocaleString()}
                {exp.stoppedAt && ` • Stopped: ${new Date(exp.stoppedAt).toLocaleTimeString()}`}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
              <div>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>Generator Statistics</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--color-text-dim)' }}>Attempted</div>
                    <div style={{ fontSize: '16px', color: '#fff', fontWeight: 600 }}>{exp.trafficStatistics.requestsAttempted}</div>
                  </div>
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--color-healthy)' }}>Successful</div>
                    <div style={{ fontSize: '16px', color: '#fff', fontWeight: 600 }}>{exp.trafficStatistics.requestsSuccessful}</div>
                  </div>
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--color-critical)' }}>Failed</div>
                    <div style={{ fontSize: '16px', color: '#fff', fontWeight: 600 }}>{exp.trafficStatistics.requestsFailed}</div>
                  </div>
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--color-accent-cyan)' }}>Peak Rate</div>
                    <div style={{ fontSize: '16px', color: '#fff', fontWeight: 600 }}>{exp.trafficStatistics.peakRate}/s</div>
                  </div>
                </div>
              </div>

              <div>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>Observed Peak Telemetry</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--color-text-dim)' }}>Peak CPU</div>
                    <div style={{ fontSize: '16px', color: '#fff', fontWeight: 600 }}>{exp.peakObservedMetrics.cpuPercent.toFixed(1)}%</div>
                  </div>
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--color-text-dim)' }}>Peak RAM</div>
                    <div style={{ fontSize: '16px', color: '#fff', fontWeight: 600 }}>{exp.peakObservedMetrics.memoryPercent.toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            </div>
            
            {exp.status === 'ABORTED_SAFETY' && (
              <div style={{ background: 'rgba(255,23,68,0.1)', border: '1px solid var(--color-critical)', borderRadius: '6px', padding: '8px', fontSize: '12px', color: 'var(--color-critical)' }}>
                ⚠ Experiment was automatically aborted because it exceeded safety limits.
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
