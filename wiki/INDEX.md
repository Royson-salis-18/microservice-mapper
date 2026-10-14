# Documentation index

Open **wiki/visualizer/index.html`** in a browser for the readable version (diagrams, search, reading path). The Markdown sources are listed here.

| I want to… | Read | Where | Audience |
|---|---|---|---|
| Prepare for the evaluation in one hour | Evaluation guide | `wiki/00-evaluation-guide.md` | Presenters |
| Read the simple Python version of the logic | algorithms | `algorithms/README.md` | Presenters |
| Understand what each page of the app shows and how to read it | How each page works | `wiki/37-app-pages-guide.md` | Operator |
| Run everything on my own machine | Run it on your machine | `wiki/RUN_LOCAL.md` | Anyone |
| Know the whole system in one read | How it all works | `wiki/19-how-it-all-works.md` | Anyone |
| See the formulas (detector, root cause, cascade, graph) | Mapper algorithms | `wiki/MAPPER_ALGORITHMS.md` | Engineer |
| Understand the fault injector and traffic generator | Fault injection | `wiki/FAULT_INJECTION.md` | Tester |
| Look up an API endpoint or data shape | API reference, Data models | `wiki/13-api-reference.md`, `wiki/12-data-models.md` | Engineer |
| Find a term | Glossary | `wiki/36-glossary.md` | Anyone |
| Tour the code | Code tour | `wiki/34-code-tour.md` | Engineer |
| Fix something that broke | Troubleshooting | `wiki/15-troubleshooting.md` | Operator |
| Reach an EC2 host, check it, set up a bench, open the fault panel | SSH tools (scripts and the discovery algorithm) | `run/ssh/README.md` | Operator |
| Drive faults and traffic from a page, run the staged demo | Fault panel and staged demo | `wiki/40-faultlab-panel-and-demo.md` | Tester |
| Know what the tests measure and what they found | Experiment report | `wiki/38-experiment-report.md` | Everyone |
| See every chart, every hyperparameter and where the data is stored | The model lab | `graphs/output/model-lab.html`, `wiki/42-model-lab.md` | Everyone |
| See what is planned next | UI redesign, ML separation | `wiki/UI_REDESIGN_PLAN.md`, `wiki/ML_SEPARATION_PLAN.md` | Team |

Rebuild the visual docs after editing any Markdown: `python3 wiki/build_visualizer.py`.
