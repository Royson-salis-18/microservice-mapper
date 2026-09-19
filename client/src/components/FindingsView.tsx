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
      A service is flagged when its score passes the p99 threshold taken from its own training
      distribution — so "high" always means high <em>for that service</em>, never against a shared bar.
      <br /><br />
      <strong>Persistent</strong> means it has stayed above that line for the configured number of
      consecutive scoring cycles. A single cycle above threshold is very often one noisy sample, which
      is why the two are counted separately and persistent ones sort first.
    </>
  );

  if (scored.length === 0) {
    return (
      <Panel title="Current findings" subtitle="nothing scored" about={about}>
        <EmptyNote>
          The scorer is not running, or the target is unreachable. Start it under{' '}
          <strong>ML Pipeline → Pipeline processes</strong>. Until then this page shows what was learned
          at training time, not what is happening now.
        </EmptyNote>
      </Panel>
    );
  }

  return (
    <Panel
      title="Current findings"
      subtitle={flagged.length === 0 ? 'all within baseline' : `${flagged.length} flagged`}
      about={about}
    >
      <div style={{ marginBottom: flagged.length ? SPACE.card : 0 }}>
        <StatRow>
          <Stat label="Scored" value={scored.length} />
          <Stat
            label="Above threshold"
            value={flagged.length}
            tone={flagged.length ? 'var(--color-degraded)' : 'var(--color-healthy)'}
          />
          <Stat
            label="Persistent"
            value={persistent.length}
            tone={persistent.length ? 'var(--color-critical)' : 'var(--color-text-dim)'}
            sub={persistent.length ? 'look here first' : undefined}
          />
        </StatRow>
      </div>

      {flagged.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[...flagged]
            .sort((a, b) => Number(b.live!.persistent) - Number(a.live!.persistent) || b.live!.anomaly_score - a.live!.anomaly_score)
            .map(r => (
              <button
                key={r.sid}
                type="button"
                onClick={() => onSelect(r.sid)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px',
                  background: r.live!.persistent ? 'rgba(255,23,68,0.07)' : 'rgba(255,171,0,0.06)',
                  border: `1px solid ${r.live!.persistent ? 'rgba(255,23,68,0.35)' : 'rgba(255,171,0,0.28)'}`,
                  borderRadius: '10px', padding: '12px 14px', cursor: 'pointer', textAlign: 'left',
                  color: 'var(--color-text-main)', fontSize: '13px',
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {r.sid.includes(':') ? r.sid.split(':').slice(1).join(':') : r.sid}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                    color: r.live!.persistent ? 'var(--color-critical)' : 'var(--color-degraded)',
                  }}>
                    {r.live!.persistent ? 'persistent' : 'single cycle'}
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    {r.live!.anomaly_score.toFixed(4)}
                  </span>
                </span>
              </button>
            ))}
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
    return <div style={{ padding: '24px', color: 'var(--color-critical)' }}>Failed to load findings: {error}</div>;
  }
  if (!status) {
    return <div style={{ padding: '24px', color: 'var(--color-text-muted)' }}>Loading…</div>;
  }

  return (
    // The charts are what this page is for, so they open by default here.
    <PanelsStartOpen.Provider value={true}>
    <PageShell>
      <PageHeader title="Findings" scope={selectedProject}>
        What the trained detectors concluded. These are model outputs, so they are only as good as what
        the models were fitted on — rule-based alerts that need no model live under Incidents.
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
