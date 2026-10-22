/**
 * The web consoles of each host (the app itself, Grafana, Prometheus, FaultLab, ...) as clickable links.
 *
 * Two kinds. A DIRECT link is a page the host already serves on a port the security group allows: it opens as it is. A TUNNEL
 * link is a page bound to the host's localhost (Grafana, Prometheus, the FaultLab panel): the server opens an ssh port forward
 * to it and the link points at the local end. The forwards use the same control sockets and local ports as `npm run labs`, so
 * the two never fight, and `close` ends exactly what `open` started.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface HostConfig { ec2PublicIp?: string; sshUsername?: string; sshKeyPath?: string; displayName?: string; trafficBaseUrl?: string }

interface DirectDef { kind: 'direct'; id: string; label: string; port: number; path?: string; note?: string }
interface TunnelDef { kind: 'tunnel'; id: string; label: string; remotePort: number; localPort: number; path?: string; note?: string; startsFaultLab?: boolean }
type ConsoleDef = DirectDef | TunnelDef;

/** The same local ports `npm run labs` uses, so bookmarks keep working. */
const BENCH_TUNNELS: Record<string, { grafana: number; prometheus: number; faultlab: number }> = {
  ledgerline: { grafana: 23000, prometheus: 29000, faultlab: 28100 },
  shopflow: { grafana: 23100, prometheus: 29100, faultlab: 28101 },
};

/** What each known project serves. Anything else gets just its app link. */
function catalog(targetId: string, appPort: number): ConsoleDef[] {
  const app: DirectDef = { kind: 'direct', id: 'app', label: 'App UI', port: appPort, note: 'the system under test' };
  const bench = BENCH_TUNNELS[targetId];
  if (bench) {
    return [
      app,
      { kind: 'tunnel', id: 'grafana', label: 'Grafana', remotePort: 3000, localPort: bench.grafana, path: `/d/bench/${targetId}-test-bench?orgId=1&from=now-15m&to=now&timezone=browser&refresh=5s`, note: 'test-bench dashboard' },
      { kind: 'tunnel', id: 'faultlab', label: 'FaultLab', remotePort: 8099, localPort: bench.faultlab, note: 'inject faults and start/stop its own traffic', startsFaultLab: true },
      { kind: 'tunnel', id: 'prometheus', label: 'Prometheus', remotePort: 9090, localPort: bench.prometheus },
    ];
  }
  if (targetId === 'open-telemetry') {
    // The demo's Envoy front proxy serves its own consoles under the one open port.
    return [
      { ...app, label: 'Shop UI', note: 'OpenTelemetry demo storefront' },
      { kind: 'direct', id: 'grafana', label: 'Grafana', port: appPort, path: '/grafana/' },
      { kind: 'direct', id: 'jaeger', label: 'Jaeger', port: appPort, path: '/jaeger/ui/' },
      { kind: 'direct', id: 'flags', label: 'Feature flags', port: appPort, path: '/feature' },
    ];
  }
  if (targetId === 'death-star') {
    return [
      { ...app, label: 'Social network UI', note: 'nginx-thrift' },
      { kind: 'direct', id: 'media', label: 'Media frontend', port: 8081, path: '/', note: 'port 8081 must be open in the security group' },
    ];
  }
  return [app];
}

export interface ConsoleLink { id: string; label: string; url: string; kind: 'direct' | 'tunnel'; ready: boolean; note?: string }
export interface HostConsoles { targetId: string; displayName: string; ip: string; hasTunnels: boolean; tunnelUp: boolean; links: ConsoleLink[] }

const sock = (t: string) => path.join(os.tmpdir(), `mapper-labs-${t}.sock`);
const expand = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
const SAFE = /^[A-Za-z0-9._-]+$/;

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
}
const tunnelUp = async (t: string) => fs.existsSync(sock(t)) && (await run('ssh', ['-S', sock(t), '-O', 'check', 'x'], 4000)).ok;
const portFree = (port: number) => new Promise<boolean>((res) => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port, '127.0.0.1');
});
async function answers(url: string): Promise<boolean> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.status < 500; } catch { return false; }
}

