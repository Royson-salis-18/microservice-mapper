import type { MetricStore } from '../telemetry/MetricStore.js';
import type { AnomalyRecord, IncidentSeverity } from '../models/Incident.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import { loadThresholds, type IncidentThresholds } from './thresholds.js';

export class AnomalyDetector {
  constructor(private metricStore: MetricStore) {}

  public detectAnomaliesForTarget(targetId: string, nodes: ServiceNode[]): AnomalyRecord[] {
    const anomalies: AnomalyRecord[] = [];
    const now = new Date().toISOString();
    // Read per pass, so an edit in the UI takes effect on the next detection
    // cycle without a restart.
    const t = loadThresholds();

    for (const node of nodes) {
      if (node.project !== targetId) continue;

      // 1. Check Container Health & Status Anomaly
      if (node.status === 'critical' || node.metadata?.state === 'exited' || node.metadata?.state === 'dead') {
        anomalies.push({
          id: `anomaly-${node.id}-health-${Date.now()}`,
          nodeId: node.id,
          targetId,
          metric: 'container-health',
          timestamp: now,
          observedValue: 0,
          baselineMean: 1,
          baselineStdDev: 0,
          zScore: null,
          reason: 'container-exited-or-critical',
          severity: 'CRITICAL',
          evidenceSource: 'container-runtime'
        });
      }

      // 2. Metric History Baseline & Dynamic Z-Score Analysis
      const history = this.metricStore.getHistory(node.id, '15m');
      if (history.length < t.minHistorySamples) {
        // Cold start or insufficient historical data - skip anomaly detection until baseline is established
        continue;
      }

      // Evaluate CPU Dynamic Z-Score
      const cpuValues = history.map(h => h.cpu || 0);
      const currentCpu = node.metrics?.cpu || 0;
      const cpuAnomaly = this.calculateZScore(cpuValues, currentCpu, 'cpu', node.id, targetId, now, t);
      if (cpuAnomaly) anomalies.push(cpuAnomaly);

      // Evaluate Memory Dynamic Z-Score
      const memValues = history.map(h => h.memoryPercent || 0);
      const currentMem = node.metrics?.memoryPercent || 0;
      const memAnomaly = this.calculateZScore(memValues, currentMem, 'memoryPercent', node.id, targetId, now, t);
      if (memAnomaly) anomalies.push(memAnomaly);
    }

    return anomalies;
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
          baselineStdDev: Math.round(stdDev * 1000) / 1000,
          zScore: null,
          reason: 'flat-baseline-jump',
          severity: currentValue > t.flatlineCriticalPercent ? 'CRITICAL' : 'HIGH',
          evidenceSource: 'dynamic-baseline'
        };
      }
      return null;
    }

    const zScore = (currentValue - mean) / stdDev;
    if (Math.abs(currentValue - mean) < t.minDeltaPercent) return null;

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
        reason: 'zscore',
        severity,
        evidenceSource: 'dynamic-zscore'
      };
    }

    return null;
  }
}
