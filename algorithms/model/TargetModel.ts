/**
 * The model of ONE architecture, trained on its own baseline every time the app loads. PURE: history in, model out.
 *
 *   shared weights    how much each signal counts. Learned offline from labelled faults on several systems (algorithms/learning) and checked
 *                     on a system they were not trained on, so they carry over to a new architecture.
 *   local calibration trained HERE, on this target's own recent fault-free history: where the alarm threshold sits. The
 *                     threshold is the highest persistent score this architecture produced while healthy. A score above
 *                     anything seen in the baseline is, by construction, unprecedented for this system.
 *
 * "Persistent" mirrors how alarms are raised: two consecutive cycles must agree, so a moment's score is the smaller of its
 * own and the previous moment's. The top 1% of baseline moments is trimmed so one unnoticed fault inside the baseline cannot
 * set the bar (that tolerates a baseline that is up to 1% faulty).
 *
 * Until the baseline spans `needSec` the model is 'learning' and the target raises incidents only for container facts.
 */
import { makeScorer, momentScores, type Weights } from '../detection/scoring.js';
import type { ServiceNode } from '../../server/models/ServiceNode.js';
import type { MetricSnapshot } from '../../server/models/MetricSnapshot.js';

export interface TargetModel {
  target: string;
  state: 'learning' | 'ready';
  trainedAt: string;
  /** Seconds of clean history the threshold was learned from, and how many are needed. */
  baselineSec: number;
  needSec: number;
  moments: number;
  services: number;
  scorer: 'learned' | 'rules';
  /** Alarm threshold on the scorer's output. */
  threshold: number;
  /** Highest persistent baseline score (after trimming) and the shared prior it was combined with. */
  noiseCeiling: number;
  prior: number | null;
}

/** Every tunable number of the per-target model (printed by the experiment report). */
export const TARGET_MODEL_PARAMS = {
  /** Samples a service needs before its own past can define "normal" (the detector's 12 plus the 2 judged). */
  minHistory: 14,
  /** Bounds the cost of training: at most this many moments of the baseline are scored. */
  maxMoments: 150,
  /** With at least this many moments, the top (1 - trimQuantile) share is trimmed before the ceiling is read. */
  trimMinMoments: 100, trimQuantile: 0.99,
  /** A gap between moments above this many typical gaps is an outage and does not count as baseline time. */
  outageGapFactor: 3,
} as const;
const MIN_HISTORY = TARGET_MODEL_PARAMS.minHistory;
const MAX_MOMENTS = TARGET_MODEL_PARAMS.maxMoments;

const stamp = (s: MetricSnapshot) => Date.parse(s.timestamp);

/** Number of leading elements with timestamp <= t (the series is oldest first). */
function prefixLen(ts: number[], t: number): number {
  let lo = 0, hi = ts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

export interface TrainInput {
  target: string;
  nodes: ServiceNode[];
  history: (id: string) => MetricSnapshot[];
  edges: [string, string][];
  weights: (Weights & { threshold: number }) | null;
  needSec: number;
  nowMs?: number;
  /** Moments to leave out of the baseline: while an incident was open (plus its recovery), the system was not healthy. */
  exclude?: (ts: number) => boolean;
}

export function trainTarget(input: TrainInput): TargetModel {
  const { target, nodes, edges, weights, needSec } = input;
  const scorer = makeScorer(weights);
  const prior = weights ? weights.threshold : null;
  const series = new Map(nodes.map((n) => [n.id, input.history(n.id)]));
  const stamps = new Map([...series].map(([id, h]) => [id, h.map(stamp)]));
  const all = [...new Set([...stamps.values()].flat().filter(Number.isFinite))].sort((a, b) => a - b);
  const stride = Math.max(1, Math.ceil(all.length / MAX_MOMENTS));
  const base: TargetModel = { target, state: 'learning', trainedAt: new Date(input.nowMs ?? Date.now()).toISOString(), baselineSec: 0, needSec,
    moments: 0, services: nodes.length, scorer: scorer.kind, threshold: prior ?? 0, noiseCeiling: 0, prior };

  const times: number[] = [], maxScore: number[] = [];
  for (let i = 0; i < all.length; i += stride) {
    const t = all[i];
    if (input.exclude?.(t)) continue;
    const lens = nodes.map((n) => prefixLen(stamps.get(n.id)!, t));
    if (Math.max(...lens) < MIN_HISTORY) continue;                       // warm-up: nobody has a past yet
    const hist = new Map(nodes.map((n, k) => [n.id, series.get(n.id)!.slice(0, lens[k])]));
    const scores = momentScores(nodes, (id) => hist.get(id) ?? [], edges, scorer);
    if (!scores.size) continue;
    times.push(t); maxScore.push(Math.max(...scores.values()));
  }
  base.moments = times.length;
  if (times.length < 3) return base;

  // clean span: the sum of gaps between consecutive kept moments, ignoring outages (gaps far above the usual pace)
  const gaps = times.slice(1).map((t, k) => t - times[k]).sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)] || 1;
  base.baselineSec = Math.round(gaps.filter((g) => g <= TARGET_MODEL_PARAMS.outageGapFactor * typical).reduce((a, b) => a + b, 0) / 1000);

  const persistent = maxScore.slice(1).map((s, k) => Math.min(s, maxScore[k])).sort((a, b) => a - b);
  const trim = persistent.length >= TARGET_MODEL_PARAMS.trimMinMoments ? Math.floor(TARGET_MODEL_PARAMS.trimQuantile * (persistent.length - 1)) : persistent.length - 1;
  base.noiseCeiling = persistent[trim];
  // the shared prior is the floor: a quiet architecture keeps the cross-system threshold, a noisy one raises the bar
  base.threshold = Math.max(prior ?? 0, base.noiseCeiling);
  base.state = base.baselineSec >= needSec ? 'ready' : 'learning';
  return base;
}
