/**
 * Live use of the model learned by algorithms/learning (server/rca/model/learned.json): for every service, the probability that it is
 * the cause right now, and which features pushed that probability up or down.
 *
 * The features are computed by server/rca/features.ts, the same code the learner used, from the same metric history the
 * detector reads. No model file means no learned scoring: the mapper falls back to the rule-based ranking.
 */
import fs from 'node:fs';
import path from 'node:path';
import { featureVectors, nodeSignals, FEATURE_NAMES } from '../../algorithms/detection/features.js';
import { isLoadGenerator } from '../../algorithms/detection/containerFacts.js';
import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';

export interface LearnedModel { kind: 'logistic'; mean: number[]; std: number[]; w: number[]; b: number; threshold: number; persistence: number; features: string[]; faults: number; trainedAt: string }
export interface LearnedScores { p: Map<string, number>; why: Map<string, { feature: string; value: number }[]>; threshold: number; maxP: number; top: string | null }

const MODEL_PATH = path.resolve(process.cwd(), 'rca', 'model', 'learned.json');
const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Plain-language names for the features, for the "why this score" list. */
export const FEATURE_LABEL: Record<string, string> = {
  own: 'its own CPU, memory or throttling is off its normal', symptom: 'its errors, latency or traffic are off their normal',
  cpu: 'CPU above its normal', memory: 'memory above its normal', throttle: 'held back by its CPU limit', netDrop: 'network traffic fell',
  reqDrop: 'requests fell', errRise: 'error share rose', latRise: 'latency rose', down: 'container is down', paused: 'container is paused',
  restarting: 'container restarted', detached: 'container lost its network', callersSymptomMax: 'services that call it are suffering',
  callersSymptomMean: 'its callers, on average, are suffering', calleesEvidenceMax: 'a service it calls is broken (explains it away)',
  hasRequests: 'serves requests', noData: 'no telemetry from it',
};

export function scoreWithModel(model: Pick<LearnedModel, 'mean' | 'std' | 'w' | 'b' | 'features'>, x: number[]) {
  let z = model.b; const why: { feature: string; value: number }[] = [];
  x.forEach((v, j) => { const c = model.w[j] * ((v - model.mean[j]) / (model.std[j] || 1)); z += c; why.push({ feature: model.features[j], value: c }); });
  return { p: sigmoid(z), why: why.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)) };
}

export class LearnedScorer {
  private model: LearnedModel | null = null;
  private mtime = 0;

  constructor(private readonly modelPath = MODEL_PATH) {}

  /** Re-read the model when the file changes (training writes a new one without a restart). */
  current(): LearnedModel | null {
    if (process.env.MAPPER_LEARNED === '0') return null;
    try {
      const st = fs.statSync(this.modelPath);
      if (st.mtimeMs !== this.mtime) {
        const m = JSON.parse(fs.readFileSync(this.modelPath, 'utf8'));
        const ok = m.kind === 'logistic' && Array.isArray(m.w) && m.w.length === FEATURE_NAMES.length && FEATURE_NAMES.every((f, i) => m.features?.[i] === f);
        this.model = ok ? m : null;
        this.mtime = st.mtimeMs;
        if (!ok) console.warn('[LearnedScorer] model file does not match the current features; using the rule-based ranking');
      }
    } catch { this.model = null; this.mtime = 0; }
    return this.model;
  }

  score(nodes: ServiceNode[], edges: DependencyEdge[], history: (id: string) => MetricSnapshot[], threshold?: number): LearnedScores | null {
    const model = this.current();
    if (!model) return null;
    nodes = nodes.filter((n) => !isLoadGenerator(n.name));
    const signals = nodes.map((n) => nodeSignals(n, history(n.id)));
    const pairs = edges.filter((e) => e.observed).map((e) => [e.source, e.target] as [string, string]);
    const names = new Map(nodes.map((n) => [n.id, n.name]));
    const fv = featureVectors(signals, pairs, (id) => names.get(id) ?? id);
    const p = new Map<string, number>(), why = new Map<string, { feature: string; value: number }[]>();
    let maxP = 0, top: string | null = null;
    for (const n of nodes) {
      const s = scoreWithModel(model, fv.get(n.id)!);
      p.set(n.id, s.p); why.set(n.id, s.why);
      if (s.p > maxP) { maxP = s.p; top = n.id; }
    }
    return { p, why, threshold: threshold ?? model.threshold, maxP, top };
  }
}
