import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  LiveScoresChart,
  ScoreHistoryChart,
  FeatureExplorer,
  ScoreDistributionChart,
  DetectorComparison,
  DataQualityPanel,
  ModelQualityChart,
  type ModelMeta,
  type MLStatus,
} from './MLPipelineView';

/**
 * Findings — everything the trained models concluded.
 *
 * The split from Incidents is about provenance, not presentation:
 *
 *   Findings   what the models say. Needs training data, a fitted artefact
 *              per service and the scorer running. Says "this service is
 *              behaving unlike its own history", which is a claim about a
 *              learned baseline and only as good as what it was fitted on.
 *
 *   Incidents  what the rules say. A fixed z-score and absolute threshold on
 *              a live metric, with no model involved. Fires on a service
 *              discovered a minute ago, on a target that was never trained.
 *
 * Keeping them apart matters for the research as much as the UI: if
 * incidents were raised by the models, any evaluation of those models would
 * be scored against alerts the models themselves produced.
 *
 * Everything here is scoped to the project chosen in the top bar.
 */

interface FindingsViewProps {
  selectedProject?: string;
}

const panel: React.CSSProperties = {
  background: 'var(--color-bg-panel)',
  border: '1px solid var(--color-border)',
  borderRadius: '12px',
  padding: '16px',
};

const sectionTitle: React.CSSProperties = {
  margin: '0 0 4px 0',
  fontSize: '14px',
  fontWeight: 700,
};

const sectionNote: React.CSSProperties = {
  margin: '0 0 14px 0',
  fontSize: '11px',
  color: 'var(--color-text-muted)',
  lineHeight: 1.55,
};

/**
 * What the models are flagging right now.
 *
 * A model's own p99 training threshold decides "above threshold"; persistence
 * means it has stayed there for the configured number of consecutive scoring
 * cycles, which is what separates a genuine shift from one noisy sample.
 */
