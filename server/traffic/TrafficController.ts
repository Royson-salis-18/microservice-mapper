import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import type { GraphStore } from '../graph/GraphStore.js';

const TRAFFIC_GEN_PORT = process.env.TRAFFIC_GEN_PORT || '4400';
const TRAFFIC_GEN_URL = `http://localhost:${TRAFFIC_GEN_PORT}`;
const TRAFFIC_GEN_WS_URL = `ws://localhost:${TRAFFIC_GEN_PORT}/ws`;

// only targets with a workflow file under traffic-gen/workflows/
// [AGY] Added 'open-telemetry' because without being in this set, 
// TrafficController actively rejects start requests with an error, 
// causing silent UI failures for the OpenTelemetry target.
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
  /**
   * SWEEP means "exercise the whole surface": every discovered HTTP endpoint
   * that a live probe just proved responds, driven as one workflow, so every
   * service produces telemetry in the same window. The per-service Isolation
   * Forest needs each service to have data; a USER_JOURNEY through the
   * frontend only lights up whatever that journey happens to touch.
   */
  mode?: 'USER_JOURNEY' | 'ENDPOINT' | 'SERVICE' | 'SWEEP';
  routeId?: string;
  serviceId?: string;
  endpointId?: string;
  overrideUrl?: string;
  authUsername?: string;
  authPassword?: string;
  /** Virtual users. Overrides the workflow profile's own default. */
  users?: number;
  /** Ceiling passed to traffic-gen; defaults to `users` there. */
  maxConcurrency?: number;
  /** Auto-stop after N seconds. traffic-gen caps this at 1800. */
  durationSec?: number;
  /**
   * Explicit target list for SWEEP. Absolute URLs are allowed (engine.js
   * uses them verbatim), which is what lets one run spread across many
   * hosts/ports instead of one baseUrl. Omitted means "probe and decide".
   */
  endpointPaths?: string[];
}

/**
 * Paths a path-routed gateway commonly exposes. These are probe hypotheses,
 * never assumptions: a path only ends up in a run because it answered.
 *
 * The /api/* entries are how the OpenTelemetry demo's Envoy frontend-proxy
 * reaches its backends — verified against a live instance, where :8080 is
 * the only open port and /api/products, /api/cart, /api/data, /api/currency
 * and /api/shipping each land on a different service.
 */
const COMMON_GATEWAY_PATHS = [
  '/api', '/api/products', '/api/cart', '/api/data', '/api/currency',
  '/api/shipping', '/api/recommendations', '/api/checkout', '/api/orders',
  '/api/users', '/api/catalogue', '/api/customers',
  '/catalogue', '/cart', '/orders', '/customers', '/category.html',
  '/health', '/healthz', '/actuator/health', '/metrics', '/status',
];

/** A URL queued for probing, before anything is known about it. */
interface ProbeCandidate {
  url: string;
  serviceName: string;
  endpointId: string;
  port: number;
}

/** One probed URL and what came back. */
export interface ProbeResult {
  url: string;
  serviceName: string;
  endpointId: string;
  port: number;
  /** The origin answered at all — the port is open and something is listening. */
  reachable: boolean;
  /** It answered AND the answer means a real handler ran (see classify()). */
  usable: boolean;
  status?: number;
  ms: number;
  error?: string;
}

export interface SurfaceReport {
  targetId: string;
  probedAt: string;
  totalCandidates: number;
  usable: ProbeResult[];
  reachableButUnusable: ProbeResult[];
  dead: ProbeResult[];
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
  /** Virtual users the run was actually started with, when specified. */
  users?: number;
  /** How many distinct URLs this run cycles through (SWEEP / ENDPOINT). */
  endpointsHit?: number;
  /** Human-readable sweep outcome, e.g. "14/31 endpoints answered". */
  sweepSummary?: string;
}

