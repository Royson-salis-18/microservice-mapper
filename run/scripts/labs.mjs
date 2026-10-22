#!/usr/bin/env node
// One command: take each bench host's current IP from the mapper, open SSH tunnels to its Grafana and FaultLab, print the links.
//
//   npm run labs                    tunnels for shopflow and ledgerline (the targets that run Grafana + FaultLab)
//   npm run labs -- status          which tunnels are up
//   npm run labs -- down            close them
//   npm run labs -- up <target>...  only these targets (any target name known to the mapper)
//
// The IP comes from the running mapper (GET /api/config/remote, so an IP changed in the app is used at once); if the server is
// not running it falls back to server/data/remote_config.json. EC2 public IPs change on every stop/start: change it in the
// app (Edit project) or `npm run hosts -- set <target> <ip>`, then run this again.
// Each tunnel is an ssh control-master socket, so `down` closes exactly what `up` opened and a second `up` reuses live ones.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const MAPPER = process.env.MAPPER_URL ?? 'http://localhost:3001';
const DEFAULTS = ['ledgerline', 'shopflow'];
// Fixed local ports per target so bookmarks keep working. Unknown targets get the next free pair after these.
const PORTS = { ledgerline: { grafana: 23000, faultlab: 28100 }, shopflow: { grafana: 23100, faultlab: 28101 } };
const REMOTE = { grafana: 3000, faultlab: 8099 };
const sock = (t) => path.join(os.tmpdir(), `mapper-labs-${t}.sock`);
const expand = (p) => (p ?? '').replace(/^~(?=$|\/)/, os.homedir());

async function loadHosts() {
  try {
    const r = await fetch(`${MAPPER}/api/config/remote`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) return { hosts: await r.json(), from: `the mapper at ${MAPPER}` };
  } catch { /* server not running */ }
  const file = path.join(ROOT, 'server', 'data', 'remote_config.json');
  return { hosts: JSON.parse(fs.readFileSync(file, 'utf8')), from: `${file} (the mapper server is not running)` };
}

const portFree = (port) => new Promise((res) => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port, '127.0.0.1');
});
const reachable = (host, port = 22, ms = 5000) => new Promise((res) => {
  const s = net.connect({ host, port, timeout: ms });
  s.on('connect', () => { s.destroy(); res(true); }); s.on('timeout', () => { s.destroy(); res(false); }); s.on('error', () => res(false));
});
const ssh = (args) => spawnSync('ssh', args, { encoding: 'utf8' });
const isUp = (t) => fs.existsSync(sock(t)) && ssh(['-S', sock(t), '-O', 'check', 'x']).status === 0;
async function get(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return { ok: r.status < 500, text: await r.text() }; } catch { return { ok: false, text: '' }; }
}

const [cmd = 'up', ...rest] = process.argv.slice(2);
const { hosts, from } = await loadHosts();
const wanted = rest.length ? rest : DEFAULTS;
const targets = cmd === 'down' || cmd === 'status' ? (rest.length ? rest : DEFAULTS.concat(Object.keys(hosts).filter((k) => !DEFAULTS.includes(k)))) : wanted;

if (cmd === 'down' || cmd === 'status') {
  for (const t of targets) {
    const up = isUp(t);
    if (cmd === 'status') { if (up || DEFAULTS.includes(t)) console.log(`${t.padEnd(14)} ${up ? 'tunnel up' : 'no tunnel'}`); }
    else if (up) { ssh(['-S', sock(t), '-O', 'exit', 'x']); console.log(`${t}: closed`); }
  }
  process.exit(0);
}
if (cmd !== 'up') { console.error('usage: npm run labs [-- up|down|status] [target...]'); process.exit(2); }

console.log(`IPs from ${from}\n`);
let next = 0;
const portsFor = (t) => PORTS[t] ?? (() => { next += 1; return { grafana: 23200 + next, faultlab: 28200 + next }; })();
let failed = 0;
const links = [];
for (const t of targets) {
  const h = hosts[t];
  if (!h?.ec2PublicIp) { console.log(`${t}: not in the mapper's hosts (npm run hosts -- set ${t} <public-ip>)`); failed++; continue; }
  const ip = h.ec2PublicIp, user = h.sshUsername ?? 'ubuntu', key = expand(h.sshKeyPath ?? '~/Downloads/sock-shop-key.pem');
  const p = portsFor(t);
  console.log(`${t}: ${user}@${ip}`);
  if (!fs.existsSync(key)) { console.log(`  FAIL key not found: ${key}`); failed++; continue; }
  if (!(await reachable(ip))) { console.log(`  FAIL ${ip}:22 does not answer. The instance has a new public IP or is stopped: update it in the app or  npm run hosts -- set ${t} <new-ip>`); failed++; continue; }
  if (isUp(t)) ssh(['-S', sock(t), '-O', 'exit', 'x']);      // always re-open: it may point at an old IP
  const taken = [];
  for (const port of [p.grafana, p.faultlab]) if (!(await portFree(port))) taken.push(port);
  if (taken.length) { console.log(`  FAIL local port ${taken.join(', ')} is taken by something else`); failed++; continue; }
  const r = ssh(['-fN', '-M', '-S', sock(t), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-i', key,
    '-L', `127.0.0.1:${p.grafana}:127.0.0.1:${REMOTE.grafana}`, '-L', `127.0.0.1:${p.faultlab}:127.0.0.1:${REMOTE.faultlab}`, `${user}@${ip}`]);
  if (r.status !== 0) { console.log(`  FAIL ssh: ${(r.stderr || '').trim().split('\n').pop()}`); failed++; continue; }
  const g = await get(`http://127.0.0.1:${p.grafana}/api/health`);
  let f = await get(`http://127.0.0.1:${p.faultlab}/`);
  if (!f.ok) {
    // The panel is a plain node process on the host (not a container), so a reboot or a `make down` leaves it gone. Start it the
    // documented way: node lab/faultlab/panel.mjs <project> --port 8099, from the bench folder, detached.
    console.log('  faultlab panel is not running on the host: starting it');
    ssh(['-S', sock(t), 'x', `cd ~/bench && (nohup node lab/faultlab/panel.mjs ${t} --port ${REMOTE.faultlab} > ~/faultlab-panel.log 2>&1 < /dev/null &) ; sleep 2`]);
    f = await get(`http://127.0.0.1:${p.faultlab}/`);
  }
  console.log(`  grafana ${g.ok ? 'answers' : 'DOES NOT ANSWER (not running on this host?)'}, faultlab ${f.ok ? 'answers' : 'DOES NOT ANSWER (not running on this host?)'}`);
  links.push(`${t}\n  Grafana : http://localhost:${p.grafana}/d/bench/${t}-test-bench?orgId=1&from=now-15m&to=now&timezone=browser&refresh=5s\n  FaultLab: http://localhost:${p.faultlab}`);
}
if (links.length) console.log(`\n=== OPEN THESE ===\n${links.join('\n')}\n\nclose them with: npm run labs -- down`);
process.exit(failed && !links.length ? 1 : 0);