function CurrentFindings({ rows, onSelect }: {
  rows: { sid: string; live?: { anomaly_score: number; persistent: boolean; above_threshold: boolean } }[];
  onSelect: (sid: string) => void;
}) {
  const scored = rows.filter(r => r.live);
  const flagged = scored.filter(r => r.live!.above_threshold);
  const persistent = flagged.filter(r => r.live!.persistent);

  if (scored.length === 0) {
    return (
      <div style={panel}>
        <h3 style={sectionTitle}>Current findings</h3>
        <p style={sectionNote}>
          Nothing scored. The scorer process has to be running and the target reachable for the models to
          say anything — start it under ML Pipeline → Pipeline processes. Until then this page shows what
          was learned at training time, not what is happening now.
        </p>
      </div>
    );
  }

  return (
    <div style={panel}>
      <h3 style={sectionTitle}>Current findings</h3>
      <p style={sectionNote}>
        {flagged.length === 0
          ? `All ${scored.length} scored service(s) are within their own learned baseline.`
          : `${flagged.length} of ${scored.length} scored service(s) are above their model's threshold` +
            (persistent.length > 0
              ? `, ${persistent.length} of them persistently — the ones worth looking at first.`
              : ', none persistently yet — a single cycle above threshold is often one noisy sample.')}
      </p>

      {flagged.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {[...flagged]
            .sort((a, b) => Number(b.live!.persistent) - Number(a.live!.persistent) || b.live!.anomaly_score - a.live!.anomaly_score)
            .map(r => (
              <button
                key={r.sid}
                type="button"
                onClick={() => onSelect(r.sid)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                  background: r.live!.persistent ? 'rgba(255,82,82,0.08)' : 'rgba(255,171,0,0.07)',
                  border: `1px solid ${r.live!.persistent ? 'rgba(255,82,82,0.4)' : 'rgba(255,171,0,0.32)'}`,
                  borderRadius: '8px', padding: '8px 10px', cursor: 'pointer', textAlign: 'left',
                  color: 'var(--color-text-main)', fontSize: '11px',
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {r.sid.includes(':') ? r.sid.split(':').slice(1).join(':') : r.sid}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ color: r.live!.persistent ? 'var(--color-critical)' : 'var(--color-degraded)', fontWeight: 700 }}>
                    {r.live!.persistent ? 'persistent' : 'single cycle'}
                  </span>
                  <span style={{ fontFamily: 'monospace', color: 'var(--color-text-muted)' }}>
                    score {r.live!.anomaly_score.toFixed(4)}
                  </span>
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function FindingsView({ selectedProject = 'ALL' }: FindingsViewProps) {
  const [status, setStatus] = useState<MLStatus | null>(null);
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scoped = selectedProject !== 'ALL';
  const inScope = useCallback(
    (sid: string) => !scoped || sid.split(':')[0] === selectedProject,
    [scoped, selectedProject],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, m] = await Promise.all([
          fetch('/api/ml/status').then(r => r.json()),
          fetch('/api/ml/models').then(r => (r.ok ? r.json() : [])),
        ]);
        if (cancelled) return;
        setStatus(s);
        setModels(m);
        setError(null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load');
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // A service selected under one project should not linger when the scope
  // moves to another.
  useEffect(() => {
    setSelectedSid(prev => (prev && !inScope(prev) ? null : prev));
  }, [inScope]);

  const rows = useMemo(() => {
    if (!status) return [];
    const ids = new Set<string>();
    Object.keys(status.training?.trained || {}).forEach(s => ids.add(s));
    Object.keys(status.liveScores || {}).forEach(s => ids.add(s));
    Object.keys(status.preprocessing?.per_service || {}).forEach(s => ids.add(s));
    return Array.from(ids)
      .filter(inScope)
      .sort()
      .map(sid => ({
        sid,
        featured: status.preprocessing?.per_service?.[sid],
        trainedEntry: status.training?.trained?.[sid],
        live: status.liveScores?.[sid],
      }));
  }, [status, inScope]);

  const scopedModels = useMemo(() => models.filter(m => inScope(m.service_id)), [models, inScope]);
  const featureServiceIds = rows.filter(r => r.featured?.status === 'ok').map(r => r.sid);

  if (error && !status) {
    return <div style={{ padding: '24px', color: 'var(--color-critical)' }}>Failed to load findings: {error}</div>;
  }
  if (!status) {
    return <div style={{ padding: '24px', color: 'var(--color-text-muted)' }}>Loading…</div>;
  }

  return (
    <div style={{
      flex: 1, height: '100%', overflowY: 'auto', padding: '24px',
      background: 'var(--color-bg-body)', color: 'var(--color-text-main)',
      display: 'flex', flexDirection: 'column', gap: '20px',
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>Findings</h1>
          <span style={{
            fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
            color: scoped ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
            border: `1px solid ${scoped ? 'var(--color-accent-cyan)' : 'var(--color-border)'}`,
            borderRadius: '999px', padding: '2px 10px',
          }}>{scoped ? selectedProject : 'all projects'}</span>
        </div>
        <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: 1.55 }}>
          What the trained detectors concluded — live scores, how each model behaves, and how much the
          detectors agree. These are model outputs, so they depend on what the models were fitted on.
          Rule-based alerts that need no model live under <strong>Incidents</strong>.
        </p>
      </div>

      <CurrentFindings rows={rows} onSelect={setSelectedSid} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', alignItems: 'start' }}>
        <LiveScoresChart rows={rows} onSelect={setSelectedSid} selectedSid={selectedSid} />
        <ScoreHistoryChart sid={selectedSid} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', alignItems: 'start' }}>
        <ScoreDistributionChart rows={rows} />
        <ModelQualityChart models={scopedModels} onSelect={setSelectedSid} />
      </div>

      <DetectorComparison models={scopedModels} />

      <DataQualityPanel models={scopedModels} />

      <FeatureExplorer serviceIds={featureServiceIds} sid={selectedSid} onSelect={setSelectedSid} />
    </div>
  );
}
