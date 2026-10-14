#!/usr/bin/env node
// graphs/model-lab.ts: the model lab. ONE html file with every chart behind the mapper's detection and learning, built from recorded runs.
//
//   npm run ml:report -- <run-dir> [<run-dir> ...] [--out graphs/output/model-lab.html] [--k 5] [--quick] [--wiki]
//   (--wiki also copies the file into `wiki visualizer/model-lab.html`)
//
// Sections: 1 data (what was recorded, distributions, skewness, missing values, sampling), 2 features (how they separate
// healthy from faulted, their correlation), 3 model (weights, threshold, ROC, calibration), 4 comparison (rules vs learned vs
// the live mapper, per fault class, per fault, cross-bench), 5 sensitivity (sliding window, minimum history, persistence,
// regularisation, folds), 6 where the data lives and what flows through each stage, 7 every hyperparameter in use.
// Every number is computed from the recorded runs; every hyperparameter is imported from the code that uses it.
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns } from '../run/cli/ml/run.ts';
import { buildRun, labelledRows, DEFAULT_HISTORY, DEFAULT_MIN_HISTORY, FEATURE_NAMES, type Run } from '../algorithms/learning/dataset.ts';
import { crossSystem, crossValidate, summarise, train, scorer, LAMBDAS, METHODS, RULES_FIXED_THRESHOLD, type Method } from '../algorithms/learning/experiment.ts';
import { evaluatePrepared, prepare } from '../algorithms/learning/evaluate.ts';
import { predict, LOGREG_PARAMS } from '../algorithms/learning/logreg.ts';
import { rulesScore } from '../algorithms/detection/scoring.ts';
import { PAL, bars, esc, f2, flow, heat, histogram, hbars, lines, pct, table } from './charts.ts';
import { auc, parseObserved, wilson } from '../algorithms/evaluation/score.ts';
import { moments, pearson } from '../algorithms/evaluation/stats.ts';
import { DETECTOR_PARAMS } from '../algorithms/detection/AnomalyDetector.ts';
import { SIGNALS } from '../algorithms/detection/features.ts';
import { TARGET_MODEL_PARAMS } from '../algorithms/model/TargetModel.ts';
import { baselineNeededSec } from '../server/rca/TargetModels.ts';
import { DEFAULT_THRESHOLDS, THRESHOLD_DOCS } from '../algorithms/detection/thresholds.ts';
import { COLLECTOR_PARAMS } from '../algorithms/detection/requestStats.ts';
import { config } from '../server/config.ts';
import { MetricStore } from '../server/telemetry/MetricStore.ts';
import { TraceStore } from '../server/traces/TraceStore.ts';
import { GraphStore, GRAPH_SAVE_DEBOUNCE_MS } from '../server/graph/GraphStore.ts';
import { DEFAULT_TRANSMISSION, ANOMALY_WEIGHT, PERSISTENT_ANOMALY_WEIGHT, STATUS_PROBABILITY } from '../algorithms/graph/CascadeEngine.ts';
import { HEALTH_WEIGHTS } from '../server/graph/RiskEngine.ts';
import { CONFIDENCE, TELEMETRY_FACTOR } from '../algorithms/graph/EdgeWeights.ts';
import { LINK_THRESHOLDS } from '../algorithms/graph/linkThresholds.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const K = Number(opt('k', '5')), outFile = opt('out', 'graphs/output/model-lab.html'), quick = args.includes('--quick');
const log = (s: string) => console.error(`[model-lab] ${s}`);

const { runs, texts } = loadRuns(dirs);
if (!runs.length) { console.error('no usable runs: pass directories holding observed-<subject>.jsonl and ledger-<subject>.jsonl'); process.exit(1); }
const subjects = [...new Set(runs.map((r) => r.subject))];
const subjColor = (s: string) => PAL[subjects.indexOf(s) % PAL.length];
const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const fmtMin = (sec: number) => (sec >= 90 ? `${(sec / 60).toFixed(1)} min` : `${Math.round(sec)} s`);

// ------------------------------------------------------------------ 1. data
log('data');
const RAW = [
  { key: 'cpu', label: 'CPU %', unit: 0.5, log: true }, { key: 'memoryPercent', label: 'memory %', unit: 1, log: true },
  { key: 'networkRxRate', label: 'net in', unit: 2000, log: true }, { key: 'networkTxRate', label: 'net out', unit: 2000, log: true },
  { key: 'requestRate', label: 'requests/s', unit: 0.1, log: true }, { key: 'latencyP95', label: 'p95 ms', unit: 1, log: true },
  { key: 'errorRate', label: 'error share', unit: 0, log: false }, { key: 'cpuThrottledPct', label: 'throttled %', unit: 0, log: false },
];
type Row = Record<string, number | string | boolean | null>;
const series: Record<string, Record<string, number[]>> = {};                 // signal -> "subject|service" -> healthy values
const missing: Record<string, { n: number; miss: number }> = {};              // "subject|signal"
const gaps: number[] = [];
const spans: { run: string; minutes: number; snaps: number; spacing: number }[] = [];
texts.forEach((t, ri) => {
  const run = runs[ri], snaps = parseObserved(t.observed).filter((s) => s.metrics);
  const lastKey = new Map<string, string>(), lastT = new Map<string, number>(), spacing: number[] = [];
  const bad = (ts: number) => run.faults.some((f) => ts >= f.a - 60000 && ts <= f.b + 120000) || ts < run.t0 + 300000;
  for (const s of snaps) for (const [id, m] of Object.entries(s.metrics as Record<string, Row>)) {
    if (id === 'traffic') continue;
    const k = JSON.stringify(m);
    if (lastKey.get(id) === k) continue;
    lastKey.set(id, k);
    const prev = lastT.get(id); if (prev !== undefined) { spacing.push((s.ts - prev) / 1000); gaps.push((s.ts - prev) / 1000); } lastT.set(id, s.ts);
    for (const sg of RAW) {
      const mk = `${t.subject}|${sg.key}`; missing[mk] ??= { n: 0, miss: 0 }; missing[mk].n++;
      const v = m[sg.key];
      if (typeof v !== 'number' || !Number.isFinite(v)) { missing[mk].miss++; continue; }
      if (bad(s.ts)) continue;
      ((series[sg.key] ??= {})[`${t.subject}|${id}`] ??= []).push(v);
    }
  }
  spans.push({ run: run.name, minutes: (run.t1 - run.t0) / 60000, snaps: snaps.length, spacing: med(spacing) });
});
const readingSpacing = med(gaps) || 8;
const skewRows = RAW.map((sg) => {
  const per = Object.values(series[sg.key] ?? {}).filter((v) => v.length >= 30);
  const stat = (tf: (v: number) => number) => per.map((v) => moments(v.map(tf))).filter((m) => Number.isFinite(m.skew));
  const raw = stat((v) => v), lg = stat((v) => (sg.log ? Math.log(Math.max(v, 0) + sg.unit) : v));
  return { sg, n: per.length, rawSkew: med(raw.map((m) => m.skew)), lgSkew: med(lg.map((m) => m.skew)), rawKurt: med(raw.map((m) => m.kurt)), lgKurt: med(lg.map((m) => m.kurt)) };
});
const pooled = (key: string, tf: (v: number) => number) => Object.values(series[key] ?? {}).filter((v) => v.length >= 30).flatMap((v) => { const m = med(v.map(tf)); return v.map((x) => tf(x) - m); });
const ratioPooled = (key: string) => Object.values(series[key] ?? {}).filter((v) => v.length >= 30).flatMap((v) => { const m = med(v); return m > 0 ? v.map((x) => x / m) : []; });

