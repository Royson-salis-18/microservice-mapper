/**
 * Where a number came from.
 *
 * The graph already refuses to conflate a declared edge with an observed one.
 * Metrics need the same discipline, and more urgently: a cgroup-derived
 * estimate and a histogram quantile are both "latency" to a chart, and
 * presenting them identically would make the weaker one look like the
 * stronger one. Once several tiers can fill the same field, an unlabelled
 * number is not a measurement — it is a claim with its evidence stripped off.
 *
 * See wiki/18-telemetry-tiers-plan.md for the tier model.
 */

export type MetricSourceKind =
  /** Tier 0 — `docker stats`, i.e. the kernel's cgroup accounting. Exact for
   *  resource use, and says nothing whatsoever about requests. */
  | 'cgroup'
  /** Tier 0 — per-container `/proc/net/tcp` snapshots. Gives topology and a
   *  coarse volume proxy; contains no requests, so no latency and no errors. */
  | 'socket-scan'
  /** Tier 1 — a proxy's access log. Real per-request status and upstream
   *  latency, but only for traffic that passes through that proxy. */
  | 'access-log'
  /** Tier 2 — the target's own Prometheus. Exact histograms and error rates,
   *  and only as good as the instrumentation already deployed there. */
  | 'prometheus'
  /** Tier 2 — the target's own Jaeger/Tempo. Real spans with causality. */
  | 'trace-backend';

export const SOURCE_TIER: Record<MetricSourceKind, 0 | 1 | 2> = {
  'cgroup': 0,
  'socket-scan': 0,
  'access-log': 1,
  'prometheus': 2,
  'trace-backend': 2,
};

/** What each source can honestly speak to. Used to reject a value being
 *  written into a field its source cannot support — a socket scan must never
 *  end up populating a latency field, however convenient that would be. */
export const SOURCE_CAPABILITIES: Record<MetricSourceKind, {
  resourceUse: boolean;
  topology: boolean;
  requestRate: boolean;
  latency: boolean;
  errorRate: boolean;
}> = {
  'cgroup':        { resourceUse: true,  topology: false, requestRate: false, latency: false, errorRate: false },
  'socket-scan':   { resourceUse: false, topology: true,  requestRate: false, latency: false, errorRate: false },
  'access-log':    { resourceUse: false, topology: true,  requestRate: true,  latency: true,  errorRate: true  },
  'prometheus':    { resourceUse: true,  topology: false, requestRate: true,  latency: true,  errorRate: true  },
  'trace-backend': { resourceUse: false, topology: true,  requestRate: true,  latency: true,  errorRate: true  },
};

export interface MetricProvenance {
  source: MetricSourceKind;
  tier: 0 | 1 | 2;
  /** When the source produced this value — not when the graph was read. */
  observedAt: string;
  /**
   * How it was obtained, in enough detail to reproduce: the PromQL that was
   * run, the log format that matched, the command that was executed. A number
   * whose derivation cannot be restated is not reproducible, and this project
   * is meant to produce results someone can check.
   */
  detail?: string;
}

export function provenance(source: MetricSourceKind, detail?: string, observedAt?: string): MetricProvenance {
  return {
    source,
    tier: SOURCE_TIER[source],
    observedAt: observedAt ?? new Date().toISOString(),
    detail,
  };
}

/**
 * Guard for writing a metric field. Returns false when the source cannot
 * legitimately speak to that field, so a mistake shows up as a dropped value
 * and a warning rather than as a confident wrong number in the UI.
 */
export function canProvide(source: MetricSourceKind, field: keyof typeof SOURCE_CAPABILITIES['cgroup']): boolean {
  return SOURCE_CAPABILITIES[source][field];
}
