import { useState, useEffect, useMemo, type CSSProperties } from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';
import type { Node, Edge } from '@xyflow/react';
import type { ServiceNode, DependencyEdge } from '../types';
import { pageRootStyle } from './ProjectSections';

interface AnalyticsViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
  /** Rendered inside a per-project stack: the wrapper owns scroll + height. */
  embedded?: boolean;
}

export function AnalyticsView({ nodes, edges, selectedProject, embedded = false }: AnalyticsViewProps) {
  const [rcaData, setRcaData] = useState<any>(null);

  const serviceNodes = useMemo(() => {
    return nodes
      .map(n => n.data as unknown as ServiceNode)
      .filter(n => {
        if (selectedProject !== 'ALL' && n.project !== selectedProject.toLowerCase()) return false;
        return true;
      });
  }, [nodes, selectedProject]);

  const parsedEdges = useMemo(() => {
    return edges.map(e => e.data as unknown as DependencyEdge);
  }, [edges]);

  useEffect(() => {
    const url = selectedProject !== 'ALL' ? `/api/incidents?targetId=${selectedProject.toLowerCase()}` : '/api/incidents';
    fetch(url)
      .then(res => res.json())
      .then(incidents => {
        if (incidents && incidents.length > 0) {
          const inc = incidents[0];
          setRcaData({
            incidentDetected: true,
            timestamp: inc.startedAt,
            primaryRootCauses: inc.candidateCauses?.slice(0, 1).map((c: any) => ({
              nodeId: c.serviceId,
              name: c.serviceName,
              status: 'critical',
              failureReason: inc.explanation?.whatHappened || 'Anomaly detected',
              evidence: inc.evidence ? inc.evidence.map((ev: any) => ev.description) : []
            })) || [],
            blastRadius: {
              affectedServices: inc.affectedServices ? inc.affectedServices.map((id: string) => id.replace(/^(sock-shop|vertikal)-/, '')) : []
            },
            remediationGuide: (inc.remediationGuide && inc.remediationGuide.length > 0) ? inc.remediationGuide.join(' && ') : `docker restart ${inc.rootCauseServiceId}`
          });
        } else {
          setRcaData(null);
        }
      })
      .catch(() => setRcaData(null));
  }, [nodes, edges, selectedProject]);

  // Compute Analytics Metrics
  const analytics = useMemo(() => {
    const total = serviceNodes.length;
    const healthy = serviceNodes.filter(n => n.status === 'healthy').length;
    const degraded = serviceNodes.filter(n => n.status === 'degraded').length;
    const critical = serviceNodes.filter(n => n.status === 'critical').length;

    const healthScore = total > 0 ? Math.round((healthy / total) * 100) : 100;

    const topCpu = [...serviceNodes]
      .sort((a, b) => (b.metrics?.cpu || 0) - (a.metrics?.cpu || 0))
      .slice(0, 5);

    const topMem = [...serviceNodes]
      .sort((a, b) => (b.metrics?.memoryPercent || 0) - (a.metrics?.memoryPercent || 0))
      .slice(0, 5);

    const connectionCounts: Record<string, { node: ServiceNode; degree: number; upstream: number; downstream: number }> = {};
    serviceNodes.forEach(n => {
      connectionCounts[n.id] = { node: n, degree: 0, upstream: 0, downstream: 0 };
    });

    parsedEdges.forEach(e => {
      if (connectionCounts[e.source]) {
        connectionCounts[e.source].degree++;
        connectionCounts[e.source].downstream++;
      }
      if (connectionCounts[e.target]) {
        connectionCounts[e.target].degree++;
        connectionCounts[e.target].upstream++;
      }
    });

    const mostConnected = Object.values(connectionCounts)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 5);

    return { total, healthy, degraded, critical, healthScore, topCpu, topMem, mostConnected };
  }, [serviceNodes, parsedEdges]);

  const num: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
  const kpiValue: CSSProperties = { fontSize: '26px', fontWeight: 600, letterSpacing: '-0.02em', marginTop: '8px', color: 'var(--color-text-main)', ...num };
  const kpiSub: CSSProperties = { fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' };
  const cardTitle: CSSProperties = { margin: '0 0 14px 0', fontSize: '14px', fontWeight: 600, color: 'var(--color-text-main)' };
  const rank: CSSProperties = { fontSize: '12px', color: 'var(--color-text-dim)', width: '18px', flexShrink: 0, ...num };
  const meterColor = (pct: number) => (pct >= 90 ? 'var(--color-critical)' : pct >= 75 ? 'var(--color-degraded)' : '#9aa3b0');
  const meter = (pct: number) => (
    <div style={{ height: '4px', background: 'rgba(255,255,255,.06)', borderRadius: '2px', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: meterColor(pct) }} />
    </div>
  );
  const emptyList = (
    <div style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', textAlign: 'center' }}>
      <Inbox size={20} strokeWidth={1.75} color="var(--color-text-dim)" />
      <div style={{ fontSize: '13px', color: 'var(--color-text-main)' }}>No services yet</div>
      <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Rankings appear once services report metrics</div>
    </div>
  );
  const causeCount = rcaData?.primaryRootCauses?.length || 0;

  return (
    <div style={pageRootStyle(embedded)}>
      {/* Root cause analysis incident banner */}
      {rcaData?.incidentDetected && (
        <div className="mm-card" style={{
          padding: '18px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          borderColor: 'rgba(239,95,103,.3)',
          boxShadow: 'inset 2px 0 0 var(--color-critical), var(--shadow-1)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <AlertTriangle size={16} strokeWidth={1.75} color="var(--color-critical)" style={{ marginTop: '1px', flexShrink: 0 }} />
              <div>
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--color-text-main)' }}>
                  Active incident
                </h3>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px', ...num }}>
                  Automated root cause analysis · started {rcaData.timestamp ? new Date(rcaData.timestamp).toLocaleTimeString() : 'now'}
                </div>
              </div>
            </div>
            <span className="mm-chip" style={{ background: 'rgba(239,95,103,.1)', color: 'var(--color-critical)', border: 'none', ...num }}>
              <i className="mm-dot" style={{ background: 'currentColor' }} />
              {causeCount} primary root {causeCount === 1 ? 'cause' : 'causes'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
            {/* Primary root cause */}
            <div style={{ background: 'rgba(255,255,255,.02)', borderRadius: 'var(--radius-md)', padding: '14px 16px', border: '1px solid var(--color-border)' }}>
              <div className="mm-eyebrow">Root cause</div>
              {rcaData.primaryRootCauses?.map((rc: any) => (
                <div key={rc.nodeId} style={{ marginTop: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-main)' }}>{rc.name}</div>
                  <div style={{ fontSize: '12.5px', color: 'var(--color-text-muted)', marginTop: '4px', lineHeight: 1.55 }}>
                    {rc.failureReason}
                  </div>
                  {rc.evidence?.length > 0 && (
                    <ul style={{ margin: '8px 0 0 0', paddingLeft: '16px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
                      {rc.evidence.map((ev: string, idx: number) => <li key={idx}>{ev}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            {/* Blast radius and remediation */}
            <div style={{ background: 'rgba(255,255,255,.02)', borderRadius: 'var(--radius-md)', padding: '14px 16px', border: '1px solid var(--color-border)' }}>
              <div className="mm-eyebrow">Blast radius and remediation</div>
              <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--color-text-muted)' }}>
                Impacted services: <span style={{ fontWeight: 500, color: 'var(--color-text-main)' }}>{rcaData.blastRadius?.affectedServices?.join(', ') || 'None'}</span>
              </div>
              <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--color-text-muted)' }}>Recommended recovery action</div>
              <div style={{ background: 'var(--color-bg-body)', border: '1px solid var(--color-border)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-text-main)', marginTop: '6px', wordBreak: 'break-all' }}>
                {rcaData.remediationGuide || 'docker start container'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Top analytics KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">System health index</div>
          <div style={kpiValue}>
            {analytics.healthScore} <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text-muted)' }}>/ 100</span>
          </div>
          <div style={kpiSub}>
            <i className="mm-dot" style={{ background: analytics.healthScore > 80 ? 'var(--color-healthy)' : 'var(--color-critical)' }} />
            Topological resilience score
          </div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Healthy services</div>
          <div style={kpiValue}>
            {analytics.healthy} <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text-muted)' }}>/ {analytics.total}</span>
          </div>
          <div style={kpiSub}>
            <i className="mm-dot" style={{ background: 'var(--color-healthy)' }} />
            Normal operating parameters
          </div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Degraded</div>
          <div style={kpiValue}>{analytics.degraded}</div>
          <div style={kpiSub}>
            <i className="mm-dot" style={{ background: analytics.degraded > 0 ? 'var(--color-degraded)' : 'var(--color-unknown)' }} />
            Elevated resource utilization
          </div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <div className="mm-eyebrow">Critical or failed</div>
          <div style={kpiValue}>{analytics.critical}</div>
          <div style={kpiSub}>
            <i className="mm-dot" style={{ background: analytics.critical > 0 ? 'var(--color-critical)' : 'var(--color-unknown)' }} />
            Immediate attention required
          </div>
        </div>
      </div>

      {/* Analytics ranking grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px' }}>
        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <h3 style={cardTitle}>Most connected services</h3>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {analytics.mostConnected.length === 0 && emptyList}
            {analytics.mostConnected.map((item, i) => (
              <div key={item.node.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <span style={rank}>{i + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.node.name}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--color-text-dim)', ...num }}>{item.upstream} upstream · {item.downstream} downstream</div>
                  </div>
                </div>
                <span style={{ fontSize: '12.5px', color: 'var(--color-text-muted)', flexShrink: 0, ...num }}>
                  <span style={{ color: 'var(--color-text-main)', fontWeight: 500 }}>{item.degree}</span> edges
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <h3 style={cardTitle}>Top CPU load</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {analytics.topCpu.length === 0 && emptyList}
            {analytics.topCpu.map((node, i) => {
              const cpu = node.metrics?.cpu || 0;
              return (
                <div key={node.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', fontSize: '13px', marginBottom: '6px' }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
                      <span style={rank}>{i + 1}</span>
                      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                    </span>
                    <span style={{ color: 'var(--color-text-main)', ...num }}>{cpu.toFixed(1)}%</span>
                  </div>
                  <div style={{ paddingLeft: '28px' }}>{meter(cpu)}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mm-card" style={{ padding: '18px 20px' }}>
          <h3 style={cardTitle}>Top memory usage</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {analytics.topMem.length === 0 && emptyList}
            {analytics.topMem.map((node, i) => {
              const mem = node.metrics?.memoryPercent || 0;
              return (
                <div key={node.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', fontSize: '13px', marginBottom: '6px' }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
                      <span style={rank}>{i + 1}</span>
                      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                    </span>
                    <span style={{ color: 'var(--color-text-main)', ...num }}>{mem.toFixed(1)}%</span>
                  </div>
                  <div style={{ paddingLeft: '28px' }}>{meter(mem)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
