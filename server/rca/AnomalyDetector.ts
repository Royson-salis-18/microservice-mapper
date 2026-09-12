import type { MetricStore } from '../telemetry/MetricStore.js';
import type { AnomalyRecord, IncidentSeverity } from '../models/Incident.js';
import type { ServiceNode } from '../models/ServiceNode.js';

export class AnomalyDetector {
  constructor(private metricStore: MetricStore) {}

  public detectAnomaliesForTarget(targetId: string, nodes: ServiceNode[]): AnomalyRecord[] {
    const anomalies: AnomalyRecord[] = [];
    const now = new Date().toISOString();

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
          zScore: 99.0,
          severity: 'CRITICAL',
          evidenceSource: 'container-runtime'
        });
      }

      // 2. Metric History Baseline & Dynamic Z-Score Analysis
      const history = this.metricStore.getHistory(node.id, '15m');
      if (history.length < 3) {
        // Cold start or insufficient historical data - evaluate absolute bounds only
        if (node.metrics) {
          if ((node.metrics.cpu || 0) > 85) {
            anomalies.push({
              id: `anomaly-${node.id}-cpu-${Date.now()}`,
              nodeId: node.id,
              targetId,
              metric: 'cpu',
              timestamp: now,
              observedValue: node.metrics.cpu || 0,
              baselineMean: 50,
              baselineStdDev: 10,
              zScore: 3.5,
              severity: 'HIGH',
              evidenceSource: 'container-stats'
            });
          }
          if ((node.metrics.memoryPercent || 0) > 85) {
            anomalies.push({
              id: `anomaly-${node.id}-mem-${Date.now()}`,
              nodeId: node.id,
              targetId,
              metric: 'memoryPercent',
              timestamp: now,
              observedValue: node.metrics.memoryPercent || 0,
              baselineMean: 50,
              baselineStdDev: 10,
              zScore: 3.5,
              severity: 'HIGH',
              evidenceSource: 'container-stats'
            });
          }
        }
        continue;
      }

      // Evaluate CPU Dynamic Z-Score
      const cpuValues = history.map(h => h.cpu || 0);
      const currentCpu = node.metrics?.cpu || 0;
      const cpuAnomaly = this.calculateZScore(cpuValues, currentCpu, 'cpu', node.id, targetId, now);
      if (cpuAnomaly) anomalies.push(cpuAnomaly);

      // Evaluate Memory Dynamic Z-Score
      const memValues = history.map(h => h.memoryPercent || 0);
      const currentMem = node.metrics?.memoryPercent || 0;
      const memAnomaly = this.calculateZScore(memValues, currentMem, 'memoryPercent', node.id, targetId, now);
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
    timestamp: string
  ): AnomalyRecord | null {
    if (values.length === 0) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Safe zero-variance handling
    if (stdDev < 0.001) {
      if (Math.abs(currentValue - mean) > 30) {
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
          severity: currentValue > 80 ? 'CRITICAL' : 'HIGH',
          evidenceSource: 'dynamic-baseline'
        };
      }
      return null;
    }

    const zScore = (currentValue - mean) / stdDev;

    // Threshold: Z-score > 2.5 or Z-score < -2.5 is anomalous
    if (Math.abs(zScore) >= 2.5) {
      let severity: IncidentSeverity = 'LOW';
      if (Math.abs(zScore) >= 4.0 || currentValue > 85) severity = 'CRITICAL';
      else if (Math.abs(zScore) >= 3.0 || currentValue > 70) severity = 'HIGH';
      else if (Math.abs(zScore) >= 2.5) severity = 'MEDIUM';

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
