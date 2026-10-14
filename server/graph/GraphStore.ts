import { linkStatus } from './linkThresholds.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { Target, TelemetryEnvelope } from '../models/index.js';
import { MetricStore } from '../telemetry/MetricStore.js';
import { config } from '../config.js';
import { EndpointRegistry } from '../registry/EndpointRegistry.js';
import { EndpointDiscoveryEngine } from '../discovery/EndpointDiscoveryEngine.js';
import { TraceStore } from '../traces/TraceStore.js';
import fs from 'fs';
import path from 'path';

import type { WebSocketManager } from '../api/websocket.js';

/**
 * Longest an ML score is treated as describing the present. score.py writes
 * every score_interval_sec (10 s by default), so a score older than this
 * means the scorer has stopped and its last verdict is history, not state.
 *
 * Scores used to be applied whatever their age: after a restart with the
 * scorer off, verdicts written the previous day, by models since retrained,
 * put six services at "anomaly 100%", raised their cascade risk to 0.8–0.9
 * and painted them red before anything had been measured.
 */
export const ANOMALY_SCORE_MAX_AGE_MS = 120_000;

/** The score for one service if it is recent enough to stand for now, else null. */
export function freshAnomalyScore(
  entry: { anomaly_score?: unknown; persistent?: unknown; scored_at?: unknown } | undefined,
  now: number,
): { score: number; persistent: boolean } | null {
  if (!entry || typeof entry.anomaly_score !== 'number' || !Number.isFinite(entry.anomaly_score)) return null;
  const at = typeof entry.scored_at === 'string' ? Date.parse(entry.scored_at) : NaN;
  if (!Number.isFinite(at) || now - at > ANOMALY_SCORE_MAX_AGE_MS || at - now > ANOMALY_SCORE_MAX_AGE_MS) return null;
  return { score: entry.anomaly_score, persistent: entry.persistent === true };
}

export class GraphStore {
  // Target Isolation: Maps targetId -> map of ids to models
  public targets = new Map<string, Target>();
  public nodesByTarget = new Map<string, Map<string, ServiceNode>>();
  public edgesByTarget = new Map<string, Map<string, DependencyEdge>>();
  
  public metricStore = new MetricStore();
  public endpointRegistry = new EndpointRegistry();
  public discoveryEngine: EndpointDiscoveryEngine;
  private traceStores = new Map<string, TraceStore>();
  private storagePath: string;
  private saveTimeout: NodeJS.Timeout | null = null;
  private wsManager?: WebSocketManager;
  /** Rolling connection-event counts per edge id, for the activity rate. */
  private edgeActivity = new Map<string, { count: number; windowStart: number }>();
  /**
   * Distinct connections per edge, from the connection key the collector
   * puts on every socket it reads (caller ip:port > callee ip:port). Raw
   * socket rows count one connection many times (once from each end, and
   * every sweep for the ~60s a closed one lingers in TIME_WAIT); these count
   * each connection once.
   */
  private edgeConns = new Map<string, {
    /** connKey -> last time seen, ms. */
    seen: Map<string, number>;
    /** One entry per sweep that covered this edge's target. */
    sweeps: { at: number; open: number; fresh: number }[];
  }>();
  /** Targets whose first sweep has been taken: until then every connection
   *  already open would wrongly count as "new". */
  private connPrimed = new Set<string>();

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
    this.discoveryEngine
      .discoverAll()
      .then(() => this.updateTargetDiscoverySummaries())
      // Without this, a rejection from startup discovery is an unhandled
      // rejection, which terminates the process in Node 18+. Targets being
      // unreachable at boot is normal here, not fatal.
      .catch((e) => console.error('[GraphStore] Initial discovery failed:', e?.message ?? e));
    
