#!/usr/bin/env python3
"""
Builds the Microservice Mapper book: wiki/*.md (plus a few READMEs) into
"wiki visualizer/*.html", with a contents page, an architecture map, chapter
diagrams and interactive labs.

    python3 scripts/build_wiki_visualizer.py

The labs re-implement real functions with the real constants. When a constant
changes in the code (an RCA weight, a threshold, a colour band), change the
lab here in the same commit.
"""

import os
import re
import html
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = BASE_DIR / "wiki visualizer"

# ---------------------------------------------------------------------------
# The book.
#
# This used to be 37 pages in eight overlapping buckets, ordered 19, 01, 02,
# 21, 23, 07, 25, 18, 08, 22... — which is why it read as a pile rather than
# something you could work through. Three of those pages were not docs at all:
# a 1,491-line monolith duplicating the whole wiki out of a temporary git
# worktree, a file that was a *prompt* rather than documentation, and a README
# from a duplicated "telemetry-platform (2)" folder. They are gone.
#
# What is left is ordered as one reading path: what the thing is, how it gets
# its data, how it builds a model, how it forms a judgement, how it drives the
# system, how it draws it, and then reference material you look things up in
# rather than read.
# ---------------------------------------------------------------------------

PARTS = [
    {"num": 'I', "title": 'Understanding the system', "blurb": 'What it is, the rules it is built on, the frameworks it uses, and what it does end to end.'},
    {"num": 'II', "title": 'Getting the data', "blurb": 'How it reaches a machine it was never installed on, and how each number it reads is kept exact.'},
    {"num": 'III', "title": 'Building the graph', "blurb": 'Turning raw socket and container observations into a model of the system.'},
    {"num": 'IV', "title": 'Forming a judgement', "blurb": 'Fixed rules, learned models, root cause, and cascade risk, and why those are kept apart.'},
    {"num": 'V', "title": 'Driving the system', "blurb": 'Generating traffic, because an idle system reveals very little.'},
    {"num": 'VI', "title": 'Seeing it', "blurb": 'What every colour, width and pulse on the screen means, and how the picture stays live.'},
    {"num": 'VII', "title": 'Trusting it, and working on it', "blurb": 'How the numbers are checked against ground truth, a tour of the code, and the loop every change goes through.'},
    {"num": 'VIII', "title": 'Reference', "blurb": 'Material to look things up in, not to read front to back.'},
]

# One accent per part, the same family as the app's island colours. Used for
# decoration only (hero numerals, rules, the progress bar), never for text
# that has to be read, so contrast stays with the theme's own colours.
PART_ACCENT = {
    "I": "#8f9cff", "II": "#38bdf8", "III": "#2ed3a0", "IV": "#c084fc",
    "V": "#2dd4bf", "VI": "#6b8cff", "VII": "#7fc8f0", "VIII": "#94a3b8",
}

DOCS_CONFIG = [
    {
        "id": 'index', "filename": 'index.html', "source": None,
        "title": 'Contents', "part": None, "category": 'Contents',
        "badge": 'START HERE', "badge_color": 'cyan',
        "desc": 'The reading path through the system, part by part.',
    },
    {
        "id": 'wiki-01-overview', "filename": '01-overview.html', "source": 'wiki/01-overview.md',
        "title": 'What this is, and why', "part": 'I', "category": 'Understanding the system',
        "badge": 'CONCEPT', "badge_color": 'blue',
        "desc": 'Watching a live microservice system from the outside, without installing anything inside it.',
        "learn": [
            'Why the whole design follows from one constraint: nothing may be installed on the target',
            'What agentless observation can and cannot see',
            'The difference between what a config file claims and what was actually observed',
        ],
    },
    {
        "id": 'wiki-37-app-pages', "filename": '37-app-pages-guide.html', "source": 'wiki/37-app-pages-guide.md',
        "title": 'How each page works', "part": 'I', "category": 'Understanding the system',
        "badge": 'APP GUIDE', "badge_color": 'green',
        "desc": 'Every page of the app: what it shows, where the data comes from, how to read it.',
    },
    {
        "id": 'docs-run-local', "filename": 'run-local.html', "source": 'docs/RUN_LOCAL.md',
        "title": 'Run it on your machine', "part": 'I', "category": 'Understanding the system',
        "badge": 'SETUP', "badge_color": 'green',
        "desc": 'Mac, Linux or Windows: start the mapper, a bench, inject faults, score the result.',
    },
    {
        "id": 'wiki-19-how-it-all-works', "filename": '19-how-it-all-works.html', "source": 'wiki/19-how-it-all-works.md',
        "title": 'How it all works', "part": 'I', "category": 'Understanding the system',
        "badge": 'THE WHOLE STORY', "badge_color": 'green',
        "desc": 'The complete walkthrough, in plain English first and then in detail.',
        "learn": [
            'The full loop: connect, discover, collect, model, judge, display',
            'Where each subsystem sits in that loop',
            'Which parts are measured and which are inferred',
        ],
    },
    {
        "id": 'wiki-29-design-principles', "filename": '29-design-principles.html', "source": 'wiki/29-design-principles.md',
        "title": 'The rules it is built on', "part": 'I', "category": 'Understanding the system',
        "badge": 'DESIGN', "badge_color": 'purple',
        "desc": 'Twelve rules that explain why the code looks the way it does, and every major design choice with its alternatives.',
        "learn": [
            'Why unmeasured is null and never zero, and the bug that rule came from',
            'Why observed evidence outranks declared, and by exactly how much',
            'What each major design decision was chosen over, and why',
        ],
    },
    {
        "id": 'wiki-02-architecture', "filename": '02-architecture.html', "source": 'wiki/02-architecture.md',
        "title": 'The four layers', "part": 'I', "category": 'Understanding the system',
        "badge": 'CORE ARCH', "badge_color": 'cyan',
        "desc": 'Collection, server processing, intelligence, and the frontend, and what crosses between them.',
        "learn": [
            'What runs where: your machine, the target, and the browser',
            'Which process owns which responsibility, and why traffic generation is separate',
            'Every port and protocol in play',
        ],
    },
    {
        "id": 'wiki-30-tech-stack', "filename": '30-tech-stack.html', "source": 'wiki/30-tech-stack.md',
        "title": 'Frameworks, and why each', "part": 'I', "category": 'Understanding the system',
        "badge": 'STACK', "badge_color": 'blue',
        "desc": 'Every library in the four programs, what it is used for here, and what it was chosen over.',
        "learn": [
            'Node + Express + ws + ssh2 on the server; React 19 + Vite + XYFlow + react-three-fiber in the client',
            'Why the ML pipeline is a separate Python process that talks through one file',
            'Exactly what crosses between the four programs, and over which channel',
        ],
    },
    {
        "id": 'architecture-map', "filename": 'architecture-map.html', "source": None,
        "title": 'The system, as one map', "part": 'I', "category": 'Understanding the system',
        "badge": 'INTERACTIVE', "badge_color": 'cyan',
        "desc": 'Every process, store and engine on one page, each linked to the chapter that explains it.',
        "learn": [
            'The path a measurement takes, from a socket on the target to a pulse on screen',
            'Where incidents, risk and ML findings are computed',
            'Which chapter to open for each box',
        ],
    },
    {
        "id": 'root-readme', "filename": 'readme.html', "source": 'README.md',
        "title": 'Running it yourself', "part": 'I', "category": 'Understanding the system',
        "badge": 'SETUP', "badge_color": 'green',
        "desc": 'Prerequisites, target setup, and the install runbook.',
        "learn": [
            'What you need on your machine and on the target',
            'How to register a target and start the stack',
        ],
    },
    {
        "id": 'wiki-21-connection-layer', "filename": '21-connection-layer.html', "source": 'wiki/21-connection-layer.md',
        "title": 'Reaching the target', "part": 'II', "category": 'Getting the data',
        "badge": 'SSH', "badge_color": 'cyan',
        "desc": 'The SSH layer, the agent that owns each target, and what happens when a host goes quiet.',
        "learn": [
            'How one SSH connection is shared by many commands',
            'Host-key checking, timeouts, and recovery',
        ],
    },
    {
        "id": 'wiki-23-endpoint-discovery', "filename": '23-endpoint-discovery.html', "source": 'wiki/23-endpoint-discovery.md',
        "title": 'Finding what is running', "part": 'II', "category": 'Getting the data',
        "badge": 'DISCOVERY', "badge_color": 'blue',
        "desc": 'Reading the container runtime and compose files to learn what exists and what it claims to depend on.',
        "learn": [
            'The loops per target: poll, sweep and rediscovery',
            'How services are named, classified and given declared dependencies',
        ],
    },
    {
        "id": 'wiki-31-measurement-precision', "filename": '31-measurement-precision.html', "source": 'wiki/31-measurement-precision.md',
        "title": 'Measuring precisely', "part": 'II', "category": 'Getting the data',
        "badge": 'PRECISION', "badge_color": 'green',
        "desc": 'What the raw sources get wrong, and how every published figure is made to agree with a hand check on the host.',
        "learn": [
            "Exact byte counters from /proc instead of Docker's three-significant-figure rounding",
            'CPU as a share of what the container may use, not of one core',
            'Counting distinct connections once each, and decoding IPv4 hidden in IPv6 tables',
        ],
    },
    {
        "id": 'wiki-25-telemetry-sources', "filename": '25-telemetry-sources.html', "source": 'wiki/25-telemetry-sources.md',
        "title": 'Where numbers come from', "part": 'II', "category": 'Getting the data',
        "badge": 'SOURCES', "badge_color": 'purple',
        "desc": 'The source abstraction, and how a metric carries its own provenance.',
        "learn": [
            'Why a socket scan may never fill a latency field',
            'How an optional Prometheus source is added without risking Tier 0',
        ],
    },
    {
        "id": 'wiki-18-telemetry-tiers-plan', "filename": '18-telemetry-tiers-plan.html', "source": 'wiki/18-telemetry-tiers-plan.md',
        "title": 'The three tiers of evidence', "part": 'II', "category": 'Getting the data',
        "badge": 'TIERS', "badge_color": 'orange',
        "desc": 'What is always available, what is sometimes available, and what only a self-instrumented target can give you.',
        "learn": [
            'Tier 0: from the outside, always',
            "Tier 1: a gateway's access log, sometimes",
            "Tier 2: the target's own metrics, opt-in per target",
        ],
    },
    {
        "id": 'wiki-03-graphstore', "filename": '03-graphstore.html', "source": 'wiki/03-graphstore.md',
        "title": 'The graph store', "part": 'III', "category": 'Building the graph',
        "badge": 'CORE', "badge_color": 'cyan',
        "desc": 'The single in-memory model everything else reads from.',
        "learn": [
            'How activity, baselines and distinct connections are computed per link',
            'Why an unobserved link has no activity field at all',
            'How broadcasts are coalesced and state is saved',
        ],
    },
    {
        "id": 'wiki-04-id-system', "filename": '04-id-system.html', "source": 'wiki/04-id-system.md',
        "title": 'Identity', "part": 'III', "category": 'Building the graph',
        "badge": 'IDS', "badge_color": 'red',
        "desc": 'One service, one id, and what goes wrong when that breaks.',
        "learn": [
            'The project:name form and normalizeId()',
            'Why incidents and cascade fields now carry ids, never names',
        ],
    },
    {
        "id": 'wiki-05-telemetry-ingestion', "filename": '05-telemetry-ingestion.html', "source": 'wiki/05-telemetry-ingestion.md',
        "title": 'Ingestion', "part": 'III', "category": 'Building the graph',
        "badge": 'INGEST', "badge_color": 'green',
        "desc": 'How a telemetry envelope becomes nodes, edges and metrics.',
        "learn": [
            'The stages of ingestRemote()',
            'How declared and observed evidence merge on one edge',
        ],
    },
    {
        "id": 'wiki-06-node-edge-lifecycle', "filename": '06-node-edge-lifecycle.html', "source": 'wiki/06-node-edge-lifecycle.md',
        "title": 'Lifecycle and direction', "part": 'III', "category": 'Building the graph',
        "badge": 'LIFECYCLE', "badge_color": 'orange',
        "desc": 'How nodes and edges appear, age, decay and disappear, and which way the arrows point.',
        "learn": [
            'How the listening port decides who is calling whom',
            'Ageing and pruning of nodes and edges',
        ],
    },
    {
        "id": 'wiki-17-findings-vs-incidents', "filename": '17-findings-vs-incidents.html', "source": 'wiki/17-findings-vs-incidents.md',
        "title": 'Two opinions, kept apart', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'PRINCIPLE', "badge_color": 'purple',
        "desc": 'Rule-based incidents and model-based findings, and why merging them would destroy both.',
        "learn": [
            'Why incidents must work with no training at all',
            'Why the models are never graded against their own alerts',
        ],
    },
    {
        "id": 'wiki-08-rca-engine', "filename": '08-rca-engine.html', "source": 'wiki/08-rca-engine.md',
        "title": 'Root cause', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'RCA', "badge_color": 'red',
        "desc": 'Five named evidence factors, a materiality cut-off and a victim penalty, with a worked example from the real engine.',
        "learn": [
            'Each factor, what it is worth, and why',
            "How 'explains' is measured through weighted dependency paths",
            'When RCA refuses to tell a single-cause story',
        ],
    },
    {
        "id": 'wiki-22-risk-engine', "filename": '22-risk-engine.html', "source": 'wiki/22-risk-engine.md',
        "title": 'Risk, cascades and blast radius', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'RELIABILITY', "badge_color": 'orange',
        "desc": 'Health, criticality and risk; the noisy-OR cascade model; what-if and blast radius, with numbers you can check by hand.',
        "learn": [
            'How health renormalises when a signal is missing',
            'The cascade formula, its one parameter, and what it is not',
            'The difference between what-if and blast radius',
        ],
    },
    {
        "id": 'wiki-11-ml-pipeline', "filename": '11-ml-pipeline.html', "source": 'wiki/11-ml-pipeline.md',
        "title": 'The learning pipeline', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'ML', "badge_color": 'green',
        "desc": "Four detectors per service, trained on that service's own history, combined by vote.",
        "learn": [
            'Why four detectors from four families',
            'How scores are put on one scale and voted on',
            "What 'persistent' means and why it matters",
        ],
    },
    {
        "id": 'wiki-26-ml-pipeline-deep-dive', "filename": '26-ml-pipeline-deep-dive.html', "source": 'wiki/26-ml-pipeline-deep-dive.md',
        "title": 'The pipeline, at code level', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'ML CODE', "badge_color": 'green',
        "desc": 'Feature construction, thresholds, the vote, and the failure modes worth knowing about.',
        "learn": [
            'Why LOF fits on distinct rows',
            'Why the old raw/threshold score broke, and what replaced it',
        ],
    },
    {
        "id": 'wiki-20-traffic-experiments', "filename": '20-traffic-experiments.html', "source": 'wiki/20-traffic-experiments.md',
        "title": 'Generating traffic', "part": 'V', "category": 'Driving the system',
        "badge": 'TRAFFIC', "badge_color": 'orange',
        "desc": 'The traffic controller, endpoint probing, and experiments.',
        "learn": [
            'Why an idle system reveals very little',
            'How endpoints are probed before load is driven at them',
        ],
    },
    {
        "id": 'traffic-gen-readme', "filename": 'traffic-gen-readme.html', "source": 'traffic-gen/README.md',
        "title": 'The load generator', "part": 'V', "category": 'Driving the system',
        "badge": 'SUBSYSTEM', "badge_color": 'orange',
        "desc": 'The standalone generator on port 4400 and its workflows.',
    },
    {
        "id": 'wiki-09-frontend', "filename": '09-frontend.html', "source": 'wiki/09-frontend.md',
        "title": 'The frontend', "part": 'VI', "category": 'Seeing it',
        "badge": 'CLIENT', "badge_color": 'blue',
        "desc": 'How the client is put together and how each view gets its data.',
        "learn": [
            'The hooks and components behind the views',
            'What each channel of a link encodes',
        ],
    },
    {
        "id": 'wiki-33-visual-language', "filename": '33-visual-language.html', "source": 'wiki/33-visual-language.md',
        "title": 'Reading the picture', "part": 'VI', "category": 'Seeing it',
        "badge": 'VISUAL', "badge_color": 'purple',
        "desc": 'What every colour, width and pulse means, the exact rule behind each, and why the interface looks the way it does.',
        "learn": [
            'The severity ladder that turns a link orange or red',
            "Why pulses move at a rate set by the link's traffic, on a log scale",
            'How the 3D islands are arranged, and why',
        ],
    },
    {
        "id": 'wiki-24-client-frontend', "filename": '24-client-frontend.html', "source": 'wiki/24-client-frontend.md',
        "title": 'Views, layouts and inspectors', "part": 'VI', "category": 'Seeing it',
        "badge": 'VIEWS', "badge_color": 'cyan',
        "desc": 'Every tab, the 2D and 3D layouts, the inspection panels, and the live data hook.',
        "learn": [
            'Which view answers which question',
            'How the data hook keeps re-renders proportional to what changed',
        ],
    },
    {
        "id": 'wiki-10-websocket', "filename": '10-websocket.html', "source": 'wiki/10-websocket.md',
        "title": 'Staying live', "part": 'VI', "category": 'Seeing it',
        "badge": 'REALTIME', "badge_color": 'green',
        "desc": 'The WebSocket protocol and what is pushed when.',
        "learn": [
            'The message types and when each is sent',
        ],
    },
    {
        "id": 'wiki-32-accuracy-and-self-check', "filename": '32-accuracy-and-self-check.html', "source": 'wiki/32-accuracy-and-self-check.md',
        "title": 'Keeping the numbers honest', "part": 'VII', "category": 'Trusting it, and working on it',
        "badge": 'ACCURACY', "badge_color": 'green',
        "desc": 'A ground-truth simulator, twelve live invariants, and the tests that pin every formula, plus what the audit fixed.',
        "learn": [
            'How a simulated target with known truth checks the whole pipeline',
            'The twelve consistency rules and the bug behind each',
            'Where the limits of accuracy still are',
        ],
    },
    {
        "id": 'wiki-34-code-tour', "filename": '34-code-tour.html', "source": 'wiki/34-code-tour.md',
        "title": 'A tour of the code', "part": 'VII', "category": 'Trusting it, and working on it',
        "badge": 'CODE', "badge_color": 'cyan',
        "desc": 'The repository map, one measurement and one failure followed through every file, and where to change what.',
        "learn": [
            'Where everything lives',
            'The fourteen steps from a socket on the host to a pulse on screen',
            'Which files to touch, and which to update with them, for common changes',
        ],
    },
    {
        "id": 'wiki-35-dev-workflow', "filename": '35-dev-workflow.html', "source": 'wiki/35-dev-workflow.md',
        "title": 'Working on it', "part": 'VII', "category": 'Trusting it, and working on it',
        "badge": 'WORKFLOW', "badge_color": 'orange',
        "desc": 'Run it, check it, prove it: tests, types, the isolated server and simulator, screenshots, and building this book.',
        "learn": [
            'The checks every change passes',
            'How to prove a number right end to end',
            'The traps: pkill -f, shared Vite caches, throttled preview panes',
        ],
    },
    {
        "id": 'wiki-36-glossary', "filename": '36-glossary.html', "source": 'wiki/36-glossary.md',
        "title": 'Glossary', "part": 'VIII', "category": 'Reference',
        "badge": 'TERMS', "badge_color": 'purple',
        "desc": 'Every term used in a specific sense, and where it is defined.',
    },
    {
        "id": 'wiki-12-data-models', "filename": '12-data-models.html', "source": 'wiki/12-data-models.md',
        "title": 'Data models', "part": 'VIII', "category": 'Reference',
        "badge": 'SCHEMA', "badge_color": 'blue',
        "desc": 'Every interface, with units and what null means.',
    },
    {
        "id": 'wiki-13-api-reference', "filename": '13-api-reference.html', "source": 'wiki/13-api-reference.md',
        "title": 'API reference', "part": 'VIII', "category": 'Reference',
        "badge": 'API', "badge_color": 'green',
        "desc": 'Every route, including reliability and the consistency check.',
    },
    {
        "id": 'wiki-14-configuration', "filename": '14-configuration.html', "source": 'wiki/14-configuration.md',
        "title": 'Configuration', "part": 'VIII', "category": 'Reference',
        "badge": 'CONFIG', "badge_color": 'orange',
        "desc": 'Environment variables, config files and data paths.',
    },
    {
        "id": 'wiki-15-troubleshooting', "filename": '15-troubleshooting.html', "source": 'wiki/15-troubleshooting.md',
        "title": 'Troubleshooting', "part": 'VIII', "category": 'Reference',
        "badge": 'RUNBOOK', "badge_color": 'red',
        "desc": 'Common problems and how to diagnose them.',
    },
    {
        "id": 'wiki-16-change-log-and-rationale', "filename": '16-change-log-and-rationale.html', "source": 'wiki/16-change-log-and-rationale.md',
        "title": 'Why things changed', "part": 'VIII', "category": 'Reference',
        "badge": 'HISTORY', "badge_color": 'purple',
        "desc": 'What changed, why, and where, including the accuracy audit and the visual redesign.',
    },
    {
        "id": 'wiki-07-remote-collector', "filename": '07-remote-collector.html', "source": 'wiki/07-remote-collector.md',
        "title": 'The optional push collector', "part": 'VIII', "category": 'Reference',
        "badge": 'OPTIONAL', "badge_color": 'orange',
        "desc": 'An agent you may choose to run on a host. Not the default path, which installs nothing.',
    },
    {
        "id": 'wiki-27-project-technical-reference', "filename": '27-project-technical-reference.html', "source": 'wiki/27-project-technical-reference.md',
        "title": 'Engineering manual', "part": 'VIII', "category": 'Reference',
        "badge": 'OLDER', "badge_color": 'blue',
        "desc": 'Long-form manual from an earlier stage. Where it disagrees, the chapters above win.',
    },
    {
        "id": 'wiki-41-learning', "filename": '41-learning-and-calibration.html', "source": 'wiki/41-learning-and-calibration.md',
        "title": 'Learning from labelled faults', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'ML', "badge_color": 'purple',
        "desc": 'What is learned and what is not, why the validation is blocked by time, and how it is compared with the rules.',
    },
    {
        "id": 'wiki-42-model-lab', "filename": '42-model-lab.html', "source": 'wiki/42-model-lab.md',
        "title": 'The model lab', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'REPORT', "badge_color": 'green',
        "desc": 'Every chart behind the detection and learning, every hyperparameter, and where the data lives. Open model-lab.html for the live charts.',
    },
    {
        "id": 'docs-algorithms', "filename": 'mapper-algorithms.html', "source": 'docs/MAPPER_ALGORITHMS.md',
        "title": 'Mapper algorithms', "part": 'IV', "category": 'Forming a judgement',
        "badge": 'MATH', "badge_color": 'purple',
        "desc": 'Detector, root-cause scoring, cascade and graph building, with the formulas.',
    },
    {
        "id": 'wiki-38-experiment-report', "filename": '38-experiment-report.html', "source": 'wiki/38-experiment-report.md',
        "title": 'Experiment report', "part": 'V', "category": 'Driving the system',
        "badge": 'RESULTS', "badge_color": 'green',
        "desc": 'The test protocol, every metric and statistic, and the latest scored run with charts.',
    },
    {
        "id": 'wiki-39-ssh-tools', "filename": '39-ssh-tools.html', "source": 'wiki/39-ssh-tools.md',
        "title": 'Reaching a host over SSH', "part": 'V', "category": 'Driving the system',
        "badge": 'SSH', "badge_color": 'blue',
        "desc": 'Scripts to check and set up a host, and the algorithm the mapper uses to connect.',
    },
    {
        "id": 'wiki-40-panel-demo', "filename": '40-faultlab-panel-and-demo.html', "source": 'wiki/40-faultlab-panel-and-demo.md',
        "title": 'Fault panel and staged demo', "part": 'V', "category": 'Driving the system',
        "badge": 'DEMO', "badge_color": 'blue',
        "desc": 'The control page for faults and traffic, the five-stage demo, and what each fault looks like to the mapper.',
    },
    {
        "id": 'docs-fault-injection', "filename": 'fault-injection.html', "source": 'docs/FAULT_INJECTION.md',
        "title": 'Fault injection', "part": 'V', "category": 'Driving the system',
        "badge": 'INJECTOR', "badge_color": 'blue',
        "desc": 'The blind injector and traffic generator: algorithm, pseudocode, flowcharts, options.',
    },
    {
        "id": 'docs-ml-plan', "filename": 'ml-separation-plan.html', "source": 'docs/ML_SEPARATION_PLAN.md',
        "title": 'ML separation plan', "part": 'VIII', "category": 'Reference',
        "badge": 'PLAN', "badge_color": 'blue',
        "desc": 'How the ML code will be split from the operator product.',
    },
    {
        "id": 'docs-ui-plan', "filename": 'ui-redesign-plan.html', "source": 'docs/UI_REDESIGN_PLAN.md',
        "title": 'UI redesign plan', "part": 'VIII', "category": 'Reference',
        "badge": 'PLAN', "badge_color": 'blue',
        "desc": 'Planned premium redesign, stored for later.',
    },
    {
        "id": 'wiki-28-mapper-technical-reference', "filename": '28-mapper-technical-reference.html', "source": 'wiki/28-mapper-technical-reference.md',
        "title": 'Subsystem reference', "part": 'VIII', "category": 'Reference',
        "badge": 'OLDER', "badge_color": 'blue',
        "desc": 'Subsystem notes from an earlier stage. Where they disagree, the chapters above win.',
    },
    {
        "id": 'ml-readme', "filename": 'ml-readme.html', "source": 'ml/README.md',
        "title": 'ML subsystem readme', "part": 'VIII', "category": 'Reference',
        "badge": 'SUBSYSTEM', "badge_color": 'green',
        "desc": 'Running the Python pipeline directly.',
    },
]