// Proxies start/stop/status to the standalone traffic-gen server instead of
// spawning the old one-shot CLI per request. traffic-gen owns the actual
// virtual users, workflows and auth; this just forwards commands and stats.
export class TrafficController {
  private graphStore?: GraphStore;
  public onStatsCallback?: (targetId: string, stats: any) => void;
  /**
   * Fires when traffic-gen ends a run on its own — durationSec elapsing, or
   * (in principle) a crash. Before durationSec was wired through from the
   * UI, every EXTERNAL/SWEEP run was unlimited and only ever ended via an
   * explicit stop, which already clears `tracked`, so this path was dead
   * code. Now that a sweep can expire by itself, without this callback
   * `tracked`/isRunning goes stale: the UI keeps reporting the run as live,
   * stats freeze, and the experiment record never closes out.
   */
  public onStoppedCallback?: (targetId: string, reason: string) => void;

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
  //
  // The in-flight promise is cleared once it settles. Caching it forever
  // meant that after traffic-gen died — which it does whenever the parent
  // server is restarted, since it's spawned as a child — every later call
  // returned the stale resolved promise and skipped the restart entirely.
  // The symptom was that traffic could never be started again: the UI
  // reported success while every proxied call failed with "fetch failed".
  private async ensureTrafficGenRunning(): Promise<void> {
    if (this.ensureStartingPromise) return this.ensureStartingPromise;

    // Already up (e.g. started by hand, or surviving from before): nothing
    // to spawn, but still make sure the stats socket is attached.
    if (await this.isTrafficGenReachable()) {
      this.connectStatsSocket();
      return;
    }

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
      // Without this, a missing `node` binary emits an unhandled 'error' that
      // throws, and genProcess stays set to a process that never ran.
      child.on('error', (err) => {
        console.error('[TrafficController] Failed to start traffic-gen:', err.message);
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

    try {
      await this.ensureStartingPromise;
    } finally {
      // Always release, success or failure, so the next call can retry.
      this.ensureStartingPromise = null;
    }
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
          } else if (msg.type === 'stopped' && msg.data?.projectId) {
            const projectId = msg.data.projectId as string;
            // Only react if we still think it's running. A stop we
            // ourselves initiated already deleted the tracked entry before
            // the request went out, so this only fires for a self-ended run.
            if (this.tracked.has(projectId)) {
              this.tracked.delete(projectId);
              console.log(`[TrafficController] ${projectId} stopped itself (traffic-gen reported 'stopped', e.g. durationSec elapsed)`);
              this.onStoppedCallback?.(projectId, 'DURATION_ELAPSED');
            }
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

  /**
   * "Find every entry point and see which ones actually work."
   *
   * Discovery reports what a container *publishes*. That is not the same as
   * what answers from here: a port can be published and still be closed in
   * the security group, bound to the wrong interface, or serving a container
   * that crash-loops. The only honest way to know is to ask.
   *
   * Two phases, because one is not enough:
   *
   *   1. ORIGINS — one request per discovered host:port. On a real target
   *      this usually eliminates most of them: measured against the
   *      OpenTelemetry demo, 19 of 20 published ports time out because only
   *      :8080 is open in the security group.
   *
   *   2. PATHS — for each origin that answered, probe the paths *behind* it.
   *      This is the phase that matters. A gateway like the demo's Envoy
   *      frontend-proxy fans one open port out to every backend service by
   *      path (/api/cart -> cart, /api/products -> product-catalog), so
   *      stopping at phase 1 would report "1 endpoint works" for a system
   *      with 25 services and generate telemetry for exactly one of them.
   *
   * Path candidates are *hypotheses* until probed: discovered routes when
   * the registry has them, otherwise conventional shapes derived from
   * discovered service names. Nothing reaches the result set on the
   * strength of its name — a URL is reported usable only because a real
   * response came back, and the status that came back is reported with it.
   */
  public async probeSurface(
    targetId: string,
    opts: { timeoutMs?: number; concurrency?: number; includeInternal?: boolean; maxProbes?: number } = {},
  ): Promise<SurfaceReport> {
    const timeoutMs = opts.timeoutMs ?? 6000;
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 16));
    const maxProbes = Math.max(10, Math.min(opts.maxProbes ?? 160, 400));
    const probedAt = new Date().toISOString();

    // --- phase 1: which origins answer at all ---
    const origins = this.buildCandidates(targetId, opts.includeInternal === true);
    const originResults = await this.probeAll(origins, timeoutMs, concurrency);
    const liveOrigins = originResults.filter((r) => r.reachable);

    // --- phase 2: what lives behind the ones that do ---
    const hypotheses = this.pathHypotheses(targetId, await this.declaredWorkflowPaths(targetId));
    const pathCandidates: ProbeCandidate[] = [];
    const seen = new Set(originResults.map((r) => r.url));
    outer: for (const origin of liveOrigins) {
      const base = origin.url.replace(/\/$/, '');
      for (const p of hypotheses) {
        const url = `${base}${p}`;
        if (seen.has(url)) continue;
        seen.add(url);
        pathCandidates.push({ url, serviceName: `${origin.serviceName} ${p}`, endpointId: origin.endpointId, port: origin.port });
        if (pathCandidates.length >= maxProbes) break outer;
      }
    }
    const pathResults = await this.probeAll(pathCandidates, timeoutMs, concurrency);

    const results = [...originResults, ...pathResults];
    results.sort((a, b) => a.url.localeCompare(b.url));

    const report: SurfaceReport = {
      targetId,
      probedAt,
      totalCandidates: results.length,
      usable: results.filter((r) => r.usable),
      reachableButUnusable: results.filter((r) => r.reachable && !r.usable),
      dead: results.filter((r) => !r.reachable),
    };
    console.log(
      `[TrafficController] probeSurface ${targetId}: ${origins.length} origins -> ${liveOrigins.length} live; ` +
      `${pathCandidates.length} paths probed; ${report.usable.length} usable / ` +
      `${report.reachableButUnusable.length} answered-but-unusable / ${report.dead.length} dead`,
    );
    return report;
  }

  /**
   * The GET paths this target's traffic-gen workflows declare.
   *
   * Declared evidence, not inference — the same standard the graph holds
   * itself to. The probe then decides whether each one actually answers, so
   * a stale workflow path is dropped rather than trusted.
   */
  private async declaredWorkflowPaths(targetId: string): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${TRAFFIC_GEN_URL}/api/targets/${encodeURIComponent(targetId)}/paths`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      const body = await res.json();
      return Array.isArray(body?.paths) ? body.paths.filter((p: unknown): p is string => typeof p === 'string') : [];
    } catch {
      // traffic-gen being unreachable is not a reason to fail the probe;
      // it just means falling back to the generic hypotheses.
      return [];
    }
  }

  /** Bounded fan-out. Firing 60 requests at once at a 2GB box measures the
   * box's accept queue, not its endpoints. */
  private async probeAll(candidates: ProbeCandidate[], timeoutMs: number, concurrency: number): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const item = candidates[cursor++];
        results.push(await this.probeOne(item, timeoutMs));
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Paths worth trying behind a live origin, best evidence first.
   *
   * Discovered routes come first because they are declared facts read out
   * of the target (nginx/Envoy config, compose files, OpenAPI). When the
   * registry has none — the normal state before any traffic has ever run,
   * since routes are also learned *from* traffic — fall back to shapes
   * built from the service names discovery did find, plus the handful of
   * conventional ones a path-routed gateway almost always answers.
   *
   * Every one of these is a guess. That is acceptable only because each is
   * then probed: a guess that 404s is dropped, and nothing generates load
   * unless a real response came back from it first.
   */
  private pathHypotheses(targetId: string, declaredPaths: string[] = []): string[] {
    const paths: string[] = ['/'];
    const add = (p: string) => {
      if (!p) return;
      const norm = p.startsWith('/') ? p : `/${p}`;
      if (!paths.includes(norm)) paths.push(norm);
    };

    // First, because these are not guesses: they were written against the
    // real system in its workflow file. Without them a sweep of
    // DeathStarBench found 2 usable URLs out of 53 — its API is
    // /wrk2-api/*, and every conventional path 404s.
    for (const p of declaredPaths) add(p);

    if (this.graphStore) {
      for (const route of this.graphStore.endpointRegistry.getRoutes(targetId)) {
        // Only GET is safe to fire blindly at a system nobody has mapped yet.
        if (route.method === 'GET' || route.method === 'ANY') add(route.path);
      }
      for (const svc of this.graphStore.endpointRegistry.getServices(targetId)) {
        add(`/api/${svc.name}`);
      }
    }

    for (const p of COMMON_GATEWAY_PATHS) add(p);
    return paths;
  }

  /** Every discovered HTTP(S) endpoint, as an absolute URL, deduplicated. */
  private buildCandidates(targetId: string, includeInternal: boolean): ProbeCandidate[] {
    const out: ProbeCandidate[] = [];
    const seen = new Set<string>();

    const push = (url: string, serviceName: string, endpointId: string, port: number) => {
      const key = url.replace(/\/$/, '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ url: key, serviceName, endpointId, port });
    };

    // The pinned/resolved entry point always gets probed, even if discovery
    // never produced an endpoint record for it — it is the one URL the
    // operator asserted is real.
    const primary = this.resolveBaseUrl(targetId);
    if (primary) push(primary, 'configured-entry-point', 'pinned', this.portOf(primary));

    if (!this.graphStore) return out;

    const target = this.graphStore.targets.get(targetId);
    const fallbackHost = target?.host && target.host !== 'unknown' ? target.host : undefined;

    for (const ep of this.graphStore.endpointRegistry.getEndpoints(targetId)) {
      if (ep.protocol !== 'HTTP' && ep.protocol !== 'HTTPS') continue;
      if (!includeInternal && ep.type !== 'PUBLIC') continue;

      // An INTERNAL endpoint's host is a container IP that means nothing
      // from here; a PUBLIC one may still carry a placeholder host.
      let host = ep.host;
      if (!host || host === 'unknown' || host === 'AWS-EC2-Public-IP' || ep.type !== 'PUBLIC') {
        host = fallbackHost || '';
      }
      if (!host) continue;

      const proto = ep.protocol.toLowerCase();
      const portStr = (ep.port === 80 && proto === 'http') || (ep.port === 443 && proto === 'https') ? '' : `:${ep.port}`;
      push(`${proto}://${host}${portStr}${ep.basePath || ''}`, ep.serviceName, ep.endpointId, ep.port);
    }

