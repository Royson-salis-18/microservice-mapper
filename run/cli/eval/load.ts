// File loading for the evaluation harness. The only I/O in run/cli/eval besides observe.ts and the CLI; scoring itself is pure (score.ts).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseLedger, parseObserved, parseTrafficLog, type ImpactSample } from '../../../server/algorithms/evaluation/score.ts';

export const loadLedger = (p: string) => parseLedger(fs.readFileSync(p, 'utf8'));
export const loadObserved = (p: string) => parseObserved(fs.readFileSync(p, 'utf8'));

/** The traffic generator's own log (what users experienced). Empty if the container is gone or docker is unavailable. */
export function loadTrafficImpact(container: string, sinceMs: number): ImpactSample[] {
  const r = spawnSync('docker', ['logs', '-t', '--since', new Date(sinceMs - 60000).toISOString(), container], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 30000 });
  if (r.error) return [];
  return parseTrafficLog(`${r.stdout}\n${r.stderr}`);          // the generator prints its windows on stderr, which docker keeps separate
}
