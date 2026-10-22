      const rulesHotNow = rulesTop >= 1, mlHotNow = r.hot, hybridHotNow = fused.max >= 1;
      sh.moments++;
      if (rulesHotNow) sh.rulesHot++;
      if (mlHotNow) sh.mlHot++;
      if (hybridHotNow) sh.hybridHot++;
      const round = (x: number) => +x.toFixed(2);
      const fact = (id: string) => r.services.get(id)?.fact;
      sh.now = {
        rulesTop: round(rulesTop), mlTop: round(mlTop), hybridMax: round(Math.min(fused.max, 10)),
        rulesRanked: [...rulesLine].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0).slice(0, 3).map(([id]) => id),
        mlRanked: r.ranked.slice(0, 3),
        hybridRanked: fused.ranked.slice(0, 3),
      };
      sh.engines = {
        rules: { alarm: rulesHotNow && prev.rules, peak: round(rulesTop), suspects: [...rulesLine].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0).slice(0, 5).map(([id, v]) => ({ id, score: round(v), fact: fact(id) })) },
        ml: { alarm: mlHotNow && prev.ml, peak: round(mlTop), suspects: r.ranked.slice(0, 5).map((id) => ({ id, score: +(r.rank.get(id) ?? 0).toFixed(3), fact: fact(id) })) },
        hybrid: { alarm: hybridHotNow && prev.hybrid, peak: round(Math.min(fused.max, 10)), suspects: fused.ranked.slice(0, 5).map((id) => ({ id, score: round(fused.blend.get(id) ?? 0), fact: fact(id) })) },
      };
      sh.prev = { rules: rulesHotNow, ml: mlHotNow, hybrid: hybridHotNow };
