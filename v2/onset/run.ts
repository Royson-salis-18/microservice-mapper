/**
 * The onset experiment, end to end.
 *
 *   node server/node_modules/tsx/dist/cli.mjs v2/onset/run.ts
 *
 * 1. Settings are chosen on the tuning campaigns ONLY (tune.json + tune2.json):
 *      ranking    detector x form x parameters, keeping V1.hybrid's alarm; pick the most "caught+named" (ties: right-first).
 *      detection  V1.hybrid OR a change-point alarm; pick the config that catches the most faults while its false alarms/h
 *                 stay within 1.25 x V1.hybrid's and its alarm time within V1.hybrid's + 2 points. If none qualifies,
 *                 the best by the v1 objective (harmonic mean of caught+named and alarm precision) is reported instead.
 * 2. The chosen engines are then scored ONCE on the held-out synthetic campaigns (test.json) and the real runs (real.json).
 * Prints all tables and writes v2/onset/results.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Only the type comes from core/trace.ts: importing its code would load run/cli/ml/run.ts, whose "am I the main script"
// check (argv[1] ends with 'run.ts') also matches this file and would start the v1 experiment.
import type { Trace } from '../core/trace.ts';
import { score, V1, line, HEADER, type Engine, type Score } from '../core/score.ts';
import { objective } from '../../server/algorithms/learning/evaluate.ts';
import type { CpParams, DetectorKind } from './changepoint.ts';
import { rcaEngine, earlyEngine, type RankOpts, type AnomOpts, type EarlyOpts } from './rca.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', '.cache');
const load = (f: string): Trace[] => JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));

const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const delays = (s: Score) => s.outcomes.filter((o) => o.detected).map((o) => o.delaySec!);
const caught = (s: Score) => s.outcomes.filter((o) => o.detected && o.top1).length;
/** v1 objective from a Score: harmonic mean of caught+named rate and alarm precision (false alarms as counts per hour). */
function obj(s: Score, fpHours: number) {
  const fa = s.falseAlarmsPerHour * fpHours;
  return objective({ faults: s.outcomes, falseAlarms: fa } as any);
}

interface RankCfg { name: string; cp: Partial<CpParams>; rank: RankOpts; anom: AnomOpts }
interface EarlyCfg { name: string; cp: Partial<CpParams>; early: EarlyOpts }

function rankGrid(): RankCfg[] {
  const out: RankCfg[] = [];
  const forms: RankOpts[] = [
    ...[5, 15, 45].map((tau) => ({ form: 'decay' as const, tau })),
    ...[0.5, 1, 2].map((beta) => ({ form: 'rrf' as const, beta, rrfK: 3 })),
    { form: 'earliest' },
    ...[5, 15].flatMap((gap) => [0.2, 0.5].map((ratio) => ({ form: 'gate' as const, gap, ratio }))),
  ];
  for (const kind of ['cusum', 'ph', 'bocpd'] as DetectorKind[])
    for (const magMin of [2, 3])
      for (const maxAge of [120, 600])
        for (const r of forms) {
          const extra = r.form === 'decay' ? `tau=${r.tau}` : r.form === 'rrf' ? `beta=${r.beta}` : r.form === 'gate' ? `gap=${r.gap},ratio=${r.ratio}` : '';
          out.push({ name: `${kind} ${r.form}${extra ? ' ' + extra : ''} mag>=${magMin} age<=${maxAge}`, cp: { kind, magMin }, rank: r, anom: { maxAge, requireV1: true } });
        }
  return out;
}

function earlyGrid(): EarlyCfg[] {
  const out: EarlyCfg[] = [];
  for (const kind of ['cusum', 'ph', 'bocpd'] as DetectorKind[])
    for (const magAlarm of [3, 5, 7])
      for (const persist of [2, 4])
        for (const maxAlarmAge of [60, 180, Infinity])
          for (const minServices of [1, 2])
            out.push({ name: `${kind} mag>=${magAlarm} persist=${persist} age<=${maxAlarmAge} n>=${minServices}`, cp: { kind }, early: { magAlarm, persist, maxAlarmAge, minServices } });
  return out;
}

/** Fault-free hours, needed to turn false alarms/h back into counts for the objective. */
function fpHours(traces: Trace[]) {
  let ms = 0;
  for (const t of traces) {
    const w = t.faults.map((f) => [f.a, f.b + 60000]);
    for (let k = 1; k < t.moments.length; k++) { const ts = t.moments[k].ts; if (ts >= t.t0 + 300000 && !w.some(([a, b]) => ts >= a && ts <= b)) ms += ts - t.moments[k - 1].ts; }
  }
  return ms / 3.6e6;
}