// ------------------------------------------------------------------ labelled rows
const allRows = runs.map((r) => labelledRows(r));
const X = allRows.flatMap((d) => d.X), Y = allRows.flatMap((d) => d.y);
const featCol = (j: number) => X.map((r) => r[j]);

// ------------------------------------------------------------------ 3/4. model and comparison
log('training and blocked cross-validation');
const cv = crossValidate(runs, K);
const sum = Object.fromEntries(METHODS.map((m) => [m, summarise(cv.pooled[m])])) as Record<Method, ReturnType<typeof summarise>>;
const final = train(runs);
const cross = crossSystem(runs);
const nameOf: Record<Method, string> = { learned: 'Learned model', rulesFixed: 'Rules, fixed threshold', rulesTuned: 'Rules, tuned threshold', live: 'Live mapper (as recorded)' };
const colorOf: Record<Method, string> = { learned: PAL[0], rulesFixed: PAL[3], rulesTuned: PAL[2], live: PAL[7] };

function roc(rows: { s: number; y: number }[]) {
  const sorted = [...rows].sort((a, b) => b.s - a.s), P = rows.filter((r) => r.y === 1).length, N = rows.length - P;
  const pts: [number, number][] = [[0, 0]], pr: [number, number][] = [];
  let tp = 0, fp = 0;
  sorted.forEach((r, i) => { if (r.y === 1) tp++; else fp++; if (i === sorted.length - 1 || sorted[i + 1].s !== r.s) { pts.push([N ? fp / N : 0, P ? tp / P : 0]); pr.push([P ? tp / P : 0, tp / (tp + fp)]); } });
  const thin = <T,>(a: T[]) => (a.length > 220 ? a.filter((_, i) => i % Math.ceil(a.length / 220) === 0) : a);
  return { roc: thin(pts), pr: thin(pr), auc: auc(rows.map((r) => r.s), rows.map((r) => r.y)), P, N };
}
const rocL = roc(cv.rows.learned), rocR = roc(cv.rows.rules);
const calib = (() => {
  const bins = Array.from({ length: 10 }, () => ({ s: 0, y: 0, n: 0 }));
  for (const r of cv.rows.learned) { const b = bins[Math.min(9, Math.floor(r.s * 10))]; b.s += r.s; b.y += r.y; b.n++; }
  return bins.filter((b) => b.n >= 5).map((b) => [b.s / b.n, b.y / b.n] as [number, number]);
})();

// operating curves over the whole data (in-sample: shows the trade-off, not an unbiased estimate)
const operating = (name: string, f: (x: number[]) => number, ths: number[]) => {
  const prep = prepare(runs, scorer(runs, f));
  return ths.map((th) => { const r = evaluatePrepared(prep, null, th); return { th, det: r.detected.p, top1: r.faults.length ? r.faults.filter((x) => x.top1).length / r.faults.length : 0, fa: r.perHour }; });
};
const learnedTh = Array.from({ length: 24 }, (_, i) => 0.02 + (i * 0.96) / 23);
const rulesTh = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30];
const opL = operating('learned', (x) => predict(final.model, x), learnedTh), opR = operating('rules', rulesScore, rulesTh);

// score timeline for the run with most faults
const showRun = runs.reduce((a, b) => (b.faults.length > a.faults.length ? b : a));
const timeline = (run: Run, f: (x: number[]) => number, label: string, color: (i: number) => string, yMax?: number) => {
  const sc = run.moments.map((m) => m.X.map(f)), top = new Map<string, number>();
  sc.forEach((row, i) => row.forEach((v, j) => top.set(run.moments[i].services[j], Math.max(top.get(run.moments[i].services[j]) ?? 0, v))));
  const names = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
  const t0 = run.t0;
  return lines({ title: label, w: 940, h: 250, xlabel: 'minutes into the run', ylabel: 'score', yRange: yMax ? [0, yMax] : undefined,
    series: names.map((n, k) => ({ label: n, color: color(k), width: 1.6, points: run.moments.map((m, i) => [(m.ts - t0) / 60000, Math.min(yMax ?? 1e9, sc[i][m.services.indexOf(n)] ?? 0)] as [number, number]) })),
    bands: run.faults.map((fl) => ({ a: (fl.a - t0) / 60000, b: (fl.b - t0) / 60000 })), note: `Shaded bands are the injected faults (ground truth from the ledger): ${run.faults.map((fl) => `${fl.class} on ${fl.target}`).join(', ')}. Showing the four highest-scoring services.` });
};

