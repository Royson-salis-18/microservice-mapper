#!/usr/bin/env bash
# Build the report: render the Mermaid diagrams, then pdflatex + bibtex.
#   report/build.sh            full build
#   report/build.sh --no-diagrams   skip the Mermaid step (the PDFs in diagrams/ are committed)
# Mermaid needs @mermaid-js/mermaid-cli and a Chromium: set MMDC and PUPPETEER_CONFIG to use your own.
set -e
cd "$(dirname "$0")"
if [ "$1" != "--no-diagrams" ]; then
  MMDC="${MMDC:-$(command -v mmdc || true)}"
  if [ -z "$MMDC" ]; then echo "mmdc not found: using the committed diagram PDFs"; else
    PCFG=""; [ -n "$PUPPETEER_CONFIG" ] && PCFG="-p $PUPPETEER_CONFIG"
    for f in diagrams/*.mmd; do
      out="${f%.mmd}.pdf"
      if [ ! -f "$out" ] || [ "$f" -nt "$out" ]; then echo "diagram $f"; "$MMDC" -i "$f" -o "$out" -c diagrams/mermaid.json $PCFG -b white --pdfFit -q; fi
    done
  fi
fi
pdflatex -interaction=nonstopmode -halt-on-error main.tex >/dev/null
bibtex main >/dev/null || true
pdflatex -interaction=nonstopmode main.tex >/dev/null
pdflatex -interaction=nonstopmode main.tex >/dev/null
echo "built report/main.pdf: $(pdfinfo main.pdf | grep Pages)"
