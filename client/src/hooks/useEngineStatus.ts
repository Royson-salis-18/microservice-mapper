import { useEffect, useState } from 'react';

/** One service as the ML engine sees it right now. Levels: 0 typical, 1 on the service's own alarm line. */
export interface EngineRow { id: string; level: number; own: number; symptom: number; anomaly: number; walk: number; hard: boolean; ready: boolean; fact?: string }
export interface EngineTarget { targetId: string; rulesTop?: number | null; warnings?: { id: string; feature: string; inSec: number | null }[]; cascade?: { id: string; risk: number }[]; ready: boolean; learnedServices: number; services: number; needReadings: number; detail: EngineRow[] }

/** Polls /api/engine: which engine is deciding, and (in ML mode) what it has learned and whom the random walk blames. */
export function useEngineStatus(everyMs = 5000) {
  const [mode, setMode] = useState<'rules' | 'ml' | 'hybrid' | null>(null);
  const [targets, setTargets] = useState<EngineTarget[]>([]);
  useEffect(() => {
    let off = false;
    const load = () => fetch('/api/engine').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (off || !d) return;
      setMode(d.mode); setTargets(d.status?.targets ?? []);
    }).catch(() => {});
    load();
    const t = setInterval(load, everyMs);
    return () => { off = true; clearInterval(t); };
  }, [everyMs]);
  return { mode, targets };
}
