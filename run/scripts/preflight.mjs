#!/usr/bin/env node
// `npm run preflight`: is everything ready for a demonstration? Prints GO or NO-GO, and for every problem the one thing to do.
//
// Checks, for every project the mapper knows: the host answers on ssh, its app answers on the entry point, the mapper is receiving
// live data from it, no service is already degraded or down, no link is already failing, no incident is open, the host has memory and
// CPU to spare. For ShopFlow and Ledgerline also the Grafana and FaultLab tunnels (opens them if they are not up).
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const MAPPER = process.env.MAPPER_URL ?? 'http://localhost:3001';
const CLIENT = process.env.CLIENT_URL ?? 'http://localhost:5173';
const issues = [];
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m, fix) => { console.log(`  \x1b[31mFIX\x1b[0m   ${m}\n         -> ${fix}`); issues.push(m); };
const note = (m) => console.log(`  note  ${m}`);
const j = async (url, ms = 8000) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const up = async (url, ms = 6000) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.status < 500; } catch { return false; } };
const tcp = (host, port, ms = 5000) => new Promise((res) => { const s = net.connect({ host, port, timeout: ms }); s.on('connect', () => { s.destroy(); res(true); }); s.on('timeout', () => { s.destroy(); res(false); }); s.on('error', () => res(false)); });
const BENCH = { ledgerline: { grafana: 23000, faultlab: 28100 }, shopflow: { grafana: 23100, faultlab: 28101 } };

console.log('\nMapper');
const status = await j(`${MAPPER}/api/status`);
if (!status) { bad('the mapper server is not running', 'npm run dev   (from the project folder)'); finish(); }
else ok(`server answers at ${MAPPER}`);
if (await up(CLIENT)) ok(`web app answers at ${CLIENT}`); else bad('the web app is not running', 'npm run dev');

const targets = (await j(`${MAPPER}/api/targets`)) ?? [];
const hosts = (await j(`${MAPPER}/api/config/remote`)) ?? {};
const graph = (await j(`${MAPPER}/api/graph`)) ?? { nodes: [], edges: [] };
const incidents = (await j(`${MAPPER}/api/incidents`)) ?? [];
if (!targets.length) bad('the mapper has no projects', 'add them in the app (Add project) or  npm run hosts -- set <name> <ip>');

for (const t of targets) {
  const id = t.targetId, h = hosts[id] ?? {};
  console.log(`\n${id}  (${t.host})`);
  if (!(await tcp(t.host, 22))) { bad(`${t.host}:22 does not answer (new public IP, or stopped)`, `EC2 console -> copy the Public IPv4 address, then  npm run hosts -- set ${id} <ip>   and restart the server`); continue; }
  ok('ssh port answers');

  const key = (h.sshKeyPath ?? '~/Downloads/sock-shop-key.pem').replace(/^~/, os.homedir());
  const r = spawnSync('ssh', ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', `${h.sshUsername ?? 'ubuntu'}@${t.host}`,
    "cat /proc/loadavg; nproc; free -m | awk 'NR==2{print $3\" \"$2}'; timeout 15 docker ps -q | wc -l; docker ps --format '{{.Names}} {{.Status}}' | grep -ci 'restarting\\|unhealthy\\|paused'; true"], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) bad(`ssh login failed: ${(r.stderr || '').trim().split('\n').pop()}`, 'wrong key or user for this instance: npm run hosts -- key <target> <path>');
  else {
    const [load, cpus, mem, containers, sick] = r.stdout.trim().split('\n');
    const l1 = Number(load.split(' ')[0]), n = Number(cpus), [used, total] = mem.split(' ').map(Number);
    if (l1 > n * 2) bad(`host load ${l1} on ${n} CPUs`, 'wait for it to settle, or stop what is loading it (a leftover traffic run?)'); else ok(`load ${l1} on ${n} CPUs, memory ${used}/${total} MB, ${containers} containers`);
    if (used / total > 0.9) bad(`memory ${Math.round((used / total) * 100)}% used`, 'free memory: stop heavy services you do not need');
    if (Number(sick) > 0) bad(`${sick} container(s) restarting, unhealthy or paused`, `docker ps on the host; for a bench: the FaultLab panel -> Heal everything`);
  }

  const url = (await j(`${MAPPER}/api/targets/${id}/resolved-url`))?.resolvedUrl;
  if (url && (await up(url))) ok(`app answers at ${url}`); else bad(`the app does not answer at ${url ?? '(no entry point)'}`, 'is the stack up on the host? (check-host: npm run check-host -- <ip> <key> <port>)');

  if (t.status === 'LIVE') ok('the mapper is receiving live data'); else bad(`the mapper shows this project as ${t.status}`, 'wait a minute; if it stays, restart the server or press Reload on the project');
  const nodes = graph.nodes.filter((n) => n.project === id);
  const notOk = nodes.filter((n) => n.status !== 'healthy');
  if (nodes.length === 0) bad('no services in the graph yet', 'press Reload (circular arrow) in the top bar with this project selected');
  else if (notOk.length) bad(`${notOk.length}/${nodes.length} service(s) not healthy: ${notOk.map((n) => `${n.name} (${n.status})`).join(', ')}`, 'let it settle for 2 minutes; if it stays, heal the host (FaultLab) or restart that container');
  else ok(`${nodes.length} services, all healthy`);
  const badLinks = graph.edges.filter((e) => e.source.startsWith(`${id}:`) && (e.status === 'failed' || e.status === 'degraded'));
  if (badLinks.length) bad(`${badLinks.length} link(s) already red/amber: ${badLinks.map((e) => `${e.source.split(':')[1]}>${e.target.split(':')[1]}`).join(', ')}`, 'they clear about 2 minutes after errors stop; if traffic is running, stop it and wait');
  const open = incidents.filter((i) => i.targetId === id && i.status !== 'RESOLVED');
  if (open.length) bad(`${open.length} open incident(s) (root: ${open.map((i) => i.rootCauseServiceId).join(', ')})`, 'wait for them to resolve, or clear them: POST /api/data/clear for this project (the model relearns in a few minutes)');
  else ok('no open incident');

  if (BENCH[id]) {
    const p = BENCH[id];
    if (!(await up(`http://127.0.0.1:${p.grafana}/api/health`)) || !(await up(`http://127.0.0.1:${p.faultlab}/`))) {
      note('Grafana / FaultLab tunnels are not up: opening them');
      spawnSync('node', ['run/scripts/labs.mjs', 'up', id], { stdio: 'ignore' });
    }
    if (await up(`http://127.0.0.1:${p.grafana}/api/health`)) ok(`Grafana  http://localhost:${p.grafana}/d/bench/${id}-test-bench`); else bad('Grafana does not answer through the tunnel', 'npm run labs');
    if (await up(`http://127.0.0.1:${p.faultlab}/`)) ok(`FaultLab http://localhost:${p.faultlab}`); else bad('FaultLab does not answer through the tunnel', 'npm run labs');
  }
}
finish();

function finish() {
  console.log(issues.length ? `\n\x1b[31mNO-GO\x1b[0m: ${issues.length} thing(s) to fix (see "FIX" above), then run  npm run preflight  again.\n` : '\n\x1b[32mGO\x1b[0m: everything is ready.\n');
  process.exit(issues.length ? 1 : 0);
}
