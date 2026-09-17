import type { GraphStore } from '../graph/GraphStore.js';
import type { MetricStore } from '../telemetry/MetricStore.js';
import type { TrafficController } from './TrafficController.js';
import { ExperimentStore, type ExperimentRecord } from './ExperimentStore.js';
import crypto from 'crypto';

export interface SafetyLimits {
  cpuThreshold: number; // e.g. 80 for 80%
  memoryThreshold: number; // e.g. 80 for 80%
  errorRateThreshold: number; // e.g. 0.05 for 5%
  latencyThreshold: number; // e.g. 1000 for 1000ms
}

export class ExperimentManager {
  private graphStore: GraphStore;
  private metricStore: MetricStore;
  private trafficController: TrafficController;
  public experimentStore: ExperimentStore;

  private activeExperiments: Map<string, string> = new Map(); // targetId -> experimentId
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(graphStore: GraphStore, metricStore: MetricStore, trafficController: TrafficController) {
    this.graphStore = graphStore;
    this.metricStore = metricStore;
    this.trafficController = trafficController;
    this.experimentStore = new ExperimentStore();
    this.startMonitoring();
  }

  public startExperiment(
    targetId: string, 
    workloadSource: 'EXTERNAL' | 'USER_SIM', 
    profile: string, 
    config: { mode: string; rate?: number; concurrency?: number; durationSeconds?: number },
    _limits?: SafetyLimits // accepted for API compatibility; no longer enforced, see checkSafetyLimits()
  ): string {
    const experimentId = crypto.randomUUID();
    
    const record: ExperimentRecord = {
      experimentId,
      targetId,
      workloadSource,
      profile,
      configuration: config,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      status: 'RUNNING',
      trafficStatistics: {
        requestsAttempted: 0,
        requestsCompleted: 0,
        requestsSuccessful: 0,
        requestsFailed: 0,
        timeouts: 0,
        durationSeconds: 0,
        peakRate: 0
      },
      peakObservedMetrics: {
        cpuPercent: 0,
        memoryPercent: 0,
        latencyP95: 0,
        errorRate: 0
      },
      affectedServices: []
    };

    this.experimentStore.createRecord(record);
    this.activeExperiments.set(targetId, experimentId);

    return experimentId;
  }

  public stopExperiment(targetId: string, reason: 'STOPPED' | 'ABORTED_SAFETY' = 'STOPPED') {
    const expId = this.activeExperiments.get(targetId);
    if (!expId) return;

    this.trafficController.stopTarget(targetId);
    // Also stop user-sim if it was running (handled by TrafficController)

    this.experimentStore.updateRecord(expId, {
      status: reason,
      stoppedAt: new Date().toISOString()
    });

    this.activeExperiments.delete(targetId);
  }

  public getActiveExperiment(targetId: string): ExperimentRecord | undefined {
    const id = this.activeExperiments.get(targetId);
    if (id) return this.experimentStore.getRecord(id);
    return undefined;
  }

  public updateExperimentStats(targetId: string, stats: any) {
    const expId = this.activeExperiments.get(targetId);
    if (!expId) return;

    this.experimentStore.updateRecord(expId, {
      trafficStatistics: {
        requestsAttempted: stats.attempted || 0,
        requestsCompleted: stats.completed || 0,
        requestsSuccessful: stats.successful || 0,
        requestsFailed: stats.failed || 0,
        timeouts: stats.timeouts || 0,
        durationSeconds: stats.duration || 0,
        peakRate: stats.peakRate || 0
      }
    });
  }

  private startMonitoring() {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.monitorInterval = setInterval(() => this.checkSafetyLimits(), 2000);
  }

  // Tracks peak CPU/memory. Does NOT abort on high usage/error rate anymore —
  // these are failure-injection experiments, services are supposed to break.
  private checkSafetyLimits() {
    for (const [targetId, expId] of this.activeExperiments.entries()) {
      const record = this.experimentStore.getRecord(expId);
      if (!record) continue;

      let maxCpu = 0;
      let maxMem = 0;

      const graph = this.graphStore.getGraph();
      const nodes = graph.nodes.filter(n => (n as any).targetId === targetId || n.id.startsWith(targetId));

      for (const node of nodes) {
        const metrics = (node as any).metrics;
        if (metrics) {
          if (metrics.cpu > maxCpu) maxCpu = metrics.cpu;
          if (metrics.memoryPercent > maxMem) maxMem = metrics.memoryPercent;
        }
      }

      const peaks = { ...record.peakObservedMetrics };
      if (maxCpu > peaks.cpuPercent) peaks.cpuPercent = maxCpu;
      if (maxMem > peaks.memoryPercent) peaks.memoryPercent = maxMem;

      this.experimentStore.updateRecord(expId, { peakObservedMetrics: peaks });
    }
  }
}
