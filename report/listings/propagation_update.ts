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
