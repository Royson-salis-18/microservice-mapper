import type { MetricStore } from '../telemetry/MetricStore.js';
import type { AnomalyRecord, IncidentSeverity } from '../models/Incident.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import { loadThresholds, type IncidentThresholds } from './thresholds.js';

/**
 * Per-service anomaly rules, ported from the rca-lab research method (new-repo/core/score.py), where each piece was
 * measured on 751 labelled faults over real healthy traffic (docs/RCA_STATISTICAL_REPORT.html):
 *
 *  - robust baseline: median and MAD of the service's OWN recent past, never including the samples being judged;
 *  - self-healing: past samples that were part of a sustained anomaly are left out of the baseline, so a long fault
 *    never becomes "normal" (one-off spikes stay: they are the series' noise);
 *  - one-sided and log-scaled: only the direction that means trouble counts (latency up, traffic down), and positive
 *    quantities are compared as ratios (100 -> 200 ms is the same jump as 1 -> 2 s);
 *  - tail-aware spread: also respects the 90% deviation, so a mostly-flat series cannot explode on one tick;
 *  - per-series noise normalisation: a series that is jumpy even when healthy is shrunk so its healthy extreme sits at
 *    z = 3 (without this: -9 points of accuracy and 8x the false alarms in the research bench);
 *  - SILENCE: a service that normally shows activity (CPU or network) and suddenly shows none is frozen or dead.
 *    Without this signal frozen services were found 1% of the time instead of 100%;
 *  - persistence: the last TWO samples must agree; a missing reading is unknown, never 0.
 *
 * Each record says whether it is the service's OWN evidence (cpu, memory, silence, container state) or a SYMPTOM that
 * can be inherited from a broken dependency (latency, errors, traffic, network). The RCA engine uses that split to
 * tell the source from its victims.
 */
const MAD_TO_STD = 1.4826;

export type EvidenceKind = 'own' | 'symptom' | 'hard';

interface MetricSpec {
  metric: string;
  pick: (h: MetricSnapshot) => number | null | undefined;
  current: (n: ServiceNode) => number | null | undefined;
  direction: 1 | -1;          // the direction that means trouble
  scale: 'log' | 'lin';
  unit: number;               // log(x + unit): the smallest change worth noticing
  floor: number;              // smallest spread allowed (transformed scale)
  kind: EvidenceKind;
  minDelta?: number;          // percent metrics: also require this many points of absolute movement
}

const SPECS: MetricSpec[] = [
  { metric: 'cpu', pick: h => h.cpu, current: n => n.metrics?.cpu, direction: 1, scale: 'log', unit: 0.5, floor: 0.15, kind: 'own', minDelta: 0 },
  { metric: 'memoryPercent', pick: h => h.memoryPercent, current: n => n.metrics?.memoryPercent, direction: 1, scale: 'log', unit: 1, floor: 0.15, kind: 'own', minDelta: 0 },
  { metric: 'latency', pick: h => h.p95Latency ?? h.latency, current: n => n.metrics?.latency, direction: 1, scale: 'log', unit: 1, floor: 0.15, kind: 'symptom' },
  { metric: 'errorRate', pick: h => h.errorRate, current: n => n.metrics?.errorRate, direction: 1, scale: 'lin', unit: 0, floor: 0.02, kind: 'symptom' },
  { metric: 'requestRate', pick: h => h.requestRate, current: n => n.metrics?.requestRate, direction: -1, scale: 'log', unit: 0.1, floor: 0.15, kind: 'symptom' },
  { metric: 'networkRxRate', pick: h => h.networkRxRate, current: () => undefined, direction: 1, scale: 'log', unit: 2000, floor: 0.15, kind: 'symptom' },
  { metric: 'networkTxRate', pick: h => h.networkTxRate, current: () => undefined, direction: 1, scale: 'log', unit: 2000, floor: 0.15, kind: 'symptom' },
];

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface RobustScore {
  /** One-sided, normalised deviation of each recent sample (0 = normal). */
  z: number[];
  center: number;              // baseline median, original units
  spread: number;              // baseline spread, transformed units
  noiseShrink: number;         // >= 1: how much a jumpy series was turned down
}

/**
 * The research score for one series. baseline = past samples only, recent = the samples being judged.
 * Returns null when there is not enough history to say what normal is.
 */
