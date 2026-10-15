/**
 * The hybrid engine: the rule engine and the ML engine judge the same moment, and their verdicts are combined.
 *
 *   rules   robust z-score per metric (median, MAD), own versus inherited evidence. Scaled so 1 is its alarm line (3 sigma).
 *   ML      Isolation Forest level per service (1 = that service's learned alarm line) and the random walk's share.
 *   facts   a container that is down, stopped, paused, restarting, detached or crash-looping. Facts always come first.
 *
 * When to alarm (detection):
 *   rules / ml     one engine alone
 *   or             either engine over its line
 *   and            both engines over their lines
 *   or-strict      ML over its line, or the rules well over theirs (rulesAlone x the line): the rules catch what the
 *                  forests miss, without bringing all their false alarms
 *   agree          some service is over the line in BOTH engines (the same service), or a fact
 *
 * Who is first (ranking), after the facts:
 *   rules / ml     one engine's order
 *   blend          mlWeight x walk share (scaled to the top) + (1 - mlWeight) x rule score (scaled to the top)
 *   rrf            reciprocal rank fusion: 1/(60 + rank in ML) + 1/(60 + rank in rules) (Cormack et al. 2009)
 *
 * PURE: numbers in, numbers out.
 */
export type DetectionMode = 'rules' | 'ml' | 'or' | 'and' | 'or-strict' | 'agree';
export type RankingMode = 'rules' | 'ml' | 'blend' | 'rrf';
export const DETECTION_MODES: DetectionMode[] = ['rules', 'ml', 'or', 'and', 'or-strict', 'agree'];
export const RANKING_MODES: RankingMode[] = ['rules', 'ml', 'blend', 'rrf'];

export interface FusionParams { detection: DetectionMode; ranking: RankingMode; rulesAlone?: number; mlWeight?: number }
export const HYBRID_DEFAULTS: Required<FusionParams> = { detection: 'or-strict', ranking: 'ml', rulesAlone: 1.25, mlWeight: 0.5 };

export interface MomentInputs {
  services: string[];
  rules: Map<string, number>;     // rule score / 3: 1 = the rule engine's alarm line
  level: Map<string, number>;     // ML level: 1 = the service's learned alarm line (a fact counts as 10)
  hard: Set<string>;              // services with a container fact
  walk: Map<string, number>;      // random-walk share
  mlRanked: string[];
}
export interface Fused { max: number; ranked: string[]; scores: number[]; blend: Map<string, number> }

export function fuseMoment(x: MomentInputs, p: FusionParams): Fused {
  const { detection, ranking, rulesAlone, mlWeight } = { ...HYBRID_DEFAULTS, ...p };
  const ids = x.services;
  const r = (id: string) => Math.max(0, x.rules.get(id) ?? 0), l = (id: string) => x.level.get(id) ?? 0;
  const maxR = Math.max(0, ...ids.map(r)), maxL = Math.max(0, ...ids.map(l));
  const fact = x.hard.size > 0 ? 10 : 0;

  let max: number;
  switch (detection) {
    case 'rules': max = maxR; break;
    case 'ml': max = maxL; break;
    case 'or': max = Math.max(maxR, maxL); break;
    case 'and': max = Math.max(Math.min(maxR, maxL), fact); break;
    case 'or-strict': max = Math.max(maxL, maxR / rulesAlone); break;
    case 'agree': max = Math.max(fact, ...ids.map((id) => Math.min(r(id), l(id)))); break;
  }

  const rankIn = (order: string[]) => new Map(order.map((id, i) => [id, i + 1]));
  const rulesOrder = [...ids].sort((a, b) => r(b) - r(a) || a.localeCompare(b));
  const topW = Math.max(1e-9, ...ids.map((id) => x.walk.get(id) ?? 0)), topR = Math.max(1e-9, maxR);
  const blend = new Map(ids.map((id) => [id, mlWeight * ((x.walk.get(id) ?? 0) / topW) + (1 - mlWeight) * (r(id) / topR)]));
  let score: (id: string) => number;
  if (ranking === 'rules') score = (id) => r(id);
  else if (ranking === 'ml') { const k = rankIn(x.mlRanked); score = (id) => -(k.get(id) ?? 1e6); }
  else if (ranking === 'rrf') { const a = rankIn(x.mlRanked), b = rankIn(rulesOrder); score = (id) => 1 / (60 + (a.get(id) ?? ids.length)) + 1 / (60 + (b.get(id) ?? ids.length)); }
  else score = (id) => blend.get(id)!;
  const ranked = [...ids].sort((a, b) => (Number(x.hard.has(b)) - Number(x.hard.has(a))) || (score(b) - score(a)) || a.localeCompare(b));
  return { max, ranked, scores: ids.map((id) => blend.get(id)!), blend };
}
