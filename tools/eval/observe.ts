// tools/eval/observe.ts: watch a mapper from the outside and record what it says, once every few seconds.
// It uses only the mapper's public HTTP API (/api/incidents, /api/graph). It never reads the ledger or talks to the injector,
// so what it records is exactly what an operator looking at the mapper would have seen.
import fs from 'node:fs';
import path from 'node:path';
import { norm, type Snapshot } from './score.ts';

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export async function snapshot(mapper: string, target: string): Promise<Snapshot | null> {
  try {
    const [inc, graph] = await Promise.all([
      fetch(`${mapper}/api/incidents?targetId=${encodeURIComponent(target)}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
      fetch(`${mapper}/api/graph`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
    ]);
    const status: Record<string, string> = {};
    for (const n of graph.nodes ?? []) if (n.project === target) status[norm(n.id)] = n.status;
    const incidents = (Array.isArray(inc) ? inc : [])
      // keep only incidents open right now: the end of an incident is the first snapshot that no longer shows it
      .map((i: any) => ({
        id: i.id, status: i.status, severity: i.severity, startedAt: ms(i.startedAt), endedAt: i.endedAt ? ms(i.endedAt) : null,
        root: norm(i.rootCauseServiceId) || null, confidence: i.confidence,
        candidates: (i.candidateCauses ?? []).map((c: any) => norm(c.serviceId)),
        affected: (i.affectedServices ?? []).map(norm),
        atRisk: (i.atRisk ?? []).map((r: any) => ({ id: norm(r.serviceId), risk: r.risk })),
        monitoringGap: !!i.monitoringGap,
      }))
      .filter((i: any) => i.endedAt === null);
    return { ts: Date.now(), incidents, status };
  } catch { return null; }
}

/** Poll until `stop()` is called or `durationSec` passes. Appends one JSON line per snapshot. */
export async function observe(opts: { mapper: string; target: string; out: string; intervalSec: number; durationSec?: number; signal?: AbortSignal; log?: (s: string) => void }) {
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const end = opts.durationSec ? Date.now() + opts.durationSec * 1000 : Infinity;
  let n = 0, missed = 0;
  while (Date.now() < end && !opts.signal?.aborted) {
    const s = await snapshot(opts.mapper, opts.target);
    if (s) { fs.appendFileSync(opts.out, JSON.stringify(s) + '\n'); n++; } else missed++;
    if (n % 12 === 0 && opts.log) opts.log(`  ${n} snapshots, ${missed} missed${s ? `, ${s.incidents.length} incident(s) open, ${Object.values(s.status).filter((x) => x !== 'healthy').length} service(s) not healthy` : ''}`);
    await new Promise((r) => setTimeout(r, opts.intervalSec * 1000));
  }
  return { snapshots: n, missed };
}
