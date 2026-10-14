import { useEffect, useState } from 'react';

interface Row { id: string; level: number; own: number; symptom: number; anomaly: number; walk: number; hard: boolean; ready: boolean }
interface Target { targetId: string; ready: boolean; learnedServices: number; services: number; needReadings: number; detail: Row[] }

/** Live view of the ML engine: what each service's forests say right now and where the random walk puts the blame. */
export function MLLivePanel({ selectedProject }: { selectedProject?: string | null }) {
  const [mode, setMode] = useState<string>('rules');
  const [targets, setTargets] = useState<Target[]>([]);
  useEffect(() => {
    let off = false;
    const load = () => fetch('/api/engine').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (off || !d) return;
      setMode(d.mode); setTargets(d.status?.targets ?? []);
    }).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { off = true; clearInterval(t); };
  }, []);

  const shown = targets.filter((t) => !selectedProject || t.targetId === selectedProject);
  const box: React.CSSProperties = { border: '1px solid var(--border, #2a2f3a)', borderRadius: 8, padding: 14, marginBottom: 16 };
  const muted: React.CSSProperties = { opacity: 0.65, fontSize: 12 };
  if (mode !== 'ml') {
    return <div style={box}><b>ML engine</b><div style={muted}>Switch the engine to ML in the top bar to see what each service has learned and how the random walk ranks the root cause.</div></div>;
  }
  return (
    <div style={box}>
      <b>ML engine, live</b>
      <div style={muted}>Level: 0 typical, 1 on the service's own alarm line. Own = CPU, memory, throttling. Symptom = traffic, errors, latency. Blame = share of the random walk.</div>
      {!shown.length && <div style={{ ...muted, marginTop: 8 }}>No readings yet.</div>}
      {shown.map((t) => (
        <div key={t.targetId} style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>{t.targetId}: learned {t.learnedServices}/{t.services} services{t.ready ? '' : ` (needs about ${t.needReadings} readings each)`}</div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead><tr style={{ textAlign: 'left', opacity: 0.6 }}><th>Service</th><th>Baseline</th><th>Own</th><th>Symptom</th><th>Blame</th></tr></thead>
            <tbody>
              {t.detail.slice(0, 12).map((r) => (
                <tr key={r.id} style={{ color: r.hard ? '#ef4444' : r.level >= 1 ? '#f59e0b' : undefined }}>
                  <td>{r.id}{r.hard ? ' (stopped)' : ''}</td>
                  <td>{r.ready ? 'learned' : 'learning'}</td>
                  <td>{r.own.toFixed(1)}</td>
                  <td>{r.symptom.toFixed(1)}</td>
                  <td style={{ width: '35%' }}>
                    <div style={{ background: 'rgba(127,127,127,.2)', borderRadius: 3, height: 8 }}>
                      <div style={{ width: `${Math.round(r.walk * 100)}%`, height: 8, borderRadius: 3, background: r.hard ? '#ef4444' : '#6366f1' }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
