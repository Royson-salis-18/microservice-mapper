#!/usr/bin/env node
// tools/eval/run.ts: evaluate the mapper against an injector campaign.
//
//   observe   watch the mapper and record snapshots           run it BEFORE and DURING a campaign
//   score     ledger + snapshots -> metrics (JSON, to stdout)
//   report    the same, as one HTML page with charts
//   all       score + report, writing both next to the snapshots
//
//   node server/node_modules/tsx/dist/cli.mjs tools/eval/run.ts observe --subject shopflow --target shopflow [--mapper http://localhost:3001] [--interval 5] [--duration 3600]
//   node server/node_modules/tsx/dist/cli.mjs tools/eval/run.ts all --subject shopflow [--ledger path] [--observed path] [--grace 60] [--out dir] [--traffic <container>|none]
//
// The ledger is the injector's private ground truth (default ~/.faultlab/ledger-<subject>.jsonl). The harness reads it only
// after the fact and never writes to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { score } from './score.ts';
import { loadLedger, loadObserved, loadTrafficImpact } from './load.ts';
import { observe } from './observe.ts';
import { renderReport } from './report.ts';

const [cmd = 'all', ...rest] = process.argv.slice(2);
const o: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) o[rest[i].slice(2)] = rest[++i];
const subject = o.subject ?? o.target ?? 'shopflow';
const dir = path.join(os.homedir(), '.faultlab');
const ledgerPath = o.ledger ?? path.join(dir, `ledger-${subject}.jsonl`);
const observedPath = o.observed ?? path.join(dir, `observed-${subject}.jsonl`);
const outDir = o.out ?? dir;

async function main() {
  if (cmd === 'observe') {
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort()); process.on('SIGTERM', () => ac.abort());
    console.error(`observing ${o.mapper ?? 'http://localhost:3001'} target=${o.target ?? subject} -> ${observedPath} (Ctrl-C to stop)`);
    const r = await observe({ mapper: o.mapper ?? 'http://localhost:3001', target: o.target ?? subject, out: observedPath, intervalSec: Number(o.interval ?? 5), durationSec: o.duration ? Number(o.duration) : undefined, signal: ac.signal, log: (s) => console.error(s) });
    console.error(`done: ${r.snapshots} snapshots, ${r.missed} missed`);
    return;
  }
  if (!fs.existsSync(ledgerPath)) throw new Error(`no ledger at ${ledgerPath}: run a faultlab campaign on this host first`);
  if (!fs.existsSync(observedPath)) throw new Error(`no observations at ${observedPath}: run "observe" while the campaign runs`);
  const { faults, campaigns } = loadLedger(ledgerPath);
  const snaps = loadObserved(observedPath);
  if (!snaps.length) throw new Error('the observation file is empty');
  // score only the faults that happened while we were watching
  const t0 = snaps[0].ts, t1 = snaps.at(-1)!.ts;
  const scored = faults.filter((f) => f.b >= t0 && f.a <= t1);
  // what users felt, from the traffic generator's own log: an independent measure the mapper never sees
  const trafficContainer = o.traffic ?? `${subject}-traffic-1`;
  const impact = o.traffic === 'none' ? [] : loadTrafficImpact(trafficContainer, t0);
  if (!impact.length) console.error(`note: no traffic log from container ${trafficContainer}; faults cannot be split into felt and unfelt (use --traffic <container>)`);
  const result = score(scored, snaps, { graceSec: Number(o.grace ?? 60) }, impact);
  if (cmd === 'score') { console.log(JSON.stringify(result, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2)); return; }

  // service rows for the timeline: faulted services first (by first fault), then the rest
  const faultOrder = [...new Set(scored.map((f) => f.target))];
  const rows = [...faultOrder, ...Object.keys(snaps.at(-1)!.status).filter((s) => !faultOrder.includes(s) && s !== 'traffic').sort()];
  const eps = new Map<string, { id: string; s: number; e: number; root: string | null }>();
  for (const s of snaps) for (const i of s.incidents) { const c = eps.get(i.id); eps.set(i.id, { id: i.id, s: Math.max(i.startedAt, t0), e: Math.max(c?.e ?? 0, s.ts), root: i.root }); }
  const html = renderReport(result, {
    subject, generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', seed: campaigns.at(-1)?.seed, mapperTarget: o.target ?? subject,
    observedSnapshots: snaps.length, spanMin: (t1 - t0) / 60000,
  }, [...eps.values()], t0, t1, rows);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `eval-${subject}`);
  fs.writeFileSync(`${base}.html`, html);
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2));
  const ov = result.overall;
  console.log(`${result.faults.length} faults: detected ${(ov.detected.p * 100).toFixed(0)}%, Top-1 ${(ov.top1.p * 100).toFixed(0)}%, Top-3 ${(ov.top3.p * 100).toFixed(0)}%, median delay ${ov.delaySec.median}s, false alarms ${result.falseAlarm.perHour.toFixed(2)}/h`);
  console.log(`wrote ${base}.html and ${base}.json`);
}
main().catch((e) => { console.error(`eval: ${e.message}`); process.exit(1); });