CSS_STYLES = """
  /* Same language as the app: navy and indigo, warm colours only for trouble. */
  :root {
    --bg:        #f5f6fb;
    --panel:     #ffffff;
    --panel-2:   #eef0f8;
    --ink:       #12142a;
    --ink-2:     #363b5c;
    --muted:     #6c7293;
    --faint:     #9aa0bd;
    --rule:      #dcdfee;
    --rule-2:    #e9ebf5;

    --sig:       #4f5bd5;
    --sig-bg:    rgba(79, 91, 213, 0.10);
    --ok:        #0b8a5c;
    --warn:      #b5650a;
    --err:       #c42443;
    --t0:        #6c7293;
    --t1:        #b5650a;
    --t2:        #2f78c4;
    --link-calm: #4f7dff; --link-busy: #2f9bff; --link-heavy: #1fd1ff; --link-sat: #9cf4ff;
    --link-orange: #ff9a3c; --link-red: #ff3d5e; --link-idle: #5b6aa0;

    --body: 'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:      #070914;
      --panel:   #0d1122;
      --panel-2: #131a30;
      --ink:     #e7eaf8;
      --ink-2:   #b0b6d4;
      --muted:   #7a81a6;
      --faint:   #4f5679;
      --rule:    #1c2340;
      --rule-2:  #151b33;
      --sig:     #8f9cff;
      --sig-bg:  rgba(143, 156, 255, 0.10);
      --ok:      #25e3a3;
      --warn:    #ffab40;
      --err:     #ff5f7a;
      --t0:      #7a81a6;
      --t1:      #ffab40;
      --t2:      #5fb4f0;
    }
  }
  :root[data-theme="dark"] {
    --bg:      #070914;  --panel:   #0d1122;  --panel-2: #131a30;
    --ink:     #e7eaf8;  --ink-2:   #b0b6d4;  --muted:   #7a81a6;
    --faint:   #4f5679;  --rule:    #1c2340;  --rule-2:  #151b33;
    --sig:     #8f9cff;  --sig-bg:  rgba(143, 156, 255, 0.10);
    --ok:      #25e3a3;  --warn:    #ffab40;  --err:     #ff5f7a;
    --t0:      #7a81a6;  --t1:      #ffab40;  --t2:      #5fb4f0;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) body { background: radial-gradient(1200px 600px at 20% -10%, #121a3a 0%, transparent 60%), var(--bg); background-attachment: fixed; } }
  :root[data-theme="dark"] body { background: radial-gradient(1200px 600px at 20% -10%, #121a3a 0%, transparent 60%), var(--bg); background-attachment: fixed; }

  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.6; margin: 0; padding: 0; }
  .wrap { max-width: 1160px; margin: 0 auto; padding-inline: 20px; padding-block: 0 90px; }

  .hd { padding-block: 54px 26px; border-bottom: 1px solid var(--rule); margin-bottom: 8px; }
  .hd .eye { font-family: var(--mono); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--sig); margin-bottom: 14px; }
  h1 { font-size: clamp(30px, 5vw, 46px); font-weight: 700; letter-spacing: -.03em; line-height: 1.05; margin: 0 0 14px; color: var(--ink); }
  .hd p, .lead { color: var(--ink-2); max-width: 76ch; margin: 0 0 14px; font-size: 15px; }

  .metadata-strip { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 10px; margin-bottom: 14px; }
  .meta-item { display: inline-flex; align-items: center; gap: 4px; }

  .toc { display: flex; flex-wrap: wrap; gap: 7px; padding-block: 22px 8px; }
  .toc a {
    font-family: var(--mono); font-size: 11.5px; letter-spacing: .04em;
    color: var(--muted); text-decoration: none;
    border: 1px solid var(--rule); border-radius: 6px; padding: 5px 11px;
    background: var(--panel); transition: all 0.2s;
  }
  .toc a:hover, .toc a:focus-visible { color: var(--sig); border-color: var(--sig); outline: none; background: var(--panel-2); }

  section { padding-block: 44px 0; scroll-margin-top: 20px; }
  h2 {
    font-size: 24px; font-weight: 700; letter-spacing: -.022em; margin: 0 0 6px;
    display: flex; align-items: baseline; gap: 11px; flex-wrap: wrap;
    color: var(--ink); border-bottom: 1px solid var(--rule); padding-bottom: 8px;
  }
  h2 .id { font-family: var(--mono); font-size: 12px; font-weight: 500; color: var(--sig); letter-spacing: .06em; }
  h3 { font-size: 16px; font-weight: 600; margin: 26px 0 9px; letter-spacing: -.008em; color: var(--ink); }
  h4 { font-size: 13.5px; font-weight: 600; margin: 18px 0 7px; color: var(--ink-2); }
  p { margin: 0 0 14px; max-width: 76ch; color: var(--ink-2); }
  p:last-child { margin-bottom: 0; }
  strong { color: var(--ink); font-weight: 600; }

  a {
    color: var(--sig);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--sig) 40%, transparent);
    text-underline-offset: 3px;
    font-weight: 500;
  }
  a:hover {
    color: var(--sig);
    text-decoration-color: var(--sig);
  }

  code {
    font-family: var(--mono); font-size: .875em;
    background: var(--panel-2); padding: 1.5px 5px; border-radius: 4px; color: var(--ink);
  }
  pre {
    font-family: var(--mono); font-size: 12.5px; line-height: 1.62;
    background: var(--panel); border: 1px solid var(--rule); border-radius: 9px;
    padding: 16px 18px; overflow-x: auto; margin: 0 0 16px; color: var(--ink-2);
  }
  pre b { color: var(--sig); font-weight: 500; }
  pre i { color: var(--muted); font-style: normal; }
  pre .g { color: var(--ok); }
  pre .r { color: var(--err); }

  .panel { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 20px 22px; }

  .t { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .t th {
    text-align: left; font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em;
    text-transform: uppercase; color: var(--muted); font-weight: 400;
    padding: 0 14px 9px 0; border-bottom: 1px solid var(--rule); white-space: nowrap;
  }
  .t td { padding: 10px 14px 10px 0; border-bottom: 1px solid var(--rule-2); vertical-align: top; color: var(--ink-2); }
  .t tr:last-child td { border-bottom: none; }
  .t td:first-child { color: var(--ink); font-weight: 500; }
  .t code { background: none; padding: 0; color: var(--sig); }
  .scroll { overflow-x: auto; margin: 1rem 0; }

  .box { border-radius: 9px; padding: 16px 19px; margin: 18px 0; border: 1px solid var(--rule); background: var(--panel); }
  .box.why  { border-left: 3px solid var(--sig); }
  .box.trap { border-left: 3px solid var(--err); }
  .box.perf { border-left: 3px solid var(--ok); }
  .box h4 { margin: 0 0 6px; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; font-family: var(--mono); font-weight: 500; }
  .box.why h4  { color: var(--sig); }
  .box.trap h4 { color: var(--err); }
  .box.perf h4 { color: var(--ok); }
  .box p { font-size: 14px; margin-bottom: 10px; }
  .box p:last-child { margin-bottom: 0; }

  /* Plain English Code Explainer Box */
  .code-explainer-box {
    background: var(--panel-2);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--sig);
    border-radius: 8px;
    padding: 14px 18px;
    margin: -8px 0 20px 0;
    font-size: 13.5px;
    color: var(--ink-2);
    line-height: 1.55;
  }
  .code-explainer-title {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--sig);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .code-explainer-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 8px;
    margin-top: 8px;
    font-size: 12.5px;
  }
  .code-explainer-col {
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 8px 10px;
  }
  .code-explainer-col strong {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--muted);
    text-transform: uppercase;
    display: block;
    margin-bottom: 2px;
  }

  .strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 18px 0; }
  .m { background: var(--panel); border: 1px solid var(--rule); border-radius: 9px; padding: 15px 16px; }
  .m .v { font-family: var(--mono); font-size: 20px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; margin-bottom: 3px; color: var(--ink); }
  .m .v s { text-decoration: none; color: var(--faint); font-size: 14px; font-weight: 400; }
  .m .k { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
  .m.ok .v { color: var(--ok); } .m.err .v { color: var(--err); }

  figure { margin: 0 0 16px; }
  figure:last-child { margin-bottom: 0; }
  .fx { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 18px; overflow-x: auto; }
  figcaption { font-size: 12.5px; color: var(--muted); margin-top: 10px; line-height: 1.55; max-width: 76ch; }

  svg { display: block; max-width: 100%; height: auto; }
  .s-n { font-family: var(--body); font-size: 12px; font-weight: 500; fill: var(--ink); }
  .s-m { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); }
  .s-s { font-family: var(--body); font-size: 11px; fill: var(--muted); }

  ul { margin: 0 0 14px; padding-left: 20px; color: var(--ink-2); max-width: 76ch; }
  li { margin-bottom: 6px; }
  li::marker { color: var(--faint); }

  .pill { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
  .pill.t0 { background: color-mix(in srgb, var(--t0) 15%, transparent); color: var(--t0); }
  .pill.t1 { background: color-mix(in srgb, var(--t1) 15%, transparent); color: var(--t1); }
  .pill.t2 { background: color-mix(in srgb, var(--t2) 15%, transparent); color: var(--t2); }

  .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-family: var(--mono); font-size: 10.5px; font-weight: 600; text-transform: uppercase; }
  .badge-cyan { background: var(--sig-bg); color: var(--sig); border: 1px solid color-mix(in srgb, var(--sig) 35%, transparent); }
  .badge-green { background: rgba(16, 185, 129, 0.15); color: var(--ok); border: 1px solid rgba(16, 185, 129, 0.3); }
  .badge-orange { background: rgba(245, 158, 11, 0.15); color: var(--warn); border: 1px solid rgba(245, 158, 11, 0.3); }
  .badge-red { background: rgba(239, 68, 68, 0.15); color: var(--err); border: 1px solid rgba(239, 68, 68, 0.3); }
  .badge-purple { background: rgba(192, 132, 252, 0.13); color: #a26be0; border: 1px solid rgba(192, 132, 252, 0.3); }
  .badge-blue { background: rgba(56, 189, 248, 0.13); color: var(--t2); border: 1px solid rgba(56, 189, 248, 0.3); }

  /* Flowchart / Architecture Styles */
  .flow-container { background: var(--panel); border: 1px solid var(--rule); border-radius: 12px; padding: 1.5rem; margin: 1.5rem 0; }
  .flow-layer { background: var(--panel-2); border: 1px solid var(--rule); border-radius: 8px; padding: 1.2rem; margin-bottom: 1rem; }
  .flow-layer-title { font-family: var(--mono); font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); margin-bottom: 0.8rem; display: flex; justify-content: space-between; align-items: center; }
  .flow-node-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.8rem; }
  .flow-node-card { background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; padding: 0.9rem; text-decoration: none; color: inherit; display: block; transition: all 0.2s; }
  .flow-node-card:hover { border-color: var(--sig); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  .flow-node-card.highlighted { border-color: var(--sig); box-shadow: 0 0 14px var(--sig); transform: scale(1.02); }
  .flow-node-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; }
  .flow-node-name { font-weight: 600; font-size: 0.88rem; color: var(--ink); }
  .flow-node-desc { font-size: 0.78rem; color: var(--muted); line-height: 1.4; margin-bottom: 0.6rem; }
  .flow-node-footer { display: flex; justify-content: space-between; align-items: center; font-family: var(--mono); font-size: 0.72rem; color: var(--sig); }
  .flow-arrow-down { text-align: center; color: var(--sig); font-family: var(--mono); font-size: 0.8rem; margin: 0.6rem 0; font-weight: 600; letter-spacing: 0.1em; }

  /* Interactive Lab Box */
  .interactive-lab { background: var(--panel); border: 1px solid var(--rule); border-left: 4px solid var(--sig); border-radius: 10px; padding: 1.5rem; margin: 2rem 0; }
  .lab-title { font-size: 1.1rem; font-weight: 700; color: var(--ink); margin-bottom: 0.6rem; }
  .lab-btn { background: var(--sig); color: #fff; border: none; font-weight: 600; font-family: var(--mono); font-size: 0.85rem; padding: 8px 16px; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
  .lab-btn:hover { filter: brightness(1.2); box-shadow: 0 0 12px var(--sig-bg); transform: translateY(-1px); }
  .lab-output { background: var(--panel-2); border: 1px solid var(--rule); border-radius: 6px; padding: 1rem; font-family: var(--mono); font-size: 0.82rem; color: var(--ink-2); min-height: 60px; }

  /* Grid Cards on Hub */
  .grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; margin: 1.5rem 0 2.5rem; }
  .feature-card { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 1.2rem; text-decoration: none; color: inherit; transition: all 0.2s; display: flex; flex-direction: column; justify-content: space-between; }
  .feature-card:hover { border-color: var(--sig); background: var(--panel-2); transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); }
  .feature-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.8rem; }
  .feature-card-title { font-size: 1rem; font-weight: 600; color: var(--ink); margin-bottom: 0.4rem; }
  .feature-card-desc { font-size: 0.82rem; color: var(--muted); line-height: 1.5; margin-bottom: 1rem; }
  .feature-card-footer { display: flex; align-items: center; justify-content: space-between; font-family: var(--mono); font-size: 0.72rem; color: var(--sig); font-weight: 600; }

  /* Chronological Stepper */
  .chrono-timeline { position: relative; margin: 2rem 0; padding-left: 1.8rem; }
  .chrono-timeline::before { content: ''; position: absolute; top: 0; bottom: 0; left: 6px; width: 2px; background: linear-gradient(to bottom, var(--sig), #c084fc, var(--ok)); }
  .chrono-step { position: relative; margin-bottom: 1.6rem; background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 1.2rem; transition: all 0.2s; }
  .chrono-step:hover { border-color: var(--sig); transform: translateX(4px); }
  .chrono-step::before { content: ''; position: absolute; top: 1.2rem; left: -2.15rem; width: 10px; height: 10px; border-radius: 50%; background: var(--bg); border: 2px solid var(--sig); box-shadow: 0 0 8px var(--sig); }
  .step-num { font-family: var(--mono); font-size: 0.68rem; font-weight: 700; text-transform: uppercase; color: var(--sig); letter-spacing: 0.1em; margin-bottom: 0.3rem; }
  .step-title { font-size: 1.1rem; font-weight: 600; color: var(--ink); margin-bottom: 0.4rem; }

  /* Page Navigation Footer */
  .page-nav-footer { display: flex; justify-content: space-between; gap: 1.5rem; margin-top: 4rem; padding-top: 2rem; border-top: 1px solid var(--rule); flex-wrap: wrap; }
  .page-nav-btn { flex: 1; min-width: 240px; background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 1rem 1.2rem; text-decoration: none; transition: all 0.2s; display: flex; flex-direction: column; gap: 4px; }
  .page-nav-btn:hover { border-color: var(--sig); background: var(--panel-2); transform: translateY(-2px); }
  .page-nav-btn.next { text-align: right; }
  .page-nav-label { font-family: var(--mono); font-size: 0.68rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; }
  .page-nav-title { font-size: 0.95rem; font-weight: 600; color: var(--ink); }

  footer { margin-top: 64px; padding-top: 22px; border-top: 1px solid var(--rule); font-size: 13px; color: var(--muted); }

  @media (max-width: 760px) { .grid2 { grid-template-columns: 1fr !important; } }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

.chapter-rail {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  padding: 10px 0 12px; margin: 0 0 18px;
  border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
}
.chapter-part {
  font-family: var(--mono); font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--sig);
}
.chapter-count {
  font-family: var(--mono); font-size: 11px; color: var(--muted);
}
.chapter-learn {
  background: var(--panel); border: 1px solid var(--rule);
  border-left: 3px solid var(--sig);
  border-radius: 10px; padding: 16px 20px; margin: 0 0 20px;
}
.chapter-learn-title {
  font-family: var(--mono); font-size: 11px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--sig); margin-bottom: 8px;
}
.chapter-learn ul { margin: 0; padding-left: 18px; }
.chapter-learn li { margin-bottom: 5px; color: var(--ink-2); font-size: 14px; line-height: 1.55; }
.chapter-learn li:last-child { margin-bottom: 0; }
.chapter-figure { margin: 0 0 24px; }
.chapter-figure .fx {
  background: var(--panel); border: 1px solid var(--rule);
  border-radius: 10px; padding: 18px; overflow-x: auto;
}
.chapter-figure figcaption {
  font-size: 13px; color: var(--muted); line-height: 1.6;
  margin-top: 10px; max-width: 76ch;
}

/* Contents page */
.part-block { margin: 0 0 30px; }
.part-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.part-num {
  font-family: var(--mono); font-size: 12px; letter-spacing: .1em;
  color: var(--sig); text-transform: uppercase;
}
.part-title { font-size: 20px; font-weight: 700; letter-spacing: -.02em; margin: 0; }
.part-blurb { color: var(--muted); font-size: 13.5px; margin: 0 0 14px; max-width: 76ch; line-height: 1.6; }
.chapter-row {
  display: flex; align-items: baseline; gap: 14px;
  padding: 11px 14px; border: 1px solid var(--rule); border-radius: 9px;
  background: var(--panel); margin-bottom: 7px; text-decoration: none;
}
.chapter-row:hover { border-color: var(--sig); }
.chapter-row .n {
  font-family: var(--mono); font-size: 11px; color: var(--muted);
  min-width: 26px; flex-shrink: 0;
}
.chapter-row .t { font-weight: 600; color: var(--ink); font-size: 14.5px; }
.chapter-row .d { color: var(--muted); font-size: 12.5px; margin-left: auto; text-align: right; max-width: 46ch; }
@media (max-width: 720px) { .chapter-row .d { display: none; } }

/* Labs: a grid of labelled fields, live results. */
.lab-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 14px 0 12px; }
.lab-field label { display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
.lab-field input, .lab-field select { width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px 9px; border-radius: 6px; font-family: var(--mono); font-size: 13px; }
.lab-field input:focus, .lab-field select:focus { outline: none; border-color: var(--sig); }
.lab-src { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: -2px; }
.lab-note { color: var(--muted); font-size: 13px; margin: 6px 0 0; max-width: 80ch; }
.lab-big { font-family: var(--mono); font-size: 26px; font-weight: 600; color: var(--ink); letter-spacing: -.02em; }
.lab-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.lab-row code { min-width: 170px; color: var(--sig); background: none; padding: 0; font-size: 12px; }
.lab-bar { flex: 1; height: 7px; background: var(--rule-2); border-radius: 4px; overflow: hidden; }
.lab-bar > div { height: 100%; border-radius: 4px; }
.lab-why { font-size: 12px; color: var(--muted); margin: 1px 0 4px 180px; font-family: var(--body); }
.lab-foot { font-size: 12px; color: var(--muted); margin-top: 10px; border-top: 1px solid var(--rule); padding-top: 8px; font-family: var(--body); }
@media (max-width: 640px) { .lab-row code { min-width: 110px; } .lab-why { margin-left: 0; } }

/* Contents page: reading paths */
.paths { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; margin: 8px 0 34px; }
.path { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; }
.path h3 { margin: 0 0 8px; font-size: 14px; }
.path ol { margin: 0; padding-left: 18px; font-size: 13px; color: var(--ink-2); }
.path li { margin-bottom: 3px; }
.path a { font-weight: 500; }
.stat-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0 28px; }
.stat { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 12px 14px; }
.stat .v { font-family: var(--mono); font-size: 20px; font-weight: 600; color: var(--ink); }
.stat .k { font-size: 12px; color: var(--muted); line-height: 1.45; }

hr.rule { border: none; border-top: 1px solid var(--rule); margin: 2.2rem 0 0; }
.t tr.sect td { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--sig); padding-top: 16px; }
.t tr.sect td strong { color: var(--sig); font-weight: 600; }
.box h4 + p { margin-top: 0; }

/* On a phone, figures keep a readable size and scroll inside their frame. */
@media (max-width: 700px) { .chapter-figure svg, figure .fx svg { min-width: 640px; } }


/* ---- atmosphere: a slow, dim aurora and a dot grid, behind everything ---- */
body::before { content: ""; position: fixed; inset: -20%; z-index: -2; pointer-events: none;
  background:
    radial-gradient(40% 35% at 15% 10%, rgba(107,140,255,.10), transparent 70%),
    radial-gradient(35% 30% at 85% 18%, rgba(45,212,191,.06), transparent 70%),
    radial-gradient(45% 40% at 60% 95%, rgba(192,132,252,.06), transparent 70%);
  animation: drift 40s ease-in-out infinite alternate; }
body::after { content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image: radial-gradient(rgba(143,156,255,.08) 1px, transparent 1px); background-size: 26px 26px;
  -webkit-mask-image: linear-gradient(to bottom, #000, transparent 75%); mask-image: linear-gradient(to bottom, #000, transparent 75%); }
@keyframes drift { to { transform: translate3d(4%, 3%, 0) rotate(3deg); } }
@media (prefers-reduced-motion: reduce) { body::before { animation: none; } }

/* ---- top bar: sticky glass ---- */
[hidden] { display: none !important; }
.topbar { position: sticky; top: 0; z-index: 30; display: flex; justify-content: space-between; align-items: center;
  gap: 12px; flex-wrap: wrap; padding: 11px 0; margin: 0 0 24px;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  -webkit-backdrop-filter: blur(12px) saturate(1.3); backdrop-filter: blur(12px) saturate(1.3);
  /* Edge to edge without widening the page: shadows are painted, not laid out. */
  box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--bg) 80%, transparent), 0 1px 0 100vmax var(--rule);
  clip-path: inset(0 -100vmax -1px); }
.topbar .crumbs { font-family: var(--mono); font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px;
  min-width: 0; flex: 1 1 auto; white-space: nowrap; overflow: hidden; }
.topbar .crumbs > * { flex: none; }
.topbar .crumbs b { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.topbar .tools { flex: none; }
@media (min-width: 900px) { .topbar { flex-wrap: nowrap; } }
@media (max-width: 899px) {
  .topbar .crumbs { flex-basis: 100%; }
  .topbar .tools { flex: 1 1 100%; min-width: 0; }
}
@media (max-width: 640px) {
  .quick-jump-select { display: none; }
  .search-btn { min-width: 0; flex: 1 1 auto; }
}
h2[id], h3[id], h4[id], section[id] { scroll-margin-top: 84px; }
.topbar .crumbs a { color: var(--ink); text-decoration: none; font-weight: 600; }
.topbar .crumbs b { color: var(--sig); font-weight: 600; }
.topbar .tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tbtn { font-family: var(--mono); font-size: 11.5px; background: var(--panel); border: 1px solid var(--rule); color: var(--ink-2);
  padding: 5px 11px; border-radius: 7px; text-decoration: none; cursor: pointer; font-weight: 500; }
.tbtn:hover { border-color: var(--sig); color: var(--ink); }
.search-btn { display: inline-flex; align-items: center; justify-content: space-between; gap: 14px; min-width: 168px; color: var(--muted); }
.quick-jump-select { max-width: 210px; }
@media (min-width: 1200px) { .has-side-toc .hd .toc { display: none; } }
.search-btn kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--rule); border-radius: 4px; padding: 0 5px; color: var(--muted); }
.read-progress { position: fixed; top: 0; left: 0; right: 0; height: 2px; transform-origin: 0 50%; transform: scaleX(0); z-index: 40;
  background: linear-gradient(90deg, var(--accent, var(--sig)), #2dd4bf); }

/* ---- search palette ---- */
.palette { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: center; align-items: flex-start;
  padding: 12vh 16px 16px; background: rgba(4,6,14,.55); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
.palette[hidden] { display: none; }
.palette-box { width: min(680px, 100%); background: var(--panel); border: 1px solid var(--rule); border-radius: 14px; overflow: hidden;
  box-shadow: 0 30px 80px -20px rgba(0,0,0,.6), 0 0 0 1px color-mix(in srgb, var(--sig) 25%, transparent); }
.palette-box input { width: 100%; border: none; border-bottom: 1px solid var(--rule); background: transparent; color: var(--ink);
  font-family: var(--body); font-size: 17px; padding: 16px 18px; outline: none; }
.palette-results { max-height: 52vh; overflow-y: auto; padding: 6px; }
.hit { display: grid; grid-template-columns: 70px 1fr; gap: 1px 10px; padding: 9px 12px; border-radius: 9px; text-decoration: none; color: var(--ink-2); font-weight: 400; }
.hit.sel, .hit:hover { background: var(--sig-bg); }
.hit-k { grid-row: span 2; align-self: center; font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.k-chapter { color: var(--sig); } .k-section { color: var(--t2); } .k-term { color: #a26be0; }
.hit-t { color: var(--ink); font-weight: 600; font-size: 14px; }
.hit-s { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hit mark { background: color-mix(in srgb, var(--sig) 28%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }
.palette-foot { display: flex; gap: 16px; padding: 8px 14px; border-top: 1px solid var(--rule); font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
.palette-none { padding: 18px; color: var(--muted); font-size: 13px; }

/* ---- chapter hero ---- */
.hd { position: relative; }
.hd > *:not(.bignum) { position: relative; z-index: 1; }
.hd .bignum { position: absolute; right: -4px; top: 26px; z-index: 0; font-family: var(--body); font-weight: 700;
  font-size: clamp(100px, 17vw, 210px); line-height: 1; letter-spacing: -.06em; color: transparent; pointer-events: none; user-select: none;
  -webkit-text-stroke: 1px color-mix(in srgb, var(--accent, var(--sig)) 45%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, #000 30%, transparent); mask-image: linear-gradient(to bottom, #000 30%, transparent); }
.hd h1::after { content: ""; display: block; width: 120px; height: 3px; margin-top: 16px; border-radius: 2px;
  background: linear-gradient(90deg, var(--accent, var(--sig)), transparent); }
.hero h1 { font-size: clamp(36px, 6vw, 60px); background: linear-gradient(95deg, var(--ink) 25%, var(--sig) 70%, #2dd4bf);
  -webkit-background-clip: text; background-clip: text; color: transparent; }
.chapter-rail { border-color: color-mix(in srgb, var(--accent, var(--sig)) 30%, var(--rule)); }
.chapter-part { color: var(--accent, var(--sig)); }
@media (max-width: 700px) { .hd .bignum { opacity: .55; } }

/* ---- two columns: the chapter and "on this page" ---- */
@media (min-width: 1200px) {
  .doc-layout { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 44px; align-items: start; }
  .side-toc { position: sticky; top: 80px; max-height: calc(100vh - 110px); overflow: auto; padding-left: 14px; border-left: 1px solid var(--rule); }
}
@media (max-width: 1199px) { .side-toc { display: none; } }
.side-toc-title { font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 6px 0 10px; }
.side-toc a { display: block; font-size: 12.5px; line-height: 1.4; color: var(--muted); text-decoration: none; font-weight: 400;
  padding: 5px 0 5px 12px; margin-left: -15px; border-left: 2px solid transparent; transition: color .2s, border-color .2s; }
.side-toc a:hover { color: var(--ink); }
.side-toc a.on { color: var(--ink); border-left-color: var(--accent, var(--sig)); }
.side-toc a.try { color: var(--sig); margin-top: 8px; }

/* ---- motion, all of it optional ---- */
.reveal { opacity: 0; transform: translateY(14px); transition: opacity .6s ease, transform .6s ease; }
.reveal.in { opacity: 1; transform: none; }
.chapter-figure .fx, .interactive-lab, .flow-container, .path, .stat { transition: box-shadow .3s, border-color .3s, transform .3s; }
.chapter-figure .fx:hover, .interactive-lab:hover, .path:hover, .stat:hover {
  border-color: color-mix(in srgb, var(--accent, var(--sig)) 40%, var(--rule));
  box-shadow: 0 18px 50px -30px color-mix(in srgb, var(--accent, var(--sig)) 75%, transparent); }
.path:hover, .stat:hover { transform: translateY(-2px); }
@media (prefers-reduced-motion: no-preference) {
  .chapter-figure path[stroke-dasharray], .chapter-figure line[stroke-dasharray] { animation: flowdash 1.6s linear infinite; }
}
@keyframes flowdash { to { stroke-dashoffset: -16; } }

/* ---- contents rows ---- */
.chapter-row { position: relative; transition: border-color .2s, transform .2s, box-shadow .2s, background .2s; }
.chapter-row::before { content: ""; position: absolute; left: -1px; top: 9px; bottom: 9px; width: 2px; border-radius: 2px; background: var(--pa, var(--sig)); opacity: 0; transition: opacity .2s; }
.chapter-row:hover { transform: translateX(3px); border-color: color-mix(in srgb, var(--pa, var(--sig)) 45%, var(--rule));
  box-shadow: 0 10px 30px -20px var(--pa, var(--sig)); }
.chapter-row:hover::before { opacity: 1; }
.chapter-row.visited .n::after { content: " ✓"; color: var(--ok); }
.part-num { color: var(--pa, var(--sig)); }
.continue { margin-left: 4px; }

/* ---- the live system on the contents page ---- */
.live { padding: 0; margin: 6px 0 34px; border: 1px solid var(--rule); border-radius: 16px; overflow: hidden; position: relative;
  background: radial-gradient(120% 90% at 30% 0%, color-mix(in srgb, var(--sig) 7%, var(--panel)), var(--panel) 60%);
  box-shadow: 0 30px 80px -50px color-mix(in srgb, var(--sig) 80%, transparent); }
.live-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 18px; border-bottom: 1px solid var(--rule); }
.live-title { font-weight: 700; font-size: 15px; color: var(--ink); }
.live-title span { font-family: var(--mono); font-size: 10.5px; color: var(--sig); letter-spacing: .1em; margin-right: 8px; text-transform: uppercase; }
.live-sub { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
.live-btns { display: flex; gap: 6px; flex-wrap: wrap; }
.live-btns button { font-family: var(--mono); font-size: 11px; color: var(--ink-2); background: var(--panel-2); border: 1px solid var(--rule); border-radius: 7px; padding: 5px 10px; cursor: pointer; }
.live-btns button:hover, .live-btns button.on { border-color: var(--sig); color: var(--ink); box-shadow: 0 0 0 3px var(--sig-bg); }
.live-grid { display: grid; grid-template-columns: minmax(0, 1fr) 330px; }
@media (max-width: 960px) { .live-grid { grid-template-columns: 1fr; } }
.ls-stage { position: relative; min-height: 300px; }
.ls-stage canvas { display: block; }
.ls-tip { position: absolute; z-index: 2; pointer-events: none; max-width: 250px; padding: 8px 10px; border-radius: 9px; font-size: 12px; color: var(--ink-2);
  background: color-mix(in srgb, var(--panel) 92%, transparent); border: 1px solid var(--rule); box-shadow: 0 10px 30px -10px rgba(0,0,0,.5); }
.ls-tip b { color: var(--ink); }
.ls-tip-hint { color: var(--muted); font-size: 11px; margin-top: 4px; }
.ls-panel { border-left: 1px solid var(--rule); padding: 14px 16px; font-size: 13px; background: color-mix(in srgb, var(--panel-2) 45%, transparent); }
@media (max-width: 960px) { .ls-panel { border-left: none; border-top: 1px solid var(--rule); } }
.ls-h { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 6px 0 8px; }
.ls-h span { color: var(--faint); letter-spacing: .02em; text-transform: none; }
.ls-root { display: flex; align-items: baseline; gap: 10px; }
.ls-root b { font-size: 19px; color: var(--ink); }
.ls-score { font-family: var(--mono); font-size: 18px; color: var(--ink); }
.ls-conf { font-family: var(--mono); font-weight: 600; font-size: 12px; }
.ls-why { color: var(--muted); font-size: 12.5px; margin: 4px 0 10px; line-height: 1.5; }
.ls-truth { font-family: var(--mono); font-size: 11px; padding: 5px 8px; border-radius: 6px; margin-bottom: 10px; }
.ls-truth.ok { background: rgba(37,227,163,.1); color: var(--ok); }
.ls-truth.bad { background: rgba(255,61,94,.1); color: var(--err); }
.ls-cand { padding: 7px 0; border-top: 1px solid var(--rule-2); }
.ls-cand-h { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--ink-2); }
.ls-cand-h span:last-child { font-family: var(--mono); font-size: 11.5px; }
.ls-cand.top .ls-cand-h span:first-child { color: var(--ink); font-weight: 600; }
.ls-bar { display: flex; height: 6px; gap: 2px; margin: 5px 0 4px; }
.ls-bar i { display: block; border-radius: 2px; }
.f-first { background: #8f9cff; } .f-anomaly { background: #6b7bd8; } .f-down { background: #ff3d5e; } .f-degraded { background: #ffab40; }
.f-observed { background: #1fd1ff; } .f-explains { background: #25e3a3; }
.ls-bar i.neg { background: repeating-linear-gradient(45deg, #ff3d5e 0 3px, transparent 3px 6px); }
.ls-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ls-chips span { font-family: var(--mono); font-size: 10px; color: var(--muted); background: var(--panel-2); border-radius: 4px; padding: 1px 5px; }
.ls-chips span.neg { color: var(--err); }
.ls-path { font-family: var(--mono); font-size: 11px; color: var(--ink-2); margin: 10px 0 14px; }
.ls-path i { color: var(--err); font-style: normal; }
.ls-kv, .ls-risk, .ls-w { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; padding: 3px 0; color: var(--ink-2); }
.ls-risk em { color: var(--muted); font-style: normal; font-size: 11.5px; }
.ls-kv b, .ls-risk b, .ls-w b { font-family: var(--mono); }
.b-high { color: var(--err); } .b-elevated { color: #ff9a3c; } .b-low { color: var(--warn); }
.ls-empty { color: var(--ink-2); font-size: 13px; line-height: 1.6; margin-bottom: 14px; }
.live-foot { padding: 10px 18px; border-top: 1px solid var(--rule); font-size: 12px; color: var(--muted); }

/* Swatches for colour legends */
.sw { display: inline-block; width: 26px; height: 10px; border-radius: 3px; vertical-align: middle; margin-right: 6px; }
"""

