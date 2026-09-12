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

      {/* Safety Notice */}
      <div style={{ background: 'rgba(255,171,0,0.1)', border: '1px solid rgba(255,171,0,0.3)', padding: '8px', borderRadius: '8px', fontSize: '10px', color: 'var(--color-degraded)' }}>
        <strong>Safety Limits Active:</strong> Experiments will automatically abort if CPU/Memory exceeds 85% on any target instance to prevent cascading failure.
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
