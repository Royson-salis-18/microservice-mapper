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

  constructor() {
    this.storagePath = path.resolve(process.cwd(), 'data', 'graph_db.json');
    this.discoveryEngine = new EndpointDiscoveryEngine(
      this.endpointRegistry,
      (targetId: string) => {
        const target = this.targets.get(targetId);
        return target?.host && target.host !== 'unknown' ? target.host : undefined;
      }
    );

    this.initTargets();
    this.loadFromDisk();
    this.discoveryEngine.discoverAll().then(() => this.updateTargetDiscoverySummaries());
    setInterval(() => {
      this.checkTargetStaleness();
      this.pingTargetEndpoints();
      this.updateTargetDiscoverySummaries();
    }, 5000);
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

  private initTargets() {
    const nowIso = new Date().toISOString();
    const sockShopUrl = config.SOCK_SHOP_BASE_URL;
    const vertikalUrl = config.VERTIKAL_BASE_URL;

    const extractHost = (url?: string) => {
      if (!url) return undefined;
      try {
        if (url.startsWith('http')) return new URL(url).hostname;
        return url.split(':')[0];
      } catch (e) {
        return undefined;
      }
    };

    const sockHost = extractHost(sockShopUrl) || 'unknown';
    const vertikalHost = extractHost(vertikalUrl) || 'unknown';

    this.upsertTarget({
      targetId: 'sock-shop',
      displayName: 'Sock Shop AWS',
      environment: 'aws',
      host: sockHost,
      transport: 'http',
      status: 'NO DATA',
      lastSeen: nowIso,
      baseUrl: sockShopUrl || (sockHost !== 'unknown' ? `http://${sockHost}:80` : undefined),
      publicPort: 80,
      endpointStatus: sockHost !== 'unknown' ? 'REACHABLE' : 'UNCONFIGURED',
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: false }
    });

    this.upsertTarget({
      targetId: 'vertikal',
      displayName: 'Vertikal AWS',
      environment: 'aws',
      host: vertikalHost,
      transport: 'http',
      status: 'NO DATA',
      lastSeen: nowIso,
      baseUrl: vertikalUrl || (vertikalHost !== 'unknown' ? `http://${vertikalHost}:54321` : undefined),
      publicPort: 54321,
      endpointStatus: vertikalHost !== 'unknown' ? 'REACHABLE' : 'UNCONFIGURED',
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: false }
    });
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
            target.lastSeen = new Date().toISOString();
            target.status = 'LIVE';
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
    const target = this.targets.get(targetId);
    if (target) {
      target.lastSeen = new Date().toISOString();
      target.status = 'LIVE';
    }
  }

  private checkTargetStaleness() {
    const now = Date.now();
    for (const target of this.targets.values()) {
      if (target.lastSeen) {
        const diff = now - new Date(target.lastSeen).getTime();
        if (diff > 60000) target.status = 'OFFLINE';
        else if (diff > 15000) target.status = 'STALE';
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

  async updateFromCollectors(dockerCollector: DockerCollector, adapters: BaseCollector[]): Promise<void> {
    const localTargetId = 'vertikal';
    const nowIso = new Date().toISOString();
    this.upsertTarget({
      targetId: localTargetId,
      displayName: 'Vertikal AWS',
      environment: 'local',
      host: 'localhost',
      transport: 'http',
      status: 'LIVE',
      lastSeen: nowIso,
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: false }
    });

    const discoveredNodes = new Map<string, ServiceNode>();

    for (const adapter of adapters) {
      const adapterNodes = await adapter.discover();
      for (const node of adapterNodes) {
        if (!node.project) node.project = localTargetId;
        discoveredNodes.set(node.id, node);
      }
    }

    if (dockerCollector) {
      const dockerNodes = await dockerCollector.discover();
      for (const node of dockerNodes) {
        if (!node.project) node.project = localTargetId;
        discoveredNodes.set(node.id, node);
      }
    }

    const currentIdsByTarget = new Map<string, Set<string>>();

    for (const node of discoveredNodes.values()) {
      const targetId = node.project || localTargetId;
      const nodesMap = this.getTargetNodes(targetId);
      const existingNode = nodesMap.get(node.id);
      
      if (!currentIdsByTarget.has(targetId)) {
        currentIdsByTarget.set(targetId, new Set());
      }
      currentIdsByTarget.get(targetId)!.add(node.id);
    }

    const nodeEntries = Array.from(discoveredNodes.values());
    const metricsResults = await Promise.all(
      nodeEntries.map(async (node) => {
        let metrics = null;
        if (dockerCollector) {
          metrics = await dockerCollector.collectMetrics(node.id).catch(() => null);
        }
        return { node, metrics };
      })
    );

    for (const { node, metrics } of metricsResults) {
      const targetId = node.project || localTargetId;
      const nodesMap = this.getTargetNodes(targetId);
      const existingNode = nodesMap.get(node.id);

      if (metrics) {
        this.metricStore.push(node.id, metrics);
        node.metrics = {
          cpu: metrics.cpu,
          memory: metrics.memory,
          memoryPercent: metrics.memoryPercent,
          networkRx: metrics.networkRx,
          networkTx: metrics.networkTx,
          latency: null,
          requestRate: null,
          errorRate: null,
        };
        if (node.status === 'healthy') {
          if ((metrics.cpu !== undefined && metrics.cpu > 80) ||
              (metrics.memoryPercent !== undefined && metrics.memoryPercent > 80)) {
            node.status = 'degraded';
          }
        }
      } else if (existingNode) {
        if (existingNode.metrics) node.metrics = existingNode.metrics;
        if (existingNode.status !== 'unknown') node.status = existingNode.status;
        if (existingNode.metadata) node.metadata = { ...existingNode.metadata, ...node.metadata };
      }
      nodesMap.set(node.id, node);
    }

    for (const [targetId, nodesMap] of this.nodesByTarget.entries()) {
      if (currentIdsByTarget.has(targetId)) {
        const currentIds = currentIdsByTarget.get(targetId)!;
        for (const id of Array.from(nodesMap.keys())) {
          if (!currentIds.has(id)) {
            nodesMap.delete(id);
          }
        }
      }
    }

    for (const adapter of adapters) {
      const knownEdges = await adapter.getKnownDependencies();
      for (const edge of knownEdges) {
        let edgeTargetId = localTargetId;
        if (edge.source.startsWith('sock-shop') || edge.target.startsWith('sock-shop')) {
          edgeTargetId = 'sock-shop';
        }
        const edgesMap = this.getTargetEdges(edgeTargetId);
        const existing = edgesMap.get(edge.id);
        if (existing) {
          if (edge.declared) existing.declared = true;
          if (edge.observed) existing.observed = true;
          for (const source of edge.evidenceSources) {
            if (!existing.evidenceSources.includes(source)) {
              existing.evidenceSources.push(source);
            }
          }
          if (edge.status !== 'unknown') existing.status = edge.status;
          if (edge.metrics) existing.metrics = edge.metrics;
        } else {
          edgesMap.set(edge.id, edge);
        }
      }
    }

    for (const edgesMap of this.edgesByTarget.values()) {
      for (const edge of edgesMap.values()) {
        const edgeMetrics = this.metricStore.getAggregatedEdgeMetrics(edge.source, edge.target);
        if (edgeMetrics && edgeMetrics.requestCount > 0) {
          edge.observed = true;
          if (!edge.evidenceSources.includes('http-log')) {
            edge.evidenceSources.push('http-log');
          }
          edge.metrics = edgeMetrics;
          if (edgeMetrics.errorRate > 0.05) {
            edge.status = 'failed';
          } else if (edgeMetrics.latency !== null && edgeMetrics.latency > 500) {
            edge.status = 'degraded';
          } else {
            edge.status = 'active';
          }
        }
      }
    }

    for (const nodesMap of this.nodesByTarget.values()) {
      for (const node of nodesMap.values()) {
        let upstream = 0;
        let downstream = 0;
        const edgesMap = this.getTargetEdges(node.project || localTargetId);
        for (const edge of edgesMap.values()) {
          if (edge.target === node.id) upstream++;
          if (edge.source === node.id) downstream++;
        }
        if (!node.analytics) {
          node.analytics = { healthScore: null, riskScore: null, failureProbability: null, affectedProbability: null, criticality: null, centrality: null };
        }
        node.analytics.upstreamCount = upstream;
        node.analytics.downstreamCount = downstream;
      }
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
    
    if (events.nodes) {
      for (const node of events.nodes) {
        if (!node.project) node.project = targetId;
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
        const existing = edgesMap.get(edge.id);
        if (existing) {
          existing.observed = edge.observed || existing.observed;
          existing.declared = edge.declared || existing.declared;
          for (const source of edge.evidenceSources) {
            if (!existing.evidenceSources.includes(source)) {
              existing.evidenceSources.push(source);
            }
          }
          if (edge.status !== 'unknown') existing.status = edge.status;
        } else {
          edgesMap.set(edge.id, edge);
        }
      }
    }
    
    if (events.metrics) {
      for (const m of events.metrics) {
        this.metricStore.push(m.nodeId, m.snapshot);
        const node = nodesMap.get(m.nodeId);
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
          if (node.status === 'healthy') {
            if ((m.snapshot.cpu !== undefined && m.snapshot.cpu > 80) ||
                (m.snapshot.memoryPercent !== undefined && m.snapshot.memoryPercent > 80)) {
              node.status = 'degraded';
            }
          }
        }
      }
    }
    
    if (events.interactions) {
      for (const e of events.interactions) {
        this.metricStore.pushEvent(e);
        const eventRoute = e.route;
        if (eventRoute) {
          const matchedRoute = this.endpointRegistry.getRoutes(targetId).find(r => r.path === eventRoute || eventRoute.startsWith(r.path));
          if (matchedRoute) {
            this.endpointRegistry.markRouteObserved(targetId, matchedRoute.routeId, e.latency, (e.statusCode || 200) >= 400);
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
  }
}