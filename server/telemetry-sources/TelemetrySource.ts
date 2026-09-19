import type { MetricSourceKind } from '../models/MetricProvenance.js';

/**
 * A place per-request telemetry can come from.
 *
 * The existing SSH collector is Tier 0 and is not replaced by this — it stays
 * the default and the fallback, because it is the only source that works on
 * an uninstrumented box in thirty seconds. What this adds is somewhere for
 * Tier 1 and Tier 2 to plug in without turning MetricCollector into a
 * dispatch table.
 *
 * The contract is deliberately narrow: a source answers for a target, says
 * whether it is usable right now, and returns per-service and per-edge
 * request metrics. It does not own connections, does not write to the graph,
 * and cannot decide what a metric means. See wiki/18-telemetry-tiers-plan.md.
 */

/** Per-request numbers a source can produce for one service. */
export interface ServiceRequestMetrics {
  serviceName: string;
  requestRate?: number | null;
  errorRate?: number | null;
  latencyP50Ms?: number | null;
  latencyP95Ms?: number | null;
  latencyP99Ms?: number | null;
  /** How each figure was obtained, for the provenance record. */
  detail?: string;
}

/** The same, for a link between two services, when the source can attribute
 *  traffic to a caller. Prometheus usually cannot without explicit
 *  client-side labels, so this is frequently empty even at Tier 2. */
export interface EdgeRequestMetrics {
  sourceService: string;
  targetService: string;
  requestRate?: number | null;
  errorRate?: number | null;
  latencyP50Ms?: number | null;
  latencyP95Ms?: number | null;
  latencyP99Ms?: number | null;
  detail?: string;
}

export interface TelemetrySnapshot {
  services: ServiceRequestMetrics[];
  edges: EdgeRequestMetrics[];
  /** Non-fatal problems worth surfacing rather than swallowing. */
  warnings: string[];
}

export interface TelemetrySourceStatus {
  kind: MetricSourceKind;
  available: boolean;
  /**
   * Why it is unavailable, in terms someone can act on — "nothing listening
   * on :9090", not "error". An unavailable source is the normal case, not a
   * failure: three of four targets have no Prometheus at all.
   */
  reason?: string;
  checkedAt: string;
}

export interface TelemetrySource {
  readonly kind: MetricSourceKind;
  readonly targetId: string;

  /**
   * Cheap liveness check. Called before collection so an absent source costs
   * one probe rather than a full timeout on every cycle.
   */
  probe(): Promise<TelemetrySourceStatus>;

  /** Current per-request metrics, over the given lookback window. */
  collect(windowSec: number): Promise<TelemetrySnapshot>;
}

/**
 * Per-target configuration, read from remote_config.json.
 *
 * Absent means Tier 0 only, which is the correct default: enabling a source
 * that is not there should be a deliberate act, not something inferred from a
 * port being open.
 */
export interface TelemetrySourceConfig {
  prometheus?: {
    enabled: boolean;
    /** Reached from the target host itself over SSH, so localhost is normal
     *  and no port needs opening in the security group. */
    url?: string;
  };
  traceBackend?: {
    enabled: boolean;
    url?: string;
    kind?: 'jaeger' | 'tempo';
  };
  accessLogs?: {
    enabled: boolean;
    /** Container names whose stdout carries a parseable access log. */
    containers?: string[];
  };
}

export const DEFAULT_SOURCE_CONFIG: TelemetrySourceConfig = {
  prometheus: { enabled: false, url: 'http://localhost:9090' },
  traceBackend: { enabled: false, url: 'http://localhost:16686', kind: 'jaeger' },
  accessLogs: { enabled: false, containers: [] },
};