JS_SCRIPTS = """
document.addEventListener('DOMContentLoaded', () => {
    // 1. Theme Switcher matching Mapper Technical Reference
    const initTheme = () => {
        const saved = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', saved);
        const btn = document.getElementById('theme-toggle-btn');
        if (btn) btn.innerHTML = saved === 'dark' ? '☀️ Light' : '🌙 Dark';
    };
    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('theme', next);
            themeBtn.innerHTML = next === 'dark' ? '☀️ Light' : '🌙 Dark';
        });
    }
    initTheme();

    // 2. Quick Jump Dropdown
    const quickJump = document.getElementById('quick-jump');
    if (quickJump) {
        quickJump.addEventListener('change', (e) => {
            if (e.target.value) {
                window.location.href = e.target.value;
            }
        });
    }

    // 3. Flowchart Path Tracing
    const traceBtns = document.querySelectorAll('.flow-trace-btn');
    const nodes = document.querySelectorAll('.flow-node');
    if (traceBtns.length > 0 && nodes.length > 0) {
        traceBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                traceBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const flow = btn.getAttribute('data-flow');
                nodes.forEach(n => {
                    n.classList.remove('highlighted');
                    const tags = (n.getAttribute('data-tags') || '').split(',');
                    if (flow === 'RESET') {
                        n.style.opacity = '1';
                    } else if (tags.includes(flow.toLowerCase())) {
                        n.classList.add('highlighted');
                        n.style.opacity = '1';
                    } else {
                        n.style.opacity = '0.35';
                    }
                });
            });
        });
    }

    // 4. Master Interactive Topology Canvas (Hub Page)
    const canvas = document.getElementById('topo-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        let currentMode = 'xyflow'; // 'xyflow', 'ring', '3d'
        let hasFault = false;
        let animFrameId = null;

        function resizeCanvas() {
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width * window.devicePixelRatio;
            canvas.height = 420 * window.devicePixelRatio;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        const nodesData = [
            { id: 'gateway', name: 'api-gateway', x: 0.15, y: 0.5, r: 24, col: '#00e5ff', status: 'HEALTHY', type: 'Gateway' },
            { id: 'auth', name: 'auth-service', x: 0.38, y: 0.22, r: 20, col: '#38bdf8', status: 'HEALTHY', type: 'Core' },
            { id: 'orders', name: 'orders-service', x: 0.42, y: 0.78, r: 22, col: '#38bdf8', status: 'HEALTHY', type: 'Core' },
            { id: 'payment', name: 'payment-svc', x: 0.68, y: 0.78, r: 22, col: '#38bdf8', status: 'HEALTHY', type: 'Payment' },
            { id: 'postgres', name: 'orders-db', x: 0.88, y: 0.82, r: 18, col: '#a855f7', status: 'HEALTHY', type: 'Storage' },
            { id: 'redis', name: 'session-cache', x: 0.62, y: 0.22, r: 18, col: '#a855f7', status: 'HEALTHY', type: 'Cache' },
            { id: 'collector', name: 'collector-agent', x: 0.50, y: 0.50, r: 20, col: '#10b981', status: 'HEALTHY', type: 'Agent' }
        ];

        const edges = [
            { from: 'gateway', to: 'auth', latency: 4 },
            { from: 'gateway', to: 'orders', latency: 12 },
            { from: 'auth', to: 'redis', latency: 2 },
            { from: 'orders', to: 'payment', latency: 18 },
            { from: 'payment', to: 'postgres', latency: 8 },
            { from: 'collector', to: 'gateway', latency: 1 },
            { from: 'collector', to: 'orders', latency: 1 }
        ];

        let packets = [
            { edgeIdx: 0, progress: 0.1, speed: 0.012 },
            { edgeIdx: 1, progress: 0.4, speed: 0.009 },
            { edgeIdx: 3, progress: 0.7, speed: 0.007 },
            { edgeIdx: 4, progress: 0.2, speed: 0.015 }
        ];

        let angle3D = 0;

        function renderTopology() {
            const w = canvas.getBoundingClientRect().width;
            const h = 420;
            ctx.clearRect(0, 0, w, h);

            // Draw Grid
            ctx.strokeStyle = 'rgba(255,255,255,0.03)';
            ctx.lineWidth = 1;
            for (let x = 0; x < w; x += 30) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            }
            for (let y = 0; y < h; y += 30) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
            }

            // Calculate Positions
            let posMap = {};
            if (currentMode === 'xyflow') {
                nodesData.forEach(n => {
                    posMap[n.id] = { x: n.x * w, y: n.y * h, z: 1 };
                });
            } else if (currentMode === 'ring') {
                const cx = w / 2, cy = h / 2, radius = Math.min(w, h) * 0.36;
                nodesData.forEach((n, idx) => {
                    if (n.id === 'collector') {
                        posMap[n.id] = { x: cx, y: cy, z: 1 };
                    } else {
                        const theta = ((idx) / (nodesData.length - 1)) * Math.PI * 2 - Math.PI / 2;
                        posMap[n.id] = { x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius, z: 1 };
                    }
                });
            } else if (currentMode === '3d') {
                angle3D += 0.006;
                const cx = w / 2, cy = h / 2, radius = Math.min(w, h) * 0.34;
                nodesData.forEach((n, idx) => {
                    if (n.id === 'collector') {
                        posMap[n.id] = { x: cx, y: cy, z: 1 };
                    } else {
                        const theta = ((idx) / (nodesData.length - 1)) * Math.PI * 2 + angle3D;
                        const px = Math.cos(theta) * radius;
                        const pz = Math.sin(theta) * radius;
                        const scale = (pz + radius * 1.5) / (radius * 2.5);
                        posMap[n.id] = {
                            x: cx + px * scale,
                            y: cy + (n.y - 0.5) * 160 * scale + Math.sin(theta * 2) * 20,
                            z: scale
                        };
                    }
                });
            }

            // Draw Edges
            edges.forEach((e) => {
                const p1 = posMap[e.from];
                const p2 = posMap[e.to];
                if (!p1 || !p2) return;

                const isDegraded = hasFault && (e.to === 'payment' || e.from === 'payment');
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.strokeStyle = isDegraded ? 'rgba(239, 68, 68, 0.7)' : 'rgba(0, 229, 255, 0.25)';
                ctx.lineWidth = isDegraded ? 2.5 : 1.5;
                if (isDegraded) ctx.setLineDash([4, 4]);
                else ctx.setLineDash([]);
                ctx.stroke();
                ctx.setLineDash([]);

                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;
                ctx.fillStyle = isDegraded ? '#ef4444' : '#00e5ff';
                ctx.font = '10px "IBM Plex Mono", monospace';
                const latText = isDegraded ? `${e.latency * 18}ms ⚠` : `${e.latency}ms`;
                ctx.fillText(latText, midX + 4, midY - 4);
            });

            // Draw Packets
            packets.forEach(p => {
                p.progress += p.speed;
                if (p.progress > 1) p.progress = 0;
                const e = edges[p.edgeIdx];
                const p1 = posMap[e.from];
                const p2 = posMap[e.to];
                if (p1 && p2) {
                    const px = p1.x + (p2.x - p1.x) * p.progress;
                    const py = p1.y + (p2.y - p1.y) * p.progress;
                    ctx.beginPath();
                    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
                    ctx.fillStyle = hasFault && e.to === 'payment' ? '#ef4444' : '#00e5ff';
                    ctx.shadowColor = ctx.fillStyle;
                    ctx.shadowBlur = 8;
                    ctx.fill();
                    ctx.shadowBlur = 0;
                }
            });

            // Draw Nodes
            nodesData.forEach(n => {
                const pos = posMap[n.id];
                if (!pos) return;
                const isTargetFault = hasFault && n.id === 'payment';
                const nodeColor = isTargetFault ? '#ef4444' : n.col;
                const radius = n.r * (pos.z || 1);

                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius + (isTargetFault ? 8 : 4), 0, Math.PI * 2);
                ctx.fillStyle = isTargetFault ? 'rgba(239, 68, 68, 0.25)' : 'rgba(0, 229, 255, 0.08)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = '#0f172a';
                ctx.fill();
                ctx.lineWidth = isTargetFault ? 3 : 2;
                ctx.strokeStyle = nodeColor;
                ctx.stroke();

                ctx.fillStyle = '#f8fafc';
                ctx.font = '600 11.5px "IBM Plex Sans", sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(n.name, pos.x, pos.y + radius + 15);

                ctx.fillStyle = isTargetFault ? '#f87171' : '#94a3b8';
                ctx.font = '10px "IBM Plex Mono", monospace';
                const statusStr = isTargetFault ? 'CPU: 98.4% [ANOMALY]' : n.type;
                ctx.fillText(statusStr, pos.x, pos.y + radius + 27);
                ctx.textAlign = 'left';
            });

            animFrameId = requestAnimationFrame(renderTopology);
        }

        animFrameId = requestAnimationFrame(renderTopology);

        const btnFault = document.getElementById('topo-btn-fault');
        const btnReset = document.getElementById('topo-btn-reset');
        const statusText = document.getElementById('topo-status-text');

        if (btnFault && btnReset && statusText) {
            btnFault.addEventListener('click', () => {
                hasFault = true;
                statusText.innerHTML = '<span style="color: var(--err); font-weight: bold;">🚨 ANOMALY DETECTED:</span> <code>payment-svc</code> CPU Spike 98.4% &bull; RCA Score: 0.94 &bull; BFS Depth: 2';
            });
            btnReset.addEventListener('click', () => {
                hasFault = false;
                statusText.innerHTML = '<span style="color: var(--ok); font-weight: bold;">✓ ALL SYSTEMS NORMAL:</span> Zero-instrumentation continuous 5s telemetry pulse active.';
            });
        }
    }

    // 5. Interactive labs.
    //
    // Each re-implements a real function from the repository with the same
    // constants and branch order. If one of them disagrees with its source
    // file, the lab is the thing that is wrong.

    const labVal = (id) => { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; };
    const labNum = (id) => {
        const v = labVal(id).toLowerCase();
        if (v === '' || v === 'none' || v === 'null' || v === '—') return null;
        const n = parseFloat(v);
        return isFinite(n) ? n : null;
    };
    const r2 = (n) => Math.round(n * 100) / 100;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const out = (fn, htmlText) => { const el = document.getElementById(fn + '-out'); if (el) el.innerHTML = htmlText; };
    const row = (name, value, frac, colour, why) =>
        '<div class="lab-row"><code>' + esc(name) + '</code>' +
        '<div class="lab-bar"><div style="width:' + Math.max(0, Math.min(100, frac * 100)) + '%;background:' + colour + ';"></div></div>' +
        '<strong style="font-family:var(--mono);min-width:52px;text-align:right;color:var(--ink);">' + value + '</strong></div>' +
        (why ? '<div class="lab-why">' + why + '</div>' : '');
    const big = (value, label, colour) =>
        '<span class="lab-big" style="color:' + (colour || 'var(--ink)') + ';">' + value + '</span> ' +
        '<span style="color:var(--muted);font-size:12px;margin-right:22px;">' + label + '</span>';

    // normalizeId() in server/graph/GraphStore.ts
    window.labCanonicalId = function () {
        const raw = labVal('canon-input');
        const tgt = labVal('canon-target') || 'sock-shop';
        if (!raw || raw === 'external' || raw === 'unknown-upstream') {
            out('labCanonicalId', big(esc(raw || '(empty)'), 'passed through unchanged') +
                '<div class="lab-foot">Sentinel ids are exempt: prefixing them would invent a service that does not exist.</div>');
            return;
        }
        let clean = raw;
        for (const sep of ['-', ':', '/']) {
            if (raw.indexOf(tgt + sep) === 0) { clean = raw.slice(tgt.length + 1); break; }
        }
        out('labCanonicalId', big(esc(tgt + ':' + clean), 'canonical id', 'var(--sig)') +
            '<div class="lab-foot">' + (clean !== raw
                ? 'An existing <code>' + esc(tgt) + '</code> prefix was stripped and re-applied, which is what makes this idempotent.'
                : 'No existing prefix, so the target id was simply prepended.') + '</div>');
    };

    // The candidate loop in server/rca/RCAEngine.ts
    window.labRca = function () {
        const parts = [];
        const t = labVal('rca-time'), st = labVal('rca-status'), ev = labVal('rca-evidence');
        if (t === 'earliest') parts.push(['temporal_precedence', 0.30, 'earliest detected anomaly']);
        else if (t === 'anomaly') parts.push(['anomaly_presence', 0.10, 'metric anomaly detected']);
        if (st === 'critical') parts.push(['critical_status', 0.35, 'container down or crash-looping']);
        else if (st === 'degraded') parts.push(['degraded_status', 0.15, 'degraded']);
        const observed = ev === 'observed';
        if (observed) parts.push(['observed_dependency', 0.20, 'observed runtime TCP/HTTP traffic confirmed']);
        else if (ev === 'declared') parts.push(['declared_dependency', 0.05, 'declared dependency only']);

        const others = Math.max(0, Math.round(labNum('rca-others') ?? 0));
        const k = Math.min(others, Math.max(0, Math.round(labNum('rca-explained') ?? 0)));
        const reach = Math.min(1, Math.max(0, labNum('rca-reach') ?? 0));
        const material = reach >= 0.1 ? reach : 0;           // MATERIAL_REACH
        const explained = material > 0 ? k : 0;
        if (others > 0) {
            const coverage = (explained * material) / others;
            const pts = Math.round(0.25 * coverage * 100) / 100; // EXPLAINS_WEIGHT
            if (pts >= 0.01) parts.push(['explains_failures', pts, 'explains ' + explained + ' of ' + others + ' other affected service(s): weighted coverage ' + Math.round(coverage * 100) + '%']);
        }
        const victim = Math.min(1, Math.max(0, labNum('rca-victim') ?? 0));
        if (victim > 0) {
            const pts = Math.round(0.25 * victim * 100) / 100;   // VICTIM_WEIGHT
            parts.push(['dependency_failing', -pts, 'its own callees are failing (weighted share ' + Math.round(victim * 100) + '%): likely a victim, not the cause']);
        }
        const total = parts.reduce((a, p) => a + p[1], 0);
        const score = Math.min(Math.max(Math.round(total * 100) / 100, 0), 1);
        let conf = score >= 0.75 && observed ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : score >= 0.25 ? 'LOW' : 'UNKNOWN';
        const independent = others > 0 && explained === 0 && conf !== 'UNKNOWN';
        const colour = conf === 'HIGH' ? 'var(--err)' : conf === 'MEDIUM' ? 'var(--warn)' : 'var(--muted)';
        const rows = parts.map((p) => row(p[0], (p[1] >= 0 ? '+' : '−') + Math.abs(p[1]).toFixed(2), Math.abs(p[1]) / 0.35,
            p[1] >= 0 ? 'var(--sig)' : 'var(--err)', p[2])).join('');
        out('labRca', big(score.toFixed(2), 'score') + big(conf, 'confidence', colour) +
            (rows || '<div class="lab-foot">No factor matched: this candidate scores 0.</div>') +
            '<div class="lab-foot">' +
            (total > 1 ? 'The raw sum was ' + r2(total).toFixed(2) + '; it is clamped to 1. ' : '') +
            'HIGH needs 0.75+ <em>and</em> an observed edge. ' +
            (independent ? '<strong>If this is the top candidate</strong>, it explains none of the others, so the incident is treated as independent failures and confidence is forced to LOW.' : '') +
            '</div>');
    };

    // computeHealth() and the risk composite in server/graph/RiskEngine.ts
    window.labHealth = function () {
        const status = labVal('risk-status');
        const parts = [];
        const sv = status === 'healthy' ? 1 : status === 'degraded' ? 0.5 : status === 'critical' ? 0 : 0.5;
        parts.push(['status', 0.60, sv, 'container status is ' + status]);
        const a = labNum('risk-anomaly');
        if (a !== null) { const c = Math.min(Math.max(a, 0), 1); parts.push(['anomaly', 0.25, 1 - c, 'model anomaly score ' + r2(c)]); }
        const inc = labVal('risk-incident');
        parts.push(['incident', 0.15, inc === 'root' ? 0 : inc === 'affected' ? 0.3 : 1,
            inc === 'root' ? 'named as the root cause of an open incident' : inc === 'affected' ? 'among the affected services of an open incident' : 'not part of any open incident']);
        const tw = parts.reduce((s, p) => s + p[1], 0);
        const br = parts.map((p) => ({ f: p[0], w: p[1], score: r2((p[2] * p[1]) / tw), why: p[3] }));
        const health = r2(br.reduce((s, b) => s + b.score, 0));
        const crit = labNum('risk-crit');
        const risk = crit !== null ? r2(0.5 * (1 - health) + 0.5 * Math.min(Math.max(crit, 0), 1)) : r2(1 - health);
        const rc = risk > 0.8 ? 'var(--err)' : risk > 0.6 ? 'var(--warn)' : 'var(--ok)';
        out('labHealth', big(health.toFixed(2), 'health') + big(risk.toFixed(2), 'risk', rc) +
            br.map((b) => row(b.f + '  w ' + b.w.toFixed(2) + '→' + r2(b.w / tw).toFixed(2), b.score.toFixed(2), b.score, 'var(--ok)', b.why)).join('') +
            '<div class="lab-foot">' + (parts.length === 2 ? 'No anomaly score, so status and incident renormalise from .60/.15 to .80/.20. ' : '') +
            'The parts sum to exactly ' + health.toFixed(2) + '. ' +
            (crit !== null ? 'Risk = 0.5 × (1 − health) + 0.5 × criticality.' : 'Criticality is null, so risk falls back to 1 − health.') + '</div>');
    };

    // intrinsicProbability() and one step of solve()/describe() in server/graph/CascadeEngine.ts
    window.labCascade = function () {
        const tau = labNum('cas-tau') ?? 0.7;
        const status = labVal('cas-status');
        const reasons = [];
        let survive = 1;
        const s = status === 'critical' ? 1 : status === 'degraded' ? 0.5 : 0;
        if (s > 0) { survive *= 1 - s; reasons.push('status ' + status + ' (' + s + ')'); }
        const a = labNum('cas-anom');
        const persistent = labVal('cas-persist') === 'yes';
        if (a !== null && a > 0) {
            const c = Math.min(Math.max(a, 0), 1) * (persistent ? 0.8 : 0.3);
            survive *= 1 - c;
            reasons.push('anomaly ' + a + ' × ' + (persistent ? '0.8' : '0.3') + ' = ' + r3(c));
        }
        const p0 = 1 - survive;
        let inhSurvive = 1, best = null;
        const callees = [['A', labNum('cas-w1') ?? 0, labNum('cas-p1') ?? 0], ['B', labNum('cas-w2') ?? 0, labNum('cas-p2') ?? 0]];
        const lines = [];
        for (const [name, w, p] of callees) {
            const contrib = tau * Math.min(Math.max(w, 0), 1) * Math.min(Math.max(p, 0), 1);
            inhSurvive *= 1 - contrib;
            if (contrib > 0 && (!best || contrib > best[1])) best = [name, contrib];
            lines.push(row('via callee ' + name, r3(contrib).toFixed(3), contrib, 'var(--warn)', 'τ ' + tau + ' × w ' + w + ' × P ' + p));
        }
        const inherited = 1 - inhSurvive;
        const P = 1 - (1 - p0) * inhSurvive;
        const band = P >= 0.7 ? 'high' : P >= 0.4 ? 'elevated' : P >= 0.15 ? 'low' : 'minimal';
        const bc = band === 'high' ? 'var(--err)' : band === 'elevated' ? 'var(--warn)' : 'var(--muted)';
        const routed = (inherited >= 0.15 || inherited > p0) && best;
        out('labCascade', big(r3(P).toFixed(3), 'P(failure)', bc) + big(band, 'band', bc) +
            row('p0 (its own state)', r3(p0).toFixed(3), p0, 'var(--sig)', reasons.join(' · ') || 'no evidence of its own') +
            lines.join('') +
            '<div class="lab-foot">inherited = ' + r3(inherited).toFixed(3) + ' · P = 1 − (1 − ' + r3(p0) + ') × ' + r3(inhSurvive) +
            (routed ? ' · <strong>via callee ' + best[0] + '</strong>' : ' · no via shown (inherited risk too small to name a route)') +
            (p0 < 0.15 && P >= 0.15 ? ' · <strong>at risk</strong>: fine on its own, pulled down by its dependencies.' : '') + '</div>');
    };

    // cpuShareOfAllowance() + statusFromSample() in containerHealth.ts
    window.labCpu = function () {
        const cpu = labNum('cpu-raw');
        const limit = labNum('cpu-limit');
        const host = labNum('cpu-host');
        const mem = labNum('cpu-mem') ?? 0;
        const allowance = limit && limit > 0 ? limit : host && host > 0 ? host : null;
        const share = cpu === null ? null : !allowance ? cpu : Math.min(100, cpu / allowance);
        const c = share ?? 0;
        let status = 'healthy', reason = 'running normally';
        if (c > 80 || mem > 80) {
            status = 'degraded';
            reason = 'resource saturation: ' + (c > 80 ? 'CPU ' + Math.round(c) + '%' + (allowance ? ' of its ' + r2(allowance) + '-core allowance' : '') : 'memory ' + Math.round(mem) + '%');
        }
        out('labCpu', big(share === null ? '—' : r2(share).toFixed(1) + '%', 'cpuOfAllowance', 'var(--sig)') +
            big(status, 'status', status === 'healthy' ? 'var(--ok)' : 'var(--warn)') +
            '<div class="lab-foot">allowance = ' + (allowance ? r2(allowance) + ' cores (' + (limit ? 'its limit' : 'host nproc') + ')' : 'unknown, so the raw per-core figure is used') +
            ' · ' + (cpu ?? '—') + '% of one core ÷ ' + (allowance ?? 1) + ' · ' + esc(reason) + '</div>');
    };

    // computeEdgeWeights() in server/graph/EdgeWeights.ts (activity path)
    window.labShares = function () {
        const CONF = { listen: 1.0, ephemeral: 0.85, legacy: 0.7, unresolved: 0.5, declared: 0.4, candidate: 0 };
        const edges = [];
        for (let i = 1; i <= 4; i++) {
            const name = labVal('sh-n' + i);
            if (!name) continue;
            edges.push({ name, conf: CONF[labVal('sh-e' + i)] ?? 0, ref: Math.max(0, labNum('sh-a' + i) ?? 0), kind: labVal('sh-k' + i) });
        }
        const groups = {};
        for (const e of edges) if (e.conf > 0) (groups[e.kind] = groups[e.kind] || []).push(e);
        const sums = {};
        for (const e of edges) {
            const sib = e.conf > 0 ? groups[e.kind] : [];
            let dep = 0, basis = 'none (candidate)';
            if (sib.length) {
                const total = sib.reduce((s, x) => s + x.ref, 0);
                const unmeasured = sib.filter((x) => !(x.ref > 0)).length;
                const pool = 1 - unmeasured / sib.length;
                if (total > 0 && e.ref > 0) { dep = (e.ref / total) * pool; basis = 'activity'; }
                else { dep = 1 / sib.length; basis = 'uniform'; }
                sums[e.kind] = (sums[e.kind] || 0) + dep;
            }
            e.dep = dep; e.basis = basis;
            e.weight = r3(Math.min(Math.max(e.conf * dep * (e.kind === 'telemetry' ? 0.1 : 1), 0), 1));
        }
        out('labShares', edges.map((e) => row(e.name, e.weight.toFixed(3), e.weight, e.kind === 'telemetry' ? 'var(--muted)' : 'var(--sig)',
            'share ' + Math.round(e.dep * 1000) / 10 + '% (' + e.basis + ') × confidence ' + e.conf + (e.kind === 'telemetry' ? ' × 0.1' : ''))).join('') +
            '<div class="lab-foot">Shares per kind: ' + Object.entries(sums).map(([k, v]) => k + ' ' + Math.round(v * 1000) / 10 + '%').join(' · ') +
            '. Each must be 100%: that is the consistency rule <code>reliance-sums-to-one</code>.</div>');
    };

    // edgeAppearance() + edgeLook() + linkFlow()/pulsesFor()/svgPulses()
    window.labLink = function () {
        const RED = ['#ff3d5e', 1], ORANGE = ['#ff9a3c', 0.95];
        const status = labVal('lk-status'), observed = labVal('lk-obs') === 'observed', callee = labVal('lk-callee');
        const errPct = labNum('lk-err'), latency = labNum('lk-lat'), req = labNum('lk-req'), perMin = labNum('lk-act'), w = labNum('lk-weight');
        const telemetry = labVal('lk-kind') === 'telemetry';
        const err = errPct === null ? null : errPct / 100;
        const measured = err !== null || latency !== null;
        const msf = (v) => v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms';
        let a;
        if (status === 'failed') a = { heat: 'failed', c: RED, label: 'failing', reason: 'marked failed' };
        else if (err !== null && err >= 0.05) a = { heat: 'failed', c: RED, label: 'failing', reason: (err * 100).toFixed(1) + '% of requests failing' };
        else if (latency !== null && latency >= 1000) a = { heat: 'failed', c: RED, label: 'very slow', reason: 'latency ' + msf(latency) };
        else if (observed && !measured && callee === 'critical') a = { heat: 'failed', c: RED, label: 'failing', reason: 'calls a service that is down' };
        else if (status === 'degraded') a = { heat: 'degraded', c: ORANGE, label: 'degraded', reason: 'marked degraded' };
        else if (err !== null && err >= 0.01) a = { heat: 'degraded', c: ORANGE, label: 'erroring', reason: (err * 100).toFixed(1) + '% of requests failing' };
        else if (latency !== null && latency >= 300) a = { heat: 'degraded', c: ORANGE, label: 'slow', reason: 'latency ' + msf(latency) };
        else if (observed && !measured && callee === 'degraded') a = { heat: 'degraded', c: ORANGE, label: 'degraded', reason: 'calls a degraded service' };
        else if (!observed) a = { heat: 'idle', c: ['#5b6aa0', 0.5], label: 'declared, not observed' };
        else if (perMin === null) a = { heat: 'calm', c: ['#4f7dff', 0.85], label: 'observed' };
        else if (perMin > 1200) a = { heat: 'saturated', c: ['#9cf4ff', 1], label: perMin + '/min, very heavy' };
        else if (perMin > 250) a = { heat: 'heavy', c: ['#1fd1ff', 0.95], label: perMin + '/min, heavy' };
        else if (perMin > 60) a = { heat: 'busy', c: ['#2f9bff', 0.9], label: perMin + '/min, busy' };
        else a = { heat: 'calm', c: ['#4f7dff', 0.85], label: perMin + '/min' };

        const width = telemetry ? 1 : w !== null ? 1.2 + 4.3 * Math.min(Math.max(w, 0), 1)
            : !observed ? 1 : (a.heat === 'saturated' || a.heat === 'failed') ? 3.4 : (a.heat === 'heavy' || a.heat === 'busy' || a.heat === 'degraded') ? 2.6 : 2;
        const pulsesFor = (x) => Math.min(5, Math.max(0.25, 0.3 + 1.6 * Math.log10(1 + Math.max(0, x))));
        let flow = null;
        if (req !== null && req > 0) flow = { basis: 'requests', rate: req, pulses: pulsesFor(req) };
        else if (perMin !== null && perMin > 0) flow = { basis: 'activity', rate: perMin / 60, pulses: pulsesFor(perMin / 60) };

        const len = 300;
        let svg = '<svg viewBox="0 0 340 40" width="340" style="max-width:100%;margin:6px 0 4px;">' +
            '<path id="lk-path" d="M14 20 H 314" stroke="' + a.c[0] + '" stroke-opacity="' + a.c[1] + '" stroke-width="' + width.toFixed(1) + '" fill="none" stroke-linecap="round"/>' +
            '<path d="M306 14 L316 20 L306 26 z" fill="' + a.c[0] + '"/>';
        let timing = '';
        if (flow) {
            const trip = Math.max(0.4, len / 110);
            const count = Math.min(8, Math.max(1, Math.round(flow.pulses * trip)));
            const dur = count / flow.pulses;
            for (let i = 0; i < count; i++) {
                svg += '<circle r="3" fill="#fff" fill-opacity="0.85"><animateMotion dur="' + dur.toFixed(2) + 's" begin="' + (-i * dur / count).toFixed(2) + 's" repeatCount="indefinite"><mpath href="#lk-path"/></animateMotion></circle>';
            }
            timing = count + ' on the path, one trip ' + dur.toFixed(2) + ' s → exactly ' + flow.pulses.toFixed(2) + ' arrive per second';
        }
        svg += '</svg>';
        out('labLink', '<div style="display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;">' +
            big(a.heat, esc(a.label), a.c[0]) + big(width.toFixed(1) + ' px', 'width') +
            big(flow ? flow.pulses.toFixed(2) : '0', 'pulses / s') + '</div>' + svg +
            '<div class="lab-foot">' + (a.reason ? '<strong>Why:</strong> ' + esc(a.reason) + '. ' : '') +
            (flow ? 'Pulse rate from ' + (flow.basis === 'requests' ? flow.rate + ' req/s (measured requests)' : 'the activity index ÷ 60 = ' + r2(flow.rate) + ' (not a request count)') + '; ' + timing + '.'
                  : 'No rate measured, so no pulses.') + '</div>');
    };

    // detector_score() + combine() in ml/ensemble.py, persistence in score.py
    window.labEnsemble = function () {
        const names = ['iforest', 'lof', 'ocsvm', 'zscore'];
        const used = [];
        const lines = [];
        for (const n of names) {
            const raw = labNum('ml-' + n + '-raw'), c = labNum('ml-' + n + '-c'), t = labNum('ml-' + n + '-t');
            if (raw === null || c === null || t === null || t - c <= 1e-9) {
                lines.push(row(n, '—', 0, 'var(--muted)', 'unusable: missing statistics or no spread between centre and threshold'));
                continue;
            }
            const r = (raw - c) / (t - c);
            const score = Math.max(0, Math.min(1, r / 2));
            const above = raw >= t;
            used.push({ score, above });
            lines.push(row(n, score.toFixed(2), score, above ? 'var(--warn)' : 'var(--sig)', 'r = ' + r2(r) + (above ? ' · above its threshold (votes yes)' : ' · below its threshold')));
        }
        if (!used.length) { out('labEnsemble', lines.join('') + '<div class="lab-foot">No usable detector: the service is left out of latest_scores.json, never given a made-up score.</div>'); return; }
        const sorted = used.map((u) => u.score).sort((x, y) => x - y);
        const n = sorted.length;
        const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        const votes = used.filter((u) => u.above).length;
        const needed = Math.ceil(n / 2);
        const anomalous = votes >= needed;
        const prev = Math.max(0, Math.round(labNum('ml-prev') ?? 0));
        const need = Math.max(1, Math.round(labNum('ml-need') ?? 3));
        const consecutive = anomalous ? prev + 1 : 0;
        const persistent = consecutive >= need;
        out('labEnsemble', big(median.toFixed(2), 'anomaly_score (median)') +
            big(votes + '/' + n, 'votes (need ' + needed + ')', anomalous ? 'var(--warn)' : 'var(--ok)') +
            big(persistent ? 'persistent' : anomalous ? 'anomalous' : 'normal', consecutive + ' window(s) in a row', persistent ? 'var(--err)' : anomalous ? 'var(--warn)' : 'var(--ok)') +
            lines.join('') +
            '<div class="lab-foot">Only a persistent anomaly gets the ANOMALY badge, and it weighs 0.8 (not 0.3) in the cascade model.</div>');
    };

    // Run every lab once, then again on each edit.
    document.querySelectorAll('.interactive-lab[data-lab]').forEach((lab) => {
        const fn = window[lab.getAttribute('data-lab')];
        if (typeof fn !== 'function') return;
        lab.addEventListener('input', fn);
        lab.addEventListener('change', fn);
        try { fn(); } catch (e) { console.error(e); }
    });

    // 6. Reading progress, along the top edge.
    const bar = document.createElement('div');
    bar.className = 'read-progress';
    document.body.appendChild(bar);
    const onScroll = () => {
        const h = document.documentElement;
        const max = h.scrollHeight - h.clientHeight;
        bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, h.scrollTop / max) : 0) + ')';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // 7. "On this page": the chapter's sections, following the scroll.
    const aside = document.querySelector('.side-toc');
    const article = document.querySelector('.doc-body');
    if (aside && article) {
        const heads = Array.from(article.querySelectorAll('h2[id]'));
        if (heads.length >= 3) {
            aside.innerHTML = '<div class="side-toc-title">On this page</div>' + heads.map((h) =>
                '<a href="#' + h.id + '" data-for="' + h.id + '">' + h.textContent.replace(/^\\d+(\\.\\d+)?\\s*/, '') + '</a>').join('') +
                (document.getElementById('try-it') ? '<a href="#try-it" data-for="try-it" class="try">Try it</a>' : '');
            const links = new Map(Array.from(aside.querySelectorAll('a')).map((a) => [a.getAttribute('data-for'), a]));
            const targets = heads.concat(document.getElementById('try-it') ? [document.getElementById('try-it')] : []);
            // The section you are in is the last heading above a line a third
            // of the way down the screen, so a sub-section still lights its parent.
            let current = null;
            const spy = () => {
                const line = window.innerHeight * 0.33;
                let id = targets[0].id;
                for (const t of targets) if (t.getBoundingClientRect().top <= line) id = t.id;
                if (id === current) return;
                current = id;
                links.forEach((a) => a.classList.toggle('on', a.getAttribute('data-for') === id));
            };
            window.addEventListener('scroll', spy, { passive: true });
            spy();
            document.body.classList.add('has-side-toc');
        } else {
            aside.remove();
        }
    }

    // 8. Search everything: Ctrl/Cmd+K or "/".
    const INDEX = window.BOOK_INDEX || [];
    const palette = document.createElement('div');
    palette.className = 'palette';
    palette.hidden = true;
    palette.innerHTML = '<div class="palette-box" role="dialog" aria-label="Search the book">' +
        '<input type="text" placeholder="Search chapters, sections, terms…" aria-label="Search" autocomplete="off" spellcheck="false">' +
        '<div class="palette-results"></div>' +
        '<div class="palette-foot"><span>↑↓ move</span><span>↵ open</span><span>esc close</span></div></div>';
    document.body.appendChild(palette);
    const pin = palette.querySelector('input');
    const pres = palette.querySelector('.palette-results');
    let hits = [], sel = 0;
    const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const mark = (text, toks) => {
        let out = escHtml(text);
        for (const t of toks) if (t.length > 1) out = out.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'ig'), '<mark>$1</mark>');
        return out;
    };
    function search(q) {
        const toks = q.toLowerCase().split(/\\s+/).filter(Boolean);
        if (!toks.length) {
            hits = INDEX.filter((d) => d.k === 'chapter').slice(0, 10).map((d) => ({ d, score: 0 }));
        } else {
            hits = [];
            for (const d of INDEX) {
                const hay = (d.t + ' ' + (d.s || '') + ' ' + (d.x || '')).toLowerCase();
                if (!toks.every((t) => hay.includes(t))) continue;
                let score = 0;
                const tl = d.t.toLowerCase();
                for (const t of toks) score += tl.startsWith(t) ? 6 : tl.includes(t) ? 4 : (d.s || '').toLowerCase().includes(t) ? 2 : 1;
                if (d.k === 'chapter') score += 2;
                hits.push({ d, score });
            }
            hits.sort((a, b) => b.score - a.score);
            hits = hits.slice(0, 14);
        }
        sel = 0;
        pres.innerHTML = hits.length ? hits.map((h, i) =>
            '<a href="' + h.d.u + '" class="hit' + (i === 0 ? ' sel' : '') + '"><span class="hit-k k-' + h.d.k + '">' + h.d.k + '</span>' +
            '<span class="hit-t">' + mark(h.d.t, toks) + '</span><span class="hit-s">' + mark(h.d.s || '', toks) + '</span></a>').join('')
            : '<div class="palette-none">Nothing matches. Try a function name, a term or a number like 0.7.</div>';
    }
    const openPalette = () => { palette.hidden = false; pin.value = ''; search(''); setTimeout(() => pin.focus(), 0); };
    const closePalette = () => { palette.hidden = true; };
    pin.addEventListener('input', () => search(pin.value));
    pin.addEventListener('keydown', (e) => {
        const items = pres.querySelectorAll('.hit');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!items.length) return;
            items[sel].classList.remove('sel');
            sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
            items[sel].classList.add('sel');
            items[sel].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && items[sel]) {
            window.location.href = items[sel].getAttribute('href');
        } else if (e.key === 'Escape') {
            closePalette();
        }
    });
    palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });
    document.addEventListener('keydown', (e) => {
        const typing = /input|textarea|select/i.test((e.target && e.target.tagName) || '');
        if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); }
        else if (e.key === '/' && !typing && palette.hidden) { e.preventDefault(); openPalette(); }
        else if (e.key === 'Escape' && !palette.hidden) closePalette();
    });
    document.querySelectorAll('[data-open-search]').forEach((b) => b.addEventListener('click', openPalette));

    // 9. Sections arrive as you reach them. Off for reduced motion; anything
    //    already on screen is shown at once.
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
        const items = document.querySelectorAll('.doc-body > h2, .doc-body > .scroll, .doc-body > .box, .chapter-figure, .interactive-lab, .part-block, .path, .stat, .feature-card, .flow-layer');
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        }, { rootMargin: '0px 0px -6% 0px' });
        items.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.top < window.innerHeight) return;
            el.classList.add('reveal');
            io.observe(el);
        });
    }

    // 10. Where you have been. Kept in this browser only; the page works the
    //     same without it.
    const store = {
        get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
    };
    const here = (location.pathname.split('/').pop() || 'index.html');
    const visited = new Set(store.get('mm.book.visited', []));
    if (here !== 'index.html' && document.querySelector('.chapter-rail')) {
        visited.add(here);
        store.set('mm.book.visited', Array.from(visited));
        store.set('mm.book.last', { u: here, t: document.title.split(' | ')[0] });
    }
    document.querySelectorAll('.chapter-row').forEach((row) => {
        if (visited.has(row.getAttribute('href'))) row.classList.add('visited');
    });
    const last = store.get('mm.book.last', null);
    const cont = document.querySelector('[data-continue]');
    if (cont && last && last.u) {
        cont.href = last.u;
        cont.textContent = 'Continue: ' + last.t + ' →';
        cont.hidden = false;
    }
    const done = document.querySelector('[data-progress-count]');
    if (done) done.textContent = String(document.querySelectorAll('.chapter-row.visited').length);
});
"""

