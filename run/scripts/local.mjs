#!/usr/bin/env node
// `npm run local`: run the whole mapper on THIS machine (macOS, Linux or Windows) and map the Docker containers running here.
//
//   npm run local                          start the mapper, and a collector for every docker compose project that is running
//   npm run local -- --project shopflow    only these projects (comma separated); each becomes its own target in the UI
//   npm run local -- --no-collect          the mapper only (map remote hosts from the UI instead)
//   npm run local -- --dry-run             say what would start, change nothing
//
// What it does: checks Node and Docker, installs dependencies if any folder is missing them, starts the server (:3001) and the
// UI (:5173), waits until the server answers, then starts one collector per compose project. Ctrl-C stops everything it started.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const dry = flag('dry-run');
const MAPPER = process.env.MAPPER_URL ?? 'http://127.0.0.1:3001';
const say = (m) => console.log(m);
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', shell: win, timeout: 20000, ...o });

// ---- prerequisites
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { say(`Node 20 or newer is needed (found ${process.version}). Install it from https://nodejs.org and run this again.`); process.exit(1); }
const dockerOut = run('docker', ['version', '--format', '{{.Server.Version}}']);
const dockerOk = dockerOut.status === 0 && dockerOut.stdout.trim();
if (!dockerOk && !flag('no-collect')) {
  say('Docker is not running here, so there is nothing local to map.\n  Start Docker Desktop (or your Docker engine) and run again, or use --no-collect to open the mapper without a collector.');
  process.exit(1);
}

// ---- which compose projects to watch
function projects() {
  if (flag('no-collect')) return [];
  if (opt('project')) return opt('project').split(',').map((s) => s.trim()).filter(Boolean);
  const r = run('docker', ['ps', '--format', '{{.Label "com.docker.compose.project"}}']);
  const found = [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
  return found.filter((p) => !/^(microservice-mapper|profesional-ui-final-?)$/i.test(p));
}
const watch = projects();

say(`mapper: ${root}`);
say(`docker: ${dockerOk ? dockerOut.stdout.trim() : 'not used'}`);
say(watch.length ? `watching compose project(s): ${watch.join(', ')}` : flag('no-collect') ? 'no collector (mapper only)' : 'no compose project is running yet: starting the mapper alone. Start a bench (e.g. `make bench` in bench-1/shopflow) and run this again, or add a project with --project <name>.');
if (dry) process.exit(0);

// ---- dependencies
const needed = ['', 'server', 'client', 'remote-collector'].filter((d) => !fs.existsSync(path.join(root, d, 'node_modules')));
if (needed.length) {
  say(`installing dependencies (first run, a few minutes): ${needed.map((d) => d || 'root').join(', ')}`);
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['run', 'install:all'], { cwd: root, stdio: 'inherit', shell: win });
  if (r.status !== 0) { say('npm install failed: see the messages above (npm run doctor explains what this machine is missing).'); process.exit(1); }
}

// ---- start things; remember them so Ctrl-C can stop them
const children = [];
const start = (label, cmd, a, o = {}) => {
  const c = spawn(cmd, a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: win, ...o });
  const tag = `[${label}] `;
  const pipe = (s, out) => s.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => out.write(tag + l + '\n')));
  pipe(c.stdout, process.stdout); pipe(c.stderr, process.stderr);
  c.on('exit', (code) => say(`${tag}exited (${code})`));
  children.push(c); return c;
};
const stopAll = () => { for (const c of children) { try { win ? spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F']) : process.kill(-c.pid ?? c.pid, 'SIGTERM'); } catch { try { c.kill(); } catch { /* gone */ } } } };
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });

start('mapper', win ? 'npm.cmd' : 'npm', ['run', 'dev'], { detached: !win });

const up = async () => { try { return (await fetch(`${MAPPER}/api/targets`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
for (let i = 0; i < 90 && !(await up()); i++) await new Promise((r) => setTimeout(r, 2000));
if (!(await up())) { say('the mapper server did not come up in 3 minutes: see its log above.'); stopAll(); process.exit(1); }

const tsx = path.join(root, 'remote-collector', 'node_modules', 'tsx', 'dist', 'cli.mjs');
for (const p of watch) {
  start(`collect ${p}`, process.execPath, [tsx, 'index.ts'], { cwd: path.join(root, 'remote-collector'), detached: !win, env: { ...process.env, TARGET_ID: p, COMPOSE_PROJECT: p, MAPPER_URL: MAPPER, ENVIRONMENT: 'local' } });
}
say(`\nopen http://localhost:5173  (pick ${watch[0] ?? 'a project'} in the top bar). Ctrl-C stops everything.\n`);
await new Promise(() => {});
