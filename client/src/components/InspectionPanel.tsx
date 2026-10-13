import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Radar, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { DependencyEdge, Incident, ServiceNode, WhatIfResult } from '../types';
import { MiniChart } from './MiniChart';
import { useMetrics } from '../hooks/useMetrics';
import { edgeAppearance } from './shared/edgeHeat';
import { cpuBasis, cpuShown, loadColor, shortName, statusVisual, typeVisual } from './shared/serviceVisuals';
import { Bar, Card, PanelHead, Ring, Row, formatBytes, formatRate } from './inspect/parts';
import { EgoMap } from './inspect/EgoMap';

interface InspectionPanelProps {
  node: ServiceNode | null;
  edges: DependencyEdge[];
  nodesById: Map<string, ServiceNode>;
  onClose: () => void;
  /** Move the inspection to another service (a neighbour, a root cause). */
  onSelectNode: (id: string) => void;
}

const RANGES = ['5m', '15m', '30m', '1h'];
const INCIDENT_POLL_MS = 10_000;

function bandColor(p: number): string {
  return p >= 0.7 ? '#ff3d5e' : p >= 0.4 ? '#ffab40' : p >= 0.15 ? '#8b9cff' : '#5b7cff';
}

/**
 * The active incident on this service's project, if there is one. Polled while
 * the panel is open; incidents are small and already computed server-side.
 */
