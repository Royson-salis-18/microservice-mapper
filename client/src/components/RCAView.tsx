import { useState, useEffect, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { Incident } from '../types';

interface RCAViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
}

export function RCAView({ nodes, edges: _edges, selectedProject }: RCAViewProps) {
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

  const getCleanName = (name: string) => name.replace(/^(sock-shop|vertikal)-/, '');

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

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {selectedCandidate.scoreBreakdown.map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', fontSize: '12px' }}>
                      <span style={{ color: 'var(--color-text-muted)' }}>{b.reason}</span>
                      <span style={{ fontWeight: 700, color: 'var(--color-healthy)', fontFamily: 'monospace' }}>
                        +{(b.score).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Deterministic Report, Evidence & Propagation */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            
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
