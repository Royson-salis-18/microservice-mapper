import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, Play, Loader2 } from 'lucide-react';
import { InfoTip } from './ui/Panel';

/**
 * Notebook-style execution panel for the ML pipeline.
 *
 * The cells are the real pipeline steps, in the order they run, each showing
 * the actual source of the script it executes - fetched from the server, not
 * transcribed here, so what is displayed cannot drift from what runs.
 *
 * What is editable is the part worth editing: the project to scope to and the
 * hyperparameters, which are forwarded as real CLI flags to train.py. That is
 * deliberate rather than a limitation. A free-text Python cell posted to a
 * server is remote code execution, and this app already listens on a port; a
 * typo in a hyperparameter costs a retrain, a typo in an exec cell costs the
 * machine. Editing the scripts themselves is a file away, in an editor that
 * has undo and version control, and the source shown here is the same file.
 */

type StepName = 'preprocess' | 'train';

interface SourceDoc {
  name: string;
  file: string;
  code: string;
  lines: number;
}

interface Suggestion {
  suggested: number | string[];
  range?: [number, number];
  hard_limits?: [number, number];
  reason: string;
}

interface Suggestions {
  available: boolean;
  reason?: string;
  project?: string;
  observed?: {
    services: number;
    median_rows: number;
    median_distinct: number;
    min_rows: number;
    thin_services: number;
    lof_capable_services: number;
    thinnest: { sid: string; rows: number; distinct: number }[];
  };
  suggestions?: Record<string, Suggestion>;
  warnings?: string[];
}

interface RetrainState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  exitCode: number | null;
}

const ALGORITHMS = [
  { id: 'iforest', label: 'Isolation Forest', note: 'partitioning' },
  { id: 'lof', label: 'Local Outlier Factor', note: 'local density' },
  { id: 'ocsvm', label: 'One-Class SVM', note: 'boundary' },
  { id: 'zscore', label: 'Z-score', note: 'statistical baseline' },
];

const label: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--color-text-muted)',
  fontWeight: 500,
  display: 'block',
  marginBottom: '6px',
};

const cell: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: '16px',
  marginBottom: '12px',
};

const cellTitle: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: '8px',
  fontSize: '13px', fontWeight: 600, color: 'var(--color-text-main)',
};

const stepNo: React.CSSProperties = {
  fontSize: '11px', fontWeight: 500, color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums',
};

const helper: React.CSSProperties = {
  fontSize: '11.5px', color: 'var(--color-text-dim)', marginTop: '6px', lineHeight: 1.5,
};

const mono = 'var(--font-mono)';

const input: React.CSSProperties = {
  width: '100%',
  height: '30px',
  background: 'rgba(255,255,255,0.03)',
  color: 'var(--color-text-main)',
  border: '1px solid var(--color-border)',
  borderRadius: '8px',
  padding: '0 10px',
  fontSize: '13px',
  fontFamily: 'inherit',
  fontVariantNumeric: 'tabular-nums',
  outline: 'none',
};

