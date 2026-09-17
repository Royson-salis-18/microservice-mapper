import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import type { GraphStore } from '../graph/GraphStore.js';

const TRAFFIC_GEN_PORT = process.env.TRAFFIC_GEN_PORT || '4400';
const TRAFFIC_GEN_URL = `http://localhost:${TRAFFIC_GEN_PORT}`;
const TRAFFIC_GEN_WS_URL = `ws://localhost:${TRAFFIC_GEN_PORT}/ws`;

// only targets with a workflow file under traffic-gen/workflows/
const KNOWN_TRAFFIC_GEN_TARGETS = new Set(['sock-shop', 'vertikal', 'death-star', 'train-ticket', 'open-telemetry']);

// old lowercase UI profile names -> traffic-gen's PROFILES keys
const PROFILE_MAP: Record<string, string> = {
  normal: 'BASELINE',
  baseline: 'BASELINE',
  moderate: 'MODERATE',
  heavy: 'HEAVY',
  stress: 'STRESS',
  ramp: 'RAMP',
};

// seeded sock-shop test account; without it traffic-gen zeroes out the
// account/checkout workflow weights (cfgAuthWeights in traffic-gen/server.js)
const DEFAULT_AUTH = { username: 'user', password: 'password' };

export interface TargetTrafficOptions {
  profile?: string;
  mode?: 'USER_JOURNEY' | 'ENDPOINT' | 'SERVICE';
  routeId?: string;
  serviceId?: string;
  endpointId?: string;
  overrideUrl?: string;
  authUsername?: string;
  authPassword?: string;
}

export interface TargetTrafficStatus {
  targetId: string;
  isRunning: boolean;
  profileName: string;
  mode?: string;
  routeId?: string;
  serviceId?: string;
  endpointId?: string;
  startTime: string | null;
  pid: number | null;
  resolvedUrl?: string;
  error?: string;
  workloadSource?: 'EXTERNAL' | 'USER_SIM';
}

// Proxies start/stop/status to the standalone traffic-gen server instead of
// spawning the old one-shot CLI per request. traffic-gen owns the actual
// virtual users, workflows and auth; this just forwards commands and stats.
export class TrafficController {
  private graphStore?: GraphStore;
  public onStatsCallback?: (targetId: string, stats: any) => void;

  private tracked: Map<string, { startTime: string; profile: string; mode: string; resolvedUrl: string; workloadSource: 'EXTERNAL' | 'USER_SIM' }> = new Map();
  private genProcess: ChildProcess | null = null;
  private ensureStartingPromise: Promise<void> | null = null;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;

  constructor(graphStore?: GraphStore) {
    this.graphStore = graphStore;
    this.ensureTrafficGenRunning().catch((e) => console.error('[TrafficController] Failed to start traffic-gen:', e.message));
  }

  public setGraphStore(graphStore: GraphStore) {
    this.graphStore = graphStore;
  }

  /**
   * The entry point traffic is actually sent to, in priority order:
   *   1. a URL passed with this request
   *   2. the operator-pinned entry point for this target (see below)
   *   3. whatever the endpoint registry inferred from discovery
   *   4. the target's base URL
   *
   * Step 2 exists because discovery can only report what a container
   * publishes, which is not the same as what is reachable from here. A
   * DeathStarBench box publishes nginx-thrift on :8080, but if that port
   * isn't open in the security group the inferred URL times out forever;
   * the working entry point might be an SSH forward on localhost. Pinning
   * is the honest fix — it records a fact discovery cannot observe.
   */
  public getConfiguredEntryPoint(targetId: string): string | null {
    try {
      const configPath = path.resolve(process.cwd(), 'data', 'remote_config.json');
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const url = cfg?.[targetId]?.trafficBaseUrl;
      return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
    } catch {
      return null;
    }
  }

  public resolveBaseUrl(targetId: string, endpointId?: string, overrideUrl?: string): string | null {
    if (overrideUrl && overrideUrl.trim().length > 0) {
      return overrideUrl.trim();
    }

    const pinned = this.getConfiguredEntryPoint(targetId);
    if (pinned) return pinned;

    if (this.graphStore) {
      const target = this.graphStore.targets.get(targetId);
      const targetHost = target?.host && target.host !== 'unknown' ? target.host : undefined;

      const registryUrl = this.graphStore.endpointRegistry.getEndpointUrl(targetId, endpointId, targetHost);
      if (registryUrl && !registryUrl.includes('unknown') && !registryUrl.includes('AWS-EC2-Public-IP')) {
        return registryUrl;
      }

      if (target?.baseUrl && !target.baseUrl.includes('unknown') && !target.baseUrl.includes('AWS-EC2-Public-IP')) {
        return target.baseUrl;
      }
    }

    return null;
  }

