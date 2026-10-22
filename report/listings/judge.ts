  judge(v: (number | null)[]): { score: number; level: number } {
    if (!this.models.length) return { score: 0, level: 0 };
    // a one-sided feature below its usual value is judged as if it were usual
    const x = this.project(v).map((val, k) => (this.p.oneSided && UPPER_ONLY.has(this.cols[k]) ? Math.max(val, this.fill[k]) : val));
    const levels = this.models.map((m) => { const sc = m.det.score(x); return { sc, lv: Math.max(0, (sc - m.typical) / Math.max(1e-6, m.line - m.typical)) }; });
    const modelLevel = levels.reduce((a, b) => a + b.lv, 0) / levels.length;
    // range guard: a value far outside anything seen in training would be cut off at the root of every tree, but the
    // forest scores it no higher than its most extreme training point. Count how many floors beyond the range it is.
    let rangeLevel = 0;
    if (this.p.rangeK > 0) x.forEach((val, k) => {
      const excess = Math.max(0, val - this.hi[k], this.lo[k] - val);
      rangeLevel = Math.max(rangeLevel, excess / (this.p.floors[this.cols[k]] * this.p.rangeK));
    });
    return { score: levels[0].sc, level: Math.max(modelLevel, rangeLevel) };
  }
