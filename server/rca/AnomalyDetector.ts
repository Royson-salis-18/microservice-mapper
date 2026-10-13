import type { MetricStore } from '../telemetry/MetricStore.js';
import type { AnomalyRecord, IncidentSeverity } from '../models/Incident.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import { loadThresholds, type IncidentThresholds } from './thresholds.js';

export class AnomalyDetector {
  /**
   * When each ongoing anomaly (node + metric) was first seen.
   *
   * Anomalies are re-derived from scratch every cycle, and used to be stamped
   * with that cycle's time. So every anomaly in an evaluation carried the same
   * timestamp, "earliest" fell back to array order, and the root-cause
   * engine's temporal-precedence credit (+0.30, its second-largest factor) went
   * to whichever service was discovered first rather than whichever started
   * failing first. An anomaly now keeps the time it first appeared for as
   * long as it persists, and is forgotten once it clears.
   */
  private onsets = new Map<string, string>();

  constructor(private metricStore: MetricStore) {}

  public detectAnomaliesForTarget(targetId: string, nodes: ServiceNode[]): AnomalyRecord[] {
    const anomalies = this.detectRaw(targetId, nodes);

    const now = new Date().toISOString();
    const active = new Set<string>();
    for (const a of anomalies) {
      const key = `${a.nodeId}|${a.metric}`;
      active.add(key);
      const onset = this.onsets.get(key);
      if (onset) a.timestamp = onset;
      else this.onsets.set(key, a.timestamp ?? now);
    }
    for (const key of this.onsets.keys()) {
      if (key.startsWith(`${targetId}:`) && !active.has(key)) this.onsets.delete(key);
    }
    return anomalies;
  }

  private detectRaw(targetId: string, nodes: ServiceNode[]): AnomalyRecord[] {
    const anomalies: AnomalyRecord[] = [];
    const now = new Date().toISOString();
    // Read per pass, so an edit in the UI takes effect on the next detection
    // cycle without a restart.
    const t = loadThresholds();

    for (const node of nodes) {
      if (node.project !== targetId) continue;

      // 1. Check Container Health & Status Anomaly
      if (node.status === 'critical' || /^(exited|dead|restarting)/.test(String(node.metadata?.state ?? ''))) {
        anomalies.push({
          id: `anomaly-${node.id}-health-${Date.now()}`,
          nodeId: node.id,
          targetId,
          metric: 'container-health',
          timestamp: now,
          observedValue: 0,
          baselineMean: 1,
          baselineStdDev: 0,
          zScore: 99.0,
          severity: 'CRITICAL',
          evidenceSource: 'container-runtime'
        });
      }

      // 2. Resource metrics against the service's own recent history.
      //
      // The baseline is the history *before* the last minute, not all of it.
      // Including the newest samples meant an anomaly diluted its own
      // reference: after ~15s at 97% CPU the high samples had pulled the mean
      // up and the spread wide enough that 97% no longer looked unusual, so a
      // sustained problem stopped being detected almost as soon as it began.
      // Measured on a simulated saturation: zero anomalies raised.
      const history = this.metricStore.getHistory(node.id, '15m');
      const cutoff = Date.now() - AnomalyDetector.BASELINE_LAG_MS;
      const baseline = history.filter(h => {
        const ts = Date.parse(h.timestamp);
        return Number.isFinite(ts) && ts < cutoff;
      });

      for (const [metric, current, pick] of [
        ['cpu', node.metrics?.cpu, (h: any) => h.cpu],
        ['memoryPercent', node.metrics?.memoryPercent, (h: any) => h.memoryPercent],
      ] as const) {
        if (typeof current !== 'number' || !Number.isFinite(current)) continue;
        // Samples where the reading was not taken are left out of the
        // baseline. They used to be counted as 0, which dragged the mean down
        // and widened the spread, so a real rise looked less unusual than it
        // was.
        const values = baseline.map(pick).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        // Cold start: too little history to judge "unusual for this service",
        // so no z-score — but a fixed absolute limit still applies, since that
        // is a rule rather than a guess and needs no history.
        const z = values.length >= t.minHistorySamples
          ? this.calculateZScore(values, current, metric, node.id, targetId, now, t)
          : null;
        // The fixed limit is about saturation, so for CPU it is checked
        // against the share of the container's allowance, not docker's
        // per-core percentage (180% is half of a 4-core allowance).
        const share = metric === 'cpu' && typeof node.metrics?.cpuOfAllowance === 'number' ? node.metrics.cpuOfAllowance : current;
        const anomaly = z ?? this.absoluteThreshold(share, metric, node.id, targetId, now, t, values);
        if (anomaly) anomalies.push(anomaly);
      }
    }

    return anomalies;
  }

