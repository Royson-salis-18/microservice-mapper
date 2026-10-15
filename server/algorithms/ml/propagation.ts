/**
 * Which healthy services will a failure reach next? A cascade model learned from the system's own history.
 *
 * Every time a service turns abnormal, each service that calls it (and was fine at that moment) is a trial: did the
 * caller turn abnormal too within `windowSteps`? The success rate per call edge is its propagation probability, with a
 * Beta prior (`prior`, worth `priorWeight` trials) so a rarely seen edge starts at the prior and moves with evidence:
 *
 *   p(caller <- callee) = (successes + priorWeight * prior) / (trials + priorWeight)
 *
 * Risk then travels up the call graph from the root (noisy-OR over the services each caller depends on):
 *
 *   risk(root) = 1,    risk(c) = 1 - prod over callees x of c of (1 - risk(x) * p(c <- x))
 *
 * This is the independent-cascade model (Kempe, Kleinberg and Tardos 2003) with edge probabilities estimated online.
 * PURE apart from its own counters.
 */
export interface PropagationParams { windowSteps: number; prior: number; priorWeight: number }
export const PROPAGATION_DEFAULTS: PropagationParams = { windowSteps: 12, prior: 0.5, priorWeight: 2 };

interface Trial { caller: string; callee: string; until: number }

export class PropagationModel {
  private counts = new Map<string, { trials: number; successes: number }>();
  private open: Trial[] = [];
  constructor(private readonly p: PropagationParams = PROPAGATION_DEFAULTS) {}

  private key = (caller: string, callee: string) => `${caller}\u0000${callee}`;

  /** Probability that trouble in `callee` reaches `caller`. */
  prob(caller: string, callee: string): number {
    const c = this.counts.get(this.key(caller, callee)) ?? { trials: 0, successes: 0 };
    return (c.successes + this.p.priorWeight * this.p.prior) / (c.trials + this.p.priorWeight);
  }

  edgeStats(): { caller: string; callee: string; trials: number; successes: number; p: number }[] {
    return [...this.counts].map(([k, c]) => { const [caller, callee] = k.split('\u0000'); return { caller, callee, ...c, p: this.prob(caller, callee) }; });
  }

  /**
   * One step: `onsets` turned abnormal now, `abnormal` is everything abnormal now, `callersOf` gives who calls whom.
   */
  update(step: number, onsets: string[], abnormal: Set<string>, callersOf: (id: string) => string[]): void {
    // settle trials: success as soon as the caller is abnormal, failure when the window runs out
    const still: Trial[] = [];
    for (const t of this.open) {
      const c = this.counts.get(this.key(t.caller, t.callee)) ?? { trials: 0, successes: 0 };
      if (abnormal.has(t.caller)) { c.trials++; c.successes++; this.counts.set(this.key(t.caller, t.callee), c); }
      else if (step >= t.until) { c.trials++; this.counts.set(this.key(t.caller, t.callee), c); }
      else still.push(t);
    }
    this.open = still;
    for (const x of onsets) for (const caller of callersOf(x)) {
      if (abnormal.has(caller) || this.open.some((t) => t.caller === caller && t.callee === x)) continue;
      this.open.push({ caller, callee: x, until: step + this.p.windowSteps });
    }
  }

  /** Risk that each service is reached from `root` (services already abnormal are left out of the answer). */
  risk(root: string, abnormal: Set<string>, callersOf: (id: string) => string[], calleesOf: (id: string) => string[]): Map<string, number> {
    const risk = new Map<string, number>([[root, 1]]);
    // breadth-first up the callers; a few sweeps settle the noisy-OR on small graphs
    for (let sweep = 0; sweep < 4; sweep++) {
      const frontier = [...risk.keys()];
      const seen = new Set(frontier);
      while (frontier.length) {
        const x = frontier.shift()!;
        for (const c of callersOf(x)) {
          if (c === root) continue;
          let keep = 1;
          for (const y of calleesOf(c)) { const ry = risk.get(y); if (ry) keep *= 1 - ry * this.prob(c, y); }
          risk.set(c, 1 - keep);
          if (!seen.has(c)) { seen.add(c); frontier.push(c); }
        }
      }
    }
    risk.delete(root);
    for (const id of abnormal) risk.delete(id);
    return risk;
  }

  forget(): void { this.counts.clear(); this.open = []; }
}