// ------------------------------------------------------------------ 5. sensitivity
log('sensitivity sweeps');
interface Pt { x: number; learned: ReturnType<typeof summarise>; rules: ReturnType<typeof summarise> }
const evalCfg = (rs: Run[], k: number, opts: { persistence?: number } = {}, lambdas = LAMBDAS): Pt['learned' | 'rules'] extends never ? never : { learned: ReturnType<typeof summarise>; rules: ReturnType<typeof summarise> } => {
  const c = crossValidate(rs, k, opts, lambdas);
  return { learned: summarise(c.pooled.learned), rules: summarise(c.pooled.rulesTuned) };
};
const rebuild = (o: { history?: number; minHistory?: number }) => texts.map((t) => buildRun(t.name, t.subject, t.ledger, t.observed, o)).filter((r) => r.moments.length && r.faults.length);
const sweeps: { id: string; title: string; xlabel: string; xs: number[]; pts: Pt[]; xFmt?: (v: number) => string; note: string }[] = [];
if (!quick) {
  const wins = [20, 40, 80, DEFAULT_HISTORY, 240, 480];
  sweeps.push({ id: 'window', title: 'Sliding window of the baseline', xlabel: `window (samples; 1 sample ≈ ${readingSpacing.toFixed(0)} s)`, xs: wins, xFmt: (v) => `${v} (${((v * readingSpacing) / 60).toFixed(0)} min)`,
    pts: wins.map((h) => ({ x: h, ...evalCfg(rebuild({ history: h }), K) })), note: 'How much recent past defines "normal" for each signal. Too short: the baseline follows a fault. Too long: it follows daily drift and old incidents.' });
  const mh = [6, 12, 24];
  sweeps.push({ id: 'minhist', title: 'Minimum history before a signal is judged', xlabel: 'samples required', xs: mh, pts: mh.map((m) => ({ x: m, ...evalCfg(rebuild({ minHistory: m }), K) })), note: 'Signals with less past than this are not judged (cold start). Lower catches faults sooner after start-up and raises false alarms.' });
  const per = [1, 2, 3, 4];
  sweeps.push({ id: 'persist', title: 'Persistence: consecutive moments above the threshold', xlabel: 'moments in a row', xs: per, pts: per.map((p) => ({ x: p, ...evalCfg(runs, K, { persistence: p }) })), note: 'An alarm needs this many moments in a row. More persistence removes one-off spikes and delays detection by one moment each.' });
  const lam = [0.01, 0.1, 1, 10, 100];
  sweeps.push({ id: 'lambda', title: 'Regularisation strength of the learned model (lambda)', xlabel: 'lambda (log scale)', xs: lam, pts: lam.map((l) => ({ x: l, ...evalCfg(runs, K, {}, [l]) })), note: 'Higher lambda shrinks all weights. With collinear signals a small lambda gives large opposite-sign weights that do not generalise.' });
  const ks = [3, 5, 8];
  sweeps.push({ id: 'folds', title: 'Number of time blocks in the cross-validation', xlabel: 'blocks (K)', xs: ks, pts: ks.map((k) => ({ x: k, ...evalCfg(runs, k) })), note: 'Stability of the estimate: results should not swing with how the run is cut.' });
}
const sweepCharts = (s: (typeof sweeps)[number]) => {
  const mk = (title: string, f: (r: ReturnType<typeof summarise>) => number, yMax?: number, fmt?: (v: number) => string) => lines({ title, w: 300, h: 190, xlabel: s.id === 'window' ? 'window (samples)' : s.xlabel, yRange: yMax ? [0, yMax] : undefined, logX: s.id === 'lambda', dots: true, xFmt: s.id === 'window' ? undefined : undefined, yFmt: fmt,
    series: [{ label: 'Learned', color: PAL[0], points: s.pts.map((p) => [p.x, f(p.learned)] as [number, number]) }, { label: 'Rules (tuned)', color: PAL[2], points: s.pts.map((p) => [p.x, f(p.rules)] as [number, number]) }] });
  return `<h3>${esc(s.title)}</h3><p class="note">${esc(s.note)}</p><div class="grid3">${mk('Faults detected', (r) => r.detected, 1, (v) => pct(v))}${mk('Right service named first (of detected)', (r) => r.top1OfDetected, 1, (v) => pct(v))}${mk('False alarms per hour', (r) => r.falseAlarmsPerHour)}</div>`;
};

// ------------------------------------------------------------------ 6/7. lineage and hyperparameters
const home = '~/.faultlab';
const stages = [
  { label: '1 Collect', sub: 'docker stats, inspect, logs, /proc/net/tcp every cycle', store: 'in memory (remote-collector)' },
  { label: '2 Ingest', sub: 'POST /api/ingest, merged into nodes, edges, metrics', store: 'server/data/graph_db.json' },
  { label: '3 History', sub: 'per-service ring buffer of readings', store: 'server/data/telemetry_db.json' },
  { label: '4 Detect', sub: 'robust z per signal, persistence 2', store: 'in memory (anomaly onsets)' },
  { label: '5 Model', sub: 'per-target baseline model, learned weights', store: 'server/data/models/<target>.json' },
  { label: '6 Rank', sub: 'root cause, cascade, at-risk', store: 'in memory (incidents)' },
  { label: '7 Serve', sub: '/api/graph, /api/incidents, /api/models', store: 'browser (React)' },
  { label: '8 Record', sub: 'observer polls the API, injector writes the ledger', store: `${home}/<run>/{observed,ledger}-<subject>.jsonl` },
  { label: '9 Learn', sub: 'features, logistic model, blocked CV', store: 'server/rca/model/{results,learned}.json' },
];
const storage = table(['What', 'Path', 'Written by', 'How often / how long', 'Read by'], [
  ['Raw readings of one cycle', 'in memory', 'remote-collector/index.ts', `every ${COLLECTOR_PARAMS.pollMs} ms; request stats over a rolling ${COLLECTOR_PARAMS.requestWindowMs / 1000} s window`, 'POST /api/ingest'],
  ['Nodes, edges, targets', 'server/data/graph_db.json', 'GraphStore.saveToDisk', `after a change, debounced ${GRAPH_SAVE_DEBOUNCE_MS} ms; stale nodes pruned`, 'server start, /api/graph'],
  ['Metric history per service', 'server/data/telemetry_db.json', 'MetricStore.saveToDisk', `ring buffer of ${config.METRIC_HISTORY_SIZE} readings per service; saved every ${MetricStore.SAVE_DEBOUNCE_MS / 1000} s`, 'AnomalyDetector, TargetModels, charts'],
  ['Connection events (traces page)', 'server/data/traces_<target>.json', 'TraceStore', `last ${TraceStore.RETENTION_MS / 3600000} h, at most ${TraceStore.MAX_EVENTS} events, written every ${TraceStore.WRITE_DEBOUNCE_MS / 1000} s`, 'Traces page'],
  ['Saved projects (hosts, keys)', 'server/data/remote_config.json', 'POST /api/config/remote', 'on save', 'discovery agents, collector'],
  ['Per-architecture model', 'server/data/models/<target>.json', 'TargetModels.save', 'trained at every start, retrained every 5 min', 'inspection, /api/models'],
  ['Learned weights and threshold', 'server/rca/model/learned.json', 'npm run ml -- --install', 'when you install a trained model', 'LearnedScorer (reloaded on change)'],
  ['Incident rule overrides', 'server/data/incident_thresholds.json', 'POST /api/incidents/thresholds', 'on edit in the UI', 'AnomalyDetector (each cycle)'],
  ['Recorded run: what the mapper showed', `${home}/<run>/observed-<subject>.jsonl`, 'npm run eval -- observe', 'one JSON line per ~5 s: incidents, status, per-service readings, edges', 'algorithms/learning, run/cli/eval'],
  ['Recorded run: what was injected', `${home}/<run>/ledger-<subject>.jsonl`, 'lab/faultlab (bench repos)', 'one line per campaign, fault start and fault end', 'algorithms/learning, run/cli/eval only (never the mapper)'],
  ['Evaluation report', `${home}/eval-<subject>.html`, 'npm run eval -- all', 'on demand', 'you'],
  ['This report', outFile, 'npm run ml:report', 'on demand', 'you'],
]);