export function robustScore(baseline: number[], recent: number[], spec: Pick<MetricSpec, 'direction' | 'scale' | 'unit' | 'floor'>,
  minHistory: number, excludeZ = 4.0): RobustScore | null {
  const tf = (v: number) => (spec.scale === 'log' ? Math.log(Math.max(v, 0) + (spec.unit || 1)) : v);
  let B = baseline.filter(finite).map(tf);
  if (B.length < minHistory || !recent.length) return null;
  const fit = (xs: number[], tail = true) => {
    const c = median(xs);
    const dev = xs.map(v => Math.abs(v - c));
    const s = Math.max(median(dev) * MAD_TO_STD, tail ? quantile(dev, 0.9) / 1.645 : 0, spec.floor);
    return { c, s };
  };
  // The exclusion decision uses the plain MAD spread: if an old fault fills more than ~10% of the window, the
  // tail-aware spread would absorb it and nothing would ever be excluded.
  let { c, s } = fit(B, false);
  // self-healing: drop past samples that belonged to a SUSTAINED anomaly (>= 2 in a row above excludeZ: a past
  // incident), so a long fault never becomes normal. Isolated one-sample spikes stay: they are this series' noise,
  // and the noise normalisation below needs to see them to know the series is jumpy.
  const hot = B.map(v => spec.direction * (v - c) / s >= excludeZ);
  const inRun = hot.map((h, i) => h && (hot[i - 1] || hot[i + 1]));
  const kept = B.filter((_, i) => !inRun[i]);
  if (kept.length >= minHistory && kept.length < B.length) B = kept;
  ({ c, s } = fit(B));
  // per-series noise normalisation: the healthy extreme of this series is mapped to z = 3
  const healthyZ = B.map(v => Math.max(0, spec.direction * (v - c) / s));
  const shrink = Math.max(1, quantile(healthyZ, 0.995) / 3);
  const z = recent.map(v => (finite(v) ? Math.min(50, Math.max(0, spec.direction * (tf(v) - c) / s) / shrink) : NaN));
  const center = spec.scale === 'log' ? Math.exp(c) - (spec.unit || 1) : c;
  return { z, center, spread: s, noiseShrink: shrink };
}

export class AnomalyDetector {
  constructor(private metricStore: MetricStore) {}

  public detectAnomaliesForTarget(targetId: string, nodes: ServiceNode[]): AnomalyRecord[] {
    const anomalies: AnomalyRecord[] = [];
    const now = new Date().toISOString();
    // Read per pass, so an edit in the UI takes effect on the next detection cycle without a restart.
    const t = loadThresholds();

    for (const node of nodes) {
      if (node.project !== targetId) continue;
      const state = node.metadata?.state as string | undefined;

      // 1. HARD evidence: container state. A stopped or paused container is a fact, not a degree.
      if (node.status === 'critical' || state === 'exited' || state === 'dead' || state === 'paused') {
        anomalies.push(this.record(node.id, targetId, 'container-health', now, 0, 1, 0, null,
          state === 'paused' ? 'container-paused' : node.metadata?.vanished ? 'container-vanished' : 'container-exited-or-critical',
          'CRITICAL', 'container-runtime', 'hard'));
      } else if (state === 'restarting') {
        anomalies.push(this.record(node.id, targetId, 'container-health', now, 0, 1, 0, null, 'container-restarting', 'HIGH', 'container-runtime', 'hard'));
      }

      const history = this.metricStore.getHistory(node.id, '15m');

      // 2. A restart since the previous sample (crash loop): hard evidence, and the history around it is unreliable.
      const lastTwo = history.slice(-2);
      if (lastTwo.some(h => (h.restartDelta ?? 0) > 0)) {
        anomalies.push(this.record(node.id, targetId, 'restarts', now, lastTwo.reduce((a, h) => a + (h.restartDelta ?? 0), 0), 0, 0, null,
          'container-restarted', 'HIGH', 'container-runtime', 'hard'));
      }

      // 3. SILENCE: usually active, now doing nothing at all (frozen, deadlocked, or dead without docker noticing).
      const silence = this.silence(node, history, t, now, targetId);
      if (silence) anomalies.push(silence);

      // 4. Every metric against the service's own recent past.
      for (const spec of SPECS) {
        const series = history.map(spec.pick).filter(finite);
        const cur = spec.current(node);
        const tail = finite(cur) ? [...series.slice(0, -1), cur] : series;
        if (tail.length < t.minHistorySamples + 2) continue;          // cold start: not enough history, say nothing
        const baseline = tail.slice(0, -2);                            // never contains the samples being judged
        const recent = tail.slice(-2);
        const a = this.judge(baseline, recent, spec, node.id, targetId, now, t);
        if (a) anomalies.push(a);
      }
    }
    return anomalies;
  }

