// Which engine decides incidents: the rule-based detector and ranking ("rules"), the learned one ("ml": a per-service
// Isolation Forest on a sliding window of normal readings, and a random walk on the call graph for the source), or both
// ("hybrid", the default: either engine can raise the alarm, the ML engine names the source).
// Saved in data/engine_mode.json so the choice survives a restart.
import fs from 'node:fs';
import path from 'node:path';

export type EngineMode = 'rules' | 'ml' | 'hybrid';
const MODES: EngineMode[] = ['rules', 'ml', 'hybrid'];
const file = () => path.resolve(process.cwd(), 'data', 'engine_mode.json');
let cached: EngineMode | null = null;

export function getEngineMode(): EngineMode {
  if (cached) return cached;
  const env = process.env.MAPPER_ENGINE;
  if (MODES.includes(env as EngineMode)) return (cached = env as EngineMode);
  try {
    const m = JSON.parse(fs.readFileSync(file(), 'utf8')).mode;
    cached = MODES.includes(m) ? m : 'hybrid';
  } catch { cached = 'hybrid'; }
  return cached ?? 'hybrid';
}

export function setEngineMode(mode: EngineMode): EngineMode {
  const next: EngineMode = MODES.includes(mode) ? mode : 'hybrid';
  cached = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ mode: next, changedAt: new Date().toISOString() }, null, 2));
  return next;
}