const hp = (rows: [string, string | number, string][]) => table(['Parameter', 'Value', 'Meaning'], rows.map(([a, b, c]) => [a, String(b), c]));
const D = DETECTOR_PARAMS, TM = TARGET_MODEL_PARAMS;
const hyper = `
<h3>Collection</h3>${hp([
  ['collector poll interval', `${COLLECTOR_PARAMS.pollMs} ms`, 'pause between collection cycles (env POLLING_INTERVAL)'],
  ['request statistics window', `${COLLECTOR_PARAMS.requestWindowMs / 1000} s`, 'rolling window of log lines behind request rate, error share and latency percentiles'],
  ['server polling interval', `${config.POLLING_INTERVAL_MS} ms`, 'how often the server evaluates targets (env POLLING_INTERVAL_MS)'],
  ['metric history per service', `${config.METRIC_HISTORY_SIZE} readings`, `about ${((config.METRIC_HISTORY_SIZE * COLLECTOR_PARAMS.pollMs) / 60000).toFixed(0)} min at the collector pace (env METRIC_HISTORY_SIZE)`],
  ['edge request-metric time to live', `${GraphStore.REQUEST_METRICS_TTL_MS / 1000} s`, 'how long the last request figures stay when a cycle has none'],
  ['stale edge', `${GraphStore.STALE_EDGE_MS / 1000} s`, 'an edge not seen for this long is dropped from the live graph'],
  ['connection memory / window', `${GraphStore.CONN_MEMORY_MS / 1000} s / ${GraphStore.CONN_WINDOW_MS / 1000} s`, 'distinct-connection counting (TIME_WAIT-safe) and its averaging window'],
  ['edge activity baseline', `rise ${GraphStore.BASELINE_RISE_MS / 1000} s, fall ${GraphStore.BASELINE_FALL_MS / 1000} s, min window ${GraphStore.BASELINE_MIN_WINDOW_MS / 1000} s`, 'asymmetric exponential average of link activity (quick to rise, slow to fall)'],
])}
<h3>Detector (server/rca/AnomalyDetector.ts, DETECTOR_PARAMS)</h3>${hp([
  ['history read', D.historyRange, 'sliding window of the baseline: the newest readings of each service'],
  ['judged samples', D.judgedSamples, 'the newest samples compared with the baseline; all must agree (persistence of the signal)'],
  ['min history samples', DEFAULT_THRESHOLDS.minHistorySamples, 'a signal with less past is not judged (cold start)'],
  ['MAD to std', D.madToStd, '1.4826 × median absolute deviation estimates the standard deviation'],
  ['tail-aware spread', `quantile ${D.tailQuantile} / ${D.tailZ}`, 'spread is also at least the 90% deviation over 1.645 (heavy tails, mostly-zero series)'],
  ['self-heal z', D.selfHealZ, 'runs of ≥2 samples above this z are old incidents and are left out of the baseline'],
  ['noise normalisation', `quantile ${D.healthyQuantile} → z ${D.healthyZ}`, 'a jumpy series is shrunk so its healthy extreme sits at z = 3; quiet series are never amplified'],
  ['z cap', D.zCap, 'largest deviation reported'],
  ['min requests', D.minRequests, 'a p95 or error share needs this many requests in each judged sample'],
  ['silence rule', `history ×${D.silenceHistoryFactor}, expected ≥ ${D.silenceMinExpected}, gap ×${D.silenceGapFactor}`, 'silence on a counted service needs a long past, enough expected requests, and a quiet stretch beyond its own longest gap'],
])}
<h4>Signals (server/rca/features.ts, SIGNALS)</h4>${table(['Signal', 'Trouble direction', 'Scale', 'Unit (resolution)', 'Floor', 'Evidence', 'Min requests'], SIGNALS.map((s) => [s.name, s.direction === 1 ? 'up' : 'down', s.scale, s.unit, s.floor, s.own ? 'own' : 'symptom (inheritable)', s.minRequests ?? '–']))}
<h4>Incident thresholds (editable in the UI; server/rca/thresholds.ts)</h4>${table(['Name', 'Default', 'Meaning'], Object.entries(DEFAULT_THRESHOLDS).map(([k, v]) => [k, String(v), (THRESHOLD_DOCS as Record<string, string>)[k] ?? '']))}
<h3>Per-architecture model (server/rca/TargetModel.ts)</h3>${hp([
  ['baseline needed', `${baselineNeededSec() / 60} min`, 'learning period; only container facts raise incidents until then (env MAPPER_BASELINE_MIN)'],
  ['retrain every', '5 min', 'moments inside an incident (plus 60 s) are left out of every retraining'],
  ['min history', TM.minHistory, 'samples a service needs before it contributes'],
  ['max moments scored', TM.maxMoments, 'bounds the cost of training'],
  ['trim', `top ${((1 - TM.trimQuantile) * 100).toFixed(0)}% when ≥ ${TM.trimMinMoments} moments`, 'tolerates a baseline that is up to 1% faulty'],
  ['outage gap', `${TM.outageGapFactor} × typical gap`, 'a longer gap between moments is an outage and does not count as baseline time'],
  ['threshold', 'max(shared prior, noise ceiling)', 'the shared threshold is the floor; a noisy architecture raises the bar'],
])}
<h3>Learning pipeline (this report; algorithms/learning)</h3>${hp([
  ['features', FEATURE_NAMES.length, FEATURE_NAMES.join(', ')],
  ['baseline window for features', `${DEFAULT_HISTORY} samples`, `≈ ${((DEFAULT_HISTORY * readingSpacing) / 60).toFixed(0)} min at ${readingSpacing.toFixed(0)} s per reading (swept below)`],
  ['min history for features', DEFAULT_MIN_HISTORY, 'swept below'],
  ['model', 'logistic regression', `${LOGREG_PARAMS.penalty}; ${LOGREG_PARAMS.iterations} Newton iterations at most; class-balanced rows`],
  ['lambda grid', LAMBDAS.join(', '), 'chosen on the training blocks by the event objective'],
  ['threshold candidates', 60, 'quantiles of the observed top scores, chosen on the training blocks'],
  ['alarm persistence', 2, 'consecutive moments (swept below)'],
  ['grace after a fault', '60 s', 'an alarm this long after a fault ends still counts for it'],
  ['warm-up left out', '300 s', 'start of each run, while baselines form'],
  ['recovery left out of training', '60 s', 'rows right after a fault are neither faulty nor healthy'],
  ['cross-validation', `${K} time blocks`, 'each run cut into consecutive blocks; a fault is in exactly one block'],
  ['rules, fixed threshold', RULES_FIXED_THRESHOLD, 'the three-sigma line on the rule-based score'],
])}
<h3>Risk and cascade</h3>${hp([
  ['transmission τ', DEFAULT_TRANSMISSION, 'share of a failing dependency\'s probability passed to its caller along an edge'],
  ['status probability', JSON.stringify(STATUS_PROBABILITY), 'intrinsic failure probability by status'],
  ['anomaly weight', `${ANOMALY_WEIGHT} (persistent ${PERSISTENT_ANOMALY_WEIGHT})`, 'only used when MAPPER_ML=1'],
  ['health weights', JSON.stringify(HEALTH_WEIGHTS), 'status, anomaly, incident'],
  ['edge confidence', JSON.stringify(CONFIDENCE), 'by evidence behind the edge'],
  ['telemetry edge factor', TELEMETRY_FACTOR, 'monitoring traffic counts this much relative to a functional call'],
  ['link status', JSON.stringify(LINK_THRESHOLDS), 'slow and error thresholds that colour a link'],
])}`;

