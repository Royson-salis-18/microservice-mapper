// server/algorithms/evaluation/infer.ts: from what the mapper SAW on the named root cause, say what kind of fault it looks like. PURE.
// This is the "output matches the input" check: the injector applied a fault class; the mapper never knew it; here we ask
// whether the evidence it collected is the evidence that class leaves behind.
//
// Families (what an operator could tell apart from outside the service):
//   down        crash, stop, crash-loop   container exited, or restarted again and again
//   frozen      pause                     alive but silent: no activity at all
//   slow        brownout, flap            answers, but late or failing (latency, errors, CPU, intermittent)
//   memory      memory                    memory climbing towards its limit
//   isolated    partition                 running, but nothing reaches it (traffic and network drop)
export const FAMILY_OF: Record<string, string> = {
  crash: 'down', stop: 'down', 'crash-loop': 'down', pause: 'frozen', brownout: 'slow', flap: 'slow', memory: 'memory', partition: 'isolated',
};
export const FAMILIES = ['down', 'frozen', 'slow', 'memory', 'isolated'];

/** Evidence tokens look like "metric" or "metric:reason", as recorded by observe.ts for the root cause. */
export function inferFamily(evidence: string[]): string | null {
  if (!evidence.length) return null;
  const has = (s: string) => evidence.some((e) => e === s || e.startsWith(`${s}:`));
  if (has('container-health:container-paused')) return 'frozen';
  if (has('container-health:container-network-detached')) return 'isolated';
  if (has('container-health') || has('restarts')) return 'down';
  if (has('memoryPercent')) return 'memory';
  if (has('silence')) return has('requestRate') || has('networkRxRate') ? 'isolated' : 'frozen';
  if (has('requestRate') && (has('networkRxRate') || has('networkTxRate')) && !has('latency') && !has('errorRate')) return 'isolated';
  if (has('latency') || has('errorRate') || has('cpu') || has('cpuThrottledPct')) return 'slow';
  if (has('requestRate') || has('networkRxRate') || has('networkTxRate')) return 'isolated';
  return null;
}
