import fs from 'fs';
import path from 'path';
import os from 'os';
import { EndpointRegistry } from '../registry/EndpointRegistry.js';
import type { DiscoveredService, DiscoveredEndpoint } from '../models/EndpointModels.js';
import type { WebSocketManager } from '../api/websocket.js';

// Import from the new agentless telemetry platform
import { ConnectionManager } from '../telemetry-platform/src/connection/ConnectionManager.js';
import { DiscoveryEngine } from '../telemetry-platform/src/discovery/DiscoveryEngine.js';
import { MetricCollector } from '../telemetry-platform/src/collection/MetricCollector.js';
import { REMOTE_COMMANDS } from '../telemetry-platform/src/connection/RemoteCommand.js';
import type { TargetConfig } from '../telemetry-platform/src/types/target.js';
import { PrometheusSource } from '../telemetry-sources/PrometheusSource.js';
import type { ServiceRequestMetrics, TelemetrySourceConfig } from '../telemetry-sources/TelemetrySource.js';
import { provenance } from '../models/MetricProvenance.js';

/**
 * Containers that exist to produce load. These are never auto-restarted:
 * traffic has to be startable and stoppable from the traffic controller, and
 * a load generator quietly revived by a reconnect is load nobody can see in
 * the UI or stop from it. Observed on sock-shop as `docker-compose-user-sim-1`
 * (Exited 137) and `sock-shop-stress-1` (Exited 0).
 */
const LOAD_GENERATOR_NAMES = /(user-sim|usersim|load-?gen|loadgen|loadgenerator|locust|k6|jmeter|gatling|stress|bench|wrk2?\b|siege|vegeta|artillery)/i;

/** Restart attempts per container per session before giving up on it. */
const MAX_RESTART_ATTEMPTS = 2;

class TargetAgent {
  private targetId: string;
  private tConf: any;
  private wsManager?: WebSocketManager;
  private registry: EndpointRegistry;
  private onTopologyDiscovered?: (targetId: string, services: any[], dependencies: any[]) => void;
  private onTelemetryCollected?: (targetId: string, envelope: any) => void;

  private connManager: ConnectionManager | null = null;
  // separate connection for on-demand requests (log fetches) so they don't
  // compete with the polling loops for channels on the main connection
  private adHocConnManager: ConnectionManager | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private rediscoveryTimer: NodeJS.Timeout | null = null;
  private recovering = false;
  private dead = false;
  private discoveredServices: any[] = [];
  /** Telemetry warnings already announced, so a permanently-failing service
   *  is reported once rather than every collection cycle. */
  private seenWarnings = new Set<string>();
  /** Restarts attempted per container name, so a crash-looping service is
   *  not restarted indefinitely. */
  private restartAttempts = new Map<string, number>();
  /** Tier 2 source, created once if this target opts in. */
  private prometheus: PrometheusSource | null = null;
  private prometheusChecked = false;
  private prometheusUnavailableReason: string | null = null;

  constructor(
    targetId: string,
    tConf: any,
    registry: EndpointRegistry,
    wsManager: WebSocketManager | undefined,
    onTopologyDiscovered: ((targetId: string, services: any[], dependencies: any[]) => void) | undefined,
    onTelemetryCollected: ((targetId: string, envelope: any) => void) | undefined
  ) {
    this.targetId = targetId;
    this.tConf = tConf;
    this.registry = registry;
    this.wsManager = wsManager;
    this.onTopologyDiscovered = onTopologyDiscovered;
    this.onTelemetryCollected = onTelemetryCollected;
  }

  private get ec2Ip(): string { return this.tConf.ec2PublicIp; }
  private get sshUser(): string { return this.tConf.sshUsername || 'ubuntu'; }
  private get sshKeyPath(): string {
    let p = this.tConf.sshKeyPath || '';
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    return p;
  }

  private log(msg: string) {
    console.log(msg);
    if (this.wsManager) this.wsManager.broadcast('TERMINAL_LOG', msg);
  }

