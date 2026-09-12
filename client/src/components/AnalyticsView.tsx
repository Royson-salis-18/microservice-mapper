import { useState, useEffect, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { ServiceNode, DependencyEdge } from '../types';

interface AnalyticsViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
}

export function AnalyticsView({ nodes, edges, selectedProject }: AnalyticsViewProps) {
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
    fetch('/api/rca')
      .then(res => res.json())
      .then(data => setRcaData(data))
      .catch(() => setRcaData(null));
  }, [nodes, edges]);

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

  return (
    <div style={{
      flex: 1,
      height: '100%',
      overflowY: 'auto',
      padding: '24px',
      background: 'var(--color-bg-body)',
      color: 'var(--color-text-main)',
      display: 'flex',
      flexDirection: 'column',
      gap: '24px'
    }}>
      {/* Root Cause Analysis (RCA) Incident Alert Banner */}
      {rcaData?.incidentDetected && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(255,23,68,0.15) 0%, rgba(20,10,20,0.9) 100%)',
          border: '1px solid var(--color-critical)',
          boxShadow: '0 0 20px rgba(255,23,68,0.2)',
          borderRadius: '12px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '20px' }}>🚨</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: 'var(--color-critical)' }}>
                  AUTOMATED ROOT CAUSE ANALYSIS (RCA)
                </h3>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                  Incident Timestamp: {rcaData.timestamp ? new Date(rcaData.timestamp).toLocaleTimeString() : 'NOW'}
                </div>
              </div>
            </div>
            <span style={{ background: 'var(--color-critical)', color: '#fff', padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: 700 }}>
              {rcaData.primaryRootCauses?.length || 0} PRIMARY ROOT CAUSE(S) IDENTIFIED
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            {/* Primary Root Cause Card */}
            <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '16px', border: '1px solid rgba(255,23,68,0.3)' }}>
              <div style={{ fontSize: '11px', color: 'var(--color-critical)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>Primary Root Cause</div>
              {rcaData.primaryRootCauses?.map((rc: any) => (
                <div key={rc.nodeId} style={{ marginTop: '8px' }}>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{rc.name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                    Reason: <span style={{ color: 'var(--color-critical)' }}>{rc.failureReason}</span>
                  </div>
                  <ul style={{ margin: '8px 0 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    {rc.evidence?.map((ev: string, idx: number) => <li key={idx}>{ev}</li>)}
                  </ul>
                </div>
              ))}
            </div>

            {/* Blast Radius & Remediation Guide */}
            <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '16px', border: '1px solid rgba(0,212,255,0.2)' }}>
              <div style={{ fontSize: '11px', color: 'var(--color-accent-cyan)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>Blast Radius & Remediation</div>
              <div style={{ marginTop: '8px', fontSize: '13px' }}>
                Impacted Services: <span style={{ fontWeight: 600, color: '#fff' }}>{rcaData.blastRadius?.affectedServices?.join(', ') || 'None'}</span>
              </div>
              <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--color-text-muted)' }}>Recommended Recovery Action:</div>
              <div style={{ background: 'rgba(0,0,0,0.5)', padding: '8px 12px', borderRadius: '6px', fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-healthy)', marginTop: '4px', wordBreak: 'break-all' }}>
                {rcaData.remediationGuide || 'docker start container'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Top Analytics KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>System Health Index</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: analytics.healthScore > 80 ? 'var(--color-healthy)' : 'var(--color-critical)' }}>
            {analytics.healthScore} / 100
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Topological Resilience Score</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Healthy Microservices</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: 'var(--color-healthy)' }}>
            {analytics.healthy} <span style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>/ {analytics.total}</span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Normal operating parameters</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Degraded Nodes</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: 'var(--color-degraded)' }}>
            {analytics.degraded}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Elevated resource utilization</div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', padding: '20px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Critical / Failed Nodes</div>
          <div style={{ fontSize: '28px', fontWeight: 700, marginTop: '8px', color: 'var(--color-critical)' }}>
            {analytics.critical}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>Immediate attention required</div>
        </div>
      </div>

      {/* Analytics Ranking Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '24px' }}>
        <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 700 }}>Most Connected Services (Centrality)</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {analytics.mostConnected.map((item, i) => (
              <div key={item.node.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-accent-cyan)', width: '20px' }}>#{i+1}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{item.node.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{item.upstream} Upstream • {item.downstream} Downstream</div>
                  </div>
                </div>
                <div style={{ background: 'rgba(0, 212, 255, 0.15)', color: 'var(--color-accent-cyan)', padding: '4px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 700 }}>
                  {item.degree} Edges
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 700 }}>Top CPU Load Consumers</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {analytics.topCpu.map((node, i) => {
              const cpu = node.metrics?.cpu || 0;
              return (
                <div key={node.id} style={{ padding: '10px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                    <span style={{ fontWeight: 600 }}>#{i+1} {node.name}</span>
                    <span style={{ color: 'var(--color-accent-cyan)', fontWeight: 700 }}>{cpu.toFixed(1)}%</span>
                  </div>
                  <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(cpu, 100)}%`, background: 'var(--color-accent-cyan)' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 700 }}>Top Memory Usage</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {analytics.topMem.map((node, i) => {
              const mem = node.metrics?.memoryPercent || 0;
              return (
                <div key={node.id} style={{ padding: '10px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                    <span style={{ fontWeight: 600 }}>#{i+1} {node.name}</span>
                    <span style={{ color: 'var(--color-accent-magenta)', fontWeight: 700 }}>{mem.toFixed(1)}%</span>
                  </div>
                  <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(mem, 100)}%`, background: 'var(--color-accent-magenta)' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
