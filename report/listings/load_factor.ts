    // 1. load factor: the median shift, over services and load signals
    const shifts: number[] = [];
    let contributing = 0;
    if (p.mode !== 'control') {
      for (const [id, x] of readings) {
        const r = refs.get(id); if (!r) continue;
        let used = false;
        // only a signal that carries traffic says anything about load: an idle database reads the same zeros either way
        for (const f of p.loadFeatures) if (x[f] !== null && r[f] !== null && (r[f] as number) - p.idle[f] >= p.active) { shifts.push((x[f] as number) - (r[f] as number)); used = true; }
        if (used) contributing++;
      }
    }
    const load = contributing >= p.minServices ? med(shifts) : 0;

    // 2. slopes: pooled over services and over the window (their stored loads against their shifts from the reference)
    const slopes = p.prior.slice();
    if (p.mode === 'pooled' && contributing >= p.minServices) {
      for (let f = 0; f < slopes.length; f++) {
        if (!p.loadFeatures.includes(f) && p.prior[f] === 0) continue;
        let sxy = 0, sxx = 0;
        for (const [id, s] of this.svc) {
          const r = refs.get(id); if (!r || r[f] === null || (r[f] as number) - p.idle[f] < p.active) continue;
          for (const e of s.win) if (e.x[f] !== null) { const d = (e.x[f] as number) - (r[f] as number); sxy += d * e.load; sxx += e.load * e.load; }
        }
        slopes[f] = (sxy + p.ridge * p.prior[f]) / (sxx + p.ridge);
      }
    }
    const usedSlopes = p.mode === 'control' ? p.prior.map(() => 0) : slopes;
    const shifted = Math.abs(load) >= 1;
