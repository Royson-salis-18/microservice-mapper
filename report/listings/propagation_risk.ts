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
