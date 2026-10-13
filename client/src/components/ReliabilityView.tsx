import { useEffect, useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import { PageShell, PageHeader, Panel, Stat, StatRow, EmptyNote, SPACE } from './ui/Panel';
import type { ServiceNode, CascadePrediction, NodeCascade, WhatIfResult, RiskBand } from '../types';

/**
 * Reliability — three questions, in the order an operator asks them:
 *
 *   1. What is likely to fail next?          (cascade prediction)
 *   2. What is exposed right now, and why?   (risk ranking)
 *   3. What if this one failed?              (what-if simulation)
 *
 * The prediction and the simulation come from the cascade model in
 * server/graph/CascadeEngine.ts: each service's measured state, spread along
 * weighted dependency edges. They are model estimates, and the page says so
 * with the model's name and parameter beside them — never presented as
 * observed frequencies. The risk ranking is plain arithmetic over measured
 * signals, with each score's factors one click away.
 */

interface ReliabilityViewProps {
  selectedProject?: string;
  nodes: Node[];
}

const BAND_COLOR: Record<RiskBand, string> = {
  high: 'var(--color-critical)',
  elevated: 'var(--color-degraded)',
  low: '#ffd400',
  minimal: 'var(--color-healthy)',
};

const BAND_TINT: Record<RiskBand, { bg: string; border: string }> = {
  high: { bg: 'rgba(255,23,68,0.07)', border: 'rgba(255,23,68,0.35)' },
  elevated: { bg: 'rgba(255,171,0,0.06)', border: 'rgba(255,171,0,0.28)' },
  low: { bg: 'rgba(255,212,0,0.04)', border: 'rgba(255,212,0,0.2)' },
  minimal: { bg: 'rgba(0,0,0,0.2)', border: 'rgba(255,255,255,0.04)' },
};

function riskTone(score: number): string {
  if (score > 0.8) return 'var(--color-critical)';
  if (score > 0.6) return 'var(--color-degraded)';
  return 'var(--color-healthy)';
}

function riskTint(score: number): { bg: string; border: string } {
  if (score > 0.8) return BAND_TINT.high;
  if (score > 0.6) return BAND_TINT.elevated;
  return BAND_TINT.minimal;
}

function cleanName(id: string): string {
  return id.includes(':') ? id.split(':').slice(1).join(':') : id;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** A 0..1 bar, coloured by band. */
function ProbabilityBar({ value, band, baseline }: { value: number; band: RiskBand; baseline?: number }) {
  return (
    <div style={{ position: 'relative', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden', flex: 1, minWidth: '60px' }}>
      {baseline !== undefined && baseline > 0 && (
        <div style={{ position: 'absolute', inset: 0, width: `${baseline * 100}%`, background: 'rgba(255,255,255,0.18)' }} />
      )}
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${(baseline ?? 0) * 100}%`, width: `${Math.max(value - (baseline ?? 0), 0) * 100}%`, background: BAND_COLOR[band] }} />
    </div>
  );
}

/** "frontend ← orders ← db": how risk reaches a service. */
function CascadePath({ path }: { path: string[] }) {
  if (path.length < 2) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', fontSize: '11px' }}>
      {path.map((name, i) => (
        <span key={`${name}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <span style={{
            padding: '1px 6px', borderRadius: '4px',
            background: i === path.length - 1 ? 'rgba(255,23,68,0.14)' : 'rgba(255,255,255,0.05)',
            color: i === path.length - 1 ? 'var(--color-critical)' : 'var(--color-text-muted)',
          }}>{name}</span>
          {i < path.length - 1 && <span style={{ color: 'var(--color-text-dim)' }}>←</span>}
        </span>
      ))}
    </span>
  );
}

function CascadeRow({ c, baseline }: { c: NodeCascade & { baseline?: number; delta?: number }; baseline?: boolean }) {
  const tint = BAND_TINT[c.band];
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '6px',
      padding: '10px 14px', background: tint.bg, border: `1px solid ${tint.border}`, borderRadius: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontWeight: 600, fontSize: '13px', minWidth: '120px' }}>{c.nodeName}</span>
        <ProbabilityBar value={c.probability} band={c.band} baseline={baseline ? c.baseline : undefined} />
        <span style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 700, color: BAND_COLOR[c.band], minWidth: '44px', textAlign: 'right' }}>
          {pct(c.probability)}
        </span>
        {baseline && c.delta !== undefined && (
          <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-text-muted)', minWidth: '52px', textAlign: 'right' }}>
            +{pct(c.delta)}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--color-text-muted)' }}>
        {c.depth > 0 ? (
          <>
            <span>{c.depth === 1 ? 'depends directly on' : `${c.depth} hops from`}</span>
            <CascadePath path={c.path} />
          </>
        ) : c.intrinsicReasons.length > 0 ? (
          <span>its own state: {c.intrinsicReasons.join('; ')}</span>
        ) : (
          <span>no measured problem of its own</span>
        )}
      </div>
    </div>
  );
}

