import { useState, useEffect } from 'react';
import type { MetricSnapshot } from '../types';

interface UseMetricsReturn {
  data: MetricSnapshot[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useMetrics(nodeId: string | null, range: string): UseMetricsReturn {
  const [data, setData] = useState<MetricSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    if (!nodeId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/metrics?range=${range}`);
      if (!res.ok) throw new Error('Failed to fetch metrics');
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [nodeId, range]);

  return { data, isLoading, error, refetch: fetchData };
}