  /** Samples newer than this are excluded from the baseline they are judged against. */
  private static readonly BASELINE_LAG_MS = 60_000;

  /**
   * Fixed limits that fire regardless of deviation, as the threshold docs
   * have always said: "HIGH regardless of deviation". The code used to check
   * them only after the z-score test had already passed, so a service that
   * sat at 97% CPU without deviating enough from its own recent history was
   * never flagged at all.
   */
  private absoluteThreshold(
    currentValue: number,
    metric: string,
    nodeId: string,
    targetId: string,
    timestamp: string,
    t: IncidentThresholds,
    baselineValues: number[],
  ): AnomalyRecord | null {
    if (!(currentValue > t.absoluteHighPercent)) return null;
    const mean = baselineValues.length > 0 ? baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length : currentValue;
    return {
      id: `anomaly-${nodeId}-${metric}-${Date.now()}`,
      nodeId,
      targetId,
      metric,
      timestamp,
      observedValue: currentValue,
      baselineMean: Math.round(mean * 10) / 10,
      baselineStdDev: 0,
      zScore: 0,
      severity: currentValue > t.absoluteCriticalPercent ? 'CRITICAL' : 'HIGH',
      evidenceSource: 'absolute-threshold',
    };
  }

  private calculateZScore(
    values: number[],
    currentValue: number,
    metric: string,
    nodeId: string,
    targetId: string,
    timestamp: string,
    t: IncidentThresholds
  ): AnomalyRecord | null {
    if (values.length === 0) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Safe zero-variance handling
    if (stdDev < t.flatlineStdDev) {
      if (Math.abs(currentValue - mean) > t.flatlineDeltaPercent) {
        return {
          id: `anomaly-${nodeId}-${metric}-${Date.now()}`,
          nodeId,
          targetId,
          metric,
          timestamp,
          observedValue: currentValue,
          baselineMean: mean,
          baselineStdDev: 0.1,
          zScore: 5.0,
          severity: currentValue > t.flatlineCriticalPercent ? 'CRITICAL' : 'HIGH',
          evidenceSource: 'dynamic-baseline'
        };
      }
      return null;
    }

    const zScore = (currentValue - mean) / stdDev;

    // A statistically large move can still be practically nothing: a service
    // whose memory never leaves 0.4% has a spread of ~0.01, so 0.4% -> 0.5% is
    // "eight standard deviations". Both tests have to pass.
    if (Math.abs(currentValue - mean) < t.minDeviationPercent) return null;

    // Every bound here comes from data/incident_thresholds.json (see
    // thresholds.ts), so what fires an incident is visible and editable
    // rather than buried in this file.
    if (Math.abs(zScore) >= t.zScoreAnomaly) {
      let severity: IncidentSeverity = 'LOW';
      if (Math.abs(zScore) >= t.zScoreCritical || currentValue > t.absoluteCriticalPercent) severity = 'CRITICAL';
      else if (Math.abs(zScore) >= t.zScoreHigh || currentValue > t.absoluteHighPercent) severity = 'HIGH';
      else severity = 'MEDIUM';

      return {
        id: `anomaly-${nodeId}-${metric}-${Date.now()}`,
        nodeId,
        targetId,
        metric,
        timestamp,
        observedValue: currentValue,
        baselineMean: Math.round(mean * 10) / 10,
        baselineStdDev: Math.round(stdDev * 10) / 10,
        zScore: Math.round(zScore * 100) / 100,
        severity,
        evidenceSource: 'dynamic-zscore'
      };
    }

    return null;
  }
}
