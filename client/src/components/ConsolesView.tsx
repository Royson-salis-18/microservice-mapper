import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { ExternalLink } from 'lucide-react';
import { PageShell, PageHeader, Panel, EmptyNote } from './ui/Panel';

/**
 * Every console of every host in one place: the app itself, Grafana, FaultLab and the rest. Public ones open directly; the ones
 * the host only serves to itself (Grafana, Prometheus, FaultLab) need an ssh tunnel, which "Open tunnels" starts from the server.
 */

interface Link { id: string; label: string; url: string; kind: 'direct' | 'tunnel'; ready: boolean; note?: string }
interface Host { targetId: string; displayName: string; ip: string; hasTunnels: boolean; tunnelUp: boolean; links: Link[] }

const muted: CSSProperties = { color: 'var(--color-text-muted)' };
const linkStyle = (ready: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 'var(--radius-md)', textDecoration: 'none',
  border: '1px solid var(--color-border)', background: 'rgba(255,255,255,.02)', color: ready ? 'var(--color-text-main)' : 'var(--color-text-dim)',
  fontSize: 13, opacity: ready ? 1 : 0.55, pointerEvents: ready ? 'auto' : 'none',
});

export function ConsolesView({ selectedProject }: { selectedProject: string }) {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/consoles');
      if (!r.ok) throw new Error(String(r.status));
      setHosts(await r.json()); setFailed(false);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (targetId: string, what: 'open' | 'close') => {
    setBusy(`${what}:${targetId}`);
    try {
      const r = await fetch(`/api/consoles/${encodeURIComponent(targetId)}/${what}`, { method: 'POST' });
      const j = await r.json();
      setMsg((m) => ({ ...m, [targetId]: what === 'open' ? j.message : '' }));
    } catch (e: any) { setMsg((m) => ({ ...m, [targetId]: `could not reach the server: ${e.message}` })); }
    setBusy(null);
    await load();
  };
  const openAll = async () => { for (const h of shown.filter((x) => x.hasTunnels && !x.tunnelUp)) await act(h.targetId, 'open'); };

  const shown = (hosts ?? []).filter((h) => selectedProject === 'ALL' || h.targetId === selectedProject);

  return (
    <PageShell>
      <PageHeader title="Consoles & links" scope={selectedProject}>
        The app, Grafana, FaultLab and the rest for each host, one click away. Tunnels use the IP saved for the project.
      </PageHeader>

      {failed && <EmptyNote>The server did not answer. Start it and this page fills in.</EmptyNote>}
      {hosts && shown.length === 0 && <EmptyNote>No hosts configured yet. Add a project first.</EmptyNote>}

      {shown.some((h) => h.hasTunnels && !h.tunnelUp) && (
        <div><button className="mm-btn" onClick={openAll} disabled={busy !== null}>{busy ? 'Working…' : 'Open all tunnels'}</button></div>
      )}

      {shown.map((h) => (
        <Panel key={h.targetId} title={h.displayName} subtitle={h.ip}
          actions={h.hasTunnels ? (
            h.tunnelUp
              ? <button className="mm-btn" onClick={() => act(h.targetId, 'close')} disabled={busy !== null}>Close tunnels</button>
              : <button className="mm-btn" onClick={() => act(h.targetId, 'open')} disabled={busy !== null}>{busy === `open:${h.targetId}` ? 'Opening…' : 'Open tunnels'}</button>
          ) : undefined}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            {h.links.map((l) => (
              <a key={l.id} href={l.url} target="_blank" rel="noreferrer" style={linkStyle(l.ready)} title={l.ready ? l.url : 'Open the tunnels first'}>
                <ExternalLink size={14} strokeWidth={1.75} />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span>{l.label}</span>
                  {(l.note || !l.ready) && <span style={{ ...muted, fontSize: 11.5 }}>{l.ready ? l.note : 'needs tunnels'}</span>}
                </span>
              </a>
            ))}
          </div>
          {msg[h.targetId] && <div style={{ ...muted, fontSize: 12.5, marginTop: 10 }}>{msg[h.targetId]}</div>}
        </Panel>
      ))}
    </PageShell>
  );
}