const CLASSES_FIRST = ['brownout', 'latency', 'crash', 'memory'];
function classTable(rows: [string, Score][]) {
  const classes = [...new Set(rows.flatMap(([, s]) => Object.keys(s.byClass)))].sort((a, b) => {
    const ia = CLASSES_FIRST.indexOf(a), ib = CLASSES_FIRST.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const head = `${'class'.padEnd(11)} ${'n'.padStart(3)}  ` + rows.map(([n]) => n.slice(0, 16).padStart(17)).join('');
  const lines = classes.map((c) => {
    const n = rows[0][1].byClass[c]?.n ?? 0;
    return `${c.padEnd(11)} ${String(n).padStart(3)}  ` + rows.map(([, s]) => { const x = s.byClass[c]; return (x ? `${x.detected}/${x.named}` : '-').padStart(17); }).join('');
  });
  return [head, ...lines].join('\n') + '\n(cells: detected/caught+named)';
}

function summary(s: Score) {
  const d = delays(s);
  return { faults: s.faults, detected: s.detected, rightFirst: s.top1OfDetected, caughtNamed: s.caughtAndNamed, caughtNamedCount: caught(s),
    falseAlarmsPerHour: s.falseAlarmsPerHour, alarmTime: s.alarmShare, medianDelaySec: median(d), byClass: s.byClass };
}

/** Faults where the ranking changed its verdict: fixed (wrong -> right) and broken (right -> wrong). */
function flips(a: Score, b: Score) {
  const key = (o: Score['outcomes'][number]) => `${o.run}|${o.id}`;
  const m = new Map(a.outcomes.map((o) => [key(o), o]));
  const fixed: string[] = [], broken: string[] = [];
  for (const o of b.outcomes) {
    const p = m.get(key(o)); if (!p) continue;
    const pa = p.detected && p.top1, pb = o.detected && o.top1;
    if (!pa && pb) fixed.push(`${o.class}:${o.target}`); else if (pa && !pb) broken.push(`${o.class}:${o.target}(-> ${o.predicted})`);
  }
  return { fixed, broken };
}

/** Delay on the faults that both engines detected (a fair comparison of speed). */
function pairedDelay(a: Score, b: Score) {
  const key = (o: Score['outcomes'][number]) => `${o.run}|${o.id}`;
  const m = new Map(a.outcomes.map((o) => [key(o), o]));
  const da: number[] = [], db: number[] = [];
  for (const o of b.outcomes) { const p = m.get(key(o)); if (p?.detected && o.detected) { da.push(p.delaySec!); db.push(o.delaySec!); } }
  return { n: da.length, base: median(da), engine: median(db) };
}

function main() {
  const t0 = Date.now();
  const tuneSet = [...load('tune.json'), ...load('tune2.json')];
  const tuneHours = fpHours(tuneSet);
  const base = score(tuneSet, V1.hybrid);
  const results: any = { chosenOn: 'tune.json + tune2.json', grids: {} };

  // ---- 1a. ranking grid on tune
  console.log(`\n== Ranking grid on tune + tune2 (${base.faults} faults), alarm = V1.hybrid ==\n${HEADER}`);
  console.log(line('v1 hybrid', base));
  const rank = rankGrid().map((c) => ({ c, s: score(tuneSet, rcaEngine(c.cp, c.rank, c.anom)) }));
  rank.sort((a, b) => caught(b.s) - caught(a.s) || b.s.top1OfDetected - a.s.top1OfDetected);
  for (const { c, s } of rank.slice(0, 15)) console.log(line(c.name.slice(0, 34), s));
  // best of each form, so the forms can be compared
  console.log('\nbest per form:');
  for (const f of ['decay', 'rrf', 'earliest', 'gate']) { const b = rank.find((r) => r.c.rank.form === f)!; console.log(line(`${f}: ${b.c.name}`.slice(0, 34), b.s)); }
  console.log('best per detector:');
  for (const k of ['cusum', 'ph', 'bocpd']) { const b = rank.find((r) => r.c.cp.kind === k)!; console.log(line(`${k}: ${b.c.name}`.slice(0, 34), b.s)); }
  results.grids.ranking = rank.map(({ c, s }) => ({ name: c.name, caughtNamed: s.caughtAndNamed, rightFirst: s.top1OfDetected }));
  const bestRank = rank[0].c;
  console.log(`\nchosen ranking: ${bestRank.name}`);

  // ---- 1b. detection grid on tune
  const baseDelay = median(delays(base));
  console.log(`\n== Detection grid on tune + tune2: V1.hybrid OR change-point alarm (ranking = chosen onset ranking) ==\n${HEADER}  median-delay`);
  console.log(line('v1 hybrid', base), `  ${baseDelay.toFixed(1)}s`);
  const rankEngine = rcaEngine(bestRank.cp, bestRank.rank, bestRank.anom);
  const early = earlyGrid().map((c) => ({ c, s: score(tuneSet, earlyEngine(c.cp, c.early, rankEngine)) }));
  const ok = early.filter(({ s }) => s.falseAlarmsPerHour <= 1.25 * base.falseAlarmsPerHour + 1e-9 && s.alarmShare <= base.alarmShare + 0.02);
  ok.sort((a, b) => b.s.detected - a.s.detected || median(delays(a.s)) - median(delays(b.s)) || caught(b.s) - caught(a.s));
  const byObj = [...early].sort((a, b) => obj(b.s, tuneHours) - obj(a.s, tuneHours));
  for (const { c, s } of byObj.slice(0, 10)) console.log(line(c.name.slice(0, 34), s), `  ${median(delays(s)).toFixed(1)}s  obj ${obj(s, tuneHours).toFixed(3)}`);
  console.log(`configs within the false-alarm budget: ${ok.length} of ${early.length}`);
  for (const { c, s } of ok.slice(0, 5)) console.log(line(c.name.slice(0, 34), s), `  ${median(delays(s)).toFixed(1)}s`);
  const bestEarly = (ok[0] ?? byObj[0]).c;
  // for contrast: the fastest config whose false alarms/h stay within budget, ignoring alarm time
  const fastList = early.filter(({ s }) => s.falseAlarmsPerHour <= 1.25 * base.falseAlarmsPerHour + 1e-9)
    .sort((a, b) => median(delays(a.s)) - median(delays(b.s)) || b.s.detected - a.s.detected);
  const fastEarly = (fastList[0] ?? byObj[0]).c;
  console.log(`fastest within the false-alarm budget (alarm time ignored): ${fastEarly.name}`);
  console.log(`\nchosen detection: ${bestEarly.name} (${ok.length ? 'within budget' : 'no config within budget; best objective'})`);
  results.grids.detection = early.map(({ c, s }) => ({ name: c.name, detected: s.detected, falseAlarmsPerHour: s.falseAlarmsPerHour, alarmTime: s.alarmShare, medianDelaySec: median(delays(s)) }));
  results.chosen = { ranking: bestRank, detection: bestEarly, detectionWithinBudget: ok.length > 0, fastDetection: fastEarly };

  // ---- 2. report on tune, test and real
  const engines: [string, Engine][] = [
    ['v1 hybrid', V1.hybrid],
    ['onset ranking', rankEngine],
    ['onset ranking + cp alarm', earlyEngine(bestEarly.cp, bestEarly.early, rankEngine)],
    ['v1 ranking + cp alarm', earlyEngine(bestEarly.cp, bestEarly.early, V1.hybrid)],
    ['onset ranking + fast cp alarm', earlyEngine(fastEarly.cp, fastEarly.early, rankEngine)],
  ];
  results.sets = {};
  for (const [label, file] of [['tune + tune2 (chosen here)', null], ['test (held out)', 'test.json'], ['real', 'real.json']] as const) {
    const traces = file ? load(file) : tuneSet;
    const rows = engines.map(([n, e]) => [n, score(traces, e)] as [string, Score]);
    console.log(`\n== ${label}: ${traces.length} runs, ${rows[0][1].faults} faults ==\n${HEADER}  median-delay`);
    for (const [n, s] of rows) console.log(line(n, s), `  ${median(delays(s)).toFixed(1)}s`);
    console.log('\nper class:\n' + classTable(rows));
    const fl = flips(rows[0][1], rows[1][1]);
    console.log(`\nonset ranking vs v1: fixed ${fl.fixed.length} [${fl.fixed.join(', ')}]\n                     broken ${fl.broken.length} [${fl.broken.join(', ')}]`);
    const pd = pairedDelay(rows[0][1], rows[2][1]), pf = pairedDelay(rows[0][1], rows[4][1]);
    console.log(`delay on faults both detect: v1 ${pd.base.toFixed(1)}s vs cp alarm ${pd.engine.toFixed(1)}s (n=${pd.n}); v1 ${pf.base.toFixed(1)}s vs fast cp alarm ${pf.engine.toFixed(1)}s (n=${pf.n})`);
    const iso = rows.map(([n, s]) => {
      const part = (isolated: boolean) => { const o = s.outcomes.filter((x) => x.isolated === isolated); return { n: o.length, named: o.filter((x) => x.detected && x.top1).length }; };
      return { engine: n, isolated: part(true), overlapping: part(false) };
    });
    console.log('caught+named, isolated vs overlapping faults: ' + iso.map((r) => `${r.engine} ${r.isolated.named}/${r.isolated.n} | ${r.overlapping.named}/${r.overlapping.n}`).join(';  '));
    results.sets[file ?? 'tune'] = { engines: Object.fromEntries(rows.map(([n, s]) => [n, summary(s)])), rankingFlips: fl, pairedDelay: pd, pairedDelayFast: pf, isolation: iso };
  }
  fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, (_, v) => (v === Infinity ? 'Infinity' : v), 1));
  console.log(`\nwrote v2/onset/results.json in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
