#!/usr/bin/env node
// List or change the hosts the mapper connects to over SSH (server/data/remote_config.json), without the UI.
//
//   npm run hosts                                  list every target with its IP, user, key and whether port 22 answers
//   npm run hosts -- set <target> <public-ip>      change a target's IP (EC2 public IPs change on every stop/start)
//   npm run hosts -- key <target> <path-to-pem>    change its key
//   npm run hosts -- compose <target> <path>       the docker-compose file on the host (optional)
//   npm run hosts -- remove <target>               stop mapping it
//
// Restart the server afterwards (or use Edit project in the app, which applies at once).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'data', 'remote_config.json');
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const [cmd, target, value] = process.argv.slice(2);
const save = () => { fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n'); console.log(`saved ${file}\nrestart the server (Ctrl-C, then npm run dev) or use Edit project in the app`); };
const probe = (host) => new Promise((r) => { const s = net.connect({ host, port: 22, timeout: 4000 }); s.on('connect', () => { s.destroy(); r('port 22 open'); }); s.on('timeout', () => { s.destroy(); r('NO ANSWER on 22 (wrong IP, instance stopped, or security group)'); }); s.on('error', (e) => r(`error ${e.code}`)); });

if (!cmd) {
  if (!Object.keys(cfg).length) console.log('no targets yet: add one in the app (Add project) or with: npm run hosts -- set <name> <ip>');
  for (const [k, v] of Object.entries(cfg)) console.log(`${k.padEnd(16)} ${String(v.ec2PublicIp).padEnd(16)} ${v.sshUsername ?? 'ubuntu'}  ${v.sshKeyPath ?? '(no key)'}  ${await probe(v.ec2PublicIp)}`);
} else if (!target) { console.error('which target?'); process.exit(2); }
else if (cmd === 'set') { if (/^(10|127)\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(value ?? '')) { console.error(`${value} is a private address; use the PUBLIC IPv4 from the EC2 console`); process.exit(2); } cfg[target] = { sshUsername: 'ubuntu', sshKeyPath: '~/Downloads/sock-shop-key.pem', displayName: target, ...cfg[target], ec2PublicIp: value, updatedAt: new Date().toISOString() }; save(); }
else if (cmd === 'key') { cfg[target] = { ...cfg[target], sshKeyPath: value }; save(); }
else if (cmd === 'compose') { cfg[target] = { ...cfg[target], composeFilePath: value }; save(); }
else if (cmd === 'remove') { delete cfg[target]; save(); }
else { console.error(`unknown command ${cmd}`); process.exit(2); }
