#!/usr/bin/env bash
# Build the study guide (needs pdflatex).
set -e
cd "$(dirname "$0")"
pdflatex -interaction=nonstopmode -halt-on-error main.tex >/dev/null
pdflatex -interaction=nonstopmode -halt-on-error main.tex >/dev/null
pdflatex -interaction=nonstopmode main.tex >/dev/null
echo "built report/guide/main.pdf: $(pdfinfo main.pdf | grep Pages)"