  private createTargetConfig(): TargetConfig {
    return {
      schemaVersion: "1.0",
      id: this.targetId,
      name: this.tConf.displayName || this.targetId,
      environment: 'aws',
      region: 'unknown',
      connection: {
        type: 'ssh',
        host: this.ec2Ip,
        port: 22,
        username: this.sshUser,
        privateKeyPath: this.sshKeyPath,
        readyTimeoutMs: 15000,
      } as any,
      application: {
        adapter: 'default',
        knownServices: [],
      },
      collector: {
        intervalSeconds: 5,
        logLookbackSeconds: 30,
        windowSeconds: 5,
        logTailLines: 500,
      },
      storage: {
        outputDirectory: path.join(process.cwd(), 'data', this.targetId),
      },
    };
  }

  async start() {
    if (this.dead) return;
    this.log(`\n[Agent:${this.targetId}] Starting agentless automation for ${this.sshUser}@${this.ec2Ip}...`);
    this.connManager = new ConnectionManager(this.createTargetConfig());
    await this.runCycle();
  }

  stop() {
    this.dead = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.connectionTimer) clearInterval(this.connectionTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.rediscoveryTimer) clearInterval(this.rediscoveryTimer);
    if (this.connManager) this.connManager.close().catch(() => {});
    if (this.adHocConnManager) this.adHocConnManager.close().catch(() => {});
  }

  async getServiceLogs(containerId: string, tailLines: number): Promise<string[]> {
    if (this.dead) return [];
    if (!this.adHocConnManager) {
      this.adHocConnManager = new ConnectionManager(this.createTargetConfig());
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cmd = REMOTE_COMMANDS.dockerLogs(containerId, since, tailLines);

    // a burst of concurrent requests can still hit sshd's channel cap even
    // on the dedicated connection, so retry with backoff before giving up
    const maxAttempts = 5;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const conn = await this.adHocConnManager.getConnection();
        const res = await conn.execute(cmd);
        if (res.exitCode !== 0 || res.error) {
          throw new Error(res.error ?? res.stderr ?? 'docker logs failed');
        }
        // stdout/stderr come back as separate streams and some services
        // (Go, some JVM loggers) only log to stderr, so merge + re-sort by
        // the --timestamps prefix to get them back in order
        const merged = [...res.stdout.split('\n'), ...res.stderr.split('\n')]
          .filter((l) => l.length > 0)
          .sort();
        return merged.slice(-tailLines);
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // Re-runs docker-ps-based discovery against the current connection and
  // updates registry/graph state. Used both for the initial cycle and for
  // periodic re-discovery, so containers that start after the first scan
  // (previously stuck as unmatched "unknown-<hash>" metric samples) get
  // picked up and correctly named/classified/edged.
  private async refreshDiscovery(conn: any): Promise<number> {
    this.log(`[Agent:${this.targetId}] Discovering architecture...`);
    const engine = new DiscoveryEngine(this.targetId, conn);
    const result = await engine.discover();

    if (result.architecture.warnings && result.architecture.warnings.length > 0) {
      for (const warn of result.architecture.warnings) {
        this.log(`[Agent:${this.targetId}] Discovery warning: ${warn}`);
      }
    }

    // A transient SSH/channel hiccup (this host is resource-constrained and
    // known to drop `docker` commands under load) makes discover() return an
    // empty service list without throwing. On the *initial* cycle that's the
    // real state and we take it as-is; on a periodic rescan, overwriting a
    // known-good service list with an empty one would wipe every already-
    // matched service back to "unknown-<hash>" until the next reconnect —
    // so keep the last known-good list and let the next rescan retry.
    if (result.services.length === 0 && this.discoveredServices.length > 0) {
      this.log(`[Agent:${this.targetId}] Re-discovery returned 0 services — keeping previous ${this.discoveredServices.length} (likely a transient SSH hiccup, will retry).`);
      return this.discoveredServices.length;
    }

    this.discoveredServices = result.services;
    const nowIso = new Date().toISOString();

      // Register services in endpoint registry
      for (const svc of result.services) {
        if (svc.name.includes('mapper-collector')) continue;
        const discoveredService: DiscoveredService = {
          serviceId: svc.serviceId,
          targetId: this.targetId,
          name: svc.name,
          status: 'healthy', // State is handled downstream via telemetry
          ports: svc.ports.length > 0 ? svc.ports.map(p => (p as any).containerPort) : [80],
          protocols: ['HTTP'],
          labels: { project: this.targetId, discoveredBy: 'telemetry-platform' },
          lastSeen: nowIso,
        };
        this.registry.registerService(discoveredService);

        const isPublic = svc.ports.some(p => (p as any).hostPort !== undefined);
        const port0 = svc.ports.length > 0 ? (svc.ports[0] as any).containerPort : 80;
        const endpointId = EndpointRegistry.makeEndpointId(this.targetId, svc.name, 'HTTP', port0);
        const discoveredEndpoint: DiscoveredEndpoint = {
          endpointId,
          targetId: this.targetId,
          serviceId: svc.serviceId,
          serviceName: svc.name,
          host: isPublic ? this.ec2Ip : `${svc.name}.internal`,
          port: port0,
          protocol: 'HTTP',
          type: isPublic ? 'PUBLIC' : 'INTERNAL',
          source: 'docker',
          discoveryMethod: 'compose-config',
          reachable: isPublic,
          lastChecked: nowIso,
        };
        this.registry.registerEndpoint(discoveredEndpoint);
      }

      // Format dependencies for GraphStore
      const formattedDeps = result.dependencies.map(dep => ({
        sourceServiceId: dep.sourceServiceId,
        targetServiceId: dep.targetServiceId,
        declared: dep.declared,
        observed: dep.observed,
        evidenceSources: dep.evidenceSources
      }));

      // Map services for GraphStore
      const formattedServices = result.services.map(svc => ({
        serviceId: svc.serviceId,
        name: svc.name,
        type: svc.type,
        containerId: svc.containerId,
        image: svc.image,
        ports: svc.ports,
        state: 'running'
      }));

      if (this.onTopologyDiscovered) {
        this.onTopologyDiscovered(this.targetId, formattedServices, formattedDeps);
      }
      this.log(`[Agent:${this.targetId}] Discovery done — ${result.services.length} services found.`);
      return result.services.length;
  }

  private async runCycle() {
    if (this.dead) return;
    try {
      this.log(`[Agent:${this.targetId}] Establishing SSH connection...`);
      const conn = await this.connManager!.getConnection();

      // Before discovery, so anything brought back is discovered as part of
      // this cycle rather than waiting for the next one.
      await this.restartCrashedContainers(conn);

      await this.refreshDiscovery(conn);

      // Start continuous metric polling
      this.recovering = false;
      await this.startPolling(conn);

    } catch (err: any) {
      this.scheduleRecovery(`Cycle failed: ${err.message}`);
    }
  }

  /**
   * Bring back containers that crashed, once per fresh SSH connection.
   *
   * Stress runs kill services on these small hosts and they stay dead, so
   * the next session maps a system with holes in it. This restarts them on
   * reconnect — deliberately on reconnect only, never mid-run: an
   * experiment that silently repaired what it was measuring would destroy
   * the failure the RCA pipeline exists to observe.
   *
   * Four things are never restarted:
   *
   *   - Exit code 0. That is a job that finished, not a crash — sock-shop's
   *     `sock-shop-stress-1` has sat at "Exited (0)" for six days and
   *     restarting it would re-run a stress job nobody asked for.
   *   - Anything that generates load (see LOAD_GENERATOR_NAMES). Reviving
   *     `docker-compose-user-sim-1` would resurrect synthetic traffic
   *     outside the traffic controller, i.e. load with no way to see or
   *     stop it from the UI.
   *   - "created" containers, which never ran at all. sock-shop carries ~15
   *     of these as leftovers from failed `docker run` attempts; starting
   *     them would add services the stack was never meant to have.
   *   - Anything already retried MAX_RESTART_ATTEMPTS times, so a
   *     crash-looping container is not restarted forever.
   */
  private async restartCrashedContainers(conn: any): Promise<void> {
    if (process.env.MAPPER_AUTO_RESTART === 'off') return;

    const res = await conn.execute(REMOTE_COMMANDS.dockerPsAll()).catch((e: any) => ({
      exitCode: null, error: e?.message, stdout: '',
    }));
    if (res.exitCode !== 0 || res.error || !res.stdout?.trim()) {
      // A host too loaded to answer `docker ps -a` is exactly the host that
      // should not be asked to start more containers.
      this.log(`[Agent:${this.targetId}] Auto-restart skipped: could not list containers (${res.error ?? `exit ${res.exitCode}`}).`);
      return;
    }

    const crashed: Array<{ name: string; code: number; status: string }> = [];
    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }

      const state = String(row.State ?? '').toLowerCase();
      if (state !== 'exited' && state !== 'dead') continue;

      const name = String(row.Names ?? '').split(',')[0].trim();
      if (!name) continue;

      // "Exited (137) 6 days ago" — the code is the whole signal here, and
      // it is already in the listing, so this needs no extra inspect call.
      const match = /Exited \((\d+)\)/.exec(String(row.Status ?? ''));
      const code = match ? Number(match[1]) : -1;
      if (code === 0) continue;

      if (LOAD_GENERATOR_NAMES.test(name)) {
        this.log(`[Agent:${this.targetId}] Not restarting ${name} (exit ${code}) — it generates load, and traffic must only ever start from the traffic controller.`);
        continue;
      }

      const attempts = this.restartAttempts.get(name) ?? 0;
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        this.log(`[Agent:${this.targetId}] Not restarting ${name} again — already tried ${attempts}x this session; it is crash-looping and needs a look.`);
        continue;
      }

      crashed.push({ name, code, status: String(row.Status ?? '') });
    }

    if (crashed.length === 0) return;

    this.log(`[Agent:${this.targetId}] Found ${crashed.length} crashed container(s); restarting…`);
    for (const c of crashed) {
      this.restartAttempts.set(c.name, (this.restartAttempts.get(c.name) ?? 0) + 1);
      const start = await conn.execute(REMOTE_COMMANDS.dockerStart(c.name)).catch((e: any) => ({
        exitCode: null, error: e?.message, stdout: '',
      }));
      if (start.exitCode === 0 && !start.error) {
        this.log(`[Agent:${this.targetId}] Restarted ${c.name} (was ${c.status}).`);
      } else {
        this.log(`[Agent:${this.targetId}] Could not restart ${c.name}: ${(start.stdout || start.error || '').trim().slice(0, 160)}`);
      }
    }
  }

  /**
   * Tier 2 request metrics, if this target has a source configured.
   *
   * Everything here is best-effort and wrapped: an optional source that is
   * slow, broken or lying must never cost us the Tier 0 metrics already in
   * hand. The agentless path is the one that has to keep working — this only
   * ever adds fields to it.
   *
   * Opt-in per target via `telemetrySources.prometheus` in
   * remote_config.json. A reachable Prometheus is not on its own consent to
   * query it on a loop.
   */
  private async collectRequestMetrics(conn: any): Promise<Map<string, ServiceRequestMetrics>> {
    const empty = new Map<string, ServiceRequestMetrics>();
    const sources: TelemetrySourceConfig | undefined = this.tConf?.telemetrySources;
    const promCfg = sources?.prometheus;
    if (!promCfg?.enabled) return empty;

    try {
      if (!this.prometheus) {
        // Runs on the target: Prometheus is bound to localhost there and
        // only :8080 is open externally, so querying from here would mean
        // asking someone to open a port to read a metric.
        const exec = async (command: string): Promise<string> => {
          const res = await conn.execute({
            name: 'prometheus.query',
            command,
            timeoutMs: 15_000,
            maxOutputBytes: 262_144,
          });
          if (res.error) throw new Error(res.error);
          return res.stdout ?? '';
        };
        this.prometheus = new PrometheusSource(this.targetId, exec, promCfg.url || 'http://localhost:9090');
      }

      if (!this.prometheusChecked) {
        const status = await this.prometheus.probe();
        this.prometheusChecked = true;
        if (!status.available) {
          this.prometheusUnavailableReason = status.reason ?? 'unavailable';
          this.log(`[Agent:${this.targetId}] Tier 2 (Prometheus) unavailable: ${this.prometheusUnavailableReason}`);
          return empty;
        }
        this.log(`[Agent:${this.targetId}] Tier 2 (Prometheus) available — per-request latency and error rates enabled.`);
      }
      if (this.prometheusUnavailableReason) return empty;

      const snapshot = await this.prometheus.collect(300);
      for (const warn of snapshot.warnings) {
        if (this.seenWarnings.has(warn)) continue;
        this.seenWarnings.add(warn);
        this.log(`[Agent:${this.targetId}] Tier 2 warning: ${warn}`);
      }

      const out = new Map<string, ServiceRequestMetrics>();
      for (const svc of snapshot.services) out.set(svc.serviceName, svc);
      return out;
    } catch (e: any) {
      const msg = `Tier 2 collection failed: ${e?.message ?? e}`;
      if (!this.seenWarnings.has(msg)) {
        this.seenWarnings.add(msg);
        this.log(`[Agent:${this.targetId}] ${msg}`);
      }
      return empty;
    }
  }

  private scheduleRecovery(reason: string): void {
    if (this.dead || this.recovering) return;
    this.recovering = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.connectionTimer) clearInterval(this.connectionTimer);
    if (this.rediscoveryTimer) clearInterval(this.rediscoveryTimer);
    this.pollTimer = null;
    this.connectionTimer = null;
    this.rediscoveryTimer = null;
    this.log(`[Agent:${this.targetId}] ${reason}. Reconnecting in 10s…`);
    this.connManager?.close().catch(() => {});
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.runCycle().catch(() => {});
    }, 10_000);
  }

  private async startPolling(conn: any) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    
    const collector = new MetricCollector(this.targetId, conn);

    const poll = async () => {
      if (this.dead) return;
      
      let currentConn: any;
      try {
        currentConn = await this.connManager!.getConnection();
      } catch (e: any) {
        this.scheduleRecovery(`Connection lost: ${e.message}`);
        return;
      }

      try {
        collector.setConnection(currentConn);
        const metricsRes = await collector.collectOnce(this.discoveredServices);
        // These used to be dropped on the floor here — the block was an
        // empty `// Log warnings but continue`. That is the other half of
        // why a permanent TCP-scan failure went unnoticed for so long: the
        // collector dutifully reported it every 5s and nothing ever printed
        // it. Deduplicated because a genuinely broken service fails on
        // every single sweep, and an unthrottled warning would bury the log
        // rather than inform it — so each distinct message is announced
        // once, then again only if it stops and recurs.
        for (const warn of metricsRes.warnings) {
          if (this.seenWarnings.has(warn)) continue;
          this.seenWarnings.add(warn);
          this.log(`[Agent:${this.targetId}] Telemetry warning: ${warn}`);
        }
        for (const seen of this.seenWarnings) {
          if (!metricsRes.warnings.includes(seen)) this.seenWarnings.delete(seen);
        }

        // Tier 2, if this target has a source configured and it is usable.
        // Wrapped so that a failing optional source can never cost us the
        // Tier 0 metrics we already have in hand — the agentless path is the
        // one that has to keep working.
        const requestMetrics = await this.collectRequestMetrics(currentConn);

        if (this.onTelemetryCollected && (metricsRes.samples.length > 0 || metricsRes.observedEdges.length > 0 || metricsRes.interactions.length > 0 || metricsRes.connectionEvents.length > 0)) {
          const envelope = this.translateMetricsToEnvelope(
            metricsRes.samples, metricsRes.observedEdges, metricsRes.interactions,
            metricsRes.connectionEvents, requestMetrics,
          );
          this.onTelemetryCollected(this.targetId, envelope);
        }
      } catch (e: any) {
        this.scheduleRecovery(`Polling error: ${e.message}`);
      }
    };

    await poll();
    if (this.dead || this.recovering) return;

    /**
     * Self-scheduling rather than setInterval, because `poll` is async and
     * a cycle takes far longer than the interval.
     *
     * setInterval(poll, 5000) fires every 5s whether or not the previous
     * poll has finished. One poll walks every discovered service with a
     * separate SSH exec each (25 services on the OpenTelemetry demo, some
     * taking seconds, some timing out at 10s), so cycles stacked up and ran
     * concurrently. Each overlapping cycle holds its own SSH channels, and
     * once they exceed the server's MaxSessions (OpenSSH default 10) every
     * further exec is refused with "(SSH) Channel open failure: open
     * failed" — measured at ~2.6 refused scans per cycle across all three
     * targets, i.e. a steady fraction of every sweep's services silently
     * going unscanned, which is exactly the coverage gap that made the
     * graph look patchy.
     *
     * Waiting 5s *after* a cycle ends means only ever one in flight.
     */
    const scheduleNext = () => {
      if (this.dead || this.recovering) return;
      this.pollTimer = setTimeout(async () => {
        await poll();
        scheduleNext();
      }, 5000);
    };
    scheduleNext();

    // Containers that start after the initial scan (e.g. a compose stack
    // still coming up, or a service that restarted onto a new container id)
    // would otherwise sit forever as unmatched "unknown-<hash>" metric
    // samples with no type/edges — rescan periodically so they get named,
    // classified, and connected properly. A full rescan is a docker-ps
    // plus one docker-inspect per container, much heavier than the 1s/5s
    // polling commands, so on an already resource-constrained host this
    // needs a long interval to avoid tipping SSH channel usage over the
    // edge (observed directly: frequent rescans here caused "Channel open
    // failure" errors across the whole connection, not just rediscovery).
    if (this.rediscoveryTimer) clearInterval(this.rediscoveryTimer);
    this.rediscoveryTimer = setInterval(async () => {
      if (this.dead || this.recovering) return;
      try {
        const currentConn = await this.connManager!.getConnection();
        await this.refreshDiscovery(currentConn);
      } catch (e: any) {
        this.log(`[Agent:${this.targetId}] Re-discovery failed (will retry next cycle): ${e.message}`);
      }
    }, 180_000);

    this.connectionTimer = setInterval(async () => {
      if (this.dead || !this.onTelemetryCollected) return;
      try {
        const currentConn = await this.connManager!.getConnection();
        collector.setConnection(currentConn);
        const { observedEdges, connectionEvents } = await collector.collectObservedEdges(this.discoveredServices);
        if (observedEdges.length > 0 || connectionEvents.length > 0) {
          this.onTelemetryCollected(this.targetId, this.translateMetricsToEnvelope([], observedEdges, [], connectionEvents));
        }
      } catch (e: any) {
        this.scheduleRecovery(`Connection scan failed: ${e.message}`);
      }
      // One `docker exec` per container per tick, so this is the heaviest
      // recurring cost we impose on the target — at 1s on an 18-container
      // host that was ~18 process spawns per second against a daemon already
      // struggling. 5s costs us almost nothing in coverage because TIME_WAIT
      // lingers ~60s, which is exactly why that state is counted.
    }, 5000);
  }

  private translateMetricsToEnvelope(
    samples: any[],
    observedEdges: any[],
    interactions: any[],
    connectionEvents: any[] = [],
    requestMetrics: Map<string, ServiceRequestMetrics> = new Map(),
  ): any {
    const observedAt = new Date().toISOString();
    const nodes = samples.map(s => {
      let status = 'healthy';
      if ((s.cpuPercent || 0) > 80 || (s.memoryPercent || 0) > 80) status = 'degraded';
      
      // Need to derive a clean name for GraphStore from serviceId
      const cleanName = s.serviceId.includes(':') ? s.serviceId.split(':')[1] : s.serviceId;

      // Tier 2, when the target publishes it. Absent means absent: these
      // fields stay undefined rather than being zero-filled, because
      // "0 ms latency" and "no measurement" are entirely different claims.
      const req = requestMetrics.get(cleanName);
      const requestLevel = req
        ? {
            latency: req.latencyP95Ms ?? null,
            latencyP50: req.latencyP50Ms ?? null,
            latencyP95: req.latencyP95Ms ?? null,
            latencyP99: req.latencyP99Ms ?? null,
            requestRate: req.requestRate ?? null,
            errorRate: req.errorRate ?? null,
            provenance: provenance('prometheus', req.detail, observedAt),
          }
        : undefined;

      return {
        id: s.serviceId,
        name: cleanName,
        project: this.targetId,
        status,
        metadata: { state: 'running' },
        ...(requestLevel ? { requestMetrics: requestLevel } : {}),
      };
    });

    const metrics = samples.map(s => ({
      nodeId: s.serviceId,
      snapshot: {
        timestamp: s.timestamp,
        cpu: s.cpuPercent || 0,
        memory: s.memoryBytes || 0,
        memoryPercent: s.memoryPercent || 0,
        networkRx: s.networkRxBytes || 0,
        networkTx: s.networkTxBytes || 0
      }
    }));

    return {
      schemaVersion: '1.0',
      targetId: this.targetId,
      timestamp: new Date().toISOString(),
      events: { nodes, metrics, connectionEvents, edges: observedEdges.map((edge) => ({
        ...edge,
        id: `${edge.source}->${edge.target}`,
        type: 'dependency',
        declared: false,
        observed: true,
        firstSeen: observedAt,
        lastSeen: observedAt,
        status: 'active',
        metrics: null,
      })), interactions: interactions.map((interaction) => ({
        id: `${interaction.sourceServiceId}->${interaction.targetServiceId}:${interaction.timestamp}`,
        timestamp: interaction.timestamp,
        source: interaction.sourceServiceId,
        target: interaction.targetServiceId,
        protocol: interaction.protocol,
        method: interaction.method ?? null,
        route: interaction.route ?? null,
        statusCode: interaction.statusCode ?? null,
        latencyMs: interaction.latencyMs ?? null,
        bytesSent: interaction.bytesSent ?? null,
        bytesReceived: interaction.bytesReceived ?? null,
        success: interaction.statusCode == null ? null : interaction.statusCode < 400,
        evidenceSource: interaction.evidenceSource,
      })) }
    };
  }
}

