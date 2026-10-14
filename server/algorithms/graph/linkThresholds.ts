/**
 * Where a link counts as slow or erroring (degraded) and as failing.
 *
 * The client's edge colours use the same numbers (LINK_THRESHOLDS in
 * client/src/components/shared/edgeHeat.ts) and a test keeps the two equal:
 * a link must never be drawn orange while its own status says "active", or
 * marked failed while drawn calm. Latency is the p95 where a source gives
 * percentiles, the mean otherwise.
 */
export const LINK_THRESHOLDS = {
  slowMs: 300,
  verySlowMs: 1000,
  errorWarn: 0.01,
  errorCritical: 0.05,
} as const;

export function linkStatus(errorRate: number | null | undefined, latencyMs: number | null | undefined): 'failed' | 'degraded' | 'active' {
  if ((errorRate ?? 0) >= LINK_THRESHOLDS.errorCritical || (latencyMs ?? 0) >= LINK_THRESHOLDS.verySlowMs) return 'failed';
  if ((errorRate ?? 0) >= LINK_THRESHOLDS.errorWarn || (latencyMs ?? 0) >= LINK_THRESHOLDS.slowMs) return 'degraded';
  return 'active';
}
