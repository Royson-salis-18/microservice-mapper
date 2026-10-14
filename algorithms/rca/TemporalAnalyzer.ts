import type { AnomalyRecord } from '../../server/models/Incident.js';

export interface TemporalTimelinePoint {
  timestamp: string;
  nodeId: string;
  metric: string;
  zScore: number | null;
  observedValue: number;
  isEarliest: boolean;
}

export class TemporalAnalyzer {
  public buildTimeline(anomalies: AnomalyRecord[]): TemporalTimelinePoint[] {
    if (anomalies.length === 0) return [];

    // Sort anomalies chronologically by timestamp
    const sorted = [...anomalies].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const earliestMs = new Date(sorted[0].timestamp).getTime();

    return sorted.map((a) => {
      const aMs = new Date(a.timestamp).getTime();
      return {
        timestamp: a.timestamp,
        nodeId: a.nodeId,
        metric: a.metric,
        zScore: a.zScore,
        observedValue: a.observedValue,
        isEarliest: Math.abs(aMs - earliestMs) < 1000 // within 1 second of first anomaly
      };
    });
  }

  public findEarliestAnomalousNode(anomalies: AnomalyRecord[]): string | null {
    const timeline = this.buildTimeline(anomalies);
    const earliest = timeline.find(p => p.isEarliest);
    return earliest ? earliest.nodeId : null;
  }

  /**
   * Every node whose anomaly began in the earliest window.
   *
   * Onsets are measured at poll-cycle resolution, so two problems that began
   * in the same cycle cannot be ordered. Returning one of them — which is
   * what findEarliestAnomalousNode does — would hand the precedence credit to
   * whichever happened to sort first. A tie is reported as a tie.
   */
  public findEarliestAnomalousNodes(anomalies: AnomalyRecord[]): Set<string> {
    return new Set(this.buildTimeline(anomalies).filter(p => p.isEarliest).map(p => p.nodeId));
  }
}
