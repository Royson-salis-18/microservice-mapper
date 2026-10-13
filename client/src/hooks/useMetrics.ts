import { useState, useEffect, useCallback, useRef } from 'react';
import type { MetricSnapshot } from '../types';

interface UseMetricsReturn {
  data: MetricSnapshot[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/** How often the history is refreshed while a panel shows it. */
const POLL_MS = 15_000;

/**
 * Metric history for one service over a range, kept fresh while it is on
 * screen. It used to be fetched once when the panel opened and then never
 * again, so the "live" charts stopped at the moment you clicked.
 */
export function useMetrics(nodeId: string | null, range: string): UseMetricsReturn {
  const [data, setData] = useState<MetricSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const latest = useRef({ nodeId, range });
  latest.current = { nodeId, range };

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!nodeId) {
      setData([]);
      return;
    }
    const controller = new AbortController();
    const load = async (showLoading: boolean) => {
      if (showLoading) setIsLoading(true);
      try {
        const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/metrics?range=${range}`, { signal: controller.signal });
        if (!res.ok) throw new Error('Failed to fetch metrics');
        const json = await res.json();
        // A slow response for a service no longer selected must not land.
        if (latest.current.nodeId === nodeId && latest.current.range === range) {
          setData(json);
          setError(null);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') setError(err?.message ?? 'Failed to fetch metrics');
      } finally {
        if (showLoading) setIsLoading(false);
      }
    };
    load(true);
    const timer = setInterval(() => load(false), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [nodeId, range, tick]);

  return { data, isLoading, error, refetch };
}
