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
   * churn (restart) or a one-off match failure left behind — see
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
    networkRx?: number;
    networkTx?: number;
    // Tier 1/2 only — nothing outside the container can measure these.
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
    // this object — status, anomalyScore, open incidents, and observed edge
    // activity. healthBreakdown is what makes riskScore/healthScore checkable
    // by hand rather than taken on faith.
    healthScore?: number | null;
    /** Current exposure, not a predicted failure probability: half current
     *  health, half how much observed traffic structurally depends on this
     *  node. See RiskEngine.ts for the exact formula. */
    riskScore?: number | null;
    /**
     * Deliberately never set. A real probability needs labelled outcomes —
     * "a failure happened, N minutes after this precursor pattern" — and
     * nothing in this system records that. Leaving this null (rather than
     * inventing a plausible-looking number) is the point, not an oversight.
     */
    failureProbability?: number | null;
    /** Deliberately never set — same reason as failureProbability. */
    affectedProbability?: number | null;
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