# ---------------------------------------------------------------------------
# Chapter diagrams.
#
# Hand-authored SVG, one per chapter where a picture carries the mechanism
# better than a paragraph. They use the page's own CSS variables so they track
# the theme, and they describe what the code actually does — the numbers and
# names in them are the real ones.
# ---------------------------------------------------------------------------

def _svg(body, view_w, view_h, caption):
    return f"""
    <figure class="chapter-figure">
      <div class="fx">
        <svg viewBox="0 0 {view_w} {view_h}" width="{view_w}" role="img" style="max-width:100%;height:auto;display:block;">
          <defs>
            <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)"/>
            </marker>
            <marker id="ars" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--sig)"/>
            </marker>
            <marker id="are" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--err)"/>
            </marker>
          </defs>
          {body}
        </svg>
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
    """

_T  = 'font-family:var(--body);font-size:13px;font-weight:600;fill:var(--ink)'
_TS = 'font-family:var(--body);font-size:11.5px;fill:var(--muted)'
_TM = 'font-family:var(--mono);font-size:11px;fill:var(--sig)'

def diagram_overview():
    body = f"""
      <rect x="14" y="60" width="240" height="150" rx="10" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.5"/>
      <text x="134" y="88" text-anchor="middle" style="{_T}">Your machine</text>
      <text x="134" y="112" text-anchor="middle" style="{_TS}">server + client + traffic-gen</text>
      <text x="134" y="140" text-anchor="middle" style="{_TS}">holds the graph, the models,</text>
      <text x="134" y="158" text-anchor="middle" style="{_TS}">the incidents — all of it</text>
      <text x="134" y="188" text-anchor="middle" style="{_TM}">nothing of this is on the target</text>

      <line x1="254" y1="120" x2="404" y2="120" stroke="var(--sig)" stroke-width="2" marker-end="url(#ars)"/>
      <text x="329" y="108" text-anchor="middle" style="{_TM}">ssh :22</text>
      <text x="329" y="142" text-anchor="middle" style="{_TS}">reads, never installs</text>

      <rect x="404" y="34" width="300" height="204" rx="10" fill="var(--panel-2)" stroke="var(--rule)" stroke-dasharray="4 3"/>
      <text x="554" y="60" text-anchor="middle" style="{_T}">The target</text>
      <text x="554" y="78" text-anchor="middle" style="{_TS}">someone else's running system</text>

      <rect x="424" y="94" width="120" height="54" rx="7" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="484" y="118" text-anchor="middle" style="{_TS}">container</text>
      <text x="484" y="136" text-anchor="middle" style="{_TS}">unmodified</text>

      <rect x="564" y="94" width="120" height="54" rx="7" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="624" y="118" text-anchor="middle" style="{_TS}">container</text>
      <text x="624" y="136" text-anchor="middle" style="{_TS}">unmodified</text>

      <line x1="544" y1="121" x2="562" y2="121" stroke="var(--muted)" stroke-width="1.5"/>
      <text x="554" y="180" text-anchor="middle" style="{_TS}">docker ps &middot; docker stats &middot; /proc/&lt;pid&gt;/net/tcp</text>
      <text x="554" y="200" text-anchor="middle" style="{_TS}">all read from the host, from outside the containers</text>
    """
    return _svg(body, 720, 250,
        "One constraint drives the whole design: nothing may be installed on the target. "
        "Everything the system knows, it learned by reading from the outside over one SSH connection.")