function useProjectIncident(project: string | undefined): Incident | null {
  const [incident, setIncident] = useState<Incident | null>(null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/incidents?targetId=${encodeURIComponent(project)}`);
        if (!res.ok) return;
        const list: Incident[] = await res.json();
        const active = list.find((i) => i.status !== 'RESOLVED' && i.status !== 'NORMAL') ?? null;
        if (alive) setIncident(active);
      } catch { /* the panel still works without it */ }
    };
    load();
    const t = setInterval(load, INCIDENT_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [project]);
  return incident;
}

/** What this service is to the incident: its cause, a suspect, or a victim. */
function roleIn(incident: Incident | null, id: string) {
  if (!incident) return null;
  const candidate = incident.candidateCauses?.find((c) => c.serviceId === id);
  if (incident.rootCauseServiceId === id) return { kind: 'root' as const, candidate };
  if (candidate) return { kind: 'candidate' as const, candidate };
  if (incident.affectedServices?.includes(id)) return { kind: 'affected' as const, candidate };
  return { kind: 'uninvolved' as const, candidate };
}

function DependencyRows({ items, direction, nodesById, onSelect }: {
  items: DependencyEdge[];
  direction: 'calls' | 'calledBy';
  nodesById: Map<string, ServiceNode>;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return <div className="insp-empty">{direction === 'calls' ? 'Calls nothing that has been observed.' : 'No callers observed.'}</div>;
  return (
    <div>
      {items.map((e) => {
        const otherId = direction === 'calls' ? e.target : e.source;
        const other = nodesById.get(otherId);
        const look = edgeAppearance(e, { targetStatus: nodesById.get(e.target)?.status });
        const w = e.weight?.value ?? 0;
        return (
          <button key={e.id} type="button" className="insp-dep" onClick={() => onSelect(otherId)} title={`${look.label}${e.weight ? ` · weight ${w.toFixed(2)}` : ''}`}>
            <span className="insp-dot" style={{ color: statusVisual(other?.status).color, width: 6, height: 6 }} />
            <span className="insp-dep-name">{other?.name ?? shortName(otherId)}</span>
            <Bar value={e.weight?.kind === 'telemetry' ? 0.04 : w} color={look.color} />
            <span className="insp-dep-rate">{e.activity ? `${formatRate(e.activity.samplesPerMin)}/m` : e.observed ? 'seen' : 'declared'}</span>
          </button>
        );
      })}
    </div>
  );
}

export function InspectionPanel({ node, edges, nodesById, onClose, onSelectNode }: InspectionPanelProps) {
  const [timeRange, setTimeRange] = useState('15m');
  const { data: metrics } = useMetrics(node?.id || null, timeRange);
  const incident = useProjectIncident(node?.project);
  const [whatIf, setWhatIf] = useState<WhatIfResult | null>(null);
  const [whatIfBusy, setWhatIfBusy] = useState(false);
  const [whatIfError, setWhatIfError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A different service is a different question.
  useEffect(() => { setWhatIf(null); setWhatIfError(null); setCopied(false); }, [node?.id]);

  // Edge direction: source calls target. "Calls" are this service's own
  // dependencies (a failure there reaches it); "called by" are the services
  // that depend on it (a failure here reaches them).
  const calls = useMemo(() => node ? edges.filter((e) => e.source === node.id).sort((a, b) => (b.weight?.value ?? 0) - (a.weight?.value ?? 0)) : [], [edges, node]);
  const calledBy = useMemo(() => node ? edges.filter((e) => e.target === node.id).sort((a, b) => (b.weight?.value ?? 0) - (a.weight?.value ?? 0)) : [], [edges, node]);

  if (!node) return null;

  const type = typeVisual(node.type);
  const status = statusVisual(node.status);
  const cpu = cpuShown(node.metrics);
  const mem = node.metrics?.memoryPercent;
  const a = node.analytics ?? {};
  const p = typeof a.failureProbability === 'number' ? a.failureProbability : null;
  const role = roleIn(incident, node.id);
  const container = node.metadata?.containerName || node.metadata?.containerId?.slice(0, 12) || node.name;
  const restartCommand = `docker restart ${container}`;

  const runWhatIf = async () => {
    setWhatIfBusy(true);
    setWhatIfError(null);
    try {
      const res = await fetch(`/api/reliability/whatif/${encodeURIComponent(node.id)}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'No cascade model for this project yet' : 'Simulation failed');
      setWhatIf(await res.json());
    } catch (err: any) {
      setWhatIfError(err?.message ?? 'Simulation failed');
    } finally {
      setWhatIfBusy(false);
    }
  };

  const copyRestart = async () => {
    try {
      await navigator.clipboard.writeText(restartCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked: the command is visible in the tooltip */ }
  };

  return (
    <aside className="insp" aria-label={`${node.name} details`}>
      <PanelHead icon={type.icon} tint={type.color} title={node.name} sub={`${node.project} · ${type.label}`} onClose={onClose} />

      <div className="insp-body">
        {/* At a glance: state, CPU, memory */}
        <div className="insp-trio">
          <div>
            <div className="insp-label">Status</div>
            <div className="insp-value" style={{ color: status.color }}>
              <span className="insp-dot" />
              <span style={{ fontSize: 13 }}>{status.label}</span>
            </div>
          </div>
          <div title={cpuBasis(node.metrics)}>
            <div className="insp-label">
              CPU{node.metrics?.cpuAllowanceCores ? ` · of ${Math.round(node.metrics.cpuAllowanceCores * 100) / 100} cores` : ''}
            </div>
            <div className="insp-value">
              {cpu === undefined ? '—' : <>{cpu.toFixed(1)}<span className="insp-unit">%</span></>}
              {cpu !== undefined && <Ring value={cpu / 100} color={loadColor(cpu)} size={24} />}
            </div>
          </div>
          <div title="Share of the container's memory limit (the host's memory if it has none)">
            <div className="insp-label">Memory</div>
            <div className="insp-value">
              {mem === undefined ? '—' : <>{mem.toFixed(1)}<span className="insp-unit">%</span></>}
              {mem !== undefined && <Ring value={mem / 100} color={loadColor(mem)} size={24} />}
            </div>
          </div>
        </div>

        {node.metadata?.statusReason && node.status !== 'healthy' && (
          <div className="insp-chip" style={{ alignSelf: 'flex-start', color: status.color, borderColor: `${status.color}55`, background: `${status.color}14` }}>
            {String(node.metadata.statusReason)}
          </div>
        )}

        {/* Hero: the service among its neighbours */}
        <div className="insp-hero">
          <EgoMap node={node} edges={edges} nodesById={nodesById} onSelect={onSelectNode} />
        </div>

        {/* Incident role, from the RCA engine's active incident */}
        {role && role.kind !== 'uninvolved' ? (
          <Card
            title="Incident"
            tone={role.kind === 'root' ? 'alert' : 'warn'}
            right={<span className="insp-chip" style={{ color: role.kind === 'root' ? '#ff6b85' : '#ffc070' }}>{incident!.confidence} confidence</span>}
          >
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
              {role.kind === 'root' && 'Named as the root cause'}
              {role.kind === 'candidate' && `A suspect (score ${role.candidate!.score.toFixed(2)}), not the named cause`}
              {role.kind === 'affected' && 'Affected by the incident'}
            </div>
            {role.kind !== 'root' && (
              <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                Named cause:{' '}
                {incident!.rootCauseServiceId
                  ? <button type="button" className="insp-chip accent" style={{ cursor: 'pointer' }} onClick={() => onSelectNode(incident!.rootCauseServiceId!)}>{shortName(incident!.rootCauseServiceId)}</button>
                  : 'undetermined'}
              </div>
            )}
            {/* The explanation is written about the named cause, so it is
                shown only on that service's own panel. */}
            {role.kind === 'root' && incident!.explanation?.why && (
              <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{incident!.explanation.why}</div>
            )}
            {role.candidate && role.candidate.scoreBreakdown.length > 0 && (
              <div className="insp-chips" style={{ marginTop: 9 }}>
                {role.candidate.scoreBreakdown.map((f) => (
                  <span key={f.factor} className="insp-chip" title={f.reason} style={{ color: f.score < 0 ? '#ff8aa0' : '#c9d0ff' }}>
                    {f.factor.replace(/_/g, ' ')} {f.score >= 0 ? '+' : ''}{f.score.toFixed(2)}
                  </span>
                ))}
              </div>
            )}
          </Card>
        ) : (
          <Card title="Incident">
            <div className="insp-empty" style={{ padding: 0 }}>
              {incident ? `Not involved in the active incident on ${node.project}.` : `No active incident on ${node.project}.`}
            </div>
          </Card>
        )}

        {/* Reliability: prediction and exposure */}
        <Card title="Reliability" right={<span style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>cascade model</span>}>
          <div className="insp-row" style={{ marginBottom: 5 }}>
            <span className="k">Predicted failure</span>
            <span className="v" style={{ color: p === null ? undefined : bandColor(p) }}>{p === null ? 'not computed yet' : `${Math.round(p * 100)}%`}</span>
          </div>
          <Bar value={p ?? 0} color={bandColor(p ?? 0)} />
          <div style={{ fontSize: 10, color: 'var(--color-text-dim)', marginTop: 5 }}>
            {p === null ? 'Appears after the first poll cycle.'
              : a.cascadeVia ? <>Mostly inherited via <button type="button" className="insp-chip accent" style={{ cursor: 'pointer', padding: '1px 7px' }} onClick={() => onSelectNode(String(a.cascadeVia))}>{shortName(String(a.cascadeVia))}</button></>
              : 'From its own measured state.'}
          </div>

          <div style={{ height: 10 }} />
          <Row k="Risk (current exposure)" v={typeof a.riskScore === 'number' ? `${Math.round(a.riskScore * 100)}%` : '—'} title="Half current health, half how much traffic depends on it. Not a probability." />
          <Row k="Traffic disrupted if it fails" v={typeof a.criticality === 'number' ? `${Math.round(a.criticality * 100)}%` : '—'} title="Expected share of this project's traffic lost if this service fails from a clean state." />
          <Row k="Health score" v={typeof a.healthScore === 'number' ? `${Math.round(a.healthScore * 100)}%` : '—'} />
          {a.anomalyScore !== undefined && <Row k="ML anomaly score" v={<span style={{ color: a.anomalyPersistent ? '#ff3d5e' : undefined }}>{Math.round(a.anomalyScore * 100)}%{a.anomalyPersistent ? ' · sustained' : ''}</span>} />}
          {a.healthBreakdown && a.healthBreakdown.length > 0 && (
            <div className="insp-chips" style={{ marginTop: 9 }}>
              {a.healthBreakdown.map((f) => (
                <span key={f.factor} className="insp-chip" title={f.reason}>{f.factor} {f.score.toFixed(2)}</span>
              ))}
            </div>
          )}
        </Card>

        {/* What-if, on request */}
        {(whatIf || whatIfError) && (
          <Card
            title={`If ${node.name} went down`}
            tone={whatIf && whatIf.expectedAdditionalFailures >= 1 ? 'warn' : undefined}
            right={<button type="button" className="insp-chip" style={{ cursor: 'pointer' }} onClick={() => { setWhatIf(null); setWhatIfError(null); }}>hide</button>}
          >
            {whatIfError ? <div className="insp-empty" style={{ padding: 0 }}>{whatIfError}</div> : whatIf && (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 }}>
                  <span style={{ fontSize: 22, fontWeight: 700 }}>+{whatIf.expectedAdditionalFailures < 1 ? whatIf.expectedAdditionalFailures.toFixed(2) : whatIf.expectedAdditionalFailures.toFixed(1)}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>expected additional failures (τ = {whatIf.transmission})</span>
                </div>
                {whatIf.affected.filter((x) => x.delta > 0.005).slice(0, 6).map((x) => (
                  <button key={x.nodeId} type="button" className="insp-dep" style={{ gridTemplateColumns: '1fr 90px 40px' }} onClick={() => onSelectNode(x.nodeId)}>
                    <span className="insp-dep-name">{x.nodeName}</span>
                    <Bar value={x.probability} baseline={x.baseline} color={bandColor(x.probability)} />
                    <span className="insp-dep-rate" style={{ color: bandColor(x.probability) }}>{Math.round(x.probability * 100)}%</span>
                  </button>
                ))}
                {whatIf.affected.every((x) => x.delta <= 0.005) && <div className="insp-empty" style={{ padding: 0 }}>Nothing else is measurably exposed.</div>}
                <div style={{ fontSize: 10, color: 'var(--color-text-dim)', marginTop: 8 }}>Grey = today's risk, colour = with this service down. Read-only: nothing on the target is touched.</div>
              </>
            )}
          </Card>
        )}

        {/* Live history */}
        <Card
          title="Metrics history"
          right={
            <div className="insp-pills" role="tablist" aria-label="Time range">
              {RANGES.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={timeRange === t} className={timeRange === t ? 'active' : ''} onClick={() => setTimeRange(t)}>{t}</button>
              ))}
            </div>
          }
        >
          <div className="insp-label">CPU</div>
          <MiniChart data={metrics} dataKey="cpu" color="#5d7bff" />
          <div className="insp-label" style={{ marginTop: 10 }}>Memory</div>
          <MiniChart data={metrics} dataKey="memoryPercent" color="#a07bff" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
            <div className="insp-row" style={{ background: 'rgba(0,0,0,0.2)', padding: '7px 9px', borderRadius: 9, margin: 0 }}>
              <span className="k" style={{ display: 'flex', alignItems: 'center', gap: 5 }}><ArrowDownLeft size={12} color="#25e3a3" /> RX</span>
              <span className="v" title={node.metrics?.networkRx !== undefined ? `${formatBytes(node.metrics.networkRx)} received since the container started` : undefined}>{node.metrics?.networkRxRate !== undefined ? `${formatBytes(node.metrics.networkRxRate)}/s` : '—'}</span>
            </div>
            <div className="insp-row" style={{ background: 'rgba(0,0,0,0.2)', padding: '7px 9px', borderRadius: 9, margin: 0 }}>
              <span className="k" style={{ display: 'flex', alignItems: 'center', gap: 5 }}><ArrowUpRight size={12} color="#6b80ff" /> TX</span>
              <span className="v" title={node.metrics?.networkTx !== undefined ? `${formatBytes(node.metrics.networkTx)} sent since the container started` : undefined}>{node.metrics?.networkTxRate !== undefined ? `${formatBytes(node.metrics.networkTxRate)}/s` : '—'}</span>
            </div>
          </div>
        </Card>

        {/* Request-level metrics: only when a Tier 1/2 source supplied them,
            labelled with where they came from. CPU is measured by the kernel;
            latency by whatever the target runs. Not the same kind of fact. */}
        {node.metrics?.provenance && (
          <Card
            title="Request metrics"
            right={<span className="insp-chip accent" title={node.metrics.provenance.detail || ''}>tier {node.metrics.provenance.tier} · {node.metrics.provenance.source}</span>}
          >
            {([
              ['p50 latency', node.metrics.latencyP50, 'ms'],
              ['p95 latency', node.metrics.latencyP95, 'ms'],
              ['p99 latency', node.metrics.latencyP99, 'ms'],
              ['Request rate', node.metrics.requestRate, '/s'],
            ] as [string, number | null | undefined, string][]).map(([label, value, unit]) => (
              <Row key={label} k={label} v={value === null || value === undefined ? <span style={{ color: 'var(--color-text-dim)' }}>not measured</span> : `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${unit}`} />
            ))}
            {/* null means no traffic in the window, which is not 0%. */}
            <Row
              k="Error rate"
              v={node.metrics.errorRate === null || node.metrics.errorRate === undefined
                ? <span style={{ color: 'var(--color-text-dim)' }}>no traffic in window</span>
                : <span style={{ color: node.metrics.errorRate > 0 ? '#ff3d5e' : undefined }}>{(node.metrics.errorRate * 100).toFixed(2)}%</span>}
            />
          </Card>
        )}

        <Card title={`Calls · ${calls.length}`} right={<span style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>its dependencies</span>}>
          <DependencyRows items={calls} direction="calls" nodesById={nodesById} onSelect={onSelectNode} />
        </Card>

        <Card title={`Called by · ${calledBy.length}`} right={<span style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>depend on it</span>}>
          <DependencyRows items={calledBy} direction="calledBy" nodesById={nodesById} onSelect={onSelectNode} />
        </Card>

        <Card title="Container">
          <Row k="Container" v={<span className="insp-mono">{node.metadata?.containerId?.slice(0, 12) || '—'}</span>} />
          {node.metadata?.image && <Row k="Image" v={<span className="insp-mono" style={{ wordBreak: 'break-all' }}>{node.metadata.image}</span>} />}
          <Row k="State" v={node.metadata?.state ?? '—'} />
          <Row k="Uptime" v={node.metadata?.uptime ?? (typeof node.metadata?.uptimeSeconds === 'number' ? `${Math.round(node.metadata.uptimeSeconds / 60)} min` : '—')} />
          <Row k="Restarts" v={node.metadata?.restartCount ?? '—'} />
          {node.metadata?.ports && node.metadata.ports.length > 0 && (
            <div className="insp-chips" style={{ marginTop: 9 }}>
              {/* Docker lists a port once per address family, so dedupe. */}
              {[...new Set(node.metadata.ports.map(String))].slice(0, 12).map((port) => <span key={port} className="insp-chip insp-mono">{port}</span>)}
            </div>
          )}
        </Card>
      </div>

      <div className="insp-actions">
        <button type="button" className="insp-btn" onClick={runWhatIf} disabled={whatIfBusy} title="Run the cascade model with this service failed. Read-only: nothing on the target is touched.">
          <Radar size={15} /> {whatIfBusy ? 'Simulating…' : 'Simulate failure'}
        </button>
        <button type="button" className={`insp-btn ${node.status !== 'healthy' ? 'danger' : ''}`} onClick={copyRestart} title={restartCommand}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy restart command'}
        </button>
      </div>
    </aside>
  );
}
