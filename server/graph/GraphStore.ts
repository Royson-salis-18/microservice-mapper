import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { BaseCollector } from '../collectors/BaseCollector.js';
import type { DockerCollector } from '../collectors/DockerCollector.js';
import type { Target, TelemetryEnvelope } from '../models/index.js';
import { MetricStore } from '../telemetry/MetricStore.js';
import { config } from '../config.js';
import { EndpointRegistry } from '../registry/EndpointRegistry.js';
import { EndpointDiscoveryEngine } from '../discovery/EndpointDiscoveryEngine.js';
import fs from 'fs';
import path from 'path';

import type { WebSocketManager } from '../api/websocket.js';

export class GraphStore {
  // Target Isolation: Maps targetId -> map of ids to models
  public targets = new Map<string, Target>();
  public nodesByTarget = new Map<string, Map<string, ServiceNode>>();
  public edgesByTarget = new Map<string, Map<string, DependencyEdge>>();
  
  public metricStore = new MetricStore();
  public endpointRegistry = new EndpointRegistry();
  public discoveryEngine: EndpointDiscoveryEngine;
  private storagePath: string;
  private saveTimeout: NodeJS.Timeout | null = null;
  private wsManager?: WebSocketManager;

  constructor(wsManager?: WebSocketManager) {
    this.wsManager = wsManager;
    this.storagePath = path.resolve(process.cwd(), 'data', 'graph_db.json');
    this.discoveryEngine = new EndpointDiscoveryEngine(
      this.endpointRegistry,
      this.wsManager,
      (targetId: string) => {
        const target = this.targets.get(targetId);
        return target?.host && target.host !== 'unknown' ? target.host : undefined;
      },
      (targetId: string, services: any[], dependencies: any[]) => {
        this.handleTopologyDiscovered(targetId, services, dependencies);
      },
      (targetId: string, envelope: any) => {
        this.ingestRemote(envelope);
      }
    );

    this.loadFromDisk();
    this.loadTargetsFromConfig();
    
    // Initial discovery for loaded targets
    this.discoveryEngine.discoverAll().then(() => this.updateTargetDiscoverySummaries());
    
    setInterval(() => {
      this.checkTargetStaleness();
      this.pingTargetEndpoints();
      this.updateTargetDiscoverySummaries();
      // Broadcast current graph state so UI stays in sync with status changes
      if (this.wsManager) {
        this.wsManager.broadcast('graph-update', this.getGraph());
      }
    }, 10000);
  }

