#!/usr/bin/env node
// The staged demonstration, end to end, on one machine that runs the bench (Docker) and the mapper.
//
//   npm run demo -- --bench ../bench-1 --subject shopflow [--baseline 10] [--calm 20] [--storm 15] [--dry-run]
//
//   1 baseline   watch the running services only, so the mapper learns what normal is
//   2 traffic    raise the organic traffic (x2) so request rates rise in the mapper
//   3 calm       random faults, one at a time (gentle): can it name each root cause and its cascade?
//   4 storm      ramp up: faults more often, up to two at once
//   5 score      compare the mapper's answers with the injector's private ledger -> one HTML report
//
// The mapper (npm run local) must already be running. The injector is blind: it never talks to the mapper. Minutes are real time.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const a = process.argv.slice(2), o = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1]?.startsWith('--') || a[i + 1] === undefined ? true : a[++i];
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bench = path.resolve(String(o.bench ?? '../bench-1')), subject = String(o.subject ?? 'shopflow');
const mins = (k, d) => Number(o[k] ?? d), dry = !!o['dry-run'];
const tsx = path.join(root, 'server/node_modules/tsx/dist/cli.mjs'), lab = path.join(bench, 'lab/faultlab/faultlab.mjs');
const dir = path.join(os.homedir(), '.faultlab'), ledger = path.join(dir, `ledger-${subject}.jsonl`), observed = path.join(dir, `observed-${subject}.jsonl`);
const say = (s) => console.log(`\n== ${s}`);
const sleep = (m) => (dry ? Promise.resolve() : new Promise((r) => setTimeout(r, m * 60000)));
const run = (cmd, args, opt = {}) => { console.log(`+ ${cmd} ${args.join(' ')}`); return dry ? { status: 0 } : spawnSync(cmd, args, { stdio: 'inherit', ...opt }); };
const bg = (cmd, args) => { console.log(`+ ${cmd} ${args.join(' ')} &`); return dry ? null : spawn(cmd, args, { stdio: 'inherit' }); };
const wait = (p) => (p ? new Promise((r) => p.on('close', r)) : Promise.resolve());
const traffic = (rps) => run('docker', ['compose', '-p', subject, '-f', path.join(bench, subject, subject === 'shopflow' ? '.rendered/docker-compose.yml' : '.rendered/docker-compose.yml'), '--profile', 'traffic', 'up', '-d', '--force-recreate', 'traffic'], { env: { ...process.env, TRAFFIC_BASE_RPS: String(rps) } });

if (!dry && !fs.existsSync(lab)) { console.error(`no injector at ${lab}: pass --bench <path to the bench repo>`); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
if (!dry) for (const f of [ledger, observed]) if (fs.existsSync(f)) fs.renameSync(f, `${f}.${Date.now()}.old`);

const obs = bg('node', [tsx, path.join(root, 'tools/eval/run.ts'), 'observe', '--subject', subject, '--target', subject, '--interval', '5']);
say(`1/5 baseline: ${mins('baseline', 10)} min of normal operation (the mapper learns what normal looks like)`);
await sleep(mins('baseline', 10));
say('2/5 traffic: organic load x2'); traffic(subject === 'shopflow' ? 1.2 : 2); await sleep(3);
say(`3/5 calm campaign: ${mins('calm', 20)} min, one fault at a time`);
await wait(bg('node', [lab, subject, 'run', '--profile', 'realistic', '--duration', `${mins('calm', 20)}m`, '--max-concurrent', '1', '--rate-per-min', '0.4', '--seed', String(o.seed ?? 'demo'), '--blind']));
say(`4/5 storm: ${mins('storm', 15)} min, faults more often, up to two at once`);
await wait(bg('node', [lab, subject, 'run', '--profile', 'stormy', '--duration', `${mins('storm', 15)}m`, '--max-concurrent', '2', '--seed', `${o.seed ?? 'demo'}-storm`, '--blind']));
await sleep(2);
obs?.kill('SIGINT');
say('5/5 score against the injector\'s ledger');
const out = path.join(root, 'wiki visualizer');
run('node', [tsx, path.join(root, 'tools/eval/run.ts'), 'all', '--subject', subject, '--traffic', `${subject}-traffic-1`, '--warmup', String(mins('baseline', 10)), '--out', dir]);
if (!dry && fs.existsSync(path.join(dir, `eval-${subject}.html`))) { fs.mkdirSync(out, { recursive: true }); fs.copyFileSync(path.join(dir, `eval-${subject}.html`), path.join(out, 'experiment-report.html')); console.log(`\nreport: ${path.join(out, 'experiment-report.html')}`); }
