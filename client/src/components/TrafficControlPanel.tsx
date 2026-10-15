import { useState, useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { X, Play, Square, AlertTriangle, Info, Loader2, Radar, Pin } from 'lucide-react';

// Mirrors ABSOLUTE_MAX_USERS in traffic-gen/server.js. Kept in sync by hand;
// the server clamps regardless, so a drift here only affects the hint text.
const MAX_USERS = 200;

// Each workflow file declares its own per-profile user counts, so this is a
// hint for the placeholder only - the server uses the real value.
const PROFILE_USER_HINT: Record<string, number> = {
  baseline: 5, moderate: 15, heavy: 40, stress: 80, ramp: 20,
};

interface ProbeResult {
  url: string;
  serviceName: string;
  endpointId: string;
  port: number;
  reachable: boolean;
  usable: boolean;
  status?: number;
  ms: number;
  error?: string;
}

interface SurfaceReport {
  targetId: string;
  probedAt: string;
  totalCandidates: number;
  usable: ProbeResult[];
  reachableButUnusable: ProbeResult[];
  dead: ProbeResult[];
}
import type { Target, DiscoveredService, DiscoveredEndpoint, DiscoveredRoute, TargetDiscoverySummary } from '../types';

const sentence = (v: string) => {
  const t = String(v ?? '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
};

const labelStyle: CSSProperties = { fontSize: '12px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '6px', fontWeight: 500 };
const hintStyle: CSSProperties = { fontSize: '11.5px', color: 'var(--color-text-dim)', marginTop: '6px', lineHeight: 1.45 };

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ padding: '16px 20px', borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', minHeight: '22px' }}>
        <span className="mm-eyebrow">{title}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Note({ tone, icon, children }: { tone: 'warn' | 'error' | 'info'; icon: ReactNode; children: ReactNode }) {
  const palette = {
    warn: { bg: 'rgba(232,163,61,0.08)', border: 'rgba(232,163,61,0.22)', icon: 'var(--color-degraded)' },
    error: { bg: 'rgba(239,95,103,0.08)', border: 'rgba(239,95,103,0.25)', icon: 'var(--color-critical)' },
    info: { bg: 'rgba(255,255,255,0.02)', border: 'var(--color-border)', icon: 'var(--color-text-dim)' },
  }[tone];
  return (
    <div style={{
      display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: '8px',
      background: palette.bg, border: `1px solid ${palette.border}`, fontSize: '12px', lineHeight: 1.5,
      color: tone === 'info' ? 'var(--color-text-muted)' : 'var(--color-text-main)',
    }}>
      <span style={{ color: palette.icon, display: 'flex', marginTop: '2px', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const PANEL_CSS = `
  .mm-tc-input { width: 100%; height: 30px; background-color: rgba(255,255,255,0.03); color: var(--color-text-main); border: 1px solid var(--color-border);
    border-radius: 8px; padding: 0 10px; font: inherit; font-size: 12.5px; outline: none; transition: border-color var(--transition-fast); }
  .mm-tc-input::placeholder { color: var(--color-text-dim); }
  .mm-tc-input:hover:not(:disabled) { border-color: var(--color-border-hover); }
  .mm-tc-input:focus { border-color: rgba(138,180,255,0.45); }
  .mm-tc-input:disabled { color: var(--color-text-dim); cursor: not-allowed; }
  .mm-tc-input.mono { font-family: var(--font-mono); font-size: 12px; }
  select.mm-tc-input { appearance: none; -webkit-appearance: none; padding-right: 28px; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235d636c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 9px center; }
  select.mm-tc-input option { background: var(--color-bg-raised); color: var(--color-text-main); }
  .mm-tc .mm-btn { cursor: pointer; }
  .mm-tc .mm-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .mm-tc .mm-btn.danger { background: rgba(239,95,103,0.1); border-color: rgba(239,95,103,0.3); color: #ffb3b7; }
  .mm-tc .mm-btn.danger:hover:not(:disabled) { background: rgba(239,95,103,0.16); }
  .mm-tc .mm-btn.ghost { background: transparent; color: var(--color-text-muted); }
  .mm-tc .mm-btn.ghost:hover:not(:disabled) { background: rgba(255,255,255,0.04); color: var(--color-text-main); }
`;

interface TrafficControlPanelProps {
  onClose?: () => void;
}

export function TrafficControlPanel({ onClose }: TrafficControlPanelProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string>('sock-shop');
  const [workloadSource, setWorkloadSource] = useState<'EXTERNAL' | 'USER_SIM'>('EXTERNAL');
  const [mode, setMode] = useState<'USER_JOURNEY' | 'ENDPOINT' | 'SERVICE' | 'SWEEP'>('USER_JOURNEY');
  const [profile, setProfile] = useState<string>('baseline');
  const [duration, setDuration] = useState<string>('0');
  // Empty means "use the profile's own default". A number overrides it, so
  // an operator can push past a profile without editing a workflow file.
  const [users, setUsers] = useState<string>('');
  const [surface, setSurface] = useState<SurfaceReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [reachabilityStatus, setReachabilityStatus] = useState<string>('UNKNOWN');
  
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>('');
  const [selectedServiceId, setSelectedServiceId] = useState<string>('');
  const [selectedRouteId, setSelectedRouteId] = useState<string>('');

  const [targets, setTargets] = useState<Target[]>([]);
  const [diagnostics, setDiagnostics] = useState<any[]>([]);
  const [summary, setSummary] = useState<TargetDiscoverySummary | null>(null);
  const [services, setServices] = useState<DiscoveredService[]>([]);
  const [publicEndpoints, setPublicEndpoints] = useState<DiscoveredEndpoint[]>([]);
  const [routes, setRoutes] = useState<DiscoveredRoute[]>([]);
  const [resolvedEndpointUrl, setResolvedEndpointUrl] = useState<string | null>(null);
  const [isResolvedConfigured, setIsResolvedConfigured] = useState<boolean>(false);
  
  const [isLoading, setIsLoading] = useState<boolean>(false);

  interface TrafficHealth {
    reachable: boolean;
    url: string | null;
    projects: Array<{
      projectId: string; targetId: string; baseUrl: string | null; running: boolean;
      stats: { requestsAttempted: number; requestsCompleted: number; requestsSuccessful: number; requestsFailed: number; currentRate: number; currentUsers: number; errorRate: number } | null;
    }>;
  }
  const [trafficHealth, setTrafficHealth] = useState<TrafficHealth | null>(null);
  const [entryPoints, setEntryPoints] = useState<Record<string, { pinned: string | null; resolved: string | null; staleHost?: string }>>({});
  const [entryDraft, setEntryDraft] = useState('');
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryMsg, setEntryMsg] = useState<string | null>(null);

  const fetchResolvedUrl = async (targetId: string, endpointId?: string) => {
    try {
      const url = `/api/targets/${targetId}/resolved-url${endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setResolvedEndpointUrl(data.resolvedUrl);
        setIsResolvedConfigured(data.isConfigured);
        
        if (data.resolvedUrl) {
          setReachabilityStatus('CHECKING');
          const reachRes = await fetch(`/api/targets/${targetId}/reachability?url=${encodeURIComponent(data.resolvedUrl)}`);
          if (reachRes.ok) {
            const reachData = await reachRes.json();
            setReachabilityStatus(reachData.status);
          } else {
            setReachabilityStatus('ERROR');
          }
        } else {
          setReachabilityStatus('UNKNOWN');
        }
      }
    } catch (e) {
      console.error('Error fetching resolved URL:', e);
      setReachabilityStatus('ERROR');
    }
  };

  const fetchTargetDiscovery = async (targetId: string) => {
    try {
      const [sumRes, svcRes, epRes, rtRes] = await Promise.all([
        fetch(`/api/targets/${targetId}/discovery`),
        fetch(`/api/targets/${targetId}/services`),
        fetch(`/api/targets/${targetId}/endpoints?publicOnly=true`),
        fetch(`/api/targets/${targetId}/routes`)
      ]);

      if (sumRes.ok) setSummary(await sumRes.json());
      if (svcRes.ok) setServices(await svcRes.json());
      if (epRes.ok) {
        const eps: DiscoveredEndpoint[] = await epRes.json();
        setPublicEndpoints(eps);
        if (eps.length > 0 && !selectedEndpointId) {
          // [AGY] Changed default selection behavior to prioritize known frontend 
          // ports (80, 8080) rather than picking the first alphabetical endpoint. 
          // OpenTelemetry was defaulting to grafana:3000 which was unreachable.
          const preferredPorts = [80, 8080, 8000, 3000];
          const bestEp = [...eps].sort((a, b) => {
            const aIdx = preferredPorts.indexOf(a.port);
            const bIdx = preferredPorts.indexOf(b.port);
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
            return 0;
          })[0];
          setSelectedEndpointId(bestEp.endpointId);
        }
      }
      if (rtRes.ok) setRoutes(await rtRes.json());
    } catch (e) {
      console.error('Error fetching discovery data:', e);
    }
  };

  const fetchData = async () => {
    try {
      const [targetsRes, statusRes] = await Promise.all([
        fetch('/api/targets'),
        fetch('/api/traffic/status')
      ]);

      if (targetsRes.ok) {
        const t: Target[] = await targetsRes.json();
        setTargets(t.filter(x => x.targetId !== 'all' && x.targetId !== 'ALL TARGETS'));
      }
      if (statusRes.ok) setDiagnostics(await statusRes.json());
    } catch (e) {
      console.error('Error fetching traffic/targets data:', e);
    }
  };

  useEffect(() => {
    fetchData();
    fetchTargetDiscovery(selectedTargetId);
    fetchResolvedUrl(selectedTargetId, selectedEndpointId);

    const interval = setInterval(() => {
      fetchData();
    }, 1000);
    return () => clearInterval(interval);
  }, [selectedTargetId, selectedEndpointId]);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/traffic/health');
        if (res.ok) setTrafficHealth(await res.json());
      } catch {
        setTrafficHealth({ reachable: false, url: null, projects: [] });
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchEntryPoints();
  }, []);

  // Show the pin for whichever target is selected, without clobbering an
  // edit in progress.
  useEffect(() => {
    setEntryDraft(entryPoints[selectedTargetId]?.pinned || '');
    setEntryMsg(null);
  }, [selectedTargetId, entryPoints[selectedTargetId]?.pinned]);

  const activeUrl = resolvedEndpointUrl || '';

  const runningDiag = diagnostics.find((d) => d.targetId === selectedTargetId && d.isRunning);
  const isCurrentRunning = !!runningDiag;
  const isAnyRunning = diagnostics.some((d) => d.isRunning);

  const selectedServiceRoutes = selectedServiceId ? routes.filter(r => r.serviceId === selectedServiceId) : routes;
  const isSelectedServiceCapable = selectedServiceId
    ? selectedServiceRoutes.some(r => r.trafficCapable)
    : true;

  // Why the run can't start, in the user's words. Previously handleStart
  // just `return`ed when a precondition failed, so clicking a button that
  // looked enabled did nothing at all and said nothing about why.
  //
  // SWEEP is deliberately exempt from the reachability gate: its whole job is
  // to find out which endpoints respond. Blocking it because the *default*
  // entry point is unreachable would block the one mode that can tell you
  // which entry point to use instead.
  const blockedReason: string | null =
    !isResolvedConfigured
      ? 'No entry point resolved for this target. Pin one above, or pick an endpoint.'
      : mode === 'SWEEP'
        ? null
        : reachabilityStatus === 'CHECKING'
          ? 'Still checking whether the entry point responds…'
          : reachabilityStatus !== 'REACHABLE'
            ? `Entry point ${activeUrl || ''} is ${reachabilityStatus.toLowerCase()}. Pick a different endpoint, or pin one that responds - telemetry UIs (Grafana, Jaeger) are often not reachable from here. Or switch traffic mode to Sweep to probe every endpoint.`
            : !isSelectedServiceCapable
              ? 'The selected service has no traffic-capable routes. Choose another service, or switch traffic mode to User journey.'
              : null;

  const handleStart = async () => {
    if (blockedReason) return;
    setIsLoading(true);
    setStartError(null);
    try {
      const durationSec = parseInt(duration, 10) || 0;
      // If the surface was already probed for this target, reuse that result
      // rather than making the server probe again - the operator has seen
      // exactly which URLs it contains and is starting against those.
      const sweepPaths =
        mode === 'SWEEP' && surface?.targetId === selectedTargetId && surface.usable.length > 0
          ? surface.usable.map(u => u.url)
          : undefined;

      const res = await fetch('/api/experiments/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: selectedTargetId,
          workloadSource,
          profile,
          mode,
          users: users.trim() ? parseInt(users, 10) : undefined,
          durationSec: durationSec || undefined,
          endpointPaths: sweepPaths,
          config: { durationSeconds: durationSec },
          endpointId: selectedEndpointId || undefined,
          serviceId: selectedServiceId || undefined,
          routeId: selectedRouteId || undefined,
          limits: { cpuThreshold: 85, memoryThreshold: 85, errorRateThreshold: 0.1, latencyThreshold: 2000 }
        }),
      });

      // The server answers 502 with the real reason when traffic never
      // started. This used to be discarded, so a failed start looked
      // identical to a successful one until the stats stayed at zero.
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        setStartError(body.error || `Server refused the start (HTTP ${res.status})`);
      }
      await fetchData();
    } catch (e: any) {
      console.error('Failed to start experiment:', e);
      setStartError(e?.message || 'Could not reach the server');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Probe every discovered endpoint and report which ones answer.
   *
   * This is read-only - one GET per endpoint, no load generated. It exists
   * because discovery can only report what a container publishes, which is
   * not the same as what is reachable from here.
   */
  const handleProbeSurface = async () => {
    setProbing(true);
    setSurface(null);
    setStartError(null);
    try {
      const res = await fetch('/api/traffic/surface/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: selectedTargetId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        setStartError(body.error || `Probe failed (HTTP ${res.status})`);
        return;
      }
      setSurface(await res.json());
    } catch (e: any) {
      setStartError(e?.message || 'Probe request failed');
    } finally {
      setProbing(false);
    }
  };

  const handleStop = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/traffic/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: selectedTargetId }),
      });
      await fetchData();
    } catch (e) {
      console.error('Failed to stop traffic:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const anyProjectRunning = (trafficHealth?.projects || []).some(p => p.running);

  const handleStopAll = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/traffic/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: 'all' }),
      });
      await fetchData();
    } catch (e) {
      console.error('Failed to stop all traffic:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchEntryPoints = async () => {
    try {
      const res = await fetch('/api/traffic/entrypoints');
      if (res.ok) setEntryPoints(await res.json());
    } catch { /* keep previous */ }
  };

  const handleProbeEntry = async () => {
    const url = entryDraft.trim() || entryPoints[selectedTargetId]?.resolved;
    if (!url) { setEntryMsg('No URL to probe'); return; }
    setEntryBusy(true);
    setEntryMsg(null);
    try {
      const res = await fetch('/api/traffic/entrypoint/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const d = await res.json();
      setEntryMsg(d.reachable ? `OK - HTTP ${d.status} in ${d.ms}ms` : `Unreachable: ${d.error}`);
    } catch (e: any) {
      setEntryMsg(`Probe failed: ${e.message}`);
    } finally {
      setEntryBusy(false);
    }
  };

  const handleSaveEntry = async (explicit?: string) => {
    setEntryBusy(true);
    setEntryMsg(null);
    try {
      const res = await fetch('/api/traffic/entrypoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: selectedTargetId, url: explicit !== undefined ? explicit : entryDraft }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setEntryMsg(d.pinned ? `OK - pinned to ${d.pinned}` : 'OK - pin cleared, using discovery');
      await fetchEntryPoints();
    } catch (e: any) {
      setEntryMsg(e.message);
    } finally {
      setEntryBusy(false);
    }
  };

  const entry = entryPoints[selectedTargetId];
  const engineTone: CSSProperties = trafficHealth === null
    ? {}
    : trafficHealth.reachable
      ? { background: 'rgba(62,207,142,.1)', color: 'var(--color-healthy)', borderColor: 'transparent' }
      : { background: 'rgba(239,95,103,.1)', color: 'var(--color-critical)', borderColor: 'transparent' };
  const reachColor = reachabilityStatus === 'REACHABLE'
    ? 'var(--color-healthy)'
    : reachabilityStatus === 'CHECKING' || reachabilityStatus === 'UNKNOWN'
      ? 'var(--color-text-muted)'
      : 'var(--color-critical)';
  const canStart = !isCurrentRunning && !blockedReason;

  return (
    <div
      className="mm-tc"
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        width: '440px',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 48px)',
        background: 'rgba(17, 19, 23, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--color-border)',
        borderRadius: '14px',
        zIndex: 100,
        boxShadow: 'var(--shadow-pop)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-family)',
        color: 'var(--color-text-main)',
        overflow: 'hidden',
      }}
    >
      <style>{PANEL_CSS}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', padding: '16px 16px 14px 20px', flexShrink: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '14px', letterSpacing: '-0.005em' }}>Traffic generator</div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '3px' }}>
            Run synthetic workloads against a target and watch how it responds.
          </div>
        </div>
        {onClose && (
          <button className="mm-icon-btn" onClick={onClose} aria-label="Close" style={{ cursor: 'pointer', flexShrink: 0, marginTop: '-4px' }}>
            <X size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div className="mm-tc-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* Traffic-gen live status - makes it obvious whether the engine is
            actually up, since Node's own "isRunning" belief can go stale if
            traffic-gen crashes mid-run without Node finding out. */}
        <Section
          title="Traffic engine"
          aside={
            <span className="mm-chip" style={engineTone}>
              {trafficHealth === null
                ? <Loader2 size={12} strokeWidth={1.75} className="mm-spin" />
                : <i className="mm-dot" style={{ background: 'currentColor' }} />}
              {trafficHealth === null ? 'Checking' : trafficHealth.reachable ? 'Online' : 'Offline'}
            </span>
          }
        >
          {trafficHealth?.reachable && trafficHealth.projects.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {trafficHealth.projects.map(p => (
                <div key={p.projectId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', height: '28px', fontSize: '12.5px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, color: p.running ? 'var(--color-text-main)' : 'var(--color-text-muted)' }}>
                    <i className="mm-dot" style={{ background: p.running ? 'var(--color-accent-cyan)' : 'var(--color-unknown)' }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.projectId}</span>
                  </span>
                  <span style={{ color: p.running ? 'var(--color-text-muted)' : 'var(--color-text-dim)', fontSize: '12px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {p.running && p.stats
                      ? `${p.stats.currentUsers} users · ${p.stats.currentRate.toFixed(1)} req/s · ${(p.stats.errorRate * 100).toFixed(0)}% err`
                      : 'Idle'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {trafficHealth?.reachable === false && (
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Not reachable at <code style={{ color: 'var(--color-text-main)' }}>{trafficHealth.url || 'localhost:4400'}</code>. It should start with the server; check the server logs if this persists.
            </div>
          )}

          {/* Global kill switch. Stops every run the system can reach, including
              ones started outside this app or before the last server restart -
              not just whatever this panel happens to be showing. */}
          <button
            className={`mm-btn${anyProjectRunning ? ' danger' : ' ghost'}`}
            onClick={handleStopAll}
            disabled={isLoading}
            title="Stops synthetic traffic for every project, from any source"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            <Square size={13} strokeWidth={1.75} />
            {anyProjectRunning ? 'Stop all traffic (all projects)' : 'Stop all · nothing running'}
          </button>
        </Section>

        {/* Entry point: what traffic is actually sent to. Discovery can only
            see what a container publishes, which isn't always reachable from
            here, so this can be pinned per project and proven with a probe. */}
        <Section
          title="Entry point"
          aside={
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--color-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedTargetId}</span>
              {entry?.pinned && (
                <span className="mm-chip" style={{ background: 'rgba(138,180,255,.1)', color: 'var(--color-accent-cyan)', borderColor: 'transparent' }}>
                  <Pin size={11} strokeWidth={1.75} />Pinned
                </span>
              )}
            </span>
          }
        >
          <div>
            <input
              className="mm-tc-input mono"
              value={entryDraft}
              onChange={(e) => setEntryDraft(e.target.value)}
              placeholder={entry?.resolved || 'http://host:port'}
            />
            <div style={hintStyle}>
              In use: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>{entry?.resolved || 'none resolved'}</span>
              {!entry?.pinned && ' (inferred from discovery)'}
            </div>
          </div>
          {entry?.staleHost && (
            <Note tone="warn" icon={<AlertTriangle size={14} strokeWidth={1.75} />}>
              This pin doesn't match the target's current IP (<code>{entry.staleHost}</code>). The instance likely restarted with a new
              address. Probe it, then update or clear the pin.
            </Note>
          )}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button className="mm-btn" onClick={handleProbeEntry} disabled={entryBusy}>
              {entryBusy ? <Loader2 size={14} strokeWidth={1.75} className="mm-spin" /> : <Radar size={14} strokeWidth={1.75} />}
              Probe
            </button>
            <button className="mm-btn" onClick={() => handleSaveEntry()} disabled={entryBusy}>
              Save pin
            </button>
            <button
              className="mm-btn ghost"
              onClick={() => { setEntryDraft(''); handleSaveEntry(''); }}
              disabled={entryBusy}
              title="Clear the pin and fall back to discovery"
            >
              Clear
            </button>
          </div>
          {entryMsg && (
            <div style={{ fontSize: '12px', color: entryMsg.startsWith('OK') ? 'var(--color-healthy)' : 'var(--color-critical)' }}>{entryMsg}</div>
          )}
        </Section>

        <Section title="Workload">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ minWidth: 0 }}>
              <label style={labelStyle}>Target</label>
              <select
                className="mm-tc-input"
                value={selectedTargetId} disabled={isAnyRunning}
                onChange={(e) => {
                  // Endpoint/service/route ids are namespaced per target, so
                  // carrying them across a target switch sends traffic to the
                  // previous project's URL. Observed in the log as a death-star
                  // experiment resolving an open-telemetry endpoint id.
                  setSelectedTargetId(e.target.value);
                  setSelectedEndpointId('');
                  setSelectedServiceId('');
                  setSelectedRouteId('');
                  // A probe report belongs to the target it was taken against.
                  setSurface(null);
                  setStartError(null);
                }}
              >
                {targets.length > 0 ? targets.map(t => <option key={t.targetId} value={t.targetId}>{t.displayName || t.targetId}</option>) : <><option value="sock-shop">Sock Shop AWS</option><option value="vertikal">Vertikal AWS</option></>}
              </select>
            </div>
            <div style={{ minWidth: 0 }}>
              <label style={labelStyle}>Workload source</label>
              <select
                className="mm-tc-input"
                value={workloadSource}
                onChange={(e) => setWorkloadSource(e.target.value as any)}
              >
                <option value="EXTERNAL">External traffic engine</option>
                <option value="USER_SIM" disabled>Remote user sim (uncontrollable)</option>
              </select>
              {selectedTargetId.includes('sock') && (
                <div style={hintStyle}>Native user sim: observe only, via telemetry</div>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ minWidth: 0 }}>
              <label style={labelStyle}>Profile</label>
              <select
                className="mm-tc-input"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              >
                <option value="baseline">Baseline (2 req/s)</option>
                <option value="moderate">Moderate (10 req/s)</option>
                <option value="heavy">Heavy (25 req/s)</option>
                <option value="stress">Stress (50 req/s, may crash)</option>
                <option value="ramp">Ramp (dynamic increment)</option>
              </select>
            </div>
            <div style={{ minWidth: 0 }}>
              <label style={labelStyle}>Duration (seconds)</label>
              <input
                className="mm-tc-input"
                type="number" value={duration} onChange={e => setDuration(e.target.value)}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              />
              <div style={hintStyle}>0 runs until stopped (max 1800)</div>
            </div>
          </div>

          <div>
            <label style={labelStyle}>
              Virtual users <span style={{ color: 'var(--color-text-dim)' }}>{users.trim() ? '· override' : '· profile default'}</span>
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                className="mm-tc-input"
                type="number" min={1} max={MAX_USERS} value={users}
                placeholder={`Default, e.g. ${PROFILE_USER_HINT[profile] ?? 5}`}
                onChange={e => setUsers(e.target.value)}
                style={{ flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}
              />
              <div className="mm-seg" style={{ gridTemplateColumns: 'repeat(4, 34px)', flexShrink: 0 }}>
                {[10, 25, 50, 100].map(n => (
                  <button
                    key={n} type="button" onClick={() => setUsers(String(n))}
                    className={users === String(n) ? 'on' : ''}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >{n}</button>
                ))}
              </div>
              {users.trim() && (
                <button
                  type="button" className="mm-btn ghost" onClick={() => setUsers('')}
                  title="Back to the profile's own default"
                  style={{ padding: '0 8px' }}
                >Clear</button>
              )}
            </div>
            <div style={hintStyle}>
              Concurrent simulated users. Hard ceiling {MAX_USERS} - these are small EC2 boxes.
            </div>
          </div>
        </Section>

        {workloadSource === 'EXTERNAL' && (
          <Section title="Routing">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ minWidth: 0 }}>
                <label style={labelStyle}>Endpoint</label>
                <select
                  className="mm-tc-input"
                  value={selectedEndpointId} onChange={(e) => setSelectedEndpointId(e.target.value)}
                >
                  {publicEndpoints.map(ep => <option key={ep.endpointId} value={ep.endpointId}>{ep.serviceName} :{ep.port}</option>)}
                </select>
              </div>
              <div style={{ minWidth: 0 }}>
                <label style={labelStyle}>Traffic mode</label>
                <select
                  className="mm-tc-input"
                  value={mode} onChange={(e) => setMode(e.target.value as any)}
                >
                  <option value="USER_JOURNEY">User journey scenario</option>
                  <option value="SWEEP">Sweep - every working endpoint</option>
                  <option value="ENDPOINT">Specific discovered route</option>
                  <option value="SERVICE">Service public workflow</option>
                </select>
              </div>
            </div>

            {mode === 'SWEEP' && (
              <div style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '12px', background: 'rgba(255,255,255,0.015)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                  Sweep drives one virtual-user loop across <span style={{ color: 'var(--color-text-main)' }}>every discovered HTTP endpoint that answers a live probe</span>,
                  so every service emits telemetry in the same window - which is what the per-service Isolation Forest needs.
                  Endpoints that do not respond are left out rather than counted as failures.
                </div>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <button
                    type="button" className="mm-btn" onClick={handleProbeSurface} disabled={probing}
                    style={{ cursor: probing ? 'wait' : 'pointer' }}
                  >
                    {probing ? <Loader2 size={14} strokeWidth={1.75} className="mm-spin" /> : <Radar size={14} strokeWidth={1.75} />}
                    {probing ? 'Probing…' : 'Probe all endpoints'}
                  </button>
                  <span style={{ fontSize: '11.5px', color: 'var(--color-text-dim)' }}>
                    Read-only: one GET per endpoint, no load.
                  </span>
                </div>

                {surface && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: '12px', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><i className="mm-dot" style={{ background: 'var(--color-healthy)' }} />{surface.usable.length} working</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><i className="mm-dot" style={{ background: 'var(--color-degraded)' }} />{surface.reachableButUnusable.length} unusable</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><i className="mm-dot" style={{ background: 'var(--color-critical)' }} />{surface.dead.length} no response</span>
                      <span style={{ color: 'var(--color-text-dim)' }}>of {surface.totalCandidates}</span>
                    </div>

                    <div style={{ maxHeight: '170px', overflowY: 'auto', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--color-border)' }}>
                      {[...surface.usable, ...surface.reachableButUnusable, ...surface.dead].map(r => (
                        <div key={r.url} style={{ display: 'flex', gap: '8px', alignItems: 'center', height: '26px', fontSize: '11.5px', fontFamily: 'var(--font-mono)', borderBottom: '1px solid var(--color-border)' }}>
                          <i className="mm-dot" style={{
                            width: '6px', height: '6px',
                            background: r.usable ? 'var(--color-healthy)' : r.reachable ? 'var(--color-degraded)' : 'var(--color-critical)',
                          }} />
                          <span style={{ color: 'var(--color-text-main)', width: '96px', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.serviceName}</span>
                          <span style={{ color: 'var(--color-text-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url}</span>
                          <span style={{ color: r.usable ? 'var(--color-text-muted)' : r.reachable ? 'var(--color-degraded)' : 'var(--color-critical)', flexShrink: 0 }}>
                            {r.reachable ? `${r.status} · ${r.ms}ms` : r.error}
                          </span>
                        </div>
                      ))}
                    </div>

                    {surface.usable.length === 0 && (
                      <div style={{ fontSize: '12px', color: 'var(--color-critical)' }}>
                        Nothing responded. The host may be down, or its ports may not be open in the security group.
                      </div>
                    )}
                  </div>
                )}

                {!surface && !probing && (
                  <div style={{ fontSize: '11.5px', color: 'var(--color-text-dim)' }}>
                    Not probed yet - starting now will probe first and use whatever answers.
                  </div>
                )}
              </div>
            )}

            {mode === 'SERVICE' && (
              <div>
                <label style={labelStyle}>Target service</label>
                <select
                  className="mm-tc-input"
                  value={selectedServiceId} onChange={(e) => setSelectedServiceId(e.target.value)}
                >
                  <option value="">All services</option>
                  {services.map(svc => <option key={svc.serviceId} value={svc.serviceId}>{svc.name}</option>)}
                </select>
              </div>
            )}

            {mode === 'ENDPOINT' && (
              <div>
                <label style={labelStyle}>Target route</label>
                <select
                  className="mm-tc-input mono"
                  value={selectedRouteId} onChange={(e) => setSelectedRouteId(e.target.value)}
                >
                  <option value="">Auto / all discovered routes</option>
                  {routes.map(rt => <option key={rt.routeId} value={rt.routeId}>{rt.method} {rt.path}</option>)}
                </select>
              </div>
            )}
          </Section>
        )}

        <div style={{ padding: '14px 20px 16px', borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Discovery status */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', fontSize: '12px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <i className="mm-dot" style={{ background: reachColor }} />
              <span style={{ fontFamily: activeUrl ? 'var(--font-mono)' : undefined, fontSize: activeUrl ? '11.5px' : '12px', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeUrl || 'Endpoint unavailable'}
              </span>
              {activeUrl && <span style={{ color: reachColor, whiteSpace: 'nowrap' }}>{sentence(reachabilityStatus)}</span>}
            </span>
            {summary && (
              <span style={{ color: 'var(--color-text-dim)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {summary.servicesCount} services · {summary.publicEndpointsCount} endpoints
              </span>
            )}
          </div>

          {blockedReason && (
            <Note tone="warn" icon={<AlertTriangle size={14} strokeWidth={1.75} />}>
              <span style={{ fontWeight: 550 }}>Can't start yet.</span>{' '}
              <span style={{ color: 'var(--color-text-muted)' }}>{blockedReason}</span>
            </Note>
          )}

          {startError && (
            <Note tone="error" icon={<AlertTriangle size={14} strokeWidth={1.75} />}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                <span><span style={{ fontWeight: 550 }}>Start failed.</span> <span style={{ color: 'var(--color-text-muted)' }}>{startError}</span></span>
                <button
                  type="button" onClick={() => setStartError(null)} aria-label="Dismiss"
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-text-dim)', cursor: 'pointer', padding: 0, display: 'flex', height: '16px' }}
                ><X size={14} strokeWidth={1.75} /></button>
              </div>
            </Note>
          )}

          {/* No auto-abort notice - these are failure-injection experiments;
              services are supposed to break, so nothing here auto-stops on
              high CPU/memory/error-rate. See ExperimentManager.checkSafetyLimits(). */}
          <Note tone="info" icon={<Info size={14} strokeWidth={1.75} />}>
            <span style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>No auto-abort.</span> Experiments run until you stop them, even under heavy CPU, memory or error rate - that's the point, for RCA and cascading-failure research.
          </Note>

          {isCurrentRunning && runningDiag && runningDiag.trafficStatistics && (
            <div style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <i className="mm-dot" style={{ background: 'var(--color-accent-cyan)' }} />
                <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Live generator statistics</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                {[
                  { label: 'Attempted', value: runningDiag.trafficStatistics.requestsAttempted },
                  { label: 'Successful', value: runningDiag.trafficStatistics.requestsSuccessful },
                  { label: 'Failed', value: runningDiag.trafficStatistics.requestsFailed },
                  { label: 'Rate', value: `${runningDiag.trafficStatistics.peakRate}/s` },
                ].map(stat => (
                  <div key={stat.label}>
                    <div style={{ fontSize: '11.5px', color: 'var(--color-text-dim)' }}>{stat.label}</div>
                    <div style={{
                      fontSize: '18px', fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', marginTop: '2px',
                      color: stat.label === 'Failed' && Number(stat.value) > 0 ? 'var(--color-critical)' : 'var(--color-text-main)',
                    }}>{stat.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '12px 16px', borderTop: '1px solid var(--color-border)', flexShrink: 0, background: 'rgba(255,255,255,0.01)' }}>
        <button
          className="mm-btn primary"
          onClick={handleStart}
          disabled={isLoading || isCurrentRunning || !!blockedReason}
          title={blockedReason || 'Start the experiment'}
          style={{ justifyContent: 'center', height: '32px', cursor: canStart ? 'pointer' : 'not-allowed' }}
        >
          <Play size={14} strokeWidth={1.75} />
          Start experiment
        </button>

        <button
          className={`mm-btn${isCurrentRunning ? ' danger' : ''}`}
          onClick={handleStop}
          disabled={isLoading || !isCurrentRunning}
          style={{ justifyContent: 'center', height: '32px' }}
        >
          <Square size={13} strokeWidth={1.75} />
          Stop experiment
        </button>
      </div>
    </div>
  );
}