export class Consoles {
  constructor(private readonly hosts: () => Record<string, HostConfig>, private readonly appPortOf: (targetId: string) => number) {}

  async list(): Promise<HostConsoles[]> {
    const out: HostConsoles[] = [];
    for (const [targetId, h] of Object.entries(this.hosts())) {
      if (!h.ec2PublicIp || !SAFE.test(targetId)) continue;
      const defs = catalog(targetId, this.appPortOf(targetId));
      const up = await tunnelUp(targetId);
      const links: ConsoleLink[] = [];
      for (const d of defs) {
        if (d.kind === 'direct') links.push({ id: d.id, label: d.label, kind: 'direct', ready: true, url: `http://${h.ec2PublicIp}:${d.port}${d.path ?? '/'}`, note: d.note });
        else links.push({ id: d.id, label: d.label, kind: 'tunnel', ready: up, url: `http://localhost:${d.localPort}${d.path ?? ''}`, note: d.note });
      }
      out.push({ targetId, displayName: h.displayName ?? targetId, ip: h.ec2PublicIp, hasTunnels: defs.some((d) => d.kind === 'tunnel'), tunnelUp: up, links });
    }
    return out;
  }

  /** Opens the forwards for one project (and starts its FaultLab panel on the host if it is not running). */
  async open(targetId: string): Promise<{ ok: boolean; message: string }> {
    const h = this.hosts()[targetId];
    if (!h?.ec2PublicIp || !SAFE.test(targetId)) return { ok: false, message: `${targetId} is not in the mapper's hosts` };
    const tunnels = catalog(targetId, this.appPortOf(targetId)).filter((d): d is TunnelDef => d.kind === 'tunnel');
    if (tunnels.length === 0) return { ok: true, message: 'nothing to tunnel for this project' };
    const user = h.sshUsername ?? 'ubuntu';
    const key = expand(h.sshKeyPath ?? '~/Downloads/sock-shop-key.pem');
    if (!SAFE.test(user) || !/^[0-9.]+$/.test(h.ec2PublicIp)) return { ok: false, message: 'host settings look wrong' };
    if (!fs.existsSync(key)) return { ok: false, message: `ssh key not found: ${key}` };

    if (await tunnelUp(targetId)) await run('ssh', ['-S', sock(targetId), '-O', 'exit', 'x'], 4000); // may point at an old IP
    for (const t of tunnels) if (!(await portFree(t.localPort))) return { ok: false, message: `local port ${t.localPort} is taken by another program` };

    const args = ['-fN', '-M', '-S', sock(targetId), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-i', key];
    for (const t of tunnels) args.push('-L', `127.0.0.1:${t.localPort}:127.0.0.1:${t.remotePort}`);
    args.push(`${user}@${h.ec2PublicIp}`);
    const r = await run('ssh', args, 25_000);
    if (!r.ok) return { ok: false, message: `ssh to ${h.ec2PublicIp} failed: ${r.out.split('\n').pop() || 'no answer'} (new public IP? update it in Edit project)` };

    const fl = tunnels.find((t) => t.startsFaultLab);
    if (fl && !(await answers(`http://127.0.0.1:${fl.localPort}/`))) {
      // A plain node process on the host, not a container: gone after a reboot or a stack reset.
      await run('ssh', ['-S', sock(targetId), 'x', `cd ~/bench && (nohup node lab/faultlab/panel.mjs ${targetId} --port ${fl.remotePort} > ~/faultlab-panel.log 2>&1 < /dev/null &) ; sleep 2`], 15_000);
    }
    return { ok: true, message: 'tunnels open' };
  }

  async close(targetId: string): Promise<{ ok: boolean }> {
    if (!SAFE.test(targetId)) return { ok: false };
    if (await tunnelUp(targetId)) await run('ssh', ['-S', sock(targetId), '-O', 'exit', 'x'], 4000);
    return { ok: true };
  }
}