    return out;
  }

  private portOf(url: string): number {
    try {
      const u = new URL(url);
      return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch {
      return 0;
    }
  }

  private async probeOne(item: ProbeCandidate, timeoutMs: number): Promise<ProbeResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(item.url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'microservice-mapper/probe' },
      });
      clearTimeout(timer);
      return { ...item, reachable: true, usable: this.classify(res.status), status: res.status, ms: Date.now() - started };
    } catch (e: any) {
      clearTimeout(timer);
      return {
        ...item,
        reachable: false,
        usable: false,
        ms: Date.now() - started,
        error: e?.name === 'AbortError' ? `no response in ${timeoutMs}ms` : (e?.cause?.code || e?.message || 'request failed'),
      };
    }
  }

  /**
   * Is this status worth generating load against?
   *
   * 2xx/3xx: obviously. 401/403: a real auth handler ran, so the service is
   * doing work and emitting telemetry — exactly what the per-service model
   * needs. 405/429: routed and handled, just not by GET / not right now.
   * 404: the origin is alive but this path isn't a route, so hammering it
   * measures the router, not the service. 5xx: keep it — a service that is
   * failing is the most interesting thing an RCA run can observe.
   */
  private classify(status: number): boolean {
    if (status >= 200 && status < 400) return true;
    if (status === 401 || status === 403 || status === 405 || status === 429) return true;
    if (status >= 500) return true;
    return false;
  }

  // Async on purpose. This used to fire the start request and immediately
  // return isRunning:true, so a refusal from traffic-gen (a STUB target, a
  // 409, or the process being down) was logged to the server console while
  // the UI cheerfully reported success and nothing actually ran. The caller
  // now gets the real outcome.
  public async startTarget(targetId: string, options: TargetTrafficOptions & { workloadSource?: 'EXTERNAL' | 'USER_SIM' } = {}): Promise<TargetTrafficStatus> {
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

    // What the run will actually hit, in priority order:
    //   1. an explicit list from the caller (already probed in the UI)
    //   2. SWEEP: probe the whole surface now and take what answers
    //   3. ENDPOINT: the single route the operator picked
    //   4. '/' against the resolved base URL
    let endpointPaths: string[] | undefined;
    let sweepSummary: string | undefined;

    if (options.endpointPaths && options.endpointPaths.length > 0) {
      endpointPaths = options.endpointPaths;
    } else if (mode === 'SWEEP') {
      const report = await this.probeSurface(targetId);
      endpointPaths = report.usable.map((r) => r.url);
      sweepSummary = `${report.usable.length}/${report.totalCandidates} endpoints answered`;
      if (endpointPaths.length === 0) {
        this.tracked.delete(targetId);
        const detail = report.dead.slice(0, 3).map((d) => `${d.url} (${d.error})`).join('; ');
        return {
          targetId, isRunning: false, profileName: profile, mode, startTime: null, pid: null, resolvedUrl, workloadSource,
          error: `sweep found no responding endpoints out of ${report.totalCandidates} candidates${detail ? ` — e.g. ${detail}` : ''}`,
        };
      }
    } else if (mode === 'ENDPOINT' && options.routeId) {
      endpointPaths = [this.toPath(options.routeId)];
    }

    const body: Record<string, unknown> = {
      targetId,
      projectId: targetId,
      baseUrl: resolvedUrl,
      profile: PROFILE_MAP[profile.toLowerCase()] || 'BASELINE',
      authUsername: options.authUsername || DEFAULT_AUTH.username,
      authPassword: options.authPassword || DEFAULT_AUTH.password,
    };
    // Only send these when set, so an unset field still falls back to the
    // workflow profile's own default rather than to 0/undefined.
    if (typeof options.users === 'number' && options.users > 0) body.users = Math.floor(options.users);
    if (typeof options.maxConcurrency === 'number' && options.maxConcurrency > 0) body.maxConcurrency = Math.floor(options.maxConcurrency);
    if (typeof options.durationSec === 'number' && options.durationSec > 0) body.durationSec = Math.floor(options.durationSec);

    if (useDiscoveredEndpoints) {
      body.useDiscoveredEndpoints = true;
      body.endpointPaths = endpointPaths && endpointPaths.length > 0 ? endpointPaths : ['/'];
    }

    const failed = (error: string): TargetTrafficStatus => {
      this.tracked.delete(targetId);
      console.error(`[TrafficController] ${targetId}: ${error}`);
      return { targetId, isRunning: false, profileName: profile, mode, routeId: options.routeId, serviceId: options.serviceId, endpointId, startTime: null, pid: null, resolvedUrl, workloadSource, error };
    };

    try {
      await this.ensureTrafficGenRunning();
      const res = await fetch(`${TRAFFIC_GEN_URL}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        return failed(`traffic-gen refused to start: ${err.error || `HTTP ${res.status}`}`);
      }
      console.log(`[TrafficController] traffic-gen started for ${targetId} -> ${resolvedUrl} (profile=${body.profile}, users=${body.users ?? 'profile default'}${sweepSummary ? `, sweep: ${sweepSummary}` : ''})`);
    } catch (e: any) {
      return failed(`could not reach traffic-gen: ${e.message}`);
    }

    return {
      targetId, isRunning: true, profileName: profile, mode, routeId: options.routeId, serviceId: options.serviceId,
      endpointId, startTime, pid: null, resolvedUrl, workloadSource,
      users: typeof body.users === 'number' ? (body.users as number) : undefined,
      endpointsHit: endpointPaths?.length,
      sweepSummary,
    };
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
