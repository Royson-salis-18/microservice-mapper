import { useEffect, useState } from 'react';

/** The per-architecture model the server trains on a project's own baseline at every start. */
export interface TargetModelStatus {
  target: string; state: 'learning' | 'ready'; baselineSec: number; needSec: number; moments: number;
  scorer: 'learned' | 'rules'; threshold: number; noiseCeiling: number; prior: number | null; trainedAt: string;
}

export function useModelStatus(targetId: string | null): TargetModelStatus | null {
  const [model, setModel] = useState<TargetModelStatus | null>(null);
  useEffect(() => {
    if (!targetId || targetId === 'ALL') { setModel(null); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/models');
        if (!r.ok) return;
        const all = (await r.json()) as TargetModelStatus[];
        if (!cancelled) setModel(all.find((m) => m.target === targetId) ?? null);
      } catch { /* server briefly away: keep the last value */ }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [targetId]);
  return model;
}

export const learningText = (m: TargetModelStatus) => `${Math.floor(m.baselineSec / 60)} of ${Math.round(m.needSec / 60)} min`;