  /**
   * Silence (research: binomial z of recent activity vs usual activity). Activity = CPU above 0.5% or any network
   * bytes moved in the sample. Only judged for services that are usually active (>= 60% of past samples).
   */
  private silence(node: ServiceNode, history: MetricSnapshot[], t: IncidentThresholds, now: string, targetId: string): AnomalyRecord | null {
    const k = t.silenceSamples;
    const act = history.map(h => {
      const net = (h.networkRxRate ?? 0) + (h.networkTxRate ?? 0);
      if (!finite(h.cpu) && !finite(h.networkRxRate)) return null;   // no reading at all: unknown, not silent
      return (h.cpu ?? 0) > 0.5 || net > 0 ? 1 : 0;
    }).filter((v): v is 0 | 1 => v !== null);
    if (act.length < t.minHistorySamples + k) return null;
    const past = act.slice(0, -k), recent = act.slice(-k);
    const q = past.reduce((a: number, b) => a + b, 0) / past.length;
    if (q < 0.6) return null;                                         // a mostly idle service going quiet is just idle
    const obs = recent.reduce((a: number, b) => a + b, 0);
    const exp = k * q;
    const z = Math.min(50, (exp - obs) / Math.sqrt(Math.max(exp * (1 - q), 1e-6)));
    if (obs > 0 || z < t.zScoreAnomaly) return null;
    return this.record(node.id, targetId, 'silence', now, 0, Math.round(q * 100) / 100, 0, Math.round(z * 100) / 100,
      'service-went-silent', z >= t.zScoreCritical ? 'CRITICAL' : 'HIGH', 'activity', 'own');
  }

  private judge(baseline: number[], recent: number[], spec: MetricSpec, nodeId: string, targetId: string, now: string, t: IncidentThresholds): AnomalyRecord | null {
    const r = robustScore(baseline, recent, spec, t.minHistorySamples);
    if (!r) return null;
    if (r.z.some(z => !Number.isFinite(z) || z < t.zScoreAnomaly)) return null;      // persistence: both samples agree
    const current = recent[recent.length - 1];
    if (spec.minDelta !== undefined && Math.abs(current - r.center) < Math.max(spec.minDelta, t.minDeltaPercent)) return null;
    const z = r.z[r.z.length - 1];
    let severity: IncidentSeverity = 'MEDIUM';
    if (z >= t.zScoreCritical || (spec.metric === 'cpu' || spec.metric === 'memoryPercent') && current > t.absoluteCriticalPercent) severity = 'CRITICAL';
    else if (z >= t.zScoreHigh || (spec.metric === 'cpu' || spec.metric === 'memoryPercent') && current > t.absoluteHighPercent) severity = 'HIGH';
    return this.record(nodeId, targetId, spec.metric, now, current, Math.round(r.center * 100) / 100, Math.round(r.spread * 1000) / 1000,
      Math.round(z * 100) / 100, r.noiseShrink > 1 ? 'robust-zscore-persistent (noise-normalised)' : 'robust-zscore-persistent',
      severity, 'dynamic-zscore', spec.kind);
  }

  /**
   * Kept for callers and tests that score one metric directly: recent = [previous, current], both must deviate in the
   * SAME direction (two-sided here, because the caller does not say which direction is bad).
   */
  public calculateZScore(baseline: number[], recent: number[], metric: string, nodeId: string, targetId: string, timestamp: string,
    t: IncidentThresholds): AnomalyRecord | null {
    if (baseline.length === 0 || recent.length === 0) return null;
    const currentValue = recent[recent.length - 1];
    const center = median(baseline);
    const spread = median(baseline.map(v => Math.abs(v - center))) * MAD_TO_STD;
    if (spread < t.flatlineStdDev) {                                  // flat baseline: judge absolute movement
      if (!recent.every(v => Math.abs(v - center) > t.flatlineDeltaPercent)) return null;
      return this.record(nodeId, targetId, metric, timestamp, currentValue, center, 0, null, 'flat-baseline-jump',
        currentValue > t.flatlineCriticalPercent ? 'CRITICAL' : 'HIGH', 'dynamic-baseline', 'own');
    }
    const zs = recent.map(v => (v - center) / spread);
    const sameSide = zs.every(z => z > 0) || zs.every(z => z < 0);
    if (!sameSide || Math.min(...zs.map(Math.abs)) < t.zScoreAnomaly) return null;
    if (Math.abs(currentValue - center) < t.minDeltaPercent) return null;
    const zScore = zs[zs.length - 1];
    let severity: IncidentSeverity = 'MEDIUM';
    if (Math.abs(zScore) >= t.zScoreCritical || currentValue > t.absoluteCriticalPercent) severity = 'CRITICAL';
    else if (Math.abs(zScore) >= t.zScoreHigh || currentValue > t.absoluteHighPercent) severity = 'HIGH';
    return this.record(nodeId, targetId, metric, timestamp, currentValue, Math.round(center * 10) / 10, Math.round(spread * 10) / 10,
      Math.round(zScore * 100) / 100, 'robust-zscore-persistent', severity, 'dynamic-zscore', 'own');
  }

  private record(nodeId: string, targetId: string, metric: string, timestamp: string, observedValue: number, baselineMean: number,
    baselineStdDev: number, zScore: number | null, reason: string, severity: IncidentSeverity, evidenceSource: string,
    evidence: EvidenceKind): AnomalyRecord {
    return { id: `anomaly-${nodeId}-${metric}-${Date.now()}`, nodeId, targetId, metric, timestamp, observedValue, baselineMean,
      baselineStdDev, zScore, reason, severity, evidenceSource, evidence };
  }
}
