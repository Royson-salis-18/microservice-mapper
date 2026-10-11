import type { MetricStore } from '../telemetry/MetricStore.js';
import type { AnomalyRecord, IncidentSeverity } from '../models/Incident.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import { loadThresholds, type IncidentThresholds } from './thresholds.js';

/**
 * Per-service anomaly rules. Three things changed after measuring them on real
 * traffic (rca-lab, docs/WHAT_IS_WRONG.md):
 *  - the baseline is the median and MAD of the history BEFORE the samples being
 *    judged; the old mean/std over a window that contained the anomaly let a
 *    fault inflate its own baseline and let one spike move the mean;
 *  - an anomaly needs the last TWO samples to agree (persistence); a single
 *    sample above z = 2.5 is what a noisy-but-healthy service does every few
 *    minutes, and that is how detectors end up at dozens of false alarms per hour;
 *  - a missing reading is unknown, not 0 (reading it as 0 made every gap look
 *    like a drop).
 */
const MAD_TO_STD = 1.4826;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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

      // 1. Container state. 'paused' is a frozen process: Docker still lists it,
      // it answers nothing, and before this it was invisible here.
      const state = node.metadata?.state as string | undefined;
      if (node.status === 'critical' || state === 'exited' || state === 'dead' || state === 'paused') {
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
          reason: state === 'paused' ? 'container-paused' : 'container-exited-or-critical',
          severity: 'CRITICAL',
          evidenceSource: 'container-runtime'
        });
      }

      // 2. Metrics against the service's own recent past.
      const history = this.metricStore.getHistory(node.id, '15m');
      const metrics: [string, (h: MetricSnapshot) => number | undefined, number | undefined][] = [
        ['cpu', h => h.cpu, node.metrics?.cpu],
        ['memoryPercent', h => h.memoryPercent, node.metrics?.memoryPercent],
      ];
      for (const [metric, pick, current] of metrics) {
        const series = history.map(pick).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (typeof current !== 'number' || !Number.isFinite(current)) continue;
        // Cold start: not enough history to say what normal is, so say nothing.
        if (series.length < t.minHistorySamples + 2) continue;
        const baseline = series.slice(0, -2);              // never contains the samples being judged
        const previous = series[series.length - 2];
        const anomaly = this.calculateZScore(baseline, [previous, current], metric, node.id, targetId, now, t);
        if (anomaly) anomalies.push(anomaly);
      }
    }

    return anomalies;
  }

  /**
   * recent = [previous, current]. Both must deviate in the same direction for an
   * anomaly (persistence); the reported value and z are the current sample's.
   */
  public calculateZScore(
    baseline: number[],
    recent: number[],
    metric: string,
    nodeId: string,
    targetId: string,
    timestamp: string,
    t: IncidentThresholds
  ): AnomalyRecord | null {
    if (baseline.length === 0 || recent.length === 0) return null;
    const currentValue = recent[recent.length - 1];
    const center = median(baseline);
    const spread = median(baseline.map(v => Math.abs(v - center))) * MAD_TO_STD;

    // Flat baseline: a z-score would divide by ~0, so judge absolute movement,
    // still on every recent sample.
    if (spread < t.flatlineStdDev) {
      const jumped = recent.every(v => Math.abs(v - center) > t.flatlineDeltaPercent);
      if (!jumped) return null;
      return {
        id: `anomaly-${nodeId}-${metric}-${Date.now()}`,
        nodeId,
        targetId,
        metric,
        timestamp,
        observedValue: currentValue,
        baselineMean: center,
        baselineStdDev: 0,
        zScore: null,
        reason: 'flat-baseline-jump',
        severity: currentValue > t.flatlineCriticalPercent ? 'CRITICAL' : 'HIGH',
        evidenceSource: 'dynamic-baseline'
      };
    }

    const zs = recent.map(v => (v - center) / spread);
    const sameSide = zs.every(z => z > 0) || zs.every(z => z < 0);
    const weakest = Math.min(...zs.map(Math.abs));
    if (!sameSide || weakest < t.zScoreAnomaly) return null;
    if (Math.abs(currentValue - center) < t.minDeltaPercent) return null;

    const zScore = zs[zs.length - 1];
    let severity: IncidentSeverity = 'MEDIUM';
    if (Math.abs(zScore) >= t.zScoreCritical || currentValue > t.absoluteCriticalPercent) severity = 'CRITICAL';
    else if (Math.abs(zScore) >= t.zScoreHigh || currentValue > t.absoluteHighPercent) severity = 'HIGH';

    return {
      id: `anomaly-${nodeId}-${metric}-${Date.now()}`,
      nodeId,
      targetId,
      metric,
      timestamp,
      observedValue: currentValue,
      baselineMean: Math.round(center * 10) / 10,          // the baseline median (field name kept for the UI)
      baselineStdDev: Math.round(spread * 10) / 10,        // 1.4826 x MAD
      zScore: Math.round(zScore * 100) / 100,
      reason: 'robust-zscore-persistent',
      severity,
      evidenceSource: 'dynamic-zscore'
    };
  }
}
