/**
 * v2 causal: every table of the study, printed and saved to v2/causal/results.json.
 *
 *   1. Direction accuracy per method, on observed pairs that are true calls (one way), for real, tune (where the
 *      settings were chosen) and test (held out), each also NAME-BLIND (services renamed s1..sn).
 *   2. Root-cause ranking: V1.hybrid against the same walk with different directions (rca.ts).
 *
 *   node server/node_modules/tsx/dist/cli.mjs v2/causal/run.ts            (from the repo root; run.ts loads this file)
 *
 * Direction accuracy is measured two ways:
 *   end      with the learner state after the whole run
 *   online   averaged over checkpoints every 60 moments (5 min), each using only the run so far, over the pairs seen so far
 * A pair counts once per run (end) or once per checkpoint (online). "ambiguous" pairs are those the collector saw from
 * both ends about equally often (|edges score| < 0.5): only there does a direction have to be inferred.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTraces, type Trace } from '../core/trace.ts';
import { score, V1, line, HEADER, type Score, type Engine } from '../core/score.ts';
import { DirectionLearner, METHODS, PRESETS, nameRuleDirections, truthOf, nameBlind, tally, add, type DirTally } from './direction.ts';
import { causalEngine, type DirectionSource } from './rca.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CACHE = path.join(ROOT, 'v2', '.cache');
const CHECK = 60;

// ------------------------------------------------------------------------------------------------ directions
type Rows = Record<string, { end: DirTally; online: DirTally }>;
const DECIDERS = ['collector view', 'v1 name rule', 'learned', 'dynamic', 'name+ (name, else learned)'] as const;

function directionStudy(traces: Trace[]): { all: Rows; ambiguous: Rows; pairs: { all: number; ambiguous: number } } {
  const all: Rows = {}, ambiguous: Rows = {};
  const row = (r: Rows, k: string) => (r[k] ??= { end: tally(), online: tally() });
  let nAll = 0, nAmb = 0;
  for (const t of traces) {
    if (!t.trueCalls) continue;
    const L = new DirectionLearner();
    const union = new Map<string, [string, string]>();
    t.moments.forEach((m, i) => {
      L.observe(m);
      for (const e of m.edges) union.set(`${e[0]}>${e[1]}`, e);
      const last = i === t.moments.length - 1;
      if ((i + 1) % CHECK !== 0 && !last) return;
      const names = nameRuleDirections({ ...m, edges: [...union.values()] });
      for (const k of L.pairKeys()) {
        const [a, b] = k.split('|');
        const truth = truthOf(t, a, b);
        if (!truth) continue;
        const s = L.scores(a, b)!, amb = Math.abs(s.edges) < L.p.trustEdges;
        if (last) { nAll++; if (amb) nAmb++; }
        const name = names.get(k) ?? 0;
        const learned = L.direction(a, b, PRESETS.learned);
        const guesses: Record<string, number> = {
          'collector view': Math.abs(s.edges) >= L.p.trustEdges ? Math.sign(s.edges) : 0,
          'v1 name rule': name, learned, dynamic: L.direction(a, b, PRESETS.dynamic),
          'name+ (name, else learned)': name !== 0 ? name : learned,
        };
        for (const mth of METHODS) guesses[`method: ${mth}`] = Math.abs(s[mth]) < 1e-9 ? 0 : Math.sign(s[mth]);
        for (const [g, v] of Object.entries(guesses)) {
          for (const r of amb ? [all, ambiguous] : [all]) { const x = row(r, g); add(x.online, v, truth); if (last) add(x.end, v, truth); }
        }
      }
    });
  }
  return { all, ambiguous, pairs: { all: nAll, ambiguous: nAmb } };
}

const acc = (x: DirTally) => { const n = x.right + x.wrong + x.unknown; return n ? x.right / n : 0; };
const fmtT = (x: DirTally) => `${(acc(x) * 100).toFixed(0).padStart(4)}%  ${String(x.right).padStart(4)} ${String(x.wrong).padStart(4)} ${String(x.unknown).padStart(4)}`;
function printDirections(label: string, d: ReturnType<typeof directionStudy>) {
  console.log(`\nDIRECTIONS  ${label}: ${d.pairs.all} true one-way pairs observed, ${d.pairs.ambiguous} of them seen from both ends`);
  console.log(`${''.padEnd(30)} ${'ALL PAIRS end: acc right wrong unk'.padEnd(36)} ${'AMBIGUOUS end'.padEnd(26)} AMBIGUOUS online`);
  const keys = [...DECIDERS, ...METHODS.map((m) => `method: ${m}`)];
  for (const k of keys) {
    const a = d.all[k], b = d.ambiguous[k];
    if (!a) continue;
    const isMethod = k.startsWith('method');
    console.log(`${k.padEnd(30)} ${(isMethod ? '' : fmtT(a.end)).padEnd(36)} ${b ? fmtT(b.end) : ''.padEnd(24)}  ${b ? fmtT(b.online) : ''}`);
  }
}

// ------------------------------------------------------------------------------------------------ RCA
const SOURCES: DirectionSource[] = ['none', 'name', 'learned', 'dynamic', 'name+', 'oracle'];
const LABEL: Record<DirectionSource, string> = {
  none: 'walk, no directions (all mutual)', name: 'walk, v1 name rule (replica)', learned: 'walk, learned directions', dynamic: 'walk, dynamic-only directions',
  'name+': 'walk, name rule else learned', oracle: 'walk, TRUE directions (ceiling)',
};
const named = (s: Score) => s.outcomes.filter((o) => o.detected && o.top1).length;

function rcaStudy(label: string, traces: Trace[], blind: boolean) {
  console.log(`\nRCA  ${label}: ${traces.length} runs, ${traces.reduce((s, t) => s + t.faults.length, 0)} faults${blind ? '  (v1 hybrid row still uses v1\'s rankings made WITH names)' : ''}`);
  console.log(`${HEADER}   named  vs v1 (+/-)`);
  const base = score(traces, V1.hybrid);
  const id = (o: Score['outcomes'][number]) => `${o.run}/${o.id}`;
  const baseNamed = new Set(base.outcomes.filter((o) => o.detected && o.top1).map(id));
  const out: Record<string, any> = {};
  const show = (name: string, s: Score) => {
    const mine = new Set(s.outcomes.filter((o) => o.detected && o.top1).map(id));
    const gained = [...mine].filter((x) => !baseNamed.has(x)).length, lost = [...baseNamed].filter((x) => !mine.has(x)).length;
    console.log(`${line(name, s)}   ${String(named(s)).padStart(5)}  +${gained}/-${lost}`);
    const { outcomes, ...rest } = s;
    out[name] = { ...rest, named: named(s), gained, lost };
  };
  show('v1 hybrid', base);
  for (const src of SOURCES) show(LABEL[src], score(traces, causalEngine({ directions: src })));
  show('walk, learned + learned weights', score(traces, causalEngine({ directions: 'learned', weights: 'implication' })));
  return out;
}

// ------------------------------------------------------------------------------------------------ main
function load(f: string): Trace[] {
  const file = path.join(CACHE, f);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return loadTraces(file);
}
const t0 = Date.now();
const sets: [string, Trace[]][] = [['real', load('real.json')], ['tune (tune+tune2)', [...load('tune.json'), ...load('tune2.json')]], ['test (held out)', load('test.json')]];
const results: Record<string, any> = { directions: {}, rca: {}, settings: { presets: PRESETS, checkpointEvery: CHECK } };
for (const [label, traces] of sets) {
  for (const blind of [false, true]) {
    const tr = blind ? traces.map((t) => nameBlind(t)) : traces;
    const name = `${label}${blind ? ', name-blind' : ''}`;
    const d = directionStudy(tr);
    printDirections(name, d);
    results.directions[name] = d;
  }
}
for (const [label, traces] of sets) {
  for (const blind of [false, true]) {
    const name = `${label}${blind ? ', name-blind' : ''}`;
    results.rca[name] = rcaStudy(name, blind ? traces.map((t) => nameBlind(t)) : traces, blind);
  }
}
fs.writeFileSync(path.join(import.meta.dirname, 'results.json'), JSON.stringify(results, null, 1));
console.log(`\nwrote v2/causal/results.json in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
