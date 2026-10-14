// Which engine decides incidents: the rule-based detector and ranking ("rules") or the learned one ("ml": a per-service
// Isolation Forest on a sliding window of normal readings, and a random walk on the call graph for the source).
// Saved in data/engine_mode.json so the choice survives a restart.
import fs from 'node:fs';
import path from 'node:path';

export type EngineMode = 'rules' | 'ml';
const file = () => path.resolve(process.cwd(), 'data', 'engine_mode.json');
let cached: EngineMode | null = null;

export function getEngineMode(): EngineMode {
  if (cached) return cached;
  const env = process.env.MAPPER_ENGINE;
  if (env === 'ml' || env === 'rules') return (cached = env);
  try {
    const m = JSON.parse(fs.readFileSync(file(), 'utf8')).mode;
    cached = m === 'ml' ? 'ml' : 'rules';
  } catch { cached = 'rules'; }
  return cached;
}

export function setEngineMode(mode: EngineMode): EngineMode {
  cached = mode === 'ml' ? 'ml' : 'rules';
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ mode: cached, changedAt: new Date().toISOString() }, null, 2));
  return cached;
}
