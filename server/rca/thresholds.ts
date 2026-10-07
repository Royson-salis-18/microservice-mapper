import fs from 'fs';
import path from 'path';

/**
 * The rules that decide what counts as an incident.
 *
 * Incidents are deliberately rule-based and completely separate from the ML
 * pipeline. Nothing here loads a model, and the trained detectors never feed
 * this path — that separation is the point. The models are a research
 * artefact whose output belongs in Findings, and they need training data,
 * a fitted artefact per service and a scorer process to say anything at all.
 * An incident has to fire on a service that started five minutes ago, on a
 * target whose models were never trained, while the scorer is stopped. A
 * fixed rule on a live metric does that; an Isolation Forest does not.
 *
 * It also keeps the research honest. If incidents were driven by the models,
 * every evaluation of those models would be scored against alerts the models
 * themselves raised.
 *
 * These numbers were hardcoded across AnomalyDetector, where they could not
 * be seen or changed without editing source. They are defaults now, not
 * constants: data/incident_thresholds.json overrides any of them.
 */
export interface IncidentThresholds {
  /** Samples of history required before z-scores mean anything. */
  minHistorySamples: number;
  /** |z| at or above this is an anomaly at all. */
  zScoreAnomaly: number;
  /** …and HIGH at or above this. */
  zScoreHigh: number;
  /** …and CRITICAL at or above this. */
  zScoreCritical: number;
  /** A z-score only counts if the metric also moved at least this many points from its baseline mean. */
  minDeltaPercent: number;
  /** Absolute percent that forces HIGH regardless of z. */
  absoluteHighPercent: number;
  /** Absolute percent that forces CRITICAL regardless of z. */
  absoluteCriticalPercent: number;
  /**
   * Below this standard deviation a baseline is treated as flat. A z-score
   * against a flat baseline divides by ~0 and explodes, so the flat case is
   * judged on absolute movement instead.
   */
  flatlineStdDev: number;
  /** On a flat baseline, a move this many points is the anomaly. */
  flatlineDeltaPercent: number;
  /** …and CRITICAL if the value itself is above this. */
  flatlineCriticalPercent: number;
  /** Critical services needed before an incident is CRITICAL rather than HIGH. */
  criticalServicesForCritical: number;
}

export const DEFAULT_THRESHOLDS: IncidentThresholds = {
  minHistorySamples: 12,
  zScoreAnomaly: 2.5,
  zScoreHigh: 3.0,
  zScoreCritical: 4.0,
  minDeltaPercent: 5,
  absoluteHighPercent: 70,
  absoluteCriticalPercent: 85,
  flatlineStdDev: 0.001,
  flatlineDeltaPercent: 30,
  flatlineCriticalPercent: 80,
  criticalServicesForCritical: 2,
};

/** Bounds that keep an edited value from producing nonsense. */
const LIMITS: Record<keyof IncidentThresholds, [number, number]> = {
  minHistorySamples: [2, 1000],
  zScoreAnomaly: [0.5, 10],
  zScoreHigh: [0.5, 15],
  zScoreCritical: [0.5, 20],
  minDeltaPercent: [0, 100],
  absoluteHighPercent: [1, 100],
  absoluteCriticalPercent: [1, 100],
  flatlineStdDev: [0.0000001, 10],
  flatlineDeltaPercent: [1, 100],
  flatlineCriticalPercent: [1, 100],
  criticalServicesForCritical: [1, 1000],
};

/**
 * Number(), but only for things that are genuinely numeric.
 *
 * Number(null) is 0 and Number([]) is 0, both finite, so a plain
 * Number.isFinite guard lets `{"zScoreAnomaly": null}` through and clamps it
 * to the minimum — which is the most sensitive possible setting, making every
 * sample anomalous. Silently turning a malformed edit into an alert storm is
 * the worst available failure, so anything not a number or a numeric string
 * is rejected and the previous value stands.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function configPath(): string {
  return path.resolve(process.cwd(), 'data', 'incident_thresholds.json');
}

/**
 * Read the overrides, clamped. Anything missing or out of range falls back
 * to the default rather than failing: a malformed file should not stop
 * incident detection, which is the one thing that has to keep working.
 */
export function loadThresholds(): IncidentThresholds {
  const merged: IncidentThresholds = { ...DEFAULT_THRESHOLDS };
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof IncidentThresholds)[]) {
      const value = toNumber(parsed?.[key]);
      if (value === null) continue;
      const [lo, hi] = LIMITS[key];
      merged[key] = Math.min(Math.max(value, lo), hi);
    }
  } catch {
    // No file yet, or unreadable — defaults stand.
  }
  return merged;
}

export function saveThresholds(patch: Partial<Record<keyof IncidentThresholds, unknown>>): IncidentThresholds {
  const current = loadThresholds();
  const next: IncidentThresholds = { ...current };
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof IncidentThresholds)[]) {
    if (!(key in patch)) continue;
    const value = toNumber(patch[key]);
    if (value === null) continue;
    const [lo, hi] = LIMITS[key];
    next[key] = Math.min(Math.max(value, lo), hi);
  }
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export function thresholdLimits() {
  return LIMITS;
}

/** Plain-English description of each rule, shown next to it in the UI. */
export const THRESHOLD_DOCS: Record<keyof IncidentThresholds, string> = {
  minHistorySamples:
    'How many past samples a service needs before it is judged at all. Below this it is skipped rather than guessed at, so a service that just started does not alert on its first reading.',
  zScoreAnomaly:
    'How far from its own recent baseline a metric must move to count as anomalous, in standard deviations. Lower fires more often.',
  zScoreHigh: 'Deviation at or above this is HIGH rather than MEDIUM.',
  zScoreCritical: 'Deviation at or above this is CRITICAL.',
  minDeltaPercent:
    'Even a large z-score is ignored unless the metric moved this many percentage points from its baseline. Stops an idle service going from 0.05% to 2% CPU from raising an incident.',
  absoluteHighPercent:
    'A CPU or memory reading above this is HIGH no matter how calm the baseline is — a service pinned at 75% is worth seeing even if it has been there long enough to look normal.',
  absoluteCriticalPercent: 'A reading above this is CRITICAL regardless of deviation.',
  flatlineStdDev:
    'Below this standard deviation the baseline counts as flat. Dividing by a near-zero deviation makes z-scores explode, so the flat case is judged on absolute movement instead.',
  flatlineDeltaPercent:
    'On a flat baseline, how many points a metric must jump to be anomalous. This is the rule that catches an idle service suddenly doing work.',
  flatlineCriticalPercent: 'On a flat baseline, a value above this is CRITICAL rather than HIGH.',
  criticalServicesForCritical:
    'How many services must be critical at once before the whole incident is CRITICAL rather than HIGH.',
};