    setInterval(() => {
      this.checkTargetStaleness();
      this.pruneStaleNodes();
      this.pruneStaleEdges();
      this.pingTargetEndpoints();
      this.updateTargetDiscoverySummaries();
      // Broadcast current graph state so UI stays in sync with status changes
      this.requestBroadcast();
    }, 10000);
  }

  private loadTargetsFromConfig() {
    const configPath = path.join(process.cwd(), 'data', 'remote_config.json');
    if (fs.existsSync(configPath)) {
      try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const [targetId, tConf] of Object.entries<any>(configData)) {
          this.registerNewProject(targetId, tConf.displayName || targetId, tConf.ec2PublicIp, tConf.trafficBaseUrl);
        }
      } catch (e) {
        console.error('[GraphStore] Error loading remote_config.json:', e);
      }
    }
  }

  public registerNewProject(targetId: string, displayName: string, hostIp: string, trafficBaseUrl?: string) {
    const nowIso = new Date().toISOString();
    const defaultPort = targetId === 'vertikal' ? 54321 : (targetId === 'open-telemetry' || targetId === 'death-star' ? 8080 : 80);
    let resolvedPort = defaultPort;
    let resolvedBaseUrl = trafficBaseUrl;
    if (resolvedBaseUrl) {
      try {
        const parsed = new URL(resolvedBaseUrl);
        if (parsed.port) resolvedPort = Number(parsed.port);
      } catch {}
    } else if (hostIp && hostIp !== 'unknown') {
      resolvedBaseUrl = `http://${hostIp}:${defaultPort}`;
    }

    this.upsertTarget({
      targetId,
      displayName,
      environment: 'aws',
      host: hostIp || 'unknown',
      transport: 'http',
      status: 'NO DATA',
      lastSeen: nowIso,
      baseUrl: resolvedBaseUrl,
      publicPort: resolvedPort,
      endpointStatus: hostIp && hostIp !== 'unknown' ? 'REACHABLE' : 'UNCONFIGURED',
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: false }
    });
    // Trigger discovery immediately (use refresh to ensure new config is picked up)
    this.discoveryEngine
      .refreshTarget(targetId)
      .then(() => this.updateTargetDiscoverySummaries())
      .catch((e) => console.error(`[GraphStore] Discovery failed for ${targetId}:`, e?.message ?? e));
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
          const loadTimeIso = new Date().toISOString();
          for (const [tId, nodesObj] of Object.entries(data.nodesByTarget)) {
            const nodesMap = this.getTargetNodes(tId);
            for (const [nId, node] of Object.entries(nodesObj as Record<string, ServiceNode>)) {
              // Nodes saved before `lastSeen` existed (or from a target that
              // isn't reachable this run) get a load-time baseline so
              // pruneStaleNodes() gives them a full grace window to be
              // reconfirmed by a real discovery/telemetry cycle instead of
              // being treated as already-infinitely-stale on the first tick.
              if (!node.lastSeen) node.lastSeen = loadTimeIso;
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

  /**
   * Forget what was learned about a target: its services, links, metric history (the baselines), connection traces and
   * edge rates. The target itself stays registered, so collection starts again from a clean slate on the next cycle.
   */
  public clearProjectData(targetId: string): void {
    const prefix = `${targetId}:`;
    for (const id of this.nodesByTarget.get(targetId)?.keys() ?? []) this.metricStore.deleteNode(id);
    this.nodesByTarget.set(targetId, new Map());
    this.edgesByTarget.set(targetId, new Map());
    for (const m of [this.edgeActivity, this.edgeConns, this.edgeBaselines] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
    this.connPrimed.delete(targetId);
    this.lastEdgeReportAt.delete(targetId);
    void this.getTraceStore(targetId).clear();
    this.scheduleSave();
    this.requestBroadcast();
  }

  /** Stop watching a target and drop everything held about it. */
  public removeProject(targetId: string): void {
    this.discoveryEngine.stopTarget(targetId);
    this.clearProjectData(targetId);
    this.nodesByTarget.delete(targetId);
    this.edgesByTarget.delete(targetId);
    this.targets.delete(targetId);
    this.traceStores.delete(targetId);
    this.scheduleSave();
    this.requestBroadcast();
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
            // A reachable website says nothing about telemetry: it no longer refreshes lastSeen, which made a
            // target with zero collected services show as LIVE. Status comes from telemetry only (see touchTarget).
            target.endpointStatus = 'REACHABLE';
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
    for (const [targetId, target] of this.targets.entries()) {
      if (target.lastSeen) {
        const diff = now - new Date(target.lastSeen).getTime();
        // Wider thresholds: STALE after 2min, OFFLINE after 5min
        if (diff > 300000) target.status = 'OFFLINE';
        else if (diff > 120000) target.status = 'STALE';
        else target.status = 'LIVE';
        // Frozen readings must not keep painting services green or red: with no data from the host, every service of
        // that target is unknown until telemetry resumes (the next ingest writes the real status back).
        if (target.status !== 'LIVE') {
          for (const n of this.nodesByTarget.get(targetId)?.values() ?? []) {
            if (n.status !== 'unknown') { n.status = 'unknown'; n.metadata = { ...n.metadata, statusReason: `no telemetry from the host for ${Math.round(diff / 60000)} min` }; }
          }
        }
      } else {
        target.status = 'NO DATA';
      }
    }
  }

  // A container that restarts onto a new container id, or a one-off
  // discovery/metric match failure, used to leave a permanent ghost node
  // behind (e.g. "unknown-<hash>") since nodes were only ever upserted,
  // never removed. Anything not touched by a real discovery or telemetry
  // update in a while is almost certainly gone — drop it, and any edge
  // that pointed at it, rather than let the graph accumulate forever.
  // Deliberately longer than checkTargetStaleness()'s 5min OFFLINE
  // threshold: on these resource-constrained EC2 hosts, SSH channel
  // exhaustion has been observed to black out ALL commands (discovery and
  // telemetry alike) for several minutes at a stretch. Pruning on the same
  // 5min clock as OFFLINE would wipe every node the moment a target goes
  // OFFLINE, even though it typically recovers on its own — so give it
  // extra room to reconnect and reconfirm before treating nodes as gone.
  private static readonly STALE_NODE_MS = 900_000;
  /** Request metrics older than this with nothing newer are dropped. */
  private static readonly REQUEST_METRICS_TTL_MS = 60_000;
  /**
   * An observed edge that the target has stopped reporting for this long,
   * while it keeps reporting others, is treated as no longer in use.
   */
  private static readonly STALE_EDGE_MS = 600_000;
  /** Per target: when it last reported any observed edge at all. */
  private lastEdgeReportAt = new Map<string, number>();
  /** Coalescing state for graph-update broadcasts — see requestBroadcast(). */
  private broadcastTimer: NodeJS.Timeout | null = null;
  private lastBroadcastAt = 0;
  private static readonly BROADCAST_MIN_INTERVAL_MS = 3_000;
  /** Slow reference level of each edge's traffic — see applyEdgeActivity. */
  private edgeBaselines = new Map<string, { value: number; at: number }>();
  private static readonly BASELINE_RISE_MS = 60_000;
  private static readonly BASELINE_FALL_MS = 600_000;
  private static readonly BASELINE_MIN_WINDOW_MS = 20_000;

  private pruneStaleNodes() {
    const now = Date.now();
    for (const [targetId, nodesMap] of this.nodesByTarget.entries()) {
      const removedIds = new Set<string>();
      for (const [id, node] of nodesMap.entries()) {
        const age = node.lastSeen ? now - new Date(node.lastSeen).getTime() : Infinity;
        if (age > GraphStore.STALE_NODE_MS) {
          nodesMap.delete(id);
          this.metricStore.deleteNode(id);
          removedIds.add(id);
        }
      }
      if (removedIds.size === 0) continue;

      const edgesMap = this.edgesByTarget.get(targetId);
      if (edgesMap) {
        for (const [edgeId, edge] of edgesMap.entries()) {
          if (removedIds.has(edge.source) || removedIds.has(edge.target)) {
            edgesMap.delete(edgeId);
            // The activity counter is keyed by edge id and was never
            // cleaned up, so every pruned edge leaked an entry that grew
            // for the lifetime of the process.
            this.edgeActivity.delete(edgeId);
            this.edgeConns.delete(edgeId);
            this.edgeBaselines.delete(edgeId);
          }
        }
      }
      console.log(`[GRAPH] target=${targetId} pruned ${removedIds.size} stale node(s): ${[...removedIds].join(', ')}`);
      this.scheduleSave();
    }
  }

  /**
   * Let go of observed edges that have stopped being observed.
   *
   * Nothing used to do this: once an edge was seen it stayed `observed`
   * forever, unless one of its nodes was pruned. So a dependency a service
   * stopped using was drawn as live indefinitely, and — the reason this
   * matters now — the reverse-duplicate edges recorded before direction was
   * recovered from listening ports (one real link stored as A->B *and* B->A)
   * would have sat in the graph permanently, keeping every false cycle alive.
   *
   * Expiry is measured against the target's own most recent edge report, not
   * wall-clock time. If the target has gone quiet — an SSH outage, which on
   * these hosts is common and usually recovers — nothing expires, because
   * silence there says nothing about any particular link. Only an edge the
   * target *keeps not reporting while reporting others* is let go.
   */
  /**
   * Ask for the current graph to be pushed to every browser, at most once per
   * BROADCAST_MIN_INTERVAL_MS.
   *
   * Five places broadcast the full graph, one of them after every telemetry
   * envelope from every target. Measured live: 66 full-graph pushes a minute
   * (~130 KB each, 8.5 MB/min), and the client rebuilds on each — roughly one
   * 120 ms main-thread stall every 1.7 seconds. Collection runs on a 5-second
   * cycle, so nothing is gained by pushing faster than this; a burst of
   * requests collapses into one broadcast carrying the newest state.
   */
  public requestBroadcast(): void {
    if (!this.wsManager || this.broadcastTimer) return;
    const wait = Math.max(0, this.lastBroadcastAt + GraphStore.BROADCAST_MIN_INTERVAL_MS - Date.now());
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.lastBroadcastAt = Date.now();
      this.wsManager?.broadcast('graph-update', this.getGraph());
    }, wait);
  }

  private pruneStaleEdges() {
    for (const [targetId, edgesMap] of this.edgesByTarget.entries()) {
      const reportAt = this.lastEdgeReportAt.get(targetId);
      if (reportAt === undefined) continue;

      let changed = 0;
      for (const [edgeId, edge] of edgesMap.entries()) {
        if (!edge.observed) continue;
        if (!edge.lastSeen) {
          // Loaded from before lastSeen was tracked: give it a full window.
          edge.lastSeen = new Date(reportAt).toISOString();
          continue;
        }
        if (reportAt - new Date(edge.lastSeen).getTime() <= GraphStore.STALE_EDGE_MS) continue;

        if (edge.declared) {
          // Still claimed by config, just no longer seen carrying traffic.
          edge.observed = false;
          edge.evidenceSources = edge.evidenceSources.filter(
            s => s !== 'network-tcp' && s !== 'http-log' && !s.startsWith('direction:'),
          );
          delete edge.activity;
          edge.status = 'unknown';
        } else {
          edgesMap.delete(edgeId);
        }
        this.edgeActivity.delete(edgeId);
        this.edgeConns.delete(edgeId);
        this.edgeBaselines.delete(edgeId);
        changed++;
      }
      if (changed > 0) {
        console.log(`[GRAPH] target=${targetId} expired ${changed} edge(s) no longer observed`);
        this.scheduleSave();
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

    // Update target lastSeen so it stays LIVE, but only when discovery actually found services:
    // an empty discovery is "no data", not a sign of life.
    const target = this.targets.get(targetId);
    const found = services.filter(s => !String(s?.name ?? '').includes('mapper-collector')).length;
    if (target && found > 0) {
      target.lastSeen = new Date().toISOString();
      target.status = 'LIVE';
    }

    for (const svc of services) {
      if (svc.name.includes('mapper-collector')) continue;
      const nodeId = svc.serviceId;
      const existing = nodesMap.get(nodeId);
      
      const st = String(svc.state ?? 'unknown');
      const status = st === 'running' ? 'healthy' : ['exited', 'dead', 'paused'].includes(st) ? 'critical' : st === 'restarting' ? 'degraded' : 'unknown';
      const nodeType = ['gateway', 'service', 'database', 'queue', 'frontend', 'infrastructure', 'external'].includes(svc.type) ? svc.type : 'service';
      
      const nowIso = new Date().toISOString();
      if (existing) {
        // Status is left to telemetry, which runs every 5s and sees restarts,
        // container state and resource pressure. Discovery runs every 3
        // minutes and only knows "it is running", so letting it write status
        // reset a degraded or crash-looping node to healthy on every rescan.
        existing.type = nodeType as any;
        existing.lastSeen = nowIso;
        existing.metadata = {
          ...existing.metadata,
          state: st,
          vanished: false,
          ...(svc.containerName ? { containerName: svc.containerName } : {}),
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
          lastSeen: nowIso,
          metadata: {
            state: st,
            ...(svc.containerName ? { containerName: svc.containerName } : {}),
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

    console.log(`[GRAPH] target=${targetId} services=${nodesMap.size} edges=${edgesMap.size}`);

    this.scheduleSave();
    this.requestBroadcast();
  }



  private anomalyScoresCache: { mtimeMs: number; data: Record<string, any> } | null = null;

  /** Reads ml/score.py's output file, re-reading only when it changes on
   * disk. Missing file (no models trained yet) is not an error — just no
   * scores to attach. */
  private readAnomalyScores(): Record<string, any> {
    const scoresPath = path.resolve(process.cwd(), '..', 'ml', 'data', 'latest_scores.json');
    try {
      const stat = fs.statSync(scoresPath);
      if (this.anomalyScoresCache?.mtimeMs === stat.mtimeMs) {
        return this.anomalyScoresCache.data;
      }
      const data = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
      this.anomalyScoresCache = { mtimeMs: stat.mtimeMs, data };
      return data;
    } catch {
      return {};
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

    // The ML scorer is a research tool. Its scores reach the product (risk, cascade, the 3D tags) only when switched on with
    // MAPPER_ML=1: trained on little data it calls a quiet, healthy system "100% anomalous", which then shows up as at-risk
    // services and red tags with no traffic and no fault at all. The statistical detector is what the product relies on.
    const scores = process.env.MAPPER_ML === '1' ? this.readAnomalyScores() : {};
    const now = Date.now();
    for (const node of allNodes) {
      const fresh = freshAnomalyScore(scores[node.id], now);
      if (fresh) {
        node.analytics = { ...node.analytics, anomalyScore: fresh.score, anomalyPersistent: fresh.persistent };
      } else if (node.analytics && ('anomalyScore' in node.analytics || 'anomalyPersistent' in node.analytics)) {
        // No current opinion: drop the old one rather than let it stand.
        const { anomalyScore: _score, anomalyPersistent: _persistent, ...rest } = node.analytics;
        node.analytics = rest;
      }
    }

    this.applyEdgeActivity(allEdges);

    return { nodes: allNodes, edges: allEdges, targets: Array.from(this.targets.values()) };
  }

  /** How long a connection key is remembered after it was last seen. Longer
   *  than TIME_WAIT (~60s), so a closing connection is not counted twice. */
  private static readonly CONN_MEMORY_MS = 150_000;
  /** Sweeps averaged into an edge's connection figures. */
  private static readonly CONN_WINDOW_MS = 120_000;

  /**
   * One socket sweep of a target: every event in it carries the same
   * timestamp. For each edge, counts distinct ESTABLISHED connections (open
   * now) and distinct keys never seen before (opened since the last sweep).
   * Edges of this target that had no sockets this sweep record a zero, so
   * the average reflects the time a link sat idle.
   */
  private recordConnectionSweep(targetId: string, events: any[], normalizeId: (id: string) => string): void {
    const keyed = events.filter((e) => typeof e.connKey === 'string');
    if (keyed.length === 0) return;
    const now = Date.now();
    const primed = this.connPrimed.has(targetId);
    const perEdge = new Map<string, { open: Set<string>; all: Set<string> }>();
    for (const ev of keyed) {
      const src = normalizeId(ev.sourceServiceId);
      const dst = normalizeId(ev.destServiceId);
      if (!src || !dst || src === dst) continue;
      const id = `${src}->${dst}`;
      const entry = perEdge.get(id) ?? { open: new Set<string>(), all: new Set<string>() };
      entry.all.add(ev.connKey);
      if (ev.state === 'ESTABLISHED') entry.open.add(ev.connKey);
      perEdge.set(id, entry);
    }
    const prefix = `${targetId}:`;
    const ids = new Set<string>([...perEdge.keys(), ...[...this.edgeConns.keys()].filter((id) => id.startsWith(prefix))]);
    for (const id of ids) {
      const track = this.edgeConns.get(id) ?? { seen: new Map<string, number>(), sweeps: [] };
      const sweep = perEdge.get(id);
      let fresh = 0;
      if (sweep) {
        for (const key of sweep.all) {
          if (!track.seen.has(key) && primed) fresh++;
          track.seen.set(key, now);
        }
      }
      track.sweeps.push({ at: now, open: sweep?.open.size ?? 0, fresh });
      for (const [key, at] of track.seen) if (now - at > GraphStore.CONN_MEMORY_MS) track.seen.delete(key);
      while (track.sweeps.length > 0 && now - track.sweeps[0].at > GraphStore.CONN_WINDOW_MS) track.sweeps.shift();
      this.edgeConns.set(id, track);
    }
    this.connPrimed.add(targetId);
  }

  /**
   * Turns the rolling connection counts into a per-minute rate. The window
   * resets once it has run long enough to be meaningful, so the figure
   * tracks current activity instead of drifting toward a lifetime average.
   * Edges with no observations are left without an `activity` field rather
   * than being given a zero — "never seen" and "measured as idle" are
   * different claims.
   */
  private applyEdgeActivity(edges: DependencyEdge[]): void {
    const now = Date.now();
    const WINDOW_RESET_MS = 120_000;

    for (const edge of edges) {
      const bucket = this.edgeActivity.get(edge.id);
      if (!bucket) continue;

      const elapsedMs = Math.max(1000, now - bucket.windowStart);
      const perMin = (bucket.count / elapsedMs) * 60_000;

      // Asymmetric exponential average, time-based so it is correct however
      // often getGraph() happens to be called: quick to rise, slow to fall.
      //
      // Only fed once the rate window is long enough to mean something. A
      // window of a second or two turns three events into "180/min"; the fast
      // rise would absorb that artefact and the slow decay would then hold it
      // for ten minutes — observed as a 171/min baseline on a 90/min link.
      const prev = this.edgeBaselines.get(edge.id);
      let baseline: number | undefined = prev?.value;
      if (elapsedMs >= GraphStore.BASELINE_MIN_WINDOW_MS) {
        if (prev) {
          const dt = Math.max(0, now - prev.at);
          const tau = perMin >= prev.value ? GraphStore.BASELINE_RISE_MS : GraphStore.BASELINE_FALL_MS;
          baseline = prev.value + (perMin - prev.value) * (1 - Math.exp(-dt / tau));
        } else {
          baseline = perMin;
        }
        this.edgeBaselines.set(edge.id, { value: baseline, at: now });
      }

      // Distinct-connection figures, once at least two sweeps exist: open
      // connections averaged over the window, and connections opened per
      // minute (each counted once, however many sweeps saw it linger).
      const conns = this.edgeConns.get(edge.id);
      let connFields = {};
      if (conns && conns.sweeps.length >= 2) {
        const span = Math.max(30_000, conns.sweeps[conns.sweeps.length - 1].at - conns.sweeps[0].at);
        const avgOpen = conns.sweeps.reduce((sum, w) => sum + w.open, 0) / conns.sweeps.length;
        const opened = conns.sweeps.slice(1).reduce((sum, w) => sum + w.fresh, 0);
        connFields = {
          openConnections: Math.round(avgOpen * 10) / 10,
          newConnectionsPerMin: Math.round((opened / span) * 60_000 * 10) / 10,
          connectionSweeps: conns.sweeps.length,
        };
      }

      edge.activity = {
        samplesPerMin: Math.round(perMin * 10) / 10,
        windowSec: Math.round(elapsedMs / 1000),
        lastSeen: new Date().toISOString(),
        ...(baseline !== undefined ? { baselinePerMin: Math.round(baseline * 10) / 10 } : {}),
        ...connFields,
      };

      if (elapsedMs > WINDOW_RESET_MS) {
        // Carry half the count forward so the rate decays instead of
        // snapping to zero the instant a window rolls over.
        this.edgeActivity.set(edge.id, { count: Math.floor(bucket.count / 2), windowStart: now - WINDOW_RESET_MS / 2 });
      }
    }
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
    const defaultPort = targetId === 'vertikal' ? 54321 : (targetId === 'open-telemetry' || targetId === 'death-star' ? 8080 : 80);
    const port = existingTarget?.publicPort || defaultPort;
    const hostToUse = (existingTarget?.host && existingTarget.host !== 'unknown') ? existingTarget.host : remoteHost;

    this.upsertTarget({
      targetId,
      displayName: targetId === 'sock-shop' ? 'Sock Shop AWS' : (targetId === 'vertikal' ? 'Vertikal AWS' : targetId),
      environment: 'remote',
      host: hostToUse,
      transport: 'http',
      status: 'LIVE',
      lastSeen: new Date().toISOString(),
      baseUrl: hostToUse !== 'unknown' ? `http://${hostToUse}:${port}` : existingTarget?.baseUrl,
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: true }
    });

    const nodesMap = this.getTargetNodes(targetId);
    const edgesMap = this.getTargetEdges(targetId);
    
    const normalizeId = (rawId: string) => {
      if (!rawId || rawId === 'external' || rawId === 'unknown-upstream') return rawId;
      const clean = rawId.replace(new RegExp(`^${targetId}[-:/]`), '');
      return `${targetId}:${clean}`;
    };

    if (events.nodes) {
      const nowIso = new Date().toISOString();
      for (const node of events.nodes) {
        if (!node.project) node.project = targetId;
        node.id = normalizeId(node.id);
        // Tier 1/2 request metrics ride along on the envelope when a source
        // produced them. Merged rather than assigned, so a cycle where the
        // optional source was unavailable does not wipe the resource metrics
        // the agentless path collected in the same cycle.
        const req = (node as any).requestMetrics;
        delete (node as any).requestMetrics;

        const existing = nodesMap.get(node.id);
        if (existing) {
          existing.status = node.status;
          existing.lastSeen = nowIso;
          if (node.metadata) existing.metadata = { ...existing.metadata, ...node.metadata };
          if (req) {
            existing.metrics = { ...(existing.metrics ?? {}), ...req } as any;
          } else if (existing.metrics?.provenance) {
            // No request metrics this cycle. Keep the last ones briefly — an
            // optional source can miss a cycle — but not indefinitely, or a
            // source that went away leaves a latency figure on screen that
            // nothing is measuring any more.
            const age = Date.now() - new Date(existing.metrics.provenance.observedAt).getTime();
            if (!(age < GraphStore.REQUEST_METRICS_TTL_MS)) {
              const { latency, requestRate, errorRate, provenance, ...rest } = existing.metrics as any;
              void latency; void requestRate; void errorRate; void provenance;
              for (const k of ['latencyP50', 'latencyP95', 'latencyP99']) delete rest[k];
              existing.metrics = rest;
            }
          }
        } else {
          node.lastSeen = nowIso;
          if (req) node.metrics = { ...(node.metrics ?? {}), ...req };
          nodesMap.set(node.id, node);
        }
      }
    }
    
    if (events.edges) {
      if (events.edges.some((e: DependencyEdge) => e.observed)) this.lastEdgeReportAt.set(targetId, Date.now());
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
          // Merge the Tier 0 resource fields over whatever is already there.
          // This used to assign a fresh object with latency/requestRate/
          // errorRate hardcoded to null — and since nodes are processed above
          // this loop, it wiped the Tier 1/2 request metrics (and their
          // provenance) that had been merged in from the same envelope a
          // moment earlier. Request-level data never survived a cycle.
          // Missing readings stay missing (undefined) rather than becoming 0,
          // so the UI shows "—" instead of a confident "0%".
          const r1 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);
          const raw = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
          const snap = m.snapshot as any;
          node.metrics = {
            ...(node.metrics ?? {}),
            cpu: r1(snap.cpu),
            memory: raw(snap.memory),
            memoryPercent: r1(snap.memoryPercent),
            networkRx: raw(snap.networkRx),
            networkTx: raw(snap.networkTx),
            networkRxRate: raw(snap.networkRxRate),
            networkTxRate: raw(snap.networkTxRate),
            ...(snap.requestRate !== undefined && snap.requestRate !== null ? {
              requestRate: raw(snap.requestRate), errorRate: raw(snap.errorRate) ?? undefined,
              latency: raw(snap.latency) ?? undefined, latencyP95: raw(snap.p95Latency) ?? undefined,
            } : {}),
            requestCount: raw(snap.requestCount),
            cpuThrottledPct: raw(snap.cpuThrottledPct),
            restartDelta: raw(snap.restartDelta),
            cpuAllowanceCores: raw(snap.cpuAllowanceCores),
            cpuOfAllowance: r1(snap.cpuOfAllowance),
          };
        }
      }
    }
    
    if (events.interactions) {
      if (events.interactions.length > 0) this.lastEdgeReportAt.set(targetId, Date.now());
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

    // Ingest raw connection events for the Traces feature
    if (events.connectionEvents && events.connectionEvents.length > 0) {
      const traceStore = this.getTraceStore(targetId);
      traceStore.saveEvents(events.connectionEvents).catch(err => {
        console.error(`[TRACES] Failed to save connection events for ${targetId}:`, err);
      });
      // Broadcast connection events to WebSocket for real-time Traces UI
      if (this.wsManager) {
        this.wsManager.broadcast('trace-events', {
          targetId,
          events: events.connectionEvents
        });
      }
      console.log(`[TRACES] target=${targetId} connectionEvents=${events.connectionEvents.length}`);

      // Roll up per-edge connection activity. This is the only real
      // measure of how busy a link is — edge.metrics (latency, errors,
      // request rate) is null for every edge here because nothing collects
      // HTTP-level data, so activity is what the heat scale can honestly
      // be driven by.
      for (const ev of events.connectionEvents) {
        const src = normalizeId(ev.sourceServiceId);
        const dst = normalizeId(ev.destServiceId);
        if (!src || !dst || src === dst) continue;
        const key = `${src}->${dst}`;
        const bucket = this.edgeActivity.get(key) ?? { count: 0, windowStart: Date.now() };
        bucket.count += 1;
        this.edgeActivity.set(key, bucket);
      }
      this.recordConnectionSweep(targetId, events.connectionEvents, normalizeId);
    }
    
    // Edge status/color comes only from evidence measured on that edge
    // (below) — an overloaded node shows its own stress on its own card,
    // it doesn't get smeared onto every edge touching it, since we have no
    // actual latency/error data for most of those edges.
    for (const edge of edgesMap.values()) {
      const edgeMetrics = this.metricStore.getAggregatedEdgeMetrics(edge.source, edge.target);
      if (edgeMetrics && edgeMetrics.requestCount > 0) {
        edge.observed = true;
        if (!edge.evidenceSources.includes('http-log')) {
          edge.evidenceSources.push('http-log');
        }
        edge.metrics = edgeMetrics;
        // Same thresholds as the edge colours (see linkThresholds.ts). This
        // used >5% / >500ms while the colours used 1%/300ms and 5%/1s, so a
        // link could be drawn orange while its own status said "active".
        edge.status = linkStatus(edgeMetrics.errorRate, (edgeMetrics as any).p95Latency ?? edgeMetrics.latency);
      } else if (edge.status === 'degraded' || edge.status === 'failed') {
        // no current edge-level evidence to justify this — don't leave a
        // stale bad status sitting there forever
        edge.status = edge.observed ? 'active' : 'unknown';
      }
    }

    this.updateTargetDiscoverySummaries();
    this.scheduleSave();
    this.requestBroadcast();
  }

  /** Get or create a TraceStore for a target. Used by TraceRouter and ingestRemote. */
  getTraceStore(targetId: string): TraceStore {
    let store = this.traceStores.get(targetId);
    if (!store) {
      store = new TraceStore(targetId);
      this.traceStores.set(targetId, store);
    }
    return store;
  }
}