function CodeCell({ source, collapsed, onToggle }: { source: SourceDoc | null; collapsed: boolean; onToggle: () => void }) {
  if (!source) return null;
  return (
    <div style={{ marginTop: '12px', border: '1px solid var(--color-border)', borderRadius: '8px', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%', textAlign: 'left', background: 'rgba(255,255,255,0.02)', border: 'none',
          color: 'var(--color-text-muted)', padding: '0 10px', height: '30px', fontSize: '12px', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: mono }}>
          {collapsed ? <ChevronRight size={14} strokeWidth={1.75} /> : <ChevronDown size={14} strokeWidth={1.75} />}
          ml/{source.file}
        </span>
        <span style={{ fontSize: '11.5px', color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums' }}>{source.lines} lines · Read-only</span>
      </button>
      {!collapsed && (
        <pre style={{
          margin: 0, padding: '12px', maxHeight: '340px', overflow: 'auto',
          background: 'var(--color-bg-body)', borderTop: '1px solid var(--color-border)', fontSize: '12px', lineHeight: 1.55,
          color: 'var(--color-text-muted)', fontFamily: mono,
        }}>{source.code}</pre>
      )}
    </div>
  );
}

/**
 * The suggestion under a hyperparameter field.
 *
 * Shows the value, the sane range, and one click to take it - with the
 * reasoning behind it available rather than asking anyone to trust a bare
 * number. The reasons are computed from this project's own feature table,
 * so they say what will happen to these services rather than quoting a
 * textbook default.
 */
function Hint({ s, current, onApply }: { s?: Suggestion; current: string; onApply: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!s || Array.isArray(s.suggested)) return null;
  const value = String(s.suggested);
  const applied = current === value;
  return (
    <div style={{ marginTop: '6px', fontSize: '11.5px', color: 'var(--color-text-dim)', lineHeight: 1.6 }}>
      <span>Suggested </span>
      <button
        type="button"
        onClick={() => onApply(value)}
        title={applied ? 'Already set' : `Use ${value}`}
        style={{
          background: applied ? 'rgba(255,255,255,0.04)' : 'rgba(138,180,255,0.1)',
          border: `1px solid ${applied ? 'var(--color-border)' : 'rgba(138,180,255,0.3)'}`,
          color: applied ? 'var(--color-text-muted)' : 'var(--color-accent-cyan)',
          borderRadius: '6px', padding: '0 6px', fontSize: '11.5px', cursor: 'pointer', fontWeight: 550,
          fontVariantNumeric: 'tabular-nums', fontFamily: 'inherit',
        }}
      >{value}</button>
      {s.range && <span> · usual {s.range[0]}–{s.range[1]}</span>}
      <button
        type="button" onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: '11.5px', padding: '0 0 0 6px', textDecoration: 'underline', textUnderlineOffset: '2px', fontFamily: 'inherit' }}
      >{open ? 'Less' : 'Why'}</button>
      {open && (
        <div style={{ marginTop: '6px', padding: '8px 10px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--color-border)', borderRadius: '6px', color: 'var(--color-text-muted)' }}>
          {s.reason}
        </div>
      )}
    </div>
  );
}

