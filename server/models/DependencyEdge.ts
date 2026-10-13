import type { MetricProvenance } from './MetricProvenance.js';

export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  type: 'http' | 'database' | 'message' | 'dependency';
  protocol?: 'http' | 'tcp' | 'amqp' | 'rabbitmq' | string;
  
  declared: boolean;
  observed: boolean;
  evidenceSources: string[];

  firstSeen?: string;
  lastSeen?: string;

  /**
   * Per-request metrics. Null under Tier 0 alone, and that is not a gap to
   * paper over: a socket table contains no requests, so there is nothing
   * here to report. Filled by Tier 1 (proxy access logs) or Tier 2 (the
   * target's own Prometheus/traces) when the target provides them — see
   * wiki/18-telemetry-tiers-plan.md.
   */
  metrics: {
    requestCount?: number | null;
    requestRate?: number | null;
    latency?: number | null;
    p50Latency?: number | null;
    p95Latency?: number | null;
    p99Latency?: number | null;
    errorCount?: number | null;
    errorRate?: number | null;
    /** Which tier produced these, so an estimate is never read as a
     *  measurement. Absent on data written before provenance existed. */
    provenance?: MetricProvenance;
  } | null;

  statusCodeDistribution?: Record<string, number>;

  /**
   * Observed TCP connection activity on this link, from the per-container
   * /proc/net/tcp scans. Deliberately NOT called requestRate: these are
   * connection observations, not HTTP requests, and there is no latency or
   * error data behind them. Absent until the link has been seen at least
   * once — never defaulted to 0, which would read as "measured, and idle".
   */
  activity?: {
    /**
     * Socket observations per minute, NOT new connections per minute: the
     * collector re-counts every ESTABLISHED/TIME_WAIT socket on each sweep,
     * so one long-lived connection contributes on every scan. It is a
     * proxy for how much concurrent traffic a link carries, and it is the
     * only per-edge volume signal available — there is no latency, error
     * rate or request count behind these links.
     */
    samplesPerMin: number;
    /** Seconds the rate was measured over, so a short sample is obvious. */
    windowSec: number;
    lastSeen: string;
    /** Average number of distinct open (ESTABLISHED) connections over the
     *  last two minutes, each counted once whichever end reported it. */
    openConnections?: number;
    /** Distinct connections opened per minute over the same window. A closed
     *  connection lingers ~60s in TIME_WAIT and is still counted once. */
    newConnectionsPerMin?: number;
    /** Socket sweeps behind those two figures. */
    connectionSweeps?: number;
    /**
     * A slow-moving reference level for this link's traffic: it rises within
     * about a minute when traffic grows, and decays over about ten when it
     * falls. Dependency weights are computed from this rather than the
     * instantaneous rate, because a link goes quiet precisely when its callee
     * dies — weighting on current traffic made a crashed database look less
     * and less important to its callers the longer it stayed down.
     */
    baselinePerMin?: number;
  };

  status: 'active' | 'degraded' | 'failed' | 'unknown';

  /**
   * How strongly the source depends on the target. Computed every poll cycle
   * by computeEdgeWeights() in server/graph/EdgeWeights.ts; absent until the
   * first cycle has run.
   */
  weight?: EdgeWeight;
}

export interface EdgeWeight {
  /**
   * The weight the algorithms use, 0..1: how strongly a failure of the target
   * transmits to the source. confidence × dependency.
   */
  value: number;
  /**
   * Share of the caller's outbound work that goes over this edge, 0..1.
   * Losing a callee that takes 60% of your calls hurts more than losing one
   * that takes 5%.
   */
  dependency: number;
  /**
   * What `dependency` was computed from. `requests` and `activity` are
   * measurements; `uniform` means no traffic figure existed for this caller,
   * so its dependencies were weighted equally — stated rather than hidden.
   */
  dependencyBasis: 'requests' | 'activity' | 'uniform';
  /**
   * `telemetry` when either end is an observability component (collector,
   * tracing, metrics, dashboards). Such an edge counts at a tenth of its
   * measured share in `value`: exporting telemetry rarely stops a service
   * from working when the exporter's destination is down.
   */
  kind: 'request' | 'telemetry';
  /** This edge's traffic relative to the busiest edge in its project, 0..1.
   *  Null when this edge carries no traffic measurement. */
  volume: number | null;
  /** How sure we are this dependency exists and points this way, 0..1 —
   *  from the kind of evidence behind it. */
  confidence: number;
  /** Plain-language source of `confidence`. */
  confidenceBasis: string;
  /** 0..1 from errors and latency measured on this edge. Null when the edge
   *  has no request-level measurements (Tier 0 alone never does). */
  stress: number | null;
}