import { useCallback, useEffect, useState } from 'react';

/** Which engine decides incidents on the server: the rule-based detector, the learned one (Isolation Forest + random walk), or both (hybrid). */
export type EngineMode = 'rules' | 'hybrid' | 'ml';

export function useEngineMode() {
  const [mode, setMode] = useState<EngineMode | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/engine').then((r) => (r.ok ? r.json() : null)).then((d) => { if (!cancelled && d?.mode) setMode(d.mode); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const change = useCallback(async (next: EngineMode) => {
    if (next === mode || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/engine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }) });
      const d = await r.json();
      if (r.ok && d?.mode) setMode(d.mode);
    } catch { /* server away: keep the current mode */ }
    setBusy(false);
  }, [mode, busy]);
  return { mode, change, busy };
}
