/**
 * One moment, one score per service. PURE. Two scorers share the features of features.ts:
 *   learned   a logistic model fitted offline on labelled faults (algorithms/learning): the probability this service is the cause
 *   rules     the earlier hand-written rule: its own evidence, or symptoms that no broken dependency explains, plus a large
 *             bonus for a container fact (down, paused, restarting, no network)
 * The per-target model (TargetModel.ts) calibrates the alarm threshold of whichever scorer is in use on that architecture's
 * own baseline, so the same weights work on a quiet system and on a noisy one.
 */
import { FEATURE_NAMES, featureVectors, nodeSignals } from './features.js';
import { isLoadGenerator } from './containerFacts.js';
import type { ServiceNode } from '../../server/models/ServiceNode.js';
import type { MetricSnapshot } from '../../server/models/MetricSnapshot.js';

const I = (n: string) => FEATURE_NAMES.indexOf(n as (typeof FEATURE_NAMES)[number]);
const ex = (v: number) => Math.expm1(v);

export interface Weights { mean: number[]; std: number[]; w: number[]; b: number; features: readonly string[] | string[] }
const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function learnedScore(m: Weights, x: number[]): number {
  let z = m.b; for (let j = 0; j < x.length; j++) z += m.w[j] * ((x[j] - m.mean[j]) / (m.std[j] || 1));
  return sigmoid(z);
}

export function rulesScore(x: number[]): number {
  const facts = Math.max(x[I('down')], x[I('paused')], x[I('restarting')], x[I('detached')]);
  return Math.max(ex(x[I('own')]), ex(x[I('symptom')]) - ex(x[I('calleesEvidenceMax')])) + 10 * facts;
}

export type Scorer = { kind: 'learned' | 'rules'; score: (x: number[]) => number };
export const makeScorer = (w: Weights | null): Scorer => (w ? { kind: 'learned', score: (x) => learnedScore(w, x) } : { kind: 'rules', score: rulesScore });

/** Scores for the judged services at one moment. `histories` holds, per node id, the readings up to that moment. */
export function momentScores(nodes: ServiceNode[], histories: (id: string) => MetricSnapshot[], edges: [string, string][], scorer: Scorer): Map<string, number> {
  const judged = nodes.filter((n) => !isLoadGenerator(n.name));
  const signals = judged.map((n) => nodeSignals(n, histories(n.id)));
  const names = new Map(nodes.map((n) => [n.id, n.name]));
  const fv = featureVectors(signals, edges, (id) => names.get(id) ?? id);
  const out = new Map<string, number>();
  for (const n of judged) out.set(n.id, scorer.score(fv.get(n.id)!));
  return out;
}
