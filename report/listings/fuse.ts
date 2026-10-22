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
