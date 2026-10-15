# Research paper

IEEE conference paper on the microservice mapper: the hybrid detector, the evidence-weighted dependency graph, learned
call directions, the calibrated cascade model and change-point detection, evaluated on the real benches (62 faults) and the
synthetic benchmark (178 held-out faults).

- `main.tex`   the paper (IEEEtran, conference mode)
- `refs.bib`   bibliography
- `main.pdf`   the built paper (13 pages, IEEE journal format)
- `figures/`   vector PDF figures, built by `plots.py` from `data/*.json`
- `exp/`       experiment scripts that produce the data (curves, cascade calibration, detector ROC, amplification study, router)

Not included because they were not run: sensitivity sweeps (`fig_sweep` in `plots.py`) and the scalability benchmark (`exp/scale.ts`); the ensemble detector on the synthetic set.

Schematic figures are TikZ (`fig_arch.tex`, `fig_prop.tex`); data figures are matplotlib PDFs.

## Build

```
pdflatex main
bibtex main
pdflatex main
pdflatex main
```

Every number in the paper comes from the project's own reproducible commands: `npm run ml:compare`, `ml:hybrid`,
`ml:predict`, `ml:bench`, and the v2 modules `v2/causal/run.ts`, `v2/onset/run.ts`, `v2/diagnose/run.ts`. The real-bench
numbers use the 62-fault ledger after the parser fix (`server/algorithms/evaluation/score.ts`).