def diagram_layers():
    rows = [
        ("Collection", "runs against the target over SSH", "var(--sig)", 40),
        ("Server processing", "GraphStore, MetricStore, ingestion", "var(--ok)", 106),
        ("Intelligence", "incidents, RCA, risk, ML scoring", "var(--warn)", 172),
        ("Frontend", "2D graph, 3D canvas, the analysis pages", "var(--muted)", 238),
    ]
    body = ""
    for title, sub, colour, y in rows:
        body += f"""
      <rect x="40" y="{y}" width="620" height="52" rx="8" fill="var(--panel)" stroke="{colour}" stroke-width="1.5"/>
      <text x="62" y="{y+22}" style="{_T}">{title}</text>
      <text x="62" y="{y+40}" style="{_TS}">{sub}</text>"""
        if y < 238:
            body += f"""
      <line x1="350" y1="{y+52}" x2="350" y2="{y+64}" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#ar)"/>"""
    body += f"""
      <text x="670" y="70" style="{_TM}">ssh</text>
      <text x="670" y="136" style="{_TM}">memory</text>
      <text x="670" y="202" style="{_TM}">rules + models</text>
      <text x="670" y="268" style="{_TM}">ws + rest</text>"""
    return _svg(body, 760, 306,
        "Data only ever moves down this stack. Each layer depends on the one above it and knows nothing about the one below.")

def diagram_tiers():
    body = f"""
      <polygon points="40,250 660,250 540,180 160,180" fill="var(--panel-2)" stroke="var(--muted)" stroke-width="1.5"/>
      <text x="350" y="212" text-anchor="middle" style="{_T}">Tier 0 &mdash; from the outside</text>
      <text x="350" y="232" text-anchor="middle" style="{_TS}">cpu, memory, who is connected to whom &mdash; never what a request was</text>
      <text x="628" y="200" text-anchor="end" style="{_TM}">ALWAYS</text>

      <polygon points="160,180 540,180 452,112 248,112" fill="var(--panel)" stroke="var(--warn)" stroke-width="1.5"/>
      <text x="350" y="146" text-anchor="middle" style="{_T}">Tier 1 &mdash; the gateway's log</text>
      <text x="350" y="165" text-anchor="middle" style="{_TS}">per-request status and latency, if a proxy writes them</text>
      <text x="520" y="134" text-anchor="end" style="{_TM}">SOMETIMES</text>

      <polygon points="248,112 452,112 350,44" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.5"/>
      <text x="350" y="88" text-anchor="middle" style="{_T}">Tier 2</text>
      <text x="350" y="104" text-anchor="middle" style="{_TS}">its own metrics</text>
      <text x="470" y="80" style="{_TM}">RARELY</text>
    """
    return _svg(body, 720, 268,
        "Each number carries the tier it came from. A tier-0 estimate is never quietly presented as a tier-2 measurement, "
        "and a value nobody could measure stays null rather than becoming zero.")

def diagram_direction():
    body = f"""
      <text x="30" y="30" style="{_TM}">THE PROBLEM</text>
      <rect x="30" y="44" width="130" height="44" rx="7" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="95" y="71" text-anchor="middle" style="{_T}">orders</text>
      <rect x="290" y="44" width="130" height="44" rx="7" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="355" y="71" text-anchor="middle" style="{_T}">orders-db</text>
      <path d="M160 58 H 288" stroke="var(--err)" stroke-width="1.6" marker-end="url(#are)"/>
      <path d="M288 76 H 162" stroke="var(--err)" stroke-width="1.6" marker-end="url(#are)"/>
      <text x="224" y="50" text-anchor="middle" style="{_TS}">from orders' scan</text>
      <text x="224" y="96" text-anchor="middle" style="{_TS}">from the db's scan</text>
      <text x="440" y="58" style="{_TS}">Every container is scanned, so one</text>
      <text x="440" y="76" style="{_TS}">connection was recorded twice, in</text>
      <text x="440" y="94" style="{_TS}">opposite directions.</text>

      <line x1="30" y1="124" x2="740" y2="124" stroke="var(--rule)"/>

      <text x="30" y="154" style="{_TM}">THE FIX &mdash; whoever holds the listening port is being called</text>
      <rect x="30" y="172" width="130" height="58" rx="7" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="95" y="196" text-anchor="middle" style="{_T}">orders</text>
      <text x="95" y="216" text-anchor="middle" style="{_TM}">:45000</text>
      <text x="95" y="248" text-anchor="middle" style="{_TS}">ephemeral &rarr; client</text>

      <rect x="290" y="172" width="130" height="58" rx="7" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.5"/>
      <text x="355" y="196" text-anchor="middle" style="{_T}">orders-db</text>
      <text x="355" y="216" text-anchor="middle" style="{_TM}">:27017 LISTEN</text>
      <text x="355" y="248" text-anchor="middle" style="{_TS}">listening &rarr; server</text>

      <path d="M160 200 H 288" stroke="var(--sig)" stroke-width="2.2" marker-end="url(#ars)"/>
      <text x="224" y="192" text-anchor="middle" style="{_TM}">calls</text>

      <text x="440" y="188" style="{_TS}">Both scans now resolve to the same</text>
      <text x="440" y="206" style="{_TS}">single arrow, so the duplicate</text>
      <text x="440" y="224" style="{_TS}">disappears and databases stop</text>
      <text x="440" y="242" style="{_TS}">appearing as callers of their clients.</text>
    """
    return _svg(body, 760, 272,
        "LISTEN rows were already in the scan output and were being discarded. Using them fixes direction, "
        "removes a false cycle on every pair, and is what makes blast radius mean anything.")

def diagram_blast():
    body = f"""
      <rect x="40" y="40" width="130" height="46" rx="7" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="105" y="68" text-anchor="middle" style="{_T}">frontend</text>
      <rect x="250" y="40" width="130" height="46" rx="7" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="315" y="68" text-anchor="middle" style="{_T}">orders</text>
      <rect x="460" y="40" width="140" height="46" rx="7" fill="var(--panel)" stroke="var(--err)" stroke-width="2"/>
      <text x="530" y="62" text-anchor="middle" style="{_T}">orders-db</text>
      <text x="530" y="78" text-anchor="middle" style="{_TS}">fails</text>

      <path d="M170 63 H 248" stroke="var(--muted)" stroke-width="1.8" marker-end="url(#ar)"/>
      <path d="M380 63 H 458" stroke="var(--muted)" stroke-width="1.8" marker-end="url(#ar)"/>
      <text x="209" y="54" text-anchor="middle" style="{_TM}">calls</text>
      <text x="419" y="54" text-anchor="middle" style="{_TM}">calls</text>

      <path d="M458 108 H 382" stroke="var(--err)" stroke-width="2" marker-end="url(#are)" stroke-dasharray="5 3"/>
      <path d="M248 108 H 172" stroke="var(--err)" stroke-width="2" marker-end="url(#are)" stroke-dasharray="5 3"/>
      <text x="420" y="128" text-anchor="middle" style="{_TS}">hop 1</text>
      <text x="210" y="128" text-anchor="middle" style="{_TS}">hop 2</text>
      <text x="320" y="152" text-anchor="middle" style="{_TS}">failure travels against the arrow &mdash; toward whoever depends on it</text>
    """
    return _svg(body, 660, 172,
        "An arrow means \"calls\". So a failure moves the other way: the database takes down the services calling it, "
        "then whatever calls those. Walking arrows forwards would list what the database calls, which is close to the opposite question.")

def diagram_two_opinions():
    body = f"""
      <rect x="30" y="86" width="140" height="48" rx="8" fill="var(--panel-2)" stroke="var(--rule)"/>
      <text x="100" y="115" text-anchor="middle" style="{_T}">one measurement</text>

      <path d="M170 98 Q 240 56 310 56" fill="none" stroke="var(--warn)" stroke-width="2" marker-end="url(#ar)"/>
      <path d="M170 122 Q 240 164 310 164" fill="none" stroke="var(--sig)" stroke-width="2" marker-end="url(#ars)"/>

      <rect x="312" y="32" width="200" height="50" rx="8" fill="var(--panel)" stroke="var(--warn)" stroke-width="1.5"/>
      <text x="412" y="54" text-anchor="middle" style="{_T}">Incidents &mdash; fixed rules</text>
      <text x="412" y="71" text-anchor="middle" style="{_TS}">works with no training at all</text>

      <rect x="312" y="140" width="200" height="50" rx="8" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.5"/>
      <text x="412" y="162" text-anchor="middle" style="{_T}">Findings &mdash; learned</text>
      <text x="412" y="179" text-anchor="middle" style="{_TS}">needs that service's own history</text>

      <text x="540" y="100" style="{_TS}">Kept separate on purpose: if the</text>
      <text x="540" y="118" style="{_TS}">alerts came from the models, then</text>
      <text x="540" y="136" style="{_TS}">judging those models would mean</text>
      <text x="540" y="154" style="{_TS}">grading them on their own output.</text>
    """
    return _svg(body, 780, 208,
        "Two independent judges on the same number. Either can catch something the other misses, "
        "and keeping them apart is what leaves something honest to evaluate the models against.")

def diagram_ml():
    stages = [
        ("collector.py", "every 10 s", "metrics_raw.csv", 20),
        ("preprocess.py", "per-service z-score", "features.csv", 200),
        ("train.py", "4 detectors / service", "*.joblib + meta", 380),
        ("score.py", "every 10 s · vote", "latest_scores.json", 560),
    ]
    body = ""
    for name, sub, artefact, x in stages:
        body += f"""
      <rect x="{x}" y="34" width="160" height="60" rx="8" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.4"/>
      <text x="{x+80}" y="58" text-anchor="middle" style="{_T}">{name}</text>
      <text x="{x+80}" y="78" text-anchor="middle" style="{_TS}">{sub}</text>
      <text x="{x+80}" y="118" text-anchor="middle" style="{_TM}">{artefact}</text>"""
        if x < 560:
            body += f"""
      <line x1="{x+160}" y1="64" x2="{x+198}" y2="64" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#ar)"/>"""
    dets = [("Isolation Forest", "partitioning"), ("LOF", "local density"), ("one-class SVM", "boundary"), ("z-score", "statistical")]
    for i, (n, fam) in enumerate(dets):
        x = 40 + i * 130
        body += f"""
      <rect x="{x}" y="156" width="118" height="44" rx="7" fill="var(--panel-2)" stroke="var(--rule)"/>
      <text x="{x+59}" y="175" text-anchor="middle" style="{_T}">{n}</text>
      <text x="{x+59}" y="192" text-anchor="middle" style="{_TS}">{fam}</text>
      <line x1="{x+59}" y1="200" x2="{x+59}" y2="222" stroke="var(--muted)" stroke-width="1.2"/>"""
    body += f"""
      <line x1="99" y1="222" x2="489" y2="222" stroke="var(--muted)" stroke-width="1.2"/>
      <line x1="294" y1="222" x2="294" y2="240" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#ar)"/>
      <rect x="159" y="242" width="270" height="44" rx="8" fill="var(--panel)" stroke="var(--warn)" stroke-width="1.5"/>
      <text x="294" y="261" text-anchor="middle" style="{_T}">vote: ≥ half above threshold</text>
      <text x="294" y="278" text-anchor="middle" style="{_TS}">score = median · 3 in a row = persistent</text>
      <text x="560" y="172" style="{_TS}">each on its own scale (m = its</text>
      <text x="560" y="188" style="{_TS}">training median):</text>
      <text x="560" y="208" style="{_TM}">r = (raw − m) / (p99 − m)</text>
      <text x="560" y="226" style="{_TM}">score = clamp(r / 2, 0, 1)</text>
      <text x="560" y="246" style="{_TS}">0.5 = at that detector's threshold</text>"""
    return _svg(body, 760, 300,
        "Four scripts hand files to each other. collector and score run continuously; preprocess and train when asked. "
        "Live scoring puts the four detectors on one scale and votes, so one misbehaving detector cannot raise an alarm alone.")


def diagram_confidence():
    rows = [
        ("request log (http-log)", 1.00, "var(--ok)"),
        ("observed · listening port", 1.00, "var(--ok)"),
        ("observed · ephemeral port range", 0.85, "var(--ok)"),
        ("observed · no direction recorded", 0.70, "var(--t2)"),
        ("observed · direction unresolved", 0.50, "var(--t2)"),
        ("declared in config only", 0.40, "var(--warn)"),
        ("candidate (shared network)", 0.00, "var(--muted)"),
    ]
    body = ""
    for i, (label, v, colour) in enumerate(rows):
        y = 26 + i * 32
        body += f"""
      <text x="250" y="{y+15}" text-anchor="end" style="{_TS}">{label}</text>
      <rect x="262" y="{y+3}" width="420" height="16" rx="4" fill="var(--panel-2)"/>
      <rect x="262" y="{y+3}" width="{max(2, 420*v):.0f}" height="16" rx="4" fill="{colour}" fill-opacity="0.85"/>
      <text x="{262 + max(2, 420*v) + 8:.0f}" y="{y+15}" style="{_TM}">{v:.2f}</text>"""
    return _svg(body, 760, 262,
        "How sure the mapper is that a dependency exists and points the right way, by the evidence behind it "
        "(edgeConfidence in EdgeWeights.ts). Every weight, RCA factor and cascade step is scaled by this number, "
        "so a claim on paper never counts as much as a socket that was seen.")


