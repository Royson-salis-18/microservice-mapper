import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Notebook-style execution panel for the ML pipeline.
 *
 * The cells are the real pipeline steps, in the order they run, each showing
 * the actual source of the script it executes — fetched from the server, not
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

const panel: React.CSSProperties = {
  background: 'var(--color-bg-panel)',
  border: '1px solid var(--color-border)',
  borderRadius: '12px',
  padding: '16px',
};

const label: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--color-text-muted)',
  textTransform: 'uppercase',
  fontWeight: 600,
  display: 'block',
  marginBottom: '4px',
  letterSpacing: '0.04em',
};

const input: React.CSSProperties = {
  width: '100%',
  background: 'rgba(0,0,0,0.35)',
  color: '#fff',
  border: '1px solid var(--color-border)',
  borderRadius: '6px',
  padding: '6px 8px',
  fontSize: '11px',
  outline: 'none',
};

function CodeCell({ source, collapsed, onToggle }: { source: SourceDoc | null; collapsed: boolean; onToggle: () => void }) {
  if (!source) return null;
  return (
    <div style={{ marginTop: '10px', border: '1px solid var(--color-border)', borderRadius: '8px', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%', textAlign: 'left', background: 'rgba(255,255,255,0.03)', border: 'none',
          color: 'var(--color-text-muted)', padding: '6px 10px', fontSize: '10px', cursor: 'pointer',
          fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between',
        }}
      >
        <span>{collapsed ? '▸' : '▾'} ml/{source.file}</span>
        <span>{source.lines} lines · read-only</span>
      </button>
      {!collapsed && (
        <pre style={{
          margin: 0, padding: '10px', maxHeight: '340px', overflow: 'auto',
          background: 'rgba(0,0,0,0.4)', fontSize: '10px', lineHeight: 1.5,
          color: 'var(--color-text-dim)', fontFamily: 'monospace',
        }}>{source.code}</pre>
      )}
    </div>
  );
}

