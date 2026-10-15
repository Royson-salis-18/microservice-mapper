import type { MetricProvenance } from './MetricProvenance.js';
import type { ScoreContribution } from './Incident.js';

export interface ServiceNode {
  id: string;
  name: string;
  type: 'gateway' | 'service' | 'database' | 'queue' | 'frontend' | 'infrastructure' | 'external';
  project: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** ISO-8601 UTC timestamp of the last discovery or telemetry update that
   * touched this node. Used to prune ghost nodes a container's containerId
   * churn (restart) or a one-off match failure left behind - see
   * GraphStore.pruneStaleNodes(). */
  lastSeen?: string;
  metadata: {
    containerId?: string;
    image?: string;
    ports?: string[];
    uptime?: string;
    restartCount?: number;
    [key: string]: any;
  };
  metrics: {
    // Tier 0: exact, straight from cgroup accounting.
    cpu?: number;
    memory?: number;
    memoryPercent?: number;
    /** Bytes received / sent since the container started (cumulative). */
    networkRx?: number;
    networkTx?: number;
    /** Bytes per second over the last interval: exact, from the container's
     *  /proc/<pid>/net/dev counters where readable. Undefined until two
     *  readings exist. */
    networkRxRate?: number;
    networkTxRate?: number;
    /** Cores the container may use: its CPU limit, else the host's cores. */
    cpuAllowanceCores?: number;
    /** CPU as a share of that allowance, 0..100. `cpu` above is docker's
     *  figure, percent of ONE core, which can exceed 100. */
    cpuOfAllowance?: number;
    /** Share of CPU scheduler periods held back by the container's CPU limit, 0..100. */
    cpuThrottledPct?: number;
    /** Restarts since the previous sample. */
    restartDelta?: number;
    /** Requests behind requestRate/latency in the current window. */
    requestCount?: number;
    latencyP95?: number;
    // Tier 1/2 only - nothing outside the container can measure these.
    latency?: number | null;
    requestRate?: number | null;
    errorRate?: number | null;
    /** Which tier produced the request-level fields above. */
    provenance?: MetricProvenance;
  } | null;
  analytics?: {
    // healthScore, riskScore, criticality, centrality, upstreamCount and
    // downstreamCount are computed every poll cycle by RiskEngine.recomputeAll()
    // (server/graph/RiskEngine.ts) from signals already collected elsewhere on
    // this object - status, anomalyScore, open incidents, and observed edge
    // activity. healthBreakdown is what makes riskScore/healthScore checkable
    // by hand rather than taken on faith.
    healthScore?: number | null;
    /** Current exposure, not a predicted failure probability: half current
     *  health, half how much observed traffic structurally depends on this
     *  node. See RiskEngine.ts for the exact formula. */
    riskScore?: number | null;
    /**
     * Predicted probability this service fails, 0..1, from the cascade model
     * in server/graph/CascadeEngine.ts: its own measured state combined with
     * risk flowing in from failing dependencies over weighted edges.
     *
     * A model estimate, not an observed frequency - nothing has been
     * calibrated against records of real cascades. The model and its
     * transmission parameter are served alongside it at
     * /api/reliability/cascade so that is never hidden.
     */
    failureProbability?: number | null;
    /** The part of failureProbability arriving through dependencies alone -
     *  how exposed this service is to something else failing. */
    affectedProbability?: number | null;
    /** The dependency contributing most of that inherited risk. */
    cascadeVia?: string | null;
    /** Hops from where this service's risk originates; 0 = its own state. */
    cascadeDepth?: number;
    /** Share of this project's live observed traffic that flows through this
     *  node's downstream footprint. Null only when the whole project shows
     *  zero observed activity (nothing to divide by), never when the node's
     *  own share is genuinely zero. */
    criticality?: number | null;
    /** Degree over observed edges, normalised against the busiest node in the
     *  same project. Null only when the whole project has zero observed edges. */
    centrality?: number | null;
    upstreamCount?: number;
    downstreamCount?: number;
    /** The named factors and reasons riskScore/healthScore were built from,
     *  in the same visible-breakdown style RCAEngine uses for root causes. */
    healthBreakdown?: ScoreContribution[];
    /** From ml/score.py's per-service Isolation Forest, 0..1. Absent (not
     * null) until that service has a trained model and a live score. */
    anomalyScore?: number;
    anomalyPersistent?: boolean;
  };
}