def diagram_stack():
    body = f"""
      <rect x="20" y="20" width="470" height="262" rx="12" fill="none" stroke="var(--rule)" stroke-dasharray="5 4"/>
      <text x="36" y="42" style="{_TM}">YOUR MACHINE</text>

      <rect x="40" y="58" width="190" height="56" rx="8" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.5"/>
      <text x="135" y="80" text-anchor="middle" style="{_T}">client :5173</text>
      <text x="135" y="98" text-anchor="middle" style="{_TS}">React 19 · Vite · XYFlow · R3F</text>

      <rect x="40" y="168" width="190" height="56" rx="8" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.5"/>
      <text x="135" y="190" text-anchor="middle" style="{_T}">server :3001</text>
      <text x="135" y="208" text-anchor="middle" style="{_TS}">Node · Express 5 · ws · ssh2</text>

      <rect x="280" y="168" width="190" height="56" rx="8" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="375" y="190" text-anchor="middle" style="{_T}">ml/ (Python)</text>
      <text x="375" y="208" text-anchor="middle" style="{_TS}">pandas · scikit-learn · joblib</text>

      <rect x="280" y="58" width="190" height="56" rx="8" fill="var(--panel)" stroke="var(--rule)"/>
      <text x="375" y="80" text-anchor="middle" style="{_T}">traffic-gen :4400</text>
      <text x="375" y="98" text-anchor="middle" style="{_TS}">Node workflows</text>

      <line x1="120" y1="114" x2="120" y2="166" stroke="var(--sig)" stroke-width="1.6" marker-end="url(#ars)"/>
      <line x1="150" y1="166" x2="150" y2="116" stroke="var(--sig)" stroke-width="1.6" marker-end="url(#ars)"/>
      <text x="62" y="145" style="{_TM}">REST</text>
      <text x="158" y="145" style="{_TM}">ws push</text>

      <line x1="232" y1="188" x2="278" y2="188" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#ar)"/>
      <line x1="278" y1="206" x2="232" y2="206" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#ar)"/>
      <text x="375" y="152" text-anchor="middle" style="{_TS}">/api/graph →  ← latest_scores.json</text>
      <line x1="232" y1="176" x2="290" y2="116" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#ar)" stroke-dasharray="4 3"/>

      <rect x="560" y="40" width="180" height="226" rx="12" fill="var(--panel-2)" stroke="var(--rule)" stroke-dasharray="5 4"/>
      <text x="650" y="64" text-anchor="middle" style="{_TM}">THE TARGET</text>
      <text x="650" y="96" text-anchor="middle" style="{_T}">docker · /proc</text>
      <text x="650" y="114" text-anchor="middle" style="{_TS}">compose files</text>
      <text x="650" y="150" text-anchor="middle" style="{_TS}">nothing of ours</text>
      <text x="650" y="166" text-anchor="middle" style="{_TS}">installed</text>
      <path d="M135 224 V 252 H 558" fill="none" stroke="var(--sig)" stroke-width="2" marker-end="url(#ars)"/>
      <text x="545" y="246" text-anchor="end" style="{_TM}">ssh :22 · read-only</text>
      <line x1="472" y1="86" x2="558" y2="86" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#ar)"/>
      <text x="515" y="78" text-anchor="middle" style="{_TM}">HTTP</text>
    """
    return _svg(body, 760, 296,
        "Four programs, each with the smallest toolset for its job. The server is the only one that talks to the target, "
        "and it only reads. The ML pipeline shares nothing with the server but a file in each direction.")


def diagram_sweep():
    body = f"""
      <text x="20" y="14" style="{_TM}">ONE LINK, SIX SWEEPS 5 s APART</text>
      <line x1="120" y1="44" x2="740" y2="44" stroke="var(--rule)"/>"""
    xs = [150, 235, 320, 405, 490, 575]
    for i, x in enumerate(xs):
        body += f"""
      <line x1="{x}" y1="46" x2="{x}" y2="196" stroke="var(--rule-2)"/>
      <text x="{x}" y="38" text-anchor="middle" style="{_TS}">sweep {i+1}</text>"""
    conns = [
        ("A  :41000", [0, 1, 2, 3, 4, 5], "ESTABLISHED", "var(--sig)"),
        ("B  :41007", [0, 1, 2, 3, 4, 5], "ESTABLISHED", "var(--sig)"),
        ("C  :41022", [1, 2], "opened, closed", "var(--ok)"),
        ("C  TIME_WAIT", [3, 4, 5], "lingers ~60 s", "var(--muted)"),
    ]
    for j, (label, seen, state, colour) in enumerate(conns):
        y = 62 + j * 32
        body += f'\n      <text x="20" y="{y+4}" style="{_TM}">{label}</text>'
        for k in seen:
            body += f'\n      <circle cx="{xs[k]}" cy="{y}" r="6" fill="{colour}" fill-opacity="0.9"/>'
    body += f"""
      <text x="20" y="210" style="{_TS}">rows per sweep</text>"""
    rows = [2, 3, 3, 3, 3, 3]
    for x, n in zip(xs, rows):
        body += f'\n      <text x="{x}" y="210" text-anchor="middle" style="{_TM}">{n}</text>'
    body += f"""
      <text x="20" y="236" style="{_TS}">distinct open</text>"""
    for x, n in zip(xs, [2, 3, 3, 2, 2, 2]):
        body += f'\n      <text x="{x}" y="236" text-anchor="middle" style="{_TM}">{n}</text>'
    body += f"""
      <text x="20" y="262" style="{_TS}">new (never seen)</text>"""
    for x, n in zip(xs, ["—", "1", "0", "0", "0", "0"]):
        body += f'\n      <text x="{x}" y="262" text-anchor="middle" style="{_TM}">{n}</text>'
    body += f"""
      <text x="740" y="210" text-anchor="end" style="{_TS}">17 sightings</text>
      <text x="740" y="236" text-anchor="end" style="{_TS}">avg ≈ 2.3 open</text>
      <text x="740" y="262" text-anchor="end" style="{_TS}">1 new connection</text>"""
    return _svg(body, 760, 280,
        "Counting rows would report 17 \"connections\" for what is really two long-lived connections and one short one. "
        "Each socket carries a key (callerIp:port>calleeIp:port), so the store counts distinct open connections per sweep, "
        "and a key counts as new only once. It is remembered for 150 s, past TIME_WAIT. The first sweep is never counted as new.")


def diagram_verify():
    body = f"""
      <rect x="20" y="60" width="160" height="76" rx="9" fill="var(--panel)" stroke="var(--ok)" stroke-width="1.5"/>
      <text x="100" y="86" text-anchor="middle" style="{_T}">simulate-target.ts</text>
      <text x="100" y="104" text-anchor="middle" style="{_TS}">known topology, sockets,</text>
      <text x="100" y="120" text-anchor="middle" style="{_TS}">and scripted failures</text>

      <line x1="180" y1="98" x2="286" y2="98" stroke="var(--sig)" stroke-width="1.8" marker-end="url(#ars)"/>
      <text x="233" y="88" text-anchor="middle" style="{_TM}">/api/ingest</text>

      <rect x="288" y="40" width="202" height="116" rx="9" fill="var(--panel)" stroke="var(--sig)" stroke-width="1.5"/>
      <text x="389" y="64" text-anchor="middle" style="{_T}">isolated mapper :3099</text>
      <text x="389" y="84" text-anchor="middle" style="{_TS}">real GraphStore, weights,</text>
      <text x="389" y="100" text-anchor="middle" style="{_TS}">RCA, cascade, API</text>
      <text x="389" y="126" text-anchor="middle" style="{_TM}">own cwd · own token</text>
      <text x="389" y="142" text-anchor="middle" style="{_TM}">targets named sim-*</text>

      <line x1="490" y1="98" x2="558" y2="98" stroke="var(--sig)" stroke-width="1.8" marker-end="url(#ars)"/>

      <rect x="560" y="30" width="180" height="136" rx="9" fill="var(--panel-2)" stroke="var(--rule)"/>
      <text x="650" y="54" text-anchor="middle" style="{_T}">compare with truth</text>
      <text x="576" y="78" style="{_TS}">✓ RCA root = the faulted one</text>
      <text x="576" y="98" style="{_TS}">✓ open conns = 2 per link</text>
      <text x="576" y="118" style="{_TS}">✓ new/min ≈ rate ÷ 10</text>
      <text x="576" y="138" style="{_TS}">✓ consistency: 0 violations</text>
      <text x="576" y="156" style="{_TS}">✓ ids resolve, same project</text>

      <path d="M100 136 V 196 H 650 V 168" fill="none" stroke="var(--ok)" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ar)"/>
      <text x="380" y="214" text-anchor="middle" style="{_TS}">the simulator prints its ground truth when it starts</text>
    """
    return _svg(body, 760, 226,
        "The live targets cannot tell you the true root cause. The simulator can. Running it against a separate server "
        "checks the whole pipeline (graph, weights, connections, RCA, consistency) against answers known in advance. "
        "Last audit: open connections exact on 9/9 links, new connections within 1.4%, root cause named at HIGH confidence.")


def diagram_link_legend():
    rows = [
        ("#ff3d5e", "failing", "marked failed · errors ≥ 5% · p95 ≥ 1 s · calls a down service"),
        ("#ff9a3c", "slow / erroring", "marked degraded · errors ≥ 1% · p95 ≥ 300 ms · calls a degraded service"),
        ("#9cf4ff", "very heavy", "> 1200 sightings/min"),
        ("#1fd1ff", "heavy", "> 250 /min"),
        ("#2f9bff", "busy", "> 60 /min"),
        ("#4f7dff", "calm", "≤ 60 /min, or observed with no rate yet"),
        ("#5b6aa0", "declared only", "in config, never seen carrying traffic"),
    ]
    body = f'<text x="20" y="22" style="{_TM}">FIRST MATCH WINS, TOP TO BOTTOM</text>'
    for i, (c, name, rule) in enumerate(rows):
        y = 40 + i * 30
        body += f"""
      <line x1="24" y1="{y+8}" x2="124" y2="{y+8}" stroke="{c}" stroke-width="4" stroke-linecap="round"/>
      <circle cx="{60 + i*7}" cy="{y+8}" r="3" fill="#fff" fill-opacity="0.8"/>
      <text x="140" y="{y+12}" style="{_T}">{name}</text>
      <text x="270" y="{y+12}" style="{_TS}">{rule}</text>"""
    body += f"""
      <line x1="20" y1="{40+7*30+4}" x2="740" y2="{40+7*30+4}" stroke="var(--rule)"/>
      <text x="20" y="{40+7*30+26}" style="{_TM}">WIDTH</text>
      <text x="90" y="{40+7*30+26}" style="{_TS}">1.2 + 4.3 × weight px</text>
      <line x1="270" y1="{40+7*30+22}" x2="320" y2="{40+7*30+22}" stroke="var(--link-busy)" stroke-width="1.2"/>
      <line x1="330" y1="{40+7*30+22}" x2="380" y2="{40+7*30+22}" stroke="var(--link-busy)" stroke-width="3.4"/>
      <line x1="390" y1="{40+7*30+22}" x2="440" y2="{40+7*30+22}" stroke="var(--link-busy)" stroke-width="5.5"/>
      <text x="470" y="{40+7*30+26}" style="{_TM}">PULSES</text>
      <text x="540" y="{40+7*30+26}" style="{_TS}">0.3 + 1.6·log10(1 + rate) per s, ≤ 5</text>"""
    return _svg(body, 760, 300,
        "Warm colours mean trouble and nothing else; volume is a cool blue ramp. Request data, where it exists, decides "
        "before the callee's status does. The same edgeAppearance() colours the 2D canvas, the 3D scene and the inspector.")


def diagram_journey():
    steps = [
        ("target", "/proc/<pid>/net/tcp(6)\n/proc/<pid>/net/dev", "var(--muted)"),
        ("MetricCollector", "decode · orient · connKey\nparseNetDev · rates", "var(--sig)"),
        ("Endpoint\nDiscoveryEngine", "translateMetricsTo-\nEnvelope()", "var(--sig)"),
        ("GraphStore", "normalizeId · ingest\nactivity · connections", "var(--ok)"),
        ("index.ts cycle", "incidents → risk\n→ requestBroadcast", "var(--warn)"),
        ("useGraphData", "ws frame · reuse\nunchanged objects", "var(--t2)"),
        ("DependencyEdge\n/ Edge3D", "edgeAppearance · weight\nlinkFlow → pulses", "var(--t2)"),
    ]
    body = ""
    w, gap = 140, 12
    for i, (name, sub, colour) in enumerate(steps):
        x = 10 + i * (w + gap)
        body += f"""
      <rect x="{x}" y="30" width="{w}" height="98" rx="8" fill="var(--panel)" stroke="{colour}" stroke-width="1.5"/>
      <text x="{x+w/2}" y="50" text-anchor="middle" style="{_TM}">{i+1}</text>"""
        for k, part in enumerate(name.split("\n")):
            body += f'\n      <text x="{x+w/2}" y="{68 + k*14}" text-anchor="middle" style="font-family:var(--body);font-size:11px;font-weight:600;fill:var(--ink)">{part}</text>'
        for k, part in enumerate(sub.split("\n")):
            body += f'\n      <text x="{x+w/2}" y="{100 + k*13}" text-anchor="middle" style="font-family:var(--body);font-size:9.5px;fill:var(--muted)">{html.escape(part)}</text>'
        if i < len(steps) - 1:
            body += f'\n      <line x1="{x+w}" y1="79" x2="{x+w+gap-1}" y2="79" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#ar)"/>'
    body += f"""
      <text x="10" y="156" style="{_TS}">SSH · every 5 s after the last sweep</text>
      <text x="530" y="156" text-anchor="middle" style="{_TS}">≤ 1 graph-update every 3 s</text>
      <text x="1062" y="156" text-anchor="end" style="{_TS}">pixels</text>"""
    return _svg(body, 1074, 168,
        "One socket on the target becomes a pulse of light in seven hops. The table below lists all fourteen steps with "
        "the function that does each one.")


def diagram_rca():
    cands = [
        ("orders-db", [("first", 0.30, "var(--sig)"), ("down", 0.35, "var(--err)"), ("observed", 0.20, "var(--t2)"), ("explains 2/2", 0.15, "var(--ok)")], 1.00, "HIGH"),
        ("orders", [("anomaly", 0.10, "var(--sig)"), ("degraded", 0.15, "var(--warn)"), ("observed", 0.20, "var(--t2)"), ("explains 1/2", 0.08, "var(--ok)")], 0.34, "LOW"),
        ("frontend", [("anomaly", 0.10, "var(--sig)"), ("degraded", 0.15, "var(--warn)"), ("observed", 0.20, "var(--t2)")], 0.30, "LOW"),
    ]
    penalties = {"orders": 0.19, "frontend": 0.15}
    scale = 420
    x0 = 150
    body = f'<line x1="{x0}" y1="20" x2="{x0}" y2="200" stroke="var(--rule)"/>'
    for i, (name, parts, score, conf) in enumerate(cands):
        y = 34 + i * 60
        body += f'\n      <text x="{x0-12}" y="{y+16}" text-anchor="end" style="{_T}">{name}</text>'
        x = x0
        for label, v, colour in parts:
            wpx = v * scale
            body += f"""
      <rect x="{x:.0f}" y="{y}" width="{wpx:.0f}" height="22" fill="{colour}" fill-opacity="0.8"/>
      <text x="{x + wpx/2:.0f}" y="{y+36}" text-anchor="middle" style="font-family:var(--body);font-size:10px;fill:var(--muted)">{label}</text>"""
            x += wpx
        if name in penalties:
            pw = penalties[name] * scale
            body += f"""
      <rect x="{x - pw:.0f}" y="{y}" width="{pw:.0f}" height="22" fill="none" stroke="var(--err)" stroke-width="1.6" stroke-dasharray="4 3"/>
      <text x="{x + 6:.0f}" y="{y+15}" style="font-family:var(--mono);font-size:10.5px;fill:var(--err)">−{penalties[name]:.2f} victim</text>"""
        body += f'\n      <text x="740" y="{y+16}" text-anchor="end" style="{_TM}">{score:.2f} {conf}</text>'
    body += f'\n      <line x1="{x0 + scale:.0f}" y1="22" x2="{x0 + scale:.0f}" y2="200" stroke="var(--muted)" stroke-dasharray="2 3"/><text x="{x0+scale:.0f}" y="214" text-anchor="middle" style="{_TS}">1.0 (clamp)</text>'
    return _svg(body, 760, 224,
        "The worked example as the engine scored it. Each bar is a named factor, and the dashed box is the victim "
        "penalty taken back off. It is what keeps orders, which sits in the middle of everything, from looking like the origin.")


def diagram_cascade():
    nodes = [("frontend", 60, "0.316", "low", "var(--warn)"), ("orders", 300, "0.753", "high", "var(--err)"), ("orders-db", 540, "1.000", "high", "var(--err)")]
    body = ""
    for name, x, p, band, colour in nodes:
        body += f"""
      <rect x="{x}" y="40" width="150" height="62" rx="9" fill="var(--panel)" stroke="{colour}" stroke-width="1.8"/>
      <text x="{x+75}" y="64" text-anchor="middle" style="{_T}">{name}</text>
      <text x="{x+75}" y="86" text-anchor="middle" style="{_TM}">P = {p} · {band}</text>"""
    body += f"""
      <line x1="210" y1="70" x2="298" y2="70" stroke="var(--muted)" stroke-width="1.6" marker-end="url(#ar)"/>
      <text x="254" y="60" text-anchor="middle" style="{_TM}">w 0.60</text>
      <line x1="450" y1="70" x2="538" y2="70" stroke="var(--muted)" stroke-width="1.6" marker-end="url(#ar)"/>
      <text x="494" y="60" text-anchor="middle" style="{_TM}">w 0.75</text>
      <path d="M538 116 H 452" stroke="var(--err)" stroke-width="1.8" stroke-dasharray="5 3" marker-end="url(#are)"/>
      <path d="M298 116 H 212" stroke="var(--err)" stroke-width="1.8" stroke-dasharray="5 3" marker-end="url(#are)"/>
      <text x="495" y="134" text-anchor="middle" style="{_TS}">0.7 × 0.75 × 1.0</text>
      <text x="255" y="134" text-anchor="middle" style="{_TS}">0.7 × 0.60 × 0.753</text>
      <text x="375" y="166" text-anchor="middle" style="{_TM}">P(n) = 1 − (1 − p0(n)) × Π (1 − τ · w · P(callee))     τ = 0.7</text>
      <text x="375" y="188" text-anchor="middle" style="{_TS}">orders: p0 0.48 (persistent anomaly 0.6 × 0.8) → 1 − 0.52 × 0.475 = 0.753 · frontend is "at risk": fine on its own, P ≥ 0.15</text>
    """
    return _svg(body, 760, 204,
        "Calls go left to right, and risk flows right to left, scaled at each hop by how much the caller relies on the callee and by τ. "
        "These are the real engine's numbers for the worked example. They are estimates under a stated model, not observed frequencies.")


def _two(*fns):
    return lambda: "".join(f() for f in fns)


CHAPTER_DIAGRAMS = {
    "wiki-01-overview": diagram_overview,
    "wiki-02-architecture": diagram_layers,
    "wiki-18-telemetry-tiers-plan": diagram_tiers,
    "wiki-06-node-edge-lifecycle": diagram_direction,
    "wiki-22-risk-engine": _two(diagram_cascade, diagram_blast),
    "wiki-17-findings-vs-incidents": diagram_two_opinions,
    "wiki-11-ml-pipeline": diagram_ml,
    "wiki-29-design-principles": diagram_confidence,
    "wiki-30-tech-stack": diagram_stack,
    "wiki-31-measurement-precision": diagram_sweep,
    "wiki-32-accuracy-and-self-check": diagram_verify,
    "wiki-33-visual-language": diagram_link_legend,
    "wiki-34-code-tour": diagram_journey,
    "wiki-08-rca-engine": diagram_rca,
}

def get_chapter_diagram(doc_id):
    fn = CHAPTER_DIAGRAMS.get(doc_id)
    return fn() if fn else ""

def chapter_list():
    """The readable chapters, in order — everything except the contents page."""
    return [d for d in DOCS_CONFIG if d.get("part")]

def chapter_number(doc_id):
    for i, d in enumerate(chapter_list(), start=1):
        if d["id"] == doc_id:
            return i
    return None

def part_for(num):
    for pt in PARTS:
        if pt["num"] == num:
            return pt
    return None

def build_chapter_header(doc_info):
    """
    Where you are in the book, what this chapter covers, and the picture.

    The point of this block is that a chapter can be opened cold: you can see
    which part it belongs to, how far through you are, and what you are about
    to learn, without having read the previous one.
    """
    num = chapter_number(doc_info["id"])
    if num is None:
        return ""
    total = len(chapter_list())
    pt = part_for(doc_info["part"])
    part_label = f'Part {pt["num"]} &middot; {escape_html(pt["title"])}' if pt else ""

    learn = doc_info.get("learn") or []
    learn_html = ""
    if learn:
        items = "".join(f"<li>{escape_html(x)}</li>" for x in learn)
        learn_html = f"""
        <div class="chapter-learn">
          <div class="chapter-learn-title">In this chapter</div>
          <ul>{items}</ul>
        </div>"""

    return f"""
    <div class="chapter-rail">
      <span class="chapter-part">{part_label}</span>
      <span class="chapter-count">Chapter {num} of {total}</span>
    </div>
    {learn_html}
    {get_chapter_diagram(doc_info["id"])}
    """

def slugify(text):
    text = re.sub(r'[^\w\s-]', '', text).strip().lower()
    return re.sub(r'[\s_-]+', '-', text)

def escape_html(text):
    return html.escape(str(text))

def build_quick_jump_select(current_id):
    groups = {}
    for doc in DOCS_CONFIG:
        cat = doc["category"]
        if cat not in groups:
            groups[cat] = []
        groups[cat].append(doc)
        
    out = ['<select id="quick-jump" class="tbtn quick-jump-select" title="Jump to a chapter">']
    out.append('<option value="" disabled>Jump to a chapter…</option>')
    for cat, docs in groups.items():
        out.append(f'<optgroup label="{escape_html(cat)}">')
        for d in docs:
            sel = ' selected' if d["id"] == current_id else ''
            title = d["title"]
            if len(title) > 36:
                title = title[:34] + "..."
            out.append(f'<option value="{d["filename"]}"{sel}>{escape_html(title)}</option>')
        out.append('</optgroup>')
    out.append('</select>')
    return "\n".join(out)

def build_top_bar(doc_info, current_index):
    jump_select = build_quick_jump_select(doc_info["id"] if doc_info else "index")
    crumb_cat = escape_html(doc_info["category"]) if doc_info else ""
    crumb_title = escape_html(doc_info["title"] if doc_info else "Contents")
    middle = f"<span>/</span><span>{crumb_cat}</span>" if doc_info else ""
    return f"""
    <div class="topbar">
      <div class="crumbs"><a href="index.html">Microservice Mapper</a>{middle}<span>/</span><b>{crumb_title}</b></div>
      <div class="tools">
        <button class="tbtn search-btn" data-open-search type="button"><span>Search the book</span><kbd>Ctrl K</kbd></button>
        {jump_select}
        <button id="theme-toggle-btn" class="tbtn" type="button">Theme</button>
        <a href="architecture-map.html" class="tbtn">Map</a>
        <a href="index.html" class="tbtn">Contents</a>
      </div>
    </div>
    """