export class EndpointDiscoveryEngine {
  private registry: EndpointRegistry;
  private wsManager?: WebSocketManager;
  private getTargetHost?: (targetId: string) => string | undefined;
  private onTopologyDiscovered?: (targetId: string, services: any[], dependencies: any[]) => void;
  private onTelemetryCollected?: (targetId: string, envelope: any) => void;
  private agents = new Map<string, TargetAgent>();
  private starting = new Set<string>();

  constructor(
    registry: EndpointRegistry,
    wsManager?: WebSocketManager,
    getTargetHost?: (targetId: string) => string | undefined,
    onTopologyDiscovered?: (targetId: string, services: any[], dependencies: any[]) => void,
    onTelemetryCollected?: (targetId: string, envelope: any) => void
  ) {
    this.registry = registry;
    this.wsManager = wsManager;
    this.getTargetHost = getTargetHost;
    this.onTopologyDiscovered = onTopologyDiscovered;
    this.onTelemetryCollected = onTelemetryCollected;
  }

  public async discoverAll(): Promise<void> {
    const configPath = path.join(process.cwd(), 'data', 'remote_config.json');
    if (!fs.existsSync(configPath)) return;
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      for (const targetId of Object.keys(configData)) {
        await this.discoverTarget(targetId);
      }
    } catch (e) {
      console.error('[EndpointDiscovery] Failed to read config for discoverAll', e);
    }
  }

  public async discoverTarget(targetId: string): Promise<void> {
    if (this.agents.has(targetId) || this.starting.has(targetId)) {
      console.log(`[EndpointDiscovery] Target ${targetId} is already starting or running`);
      return;
    }

    const configPath = path.join(process.cwd(), 'data', 'remote_config.json');
    let tConf: any = null;
    if (fs.existsSync(configPath)) {
      try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        tConf = configData[targetId];
      } catch (e) {
        // Leaving tConf null here makes the target look unconfigured rather
        // than broken, which sends you hunting for a discovery bug when the
        // real problem is a JSON syntax error in the config file.
        console.error(`[Discovery] Could not parse remote_config.json for ${targetId}:`, (e as Error)?.message ?? e);
      }
    }

    if (!tConf?.ec2PublicIp || !tConf?.sshKeyPath) {
      console.log(`[EndpointDiscovery] No ec2PublicIp/sshKeyPath for target ${targetId} — skipping`);
      return;
    }

    const agent = new TargetAgent(
      targetId,
      tConf,
      this.registry,
      this.wsManager,
      this.onTopologyDiscovered,
      this.onTelemetryCollected,
    );
    this.starting.add(targetId);
    this.agents.set(targetId, agent);
    try {
      await agent.start();
    } finally {
      this.starting.delete(targetId);
    }
  }

  public async refreshTarget(targetId: string): Promise<void> {
    this.stopTarget(targetId);
    await this.discoverTarget(targetId);
  }

  public async getServiceLogs(targetId: string, containerId: string, tailLines: number): Promise<string[]> {
    const agent = this.agents.get(targetId);
    if (!agent) throw new Error(`No active agent for target ${targetId}`);
    return agent.getServiceLogs(containerId, tailLines);
  }

  public stopTarget(targetId: string) {
    this.starting.delete(targetId);
    this.agents.get(targetId)?.stop();
    this.agents.delete(targetId);
  }
}
