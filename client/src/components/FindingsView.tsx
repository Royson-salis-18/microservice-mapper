import { useState, useEffect, useMemo, useCallback } from 'react';
import { PageShell, PageHeader, Panel, Stat, StatRow, EmptyNote, SPACE } from './ui/Panel';
import {
  LiveScoresChart,
  ScoreHistoryChart,
  FeatureExplorer,
  ScoreDistributionChart,
  DetectorComparison,
  DataQualityPanel,
  ModelQualityChart,
  PanelsStartOpen,
  type ModelMeta,
  type MLStatus,
} from './MLPipelineView';

/**
 * Findings - everything the trained models concluded.
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

  const about = (
    <>
      Each sample is scored by every detector trained for that service - Isolation Forest, LOF,
      one-class SVM and z-score - against that detector's own training distribution, so "high"
      always means high <em>for that service</em>, never against a shared bar. A service is
      flagged when <strong>at least half of its usable detectors</strong> agree; the score shown is
      the median across them, with ~0.5 at a detector's threshold.
      <br /><br />
      <strong>Persistent</strong> means it has stayed above that line for the configured number of
      consecutive scoring cycles. A single cycle above threshold is very often one noisy sample, which
      is why the two are counted separately and persistent ones sort first.
    </>
  );

  if (scored.length === 0) {
    return (
      <Panel title="Current findings" subtitle="Nothing scored" about={about}>
        <EmptyNote>
          The scorer is not running, or the target is unreachable. Start it under{' '}
          <strong>ML pipeline → Pipeline processes</strong>. Until then this page shows what was learned
          at training time, not what is happening now.
        </EmptyNote>
      </Panel>
    );
  }

  return (
    <Panel
      title="Current findings"
      subtitle={flagged.length === 0 ? 'All within baseline' : `${flagged.length} flagged`}
      about={about}
    >
      <div style={{ marginBottom: flagged.length ? SPACE.card : 0 }}>
        <StatRow>
          <Stat label="Scored" value={scored.length} />
          <Stat label="Above threshold" value={flagged.length} />
          <Stat
            label="Persistent"
            value={persistent.length}
            sub={persistent.length ? 'Look here first' : undefined}
          />
        </StatRow>
      </div>

      {flagged.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {[...flagged]
            .sort((a, b) => Number(b.live!.persistent) - Number(a.live!.persistent) || b.live!.anomaly_score - a.live!.anomaly_score)
            .map((r, i) => {
              const crit = r.live!.persistent;
              const name = r.sid.includes(':') ? r.sid.split(':').slice(1).join(':') : r.sid;
              const project = r.sid.includes(':') ? r.sid.split(':')[0] : null;
              return (
                <button
                  key={r.sid}
                  type="button"
                  onClick={() => onSelect(r.sid)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.025)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px', minHeight: '44px',
                    background: 'transparent', border: 'none',
                    borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
                    padding: '10px 14px', cursor: 'pointer', textAlign: 'left',
                    color: 'var(--color-text-main)', fontSize: '13px', fontFamily: 'inherit',
                  }}
                >
                  <span
                    className="mm-chip"
                    style={{
                      flexShrink: 0,
                      background: crit ? 'rgba(239,95,103,0.1)' : 'rgba(232,163,61,0.1)',
                      color: crit ? 'var(--color-critical)' : 'var(--color-degraded)',
                    }}
                  >
                    <i className="mm-dot" style={{ background: 'currentColor' }} />
                    {crit ? 'Critical' : 'Warning'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {name} is {crit ? 'persistently above' : 'above'} its baseline threshold
                    </span>
                    <span style={{ fontSize: '11.5px', color: 'var(--color-text-dim)' }}>
                      {project ? `${project} · ` : ''}{crit ? 'Persistent across cycles' : 'Single cycle'}
                    </span>
                  </span>
                  <span style={{ flexShrink: 0, textAlign: 'right' }}>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--color-text-dim)' }}>Score</span>
                    <span style={{ fontSize: '12.5px', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {r.live!.anomaly_score.toFixed(4)}
                    </span>
                  </span>
                </button>
              );
            })}
        </div>
      )}
    </Panel>
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
    return <div style={{ padding: '24px', fontSize: '13px', color: 'var(--color-critical)' }}>Failed to load findings: {error}</div>;
  }
  if (!status) {
    return <div style={{ padding: '24px', fontSize: '13px', color: 'var(--color-text-muted)' }}>Loading…</div>;
  }

  return (
    // The charts are what this page is for, so they open by default here.
    <PanelsStartOpen.Provider value={true}>
    <PageShell>
      <PageHeader title="Findings" scope={selectedProject}>
        What the trained detectors concluded. These are model outputs, so they are only as good as what
        the models were fitted on - rule-based alerts that need no model live under Incidents.
      </PageHeader>

      <CurrentFindings rows={rows} onSelect={setSelectedSid} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: `${SPACE.section}px`, alignItems: 'start' }}>
        <LiveScoresChart rows={rows} onSelect={setSelectedSid} selectedSid={selectedSid} />
        <ScoreHistoryChart sid={selectedSid} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: `${SPACE.section}px`, alignItems: 'start' }}>
        <ScoreDistributionChart rows={rows} />
        <ModelQualityChart models={scopedModels} onSelect={setSelectedSid} />
      </div>

      <DetectorComparison models={scopedModels} />

      <DataQualityPanel models={scopedModels} />

      <FeatureExplorer serviceIds={featureServiceIds} sid={selectedSid} onSelect={setSelectedSid} />
    </PageShell>
    </PanelsStartOpen.Provider>
  );
}