def extract_toc_pills(md_text):
    lines = md_text.splitlines()
    pills = []
    for line in lines:
        m = re.match(r"^(#{2,3})\s+(.+)", line)
        if m:
            raw_title = m.group(2).strip()
            clean_title = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', raw_title)
            clean_title = re.sub(r'[*`_]', '', clean_title)
            tag_id = slugify(raw_title)
            
            pill_text = clean_title
            if "—" in pill_text:
                pill_text = pill_text.split("—")[-1].strip()
            if len(pill_text) > 28:
                pill_text = pill_text[:26] + "..."
            pills.append(f'<a href="#{tag_id}">{escape_html(pill_text)}</a>')
            if len(pills) >= 12:
                break
    
    if not pills:
        return ""
    return '<nav class="toc">\n  ' + "\n  ".join(pills) + '\n</nav>'

FLOW_LAYERS = [
    {
        "title": "1 · The target: read, never written",
        "badge": ("SSH :22 · NOTHING INSTALLED", "cyan"),
        "colour": "var(--muted)",
        "arrow": "read-only commands over one SSH connection",
        "nodes": [
            ("Docker host", "Any machine you can SSH to. Containers stay unmodified.", "21-connection-layer.html", "TARGET", "blue", "telemetry"),
            ("docker ps · inspect · stats", "What exists, its limits, its CPU and memory, its state.", "23-endpoint-discovery.html", "TIER 0", "green", "telemetry,rca"),
            ("/proc/&lt;pid&gt;/net/tcp(6) · net/dev", "Sockets (who calls whom) and exact byte counters, in one exec per container.", "31-measurement-precision.html", "TIER 0", "green", "telemetry"),
            ("Gateway log · Prometheus", "Per-request latency and errors, where a gateway logs them (Tier 1) or Prometheus is enabled (Tier 2, opt-in).", "18-telemetry-tiers-plan.html", "TIER 1–2", "orange", "telemetry"),
        ],
    },
    {
        "title": "2 · Collection, on your machine",
        "badge": ("POLL · SWEEP · REDISCOVER", "blue"),
        "colour": "var(--sig)",
        "arrow": "TelemetryEnvelope → GraphStore.ingestRemote()",
        "nodes": [
            ("ConnectionManager", "One ssh2 connection per target, many exec channels, recovery when a host goes quiet.", "21-connection-layer.html", "ssh2", "cyan", "telemetry"),
            ("EndpointDiscoveryEngine", "Poll and sweep loops that wait for themselves (5 s after finishing); rediscovery every 180 s.", "23-endpoint-discovery.html", "LOOPS", "blue", "telemetry"),
            ("MetricCollector", "Decodes sockets (IPv4-mapped too), orients by LISTEN port, keys each connection, reads net/dev, CPU allowance.", "31-measurement-precision.html", "PRECISION", "green", "telemetry"),
            ("Optional push collector", "An agent you may choose to run; posts to /api/ingest, the same door the ground-truth simulator uses.", "07-remote-collector.html", "OPTIONAL", "orange", "telemetry"),
        ],
    },
    {
        "title": "3 · The model",
        "badge": ("IN MEMORY · JSON SNAPSHOT", "green"),
        "colour": "var(--ok)",
        "arrow": "every 5 s: incidents → risk → broadcast",
        "nodes": [
            ("GraphStore", "Nodes, edges, activity and baselines, distinct open and new connections, anomaly scores merged in.", "03-graphstore.html", "CORE", "cyan", "telemetry,rca,ml"),
            ("Identity", "Every id is project:name, everywhere: graph, incidents, cascade fields.", "04-id-system.html", "IDS", "red", "telemetry,rca"),
            ("Ingestion", "Envelope → nodes, edges, evidence; declared and observed merged on one edge.", "05-telemetry-ingestion.html", "INGEST", "green", "telemetry"),
            ("Lifecycle and direction", "Ageing and pruning; the listening end is the callee.", "06-node-edge-lifecycle.html", "DIRECTION", "orange", "telemetry,rca"),
        ],
    },
    {
        "title": "4 · Judgement",
        "badge": ("RULES ≠ MODELS", "red"),
        "colour": "var(--err)",
        "arrow": "graph-update (≤ 1 per 3 s) · incident.updated (on visible change)",
        "nodes": [
            ("Incidents and RCA", "Rule-based symptoms with remembered onsets; five named factors, materiality, victim penalty.", "08-rca-engine.html", "RULES", "red", "rca"),
            ("Risk and cascades", "Weights → health and risk → noisy-OR cascade (τ = 0.7), what-if, blast radius.", "22-risk-engine.html", "MODEL", "orange", "rca"),
            ("ML ensemble", "Four detectors per service, majority vote, median score, persistence. Findings only.", "11-ml-pipeline.html", "PYTHON", "purple", "ml"),
            ("Consistency check", "Twelve invariants over everything published; /api/diagnostics/consistency.", "32-accuracy-and-self-check.html", "SELF-CHECK", "green", "rca,ml,telemetry"),
        ],
    },
    {
        "title": "5 · What you see",
        "badge": ("REACT 19 · VITE :5173", "purple"),
        "colour": "var(--t2)",
        "arrow": None,
        "nodes": [
            ("Live data hook", "One WebSocket; unchanged nodes and edges reused, so React redraws only what moved.", "24-client-frontend.html", "WS", "green", "telemetry,rca"),
            ("2D architecture", "XYFlow: flat cards, links coloured by trouble, width by reliance, pulses by rate.", "33-visual-language.html", "XYFLOW", "cyan", "telemetry,rca"),
            ("3D islands", "react-three-fiber: a district per project, a platform per role, the same link language.", "33-visual-language.html", "R3F", "purple", "telemetry"),
            ("Traffic generator :4400", "Drives real workflows so there is something to observe.", "20-traffic-experiments.html", "LOAD", "orange", "telemetry"),
        ],
    },
]


def build_master_architecture_flowchart_html():
    """
    The whole system on one page, every box linked to the chapter that covers it.

    Built from FLOW_LAYERS so the content stays in one checkable place. An
    earlier hand-written version described things this system does not do
    (a reverse SSH tunnel, betweenness centrality, "sub-second deltas").
    """
    layers = []
    for i, layer in enumerate(FLOW_LAYERS):
        cards = []
        for name, desc, href, badge, colour, tags in layer["nodes"]:
            chapter = href[:-5]
            cards.append(f"""
                <a href="{href}" class="flow-node-card flow-node" data-tags="{tags}">
                    <div class="flow-node-header">
                        <span class="flow-node-name">{name}</span>
                        <span class="badge badge-{colour}">{badge}</span>
                    </div>
                    <div class="flow-node-desc">{desc}</div>
                    <div class="flow-node-footer"><span>{chapter}</span><span>Open &rarr;</span></div>
                </a>""")
        label, bcol = layer["badge"]
        layers.append(f"""
        <div class="flow-layer" style="border-left: 3px solid {layer['colour']};">
            <div class="flow-layer-title"><span>{layer['title']}</span><span class="badge badge-{bcol}">{label}</span></div>
            <div class="flow-node-grid">{''.join(cards)}</div>
        </div>""")
        if layer["arrow"]:
            layers.append(f'<div class="flow-arrow-down">&darr; {layer["arrow"]} &darr;</div>')

    return f"""
    <div class="flow-container">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.2rem; flex-wrap: wrap; gap: 10px;">
            <div>
                <h3 style="margin: 0; color: var(--ink); font-size: 1.05rem;">End-to-end, top to bottom</h3>
                <p style="margin: 0; font-size: 0.85rem; color: var(--muted);">Trace a path to highlight the boxes it passes through. Every box opens its chapter.</p>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="lab-btn flow-trace-btn" data-flow="TELEMETRY" style="font-size: 11px; padding: 4px 10px;">A measurement</button>
                <button class="lab-btn flow-trace-btn" data-flow="RCA" style="font-size: 11px; padding: 4px 10px; background: var(--err); color: #fff;">A failure</button>
                <button class="lab-btn flow-trace-btn" data-flow="ML" style="font-size: 11px; padding: 4px 10px; background: #a26be0; color: #fff;">An ML finding</button>
                <button class="lab-btn flow-trace-btn" data-flow="RESET" style="font-size: 11px; padding: 4px 10px; background: var(--panel-2); color: var(--ink-2); border: 1px solid var(--rule);">Show all</button>
            </div>
        </div>
        {''.join(layers)}
    </div>
    """


def _md_link_target(url):
    """Map a markdown link to the page this book publishes it as.

    Links in the wiki point at sources (`08-rca-engine.md`, `./31-...md`,
    `wiki/22-risk-engine.md`, `../README.md`); the book publishes those under
    other names (readme.html, ...). Anything not in the book is left alone.
    """
    if url.startswith(("http://", "https://", "#", "mailto:")):
        return url
    path, _, anchor = url.partition("#")
    if path.rstrip("/").split("/")[-1] in ("wiki", "wiki visualizer"):
        return "index.html"          # the wiki folder itself is this book
    if not path.endswith(".md"):
        return url
    base = path.split("/")[-1]
    target = None
    for d in DOCS_CONFIG:
        src = d.get("source")
        if src and src.split("/")[-1] == base and (src.startswith("wiki/") or "/" not in path or path.endswith(src)):
            target = d["filename"]
            break
    if target is None:
        target = base[:-3] + ".html"
    return target + ("#" + anchor if anchor else "")


def process_inline(text):
    """Inline markdown: code, bold, emphasis, links. Everything else is escaped.

    Code spans are lifted out first so their contents are escaped verbatim and
    never touched by the emphasis rules (`a * b` stays `a * b`). Escaped pipes
    (`\\|`, needed inside table cells) become plain pipes.
    """
    spans = []

    def keep(m):
        body = m.group(1).replace("\\|", "|")
        # A hex colour gets a swatch, so a legend can be read at a glance.
        swatch = f'<span class="sw" style="background:{body}"></span>' if re.fullmatch(r"#[0-9a-fA-F]{6}", body) else ""
        spans.append(swatch + "<code>" + html.escape(body, quote=False) + "</code>")
        return f"\x00{len(spans) - 1}\x00"

    text = re.sub(r"`([^`]+)`", keep, text)
    text = html.escape(text, quote=False).replace("\\|", "|")
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{_md_link_target(m.group(2))}">{m.group(1)}</a>', text)
    return re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], text)


def _split_row(line):
    cells = re.split(r"(?<!\\)\|", line.strip())
    if cells and cells[0].strip() == "":
        cells = cells[1:]
    if cells and cells[-1].strip() == "":
        cells = cells[:-1]
    return [c.strip() for c in cells]


def render_table(table_lines):
    if not table_lines:
        return ""
    headers = _split_row(table_lines[0])
    rows = []
    for line in table_lines[1:]:
        if re.match(r'^[\|\s\-:+]+$', line.strip()):
            continue
        cols = _split_row(line)
        if cols:
            rows.append(cols)

    out = ['<div class="scroll"><table class="t">', '  <thead><tr>']
    for h in headers:
        out.append(f'    <th>{process_inline(h)}</th>')
    out.append('  </tr></thead>')
    out.append('  <tbody>')
    for row in rows:
        # A row whose only non-empty cell is the first, in bold, is a section
        # divider (the README's table uses them); span it across the table.
        if len(row) >= 2 and row[0].startswith("**") and all(c == "" for c in row[1:]):
            out.append(f'    <tr class="sect"><td colspan="{len(headers)}">{process_inline(row[0])}</td></tr>')
            continue
        out.append('    <tr>')
        for col in row:
            out.append(f'      <td>{process_inline(col)}</td>')
        out.append('    </tr>')
    out.append('  </tbody>')
    out.append('</table></div>')
    return "\n".join(out)


def markdown_to_html(md_text, base_filename=""):
    """A small markdown renderer for this wiki.

    Consecutive text lines form one paragraph (they used to become one
    paragraph each, which broke every wrapped sentence apart). The page's
    first H1 is dropped: the chapter header above it already carries the
    title. Indented lines under a list item continue that item.
    """
    lines = md_text.splitlines()
    output = []

    in_code = False
    code_lang = ""
    code_lines = []
    table_lines = []
    blockquote_lines = []
    para_lines = []
    in_list = False
    list_type = "ul"
    seen_h1 = False

    def flush_para():
        nonlocal para_lines
        if para_lines:
            output.append(f'<p>{process_inline(" ".join(l.strip() for l in para_lines))}</p>')
            para_lines = []

    def flush_blockquote():
        nonlocal blockquote_lines
        if not blockquote_lines:
            return
        content = " ".join(l for l in blockquote_lines).strip()
        box_class = "box why"
        label = ""
        for tag, cls, lab in (("[!NOTE]", "why", "Note"), ("[!TIP]", "perf", "Tip"),
                              ("[!WARNING]", "trap", "Warning"), ("[!IMPORTANT]", "trap", "Important"),
                              ("[!CAUTION]", "trap", "Caution")):
            if content.startswith(tag):
                box_class = "box " + cls
                label = lab
                content = content[len(tag):].strip()
                break
        title = f"<h4>{label}</h4>" if label else ""
        output.append(f'<div class="{box_class}">{title}<p>{process_inline(content)}</p></div>')
        blockquote_lines = []

    def flush_table():
        nonlocal table_lines
        if table_lines:
            output.append(render_table(table_lines))
            table_lines = []

    def flush_list():
        nonlocal in_list
        if in_list:
            output.append(f"</{list_type}>")
            in_list = False

    def flush_all():
        flush_para()
        flush_blockquote()
        flush_table()
        flush_list()

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("```"):
            if in_code:
                code_content = "\n".join(code_lines)
                lang = code_lang.lower()
                drawn = any(sym in code_content for sym in ("┌", "└", "│", "├", "─", "──►", "▼", "▲", "-->"))
                if lang == "mermaid":
                    output.append(f'<figure><div class="fx" style="margin:18px 0;overflow:auto"><pre class="mermaid">{html.escape(code_content)}</pre></div></figure>')
                elif lang == "math":
                    output.append(f'<div class="panel" style="margin: 18px 0; font-family: var(--mono);">{html.escape(code_content)}</div>')
                elif drawn and lang in ("", "text", "txt"):
                    output.append(f'''<figure><div class="fx" style="margin: 18px 0;">
                        <pre style="margin: 0; background: transparent; border: none; padding: 0; font-size: 12px; line-height: 1.5;">{html.escape(code_content)}</pre>
                    </div></figure>''')
                else:
                    # No auto-generated "plain English" summary next to code:
                    # a keyword-matched summary was often confidently wrong
                    # about this codebase. Prose belongs in the markdown.
                    lang_label = code_lang.upper() if code_lang else "TEXT"
                    output.append(f'''<div class="code-wrapper" style="position:relative; margin: 16px 0 8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--panel-2); padding:6px 12px; border:1px solid var(--rule); border-bottom:none; border-radius:8px 8px 0 0; font-family:var(--mono); font-size:11px; color:var(--muted);">
                            <span>{lang_label}</span>
                        </div>
                        <pre style="border-radius:0 0 8px 8px; margin-top:0;"><code class="language-{html.escape(code_lang)}">{html.escape(code_content)}</code></pre>
                    </div>''')
                in_code = False
                code_lines = []
                code_lang = ""
            else:
                flush_all()
                in_code = True
                code_lang = stripped[3:].strip()
                code_lines = []
            continue

        if in_code:
            code_lines.append(line)
            continue

        if stripped.startswith("|"):
            flush_para()
            flush_blockquote()
            flush_list()
            table_lines.append(line)
            continue
        flush_table()

        if stripped.startswith(">"):
            flush_para()
            flush_list()
            blockquote_lines.append(stripped[1:].strip())
            continue
        flush_blockquote()

        if not stripped:
            flush_para()
            continue

        list_match = re.match(r"^(\s*)([-*+]|\d+\.)\s+(.+)$", line)
        if list_match and not re.match(r"^(\s*)(\*\*|---|\*\*\*)", line):
            flush_para()
            target_list = "ol" if list_match.group(2)[0].isdigit() else "ul"
            if not in_list or list_type != target_list:
                flush_list()
                output.append(f"<{target_list}>")
                in_list = True
                list_type = target_list
            output.append(f"  <li>{process_inline(list_match.group(3))}</li>")
            continue
        if in_list and line.startswith(("  ", "\t")) and output and output[-1].endswith("</li>"):
            output[-1] = output[-1][:-5] + " " + process_inline(stripped) + "</li>"
            continue
        flush_list()

        h_match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if h_match:
            flush_para()
            level = len(h_match.group(1))
            heading_text = h_match.group(2).strip()
            heading_id = slugify(heading_text)
            clean_text = process_inline(heading_text)
            if level == 1:
                if not seen_h1:
                    seen_h1 = True
                    continue
                output.append(f'<h2 id="{heading_id}">{clean_text}</h2>')
            elif level == 2:
                num_match = re.match(r"^(\d+(?:\.\d+)?)\.?\s*[-—–.]?\s+(.+)$", heading_text)
                if num_match:
                    output.append(f'<h2 id="{heading_id}"><span class="id">{num_match.group(1)}</span> {process_inline(num_match.group(2))}</h2>')
                else:
                    output.append(f'<h2 id="{heading_id}">{clean_text}</h2>')
            else:
                tag = f"h{min(level, 5)}"
                output.append(f'<{tag} id="{heading_id}">{clean_text}</{tag}>')
            continue

        if re.match(r"^(-{3,}|\*{3,})$", stripped):
            flush_para()
            output.append('<hr class="rule">')
            continue

        para_lines.append(line)

    flush_all()
    return "\n".join(output)


def _field(fid, label, value="", options=None, placeholder=""):
    if options:
        opts = "".join(
            f'<option value="{html.escape(v)}"{" selected" if v == value else ""}>{html.escape(t)}</option>'
            for v, t in options
        )
        ctl = f'<select id="{fid}">{opts}</select>'
    else:
        ctl = (f'<input type="text" id="{fid}" value="{html.escape(str(value))}" '
               f'placeholder="{html.escape(placeholder)}" autocomplete="off" spellcheck="false">')
    return f'<div class="lab-field"><label for="{fid}">{html.escape(label)}</label>{ctl}</div>'


def _grid(*fields):
    return '<div class="lab-grid">' + "".join(fields) + '</div>'


def _lab(fn, title, source, intro, body, note=""):
    """One interactive lab. `fn` names the JS function that recomputes it on
    every edit; the generic hook in JS_SCRIPTS wires it up and runs it once."""
    note_html = f'<p class="lab-note">{note}</p>' if note else ""
    return f"""
        <div class="interactive-lab" data-lab="{fn}">
            <div class="lab-title">{title}</div>
            <div class="lab-src">mirrors {source}</div>
            <p class="lab-note" style="color: var(--ink-2);">{intro}</p>
            {body}
            <div class="lab-output" id="{fn}-out"></div>
            {note_html}
        </div>"""


STATUS_OPTS = [("healthy", "healthy"), ("degraded", "degraded"), ("critical", "critical"), ("unknown", "unknown")]


