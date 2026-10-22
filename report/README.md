# Project report

The Phase II project report, "Probabilistic Cascading Failure and Agent Assisted Root Cause Analysis for Microservice Systems", in the department's layout (cover, certificate, declaration, acknowledgements, abstract, contents, lists, seven chapters, references, appendices).

```
report/build.sh                  # Mermaid diagrams (if mmdc is installed) + pdflatex + bibtex -> report/main.pdf
report/build.sh --no-diagrams    # use the committed diagram PDFs
```

Needs `pdflatex` and `bibtex`. To redraw the diagrams: `npm i -g @mermaid-js/mermaid-cli`, then set `PUPPETEER_CONFIG` to a JSON with `executablePath` of a Chromium if mmdc cannot find one.

## Where things are

| Path | What |
|---|---|
| `meta.tex` | Names, USNs, guide, HOD, principal, course line. Lines marked CHECK were copied from the department's reference report |
| `chapters/` | One file per chapter, plus the appendices |
| `frontmatter/` | Cover, certificate, declaration, acknowledgements, abstract, lists |
| `diagrams/*.mmd` | Mermaid sources; the rendered `.pdf` next to each is what the report includes |
| `figures/` | Result figures from `paper/`, dashboard screenshots (`ui_*`, `ui3d_*`), Grafana and Fault Lab screenshots |
| `listings/` | Source excerpts quoted verbatim from the repository |

## Replacing screenshots

The dashboard screenshots were taken on the simulator-driven shop. The Grafana pictures are the ones from each bench's `docs/dashboard.png`. The Fault Lab pictures were taken of the control page with no bench running (services read "absent"); to replace them with live ones, save the new images over `figures/faultlab_shopflow.png` and `figures/faultlab_ledgerline.png` and rebuild.