export function MLExecutionPanel({ selectedProject = 'ALL' }: { selectedProject?: string }) {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState<string>('');
  const [sources, setSources] = useState<Record<string, SourceDoc>>({});
  const [collapsed, setCollapsed] = useState<Record<StepName, boolean>>({ preprocess: true, train: true });

  // Empty means "use ml/config.json", which train.py already defaults to.
  const [algorithms, setAlgorithms] = useState<string[]>(ALGORITHMS.map(a => a.id));
  const [contamination, setContamination] = useState('');
  const [nEstimators, setNEstimators] = useState('');
  const [minSamples, setMinSamples] = useState('');
  const [holdoutFraction, setHoldoutFraction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [skipPreprocess, setSkipPreprocess] = useState(false);

  const [suggest, setSuggest] = useState<Suggestions | null>(null);
  const [retrain, setRetrain] = useState<RetrainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    fetch('/api/ml/projects')
      .then(r => r.json())
      .then((list: string[]) => {
        setProjects(list);
        setProject(prev => prev || (selectedProject !== 'ALL' ? selectedProject : list[0] || ''));
      })
      .catch(() => { /* panel still works; the selector is just empty */ });

    for (const name of ['preprocess', 'train'] as StepName[]) {
      fetch(`/api/ml/source/${name}`)
        .then(r => (r.ok ? r.json() : null))
        .then((doc: SourceDoc | null) => { if (doc) setSources(prev => ({ ...prev, [name]: doc })); })
        .catch(() => { /* the cell simply shows no source */ });
    }
  }, []);

  // Follow the top bar. Choosing a project up there and then training a
  // different one because this selector kept its own value is the kind of
  // mistake that is only noticed after the run. Still selectable here, so a
  // deliberate choice made after the fact is not overridden on every render.
  useEffect(() => {
    if (selectedProject && selectedProject !== 'ALL') setProject(selectedProject);
  }, [selectedProject]);

  // Suggestions are computed from the feature table for whatever is in
  // scope, so they change with the project.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    fetch(`/api/ml/suggestions?project=${encodeURIComponent(project)}`)
      .then(r => r.json())
      .then((data: Suggestions) => { if (!cancelled) setSuggest(data); })
      .catch(() => { if (!cancelled) setSuggest(null); });
    return () => { cancelled = true; };
  }, [project]);

  // Poll only while a run is in flight.
  useEffect(() => {
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetch('/api/ml/retrain');
        const state: RetrainState = await res.json();
        setRetrain(state);
        if (state.running) timer = window.setTimeout(poll, 1500);
      } catch {
        // Stop polling rather than spin against a server that is down.
      }
    };
    poll();
    return () => { if (timer) window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [retrain?.log?.length]);

  const run = useCallback(async () => {
    setError(null);
    if (algorithms.length === 0) {
      setError('Pick at least one detector to train.');
      return;
    }
    try {
      const res = await fetch('/api/ml/retrain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: project || undefined,
          algorithms,
          contamination: contamination || undefined,
          nEstimators: nEstimators || undefined,
          minSamples: minSamples || undefined,
          holdoutFraction: holdoutFraction || undefined,
          since: since || undefined,
          until: until || undefined,
          skipPreprocess,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        setError(body.error || `Server refused the run (HTTP ${res.status})`);
        return;
      }
      setRetrain({ running: true, startedAt: new Date().toISOString(), finishedAt: null, log: [], exitCode: null });
      const poll = async () => {
        const state: RetrainState = await (await fetch('/api/ml/retrain')).json();
        setRetrain(state);
        if (state.running) window.setTimeout(poll, 1500);
      };
      window.setTimeout(poll, 800);
    } catch (e: any) {
      setError(e?.message || 'Could not reach the server');
    }
  }, [project, algorithms, contamination, nEstimators, minSamples, holdoutFraction, since, until, skipPreprocess]);

  const running = Boolean(retrain?.running);

  // Exactly what the server will run, so there is no guessing about which
  // flags a given set of fields produces.
  const commandPreview = [
    'python3 train.py',
    project ? `--project ${project}` : '',
    algorithms.length && algorithms.length < ALGORITHMS.length ? `--algorithms ${algorithms.join(',')}` : '',
    contamination ? `--contamination ${contamination}` : '',
    nEstimators ? `--n-estimators ${nEstimators}` : '',
    minSamples ? `--min-samples ${minSamples}` : '',
    holdoutFraction ? `--holdout-fraction ${holdoutFraction}` : '',
    since ? `--since ${since}` : '',
    until ? `--until ${until}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="ml-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--color-text-main)' }}>Execution</h3>
        <InfoTip>
          The pipeline steps in the order they run, each showing the real source of the script it
          executes - fetched from the server, so what is displayed cannot drift from what runs.
          <br /><br />
          Hyperparameters are passed to <code>train.py</code> as CLI flags. Anything left blank keeps the
          default from <code>ml/config.json</code>, and the exact command is previewed before you run it.
        </InfoTip>
      </div>

      {/* ---- cell 1: scope ---- */}
      <div style={cell}>
        <div style={{ ...cellTitle, marginBottom: '12px' }}>
          <span style={stepNo}>1</span>Scope
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={label}>Project</label>
            <select value={project} onChange={e => setProject(e.target.value)} disabled={running} style={input}>
              {projects.length === 0 && <option value="">(no data yet)</option>}
              {projects.map(p => <option key={p} value={p}>{p}</option>)}
              <option value="ALL">All projects</option>
            </select>
            <div style={helper}>
              One project at a time. Models are per service either way - this picks which get rebuilt.
            </div>
          </div>
          <div>
            <label style={label}>Train on data since</label>
            <input value={since} onChange={e => setSince(e.target.value)} disabled={running}
                   placeholder="2026-09-17T00:00:00Z" style={input} />
            <div style={helper}>
              Use to exclude a known stress window from the training set.
            </div>
          </div>
          <div>
            <label style={label}>Until</label>
            <input value={until} onChange={e => setUntil(e.target.value)} disabled={running}
                   placeholder="(now)" style={input} />
          </div>
        </div>
      </div>

      {/* ---- cell 2: preprocess ---- */}
      <div style={cell}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={cellTitle}>
            <span style={stepNo}>2</span>Preprocess
            <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--color-text-dim)', fontFamily: mono }}>features.csv</span>
          </div>
          <label style={{ fontSize: '12px', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={skipPreprocess} onChange={e => setSkipPreprocess(e.target.checked)} disabled={running}
                   style={{ accentColor: 'var(--color-accent-cyan)' }} />
            Skip this step
          </label>
        </div>
        <div style={{ marginTop: '6px' }}>
          <InfoTip label="What this step does">
            Rebuilds the feature table for <em>every</em> service - it is not project-scoped, and it is
            the slow step. Skip it when tuning hyperparameters against data that has not changed.
          </InfoTip>
        </div>
        <CodeCell source={sources.preprocess || null} collapsed={collapsed.preprocess}
                  onToggle={() => setCollapsed(c => ({ ...c, preprocess: !c.preprocess }))} />
      </div>

      {/* ---- cell 3: train ---- */}
      <div style={cell}>
        <div style={{ ...cellTitle, marginBottom: '12px' }}>
          <span style={stepNo}>3</span>Train
        </div>

        {/* What the suggestions below are reasoning from. Without this the
            numbers look like defaults rather than measurements. */}
        {suggest?.available && suggest.observed && (
          <div style={{
            marginBottom: '12px', padding: '8px 12px', borderRadius: '8px',
            background: 'rgba(255,255,255,0.02)', border: '1px solid var(--color-border)',
            fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: 1.6, fontVariantNumeric: 'tabular-nums',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>
                <span style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>Measured for {suggest.project}:</span>{' '}
                {suggest.observed.services} services · median{' '}
                <span style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>{suggest.observed.median_distinct}</span>
                {' '}distinct of {suggest.observed.median_rows} rows
              </span>
              <InfoTip label="Where these come from">
                Every suggestion below is computed from this project's own feature table, not from a
                textbook default - so they say what will happen to <em>these</em> services.
                {suggest.observed.thinnest.length > 0 && (
                  <>
                    <br /><br />
                    Thinnest services (distinct/total):{' '}
                    {suggest.observed.thinnest.map(t => `${t.sid.split(':').slice(1).join(':')} ${t.distinct}/${t.rows}`).join(' · ')}
                  </>
                )}
              </InfoTip>
            </div>
          </div>
        )}

        {(suggest?.warnings ?? []).map((w, i) => (
          <div key={i} style={{
            marginBottom: '12px', padding: '8px 12px', borderRadius: '8px',
            background: 'rgba(232,163,61,0.06)', border: '1px solid rgba(232,163,61,0.25)',
            fontSize: '12px', color: 'var(--color-degraded)', lineHeight: 1.5,
          }}>{w}</div>
        ))}

        <label style={label}>Detectors</label>
        {Array.isArray(suggest?.suggestions?.algorithms?.suggested) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap',
            fontSize: '12px', color: 'var(--color-text-muted)',
          }}>
            <span>Suggested:</span>
            <button
              type="button" disabled={running}
              onClick={() => setAlgorithms(suggest!.suggestions!.algorithms.suggested as string[])}
              style={{
                background: 'rgba(138,180,255,0.1)', border: '1px solid rgba(138,180,255,0.3)',
                color: 'var(--color-accent-cyan)', borderRadius: '6px', height: '24px', padding: '0 10px',
                fontSize: '12px', cursor: running ? 'not-allowed' : 'pointer', fontWeight: 550, fontFamily: 'inherit',
              }}
            >{(suggest!.suggestions!.algorithms.suggested as string[]).join(', ')}</button>
            <InfoTip label="Why these">{suggest!.suggestions!.algorithms.reason}</InfoTip>
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
          {ALGORITHMS.map(a => {
            const on = algorithms.includes(a.id);
            return (
              <button
                key={a.id} type="button" disabled={running}
                onClick={() => setAlgorithms(prev => on ? prev.filter(x => x !== a.id) : [...prev, a.id])}
                title={a.note}
                style={{
                  background: on ? 'rgba(138,180,255,0.12)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${on ? 'rgba(138,180,255,0.35)' : 'var(--color-border)'}`,
                  color: on ? '#dfe8ff' : 'var(--color-text-muted)',
                  borderRadius: '8px', height: '30px', padding: '0 12px', fontSize: '12.5px',
                  cursor: running ? 'not-allowed' : 'pointer', fontWeight: 550, fontFamily: 'inherit',
                }}
              >{a.label}</button>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          <div>
            <label style={label}>Contamination</label>
            <input value={contamination} onChange={e => setContamination(e.target.value)} disabled={running}
                   type="number" step="0.001" min="0" max="0.5" placeholder="0.01" style={input} />
            <Hint s={suggest?.suggestions?.contamination} current={contamination} onApply={setContamination} />
          </div>
          <div>
            <label style={label}><span style={{ fontFamily: mono, fontSize: '12px' }}>n_estimators</span></label>
            <input value={nEstimators} onChange={e => setNEstimators(e.target.value)} disabled={running}
                   type="number" min="10" placeholder="200" style={input} />
            <Hint s={suggest?.suggestions?.n_estimators} current={nEstimators} onApply={setNEstimators} />
          </div>
          <div>
            <label style={label}>Min samples</label>
            <input value={minSamples} onChange={e => setMinSamples(e.target.value)} disabled={running}
                   type="number" min="1" placeholder="30" style={input} />
            <Hint s={suggest?.suggestions?.min_samples} current={minSamples} onApply={setMinSamples} />
          </div>
          <div>
            <label style={label}>Holdout fraction</label>
            <input value={holdoutFraction} onChange={e => setHoldoutFraction(e.target.value)} disabled={running}
                   type="number" step="0.05" min="0" max="0.9" placeholder="0.2" style={input} />
            <Hint s={suggest?.suggestions?.holdout_fraction} current={holdoutFraction} onApply={setHoldoutFraction} />
          </div>
        </div>

        <CodeCell source={sources.train || null} collapsed={collapsed.train}
                  onToggle={() => setCollapsed(c => ({ ...c, train: !c.train }))} />
      </div>

      {/* ---- run ---- */}
      <div style={{ marginBottom: '12px' }}>
        <label style={label}>Command</label>
        <pre style={{
          margin: 0, padding: '10px 12px', background: 'var(--color-bg-body)', border: '1px solid var(--color-border)', borderRadius: '8px',
          fontSize: '12px', lineHeight: 1.55, color: 'var(--color-text-main)', fontFamily: mono,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>{skipPreprocess ? '' : 'python3 preprocess.py && '}{commandPreview}</pre>
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <button
          type="button" onClick={run} disabled={running}
          className="mm-btn primary"
          style={{ opacity: running ? 0.6 : 1, cursor: running ? 'not-allowed' : 'pointer' }}
        >
          {running ? <Loader2 size={14} strokeWidth={1.75} style={{ animation: 'mm-spin 1s linear infinite' }} /> : <Play size={14} strokeWidth={1.75} />}
          {running ? 'Running…' : 'Run'}
        </button>
        {retrain?.finishedAt && !running && (
          <span
            className="mm-chip"
            style={retrain.exitCode === 0
              ? { background: 'rgba(62,207,142,0.1)', color: 'var(--color-healthy)' }
              : { background: 'rgba(239,95,103,0.1)', color: 'var(--color-critical)' }}
          >
            <i className="mm-dot" style={{ background: 'currentColor' }} />
            {retrain.exitCode === 0 ? 'Finished cleanly' : `Exited ${retrain.exitCode}`}
          </span>
        )}
      </div>

      {error && (
        <div style={{
          marginTop: '12px', background: 'rgba(239,95,103,0.06)', border: '1px solid rgba(239,95,103,0.25)',
          borderRadius: '8px', padding: '8px 12px', fontSize: '12px', color: 'var(--color-critical)',
        }}>{error}</div>
      )}

      {retrain && retrain.log.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <label style={label}>Output</label>
          <pre ref={logRef} style={{
            margin: 0, padding: '10px 12px', maxHeight: '260px', overflow: 'auto',
            background: 'var(--color-bg-body)', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '12px',
            lineHeight: 1.55, color: 'var(--color-text-muted)', fontFamily: mono,
            whiteSpace: 'pre-wrap',
          }}>{retrain.log.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
