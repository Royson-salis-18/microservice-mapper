import { useState, useEffect, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { Incident } from '../types';
import { pageRootStyle } from './ProjectSections';
import { IncidentRulesPanel } from './IncidentRulesPanel';

interface RCAViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
  /** Rendered inside a per-project stack: the wrapper owns scroll + height. */
  embedded?: boolean;
}

export function RCAView({ nodes, edges: _edges, selectedProject, embedded = false }: RCAViewProps) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const targetId = useMemo(() => {
    return selectedProject === 'ALL' ? 'sock-shop' : selectedProject.toLowerCase();
  }, [selectedProject]);

  useEffect(() => {
    fetch(`/api/incidents?targetId=${targetId}`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setIncidents(data);
      })
      .catch(() => setIncidents([]));
  }, [targetId, nodes]);

  const activeIncident = useMemo(() => {
    return incidents.find(i => i.targetId === targetId) || incidents[0] || null;
  }, [incidents, targetId]);

  const selectedCandidate = useMemo(() => {
    if (!activeIncident || !activeIncident.candidateCauses.length) return null;
    if (selectedCandidateId) {
      return activeIncident.candidateCauses.find(c => c.serviceId === selectedCandidateId) || activeIncident.candidateCauses[0];
    }
    return activeIncident.candidateCauses[0];
  }, [activeIncident, selectedCandidateId]);

  const getCleanName = (name: string) => {
    if (!name) return '';
    return name.replace(new RegExp(`^(${targetId}|sock-shop|vertikal)-`, 'i'), '');
  };

  return (
    <div style={pageRootStyle(embedded)}>
      {/* What actually fires an incident — visible and editable here rather
          than living as literals inside AnomalyDetector. */}
      <IncidentRulesPanel />

      {/* Top Banner: Incident Status & Target Isolation */}
      {activeIncident ? (
        <div style={{
          background: 'linear-gradient(135deg, rgba(255,23,68,0.12) 0%, rgba(18,18,26,0.95) 100%)',
          border: '1px solid var(--color-critical)',
          borderRadius: '12px',
          padding: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 0 24px rgba(255,23,68,0.15)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{
              width: '44px',
              height: '44px',
              borderRadius: '10px',
              background: 'rgba(255,23,68,0.2)',
              border: '1px solid var(--color-critical)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '22px'
            }}>
              🚨
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#fff' }}>
                  ACTIVE INCIDENT DETECTED
                </h2>
                <span style={{
                  padding: '2px 10px',
                  borderRadius: '12px',
                  fontSize: '11px',
                  fontWeight: 700,
                  background: 'var(--color-critical)',
                  color: '#fff'
                }}>
                  {activeIncident.severity} SEVERITY
                </span>
                <span style={{
                  padding: '2px 10px',
                  borderRadius: '12px',
                  fontSize: '11px',
                  fontWeight: 700,
                  background: 'rgba(0, 212, 255, 0.15)',
                  color: 'var(--color-accent-cyan)',
                  border: '1px solid var(--color-accent-cyan)'
                }}>
                  TARGET: {activeIncident.targetId.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                Incident ID: <span style={{ fontFamily: 'monospace', color: '#fff' }}>{activeIncident.id}</span> • Started at: {new Date(activeIncident.startedAt).toLocaleTimeString()}
              </div>
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>Root Cause Confidence</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: activeIncident.confidence === 'HIGH' ? 'var(--color-healthy)' : 'var(--color-degraded)' }}>
              {activeIncident.confidence} CONFIDENCE
            </div>
          </div>
        </div>
      ) : (
        <div style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: '12px',
          padding: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '16px'
        }}>
          <span style={{ fontSize: '24px' }}>✅</span>
          <div>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--color-healthy)' }}>
              SYSTEM NORMAL — NO ACTIVE INCIDENTS
            </h3>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
              Target '{targetId}' is operating within normal baseline telemetry parameters.
            </div>
          </div>
        </div>
      )}

      {/* Main RCA Split Dashboard */}
      {activeIncident && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          
          {/* Left Column: Candidate Ranking & Score Breakdown */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            
            {/* Candidate Ranking Table */}
            <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px' }}>
              <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 700 }}>
                Root Cause Candidates Ranking
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {activeIncident.candidateCauses.map((candidate, idx) => {
                  const isSelected = selectedCandidate?.serviceId === candidate.serviceId;
                  return (
                    <div
                      key={candidate.serviceId}
                      onClick={() => setSelectedCandidateId(candidate.serviceId)}
                      style={{
                        padding: '12px 16px',
                        background: isSelected ? 'rgba(0, 212, 255, 0.08)' : 'rgba(0,0,0,0.2)',
                        border: `1px solid ${isSelected ? 'var(--color-accent-cyan)' : 'rgba(255,255,255,0.04)'}`,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '14px', fontWeight: 700, color: idx === 0 ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
                          #{idx + 1}
                        </span>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '14px', color: '#fff' }}>
                            {getCleanName(candidate.serviceName)}
                            {idx === 0 && <span style={{ marginLeft: '8px', fontSize: '10px', background: 'var(--color-critical)', color: '#fff', padding: '1px 6px', borderRadius: '4px' }}>SUSPECTED ROOT</span>}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                            Metric: {candidate.primaryAnomalyMetric}
                          </div>
                        </div>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--color-accent-cyan)' }}>
                          {(candidate.score * 100).toFixed(0)}%
                        </div>
                        <div style={{ fontSize: '10px', color: candidate.confidence === 'HIGH' ? 'var(--color-healthy)' : 'var(--color-degraded)', fontWeight: 600 }}>
                          {candidate.confidence}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Explainable Score Breakdown */}
            {selectedCandidate && (
              <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px' }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '15px', fontWeight: 700 }}>
                  Explainable Score Breakdown — {getCleanName(selectedCandidate.serviceName)}
                </h3>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '16px' }}>
                  Total Root Cause Score: <strong style={{ color: 'var(--color-accent-cyan)' }}>{selectedCandidate.score.toFixed(2)}</strong>
                </div>
                {selectedCandidate.own !== undefined && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '14px' }}>
                    {[
                      ['Own evidence', selectedCandidate.own, 'its own CPU / memory / silence'],
                      ['Symptoms', selectedCandidate.symptoms, 'errors, latency, traffic (can be inherited)'],
                      ['Explained by a dependency', selectedCandidate.explained, 'a broken service it calls'],
                    ].map(([label, v, hint]) => (
                      <div key={label as string} title={hint as string} style={{ background: 'rgba(0,0,0,0.25)', borderRadius: '8px', padding: '8px 10px' }}>
                        <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>{label as string}</div>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff', fontFamily: 'monospace' }}>{Number(v ?? 0).toFixed(1)}×</div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {selectedCandidate.scoreBreakdown.map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', fontSize: '12px' }}>
                      <span style={{ color: 'var(--color-text-muted)' }}>{b.reason}</span>
                      <span style={{ fontWeight: 700, color: b.score < 0 ? 'var(--color-critical)' : 'var(--color-healthy)', fontFamily: 'monospace' }}>
                        {b.score < 0 ? '−' : '+'}{Math.abs(b.score).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Deterministic Report, Evidence & Propagation */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {activeIncident.monitoringGap && (
              <div style={{ background: 'rgba(255, 184, 0, 0.08)', border: '1px solid var(--color-degraded)', borderRadius: '12px', padding: '16px 20px' }}>
                <div style={{ fontWeight: 700, color: 'var(--color-degraded)', marginBottom: '4px' }}>Monitoring outage, not a service fault</div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                  Most services stopped reporting at the same moment. Independent services do not all freeze together; a broken telemetry
                  path (SSH session, collector, Docker daemon) does. No service is blamed until data comes back.
                </div>
              </div>
            )}

            {activeIncident.atRisk && activeIncident.atRisk.length > 0 && (
              <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px' }}>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 700 }}>At risk next</h3>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '12px' }}>
                  Healthy services that call a broken one. A ranking of who to watch, not a calibrated probability.
                </div>
                {activeIncident.atRisk.slice(0, 6).map(r => (
                  <div key={r.serviceId} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 120px 44px', gap: '10px', alignItems: 'center', padding: '6px 0', fontSize: '12px' }}>
                    <span style={{ color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`calls ${r.via.join(', ')}`}>
                      {getCleanName(r.serviceName)} <span style={{ color: 'var(--color-text-muted)' }}>← {r.via.map(getCleanName).join(', ')}</span>
                    </span>
                    <div style={{ height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ width: `${Math.round(r.risk * 100)}%`, height: '100%', background: 'var(--color-degraded)' }} />
                    </div>
                    <span style={{ textAlign: 'right', color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>{Math.round(r.risk * 100)}%</span>
                  </div>
                ))}
              </div>
            )}

            {activeIncident.remediationGuide && activeIncident.remediationGuide.length > 0 && (
              <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '16px 20px' }}>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600, marginBottom: '8px' }}>Try first (on the host)</div>
                {activeIncident.remediationGuide.map((c, i) => (
                  <code key={i} style={{ display: 'block', fontSize: '12px', background: 'rgba(0,0,0,0.35)', padding: '6px 10px', borderRadius: '6px', marginBottom: '6px', color: 'var(--color-accent-cyan)' }}>{c}</code>
                ))}
              </div>
            )}
            
            {/* Human Explanation Engine Report */}
            {activeIncident.explanation && (
              <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#fff' }}>
                  RCA Investigation Report
                </h3>

                <div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>What Happened</div>
                  <div style={{ fontSize: '13px', marginTop: '2px', color: '#fff' }}>{activeIncident.explanation.whatHappened}</div>
                </div>

                <div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Causal Explanation (Why)</div>
                  <div style={{ fontSize: '13px', marginTop: '2px', color: 'var(--color-accent-cyan)', background: 'rgba(0,212,255,0.05)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(0,212,255,0.1)' }}>
                    {activeIncident.explanation.why}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Propagation Path</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {activeIncident.explanation.propagationPath.map((step, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                          padding: '4px 10px',
                          borderRadius: '6px',
                          background: i === 0 ? 'var(--color-critical)' : 'rgba(255,171,0,0.15)',
                          color: i === 0 ? '#fff' : 'var(--color-degraded)',
                          fontWeight: 700,
                          fontSize: '12px'
                        }}>
                          {step}
                        </span>
                        {i < activeIncident.explanation.propagationPath.length - 1 && <span style={{ color: 'var(--color-text-muted)' }}>➔</span>}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Recommended Investigation</div>
                  <ul style={{ margin: '6px 0 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--color-healthy)' }}>
                    {activeIncident.explanation.recommendedInvestigation.map((rec, i) => (
                      <li key={i} style={{ marginBottom: '4px' }}>{rec}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Real Telemetry Evidence List */}
            <div style={{ background: 'var(--color-bg-panel)', borderRadius: '12px', border: '1px solid var(--color-border)', padding: '20px' }}>
              <h3 style={{ margin: '0 0 14px 0', fontSize: '15px', fontWeight: 700 }}>
                Real Telemetry Evidence Log
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {activeIncident.evidence.map(ev => (
                  <div key={ev.id} style={{ background: 'rgba(0,0,0,0.2)', padding: '10px 12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.03)', fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                      <span style={{ fontWeight: 600, color: '#fff' }}>{ev.metric}</span>
                      <span style={{ fontSize: '10px', background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: '3px', color: 'var(--color-text-muted)' }}>{ev.source}</span>
                    </div>
                    <div style={{ color: 'var(--color-text-muted)' }}>{ev.description}</div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
