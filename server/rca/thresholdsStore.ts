// Where the incident thresholds live on disk. The only file in rca/ that touches the filesystem; the rules themselves
// (defaults, limits, merge) are in thresholds.ts and are pure.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_THRESHOLDS, mergeThresholds, type IncidentThresholds } from './thresholds.js';

function configPath(): string {
  return path.resolve(process.cwd(), 'data', 'incident_thresholds.json');
}

/** Read the overrides, clamped. No file, or an unreadable one: the defaults stand. */
export function loadThresholds(): IncidentThresholds {
  try {
    return mergeThresholds(DEFAULT_THRESHOLDS, JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export function saveThresholds(patch: Partial<Record<keyof IncidentThresholds, unknown>>): IncidentThresholds {
  const next = mergeThresholds(loadThresholds(), patch);
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}
