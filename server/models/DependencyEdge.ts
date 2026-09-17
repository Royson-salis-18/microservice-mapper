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

  metrics: {
    requestCount?: number | null;
    requestRate?: number | null;
    latency?: number | null;
    p50Latency?: number | null;
    p95Latency?: number | null;
    p99Latency?: number | null;
    errorCount?: number | null;
    errorRate?: number | null;
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
  };

  status: 'active' | 'degraded' | 'failed' | 'unknown';
}