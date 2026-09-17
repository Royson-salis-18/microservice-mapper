import { useState, useEffect } from 'react';
import type { Target, DiscoveredService, DiscoveredEndpoint, DiscoveredRoute, TargetDiscoverySummary } from '../types';

interface TrafficControlPanelProps {
  onClose?: () => void;
}

export function TrafficControlPanel({ onClose }: TrafficControlPanelProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string>('sock-shop');
  const [workloadSource, setWorkloadSource] = useState<'EXTERNAL' | 'USER_SIM'>('EXTERNAL');
  const [mode, setMode] = useState<'USER_JOURNEY' | 'ENDPOINT' | 'SERVICE'>('USER_JOURNEY');
  const [profile, setProfile] = useState<string>('baseline');
  const [duration, setDuration] = useState<string>('0');
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
  const [entryPoints, setEntryPoints] = useState<Record<string, { pinned: string | null; resolved: string | null }>>({});
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
          setSelectedEndpointId(eps[0].endpointId);
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
  const isEndpointReady = isResolvedConfigured && reachabilityStatus === 'REACHABLE';

  const runningDiag = diagnostics.find((d) => d.targetId === selectedTargetId && d.isRunning);
  const isCurrentRunning = !!runningDiag;
  const isAnyRunning = diagnostics.some((d) => d.isRunning);

  const selectedServiceRoutes = selectedServiceId ? routes.filter(r => r.serviceId === selectedServiceId) : routes;
  const isSelectedServiceCapable = selectedServiceId
    ? selectedServiceRoutes.some(r => r.trafficCapable)
    : true;

  const handleStart = async () => {
    if (!isEndpointReady || !isSelectedServiceCapable) return;
    setIsLoading(true);
    try {
      await fetch('/api/experiments/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: selectedTargetId,
          workloadSource,
          profile,
          mode,
          config: { durationSeconds: parseInt(duration, 10) },
          endpointId: selectedEndpointId || undefined,
          serviceId: selectedServiceId || undefined,
          routeId: selectedRouteId || undefined,
          limits: { cpuThreshold: 85, memoryThreshold: 85, errorRateThreshold: 0.1, latencyThreshold: 2000 }
        }),
      });
      await fetchData();
    } catch (e) {
      console.error('Failed to start experiment:', e);
    } finally {
      setIsLoading(false);
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
      setEntryMsg(d.reachable ? `OK — HTTP ${d.status} in ${d.ms}ms` : `Unreachable: ${d.error}`);
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
      setEntryMsg(d.pinned ? `OK — pinned to ${d.pinned}` : 'OK — pin cleared, using discovery');
      await fetchEntryPoints();
    } catch (e: any) {
      setEntryMsg(e.message);
    } finally {
      setEntryBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        width: '450px',
        maxHeight: '90vh',
        overflowY: 'auto',
        background: 'rgba(12, 12, 24, 0.95)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid var(--color-border)',
        borderRadius: '16px',
        padding: '20px',
        zIndex: 100,
        boxShadow: '0 20px 40px rgba(0,0,0,0.65), 0 0 24px rgba(0, 212, 255, 0.15)',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        fontFamily: 'var(--font-family)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: 'var(--color-accent-cyan)', fontSize: '16px' }}>⚡</span>
          <span style={{ fontWeight: 700, fontSize: '13px', letterSpacing: '1.5px', textTransform: 'uppercase', color: '#fff' }}>
            Workload Experiment Control
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', fontSize: '16px', cursor: 'pointer' }}>✕</button>
        )}
      </div>

      {/* Traffic-gen live status — makes it obvious whether the engine is
          actually up, since Node's own "isRunning" belief can go stale if
          traffic-gen crashes mid-run without Node finding out. */}
      <div style={{
        background: 'rgba(0,0,0,0.3)', border: '1px solid var(--color-border)', borderRadius: '10px',
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>Traffic Engine</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{
              width: '7px', height: '7px', borderRadius: '50%',
              background: trafficHealth?.reachable ? 'var(--color-healthy)' : 'var(--color-critical)',
              boxShadow: trafficHealth?.reachable ? '0 0 6px var(--color-healthy)' : '0 0 6px var(--color-critical)',
            }} />
            <span style={{ fontSize: '11px', fontWeight: 700, color: trafficHealth?.reachable ? 'var(--color-healthy)' : 'var(--color-critical)' }}>
              {trafficHealth === null ? 'CHECKING...' : trafficHealth.reachable ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
        </div>
        {trafficHealth?.reachable && trafficHealth.projects.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
            {trafficHealth.projects.map(p => (
              <div key={p.projectId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                <span style={{ color: p.running ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)', fontWeight: p.running ? 700 : 400 }}>
                  {p.running ? '● ' : '○ '}{p.projectId}
                </span>
                <span style={{ color: 'var(--color-text-muted)' }}>
                  {p.running && p.stats
                    ? `${p.stats.currentUsers} users, ${p.stats.currentRate.toFixed(1)} req/s, ${(p.stats.errorRate * 100).toFixed(0)}% err`
                    : 'idle'}
                </span>
              </div>
            ))}
          </div>
        )}
        {trafficHealth?.reachable === false && (
          <div style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
            not reachable at {trafficHealth.url || 'localhost:4400'} — it should auto-start with the server; check server logs if this persists
          </div>
        )}

        {/* Global kill switch. Stops every run the system can reach, including
            ones started outside this app or before the last server restart —
            not just whatever this panel happens to be showing. */}
        <button
          onClick={handleStopAll}
          disabled={isLoading}
          title="Stops synthetic traffic for every project, from any source"
          style={{
            marginTop: '8px',
            width: '100%',
            padding: '7px',
            background: anyProjectRunning ? 'rgba(255, 23, 68, 0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${anyProjectRunning ? 'rgba(255,23,68,0.45)' : 'var(--color-border)'}`,
            color: anyProjectRunning ? 'var(--color-critical)' : 'var(--color-text-muted)',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.5px',
            cursor: isLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {anyProjectRunning ? 'STOP ALL TRAFFIC (ALL PROJECTS)' : 'STOP ALL — nothing running'}
        </button>
      </div>

      {/* Entry point: what traffic is actually sent to. Discovery can only
          see what a container publishes, which isn't always reachable from
          here, so this can be pinned per project and proven with a probe. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
            Entry point — {selectedTargetId}
          </span>
          {entryPoints[selectedTargetId]?.pinned && (
            <span style={{ fontSize: '9px', color: 'var(--color-accent-cyan)', fontWeight: 700 }}>PINNED</span>
          )}
        </div>
        <input
          value={entryDraft}
          onChange={(e) => setEntryDraft(e.target.value)}
          placeholder={entryPoints[selectedTargetId]?.resolved || 'http://host:port'}
          style={{
            width: '100%', background: 'rgba(0,0,0,0.35)', border: '1px solid var(--color-border)',
            borderRadius: '5px', padding: '5px 7px', fontSize: '11px', color: '#fff', outline: 'none',
          }}
        />
        <div style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
          in use: {entryPoints[selectedTargetId]?.resolved || 'none resolved'}
          {!entryPoints[selectedTargetId]?.pinned && ' (inferred from discovery)'}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={handleProbeEntry}
            disabled={entryBusy}
            style={{ flex: 1, padding: '5px', background: 'rgba(0,212,255,0.12)', border: '1px solid rgba(0,212,255,0.3)', color: 'var(--color-accent-cyan)', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: entryBusy ? 'not-allowed' : 'pointer' }}
          >
            {entryBusy ? '...' : 'PROBE'}
          </button>
          <button
            onClick={() => handleSaveEntry()}
            disabled={entryBusy}
            style={{ flex: 1, padding: '5px', background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.3)', color: 'var(--color-healthy)', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: entryBusy ? 'not-allowed' : 'pointer' }}
          >
            SAVE
          </button>
          <button
            onClick={() => { setEntryDraft(''); handleSaveEntry(''); }}
            disabled={entryBusy}
            title="Clear the pin and fall back to discovery"
            style={{ padding: '5px 8px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: entryBusy ? 'not-allowed' : 'pointer' }}
          >
            CLEAR
          </button>
        </div>
        {entryMsg && (
          <div style={{ fontSize: '10px', color: entryMsg.startsWith('OK') ? 'var(--color-healthy)' : 'var(--color-critical)' }}>{entryMsg}</div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>TARGET AWS APP</label>
          <select
            value={selectedTargetId} disabled={isAnyRunning}
            onChange={(e) => setSelectedTargetId(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: isAnyRunning ? 'var(--color-text-dim)' : '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '12px', outline: 'none', cursor: isAnyRunning ? 'not-allowed' : 'pointer' }}
          >
            {targets.length > 0 ? targets.map(t => <option key={t.targetId} value={t.targetId}>{t.displayName || t.targetId}</option>) : <><option value="sock-shop">Sock Shop AWS</option><option value="vertikal">Vertikal AWS</option></>}
          </select>
        </div>
        <div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>WORKLOAD SOURCE</label>
          <select
            value={workloadSource}
            onChange={(e) => setWorkloadSource(e.target.value as any)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '12px', outline: 'none' }}
          >
            <option value="EXTERNAL">External Traffic Engine</option>
            <option value="USER_SIM" disabled>UNCONTROLLABLE (REMOTE USER_SIM)</option>
          </select>
          {selectedTargetId.includes('sock') && (
            <div style={{ fontSize: '9px', color: 'var(--color-text-dim)', marginTop: '4px' }}>
              Native User-Sim Status: OBSERVE ONLY (Via Telemetry)
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>EXPERIMENT PROFILE</label>
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '11px', outline: 'none' }}
          >
            <option value="baseline">BASELINE (2 req/s)</option>
            <option value="moderate">MODERATE (10 req/s)</option>
            <option value="heavy">HEAVY (25 req/s)</option>
            <option value="stress">STRESS (50 req/s, risk of crash)</option>
            <option value="ramp">RAMP (Dynamic increment)</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>DURATION (SECONDS)</label>
          <input
            type="number" value={duration} onChange={e => setDuration(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '11px', outline: 'none' }}
          />
        </div>
      </div>

      {workloadSource === 'EXTERNAL' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>ENTRY POINT</label>
              <select
                value={selectedEndpointId} onChange={(e) => setSelectedEndpointId(e.target.value)}
                style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '11px', outline: 'none' }}
              >
                {publicEndpoints.map(ep => <option key={ep.endpointId} value={ep.endpointId}>{ep.serviceName} :{ep.port}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>TRAFFIC MODE</label>
              <select
                value={mode} onChange={(e) => setMode(e.target.value as any)}
                style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '11px', outline: 'none' }}
              >
                <option value="USER_JOURNEY">User Journey Scenario</option>
                <option value="ENDPOINT">Specific Discovered Route</option>
                <option value="SERVICE">Service Public Workflow</option>
              </select>
            </div>
          </div>
          
          {mode === 'SERVICE' && (
            <div>
              <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>TARGET SERVICE</label>
              <select
                value={selectedServiceId} onChange={(e) => setSelectedServiceId(e.target.value)}
                style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '11px', outline: 'none' }}
              >
                <option value="">All Services</option>
                {services.map(svc => <option key={svc.serviceId} value={svc.serviceId}>{svc.name}</option>)}
              </select>
            </div>
          )}

          {mode === 'ENDPOINT' && (
            <div>
              <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '4px', fontWeight: 600 }}>TARGET ROUTE</label>
              <select
                value={selectedRouteId} onChange={(e) => setSelectedRouteId(e.target.value)}
                style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '11px', outline: 'none' }}
              >
                <option value="">Auto / All Discovered Routes</option>
                {routes.map(rt => <option key={rt.routeId} value={rt.routeId}>{rt.method} {rt.path}</option>)}
              </select>
            </div>
          )}
        </>
      )}

      {/* Discovery Status Note */}
      <div style={{ fontSize: '9px', color: 'var(--color-text-dim)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {summary && (
          <div style={{ textAlign: 'right' }}>
            Registry: {summary.servicesCount} services | {summary.publicEndpointsCount} endpoints
          </div>
        )}
        <div style={{ 
          textAlign: 'right', 
          color: reachabilityStatus === 'REACHABLE' ? 'var(--color-healthy)' : reachabilityStatus === 'CHECKING' ? 'var(--color-accent-cyan)' : 'var(--color-critical)',
          fontWeight: 600
        }}>
          {activeUrl ? `${activeUrl} [${reachabilityStatus}]` : 'ENDPOINT UNAVAILABLE'}
        </div>
      </div>

      {/* No auto-abort notice — these are failure-injection experiments;
          services are supposed to break, so nothing here auto-stops on
          high CPU/memory/error-rate. See ExperimentManager.checkSafetyLimits(). */}
      <div style={{ background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.25)', padding: '8px', borderRadius: '8px', fontSize: '10px', color: 'var(--color-accent-cyan)' }}>
        <strong>No auto-abort:</strong> experiments run until you stop them, even under heavy CPU/memory/error-rate — that's the point, for RCA and cascading-failure research.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '4px' }}>
        <button
          onClick={handleStart}
          disabled={isLoading || isCurrentRunning}
          style={{
            background: !isCurrentRunning ? 'linear-gradient(135deg, rgba(0,212,255,0.25), rgba(0,230,118,0.25))' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${!isCurrentRunning ? 'var(--color-accent-cyan)' : 'var(--color-border)'}`,
            color: !isCurrentRunning ? '#fff' : 'var(--color-text-dim)',
            padding: '8px 12px', borderRadius: '8px', fontWeight: 700, fontSize: '12px', letterSpacing: '1px',
            cursor: !isCurrentRunning ? 'pointer' : 'not-allowed', transition: 'all 0.2s',
          }}
        >
          ▶ START EXPERIMENT
        </button>

        <button
          onClick={handleStop}
          disabled={isLoading || !isCurrentRunning}
          style={{
            background: isCurrentRunning ? 'linear-gradient(135deg, rgba(255,23,68,0.25), rgba(224,64,251,0.25))' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${isCurrentRunning ? 'var(--color-critical)' : 'var(--color-border)'}`,
            color: isCurrentRunning ? '#fff' : 'var(--color-text-dim)',
            padding: '8px 12px', borderRadius: '8px', fontWeight: 700, fontSize: '12px', letterSpacing: '1px',
            cursor: isCurrentRunning ? 'pointer' : 'not-allowed', transition: 'all 0.2s',
          }}
        >
          ⏹ STOP EXPERIMENT
        </button>
      </div>

      {isCurrentRunning && runningDiag && runningDiag.trafficStatistics && (
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-accent-cyan)', fontWeight: 700, textTransform: 'uppercase', textAlign: 'center', marginBottom: '4px' }}>
            Live Generator Statistics
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', textAlign: 'center' }}>
            <div>
              <div style={{ fontSize: '9px', color: 'var(--color-text-dim)' }}>Attempted</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff' }}>{runningDiag.trafficStatistics.requestsAttempted}</div>
            </div>
            <div>
              <div style={{ fontSize: '9px', color: 'var(--color-healthy)' }}>Success</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff' }}>{runningDiag.trafficStatistics.requestsSuccessful}</div>
            </div>
            <div>
              <div style={{ fontSize: '9px', color: 'var(--color-critical)' }}>Failed</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff' }}>{runningDiag.trafficStatistics.requestsFailed}</div>
            </div>
            <div>
              <div style={{ fontSize: '9px', color: 'var(--color-accent-cyan)' }}>Current Rate</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff' }}>{runningDiag.trafficStatistics.peakRate}/s</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