// ------------------------------------------------------------------ assemble
log('writing');
const m = sum;
const n = (x: number, d: number) => `${x}/${d}`;
const methodRows = METHODS.map((k) => [nameOf[k], pct(m[k].detected), n(m[k].detectedN, m[k].faults), pct(m[k].top1OfDetected), n(m[k].top1N, m[k].detectedN), pct(m[k].caughtAndNamed), f2(m[k].falseAlarmsPerHour, 1), m[k].medianDelaySec === null ? 'n/a' : fmtMin(m[k].medianDelaySec!)]);
const classes = [...new Set(runs.flatMap((r) => r.faults.map((f) => f.class)))].sort();
const byClass = (k: Method, c: string, f: (x: { detected: boolean; top1: boolean }) => boolean) => { const xs = cv.pooled[k].faults.filter((x) => x.class === c); return xs.length ? xs.filter(f).length / xs.length : null; };
const perFault = cv.pooled.learned.faults.map((f, i) => { const r = cv.pooled.rulesTuned.faults[i], l = cv.pooled.live.faults[i]; const cell = (x: typeof f | undefined) => (x ? (x.detected ? (x.top1 ? '✓ named' : `✓ ${x.predicted ?? '?'}`) : '✗ missed') : '–'); return [f.run.split('/').pop()!, f.id, f.class, f.target, f.isolated ? 'alone' : 'overlap', cell(f), cell(r), cell(l)]; });
const targets = [...new Set(cv.pooled.learned.faults.map((f) => f.target))].sort();
const predicted = [...new Set([...cv.pooled.learned.faults.map((f) => f.predicted ?? '(missed)'), ...targets])].sort();
const confusion = targets.map((t) => predicted.map((p) => cv.pooled.learned.faults.filter((f) => f.target === t && (f.predicted ?? '(missed)') === p).length));
const corr = FEATURE_NAMES.map((_, i) => FEATURE_NAMES.map((__, j) => { const r = pearson(featCol(i), featCol(j)); return Number.isFinite(r) ? r : 0; }));
const keyFeats = ['own', 'symptom', 'callersSymptomMax', 'throttle', 'errRise', 'latRise'].map((f) => FEATURE_NAMES.indexOf(f as any)).filter((j) => j >= 0);
const featHists = keyFeats.map((j) => histogram({ title: `Feature “${FEATURE_NAMES[j]}” (log1p of its deviation)`, w: 300, h: 180, bins: 20, xlabel: 'value',
  series: [{ label: 'healthy rows', color: PAL[0], values: X.filter((_, i) => Y[i] === 0).map((r) => r[j]) }, { label: 'faulted service', color: PAL[1], values: X.filter((_, i) => Y[i] === 1).map((r) => r[j]) }] }));
