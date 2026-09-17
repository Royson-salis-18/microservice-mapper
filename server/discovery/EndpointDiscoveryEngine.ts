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

      await this.refreshDiscovery(conn);

      // Start continuous metric polling
      this.recovering = false;
      await this.startPolling(conn);

    } catch (err: any) {
      this.scheduleRecovery(`Cycle failed: ${err.message}`);
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
        if (metricsRes.warnings.length > 0) {
          // Log warnings but continue
        }

        if (this.onTelemetryCollected && (metricsRes.samples.length > 0 || metricsRes.observedEdges.length > 0 || metricsRes.interactions.length > 0 || metricsRes.connectionEvents.length > 0)) {
          const envelope = this.translateMetricsToEnvelope(metricsRes.samples, metricsRes.observedEdges, metricsRes.interactions, metricsRes.connectionEvents);
          this.onTelemetryCollected(this.targetId, envelope);
        }
      } catch (e: any) {
        this.scheduleRecovery(`Polling error: ${e.message}`);
      }
    };

    await poll();
    if (this.dead || this.recovering) return;
    this.pollTimer = setInterval(poll, 5000);

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

  private translateMetricsToEnvelope(samples: any[], observedEdges: any[], interactions: any[], connectionEvents: any[] = []): any {
    const observedAt = new Date().toISOString();
    const nodes = samples.map(s => {
      let status = 'healthy';
      if ((s.cpuPercent || 0) > 80 || (s.memoryPercent || 0) > 80) status = 'degraded';
      
      // Need to derive a clean name for GraphStore from serviceId
      const cleanName = s.serviceId.includes(':') ? s.serviceId.split(':')[1] : s.serviceId;

      return {
        id: s.serviceId,
        name: cleanName,
        project: this.targetId,
        status,
        metadata: { state: 'running' }
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
      } catch {}
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