/**
 * The suggestion under a hyperparameter field.
 *
 * Shows the value, the sane range, and one click to take it — with the
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
    <div style={{ marginTop: '4px', fontSize: '9px', color: 'var(--color-text-dim)', lineHeight: 1.5 }}>
      <span>suggest </span>
      <button
        type="button"
        onClick={() => onApply(value)}
        title={applied ? 'already set' : `use ${value}`}
        style={{
          background: applied ? 'rgba(0,230,118,0.15)' : 'rgba(0,212,255,0.12)',
          border: `1px solid ${applied ? 'var(--color-healthy)' : 'var(--color-accent-cyan)'}`,
          color: applied ? 'var(--color-healthy)' : 'var(--color-accent-cyan)',
          borderRadius: '4px', padding: '0 5px', fontSize: '9px', cursor: 'pointer', fontWeight: 700,
        }}
      >{value}</button>
      {s.range && <span> · usual {s.range[0]}–{s.range[1]}</span>}
      <button
        type="button" onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: '9px', padding: '0 0 0 5px', textDecoration: 'underline' }}
      >{open ? 'less' : 'why'}</button>
      {open && (
        <div style={{ marginTop: '4px', padding: '6px 8px', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', color: 'var(--color-text-muted)' }}>
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
    <div style={panel}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 700 }}>Execution</h3>
      <p style={{ margin: '0 0 14px 0', fontSize: '11px', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
        The pipeline steps in the order they run, each showing the source of the script it executes.
        Scope to one project and set the hyperparameters; they are passed to <code>train.py</code> as
        CLI flags, and anything left blank keeps the default from <code>ml/config.json</code>.
      </p>

      {/* ---- cell 1: scope ---- */}
      <div style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, marginBottom: '8px', color: 'var(--color-accent-cyan)' }}>
          [1] Scope
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={label}>Project</label>
            <select value={project} onChange={e => setProject(e.target.value)} disabled={running} style={input}>
              {projects.length === 0 && <option value="">(no data yet)</option>}
              {projects.map(p => <option key={p} value={p}>{p}</option>)}
              <option value="ALL">all projects</option>
            </select>
            <div style={{ fontSize: '9px', color: 'var(--color-text-dim)', marginTop: '3px' }}>
              One project at a time. Models are per service either way — this picks which get rebuilt.
            </div>
          </div>
          <div>
            <label style={label}>Train on data since</label>
            <input value={since} onChange={e => setSince(e.target.value)} disabled={running}
                   placeholder="2026-09-17T00:00:00Z" style={input} />
            <div style={{ fontSize: '9px', color: 'var(--color-text-dim)', marginTop: '3px' }}>
              Use to exclude a known stress window from the training set.
            </div>
          </div>
          <div>
            <label style={label}>…until</label>
            <input value={until} onChange={e => setUntil(e.target.value)} disabled={running}
                   placeholder="(now)" style={input} />
          </div>
        </div>
      </div>

      {/* ---- cell 2: preprocess ---- */}
      <div style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-accent-cyan)' }}>
            [2] Preprocess → features.csv
          </div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={skipPreprocess} onChange={e => setSkipPreprocess(e.target.checked)} disabled={running} />
            skip this step
          </label>
        </div>
        <div style={{ fontSize: '10px', color: 'var(--color-text-dim)', marginTop: '6px', lineHeight: 1.5 }}>
          Rebuilds the feature table for every service — it is not project-scoped, and it is the slow step.
          Skip it when tuning hyperparameters against data that has not changed.
        </div>
        <CodeCell source={sources.preprocess || null} collapsed={collapsed.preprocess}
                  onToggle={() => setCollapsed(c => ({ ...c, preprocess: !c.preprocess }))} />
      </div>

      {/* ---- cell 3: train ---- */}
      <div style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, marginBottom: '8px', color: 'var(--color-accent-cyan)' }}>
          [3] Train
        </div>

        {/* What the suggestions below are reasoning from. Without this the
            numbers look like defaults rather than measurements. */}
        {suggest?.available && suggest.observed && (
          <div style={{
            marginBottom: '10px', padding: '8px 10px', borderRadius: '6px',
            background: 'rgba(0,212,255,0.06)', border: '1px solid rgba(0,212,255,0.25)',
            fontSize: '10px', color: 'var(--color-text-muted)', lineHeight: 1.6,
          }}>
            <strong style={{ color: 'var(--color-accent-cyan)' }}>Measured for {suggest.project}:</strong>{' '}
            {suggest.observed.services} service(s), median{' '}
            <strong style={{ color: 'var(--color-text-main)' }}>{suggest.observed.median_distinct}</strong> distinct
            rows out of {suggest.observed.median_rows}. Suggestions below come from these numbers, not from defaults.
            {suggest.observed.thinnest.length > 0 && (
              <div style={{ marginTop: '4px', color: 'var(--color-text-dim)' }}>
                thinnest: {suggest.observed.thinnest.map(t => `${t.sid.split(':').slice(1).join(':')} ${t.distinct}/${t.rows}`).join(' · ')}
              </div>
            )}
          </div>
        )}

        {(suggest?.warnings ?? []).map((w, i) => (
          <div key={i} style={{
            marginBottom: '10px', padding: '8px 10px', borderRadius: '6px',
            background: 'rgba(255,171,0,0.08)', border: '1px solid rgba(255,171,0,0.3)',
            fontSize: '10px', color: 'var(--color-degraded)', lineHeight: 1.5,
          }}>{w}</div>
        ))}

        <label style={label}>Detectors</label>
        {Array.isArray(suggest?.suggestions?.algorithms?.suggested) && (
          <div style={{ fontSize: '9px', color: 'var(--color-text-dim)', marginBottom: '6px', lineHeight: 1.5 }}>
            suggest{' '}
            <button
              type="button" disabled={running}
              onClick={() => setAlgorithms(suggest!.suggestions!.algorithms.suggested as string[])}
              style={{
                background: 'rgba(0,212,255,0.12)', border: '1px solid var(--color-accent-cyan)',
                color: 'var(--color-accent-cyan)', borderRadius: '4px', padding: '0 5px',
                fontSize: '9px', cursor: running ? 'not-allowed' : 'pointer', fontWeight: 700,
              }}
            >{(suggest!.suggestions!.algorithms.suggested as string[]).join(', ')}</button>
            <span> — {suggest!.suggestions!.algorithms.reason}</span>
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
                  background: on ? 'rgba(0,212,255,0.18)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${on ? 'var(--color-accent-cyan)' : 'var(--color-border)'}`,
                  color: on ? '#fff' : 'var(--color-text-dim)',
                  borderRadius: '6px', padding: '5px 10px', fontSize: '10px',
                  cursor: running ? 'not-allowed' : 'pointer', fontWeight: 600,
                }}
              >{a.label}</button>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
          <div>
            <label style={label}>Contamination</label>
            <input value={contamination} onChange={e => setContamination(e.target.value)} disabled={running}
                   type="number" step="0.001" min="0" max="0.5" placeholder="0.01" style={input} />
            <Hint s={suggest?.suggestions?.contamination} current={contamination} onApply={setContamination} />
          </div>
          <div>
            <label style={label}>n_estimators</label>
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
      <div style={{ marginBottom: '10px' }}>
        <label style={label}>Command</label>
        <pre style={{
          margin: 0, padding: '8px 10px', background: 'rgba(0,0,0,0.4)', borderRadius: '6px',
          fontSize: '10px', color: 'var(--color-healthy)', fontFamily: 'monospace',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>{skipPreprocess ? '' : 'python3 preprocess.py && '}{commandPreview}</pre>
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <button
          type="button" onClick={run} disabled={running}
          style={{
            background: running ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, rgba(0,212,255,0.25), rgba(0,230,118,0.25))',
            border: `1px solid ${running ? 'var(--color-border)' : 'var(--color-accent-cyan)'}`,
            color: running ? 'var(--color-text-dim)' : '#fff',
            borderRadius: '8px', padding: '8px 18px', fontSize: '11px', fontWeight: 700,
            cursor: running ? 'not-allowed' : 'pointer', letterSpacing: '0.04em',
          }}
        >{running ? 'RUNNING…' : '▶ RUN'}</button>
        {retrain?.finishedAt && !running && (
          <span style={{ fontSize: '10px', color: retrain.exitCode === 0 ? 'var(--color-healthy)' : 'var(--color-critical)' }}>
            {retrain.exitCode === 0 ? 'finished cleanly' : `exited ${retrain.exitCode}`}
          </span>
        )}
      </div>

      {error && (
        <div style={{
          marginTop: '10px', background: 'rgba(255,82,82,0.1)', border: '1px solid rgba(255,82,82,0.4)',
          borderRadius: '6px', padding: '8px 10px', fontSize: '10px', color: 'var(--color-critical)',
        }}>{error}</div>
      )}

      {retrain && retrain.log.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <label style={label}>Output</label>
          <pre ref={logRef} style={{
            margin: 0, padding: '10px', maxHeight: '260px', overflow: 'auto',
            background: 'rgba(0,0,0,0.45)', borderRadius: '6px', fontSize: '10px',
            lineHeight: 1.55, color: 'var(--color-text-dim)', fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
          }}>{retrain.log.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