const sep = FEATURE_NAMES.map((f, j) => { const a = X.filter((_, i) => Y[i] === 1).map((r) => r[j]), b = X.filter((_, i) => Y[i] === 0).map((r) => r[j]); const s = Math.sqrt((moments(a).sd ** 2 + moments(b).sd ** 2) / 2) || 1; return { label: f, value: (moments(a).mean - moments(b).mean) / s }; }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

const css = `
:root{color-scheme:light dark;--bg:#fcfcfb;--panel:#fff;--ink:#0b0b0b;--ink2:#52514e;--ink3:#8a8984;--line:#e5e4df;--grid:#ecebe6;--accent:#2a78d6;--c1:#2a78d6;--c2:#eb6834;--c3:#1baf7a;--c4:#eda100;--c5:#e87ba4;--c6:#008300;--c7:#6250d6;--c8:#8a8984;--band:rgba(235,104,52,.14)}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--panel:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--ink3:#8a897f;--line:#2e2e2b;--grid:#262624;--accent:#3987e5;--c1:#3987e5;--c2:#d95926;--c3:#199e70;--c4:#c98500;--c5:#d55181;--c6:#008300;--c7:#9085e9;--c8:#8a897f;--band:rgba(217,89,38,.18)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:18px;margin:44px 0 6px;letter-spacing:-.01em;padding-top:10px;border-top:1px solid var(--line)}h3{font-size:15px;margin:28px 0 4px}h4{font-size:13px;margin:20px 0 6px;color:var(--ink2)}
.sub{color:var(--ink2);margin:0 0 20px;max-width:900px}nav{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:5;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px}nav a{color:var(--ink2);text-decoration:none}nav a:hover{color:var(--accent)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:14px}.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px}
figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;min-width:0}figure.wide{grid-column:1/-1}figcaption{font-weight:600;font-size:13px;margin-bottom:6px}svg{width:100%;height:auto;display:block}
.note{color:var(--ink2);font-size:12px;margin:6px 0 0}.legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0 0 6px;font-size:12px;color:var(--ink2)}.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--ink3);stroke-width:1}.tick{fill:var(--ink3);font-size:10px}.lab{fill:var(--ink2);font-size:11px}.val{fill:var(--ink2);font-size:11px}.ref{stroke:var(--ink3);stroke-width:1;stroke-dasharray:4 4}.whisker{stroke:var(--ink2);stroke-width:1.4}.band{fill:var(--band)}
.hpos{fill:var(--c1);fill-opacity:calc(.1 + var(--t)*.85)}.hneg{fill:var(--c2);fill-opacity:calc(.1 + var(--t)*.85)}.cellv{fill:var(--ink);font-size:10px}
.box{fill:var(--panel);stroke:var(--line)}.arrow{stroke:var(--ink3);fill:none;stroke-width:1.4}.path{fill:var(--accent);font-size:9.5px;font-family:ui-monospace,Menlo,monospace}
.tablewrap{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:8px 0}table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--ink2);font-weight:600;position:sticky;top:0;background:var(--panel)}td:first-child{white-space:nowrap}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:14px 0}.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.kpi b{display:block;font-size:24px;letter-spacing:-.02em}.kpi span{font-size:12px;color:var(--ink2)}
details{margin:10px 0}summary{cursor:pointer;font-weight:600}.warn{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--c4);padding:10px 14px;border-radius:8px;font-size:13px;color:var(--ink2);margin:12px 0}`;

const totalFaults = runs.reduce((s, r) => s + r.faults.length, 0);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model lab</title><style>${css}</style></head><body><div class="wrap">
<h1>Model lab</h1>
<p class="sub">Every chart behind the mapper's detection and learning, built from ${runs.length} recorded run${runs.length === 1 ? '' : 's'} (${subjects.join(', ')}; ${totalFaults} injected faults; ${spans.reduce((s, x) => s + x.minutes, 0).toFixed(0)} minutes of telemetry). Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC by <code>graphs/model-lab.ts</code>. Regenerate: <code>npm run ml:report -- ~/.faultlab/&lt;run-dir&gt;</code>.</p>
<nav><a href="#data">1 Data</a><a href="#features">2 Features</a><a href="#model">3 Model</a><a href="#compare">4 Comparison</a><a href="#sens">5 Sensitivity</a><a href="#lineage">6 Where the data lives</a><a href="#hyper">7 Hyperparameters</a></nav>
${totalFaults < 30 ? `<div class="warn"><b>Small sample.</b> ${totalFaults} faults is too few for confident conclusions: differences of one or two faults between methods are noise. Regenerate after a longer campaign.</div>` : ''}
<div class="kpis">${METHODS.map((k) => `<div class="kpi"><span>${nameOf[k]}</span><b>${pct(m[k].caughtAndNamed)}</b><span>faults caught with the right service first · ${f2(m[k].falseAlarmsPerHour, 1)} false alarms/h</span></div>`).join('')}</div>

<h2 id="data">1 Data</h2>
<p class="sub">What was recorded, how it is distributed, how much is missing, and how often it arrives. Distribution statistics use healthy periods only (outside every fault window, after the first five minutes).</p>
${table(['Run', 'Subject', 'Minutes', 'Snapshots', 'Reading spacing', 'Services', 'Faults', 'Alone / overlapping', 'By class'], runs.map((r, i) => [r.name, r.subject, spans[i].minutes.toFixed(1), spans[i].snaps, `${spans[i].spacing.toFixed(1)} s`, r.moments[0]?.services.length ?? 0, r.faults.length,
  `${r.faults.filter((f) => !r.faults.some((o) => o !== f && o.a < f.b + 30000 && o.b > f.a)).length} / ${r.faults.filter((f) => r.faults.some((o) => o !== f && o.a < f.b + 30000 && o.b > f.a)).length}`, Object.entries(r.faults.reduce((a, f) => ({ ...a, [f.class]: (a[f.class] ?? 0) + 1 }), {} as Record<string, number>)).map(([c, k]) => `${c} ${k}`).join(', ')]))}
<div class="grid2">
${bars({ title: 'Skewness of each signal, raw vs log-transformed (median over services)', groups: skewRows.map((s) => s.sg.label), series: [{ label: 'raw', color: PAL[1], values: skewRows.map((s) => s.rawSkew) }, { label: 'log-transformed (as used)', color: PAL[0], values: skewRows.map((s) => s.lgSkew) }], note: 'Skewness 0 is symmetric. Rates, latencies and byte counts are strongly right-skewed on the raw scale, which is why the detector compares them as ratios (log scale). Error share and throttling are bounded and stay linear.' })}
${bars({ title: 'Excess kurtosis, raw vs log-transformed (median over services)', groups: skewRows.map((s) => s.sg.label), series: [{ label: 'raw', color: PAL[1], values: skewRows.map((s) => s.rawKurt) }, { label: 'log-transformed (as used)', color: PAL[0], values: skewRows.map((s) => s.lgKurt) }], note: 'Excess kurtosis above 0 means heavier tails than a normal distribution: rare large values that a mean/standard-deviation baseline would be dragged by. The detector uses median/MAD and a tail-aware spread for this reason.' })}
${bars({ title: 'Missing readings per signal', groups: RAW.map((s) => s.label), series: subjects.map((s) => ({ label: s, color: subjColor(s), values: RAW.map((sg) => { const x = missing[`${s}|${sg.key}`]; return x && x.n ? x.miss / x.n : null; }) })), yMax: 1, fmt: (v) => pct(v), note: 'Share of readings where the signal was not available (for example request metrics on databases, which log no requests). Missing stays missing: it is never turned into 0.' })}
${histogram({ title: 'Seconds between distinct readings of a service', series: [{ label: 'spacing', color: PAL[0], values: gaps }], range: [0, 30], xlabel: 'seconds', note: `Median ${readingSpacing.toFixed(1)} s. This sets how many readings a sliding window of N samples covers.` })}
${histogram({ title: 'CPU: raw ratio to each service\'s own median', series: [{ label: 'cpu / median', color: PAL[1], values: ratioPooled('cpu') }], range: [0, 6], xlabel: 'ratio', note: 'Pooled over services after dividing by each service\'s median: a long right tail.' })}
${histogram({ title: 'CPU: log scale, centred on each service\'s median', series: [{ label: 'log cpu − median', color: PAL[0], values: pooled('cpu', (v) => Math.log(Math.max(v, 0) + 0.5)) }], xlabel: 'log units', note: 'The same data after the transform used by the detector: close to symmetric.' })}
${histogram({ title: 'p95 latency: raw ratio to median', series: [{ label: 'latency / median', color: PAL[1], values: ratioPooled('latencyP95') }], range: [0, 6], xlabel: 'ratio' })}
${histogram({ title: 'p95 latency: log scale, centred', series: [{ label: 'log latency − median', color: PAL[0], values: pooled('latencyP95', (v) => Math.log(Math.max(v, 0) + 1)) }], xlabel: 'log units' })}
${histogram({ title: 'Network in: raw ratio to median', series: [{ label: 'rx / median', color: PAL[1], values: ratioPooled('networkRxRate') }], range: [0, 6], xlabel: 'ratio' })}
${histogram({ title: 'Network in: log scale, centred', series: [{ label: 'log rx − median', color: PAL[0], values: pooled('networkRxRate', (v) => Math.log(Math.max(v, 0) + 2000)) }], xlabel: 'log units' })}
${bars({ title: 'Injected faults by class', groups: classes, series: subjects.map((s) => ({ label: s, color: subjColor(s), values: classes.map((c) => runs.filter((r) => r.subject === s).reduce((a, r) => a + r.faults.filter((f) => f.class === c).length, 0)) })), fmt: (v) => String(Math.round(v)), note: 'Class balance of the ground truth. A class with one or two faults cannot be judged on its own.' })}
${bars({ title: 'Rows for learning: faulted vs healthy', groups: runs.map((r) => r.name.split('/').pop()! + ' ' + r.name.split('/')[0].slice(-6)), series: [{ label: 'healthy rows', color: PAL[0], values: allRows.map((d) => d.y.filter((v) => v === 0).length) }, { label: 'faulted-service rows', color: PAL[1], values: allRows.map((d) => d.y.filter((v) => v === 1).length) }], fmt: (v) => String(Math.round(v)), note: 'One row = one service at one moment. Faulted rows are rare, so the learner weights the two classes equally.' })}
</div>

<h2 id="features">2 Features</h2>
<p class="sub">Each moment of each service becomes ${FEATURE_NAMES.length} numbers (see section 7). These charts show how well each one separates the faulted service from healthy ones, and how much they overlap.</p>
<div class="grid3">${featHists.join('')}</div>
<div class="grid2">
${hbars({ title: 'Separation: faulted minus healthy mean, in pooled standard deviations', rows: sep.map((s) => ({ label: s.label, value: s.value })), fmt: (v) => f2(v, 2), note: 'Larger means the feature alone separates the classes better. Compare with the learned weights in section 3: a feature can separate well and still get a small weight when another feature says the same thing.' })}
${heat({ title: 'Correlation between features (all labelled rows)', rows: [...FEATURE_NAMES], cols: [...FEATURE_NAMES], values: corr, diverge: true, cell: 24, fmt: (v) => f2(v, 1), note: 'Strongly correlated pairs (for example own and cpu) make the learned weights unstable unless regularised; this is why lambda is chosen by the data and swept in section 5.' })}
</div>

<h2 id="model">3 Model</h2>
<p class="sub">A logistic regression on those features, trained on all runs (final model). The curves below use out-of-fold predictions: every row is scored by a model that did not train on its time block.</p>
<div class="grid2">
${hbars({ title: 'Learned weights (standardised features, log-odds per standard deviation)', rows: FEATURE_NAMES.map((f, j) => ({ label: f, value: final.model.w[j] })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)), fmt: (v) => f2(v, 2), note: `Chosen lambda ${final.model.lambda}, alarm threshold ${f2(final.threshold, 3)}. Positive pushes towards “this service is the cause”.` })}
${lines({ title: 'Threshold choice: training objective against threshold', series: [{ label: 'objective (F of caught-and-named and alarm precision)', color: PAL[0], points: final.curve.map((c) => [c.threshold, c.objective] as [number, number]) }], xlabel: 'alarm threshold on the probability', yRange: [0, 1], vlines: [{ x: final.threshold, label: 'chosen' }], note: 'The threshold is the maximiser of this curve on training data. It is chosen from data, not typed in.' })}
${lines({ title: 'Regularisation: training objective against lambda', series: [{ label: 'objective', color: PAL[2], points: final.lambdaCurve.map((c) => [c.lambda, c.objective] as [number, number]) }], xlabel: 'lambda (log scale)', yRange: [0, 1], logX: true, dots: true })}
${lines({ title: `ROC, out-of-fold (AUC learned ${f2(rocL.auc, 3)}, rules ${f2(rocR.auc, 3)})`, series: [{ label: 'Learned', color: PAL[0], points: rocL.roc }, { label: 'Rules', color: PAL[2], points: rocR.roc }], diag: true, xRange: [0, 1], yRange: [0, 1], xlabel: 'false positive rate', ylabel: 'true positive rate', note: `${rocL.P} faulted-service rows against ${rocL.N} healthy rows. Row-level: a stricter view than the alarm-level results below.` })}
${lines({ title: 'Precision-recall, out-of-fold', series: [{ label: 'Learned', color: PAL[0], points: rocL.pr }, { label: 'Rules', color: PAL[2], points: rocR.pr }], xRange: [0, 1], yRange: [0, 1], xlabel: 'recall', ylabel: 'precision', note: 'With few faulted rows among many healthy ones, precision is the honest measure.' })}
${lines({ title: 'Calibration of the learned probabilities, out-of-fold', series: [{ label: 'observed frequency', color: PAL[0], points: calib }], diag: true, xRange: [0, 1], yRange: [0, 1], xlabel: 'predicted probability', ylabel: 'share that really were faulted', dots: true, note: 'On the dashed diagonal, a stated 70% is right 70% of the time. Class-balanced training pushes probabilities up, so they rank well but are not literal probabilities.' })}
</div>
<h3>Scores over time (final model, one run)</h3>
<div class="grid2">${timeline(showRun, (x) => predict(final.model, x), `Learned probability: ${showRun.name}`, (i) => PAL[i % 8], 1)}${timeline(showRun, rulesScore, `Rule-based score (z units, capped at 20): ${showRun.name}`, (i) => PAL[(i + 2) % 8], 20)}</div>
<h3>Alarm trade-off over the whole data (in-sample)</h3>
<div class="grid2">
${lines({ title: 'Learned: detected and caught-and-named against threshold', series: [{ label: 'detected', color: PAL[0], points: opL.map((o) => [o.th, o.det] as [number, number]) }, { label: 'caught and named first', color: PAL[1], points: opL.map((o) => [o.th, o.top1] as [number, number]) }], yRange: [0, 1], xlabel: 'threshold', yFmt: (v) => pct(v) })}
${lines({ title: 'Learned: false alarms per hour against threshold', series: [{ label: 'false alarms/h', color: PAL[3], points: opL.map((o) => [o.th, o.fa] as [number, number]) }], xlabel: 'threshold' })}
${lines({ title: 'Rules: detected and caught-and-named against threshold', series: [{ label: 'detected', color: PAL[0], points: opR.map((o) => [o.th, o.det] as [number, number]) }, { label: 'caught and named first', color: PAL[1], points: opR.map((o) => [o.th, o.top1] as [number, number]) }], yRange: [0, 1], xlabel: 'threshold (z units)', yFmt: (v) => pct(v) })}
${lines({ title: 'Rules: false alarms per hour against threshold', series: [{ label: 'false alarms/h', color: PAL[3], points: opR.map((o) => [o.th, o.fa] as [number, number]) }], xlabel: 'threshold (z units)' })}
</div>

