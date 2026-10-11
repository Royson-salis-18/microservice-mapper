#!/usr/bin/env node
// `npm run doctor`: checks what the mapper needs on THIS machine (macOS, Linux or Windows) and says how to fix what is missing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const win = process.platform === 'win32';
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, fix) => { console.log(`  MISSING ${m}\n          fix: ${fix}`); problems++; };
const opt = (m, fix) => console.log(`  note  ${m}${fix ? `\n          ${fix}` : ''}`);
let problems = 0;
const has = (cmd, args = ['--version']) => { try { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 }); return r.status === 0 ? `${r.stdout}${r.stderr}`.trim().split('\n')[0] : null; } catch { return null; } };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

console.log(`microservice-mapper doctor  (${process.platform} ${os.arch()}, node ${process.version})\n`);
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node ${process.version}`) : bad(`Node 20+ (found ${process.version})`, process.platform === 'darwin' ? 'brew install node@22' : win ? 'winget install OpenJS.NodeJS.LTS' : 'install Node 22 from nodejs.org');

for (const d of ['', 'server', 'client', 'traffic-gen', 'remote-collector']) {
  fs.existsSync(path.join(root, d, 'node_modules')) ? ok(`dependencies installed in ./${d}`) : bad(`dependencies in ./${d}`, 'npm run install:all');
}
const ssh = has('ssh', ['-V']);
ssh ? ok(`ssh client (${ssh})`) : opt('no ssh client: discovery still works (it uses a built-in SSH library); only the in-app terminal needs it', win ? 'Settings > Apps > Optional features > OpenSSH Client' : '');
const py = ['python3', 'python', 'py'].map((c) => [c, has(c)]).find(([, v]) => v && /Python 3/.test(v));
py ? ok(`Python (${py[0]}: ${py[1]}) for the ML panel`) : opt('no Python 3: only the ML panel needs it', 'install Python 3.10+; or set MAPPER_PYTHON to an interpreter');
const docker = has('docker', ['version', '--format', '{{.Server.Version}}']);
docker ? ok(`Docker ${docker} (only needed to map containers on this machine)`) : opt('Docker not running here: fine when you map remote hosts over SSH');

const cfgPath = path.join(root, 'server', 'data', 'remote_config.json');
if (fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const home = os.homedir();
  for (const [id, t] of Object.entries(cfg)) {
    if (!t || typeof t !== 'object' || !t.sshKeyPath) continue;
    let p = String(t.sshKeyPath).replace(/^["']|["']$/g, '');
    if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2));
    const base = p.split(/[\\/]/).pop();
    const found = fs.existsSync(p) ? p : ['.ssh', 'Downloads', 'Desktop', 'Documents', ''].map((d) => path.join(home, d, base)).find((c) => fs.existsSync(c));
    found ? ok(`target ${id}: key ${found}`) : bad(`target ${id}: SSH key ${t.sshKeyPath}`, `put ${base} in ~/.ssh or ~/Downloads, or re-enter the key path in Add Project`);
  }
}
console.log(problems ? `\n${problems} thing(s) to fix.` : '\nAll set: npm run dev  ->  http://localhost:5173');
process.exitCode = problems ? 1 : 0;
