export interface MetricSnapshot {
  timestamp: string;
  cpu?: number;
  memory?: number;
  memoryPercent?: number;
  networkRx?: number;
  networkTx?: number;
  latency?: number | null;
  p50Latency?: number | null;
  p95Latency?: number | null;
  p99Latency?: number | null;
  requestCount?: number | null;
  requestRate?: number | null;
  errorCount?: number | null;
  errorRate?: number | null;
  restartCount?: number;
  /** Bytes per second since the previous sample (the cumulative networkRx/Tx counters cannot show a drop). */
  networkRxRate?: number | null;
  networkTxRate?: number | null;
  /** Restarts since the previous sample. */
  restartDelta?: number | null;
  pids?: number | null;
}