<h2 id="compare">4 Comparison</h2>
<p class="sub">All four methods on the same held-out time blocks (${K}-fold, blocked by time). “Live mapper” is what the running server actually said during the run, with no re-scoring.</p>
${table(['Method', 'Detected', 'n', 'Named first (of detected)', 'n', 'Caught and named (of all faults)', 'False alarms / h', 'Median delay'], methodRows)}
<div class="grid2">
${bars({ title: 'Faults detected', groups: METHODS.map((k) => nameOf[k]), series: [{ label: 'detected', color: PAL[0], values: METHODS.map((k) => m[k].detected), err: METHODS.map((k) => { const w = wilson(m[k].detectedN, m[k].faults); return [w.lo, w.hi] as [number, number]; }) }], yMax: 1, fmt: (v) => pct(v), note: 'Whiskers are Wilson 95% intervals.' })}
${bars({ title: 'Right service named first', groups: METHODS.map((k) => nameOf[k]), series: [{ label: 'of detected', color: PAL[1], values: METHODS.map((k) => m[k].top1OfDetected) }, { label: 'of all faults', color: PAL[4], values: METHODS.map((k) => m[k].caughtAndNamed) }], yMax: 1, fmt: (v) => pct(v) })}
${bars({ title: 'False alarms per hour', groups: METHODS.map((k) => nameOf[k]), series: [{ label: 'false alarms/h', color: PAL[3], values: METHODS.map((k) => m[k].falseAlarmsPerHour) }] })}
${bars({ title: 'Median seconds from fault to alarm', groups: METHODS.map((k) => nameOf[k]), series: [{ label: 'seconds', color: PAL[5], values: METHODS.map((k) => m[k].medianDelaySec) }] })}
${bars({ title: 'Detected, by fault class', groups: classes, series: (['learned', 'rulesTuned', 'live'] as Method[]).map((k) => ({ label: nameOf[k], color: colorOf[k], values: classes.map((c) => byClass(k, c, (x) => x.detected)) })), yMax: 1, fmt: (v) => pct(v), note: 'A class with very few faults is shown, but one fault moves a bar by a large step.' })}
${bars({ title: 'Caught and named first, by fault class', groups: classes, series: (['learned', 'rulesTuned', 'live'] as Method[]).map((k) => ({ label: nameOf[k], color: colorOf[k], values: classes.map((c) => byClass(k, c, (x) => x.top1)) })), yMax: 1, fmt: (v) => pct(v) })}
${heat({ title: 'Which service the learned model named, against the service that was faulted', rows: targets, cols: predicted, values: confusion, cell: 30, fmt: (v) => (v ? String(v) : ''), note: 'Rows: the faulted service. Columns: the service named first. The diagonal is right; the last column, if present, is faults with no alarm.' })}
</div>
${cross.length ? `<h3>Does it work on a system it was not trained on?</h3>${table(['Split', 'Method', 'Detected', 'Named first (of detected)', 'False alarms / h'], cross.flatMap((c) => [[c.label, 'Learned', pct(c.learned.detected), pct(c.learned.top1OfDetected), f2(c.learned.falseAlarmsPerHour, 1)], [c.label, 'Rules (tuned)', pct(c.rules.detected), pct(c.rules.top1OfDetected), f2(c.rules.falseAlarmsPerHour, 1)], [c.label, 'Live mapper', pct(c.live.detected), pct(c.live.top1OfDetected), f2(c.live.falseAlarmsPerHour, 1)]]))}` : '<p class="note">Cross-system test needs runs from at least two subjects.</p>'}
<details><summary>Every fault, method by method (${perFault.length})</summary>${table(['Run', 'Fault', 'Class', 'Faulted service', 'Overlap', 'Learned', 'Rules (tuned)', 'Live mapper'], perFault)}<p class="note">“✓ named” = detected and the faulted service was first; “✓ name” = detected but another service was named first.</p></details>

