      let top: Level['top'] = null;
      const zs = new Array<number>(NAMES.length).fill(0);
      if (ready) {
        for (let f = 0; f < NAMES.length; f++) {
          const xf = x[f];
          if (xf === null) continue;
          // The signal is judged under each hypothesis about how it follows the load: not at all (b = 0), or by the slope the
          // project shows (b = slope). It counts as unusual only if NEITHER explains it: a service that ignores the load
          // (a message bus idling at the same rate) and one that follows it (a gateway) are both handled before either has
          // been seen to move. With the load unchanged, both hypotheses agree.
          const betas = usedSlopes[f] === 0 || p.mode === 'control' ? [0] : [0, usedSlopes[f]];
          let zBest = Infinity;
          for (const b of betas) {
            const ck = `${f}|${b.toFixed(2)}`;
            let c = s.cache.get(ck);
            if (!c || this.tick - c.at >= p.refresh || Math.abs(c.n - s.win.length) > 20) {
              const rho = s.win.map((e) => (e.x[f] === null ? null : (e.x[f] as number) - b * e.load)).filter((v): v is number => v !== null);
              if (rho.length < p.minTrain * 0.6) continue;
              const base0 = med(rho);
              let spread0 = mad(rho, base0);
              if (p.scale === 'tail') {
                const sorted = [...rho].sort((a, c2) => a - c2), q = (u: number) => sorted[Math.min(sorted.length - 1, Math.floor(u * (sorted.length - 1)))];
                const up = (q(0.9) - base0) / 1.2816, down = (base0 - q(0.1)) / 1.2816;
                spread0 = Math.max(spread0, p.oneSided && UPPER_ONLY.has(f) ? up : Math.max(up, down));
              }
              c = { base: base0, spread: Math.max(spread0, p.floors[f]), at: this.tick, n: s.win.length };
              s.cache.set(ck, c);
            }
            const base = c.base, spread = c.spread;
            let zb = ((xf - b * load) - base) / spread;
            if (p.oneSided && UPPER_ONLY.has(f)) zb = Math.max(0, zb);
            zBest = Math.min(zBest, Math.abs(zb));
          }
          if (!Number.isFinite(zBest)) continue;
          let z = zBest;
          zs[f] = z;
          const lv = z / p.zLine;
          if (lv > level) { level = lv; score = z; top = { feature: NAMES[f], z }; }
          if (OWN.includes(f)) own = Math.max(own, lv); else symptom = Math.max(symptom, lv);
        }
