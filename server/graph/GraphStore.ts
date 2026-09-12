import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import type { BaseCollector } from '../collectors/BaseCollector.js';
import type { DockerCollector } from '../collectors/DockerCollector.js';
import type { Target, TelemetryEnvelope } from '../models/index.js';
import { MetricStore } from '../telemetry/MetricStore.js';

export class GraphStore {
  // Target Isolation: Maps targetId -> map of ids to models
  public targets = new Map<string, Target>();
  public nodesByTarget = new Map<string, Map<string, ServiceNode>>();
  public edgesByTarget = new Map<string, Map<string, DependencyEdge>>();
  
  public metricStore = new MetricStore();

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

  // Registers or updates a target
  private upsertTarget(target: Target) {
    const existing = this.targets.get(target.id);
    if (existing) {
      existing.status = target.status;
      existing.lastSeen = target.lastSeen;
      if (target.metadata) existing.metadata = { ...existing.metadata, ...target.metadata };
    } else {
      this.targets.set(target.id, target);
    }
  }

  // Update loop for local target (e.g. Vertikal)
  async updateFromCollectors(dockerCollector: DockerCollector, adapters: BaseCollector[]): Promise<void> {
    const localTargetId = 'vertikal';
    const nowIso = new Date().toISOString();
    
    this.upsertTarget({
      id: localTargetId,
      name: 'Vertikal',
      type: 'application',
      environment: 'local',
      platform: 'docker-compose',
      status: 'LIVE',
      lastSeen: nowIso
    });

    this.upsertTarget({
      id: 'sock-shop',
      name: 'Sock Shop',
      type: 'application',
      environment: 'remote',
      platform: 'docker-compose',
      status: 'LIVE',
      lastSeen: nowIso
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

      let metrics = null;
      if (dockerCollector) {
        metrics = await dockerCollector.collectMetrics(node.id);
      }
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
      const currentIds = currentIdsByTarget.get(targetId) || new Set();
      for (const id of Array.from(nodesMap.keys())) {
        if (!currentIds.has(id)) {
          nodesMap.delete(id);
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

    // Evaluate target staleness
    const now = Date.now();
    for (const target of this.targets.values()) {
      if (target.lastSeen) {
        const lastSeenMs = new Date(target.lastSeen).getTime();
        const diff = now - lastSeenMs;
        if (diff > 60000) target.status = 'OFFLINE';
        else if (diff > 15000) target.status = 'STALE';
        else target.status = 'LIVE';
      } else {
        target.status = 'NO_DATA';
      }
    }

    return { nodes: allNodes, edges: allEdges, targets: Array.from(this.targets.values()) };
  }

  getNode(id: string): ServiceNode | undefined {
    for (const nodesMap of this.nodesByTarget.values()) {
      if (nodesMap.has(id)) return nodesMap.get(id);
    }
    return undefined;
  }

  ingestRemote(payload: TelemetryEnvelope) {
    const { targetId, events } = payload;
    
    // Register the target based on the envelope
    this.upsertTarget({
      id: targetId,
      name: targetId, // Can be improved
      type: 'application',
      environment: 'remote',
      platform: 'docker',
      status: 'LIVE',
      lastSeen: new Date().toISOString()
    });

    const nodesMap = this.getTargetNodes(targetId);
    const edgesMap = this.getTargetEdges(targetId);
    
    if (events.nodes) {
      nodesMap.clear(); // Rebuild from envelope
      for (const node of events.nodes) {
        if (!node.project) node.project = targetId;
        nodesMap.set(node.id, node);
      }
    }
    
    if (events.edges) {
      edgesMap.clear(); // Rebuild from envelope
      for (const edge of events.edges) {
        edgesMap.set(edge.id, edge);
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
  }
}