def get_page_interactive_lab(doc_id):
    """
    Interactive sandboxes for specific chapters.

    Every lab re-implements a function that exists in this repository, with
    the same constants and the same branch order, and names the file it
    mirrors. Each opens on the chapter's worked example and recomputes as you
    type. An earlier version shipped labs for formulas the system never ran
    (an exponential heat decay, an RCA score on error-rate z-scores); a lab
    that disagrees with its source teaches something false, so when a
    constant changes in the code, the lab here changes in the same commit.
    """
    if doc_id == "wiki-04-id-system":
        return _lab(
            "labCanonicalId", "Canonical id", "<code>normalizeId()</code> in <code>server/graph/GraphStore.ts</code>",
            "Every node and edge id arriving from a collector is normalised: a leading target prefix is stripped if "
            "present, then the target id is prefixed. Ingesting the same service twice therefore cannot create two nodes.",
            _grid(_field("canon-input", "Raw id from the collector", "sock-shop-orders"),
                  _field("canon-target", "Target id", "sock-shop")),
            "It does not lowercase and does not strip compose suffixes like <code>_1</code>. "
            "<code>external</code> and <code>unknown-upstream</code> pass through untouched.",
        )

    if doc_id == "wiki-08-rca-engine":
        return _lab(
            "labRca", "Score a root-cause candidate", "the candidate loop in <code>server/rca/RCAEngine.ts</code>",
            "A sum of named factors, clamped to 0&ndash;1. It opens on <code>orders-db</code> from the worked example: "
            "first, down, observed, and both other affected services depend on it (reach 0.75 and 0.45, average 0.6).",
            _grid(
                _field("rca-time", "Timing", "earliest", [("earliest", "earliest anomaly (+0.30)"), ("anomaly", "has an anomaly (+0.10)"), ("none", "no anomaly")]),
                _field("rca-status", "Container", "critical", [("critical", "down / crash-looping (+0.35)"), ("degraded", "degraded (+0.15)"), ("none", "healthy")]),
                _field("rca-evidence", "Its edges", "observed", [("observed", "observed traffic (+0.20)"), ("declared", "declared only (+0.05)"), ("none", "none")]),
            ) + _grid(
                _field("rca-others", "Other symptomatic services", "2"),
                _field("rca-explained", "…that depend on it", "2"),
                _field("rca-reach", "Their avg. path strength", "0.6"),
                _field("rca-victim", "Weighted share of its callees failing", "0"),
            ),
            "Paths weaker than <code>MATERIAL_REACH</code> = 0.1 explain nothing. Try <code>orders</code>: anomaly, degraded, observed, "
            "2 others, 1 depends on it at 0.6, callees failing 0.75 &rarr; 0.34 LOW. The lab gives every explained service the same path "
            "strength; the engine uses each one's own.",
        )

    if doc_id == "wiki-22-risk-engine":
        health = _lab(
            "labHealth", "Health and risk", "<code>computeHealth()</code> and <code>computeProjectRisk()</code> in <code>server/graph/RiskEngine.ts</code>",
            "Health is a weighted average that <strong>drops</strong> a factor with no data and renormalises the rest, so the "
            "breakdown always sums to the score. Risk is half (1 &minus; health), half criticality: current exposure, not a probability.",
            _grid(
                _field("risk-status", "Status (w .60)", "healthy", [("healthy", "healthy → 1.0"), ("degraded", "degraded → 0.5"), ("critical", "critical → 0.0"), ("unknown", "unknown → 0.5")]),
                _field("risk-anomaly", "ML anomaly score (w .25)", "0.6", placeholder="0–1, blank = no model"),
                _field("risk-incident", "Open incident (w .15)", "none", [("none", "not in one → 1.0"), ("affected", "affected → 0.3"), ("root", "root cause → 0.0")]),
                _field("risk-crit", "Criticality", "0.92", placeholder="0–1, blank = null"),
            ),
            "Opens on <code>orders</code> from the worked example (health 0.85, risk 0.54). Clear the anomaly score to watch .60/.15 become .80/.20.",
        )
        cascade = _lab(
            "labCascade", "One step of the cascade model", "<code>intrinsicProbability()</code> and <code>solve()</code> in <code>server/graph/CascadeEngine.ts</code>",
            "P = 1 &minus; (1 &minus; p0) &times; &Pi; (1 &minus; &tau; &middot; w &middot; P(callee)). Opens on <code>orders</code>: a persistent anomaly "
            "of 0.6 (p0 = 0.48), calling a failed <code>orders-db</code> at weight 0.75 &rarr; P = 0.753.",
            _grid(
                _field("cas-status", "Its status", "healthy", STATUS_OPTS),
                _field("cas-anom", "Anomaly score", "0.6", placeholder="0–1, blank = none"),
                _field("cas-persist", "Persistent?", "yes", [("yes", "yes (× 0.8)"), ("no", "single window (× 0.3)")]),
                _field("cas-tau", "τ (transmission)", "0.7"),
            ) + _grid(
                _field("cas-w1", "Callee A: edge weight", "0.75"),
                _field("cas-p1", "Callee A: its P", "1"),
                _field("cas-w2", "Callee B: edge weight", "0.25"),
                _field("cas-p2", "Callee B: its P", "0"),
            ),
            "The engine iterates this to a fixed point over the whole project, so callees' P already includes their own inherited risk. "
            "<code>via</code> is shown when inherited &ge; 0.15 or exceeds the service's own p0.",
        )
        return health + cascade

    if doc_id == "wiki-31-measurement-precision":
        cpu = _lab(
            "labCpu", "CPU against its allowance", "<code>cpuShareOfAllowance()</code> and <code>statusFromSample()</code> in <code>containerHealth.ts</code>",
            "Docker reports CPU as a percentage of <em>one</em> core. Status judges it against the cores the container may use.",
            _grid(
                _field("cpu-raw", "docker stats CPU %", "150"),
                _field("cpu-limit", "Limit (cores)", "2", placeholder="blank = no limit"),
                _field("cpu-host", "Host cores (nproc)", "8"),
                _field("cpu-mem", "Memory %", "40"),
            ),
            "Degraded above 80% of the allowance, or above 80% memory. Clear the limit to see the allowance fall back to the host's 8 cores.",
        )
        rows = []
        defaults = [("orders-db", "listen", "300", "request"), ("payment", "listen", "100", "request"),
                    ("shipping", "declared", "", "request"), ("otel-collector", "listen", "900", "telemetry")]
        ev_opts = [("listen", "observed · listen port (1.0)"), ("ephemeral", "observed · ephemeral (0.85)"),
                   ("legacy", "observed · no direction (0.7)"), ("unresolved", "observed · unresolved (0.5)"),
                   ("declared", "declared only (0.4)"), ("candidate", "candidate (0)")]
        for i, (name, ev, act, kind) in enumerate(defaults, start=1):
            rows.append(_grid(
                _field(f"sh-n{i}", f"Callee {i}", name),
                _field(f"sh-e{i}", "Evidence", ev, ev_opts),
                _field(f"sh-a{i}", "Activity baseline /min", act, placeholder="blank = unmeasured"),
                _field(f"sh-k{i}", "Kind", kind, [("request", "functional call"), ("telemetry", "telemetry (× 0.1)")]),
            ))
        shares = _lab(
            "labShares", "One caller's dependency shares", "<code>computeEdgeWeights()</code> in <code>server/graph/EdgeWeights.ts</code>",
            "Shares are split per kind and always sum to 100%: each unmeasured edge gets 1/N, the measured ones split the rest by "
            "their activity baseline. Weight = confidence &times; share (&times; 0.1 for telemetry).",
            "".join(rows),
            "The declared-only <code>shipping</code> link has no traffic figure, so it gets an even third and the measured two share the "
            "remaining two thirds. The telemetry link is in its own group: 100% of telemetry, weight 0.1.",
        )
        return cpu + shares

    if doc_id == "wiki-33-visual-language":
        return _lab(
            "labLink", "How a link is drawn", "<code>edgeAppearance()</code> (edgeHeat.ts), <code>edgeLook()</code> (DependencyEdge.tsx) and <code>linkFlow()</code> / <code>svgPulses()</code> (linkFlow.ts)",
            "Trouble outranks traffic. Leave request fields blank to see a Tier 0 link, whose colour comes from activity and the callee's status.",
            _grid(
                _field("lk-status", "Edge status", "active", [("active", "active"), ("degraded", "degraded"), ("failed", "failed")]),
                _field("lk-obs", "Evidence", "observed", [("observed", "observed"), ("declared", "declared only")]),
                _field("lk-callee", "Callee status", "healthy", STATUS_OPTS),
                _field("lk-weight", "Weight", "0.6", placeholder="blank = none yet"),
                _field("lk-kind", "Kind", "request", [("request", "functional"), ("telemetry", "telemetry")]),
            ) + _grid(
                _field("lk-err", "Error rate %", "", placeholder="blank = not measured"),
                _field("lk-lat", "p95 latency ms", "", placeholder="blank = not measured"),
                _field("lk-req", "Requests /s", "", placeholder="blank = not measured"),
                _field("lk-act", "Activity /min", "180", placeholder="blank = no rate yet"),
            ),
            "The preview runs at the computed pulse rate. Try 2% errors (orange), 1200 ms (red), or a critical callee with no request data (red).",
        )

    if doc_id == "wiki-11-ml-pipeline":
        rows = []
        defaults = [("iforest", "0.03", "-0.05", "0.02"), ("lof", "1.3", "1.0", "1.6"),
                    ("ocsvm", "0.5", "0.1", "0.4"), ("zscore", "2.1", "0.8", "2.9")]
        for name, raw, centre, thr in defaults:
            rows.append(_grid(
                _field(f"ml-{name}-raw", f"{name}: raw", raw, placeholder="blank = unusable"),
                _field(f"ml-{name}-c", "training median", centre),
                _field(f"ml-{name}-t", "threshold p99", thr),
            ))
        rows.append(_grid(_field("ml-prev", "Anomalous windows so far", "2"), _field("ml-need", "persistence_windows", "3")))
        return _lab(
            "labEnsemble", "Four detectors, one verdict", "<code>detector_score()</code> and <code>combine()</code> in <code>ml/ensemble.py</code>, persistence in <code>score.py</code>",
            "Each detector is scored against its own training distribution: r = (raw &minus; centre) / (threshold &minus; centre), score = clamp(r/2, 0, 1). "
            "The sample is anomalous when at least half the usable detectors are above their threshold, scored by the median.",
            "".join(rows),
            "Clear a raw value to drop that detector: the vote then needs half of the remaining ones.",
        )

    return ""


def build_page_nav_footer(current_index):
    prev_doc = DOCS_CONFIG[current_index - 1] if current_index > 0 else None
    next_doc = DOCS_CONFIG[current_index + 1] if current_index < len(DOCS_CONFIG) - 1 else None
    
    html_out = ['<div class="page-nav-footer">']
    if prev_doc:
        html_out.append(f'''<a href="{prev_doc["filename"]}" class="page-nav-btn prev">
            <span class="page-nav-label">← Previous Document</span>
            <span class="page-nav-title">{escape_html(prev_doc["title"])}</span>
        </a>''')
    else:
        html_out.append('<div></div>')
        
    if next_doc:
        html_out.append(f'''<a href="{next_doc["filename"]}" class="page-nav-btn next">
            <span class="page-nav-label">Next Document →</span>
            <span class="page-nav-title">{escape_html(next_doc["title"])}</span>
        </a>''')
    else:
        html_out.append('<div></div>')
        
    html_out.append('</div>')
    return "\n".join(html_out)

FOOTER = "Microservice Mapper &mdash; built from <code>wiki/*.md</code> by <code>scripts/build_wiki_visualizer.py</code>. Every formula, threshold and worked example is checked against the code."

READING_PATHS = [
    ("Understand it in ten minutes", ["wiki-01-overview", "wiki-19-how-it-all-works", "architecture-map"]),
    ("Know why it is built this way", ["wiki-29-design-principles", "wiki-30-tech-stack", "wiki-17-findings-vs-incidents"]),
    ("Trust, or check, a number", ["wiki-31-measurement-precision", "wiki-32-accuracy-and-self-check", "wiki-36-glossary"]),
    ("Follow the maths", ["wiki-03-graphstore", "wiki-08-rca-engine", "wiki-22-risk-engine", "wiki-11-ml-pipeline"]),
    ("Read the screen", ["wiki-33-visual-language", "wiki-24-client-frontend"]),
    ("Change the code", ["wiki-34-code-tour", "wiki-35-dev-workflow", "wiki-13-api-reference", "wiki-12-data-models"]),
]

KEY_FACTS = [
    ("0", "agents installed on the target; one SSH connection reads everything"),
    ("5 s", "cycle: incidents, then risk, then one broadcast"),
    ("12", "invariants checked live at /api/diagnostics/consistency"),
    ("4", "ML detectors per service, combined by majority vote"),
]


def _page(title, inner, accent="#8f9cff", scripts=""):
    return f"""<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>{title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
    <style>{CSS_STYLES}</style>
</head>
<body style="--accent: {accent};">
    <div class="wrap">
{inner}
        <footer>{FOOTER}</footer>
    </div>
    <script src="assets/search-index.js"></script>
    <script>{JS_SCRIPTS}</script>{scripts}
</body>
</html>"""


def _doc(doc_id):
    return next(d for d in DOCS_CONFIG if d["id"] == doc_id)


def generate_index_html():
    """
    The contents page: reading paths first, then the parts in order.

    Parts and numbered chapters make the order explicit, so the book can be
    read front to back or resumed anywhere; the reading paths are for
    someone who arrives with one question.
    """
    chapters = chapter_list()
    total = len(chapters)

    facts = "".join(f'<div class="stat"><div class="v">{v}</div><div class="k">{k}</div></div>' for v, k in KEY_FACTS)

    paths = []
    for title, ids in READING_PATHS:
        items = "".join(
            f'<li><a href="{_doc(i)["filename"]}">{escape_html(_doc(i)["title"])}</a> '
            f'<span style="color:var(--muted);font-size:11.5px;font-family:var(--mono);">{chapter_number(i):02d}</span></li>'
            for i in ids)
        paths.append(f'<div class="path"><h3>{escape_html(title)}</h3><ol>{items}</ol></div>')

    body = []
    n = 0
    for pt in PARTS:
        in_part = [d for d in chapters if d.get("part") == pt["num"]]
        if not in_part:
            continue
        body.append(f'<div class="part-block" style="--pa: {PART_ACCENT.get(pt["num"], "#8f9cff")};">')
        body.append(f'<div class="part-head"><span class="part-num">Part {pt["num"]}</span>'
                    f'<h2 class="part-title">{escape_html(pt["title"])}</h2></div>')
        body.append(f'<p class="part-blurb">{escape_html(pt["blurb"])}</p>')
        for d in in_part:
            n += 1
            body.append(f'<a href="{d["filename"]}" class="chapter-row">'
                        f'<span class="n">{n:02d}</span>'
                        f'<span class="t">{escape_html(d["title"])}</span>'
                        f'<span class="d">{escape_html(d["desc"])}</span></a>')
        body.append('</div>')

    first = chapters[0]
    inner = f"""
        {build_top_bar(None, 0)}
        <header class="hd hero">
            <div class="eye">Microservice Mapper</div>
            <h1>How this system works</h1>
            <p class="lead">
                Microservice Mapper watches a running Docker microservice system from the outside, over one SSH
                connection, installing nothing. From socket tables and container stats it builds a live dependency
                graph, finds the root cause when something breaks, predicts what would fail next, and draws it in 2D and 3D.
            </p>
            <p class="lead">
                {total} chapters in {len(PARTS)} parts. Read them in order, or start from the question you have below.
                Several chapters carry an interactive lab that runs the real formula with the real constants.
            </p>
            <div class="metadata-strip">
                <a href="{first["filename"]}" class="badge badge-cyan" style="text-decoration:none;">Start at chapter 1 &rarr;</a>
                <span class="meta-item">{total} chapters</span>
                <span class="meta-item">{len(PARTS)} parts</span>
                <a href="architecture-map.html" class="meta-item">the system as one map</a>
                <a href="#" class="badge badge-blue continue" data-continue hidden></a>
                <span class="meta-item"><span data-progress-count>0</span>/{total} read in this browser</span>
            </div>
        </header>

        <section class="live" id="live-system" aria-label="A live system to break">
            <div class="live-head">
                <div>
                    <div class="live-title"><span>Live</span>Break something, and watch the mapper reason about it</div>
                    <div class="live-sub">The simulator's shop, running the real cascade and root-cause arithmetic in your browser. Click a service to degrade it, again to take it down.</div>
                </div>
                <div class="live-btns">
                    <button type="button" data-scenario="db-crash">db-crash</button>
                    <button type="button" data-scenario="slow-payment">slow-payment</button>
                    <button type="button" data-scenario="crash-loop">crash-loop</button>
                    <button type="button" data-scenario="reset">reset</button>
                </div>
            </div>
            <div class="live-grid">
                <div class="ls-stage"><canvas aria-label="Services on islands, with live links"></canvas><div class="ls-tip" hidden></div></div>
                <div class="ls-panel"><div class="ls-panel-body"></div></div>
            </div>
            <div class="live-foot">Weights from <a href="31-measurement-precision.html">EdgeWeights</a> · cascade from <a href="22-risk-engine.html">CascadeEngine</a> (τ 0.7) · root cause from <a href="08-rca-engine.html">RCAEngine</a> · link colour and pulse rate from <a href="33-visual-language.html">edgeHeat and linkFlow</a>. Same constants as the server; statuses are yours.</div>
        </section>

        <div class="stat-strip">{facts}</div>

        <h2 style="border:none;margin-top:8px;">Start from a question</h2>
        <div class="paths">{''.join(paths)}</div>

        <h2 style="border:none;">The whole book</h2>
        {''.join(body)}

        <section style="margin-top: 36px;">
            <h2>The system on one page</h2>
            <p class="lead">Every process, store and engine, top to bottom, each linked to its chapter.</p>
            {build_master_architecture_flowchart_html()}
        </section>
    """
    out_file = OUTPUT_DIR / "index.html"
    out_file.write_text(_page("Microservice Mapper &mdash; how this system works", inner,
                              scripts='\n    <script src="assets/live-system.js"></script>'), encoding="utf-8")
    print(f"Generated {out_file}")


def generate_architecture_map_page():
    """The standalone map page: the flowchart and the three paths through it."""
    doc_info = _doc("architecture-map")
    idx = next(i for i, d in enumerate(DOCS_CONFIG) if d["id"] == "architecture-map")

    flows = [
        ("A measurement", "cyan", "From a socket on the target to a pulse on screen",
         "<code>/proc/&lt;pid&gt;/net/tcp</code> &rarr; <code>MetricCollector</code> (decode, orient, connKey) &rarr; "
         "<code>EndpointDiscoveryEngine</code> &rarr; <code>GraphStore.ingestRemote()</code> &rarr; <code>applyEdgeActivity()</code> &rarr; "
         "<code>RiskEngine</code> (weights) &rarr; <code>graph-update</code> &rarr; <code>useGraphData</code> &rarr; "
         "<code>edgeAppearance()</code> + <code>linkFlow()</code>",
         "34-code-tour.html", "Follow it step by step"),
        ("A failure", "red", "From an exited container to a named root cause",
         "<code>docker stats</code> / <code>ps</code> &rarr; <code>statusFromSample()</code> = critical &rarr; "
         "<code>AnomalyDetector</code> (onset kept) &rarr; <code>RCAEngine</code> (five factors, materiality, victim penalty) &rarr; "
         "<code>IncidentManager</code> &rarr; <code>incident.updated</code> &rarr; <code>RiskEngine</code> (cascade, at-risk callers)",
         "08-rca-engine.html", "Root cause, with a worked example"),
        ("An ML finding", "purple", "From history to a persistent anomaly",
         "<code>collector.py</code> &rarr; <code>preprocess.py</code> (per-service z) &rarr; <code>train.py</code> (4 detectors) &rarr; "
         "<code>score.py</code> (vote, median, persistence) &rarr; <code>latest_scores.json</code> &rarr; "
         "<code>GraphStore</code> merge &rarr; Findings, ANOMALY badge, health, cascade p0",
         "11-ml-pipeline.html", "The learning pipeline"),
    ]
    cards = "".join(f"""
                <div class="feature-card">
                    <div class="feature-card-header"><span class="badge badge-{colour}">{name}</span></div>
                    <div class="feature-card-title">{title}</div>
                    <div class="feature-card-desc">{chain}</div>
                    <div class="feature-card-footer"><a href="{href}">{link} &rarr;</a></div>
                </div>""" for name, colour, title, chain, href, link in flows)

    inner = f"""
        {build_top_bar(doc_info, idx)}
        <header class="hd">
            <div class="bignum" aria-hidden="true">{chapter_number("architecture-map")}</div>
            <div class="eye">Understanding the system</div>
            <h1>The system, as one map</h1>
            <p class="lead">{escape_html(doc_info["desc"])}</p>
        </header>
        {build_chapter_header(doc_info)}
        <section id="map">
            <h2>Top to bottom</h2>
            {build_master_architecture_flowchart_html()}
        </section>
        <section id="paths">
            <h2>Three paths through it</h2>
            <div class="grid-cards">{cards}</div>
        </section>
        {build_page_nav_footer(idx)}
    """
    out_file = OUTPUT_DIR / "architecture-map.html"
    out_file.write_text(_page("The system, as one map | Microservice Mapper", inner, accent=PART_ACCENT["I"]), encoding="utf-8")
    print(f"Generated {out_file}")


def generate_doc_page(doc_info, doc_index):
    source_path = BASE_DIR / doc_info["source"]
    if not source_path.exists():
        print(f"WARNING: Source file does not exist: {source_path}")
        return

    with open(source_path, "r", encoding="utf-8") as f:
        raw_md = f.read()

    # If it's already an HTML document like Mapper Technical Reference.html, keep it synchronized or render it
    if doc_info["source"].endswith(".html"):
        # For Mapper Technical Reference.html, it's already the golden reference
        return

    html_content = markdown_to_html(raw_md, doc_info["filename"])
    top_bar = build_top_bar(doc_info, doc_index)
    page_nav = build_page_nav_footer(doc_index)
    
    word_count = len(raw_md.split())
    read_time = max(1, round(word_count / 200))
    
    extra_interactive_lab = get_page_interactive_lab(doc_info["id"])
    toc_pills = extract_toc_pills(raw_md)
    chapter_header = build_chapter_header(doc_info)
    try_it = ""
    if extra_interactive_lab:
        # After the explanation rather than before it: the controls make sense
        # once the reader knows what they move. A pill at the top jumps here.
        try_it = f"""
        <section id="try-it">
            <h2>Try it</h2>
            <p class="lead">The lab below runs the same arithmetic as the code, with the same constants. It opens on this chapter's worked example and recomputes as you type.</p>
            {extra_interactive_lab}
        </section>"""
        if toc_pills:
            toc_pills = toc_pills.replace('<nav class="toc">\n  ', '<nav class="toc">\n  <a href="#try-it" style="color:var(--sig);border-color:var(--sig);">Try it &darr;</a>\n  ', 1)

    extra_flowchart = ""

    html_page = f"""<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>{escape_html(doc_info["title"])} | Microservice Mapper Wiki</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
    <style>{CSS_STYLES}</style>
</head>
<body style="--accent: {PART_ACCENT.get(doc_info.get("part"), "#8f9cff")};">
    <div class="wrap">
        {top_bar}

        <header class="hd">
            <div class="bignum" aria-hidden="true">{chapter_number(doc_info["id"]) or ""}</div>
            <div class="eye">{escape_html(doc_info["category"])}</div>
            <h1>{escape_html(doc_info["title"])}</h1>
            <p class="lead">{escape_html(doc_info["desc"])}</p>
            <div class="metadata-strip">
                <span class="badge badge-{doc_info["badge_color"]}">{doc_info["badge"]}</span>
                <span class="meta-item"><code>{doc_info["source"]}</code></span>
                <span class="meta-item">~{read_time} min read</span>
                <span class="meta-item">{word_count:,} words</span>
            </div>
            {toc_pills}
        </header>

        {chapter_header}

        {extra_flowchart}

        <div class="doc-layout">
            <div class="doc-main">
                <article class="doc-body">
                    {html_content}
                </article>
                {try_it}
            </div>
            <aside class="side-toc" aria-label="On this page"></aside>
        </div>

        {page_nav}

        <footer>{FOOTER}</footer>
    </div>
    <script src="assets/search-index.js"></script>
    <script>{JS_SCRIPTS}</script>
    <script type="module">
      if (document.querySelector('pre.mermaid')) {{
        const m = await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs');
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        m.default.initialize({{ startOnLoad: false, theme: dark ? 'dark' : 'neutral' }});
        await m.default.run({{ querySelector: 'pre.mermaid' }});
      }}
    </script>
</body>
</html>"""

    out_file = OUTPUT_DIR / doc_info["filename"]
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(html_page)
    print(f"Generated {out_file}")

def build_search_index():
    """Every chapter, section and glossary term, for the Ctrl+K palette.

    Written once as assets/search-index.js rather than inlined in every page.
    Section ids use the same slugify() the renderer gives the headings, so a
    hit lands on the heading itself.
    """
    entries = []
    for d in DOCS_CONFIG:
        if not d.get("part"):
            continue
        entries.append({"k": "chapter", "t": d["title"], "s": d["desc"], "u": d["filename"]})
        src = d.get("source")
        if not src or not (BASE_DIR / src).exists():
            continue
        md = (BASE_DIR / src).read_text(encoding="utf-8")
        in_code = False
        for line in md.splitlines():
            if line.strip().startswith("```"):
                in_code = not in_code
                continue
            if in_code:
                continue
            m = re.match(r"^(#{2,3})\s+(.+)$", line)
            if m:
                heading = m.group(2).strip()
                clean = re.sub(r"[*`]", "", re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", heading))
                entries.append({"k": "section", "t": clean, "s": d["title"], "u": d["filename"] + "#" + slugify(heading)})
            if d["id"] == "wiki-36-glossary" and line.startswith("| **"):
                cells = [c.strip() for c in re.split(r"(?<!\\)\|", line)[1:-1]]
                if len(cells) >= 2:
                    term = re.sub(r"[*`]", "", cells[0])
                    meaning = re.sub(r"[*`]|\[([^\]]+)\]\([^)]+\)", lambda mm: mm.group(1) or "", cells[1]).replace("\\|", "|")
                    entries.append({"k": "term", "t": term, "s": meaning, "u": d["filename"]})
    return "window.BOOK_INDEX = " + json.dumps(entries, ensure_ascii=False) + ";\n"


def write_assets():
    assets = OUTPUT_DIR / "assets"
    assets.mkdir(exist_ok=True)
    (assets / "search-index.js").write_text(build_search_index(), encoding="utf-8")
    src = Path(__file__).resolve().parent / "wiki_assets" / "live-system.js"
    (assets / "live-system.js").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Building the book into: {OUTPUT_DIR}")
    
    write_assets()
    generate_index_html()
    generate_architecture_map_page()
    
    for idx, doc in enumerate(DOCS_CONFIG):
        if doc["source"] is not None:
            generate_doc_page(doc, idx)
            
    print(f"\nBuilt {len(DOCS_CONFIG)} pages in '{OUTPUT_DIR}'.")

if __name__ == "__main__":
    main()