  // Spawns traffic-gen if it's not already running. Safe to call repeatedly.
  private async ensureTrafficGenRunning(): Promise<void> {
    if (this.ensureStartingPromise) return this.ensureStartingPromise;

    this.ensureStartingPromise = (async () => {
      if (await this.isTrafficGenReachable()) {
        this.connectStatsSocket();
        return;
      }

      const trafficGenDir = path.resolve(process.cwd(), '../traffic-gen');
      console.log(`[TrafficController] traffic-gen not reachable on :${TRAFFIC_GEN_PORT}, starting it from ${trafficGenDir}`);
      const child = spawn('node', ['server.js'], {
        cwd: trafficGenDir,
        env: { ...process.env, PORT: TRAFFIC_GEN_PORT },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.genProcess = child;
      child.stdout?.on('data', (chunk) => console.log(`[traffic-gen] ${chunk.toString('utf8').trim()}`));
      child.stderr?.on('data', (chunk) => console.error(`[traffic-gen:err] ${chunk.toString('utf8').trim()}`));
      child.on('exit', (code) => {
        console.log(`[TrafficController] traffic-gen process exited with code ${code}`);
        this.genProcess = null;
      });

      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 300));
        if (await this.isTrafficGenReachable()) {
          this.connectStatsSocket();
          return;
        }
      }
      console.error('[TrafficController] traffic-gen did not become reachable after starting it');
    })();

