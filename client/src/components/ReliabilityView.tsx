import { useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import { PageShell, PageHeader, Panel, Stat, StatRow, EmptyNote, SPACE } from './ui/Panel';
import type { ServiceNode } from '../types';

/**
 * Reliability — current risk exposure per service, and a blast-radius
 * simulator for "what does this node's downstream footprint look like".
 *
 * Every number here is computed by server/graph/RiskEngine.ts from signals
 * this app already collects — status, the ML anomaly score, open incidents,
 * and observed edge traffic — through arithmetic visible in each row's
 * breakdown. It is not a prediction: there is no time dimension here and no
 * claim about the future, only "as of the last poll cycle, here is the
 * exposure this graph shows."
 *
 * Data rides the same graph the rest of the app already has live via
 * WebSocket (nodes are passed in, not re-fetched) — risk scores update with
 * everything else, on the same cadence, for free. The blast-radius simulation
 * is the one thing that goes to the server, since it needs the full edge set
 * scoped and BFS'd server-side, not just what's currently on screen.
 */

interface ReliabilityViewProps {
  selectedProject?: string;
  nodes: Node[];
}

interface BlastRadiusEntry {
  nodeId: string;
  nodeName: string;
  hopDistance: number;
  inboundActivitySamplesPerMin: number | null;
  dependentShareOfInbound: number | null;
}

interface BlastRadiusResult {
  nodeId: string;
  nodeName: string;
  project: string;
  generatedAt: string;
  basis: string;
  totalReachable: number;
  affected: BlastRadiusEntry[];
}

function riskTone(score: number): string {
  if (score > 0.8) return 'var(--color-critical)';
  if (score > 0.6) return 'var(--color-degraded)';
  return 'var(--color-healthy)';
}

function riskTint(score: number): { bg: string; border: string } {
  if (score > 0.8) return { bg: 'rgba(255,23,68,0.07)', border: 'rgba(255,23,68,0.35)' };
  if (score > 0.6) return { bg: 'rgba(255,171,0,0.06)', border: 'rgba(255,171,0,0.28)' };
  return { bg: 'rgba(0,0,0,0.2)', border: 'rgba(255,255,255,0.04)' };
}

function cleanName(id: string): string {
  return id.includes(':') ? id.split(':').slice(1).join(':') : id;
}

export function ReliabilityView({ selectedProject = 'ALL', nodes }: ReliabilityViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [simNodeId, setSimNodeId] = useState<string>('');
  const [sim, setSim] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; result: BlastRadiusResult }
  >({ status: 'idle' });

  const scoped = selectedProject !== 'ALL';

  const rows = useMemo(() => {
    return nodes
      .map(n => n.data as ServiceNode & Record<string, unknown>)
      .filter(d => !scoped || d.project === selectedProject)
      .filter(d => typeof d.analytics?.riskScore === 'number')
      .sort((a, b) => (b.analytics!.riskScore! - a.analytics!.riskScore!));
  }, [nodes, scoped, selectedProject]);

  const pending = useMemo(() => {
    return nodes
      .map(n => n.data as ServiceNode & Record<string, unknown>)
      .filter(d => !scoped || d.project === selectedProject)
      .filter(d => typeof d.analytics?.riskScore !== 'number').length;
  }, [nodes, scoped, selectedProject]);

  const runSimulation = async (nodeId: string) => {
    if (!nodeId) return;
    setSim({ status: 'loading' });
    try {
      const res = await fetch(`/api/reliability/blast-radius/${encodeURIComponent(nodeId)}`);
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
        Current risk exposure per service — how each one is doing right now, and how much of the
        system's live traffic structurally depends on it. Not a forecast: there is no time window
        here, only what the last poll cycle showed.
      </PageHeader>

      <Panel
        title="Risk ranking"
        subtitle={rows.length === 0 ? 'no data yet' : `${highCount} above 60%`}
        about={
          <>
            <strong>riskScore</strong> is half current health (status, the ML anomaly score if this
            service has a trained model, and whether it's part of an open incident) and half{' '}
            <strong>criticality</strong> — the share of this project's live observed traffic that
            flows through this node's downstream footprint. It is a composite of real signals, not a
            statistically calibrated probability of failure — nothing in this system tracks whether a
            predicted failure actually happened, so no field here claims to predict one.
            <br /><br />
            This is a different number from the "healthy %" shown on the Analytics tab — that one is
            a fleet-wide count of how many services currently have status healthy. This one is
            per-service and factors in anomaly detection and incident membership too.
            <br /><br />
            Click a row to see exactly which factors produced its score.
          </>
        }
      >
        {rows.length === 0 ? (
          <EmptyNote>
            No risk scores yet. RiskEngine recomputes every poll cycle — give it a few seconds after
            the target connects, or after the server restarts.
          </EmptyNote>
        ) : (
          <>
            <div style={{ marginBottom: SPACE.card }}>
              <StatRow>
                <Stat label="Services scored" value={rows.length} />
                <Stat label="Above 60% risk" value={highCount} tone={highCount ? 'var(--color-degraded)' : 'var(--color-healthy)'} />
                {pending > 0 && <Stat label="Awaiting first score" value={pending} sub="next poll cycle" />}
              </StatRow>
            </div>

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
                          health <span style={{ fontFamily: 'monospace' }}>{(a.healthScore! * 100).toFixed(0)}%</span>
                        </span>
                        <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                          crit. {a.criticality == null ? '—' : <span style={{ fontFamily: 'monospace' }}>{(a.criticality * 100).toFixed(0)}%</span>}
                        </span>
                        <span style={{
                          fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: riskTone(a.riskScore!),
                          minWidth: '46px', textAlign: 'right',
                        }}>
                          {(a.riskScore! * 100).toFixed(0)}%
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
                          {' '}centrality {a.centrality == null ? 'n/a (no observed edges in this project)' : `${(a.centrality * 100).toFixed(0)}%`}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Panel>

      <Panel
        title="Blast-radius simulator"
        subtitle="read-only — nothing on the target is touched"
        about={
          <>
            Picks a service and answers "if its traffic stopped flowing right now, what's downstream,
            and how much of each affected service's own inbound traffic runs through it." This is a
            graph traversal over already-observed connections, not a live test — no container is
            stopped or restarted.
            <br /><br />
            <strong>Direction caveat:</strong> observed edges come from each container's own socket
            scan, which cannot tell who initiated a connection — so a database can appear as the
            "source" of an edge to a service that calls it. This traversal follows the same
            source→target convention the RCA/Incidents propagation path uses, for consistency, but
            treat hop distance as structural adjacency rather than a guaranteed causal direction.
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
              background: 'rgba(0,212,255,0.12)', border: '1px solid var(--color-accent-cyan)', color: 'var(--color-accent-cyan)',
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
          sim.result.totalReachable === 0 ? (
            <EmptyNote>
              No downstream services are currently reachable from {cleanName(sim.result.nodeId)}'s observed traffic.
            </EmptyNote>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                {sim.result.totalReachable} service{sim.result.totalReachable === 1 ? '' : 's'} reachable downstream of{' '}
                <strong style={{ color: 'var(--color-text-main)' }}>{cleanName(sim.result.nodeId)}</strong>, based on observed edges.
              </div>
              {sim.result.affected.map(entry => (
                <div key={entry.nodeId} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                  padding: '10px 14px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)',
                  borderRadius: '8px', fontSize: '13px',
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{
                      fontSize: '10px', fontWeight: 700, color: 'var(--color-text-dim)',
                      background: 'rgba(255,255,255,0.05)', borderRadius: '4px', padding: '2px 6px',
                    }}>
                      {entry.hopDistance} hop{entry.hopDistance === 1 ? '' : 's'}
                    </span>
                    <span style={{ fontWeight: 600 }}>{cleanName(entry.nodeName)}</span>
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    {entry.dependentShareOfInbound === null
                      ? 'inbound traffic unmeasured'
                      : `${(entry.dependentShareOfInbound * 100).toFixed(0)}% of its inbound traffic`}
                  </span>
                </div>
              ))}
            </div>
          )
        )}

        {sim.status === 'idle' && (
          <EmptyNote>Pick a service above and simulate to see its downstream footprint.</EmptyNote>
        )}
      </Panel>
    </PageShell>
  );
}