<h2 id="sens">5 Sensitivity</h2>
<p class="sub">One hyperparameter changed at a time, everything else as in section 7, each point a full blocked cross-validation (the learned model is retrained and its threshold re-chosen for every point). ${quick ? '<b>Skipped (--quick).</b>' : ''}</p>
${sweeps.map(sweepCharts).join('')}
<p class="note">Not swept here because they apply at collection time and the recorded data already contains their effect: the collector request-statistics window (${COLLECTOR_PARAMS.requestWindowMs / 1000} s) and poll interval (${COLLECTOR_PARAMS.pollMs} ms). To test them, record a new run with a different value and compare the two reports.</p>

<h2 id="lineage">6 Where the data lives and how it flows</h2>
${flow(stages)}
<p class="sub">Steps 1–7 run inside the product. Step 8 (recording) and 9 (learning) are offline tools and never write into the running mapper, except <code>learned.json</code> when you choose to install a trained model.</p>
${storage}
<p class="note">Paths starting with <code>server/data</code> are relative to the repository root when the server is started with <code>npm run dev</code> (the server's working directory is <code>server/</code>, so the folder is <code>data/</code> inside it). <code>~/.faultlab</code> is in your home directory on the machine that runs the injector and the observer.</p>
<details open><summary>How one reading travels</summary><ol>
<li><b>Collect.</b> Every ${COLLECTOR_PARAMS.pollMs} ms the collector reads <code>docker stats</code> (CPU, memory, network counters, throttling), <code>docker inspect</code> (state, restarts, network attachment, CPU limit), the new log lines since the last cycle (request count, errors, latency), and <code>/proc/net/tcp</code> inside each container (who talks to whom). Counters become per-second rates from two readings; a counter that went backwards is unknown, not a spike.</li>
<li><b>Ingest.</b> The batch is POSTed to <code>/api/ingest</code>. Nodes and edges are merged into the graph, readings become one snapshot per service pushed into the metric history ring buffer.</li>
<li><b>Detect.</b> Each cycle, every signal of every service is compared with that service's own recent past (robust z, log scale for rates, one-sided). The newest ${D.judgedSamples} samples must agree. Container facts (stopped, paused, restarting, no network) are read straight from the runtime.</li>
<li><b>Model.</b> The target's own model (trained at start-up on its baseline) supplies the alarm threshold; learned weights, if installed, turn the signals into one probability per service.</li>
<li><b>Rank.</b> Root cause, cascade and at-risk list are computed from the scores and the call graph. Incidents are kept in memory and rebuilt every cycle.</li>
<li><b>Serve.</b> The React app polls <code>/api/graph</code>, <code>/api/incidents</code> and <code>/api/models</code>.</li>
<li><b>Record and learn (offline).</b> The observer writes what the API showed; the injector writes what it broke; <code>npm run ml</code> joins the two and learns.</li></ol></details>

<h2 id="hyper">7 Hyperparameters in use</h2>
<p class="sub">Printed from the code that uses them (the values are imported, not retyped), so this section cannot drift from the product.</p>
${hyper}
</div></body></html>`;
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, html);
log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} kB)`);
if (args.includes('--wiki')) { const w = path.resolve('wiki visualizer', 'model-lab.html'); fs.mkdirSync(path.dirname(w), { recursive: true }); fs.writeFileSync(w, html); log(`copied to ${w}`); }