    return this.ensureStartingPromise;
  }

  private async isTrafficGenReachable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${TRAFFIC_GEN_URL}/api/targets`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Live health check + a straight proxy of traffic-gen's own per-project
   * state — not Node's own tracked belief, which can go stale if traffic-gen
   * crashes mid-run without Node finding out. */
  public async getHealth(): Promise<{ reachable: boolean; url: string; projects: any[] }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${TRAFFIC_GEN_URL}/api/projects`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { reachable: false, url: TRAFFIC_GEN_URL, projects: [] };
      const projects = await res.json();
      return { reachable: true, url: TRAFFIC_GEN_URL, projects };
    } catch {
      return { reachable: false, url: TRAFFIC_GEN_URL, projects: [] };
    }
  }

  // traffic-gen's stat field names differ from what ExperimentManager expects
  private normalizeStats(stats: any): any {
    return {
      attempted: stats.requestsAttempted || 0,
      completed: stats.requestsCompleted || 0,
      successful: stats.requestsSuccessful || 0,
      failed: stats.requestsFailed || 0,
      timeouts: stats.timeouts || 0,
      duration: stats.elapsedSec || 0,
      peakRate: stats.currentRate || 0,
    };
  }

  private connectStatsSocket() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      const ws = new WebSocket(TRAFFIC_GEN_WS_URL);
      this.ws = ws;
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'stats' && msg.data?.projectId && this.onStatsCallback) {
            this.onStatsCallback(msg.data.projectId, this.normalizeStats(msg.data));
          }
        } catch { /* ignore malformed frames */ }
      });
      ws.on('close', () => {
        this.ws = null;
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.connectStatsSocket(), 3000);
      });
      ws.on('error', () => { /* 'close' fires right after; reconnect handled there */ });
    } catch (e: any) {
      console.error('[TrafficController] Failed to open traffic-gen stats socket:', e.message);
    }
  }

  public startTarget(targetId: string, options: TargetTrafficOptions & { workloadSource?: 'EXTERNAL' | 'USER_SIM' } = {}): TargetTrafficStatus {
    const profile = options.profile || 'baseline';
    const mode = options.mode || 'USER_JOURNEY';
    const endpointId = options.endpointId;
    const overrideUrl = options.overrideUrl;
    const workloadSource = options.workloadSource || 'EXTERNAL';

    this.stopTarget(targetId);

    const resolvedUrl = this.resolveBaseUrl(targetId, endpointId, overrideUrl);
    console.log(`[EXPERIMENT] targetId=${targetId} endpoint=${endpointId || 'default'} resolvedUrl=${resolvedUrl || 'null'} status=STARTING trafficEngine=${workloadSource}`);

    if (!resolvedUrl) {
      console.warn(`[EXPERIMENT] status=ABORTED targetId=${targetId} reason="Public endpoint host not available from Target Registry"`);
      return {
        targetId, isRunning: false, profileName: profile, mode, startTime: null, pid: null,
        error: `PUBLIC HOST NOT AVAILABLE FROM CURRENT TARGET REGISTRY FOR ${targetId}`,
      };
    }

    if (workloadSource === 'USER_SIM') {
      console.log(`[TrafficController] USER_SIM requested for ${targetId} - execution delegated to environment orchestrator`);
      const startTime = new Date().toISOString();
      this.tracked.set(targetId, { startTime, profile, mode, resolvedUrl, workloadSource });
      return { targetId, isRunning: true, profileName: profile, mode, routeId: options.routeId, serviceId: options.serviceId, endpointId, startTime, pid: null, resolvedUrl, workloadSource };
    }

    if (!KNOWN_TRAFFIC_GEN_TARGETS.has(targetId)) {
      return {
        targetId, isRunning: false, profileName: profile, mode, startTime: null, pid: null,
        error: `traffic-gen has no workflow defined for target "${targetId}"`,
      };
    }

    const startTime = new Date().toISOString();
    this.tracked.set(targetId, { startTime, profile, mode, resolvedUrl, workloadSource });

    const useDiscoveredEndpoints = mode !== 'USER_JOURNEY';
    const endpointPaths = mode === 'ENDPOINT' && options.routeId ? [this.toPath(options.routeId)] : undefined;

    const body: Record<string, unknown> = {
      targetId,
      projectId: targetId,
      baseUrl: resolvedUrl,
      profile: PROFILE_MAP[profile.toLowerCase()] || 'BASELINE',
      authUsername: options.authUsername || DEFAULT_AUTH.username,
      authPassword: options.authPassword || DEFAULT_AUTH.password,
    };
    if (useDiscoveredEndpoints) {
      body.useDiscoveredEndpoints = true;
      body.endpointPaths = endpointPaths && endpointPaths.length > 0 ? endpointPaths : ['/'];
    }

    this.ensureTrafficGenRunning()
      .then(() => fetch(`${TRAFFIC_GEN_URL}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }))
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.error(`[TrafficController] traffic-gen refused to start ${targetId}: ${err.error || res.status}`);
          this.tracked.delete(targetId);
        } else {
          console.log(`[TrafficController] traffic-gen started for ${targetId} -> ${resolvedUrl} (profile=${body.profile})`);
        }
      })
      .catch((e) => {
        console.error(`[TrafficController] Failed to start traffic-gen run for ${targetId}:`, e.message);
        this.tracked.delete(targetId);
      });

    return { targetId, isRunning: true, profileName: profile, mode, routeId: options.routeId, serviceId: options.serviceId, endpointId, startTime, pid: null, resolvedUrl, workloadSource };
  }

  // best-effort: turns a routeId like ".../HTTP-/catalogue" into "/catalogue"
  private toPath(routeId: string): string {
    const idx = routeId.indexOf('/HTTP-');
    const raw = idx >= 0 ? routeId.substring(idx + 6) : routeId;
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  public stopTarget(targetId: string): TargetTrafficStatus {
    const existing = this.tracked.get(targetId);
    this.tracked.delete(targetId);

    if (existing?.workloadSource === 'USER_SIM') {
      console.log(`[TrafficController] Stopping USER_SIM for ${targetId} - delegated to environment orchestrator`);
      // Not limited to KNOWN_TRAFFIC_GEN_TARGETS: a stop must be able to
      // reach a project id traffic-gen knows but this list doesn't (e.g.
      // "vertikal-prod"). Stopping something that isn't running is a
      // harmless no-op, whereas failing to stop something that is running
      // means traffic nobody can see or halt.
    } else {
      fetch(`${TRAFFIC_GEN_URL}/api/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: targetId }),
      }).catch((e) => console.error(`[TrafficController] Failed to stop traffic-gen run for ${targetId}:`, e.message));
    }

    return {
      targetId,
      isRunning: false,
      profileName: existing?.profile || 'none',
      mode: existing?.mode,
      startTime: existing?.startTime || null,
      pid: null,
      resolvedUrl: existing?.resolvedUrl,
      workloadSource: existing?.workloadSource,
    };
  }

  /**
   * Stops every synthetic run this system can reach — not just the ones
   * this server instance started. `tracked` only holds runs started
   * through this process, so a run started directly against traffic-gen,
   * or one that outlived a server restart, used to survive "stop all" and
   * keep hitting the target with nothing in the UI admitting it. The
   * authoritative list is traffic-gen's own, so ask it.
   */
  public async stopAll(): Promise<TargetTrafficStatus[]> {
    const ids = new Set<string>(this.tracked.keys());

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${TRAFFIC_GEN_URL}/api/projects`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const projects = await res.json();
        for (const p of projects) {
          if (p?.running && p?.projectId) ids.add(p.projectId);
        }
      }
    } catch (e: any) {
      console.error('[TrafficController] Could not read traffic-gen projects during stopAll:', e.message);
    }

    const results: TargetTrafficStatus[] = [];
    for (const targetId of ids) {
      results.push(this.stopTarget(targetId));
    }
    console.log(`[TrafficController] stopAll stopped ${results.length} run(s): ${[...ids].join(', ') || 'none'}`);
    return results;
  }

  public getStatus(targetId?: string): TargetTrafficStatus[] {
    const ids = targetId && targetId !== 'all'
      ? [targetId]
      : (this.graphStore && this.graphStore.targets.size > 0 ? Array.from(this.graphStore.targets.keys()) : ['sock-shop', 'vertikal']);

    return ids.map((tId) => {
      const tracked = this.tracked.get(tId);
      const resolvedUrl = tracked?.resolvedUrl || this.resolveBaseUrl(tId) || undefined;
      return {
        targetId: tId,
        isRunning: !!tracked,
        profileName: tracked?.profile || 'baseline',
        mode: tracked?.mode || 'USER_JOURNEY',
        startTime: tracked?.startTime || null,
        pid: null,
        resolvedUrl,
        workloadSource: tracked?.workloadSource,
      };
    });
  }
}
