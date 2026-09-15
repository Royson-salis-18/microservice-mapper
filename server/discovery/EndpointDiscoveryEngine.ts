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
import type { TargetConfig } from '../telemetry-platform/src/types/target.js';

class TargetAgent {
  private targetId: string;
  private tConf: any;
  private wsManager?: WebSocketManager;
  private registry: EndpointRegistry;
  private onTopologyDiscovered?: (targetId: string, services: any[], dependencies: any[]) => void;
  private onTelemetryCollected?: (targetId: string, envelope: any) => void;

  private connManager: ConnectionManager | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
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
    if (this.connManager) this.connManager.close().catch(() => {});
  }

  private async runCycle() {
    if (this.dead) return;
    try {
      this.log(`[Agent:${this.targetId}] Establishing SSH connection...`);
      const conn = await this.connManager!.getConnection();
      
      this.log(`[Agent:${this.targetId}] Discovering architecture...`);
      const engine = new DiscoveryEngine(this.targetId, conn);
      const result = await engine.discover();

      if (result.architecture.warnings && result.architecture.warnings.length > 0) {
        for (const warn of result.architecture.warnings) {
          this.log(`[Agent:${this.targetId}] Discovery warning: ${warn}`);
        }
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
    this.pollTimer = null;
    this.connectionTimer = null;
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

        if (this.onTelemetryCollected && (metricsRes.samples.length > 0 || metricsRes.observedEdges.length > 0 || metricsRes.interactions.length > 0)) {
          const envelope = this.translateMetricsToEnvelope(metricsRes.samples, metricsRes.observedEdges, metricsRes.interactions);
          this.onTelemetryCollected(this.targetId, envelope);
        }
      } catch (e: any) {
        this.scheduleRecovery(`Polling error: ${e.message}`);
      }
    };

    await poll();
    if (this.dead || this.recovering) return;
    this.pollTimer = setInterval(poll, 5000);
    this.connectionTimer = setInterval(async () => {
      if (this.dead || !this.onTelemetryCollected) return;
      try {
        const currentConn = await this.connManager!.getConnection();
        collector.setConnection(currentConn);
        const edges = await collector.collectObservedEdges(this.discoveredServices);
        if (edges.length > 0) {
          this.onTelemetryCollected(this.targetId, this.translateMetricsToEnvelope([], edges, []));
        }
      } catch (e: any) {
        this.scheduleRecovery(`Connection scan failed: ${e.message}`);
      }
    }, 1000);
  }

  private translateMetricsToEnvelope(samples: any[], observedEdges: any[], interactions: any[]): any {
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
      events: { nodes, metrics, edges: observedEdges.map((edge) => ({
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

  public stopTarget(targetId: string) {
    this.starting.delete(targetId);
    this.agents.get(targetId)?.stop();
    this.agents.delete(targetId);
  }
}