export function ReliabilityView({ selectedProject = 'ALL', nodes }: ReliabilityViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [simNodeId, setSimNodeId] = useState<string>('');
  const [sim, setSim] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; result: WhatIfResult }
  >({ status: 'idle' });
  const [predictions, setPredictions] = useState<CascadePrediction[] | null>(null);

  const scoped = selectedProject !== 'ALL';

  // The prediction is recomputed server-side every poll cycle; the full
  // result (paths, reasons, model parameters) is not on the graph nodes, so it
  // is fetched on the same cadence rather than derived here.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/reliability/cascade');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPredictions(Array.isArray(data) ? data : [data]);
      } catch {
        // Server briefly unreachable — keep the last prediction on screen.
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const scopedPredictions = useMemo(
    () => (predictions ?? []).filter(p => !scoped || p.project === selectedProject),
    [predictions, scoped, selectedProject],
  );

  const atRisk = useMemo(
    () => scopedPredictions.flatMap(p => p.atRisk).sort((a, b) => b.probability - a.probability),
    [scopedPredictions],
  );

  const failingNow = useMemo(
    () => scopedPredictions.flatMap(p => p.nodes).filter(n => n.intrinsic >= 0.5).sort((a, b) => b.probability - a.probability),
    [scopedPredictions],
  );

  const expectedFailures = scopedPredictions.reduce((s, p) => s + p.expectedFailures, 0);
  const transmission = scopedPredictions[0]?.transmission;

  const rows = useMemo(() => {
    return nodes
      .map(n => n.data as ServiceNode & Record<string, unknown>)
      .filter(d => !scoped || d.project === selectedProject)
      .filter(d => typeof d.analytics?.riskScore === 'number')
      .sort((a, b) => (b.analytics!.riskScore! - a.analytics!.riskScore!));
  }, [nodes, scoped, selectedProject]);

  const runSimulation = async (nodeId: string) => {
    if (!nodeId) return;
    setSim({ status: 'loading' });
    try {
      const res = await fetch(`/api/reliability/whatif/${encodeURIComponent(nodeId)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSim({ status: 'error', message: body.error || `Request failed (${res.status})` });
        return;
      }
      setSim({ status: 'done', result: await res.json() });
    } catch (e: any) {
      setSim({ status: 'error', message: e?.message ?? 'Request failed' });
    }
  };

  const highCount = rows.filter(r => r.analytics!.riskScore! > 0.6).length;

  return (
    <PageShell>
      <PageHeader title="Reliability" scope={selectedProject}>
        What is likely to fail next, what is exposed right now, and what would happen if a given
        service went down — computed from live measurements and the weighted dependency graph.
      </PageHeader>

      {/* ---------------- 1. cascade prediction ---------------- */}
      <Panel
        title="Cascade prediction"
        subtitle={
          predictions === null ? 'loading'
          : atRisk.length > 0 ? `${atRisk.length} healthy service(s) at risk of being pulled down`
          : failingNow.length > 0 ? `${failingNow.length} failing — no healthy service predicted to follow`
          : 'nothing failing, nothing predicted'
        }
        about={
          <>
            Each service gets a failure probability from its own measured state — a crashed or
            crash-looping container, a recent restart, resource saturation, the anomaly model — and
            that risk then spreads to the services that <em>call</em> it, in proportion to how much
            they depend on it (the edge weight).
            <br /><br />
            <strong>Model:</strong> noisy-OR propagation. A caller's chance of being brought down
            is combined across its dependencies as independent routes to failure. The transmission
            factor{transmission !== undefined ? ` (τ = ${transmission})` : ''} is the share of a
            dependency's failure that actually reaches its caller — below 1 because real services
            retry, time out, and fall back.
            <br /><br />
            These are <strong>model estimates</strong>, not observed frequencies: the system does
            not yet record whether a predicted failure happened, so nothing has been calibrated.
            What is guaranteed is that the ranking is driven only by measured state and measured
            traffic.
          </>
        }
      >
        {predictions === null ? (
          <EmptyNote>Loading the latest prediction…</EmptyNote>
        ) : scopedPredictions.length === 0 ? (
          <EmptyNote>No prediction yet. It is recomputed every poll cycle once a target is sending telemetry.</EmptyNote>
        ) : (
          <>
            <div style={{ marginBottom: SPACE.card }}>
              <StatRow>
                <Stat label="Failing now" value={failingNow.length} tone={failingNow.length ? 'var(--color-critical)' : 'var(--color-healthy)'} />
                <Stat label="At risk next" value={atRisk.length} tone={atRisk.length ? 'var(--color-degraded)' : 'var(--color-healthy)'} />
                <Stat label="Expected failures" value={expectedFailures.toFixed(1)} hint="Sum of every service's predicted probability — the model's expected number of failed services" />
                {transmission !== undefined && <Stat label="Transmission τ" value={transmission} sub="model parameter" />}
              </StatRow>
            </div>

            {failingNow.length > 0 && (
              <div style={{ marginBottom: SPACE.card }}>
                <div style={{ fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: '8px' }}>
                  Origin — failing on its own measurements
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {failingNow.map(c => <CascadeRow key={c.nodeId} c={c} />)}
                </div>
              </div>
            )}

            <div style={{ fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: '8px' }}>
              Predicted to be pulled down
            </div>
            {atRisk.length === 0 ? (
              <EmptyNote>
                No healthy service is currently exposed to a failing dependency. Risk only spreads from
                something that is measurably failing.
              </EmptyNote>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {atRisk.map(c => <CascadeRow key={c.nodeId} c={c} />)}
              </div>
            )}
          </>
        )}
      </Panel>

      {/* ---------------- 2. risk ranking ---------------- */}
      <Panel
        title="Risk ranking"
        subtitle={rows.length === 0 ? 'no data yet' : `${highCount} above 60%`}
        about={
          <>
            <strong>riskScore</strong> is half current health (status, the anomaly model if the
            service has a trained model, and whether it is part of an open incident) and half{' '}
            <strong>criticality</strong> — the share of this project's live traffic that would stop
            if the service failed. It is exposure now, not a prediction.
            <br /><br />
            This differs from the "healthy %" on the Analytics tab, which is a fleet-wide count of
            services currently marked healthy.
            <br /><br />
            Click a row to see exactly which factors produced its score.
          </>
        }
        collapsible
      >
        {rows.length === 0 ? (
          <EmptyNote>
            No risk scores yet. They are recomputed every poll cycle — give it a few seconds after the
            target connects, or after the server restarts.
          </EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {rows.map(node => {
              const a = node.analytics!;
              const tint = riskTint(a.riskScore!);
              const expanded = expandedId === node.id;
              return (
                <div key={node.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : node.id)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px',
                      background: tint.bg, border: `1px solid ${tint.border}`,
                      borderRadius: expanded ? '10px 10px 0 0' : '10px', padding: '12px 14px',
                      cursor: 'pointer', textAlign: 'left', color: 'var(--color-text-main)', fontSize: '13px',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cleanName(node.id)}</span>
                      {!scoped && <span style={{ fontSize: '10px', color: 'var(--color-text-dim)' }}>{node.project}</span>}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
                      <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                        health <span style={{ fontFamily: 'monospace' }}>{pct(a.healthScore!)}</span>
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                        crit. {a.criticality === null || a.criticality === undefined ? '—' : <span style={{ fontFamily: 'monospace' }}>{pct(a.criticality)}</span>}
                      </span>
                      <span style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: riskTone(a.riskScore!), minWidth: '46px', textAlign: 'right' }}>
                        {pct(a.riskScore!)}
                      </span>
                    </span>
                  </button>
                  {expanded && (
                    <div style={{
                      background: 'rgba(0,0,0,0.2)',
                      // Longhand rather than `border` + `borderTop: none` — React warns when a
                      // shorthand and its longhand are both set on a re-rendering element.
                      borderLeft: `1px solid ${tint.border}`,
                      borderRight: `1px solid ${tint.border}`,
                      borderBottom: `1px solid ${tint.border}`,
                      borderRadius: '0 0 10px 10px', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px',
                    }}>
                      {(a.healthBreakdown ?? []).map((b, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px' }}>
                          <span style={{ color: 'var(--color-text-muted)' }}>{b.reason}</span>
                          <span style={{ fontFamily: 'monospace', color: 'var(--color-text-main)' }}>{b.score.toFixed(2)}</span>
                        </div>
                      ))}
                      <div style={{ fontSize: '11px', color: 'var(--color-text-dim)', marginTop: '4px' }}>
                        {a.upstreamCount ?? 0} upstream · {a.downstreamCount ?? 0} downstream ·
                        {' '}centrality {a.centrality === null || a.centrality === undefined ? 'n/a (no observed edges in this project)' : pct(a.centrality)}
                        {typeof a.failureProbability === 'number' && <> · predicted failure {pct(a.failureProbability)}</>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* ---------------- 3. what-if ---------------- */}
      <Panel
        title="What if this failed?"
        subtitle="read-only simulation — nothing on the target is touched"
        about={
          <>
            Assumes the chosen service fails outright, keeps every other service at its measured
            state, and runs the same cascade model. Each affected service shows its predicted
            probability with the part it already had shaded, so the added risk is what this failure
            causes on its own.
            <br /><br />
            Failure travels to whatever <em>calls</em> the failed service, so the path reads
            upward: <code>frontend ← orders ← db</code> means the frontend is exposed because it
            calls orders, which calls the database.
            <br /><br />
            <strong>How direction is known:</strong> in each container's socket table, the end
            holding the <em>listening</em> port is the one being called. Links where that cannot be
            decided are down-weighted rather than guessed.
          </>
        }
      >
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: SPACE.tight }}>
          <select
            value={simNodeId}
            onChange={e => setSimNodeId(e.target.value)}
            style={{
              background: 'var(--color-bg-body)', color: 'var(--color-text-main)',
              border: '1px solid var(--color-border)', borderRadius: '8px', padding: '8px 10px', fontSize: '13px', minWidth: '220px',
            }}
          >
            <option value="">Select a service…</option>
            {rows.map(n => (
              <option key={n.id} value={n.id}>{cleanName(n.id)}{!scoped ? ` (${n.project})` : ''}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!simNodeId || sim.status === 'loading'}
            onClick={() => runSimulation(simNodeId)}
            style={{
              background: 'rgba(107,128,255,0.12)', border: '1px solid var(--color-accent-cyan)', color: 'var(--color-accent-cyan)',
              borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: 600,
              cursor: !simNodeId || sim.status === 'loading' ? 'not-allowed' : 'pointer',
              opacity: !simNodeId || sim.status === 'loading' ? 0.5 : 1,
            }}
          >
            {sim.status === 'loading' ? 'Simulating…' : 'Simulate failure'}
          </button>
        </div>

        {sim.status === 'error' && (
          <EmptyNote>Could not run the simulation: {sim.message}</EmptyNote>
        )}

        {sim.status === 'done' && (
          sim.result.affected.length === 0 ? (
            <EmptyNote>
              Nothing observed depends on {sim.result.origin.nodeName} — no other service was seen calling
              it, so its failure would not spread anywhere we can see.
            </EmptyNote>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ marginBottom: SPACE.tight }}>
                <StatRow>
                  <Stat label="Services affected" value={sim.result.affected.length} tone="var(--color-degraded)" />
                  <Stat
                    label="Expected additional failures"
                    value={sim.result.expectedAdditionalFailures.toFixed(1)}
                    tone={sim.result.expectedAdditionalFailures >= 1 ? 'var(--color-critical)' : 'var(--color-degraded)'}
                    hint="Sum of the added failure probability across every affected service"
                  />
                  <Stat label="Deepest reach" value={`${Math.max(...sim.result.affected.map(a => a.depth))} hops`} />
                </StatRow>
              </div>
              {sim.result.affected.map(c => <CascadeRow key={c.nodeId} c={c} baseline />)}
            </div>
          )
        )}

        {sim.status === 'idle' && (
          <EmptyNote>Pick a service and simulate its failure to see how far it would spread.</EmptyNote>
        )}
      </Panel>
    </PageShell>
  );
}