  private loadTargetsFromConfig() {
    const configPath = path.join(process.cwd(), 'data', 'remote_config.json');
    if (fs.existsSync(configPath)) {
      try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const [targetId, tConf] of Object.entries<any>(configData)) {
          this.registerNewProject(targetId, tConf.displayName || targetId, tConf.ec2PublicIp);
        }
      } catch (e) {
        console.error('[GraphStore] Error loading remote_config.json:', e);
      }
    }
  }

  public registerNewProject(targetId: string, displayName: string, hostIp: string) {
    const nowIso = new Date().toISOString();
    this.upsertTarget({
      targetId,
      displayName,
      environment: 'aws',
      host: hostIp || 'unknown',
      transport: 'http',
      status: 'NO DATA',
      lastSeen: nowIso,
      baseUrl: hostIp && hostIp !== 'unknown' ? `http://${hostIp}:80` : undefined, // default
      publicPort: 80,
      endpointStatus: hostIp && hostIp !== 'unknown' ? 'REACHABLE' : 'UNCONFIGURED',
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: false }
    });
    // Trigger discovery immediately
    this.discoveryEngine.discoverTarget(targetId).then(() => this.updateTargetDiscoverySummaries());
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.targets && typeof data.targets === 'object') {
          for (const [k, v] of Object.entries(data.targets)) {
            this.targets.set(k, v as Target);
          }
        }
        if (data.nodesByTarget && typeof data.nodesByTarget === 'object') {
          for (const [tId, nodesObj] of Object.entries(data.nodesByTarget)) {
            const nodesMap = this.getTargetNodes(tId);
            for (const [nId, node] of Object.entries(nodesObj as Record<string, ServiceNode>)) {
              nodesMap.set(nId, node);
            }
          }
        }
        if (data.edgesByTarget && typeof data.edgesByTarget === 'object') {
          for (const [tId, edgesObj] of Object.entries(data.edgesByTarget)) {
            const edgesMap = this.getTargetEdges(tId);
            for (const [eId, edge] of Object.entries(edgesObj as Record<string, DependencyEdge>)) {
              edgesMap.set(eId, edge);
            }
          }
        }
        console.log(`[GraphStore] Loaded persistent graph state from disk (${this.targets.size} targets)`);
      }
    } catch (e) {
      console.warn('[GraphStore] Failed to load graph state from disk:', e);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveToDisk();
    }, 2000);
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const targetsObj: Record<string, Target> = {};
      for (const [k, v] of this.targets.entries()) targetsObj[k] = v;

      const nodesObj: Record<string, Record<string, ServiceNode>> = {};
      for (const [tId, map] of this.nodesByTarget.entries()) {
        nodesObj[tId] = {};
        for (const [nId, n] of map.entries()) nodesObj[tId][nId] = n;
      }

      const edgesObj: Record<string, Record<string, DependencyEdge>> = {};
      for (const [tId, map] of this.edgesByTarget.entries()) {
        edgesObj[tId] = {};
        for (const [eId, e] of map.entries()) edgesObj[tId][eId] = e;
      }

      const payload = JSON.stringify({ targets: targetsObj, nodesByTarget: nodesObj, edgesByTarget: edgesObj });
      fs.writeFileSync(this.storagePath, payload, 'utf8');
    } catch (e) {
      console.error('[GraphStore] Failed to save graph state to disk:', e);
    }
  }



  private async pingTargetEndpoints() {
    for (const target of this.targets.values()) {
      if (target.baseUrl) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(target.baseUrl, { method: 'HEAD', signal: controller.signal }).catch(async () => {
            return await fetch(target.baseUrl!, { method: 'GET', signal: controller.signal });
          });
          clearTimeout(timeoutId);
          if (res && res.status < 500) {
            target.endpointStatus = 'REACHABLE';
            // Keep target alive if endpoint is reachable
            target.lastSeen = new Date().toISOString();
          } else {
            target.endpointStatus = 'UNREACHABLE';
          }
        } catch (e) {
          target.endpointStatus = 'UNREACHABLE';
        }
      } else {
        target.endpointStatus = 'UNCONFIGURED';
      }
    }
  }

  public touchTarget(targetId: string) {
    // Deprecated: Target status must only be updated by genuine telemetry (ingestRemote)
  }

  private checkTargetStaleness() {
    const now = Date.now();
    for (const target of this.targets.values()) {
      if (target.lastSeen) {
        const diff = now - new Date(target.lastSeen).getTime();
        // Wider thresholds: STALE after 2min, OFFLINE after 5min
        if (diff > 300000) target.status = 'OFFLINE';
        else if (diff > 120000) target.status = 'STALE';
        else target.status = 'LIVE';
      } else {
        target.status = 'NO DATA';
      }
    }
  }

  private updateTargetDiscoverySummaries() {
    for (const target of this.targets.values()) {
      this.endpointRegistry.touchDiscovery(target.targetId);
      const summary = this.endpointRegistry.getSummary(target.targetId);
      target.discoverySummary = summary;
    }
  }

  private getTargetNodes(targetId: string) {
    if (!this.nodesByTarget.has(targetId)) {
      this.nodesByTarget.set(targetId, new Map());
    }
    return this.nodesByTarget.get(targetId)!;
  }

  private getTargetEdges(targetId: string) {
    if (!this.edgesByTarget.has(targetId)) {
      this.edgesByTarget.set(targetId, new Map());
    }
    return this.edgesByTarget.get(targetId)!;
  }

  private upsertTarget(target: Target) {
    const existing = this.targets.get(target.targetId);
    if (existing) {
      existing.status = target.status;
      existing.lastSeen = target.lastSeen;
      if (target.host && target.host !== 'unknown') existing.host = target.host;
      if (target.baseUrl) existing.baseUrl = target.baseUrl;
      if (target.endpointStatus) existing.endpointStatus = target.endpointStatus;
      if (target.capabilities) existing.capabilities = { ...existing.capabilities, ...target.capabilities };
    } else {
      this.targets.set(target.targetId, target);
    }
    this.scheduleSave();
  }

  private handleTopologyDiscovered(targetId: string, services: any[], dependencies: any[]) {
    const nodesMap = this.getTargetNodes(targetId);
    const edgesMap = this.getTargetEdges(targetId);

    // Update target lastSeen so it stays LIVE
    const target = this.targets.get(targetId);
    if (target) {
      target.lastSeen = new Date().toISOString();
      target.status = 'LIVE';
    }

    for (const svc of services) {
      if (svc.name.includes('mapper-collector')) continue;
      const nodeId = svc.serviceId;
      const existing = nodesMap.get(nodeId);
      
      const status = svc.state === 'running' ? 'healthy' : 'unknown';
      const nodeType = ['gateway', 'service', 'database', 'queue', 'frontend', 'infrastructure', 'external'].includes(svc.type) ? svc.type : 'service';
      
      if (existing) {
        existing.status = status as any;
        existing.type = nodeType as any;
        existing.metadata = {
          ...existing.metadata,
          containerId: svc.containerId,
          image: svc.image,
          ports: svc.ports.map((p: any) => p.containerPort.toString())
        };
      } else {
        nodesMap.set(nodeId, {
          id: nodeId,
          name: svc.name,
          type: nodeType as any,
          project: targetId,
          status: status as any,
          metadata: {
            containerId: svc.containerId,
            image: svc.image,
            ports: svc.ports.map((p: any) => p.containerPort.toString())
          },
          metrics: null
        });
      }
    }

    for (const dep of dependencies) {
      const edgeId = `${dep.sourceServiceId}->${dep.targetServiceId}`;
      const existing = edgesMap.get(edgeId);
      if (existing) {
        existing.declared = existing.declared || dep.declared === true;
        existing.observed = existing.observed || dep.observed;
        for (const src of dep.evidenceSources) {
          if (!existing.evidenceSources.includes(src)) {
            existing.evidenceSources.push(src);
          }
        }
      } else {
        edgesMap.set(edgeId, {
          id: edgeId,
          source: dep.sourceServiceId,
          target: dep.targetServiceId,
          type: 'dependency',
          declared: dep.declared === true,
          observed: dep.observed,
          evidenceSources: dep.evidenceSources || [],
          status: dep.observed ? 'active' : 'unknown',
          metrics: null
        });
      }
    }

    this.scheduleSave();
    if (this.wsManager) {
      this.wsManager.broadcast('graph-update', this.getGraph());
    }
  }



  getGraph(): { nodes: ServiceNode[], edges: DependencyEdge[], targets: Target[] } {
    const allNodes: ServiceNode[] = [];
    const allEdges: DependencyEdge[] = [];
    
    for (const nodesMap of this.nodesByTarget.values()) {
      allNodes.push(...Array.from(nodesMap.values()));
    }
    
    for (const edgesMap of this.edgesByTarget.values()) {
      allEdges.push(...Array.from(edgesMap.values()));
    }

    return { nodes: allNodes, edges: allEdges, targets: Array.from(this.targets.values()) };
  }

  getNode(id: string): ServiceNode | undefined {
    for (const nodesMap of this.nodesByTarget.values()) {
      if (nodesMap.has(id)) return nodesMap.get(id);
    }
    return undefined;
  }

  ingestRemote(payload: TelemetryEnvelope, clientIp?: string) {
    const { targetId, events } = payload;
    console.log(`[TELEMETRY] target=${targetId} nodes=${events.nodes?.length || 0} metrics=${events.metrics?.length || 0} edges=${events.edges?.length || 0} interactions=${events.interactions?.length || 0}`);
    const cleanClientIp = clientIp ? clientIp.replace(/^.*:/, '') : undefined;
    const remoteHost = (cleanClientIp && cleanClientIp !== '127.0.0.1') ? cleanClientIp : 'unknown';

    const existingTarget = this.targets.get(targetId);
    const hostToUse = remoteHost !== 'unknown' ? remoteHost : (existingTarget?.host || 'unknown');
    const port = existingTarget?.publicPort || (targetId === 'vertikal' ? 54321 : 80);

    this.upsertTarget({
      targetId,
      displayName: targetId === 'sock-shop' ? 'Sock Shop AWS' : (targetId === 'vertikal' ? 'Vertikal AWS' : targetId),
      environment: 'remote',
      host: hostToUse,
      transport: 'http',
      status: 'LIVE',
      lastSeen: new Date().toISOString(),
      baseUrl: hostToUse !== 'unknown' ? `http://${hostToUse}:${port}` : existingTarget?.baseUrl,
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: false }
    });

    const nodesMap = this.getTargetNodes(targetId);
    const edgesMap = this.getTargetEdges(targetId);
    
    const normalizeId = (rawId: string) => {
      if (!rawId || rawId === 'external' || rawId === 'unknown-upstream') return rawId;
      const clean = rawId.replace(new RegExp(`^${targetId}[-:/]`), '');
      return `${targetId}:${clean}`;
    };

    if (events.nodes) {
      for (const node of events.nodes) {
        if (!node.project) node.project = targetId;
        node.id = normalizeId(node.id);
        const existing = nodesMap.get(node.id);
        if (existing) {
          existing.status = node.status;
          if (node.metadata) existing.metadata = { ...existing.metadata, ...node.metadata };
        } else {
          nodesMap.set(node.id, node);
        }
      }
    }
    
    if (events.edges) {
      for (const edge of events.edges) {
        edge.source = normalizeId(edge.source);
        edge.target = normalizeId(edge.target);
        edge.id = `${edge.source}->${edge.target}`;
        const existing = edgesMap.get(edge.id);
        if (!edge.observed) {
          if (!existing) edgesMap.set(edge.id, edge);
          continue;
        }
        if (existing) {
          existing.observed = edge.observed || existing.observed;
          existing.declared = edge.declared || existing.declared;
          existing.protocol = edge.protocol || existing.protocol;
          existing.lastSeen = edge.lastSeen || new Date().toISOString();
          for (const source of edge.evidenceSources) {
            if (!existing.evidenceSources.includes(source)) {
              existing.evidenceSources.push(source);
            }
          }
          if (edge.status !== 'unknown') existing.status = edge.status;
          if (!existing.observed) {
            existing.observed = true;
            console.log(`[EDGE] target=${targetId} source=${existing.source} target=${existing.target} observed=true`);
          }
        } else {
          edgesMap.set(edge.id, edge);
          console.log(`[EDGE] target=${targetId} source=${edge.source} target=${edge.target} observed=true`);
        }
      }
    }
    
    if (events.metrics) {
      for (const m of events.metrics) {
        const normNodeId = normalizeId(m.nodeId);
        this.metricStore.push(normNodeId, m.snapshot);
        const node = nodesMap.get(normNodeId);
        if (node) {
          node.metrics = {
            cpu: m.snapshot.cpu !== undefined ? Math.round(m.snapshot.cpu * 10) / 10 : 0,
            memory: m.snapshot.memory || 0,
            memoryPercent: m.snapshot.memoryPercent !== undefined ? Math.round(m.snapshot.memoryPercent * 10) / 10 : 0,
            networkRx: m.snapshot.networkRx || 0,
            networkTx: m.snapshot.networkTx || 0,
            latency: null,
            requestRate: null,
            errorRate: null,
          };
        }
      }
    }
    
    if (events.interactions) {
      for (const e of events.interactions) {
        e.source = normalizeId(e.source);
        e.target = normalizeId(e.target);
        e.latencyMs = e.latencyMs ?? e.latency ?? null;
        e.statusCode = e.statusCode ?? null;
        e.bytesSent = e.bytesSent ?? null;
        e.bytesReceived = e.bytesReceived ?? null;
        e.success = e.success ?? (e.statusCode === null ? null : e.statusCode < 400);
        this.metricStore.pushEvent(e);

        console.log(`[INTERACTION] target=${targetId} source=${e.source} target=${e.target} protocol=${e.protocol ?? 'unknown'} method=${e.method ?? 'unknown'} route=${e.route ?? 'unknown'} evidence=${e.evidenceSource}`);

        if (e.source !== e.target && e.source !== 'external' && e.source !== 'unknown-upstream') {
          const edgeId = `${e.source}->${e.target}`;
          const existing = edgesMap.get(edgeId);
          if (existing) {
            const wasObserved = existing.observed;
            existing.observed = true;
            existing.protocol = e.protocol || existing.protocol;
            existing.lastSeen = e.timestamp;
            if (!existing.evidenceSources.includes('http-log')) {
              existing.evidenceSources.push('http-log');
            }
            if (!wasObserved) {
              console.log(`[EDGE] target=${targetId} source=${existing.source} target=${existing.target} observed=true`);
            }
          } else {
            edgesMap.set(edgeId, {
              id: edgeId,
              source: e.source,
              target: e.target,
              type: e.protocol === 'amqp' || e.protocol === 'rabbitmq' ? 'message' : 'http',
              declared: false,
              observed: true,
              evidenceSources: ['http-log'],
              firstSeen: e.timestamp,
              lastSeen: e.timestamp,
              status: 'active',
              metrics: null,
            });
            console.log(`[EDGE] target=${targetId} source=${e.source} target=${e.target} observed=true`);
          }
        }

        const eventRoute = e.route;
        if (eventRoute) {
          const matchedRoute = this.endpointRegistry.getRoutes(targetId).find(r => r.path === eventRoute || eventRoute.startsWith(r.path));
          if (matchedRoute) {
            this.endpointRegistry.markRouteObserved(
              targetId,
              matchedRoute.routeId,
              e.latencyMs ?? e.latency ?? undefined,
              e.statusCode !== null && e.statusCode !== undefined ? e.statusCode >= 400 : false,
            );
          }
        }
      }
    }
    
    for (const edge of edgesMap.values()) {
      const srcNode = nodesMap.get(edge.source) || Array.from(nodesMap.values()).find(n => n.id === edge.source || n.id.endsWith(`-${edge.source}`));
      const tgtNode = nodesMap.get(edge.target) || Array.from(nodesMap.values()).find(n => n.id === edge.target || n.id.endsWith(`-${edge.target}`));

      if (srcNode?.status === 'critical' || tgtNode?.status === 'critical') {
        edge.status = 'failed';
      } else if (srcNode?.status === 'degraded' || tgtNode?.status === 'degraded') {
        edge.status = 'degraded';
      }

      const edgeMetrics = this.metricStore.getAggregatedEdgeMetrics(edge.source, edge.target);
      if (edgeMetrics && edgeMetrics.requestCount > 0) {
        edge.observed = true;
        if (!edge.evidenceSources.includes('http-log')) {
          edge.evidenceSources.push('http-log');
        }
        edge.metrics = edgeMetrics;
        if (edgeMetrics.errorRate > 0.05) {
          edge.status = 'failed';
        } else if (edgeMetrics.latency !== null && edgeMetrics.latency > 500 && edge.status !== 'failed') {
          edge.status = 'degraded';
        }
      }
    }

    this.updateTargetDiscoverySummaries();
    this.scheduleSave();
    if (this.wsManager) {
      this.wsManager.broadcast('graph-update', this.getGraph());
    }
  }
}