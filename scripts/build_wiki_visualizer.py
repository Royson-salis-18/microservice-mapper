#!/usr/bin/env python3
"""
Microservice Mapper — Visual Wiki & Interactive Reference Generator V4
Authoritative generator compiling markdown docs, specifications, and reference guides
into high-contrast, responsive visual HTML documents matching the exact aesthetic
of 'Mapper Technical Reference.html'.
"""

import os
import re
import html
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = BASE_DIR / "wiki visualizer"

DOCS_CONFIG = [
    {
        "id": "index",
        "filename": "index.html",
        "source": None,
        "title": "Master Visual Wiki & Architecture Hub",
        "category": "1. Master Hub & Foundations",
        "badge": "MASTER HUB",
        "badge_color": "cyan",
        "desc": "The central visual hub, interactive architecture diagram, and complete system directory."
    },
    {
        "id": "architecture-map",
        "filename": "architecture-map.html",
        "source": None,
        "title": "Master Architecture Flowchart Map",
        "category": "1. Master Hub & Foundations",
        "badge": "FLOWCHART MAP",
        "badge_color": "purple",
        "desc": "Interactive end-to-end system flowchart mapping every daemon, store, and intelligence engine with direct links."
    },
    {
        "id": "wiki-19-how-it-all-works",
        "filename": "19-how-it-all-works.html",
        "source": "wiki/19-how-it-all-works.md",
        "title": "19 — How It All Works (Plain & Detailed)",
        "category": "1. Master Hub & Foundations",
        "badge": "FOUNDATION",
        "badge_color": "green",
        "desc": "Plain English and detailed technical walkthrough of the entire platform."
    },
    {
        "id": "wiki-01-overview",
        "filename": "01-overview.html",
        "source": "wiki/01-overview.md",
        "title": "01 — Overview & Design Philosophy",
        "category": "1. Master Hub & Foundations",
        "badge": "FOUNDATION",
        "badge_color": "blue",
        "desc": "Autonomous zero-instrumentation topology discovery and RCA for Docker microservices."
    },
    {
        "id": "wiki-02-architecture",
        "filename": "02-architecture.html",
        "source": "wiki/02-architecture.md",
        "title": "02 — System Layers & Data Flow",
        "category": "1. Master Hub & Foundations",
        "badge": "CORE ARCH",
        "badge_color": "cyan",
        "desc": "The 4-layer architecture: Collection, Server Processing, Intelligence, and Frontend UI."
    },
    {
        "id": "root-readme",
        "filename": "readme.html",
        "source": "README.md",
        "title": "Project README & Quickstart",
        "category": "1. Master Hub & Foundations",
        "badge": "QUICKSTART",
        "badge_color": "blue",
        "desc": "Microservice Mapper primary overview, prerequisites, target setup, and installation runbook."
    },
    {
        "id": "wiki-deep-dive",
        "filename": "wiki-deep-dive.html",
        "source": ".claude/worktrees/determined-sinoussi-ea61ea/WIKI.md",
        "title": "Complete System Wiki (30 Sections)",
        "category": "1. Master Hub & Foundations",
        "badge": "MONOLITH WIKI",
        "badge_color": "purple",
        "desc": "The comprehensive 30-section deep dive covering every subsystem, data structure, and operational detail."
    },
    {
        "id": "wiki-index-md",
        "filename": "wiki-index.html",
        "source": "wiki/README.md",
        "title": "Wiki Table of Contents",
        "category": "1. Master Hub & Foundations",
        "badge": "INDEX",
        "badge_color": "blue",
        "desc": "Numbered index and logical reading orders for developers, SREs, and architects."
    },
    {
        "id": "wiki-03-graphstore",
        "filename": "03-graphstore.html",
        "source": "wiki/03-graphstore.md",
        "title": "03 — GraphStore Central Nervous System",
        "category": "2. Core Graph Engine",
        "badge": "GRAPH ENGINE",
        "badge_color": "cyan",
        "desc": "In-memory topology graph, ring buffers, and state mutations."
    },
    {
        "id": "wiki-04-id-system",
        "filename": "04-id-system.html",
        "source": "wiki/04-id-system.md",
        "title": "04 — Node & Edge ID System",
        "category": "2. Core Graph Engine",
        "badge": "GRAPH ENGINE",
        "badge_color": "blue",
        "desc": "Canonical ID formats (target:service), normalization rules, and avoiding ghost duplicates."
    },
    {
        "id": "wiki-05-telemetry-ingestion",
        "filename": "05-telemetry-ingestion.html",
        "source": "wiki/05-telemetry-ingestion.md",
        "title": "05 — Telemetry Ingestion Pipeline",
        "category": "2. Core Graph Engine",
        "badge": "INGESTION",
        "badge_color": "green",
        "desc": "8-stage ingestion pipeline processing remote collector envelopes."
    },
    {
        "id": "wiki-06-node-edge-lifecycle",
        "filename": "06-node-edge-lifecycle.html",
        "source": "wiki/06-node-edge-lifecycle.md",
        "title": "06 — Node & Edge Lifecycle",
        "category": "2. Core Graph Engine",
        "badge": "LIFECYCLE",
        "badge_color": "orange",
        "desc": "Heartbeat tracking, stale node pruning, exponential edge heat decay, and reconnection handling."
    },
    {
        "id": "wiki-21-connection-layer",
        "filename": "21-connection-layer.html",
        "source": "wiki/21-connection-layer.md",
        "title": "21 — Connection Layer & Target Agent",
        "category": "3. Connection & Discovery",
        "badge": "SSH2 / AGENT",
        "badge_color": "blue",
        "desc": "TargetAgent lifecycle, SSH connection pooling, reverse tunnel, and Docker Compose parsing."
    },
    {
        "id": "wiki-23-endpoint-discovery",
        "filename": "23-endpoint-discovery.html",
        "source": "wiki/23-endpoint-discovery.md",
        "title": "23 — Endpoint Discovery Engine",
        "category": "3. Connection & Discovery",
        "badge": "DISCOVERY",
        "badge_color": "green",
        "desc": "Automated discovery of HTTP endpoints, Swagger extraction, and dynamic probe ranking."
    },
    {
        "id": "wiki-07-remote-collector",
        "filename": "07-remote-collector.html",
        "source": "wiki/07-remote-collector.md",
        "title": "07 — Remote Collector Daemon",
        "category": "4. Remote Collection",
        "badge": "DATA PLANE",
        "badge_color": "cyan",
        "desc": "Lightweight daemon on target EC2 extracting /proc/net/tcp, docker.sock stats, and proxy logs."
    },
    {
        "id": "wiki-25-telemetry-sources",
        "filename": "25-telemetry-sources.html",
        "source": "wiki/25-telemetry-sources.md",
        "title": "25 — Telemetry Sources & Ingestion",
        "category": "4. Remote Collection",
        "badge": "DATA PLANE",
        "badge_color": "green",
        "desc": "Deep dive into kernel socket tables, docker 8-byte framing, and Prometheus metrics."
    },
    {
        "id": "wiki-18-telemetry-tiers-plan",
        "filename": "18-telemetry-tiers-plan.html",
        "source": "wiki/18-telemetry-tiers-plan.md",
        "title": "18 — Telemetry Tiers Plan (0, 1, 2)",
        "category": "4. Remote Collection",
        "badge": "TIER SPEC",
        "badge_color": "orange",
        "desc": "Tier 0 (Zero-instrumentation), Tier 1 (Proxy access logs), Tier 2 (Prometheus/OTLP)."
    },
    {
        "id": "telemetry-platform-readme",
        "filename": "telemetry-platform-readme.html",
        "source": "telemetry-platform (2)/telemetry-platform/README.md",
        "title": "Telemetry Platform Daemon Readme",
        "category": "4. Remote Collection",
        "badge": "DAEMON SPEC",
        "badge_color": "cyan",
        "desc": "Autonomous target agent runtime, socket sniffer, and docker event streamer documentation."
    },
    {
        "id": "wiki-08-rca-engine",
        "filename": "08-rca-engine.html",
        "source": "wiki/08-rca-engine.md",
        "title": "08 — RCA Engine & Incident Manager",
        "category": "5. RCA & Risk",
        "badge": "RCA CORE",
        "badge_color": "red",
        "desc": "4-factor scoring algorithm, topological BFS cascade traversal, and root cause classification."
    },
    {
        "id": "wiki-22-risk-engine",
        "filename": "22-risk-engine.html",
        "source": "wiki/22-risk-engine.md",
        "title": "22 — Risk Engine & Centrality Scoring",
        "category": "5. RCA & Risk",
        "badge": "RISK SCORING",
        "badge_color": "red",
        "desc": "Betweenness centrality, single point of failure (SPOF) detection, and blast radius calculation."
    },
    {
        "id": "wiki-17-findings-vs-incidents",
        "filename": "17-findings-vs-incidents.html",
        "source": "wiki/17-findings-vs-incidents.md",
        "title": "17 — Findings vs Incidents Architecture",
        "category": "5. RCA & Risk",
        "badge": "INTELLIGENCE",
        "badge_color": "purple",
        "desc": "Separation of static structural findings from dynamic runtime telemetry incidents."
    },
    {
        "id": "wiki-09-frontend",
        "filename": "09-frontend.html",
        "source": "wiki/09-frontend.md",
        "title": "09 — Frontend Architecture & 2D/3D Graph",
        "category": "6. Frontend & UI",
        "badge": "FRONTEND",
        "badge_color": "cyan",
        "desc": "React 19, Vite, @xyflow/react 2D topology, Three.js 3D spatial view, and state sync."
    },
    {
        "id": "wiki-24-client-frontend",
        "filename": "24-client-frontend.html",
        "source": "wiki/24-client-frontend.md",
        "title": "24 — Client Frontend & 3D Spatial Canvas",
        "category": "6. Frontend & UI",
        "badge": "FRONTEND",
        "badge_color": "purple",
        "desc": "Custom node components, particle packet animations, camera controls, and CSS design system."
    },
    {
        "id": "wiki-10-websocket",
        "filename": "10-websocket.html",
        "source": "wiki/10-websocket.md",
        "title": "10 — WebSocket & Real-Time Streaming",
        "category": "6. Frontend & UI",
        "badge": "REAL-TIME",
        "badge_color": "green",
        "desc": "Heartbeat, graph diff broadcasts, metrics delta streaming, and reconnect logic."
    },
    {
        "id": "traces-section-prompt",
        "filename": "traces-section-prompt.html",
        "source": ".claude/worktrees/determined-sinoussi-ea61ea/traces-section-prompt.md",
        "title": "Traces Section Specification",
        "category": "6. Frontend & UI",
        "badge": "SPECIFICATION",
        "badge_color": "cyan",
        "desc": "Design prompt and architecture specification for live trace views and waterfall timelines."
    },
    {
        "id": "wiki-20-traffic-experiments",
        "filename": "20-traffic-experiments.html",
        "source": "wiki/20-traffic-experiments.md",
        "title": "20 — Traffic Controller & Load Generation",
        "category": "7. Traffic & ML Pipeline",
        "badge": "LOAD GEN",
        "badge_color": "orange",
        "desc": "Virtual user profiles (LIGHT, MODERATE, HEAVY, SPIKE, STRESS) and adaptive probes."
    },
    {
        "id": "traffic-gen-readme",
        "filename": "traffic-gen-readme.html",
        "source": "traffic-gen/README.md",
        "title": "Traffic Generator Readme",
        "category": "7. Traffic & ML Pipeline",
        "badge": "LOAD GEN",
        "badge_color": "orange",
        "desc": "Autonomous load simulation engine, user scenario scripting, and load profiles."
    },
    {
        "id": "wiki-11-ml-pipeline",
        "filename": "11-ml-pipeline.html",
        "source": "wiki/11-ml-pipeline.md",
        "title": "11 — ML Anomaly Detection Pipeline",
        "category": "7. Traffic & ML Pipeline",
        "badge": "ML CORE",
        "badge_color": "purple",
        "desc": "Python sidecar, IsolationForest, LOF, OCSVM, Z-Score, feature engineering, and tail CSV."
    },
    {
        "id": "wiki-26-ml-pipeline-deep-dive",
        "filename": "26-ml-pipeline-deep-dive.html",
        "source": "wiki/26-ml-pipeline-deep-dive.md",
        "title": "26 — ML Pipeline Deep Dive (Code-Level)",
        "category": "7. Traffic & ML Pipeline",
        "badge": "ML DEEP DIVE",
        "badge_color": "purple",
        "desc": "Code-level walkthrough of collector.py, preprocess.py, train.py, and score.py."
    },
    {
        "id": "ml-readme",
        "filename": "ml-readme.html",
        "source": "ml/README.md",
        "title": "ML Subsystem Readme",
        "category": "7. Traffic & ML Pipeline",
        "badge": "ML README",
        "badge_color": "purple",
        "desc": "Python dependencies, training workflows, hyperparameter tuning, and export schema."
    },
    {
        "id": "project-reference",
        "filename": "27-project-technical-reference.html",
        "source": "wiki/27-project-technical-reference.md",
        "title": "27 — Engineering Manual & Technical Reference",
        "category": "8. Reference & Operations",
        "badge": "ENGINEERING MANUAL",
        "badge_color": "blue",
        "desc": "Exhaustive project reference manual containing architectural diagrams and design rationale."
    },
    {
        "id": "mapper-technical-reference",
        "filename": "28-mapper-technical-reference.html",
        "source": "wiki/28-mapper-technical-reference.md",
        "title": "28 — Mapper Technical Reference (11 Subsystems)",
        "category": "8. Reference & Operations",
        "badge": "TECH REFERENCE",
        "badge_color": "cyan",
        "desc": "The 11 core subsystems as visual vector schematics, measured telemetry tables, and operational limits."
    },
    {
        "id": "wiki-12-data-models",
        "filename": "12-data-models.html",
        "source": "wiki/12-data-models.md",
        "title": "12 — Data Models & Schemas",
        "category": "8. Reference & Operations",
        "badge": "SCHEMAS",
        "badge_color": "blue",
        "desc": "TypeScript interfaces and schemas for Node, Edge, MetricEnvelope, and Incident."
    },
    {
        "id": "wiki-13-api-reference",
        "filename": "13-api-reference.html",
        "source": "wiki/13-api-reference.md",
        "title": "13 — API Reference",
        "category": "8. Reference & Operations",
        "badge": "REST API",
        "badge_color": "green",
        "desc": "Complete REST API documentation: 54 endpoints across 8 resource controllers."
    },
    {
        "id": "wiki-14-configuration",
        "filename": "14-configuration.html",
        "source": "wiki/14-configuration.md",
        "title": "14 — Configuration Reference",
        "category": "8. Reference & Operations",
        "badge": "CONFIG",
        "badge_color": "orange",
        "desc": "Environment variables, remote_config.json, ml/config.json, and data locations."
    },
    {
        "id": "wiki-15-troubleshooting",
        "filename": "15-troubleshooting.html",
        "source": "wiki/15-troubleshooting.md",
        "title": "15 — Troubleshooting Runbook",
        "category": "8. Reference & Operations",
        "badge": "RUNBOOK",
        "badge_color": "orange",
        "desc": "Diagnosis steps for NO DATA, missing metrics, ghost edges, SSH locks, and traffic bugs."
    },
    {
        "id": "wiki-16-change-log-and-rationale",
        "filename": "16-change-log-and-rationale.html",
        "source": "wiki/16-change-log-and-rationale.md",
        "title": "16 — Change Log & Design Rationale",
        "category": "8. Reference & Operations",
        "badge": "DECISION LOG",
        "badge_color": "purple",
        "desc": "Record of what was changed, why, and where — architectural decisions and fixes."
    }
]

CSS_STYLES = """
  :root {
    --bg:        #f6f7f9;
    --panel:     #ffffff;
    --panel-2:   #eceff4;
    --ink:       #141413;
    --ink-2:     #334155;
    --muted:     #76828f;
    --faint:     #97a1af;
    --rule:      #dbe0e8;
    --rule-2:    #e9ecf2;

    --sig:       #00e5ff;
    --sig-bg:    rgba(0, 229, 255, 0.12);
    --ok:        #0a7a46;
    --warn:      #96620a;
    --err:       #b41f3c;
    --t0:        #626d7d;
    --t1:        #96620a;
    --t2:        #0a7ea4;

    --body: 'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:      #05080d;
      --panel:   #0b1119;
      --panel-2: #121a25;
      --ink:     #e6ecf4;
      --ink-2:   #aeb9c8;
      --muted:   #76828f;
      --faint:   #545e6c;
      --rule:    #1a2430;
      --rule-2:  #131b25;
      --sig:     #3ec8ee;
      --sig-bg:  #3ec8ee14;
      --ok:      #35d38b;
      --warn:    #f0ab2e;
      --err:     #ff5f7a;
      --t0:      #76828f;
      --t1:      #f0ab2e;
      --t2:      #3ec8ee;
    }
  }
  :root[data-theme="dark"] {
    --bg:      #05080d;  --panel:   #0b1119;  --panel-2: #121a25;
    --ink:     #e6ecf4;  --ink-2:   #aeb9c8;  --muted:   #76828f;
    --faint:   #545e6c;  --rule:    #1a2430;  --rule-2:  #131b25;
    --sig:     #3ec8ee;  --sig-bg:  #3ec8ee14;
    --ok:      #35d38b;  --warn:    #f0ab2e;  --err:     #ff5f7a;
    --t0:      #76828f;  --t1:      #f0ab2e;  --t2:      #3ec8ee;
  }

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
    text-decoration-color: rgba(62, 200, 238, 0.4);
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
  .badge-cyan { background: var(--sig-bg); color: var(--sig); border: 1px solid rgba(0, 229, 255, 0.3); }
  .badge-green { background: rgba(16, 185, 129, 0.15); color: var(--ok); border: 1px solid rgba(16, 185, 129, 0.3); }
  .badge-orange { background: rgba(245, 158, 11, 0.15); color: var(--warn); border: 1px solid rgba(245, 158, 11, 0.3); }
  .badge-red { background: rgba(239, 68, 68, 0.15); color: var(--err); border: 1px solid rgba(239, 68, 68, 0.3); }
  .badge-purple { background: rgba(192, 132, 252, 0.15); color: #c084fc; border: 1px solid rgba(192, 132, 252, 0.3); }
  .badge-blue { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }

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
  .lab-btn { background: var(--sig); color: #070b14; border: none; font-weight: 600; font-family: var(--mono); font-size: 0.85rem; padding: 8px 16px; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
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

    // 5. Interactive Lab Helpers
    window.testCanonicalId = function() {
        const input = document.getElementById('canon-input');
        const target = document.getElementById('canon-target');
        const output = document.getElementById('canon-output');
        if (input && output) {
            const raw = input.value.trim() || 'sockshop_orders_1';
            const tgt = target ? target.value.trim() || 'ec2-target-prod' : 'ec2-target-prod';
            const clean = raw.toLowerCase().replace(/_\\d+$/, '').replace(/^[\\/_]+/, '');
            const canonical = `${tgt}:${clean}`;
            output.innerHTML = `<span style="color: var(--ok); font-weight: bold;">✓ Canonical ID Resolved:</span> <code style="font-size: 1rem; color: var(--sig);">${canonical}</code><br><span style="color: var(--ink-2); font-size: 0.8rem; margin-top: 4px; display: inline-block;">Stripped instance suffix <code>_1</code> &bull; Lowercased &bull; Prefixed with Target Namespace</span>`;
        }
    };

    window.calculateHeatDecay = function() {
        const h0Input = document.getElementById('heat-h0');
        const lambdaInput = document.getElementById('heat-lambda');
        const tInput = document.getElementById('heat-t');
        const output = document.getElementById('heat-output');
        const bar = document.getElementById('heat-bar');
        if (h0Input && lambdaInput && tInput && output) {
            const h0 = parseFloat(h0Input.value) || 100;
            const lambda = parseFloat(lambdaInput.value) || 0.05;
            const t = parseFloat(tInput.value) || 10;
            const ht = h0 * Math.exp(-lambda * t);
            const pct = Math.min(100, Math.max(0, (ht / h0) * 100));
            output.innerHTML = `<span style="color: var(--sig); font-weight: bold;">Residual Heat H(${t}s):</span> <strong>${ht.toFixed(2)}</strong> / ${h0.toFixed(0)} (${pct.toFixed(1)}% remaining)`;
            if (bar) bar.style.width = `${pct}%`;
        }
    };

    window.calculateRcaScore = function() {
        const cpuInput = document.getElementById('rca-cpu');
        const memInput = document.getElementById('rca-mem');
        const errInput = document.getElementById('rca-err');
        const degInput = document.getElementById('rca-deg');
        const output = document.getElementById('rca-output');
        if (cpuInput && memInput && errInput && degInput && output) {
            const cpuZ = parseFloat(cpuInput.value) || 3.2;
            const memZ = parseFloat(memInput.value) || 1.1;
            const errRate = parseFloat(errInput.value) || 0.15;
            const deg = parseFloat(degInput.value) || 4;
            
            const cpuNorm = Math.min(1, cpuZ / 4.0);
            const memNorm = Math.min(1, memZ / 4.0);
            const errNorm = Math.min(1, errRate / 0.20);
            const degNorm = Math.min(1, deg / 8.0);
            
            const totalScore = (0.35 * cpuNorm + 0.25 * memNorm + 0.30 * errNorm + 0.10 * degNorm);
            const isRoot = totalScore > 0.65;
            const badgeCol = isRoot ? 'var(--err)' : (totalScore > 0.4 ? 'var(--warn)' : 'var(--ok)');
            const badgeText = isRoot ? '🚨 PRIMARY ROOT CAUSE (P1)' : (totalScore > 0.4 ? '⚠ SECONDARY SYMPTOM' : '✓ HEALTHY / NORMAL');
            
            output.innerHTML = `
                <div style="font-size: 1.1rem; font-weight: 700; color: ${badgeCol}; margin-bottom: 6px;">${badgeText}</div>
                <div>Root Cause Probability Score: <strong style="font-size: 1.2rem; color: #fff;">${totalScore.toFixed(3)}</strong> (Threshold: 0.650)</div>
                <div style="font-size: 0.78rem; color: var(--muted); margin-top: 4px;">
                    CPU Contribution: ${(0.35 * cpuNorm).toFixed(3)} &bull; Mem: ${(0.25 * memNorm).toFixed(3)} &bull; Err: ${(0.30 * errNorm).toFixed(3)} &bull; Degree: ${(0.10 * degNorm).toFixed(3)}
                </div>
            `;
        }
    };
});
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
        
    out = ['<select id="quick-jump" class="quick-jump-select" style="background: var(--panel); border: 1px solid var(--rule); color: var(--ink-2); padding: 5px 11px; border-radius: 6px; font-family: var(--mono); font-size: 11.5px; cursor: pointer;" title="Jump directly to any document">']
    out.append('<option value="" disabled selected>⚡ Jump to document...</option>')
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
    crumb_cat = escape_html(doc_info["category"] if doc_info else "1. Master Hub & Foundations")
    crumb_title = escape_html(doc_info["title"] if doc_info else "Master Hub")
    
    return f"""
    <div style="display: flex; justify-content: space-between; align-items: center; padding-block: 18px; border-bottom: 1px solid var(--rule); margin-bottom: 24px; flex-wrap: wrap; gap: 12px;">
      <div style="font-family: var(--mono); font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px;">
        <a href="index.html" style="color: var(--ink); text-decoration: none;">Wiki Visualizer</a>
        <span>/</span>
        <span>{crumb_cat}</span>
        <span>/</span>
        <span style="color: var(--sig); font-weight: 600;">{crumb_title}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        {jump_select}
        <button id="theme-toggle-btn" style="background: var(--panel); border: 1px solid var(--rule); color: var(--ink-2); padding: 5px 11px; border-radius: 6px; font-family: var(--mono); font-size: 11.5px; cursor: pointer;">🌓 Mode</button>
        <a href="architecture-map.html" style="font-family: var(--mono); font-size: 11.5px; background: var(--panel); border: 1px solid var(--rule); color: var(--ink-2); padding: 5px 11px; border-radius: 6px; text-decoration: none;">🗺 Architecture Map</a>
        <a href="index.html" style="font-family: var(--mono); font-size: 11.5px; background: var(--panel); border: 1px solid var(--rule); color: var(--ink-2); padding: 5px 11px; border-radius: 6px; text-decoration: none;">🏠 Master Hub</a>
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

def build_master_architecture_flowchart_html():
    """
    Builds the Master System Architecture Flowchart with clickable components.
    """
    return """
    <div class="flow-container">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.2rem; flex-wrap: wrap; gap: 10px;">
            <div>
                <h3 style="margin: 0; color: var(--ink); font-size: 1.1rem;">🗺️ End-to-End System Flowchart</h3>
                <p style="margin: 0; font-size: 0.85rem; color: var(--muted);">Click any component below to jump directly into its dedicated technical documentation module:</p>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="lab-btn flow-trace-btn" data-flow="TELEMETRY" style="font-size: 11px; padding: 4px 10px;">⚡ Trace Telemetry Flow</button>
                <button class="lab-btn flow-trace-btn" data-flow="RCA" style="font-size: 11px; padding: 4px 10px; background: var(--err); color: #fff;">🚨 Trace Incident RCA Flow</button>
                <button class="lab-btn flow-trace-btn" data-flow="ML" style="font-size: 11px; padding: 4px 10px; background: var(--purple); color: #070b14;">🧠 Trace ML Drift Flow</button>
                <button class="lab-btn flow-trace-btn" data-flow="RESET" style="font-size: 11px; padding: 4px 10px; background: var(--panel-2); color: var(--ink-2); border: 1px solid var(--rule);">🔄 Reset View</button>
            </div>
        </div>

        <!-- Layer 1: Target Host Data Plane -->
        <div class="flow-layer" id="layer-target" style="border-left: 3px solid var(--sig);">
            <div class="flow-layer-title">
                <span>1. Target Host Data Plane (Zero-Touch EC2 & Docker Compose)</span>
                <span class="badge badge-cyan">PORT 22 &bull; ZERO AGENT</span>
            </div>
            <div class="flow-node-grid">
                <a href="21-connection-layer.html" class="flow-node-card flow-node" data-tags="telemetry,rca">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🖥️ AWS EC2 Host</span>
                        <span class="badge badge-blue">SSH2:22</span>
                    </div>
                    <div class="flow-node-desc">Remote target running microservice containers under Docker Compose.</div>
                    <div class="flow-node-footer">
                        <span>21-connection-layer</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="07-remote-collector.html" class="flow-node-card flow-node" data-tags="telemetry">
                    <div class="flow-node-header">
                        <span class="flow-node-name">⚙️ Remote Collector Daemon</span>
                        <span class="badge badge-purple">NODE DAEMON</span>
                    </div>
                    <div class="flow-node-desc">Autonomous daemon polling kernel socket tables and docker.sock frames.</div>
                    <div class="flow-node-footer">
                        <span>07-remote-collector</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="25-telemetry-sources.html" class="flow-node-card flow-node" data-tags="telemetry">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🔬 /proc/net/tcp Demuxer</span>
                        <span class="badge badge-green">TIER 0</span>
                    </div>
                    <div class="flow-node-desc">Reads socket inodes to detect active ESTABLISHED connections without APM.</div>
                    <div class="flow-node-footer">
                        <span>25-telemetry-sources</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="18-telemetry-tiers-plan.html" class="flow-node-card flow-node" data-tags="telemetry">
                    <div class="flow-node-header">
                        <span class="flow-node-name">📦 Docker Access Log Parser</span>
                        <span class="badge badge-orange">TIER 1</span>
                    </div>
                    <div class="flow-node-desc">Demuxes 8-byte framed streams from /var/run/docker.sock for HTTP codes.</div>
                    <div class="flow-node-footer">
                        <span>18-telemetry-tiers-plan</span>
                        <span>Explore →</span>
                    </div>
                </a>
            </div>
        </div>

        <div class="flow-arrow-down">⬇️ Reverse SSH2 Encrypted Tunnel (Port 3001) ⬇️</div>

        <!-- Layer 2: Transport & Central Server Ingestion -->
        <div class="flow-layer" id="layer-server" style="border-left: 3px solid #38bdf8;">
            <div class="flow-layer-title">
                <span>2. Central Server Ingestion & Concurrency Core (Express 5 & TSX)</span>
                <span class="badge badge-blue">PORT 3001 &bull; REVERSE TUNNEL</span>
            </div>
            <div class="flow-node-grid">
                <a href="05-telemetry-ingestion.html" class="flow-node-card flow-node" data-tags="telemetry,rca">
                    <div class="flow-node-header">
                        <span class="flow-node-name">⚡ 8-Stage Ingestion Pipeline</span>
                        <span class="badge badge-green">POST /ingest</span>
                    </div>
                    <div class="flow-node-desc">Validates Bearer token, unpacks envelopes, and feeds state engines.</div>
                    <div class="flow-node-footer">
                        <span>05-telemetry-ingestion</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="04-id-system.html" class="flow-node-card flow-node" data-tags="telemetry">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🔑 Canonical ID Resolver</span>
                        <span class="badge badge-red">normalizeId()</span>
                    </div>
                    <div class="flow-node-desc">Eliminates ghost duplicates by hashing compose names to canonical keys.</div>
                    <div class="flow-node-footer">
                        <span>04-id-system</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="03-graphstore.html" class="flow-node-card flow-node" data-tags="telemetry,rca,ml">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🧠 In-Memory GraphStore</span>
                        <span class="badge badge-cyan">CENTRAL NERVOUS</span>
                    </div>
                    <div class="flow-node-desc">Central Map&lt;string, Node&gt; tracking topology, status, and edge heat.</div>
                    <div class="flow-node-footer">
                        <span>03-graphstore</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="06-node-edge-lifecycle.html" class="flow-node-card flow-node" data-tags="telemetry">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🔄 MetricStore Ring Buffers</span>
                        <span class="badge badge-purple">1H BUFFER</span>
                    </div>
                    <div class="flow-node-desc">Circular 1-hour buffers holding 10,000 metrics events with zero leak.</div>
                    <div class="flow-node-footer">
                        <span>06-node-edge-lifecycle</span>
                        <span>Explore →</span>
                    </div>
                </a>
            </div>
        </div>

        <div class="flow-arrow-down">⬇️ Internal Event Emitter & Analysis Bus ⬇️</div>

        <!-- Layer 3: Automated Intelligence & RCA Engines -->
        <div class="flow-layer" id="layer-intel" style="border-left: 3px solid var(--err);">
            <div class="flow-layer-title">
                <span>3. Intelligence, Anomaly Detection & RCA Core</span>
                <span class="badge badge-red">ANOMALY ENGINE</span>
            </div>
            <div class="flow-node-grid">
                <a href="22-risk-engine.html" class="flow-node-card flow-node" data-tags="rca">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🛡️ Risk Engine & Centrality</span>
                        <span class="badge badge-red">BLAST RADIUS</span>
                    </div>
                    <div class="flow-node-desc">Computes Betweenness Centrality and flags Single Points of Failure (SPOFs).</div>
                    <div class="flow-node-footer">
                        <span>22-risk-engine</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="08-rca-engine.html" class="flow-node-card flow-node" data-tags="rca">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🎯 RCA Incident Engine</span>
                        <span class="badge badge-red">BFS CASCADE</span>
                    </div>
                    <div class="flow-node-desc">4-factor weighted scoring + reverse BFS dependency traversal.</div>
                    <div class="flow-node-footer">
                        <span>08-rca-engine</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="11-ml-pipeline.html" class="flow-node-card flow-node" data-tags="ml">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🤖 Python ML Sidecar</span>
                        <span class="badge badge-purple">IFOREST / LOF</span>
                    </div>
                    <div class="flow-node-desc">4 unsupervised models detecting metric drift with 97x tail CSV speedup.</div>
                    <div class="flow-node-footer">
                        <span>11-ml-pipeline</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="17-findings-vs-incidents.html" class="flow-node-card flow-node" data-tags="rca">
                    <div class="flow-node-header">
                        <span class="flow-node-name">📋 Findings vs Incidents</span>
                        <span class="badge badge-orange">TAXONOMY</span>
                    </div>
                    <div class="flow-node-desc">Clear separation of static architectural findings from live incidents.</div>
                    <div class="flow-node-footer">
                        <span>17-findings-vs-incidents</span>
                        <span>Explore →</span>
                    </div>
                </a>
            </div>
        </div>

        <div class="flow-arrow-down">⬇️ Real-Time WebSocket Frames & REST API (Port 5173 / 4400) ⬇️</div>

        <!-- Layer 4: Presentation, Traffic Gen & Visualization -->
        <div class="flow-layer" id="layer-presentation" style="border-left: 3px solid var(--ok);">
            <div class="flow-layer-title">
                <span>4. Presentation & Real-Time Visualization (React 19 & Three.js)</span>
                <span class="badge badge-green">VITE :5173</span>
            </div>
            <div class="flow-node-grid">
                <a href="09-frontend.html" class="flow-node-card flow-node" data-tags="telemetry,rca">
                    <div class="flow-node-header">
                        <span class="flow-node-name">📊 2D XYFlow Graph Canvas</span>
                        <span class="badge badge-cyan">@XYFLOW/REACT</span>
                    </div>
                    <div class="flow-node-desc">Interactive 2D graph with auto-layout and service health indicators.</div>
                    <div class="flow-node-footer">
                        <span>09-frontend</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="24-client-frontend.html" class="flow-node-card flow-node" data-tags="telemetry">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🌐 3D Spatial Mesh Canvas</span>
                        <span class="badge badge-purple">THREE.JS 3D</span>
                    </div>
                    <div class="flow-node-desc">Spatial node orbits, live request packet pulses, and camera controls.</div>
                    <div class="flow-node-footer">
                        <span>24-client-frontend</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="10-websocket.html" class="flow-node-card flow-node" data-tags="telemetry,rca">
                    <div class="flow-node-header">
                        <span class="flow-node-name">⚡ WebSocket Broadcaster</span>
                        <span class="badge badge-green">WS PUSH</span>
                    </div>
                    <div class="flow-node-desc">Sub-second delta broadcasting and SSH terminal multiplexing.</div>
                    <div class="flow-node-footer">
                        <span>10-websocket</span>
                        <span>Explore →</span>
                    </div>
                </a>

                <a href="20-traffic-experiments.html" class="flow-node-card flow-node" data-tags="telemetry">
                    <div class="flow-node-header">
                        <span class="flow-node-name">🚦 Traffic Generator (Port 4400)</span>
                        <span class="badge badge-orange">LOAD GEN</span>
                    </div>
                    <div class="flow-node-desc">Simulates real user workflows to generate runtime telemetry.</div>
                    <div class="flow-node-footer">
                        <span>20-traffic-experiments</span>
                        <span>Explore →</span>
                    </div>
                </a>
            </div>
        </div>
    </div>
    """

def get_code_explainer_markup(code_text, lang):
    """
    Generates a simple, intuitive 'Plain English Code Breakdown' section for code blocks.
    """
    lines = code_text.strip().splitlines()
    if len(lines) < 4:
        return ""
    
    first_few = " ".join(lines[:3]).lower()
    
    # Heuristics to detect context
    if "normalizeid" in first_few or "canonical" in first_few:
        summary = "Standardizes raw service/container strings from Docker stats and Compose into a deterministic canonical ID (e.g. <code>target:service</code>), preventing duplicate ghost nodes."
        inputs = "Raw container name string (e.g. <code>sockshop_orders_1</code>) and Target ID."
        logic = "Strips instance numbers (<code>_1</code>), lowercases, and prefixes with target ID."
        impact = "Guarantees 1:1 node identity in GraphStore across restarts."
    elif "graphstore" in first_few or "map<" in first_few:
        summary = "Manages the in-memory central nervous system state. Updates active microservice nodes, decays edge heat, and commits telemetry to circular ring buffers."
        inputs = "Incoming TelemetryEnvelope from remote collector."
        logic = r"Lock-free concurrent Map updates with exponential decay formula $H(t) = H_0 \cdot e^{-\lambda t}$."
        impact = "Provides ultra-low latency (<2ms) graph lookups for WebSocket broadcasting."
    elif "rca" in first_few or "incident" in first_few or "score" in first_few:
        summary = "Calculates root-cause probability for failing microservices using 4-factor scoring (CPU anomaly + Memory anomaly + Error Rate + Topology Degree)."
        inputs = "Telemetry metrics array and active graph edges."
        logic = "Weighted formula + BFS reverse dependency traversal to find the true root anomaly."
        impact = "Generates actionable root-cause alerts in the UI instead of flooding alarms."
    elif "ssh" in first_few or "tunnel" in first_few:
        summary = "Establishes an encrypted reverse SSH tunnel between the target EC2 machine and central server without exposing open inbound firewall ports."
        inputs = "Target SSH credentials and remote port 3001."
        logic = "Multiplexes telemetry stream and terminal sessions with exponential reconnect backoff."
        impact = "Enables secure, agentless data collection across private VPC networks."
    elif "collector" in first_few or "/proc/net/tcp" in first_few:
        summary = "Extracts live microservice telemetry directly from the host Linux kernel (/proc/net/tcp hex socket tables and docker.sock frames)."
        inputs = "Linux /proc filesystem & Docker socket."
        logic = "Bitwise hex IP/Port decoding and 8-byte stream demuxing."
        impact = "Zero overhead: extracts full network topology without modifying container code."
    elif "isolationforest" in first_few or "preprocess" in first_few or "train" in first_few:
        summary = "Python machine learning pipeline that trains unsupervised outlier models on metric feature distributions to detect subtle performance drift."
        inputs = "CSV telemetry window (CPU, Memory, Network RX/TX, Latency)."
        logic = "Random decision trees evaluate path length to isolate anomalous metric vectors."
        impact = "Spots multi-dimensional performance degradation before hard crashes occur."
    else:
        summary = f"Core implementation logic written in <code>{lang or 'TypeScript/Python'}</code> executing key observability operations."
        inputs = "System configuration, telemetry state, and active graph envelopes."
        logic = "Processes data through state machines and validates invariants."
        impact = "Updates downstream stores and broadcasts real-time updates."

    return f"""
    <div class="code-explainer-box">
        <div class="code-explainer-title">
            💡 Plain English Code Breakdown
        </div>
        <div style="margin-bottom: 6px;">{summary}</div>
        <div class="code-explainer-grid">
            <div class="code-explainer-col">
                <strong>📥 Inputs</strong>
                <span>{inputs}</span>
            </div>
            <div class="code-explainer-col">
                <strong>⚙️ Core Logic</strong>
                <span>{logic}</span>
            </div>
            <div class="code-explainer-col">
                <strong>📤 System Impact</strong>
                <span>{impact}</span>
            </div>
        </div>
    </div>
    """

def process_inline(text):
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', text)
    
    def link_repl(match):
        label = match.group(1)
        url = match.group(2)
        if url.endswith(".md"):
            clean_url = url
            if clean_url.startswith("wiki/"):
                clean_url = clean_url[5:]
            url = clean_url[:-3] + ".html"
        return f'<a href="{url}">{label}</a>'
        
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link_repl, text)
    return text

def render_table(table_lines):
    if not table_lines:
        return ""
    
    header_line = table_lines[0].strip()
    headers = [c.strip() for c in header_line.split("|")[1:-1]]
    
    data_lines = []
    for line in table_lines[1:]:
        line_str = line.strip()
        if re.match(r'^[\|\s\-\:\+]+$', line_str):
            continue
        cols = [c.strip() for c in line.split("|")[1:-1]]
        if cols:
            data_lines.append(cols)
            
    out = ['<div class="scroll"><table class="t">', '  <thead><tr>']
    for h in headers:
        out.append(f'    <th>{process_inline(h)}</th>')
    out.append('  </tr></thead>')
    out.append('  <tbody>')
    for row in data_lines:
        out.append('    <tr>')
        for idx, col in enumerate(row):
            out.append(f'      <td>{process_inline(col)}</td>')
        out.append('    </tr>')
    out.append('  </tbody>')
    out.append('</table></div>')
    return "\n".join(out)

def markdown_to_html(md_text, base_filename=""):
    lines = md_text.splitlines()
    output = []
    
    in_code = False
    code_lang = ""
    code_lines = []
    
    in_table = False
    table_lines = []
    
    in_blockquote = False
    blockquote_lines = []
    
    in_list = False
    list_type = "ul"

    def flush_blockquote():
        nonlocal in_blockquote, blockquote_lines
        if blockquote_lines:
            content = " ".join(blockquote_lines)
            box_class = "box"
            if content.startswith("[!NOTE]"):
                box_class += " why"
                content = content[7:].strip()
            elif content.startswith("[!TIP]"):
                box_class += " perf"
                content = content[6:].strip()
            elif content.startswith("[!WARNING]"):
                box_class += " trap"
                content = content[10:].strip()
            elif content.startswith("[!IMPORTANT]") or content.startswith("[!CAUTION]"):
                box_class += " trap"
                content = content[12:].strip()
            else:
                box_class += " why"
            
            output.append(f'<div class="{box_class}"><p>{process_inline(content)}</p></div>')
            blockquote_lines = []
            in_blockquote = False

    def flush_table():
        nonlocal in_table, table_lines
        if table_lines:
            html_table = render_table(table_lines)
            output.append(html_table)
            table_lines = []
            in_table = False

    def flush_list():
        nonlocal in_list, list_type
        if in_list:
            output.append(f"</{list_type}>")
            in_list = False

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            if in_code:
                code_content = "\n".join(code_lines)
                is_diagram = any(sym in code_content for sym in ["┌", "└", "│", "├", "─", "──►", "▼", "▲", "-->", "---", "|"]) and not any(kw in code_content for kw in ["import ", "function ", "const ", "class ", "def ", "return "])
                if code_lang.lower() == "math":
                    output.append(f'<div class="panel" style="margin: 18px 0; font-family: var(--mono);">{escape_html(code_content)}</div>')
                elif is_diagram and not code_lang.lower() in ["python", "typescript", "ts", "json", "javascript", "js", "bash", "sh", "yaml", "yml"]:
                    output.append(f'''<figure><div class="fx" style="margin: 18px 0;">
                        <div style="font-family: var(--mono); font-size: 11px; color: var(--sig); margin-bottom: 8px; font-weight: 700;">📊 SYSTEM ARCHITECTURE FLOWCHART</div>
                        <pre style="margin: 0; background: var(--panel-2); border: none; font-size: 12px; line-height: 1.5;">{escape_html(code_content)}</pre>
                    </div></figure>''')
                else:
                    lang_label = code_lang.upper() if code_lang else "CODE"
                    explainer_box = get_code_explainer_markup(code_content, code_lang)
                    output.append(f'''<div class="code-wrapper" style="position:relative; margin: 16px 0 8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--panel-2); padding:6px 12px; border:1px solid var(--rule); border-bottom:none; border-radius:8px 8px 0 0; font-family:var(--mono); font-size:11px; color:var(--muted);">
                            <span>{lang_label}</span>
                            <span style="font-size: 10px;">SOURCE</span>
                        </div>
                        <pre style="border-radius:0 0 8px 8px; margin-top:0;"><code class="language-{code_lang}">{escape_html(code_content)}</code></pre>
                    </div>{explainer_box}''')
                in_code = False
                code_lines = []
                code_lang = ""
            else:
                flush_blockquote()
                flush_table()
                flush_list()
                in_code = True
                code_lang = stripped[3:].strip()
                code_lines = []
            i += 1
            continue

        if in_code:
            code_lines.append(line)
            i += 1
            continue

        if "|" in line and (line.strip().startswith("|") or (len(line.split("|")) >= 3 and not line.startswith("#"))):
            flush_blockquote()
            flush_list()
            in_table = True
            table_lines.append(line)
            i += 1
            continue
        elif in_table:
            flush_table()

        if stripped.startswith(">"):
            flush_table()
            flush_list()
            in_blockquote = True
            blockquote_lines.append(stripped[1:].strip())
            i += 1
            continue
        elif in_blockquote:
            flush_blockquote()

        list_match = re.match(r"^(\s*)([-*+]|\d+\.)\s+(.+)$", line)
        if list_match:
            flush_table()
            flush_blockquote()
            marker = list_match.group(2)
            item_text = list_match.group(3)
            is_num = marker[0].isdigit()
            target_list = "ol" if is_num else "ul"
            
            if not in_list or list_type != target_list:
                flush_list()
                output.append(f"<{target_list}>")
                in_list = True
                list_type = target_list
                
            output.append(f"  <li>{process_inline(item_text)}</li>")
            i += 1
            continue
        elif in_list and not stripped:
            i += 1
            continue
        elif in_list:
            flush_list()

        if not stripped:
            i += 1
            continue

        h_match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if h_match:
            flush_table()
            flush_blockquote()
            flush_list()
            level = len(h_match.group(1))
            heading_text = h_match.group(2).strip()
            heading_id = slugify(heading_text)
            
            clean_text = process_inline(heading_text)
            
            if level == 1:
                output.append(f'<h1 id="{heading_id}">{clean_text}</h1>')
            elif level == 2:
                num_match = re.match(r"^(\d+)\s*[-—–]\s*(.+)$", clean_text)
                if num_match:
                    output.append(f'<h2 id="{heading_id}"><span class="id">{num_match.group(1)}</span> {num_match.group(2)}</h2>')
                else:
                    output.append(f'<h2 id="{heading_id}">{clean_text}</h2>')
            elif level == 3:
                output.append(f'<h3 id="{heading_id}">{clean_text}</h3>')
            elif level == 4:
                output.append(f'<h4 id="{heading_id}">{clean_text}</h4>')
            else:
                output.append(f'<h5 id="{heading_id}">{clean_text}</h5>')
            i += 1
            continue

        if stripped.startswith("---") or stripped.startswith("***"):
            flush_table()
            flush_blockquote()
            flush_list()
            output.append('<hr style="border:none; border-top:1px solid var(--rule); margin:2rem 0;">')
            i += 1
            continue

        flush_table()
        flush_blockquote()
        flush_list()
        output.append(f'<p>{process_inline(line)}</p>')
        i += 1

    flush_blockquote()
    flush_table()
    flush_list()
    return "\n".join(output)

def get_page_interactive_lab(doc_id):
    """
    Returns custom, rich interactive mini-labs for specific technical documents.
    """
    if doc_id == "wiki-04-id-system":
        return """
        <div class="interactive-lab">
            <div class="lab-title">🧪 Live Canonical ID Normalizer Sandbox</div>
            <p style="color: var(--ink-2); font-size: 0.88rem; margin-bottom: 1rem;">
                Test how raw Docker container names and compose service definitions are deterministically mapped to unique canonical IDs across all ingestion pipelines:
            </p>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 12px;">
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">Raw Container / Service Name</label>
                    <input type="text" id="canon-input" value="sockshop_orders_1" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); font-size: 0.85rem; margin-top: 4px;">
                </div>
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">Target EC2 Namespace</label>
                    <input type="text" id="canon-target" value="ec2-target-prod" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); font-size: 0.85rem; margin-top: 4px;">
                </div>
            </div>
            <button onclick="testCanonicalId()" class="lab-btn">Resolve Canonical ID ⚡</button>
            <div id="canon-output" class="lab-output" style="margin-top: 12px;">
                <span style="color: var(--muted);">Click "Resolve Canonical ID" to run normalizeId() string standardizer.</span>
            </div>
        </div>
        """
    elif doc_id == "wiki-06-heat-algorithm":
        return """
        <div class="interactive-lab">
            <div class="lab-title">🔥 Live Heat Decay Formula Simulator: H(t) = H₀ · e^(-λt)</div>
            <p style="color: var(--ink-2); font-size: 0.88rem; margin-bottom: 1rem;">
                Simulate exponential heat decay on graph edges. In Microservice Mapper, every active HTTP call pulses heat to 100, which decays over time to keep the visualization crisp and prevent phantom edge clutter.
            </p>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px;">
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">Initial Heat (H₀)</label>
                    <input type="number" id="heat-h0" value="100" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); margin-top: 4px;">
                </div>
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">Decay Lambda (λ)</label>
                    <input type="number" step="0.01" id="heat-lambda" value="0.05" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); margin-top: 4px;">
                </div>
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">Elapsed Time t (seconds)</label>
                    <input type="number" id="heat-t" value="15" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); margin-top: 4px;">
                </div>
            </div>
            <button onclick="calculateHeatDecay()" class="lab-btn">Compute Heat Decay 🔥</button>
            <div style="margin-top: 14px; background: rgba(0,0,0,0.4); height: 10px; border-radius: 5px; overflow: hidden; border: 1px solid var(--rule);">
                <div id="heat-bar" style="height: 100%; width: 100%; background: linear-gradient(90deg, #00e5ff, #f59e0b, #ef4444); transition: width 0.3s ease;"></div>
            </div>
            <div id="heat-output" class="lab-output" style="margin-top: 10px;">
                <span style="color: var(--muted);">Click above to calculate residual edge heat.</span>
            </div>
        </div>
        """
    elif doc_id == "wiki-08-rca-engine" or doc_id == "wiki-22-risk-engine":
        return """
        <div class="interactive-lab">
            <div class="lab-title">🎯 Live 4-Factor RCA Anomaly Classifier Sandbox</div>
            <p style="color: var(--ink-2); font-size: 0.88rem; margin-bottom: 1rem;">
                Test the exact Root Cause Analysis weighted scoring algorithm: $S = 0.35 \\cdot Z_{cpu} + 0.25 \\cdot Z_{mem} + 0.30 \\cdot ErrRate + 0.10 \\cdot Deg$:
            </p>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 12px;">
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">CPU Z-Score (0 - 5)</label>
                    <input type="number" step="0.1" id="rca-cpu" value="3.8" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); margin-top: 4px;">
                </div>
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">Mem Z-Score (0 - 5)</label>
                    <input type="number" step="0.1" id="rca-mem" value="1.2" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); margin-top: 4px;">
                </div>
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">Error Rate (0 - 1)</label>
                    <input type="number" step="0.01" id="rca-err" value="0.18" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); margin-top: 4px;">
                </div>
                <div>
                    <label style="font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase;">In-Degree Centrality</label>
                    <input type="number" id="rca-deg" value="5" style="width: 100%; background: var(--bg); border: 1px solid var(--rule); color: var(--ink); padding: 8px; border-radius: 4px; font-family: var(--mono); margin-top: 4px;">
                </div>
            </div>
            <button onclick="calculateRcaScore()" class="lab-btn">Evaluate RCA Incident Score 🚨</button>
            <div id="rca-output" class="lab-output" style="margin-top: 12px;">
                <span style="color: var(--muted);">Click to evaluate whether this service triggered a primary root-cause alert.</span>
            </div>
        </div>
        """
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

def generate_index_html():
    top_bar = build_top_bar(None, 0)
    master_flowchart = build_master_architecture_flowchart_html()
    
    groups = {}
    for doc in DOCS_CONFIG[2:]: # Skip index and architecture-map in sub-lists
        cat = doc["category"]
        if cat not in groups:
            groups[cat] = []
        groups[cat].append(doc)

    catalog_html = []
    for cat, docs in groups.items():
        catalog_html.append(f'<h2 id="{slugify(cat)}">{cat}</h2>')
        catalog_html.append('<div class="grid-cards">')
        for d in docs:
            catalog_html.append(f'''<a href="{d["filename"]}" class="feature-card">
                <div>
                    <div class="feature-card-header">
                        <span class="badge badge-{d["badge_color"]}">{d["badge"]}</span>
                        <span style="font-size: 0.72rem; color: var(--muted); font-family: var(--mono);">{d["filename"]}</span>
                    </div>
                    <div class="feature-card-title">{escape_html(d["title"])}</div>
                    <div class="feature-card-desc">{escape_html(d["desc"])}</div>
                </div>
                <div class="feature-card-footer">
                    <span>Explore Document</span>
                    <span>→</span>
                </div>
            </a>''')
        catalog_html.append('</div>')
    
    catalog_content = "\n".join(catalog_html)

    html_page = f"""<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>Microservice Mapper | Visual Wiki & Interactive Master Hub</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
    <style>{CSS_STYLES}</style>
</head>
<body>
    <div class="wrap">
        {top_bar}

        <header class="hd">
            <div class="eye">Autonomous Observability &middot; Visual Reference &middot; 2026</div>
            <h1>Microservice Mapper</h1>
            <p class="lead">
                The authoritative visual reference, engineering manual, and interactive learning visualizer for Microservice Mapper — an autonomous, zero-instrumentation observability platform for Docker microservices on AWS EC2.
            </p>
            <div class="strip">
                <div class="m"><div class="v">37</div><div class="k">Interactive documentation modules</div></div>
                <div class="m ok"><div class="v">5.0 s</div><div class="k">Continuous telemetry loop & pulse</div></div>
                <div class="m"><div class="v">3 Tiers</div><div class="k">Data provenance (Kernel / Logs / Prom)</div></div>
                <div class="m ok"><div class="v">97&times;</div><div class="k">Tail CSV feature table read speedup</div></div>
            </div>
            <nav class="toc">
                <a href="#master-architecture-map">01 Master Architecture Flowchart</a>
                <a href="#interactive-topology-lab">02 Live Multi-Mode Sandbox</a>
                <a href="#chronological-architecture-guide">03 Chronological Progression</a>
                <a href="#documentation-directory">04 Documentation Catalog</a>
            </nav>
        </header>

        <!-- Master Interactive Architecture Flowchart -->
        <section id="master-architecture-map">
            <h2><span class="id">01</span> End-to-End System Architecture Flowchart</h2>
            <p class="lead">
                Every subsystem mapped out with directional data flows. Click any card below to navigate directly into its specific deep-dive documentation:
            </p>
            {master_flowchart}
        </section>

        <!-- Master Multi-Mode Topology Simulator matching Screenshots -->
        <section id="interactive-topology-lab">
            <h2><span class="id">02</span> Master Multi-Mode Topology Simulator & Sandbox</h2>
            <p class="lead">Interactive simulator reproducing the 2D XYFlow graph, 2D Circular Ring, and 3D Spatial Canvas layouts with live packet animators and failure injection:</p>

            <div class="interactive-lab">
                <div class="lab-title">🎮 Live Multi-Mode Topology Sandbox</div>
                <p style="color: var(--ink-2); font-size: 0.88rem; margin-bottom: 1rem;">
                    Watch live request packet pulses travel between services. Click fault injection to watch status halos, CPU meters, and RCA propagation respond in real time:
                </p>

                <div style="background: var(--panel-2); border-radius: 8px; padding: 1rem; border: 1px solid var(--rule); margin-bottom: 1.2rem; position: relative;">
                    <canvas id="topo-canvas" style="width: 100%; display: block;"></canvas>
                </div>

                <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                    <button id="topo-btn-fault" class="lab-btn" style="background: var(--err); color: #fff;">⚡ Inject Payment CPU Spike (98.4%)</button>
                    <button id="topo-btn-reset" class="lab-btn" style="background: var(--ok); color: #fff;">✓ Reset Healthy Baseline</button>
                    <div id="topo-status-text" style="font-size: 0.88rem; color: var(--ink-2); margin-left: 10px;">
                        <span style="color: var(--ok); font-weight: bold;">✓ ALL SYSTEMS NORMAL:</span> Zero-instrumentation continuous 5s telemetry pulse active.
                    </div>
                </div>
            </div>
        </section>

        <!-- Chronological Step-by-Step Architecture Guide -->
        <section id="chronological-architecture-guide">
            <h2><span class="id">03</span> The Engineering Progression: "First We Did This, Then We Did This"</h2>
            <p class="lead">
                Understanding the architecture as a logical chronological progression from raw target discovery to automated root-cause intelligence:
            </p>

            <div class="chrono-timeline">
                <div class="chrono-step">
                    <div class="step-num">Step 1 &bull; Infrastructure & Connection Layer</div>
                    <div class="step-title">Zero-Touch SSH Discovery & Docker Compose Parsing</div>
                    <p>
                        <strong>First:</strong> We connect to the target EC2 instance via SSH (<a href="21-connection-layer.html">21-connection-layer.html</a>). The system scans the remote filesystem, locates <code>docker-compose.yml</code>, and extracts the <em>declared</em> microservice architecture without installing any agent packages beforehand.
                    </p>
                </div>

                <div class="chrono-step">
                    <div class="step-num">Step 2 &bull; Data Plane & Daemon Runtime</div>
                    <div class="step-title">Deploy Remote Collector & Extract Host Telemetry</div>
                    <p>
                        <strong>Then:</strong> We spin up the lightweight <code>remote-collector</code> daemon (<a href="07-remote-collector.html">07-remote-collector.html</a>). It hooks into <code>/var/run/docker.sock</code> for live CPU/memory stats, demuxes the Docker 8-byte log framing to stream HTTP access logs, and reads <code>/proc/net/tcp</code> to detect live ESTABLISHED socket connections.
                    </p>
                </div>

                <div class="chrono-step">
                    <div class="step-num">Step 3 &bull; Ingestion Pipeline & Canonical GraphStore</div>
                    <div class="step-title">Ingest Telemetry, Normalize Canonical IDs & Prune Ghosts</div>
                    <p>
                        <strong>Next:</strong> The telemetry envelope streams back via reverse SSH tunnel to the central server (<a href="05-telemetry-ingestion.html">05-telemetry-ingestion.html</a>). The <code>GraphStore</code> executes <code>normalizeId()</code> (<a href="04-id-system.html">04-id-system.html</a>) to eliminate ghost duplicates, merges declared vs observed dependencies, and buffers metrics in circular ring buffers.
                    </p>
                </div>

                <div class="chrono-step">
                    <div class="step-num">Step 4 &bull; Real-Time Frontend & 3D Visualization</div>
                    <div class="step-title">Stream Live Graph State to 2D (XYFlow) & 3D (Three.js) UI</div>
                    <p>
                        <strong>After That:</strong> The server broadcasts updates over WebSockets (<a href="10-websocket.html">10-websocket.html</a>). The React 19 client (<a href="09-frontend.html">09-frontend.html</a>, <a href="24-client-frontend.html">24-client-frontend.html</a>) renders interactive 2D graphs and a Three.js 3D spatial view, animating live packet pulses across active edges.
                    </p>
                </div>

                <div class="chrono-step">
                    <div class="step-num">Step 5 &bull; Intelligence, RCA & Risk Scoring</div>
                    <div class="step-title">Compute Blast Radius & Trace Root Cause Cascades via BFS</div>
                    <p>
                        <strong>Then:</strong> When performance drops, the <code>RiskEngine</code> (<a href="22-risk-engine.html">22-risk-engine.html</a>) computes vulnerability blast radius, and the <code>RCAEngine</code> (<a href="08-rca-engine.html">08-rca-engine.html</a>) evaluates 4-factor scoring across anomalous services, performing BFS propagation to isolate the root cause.
                    </p>
                </div>

                <div class="chrono-step">
                    <div class="step-num">Step 6 &bull; Traffic Generation & Python ML Sidecar</div>
                    <div class="step-title">Automate Traffic Sweeps & Train Unsupervised Anomaly Detectors</div>
                    <p>
                        <strong>Finally:</strong> The <code>TrafficController</code> (<a href="20-traffic-experiments.html">20-traffic-experiments.html</a>) sweeps endpoints to generate synthetic load, while the Python ML sidecar (<a href="11-ml-pipeline.html">11-ml-pipeline.html</a>, <a href="26-ml-pipeline-deep-dive.html">26-ml-pipeline-deep-dive.html</a>) fits IsolationForest models on baseline metrics to uncover subtle metric drift.
                    </p>
                </div>
            </div>
        </section>

        <section id="documentation-directory">
            <h2><span class="id">04</span> Comprehensive Documentation Directory</h2>
            <p class="lead">Explore all 36 numbered documentation modules, complete specifications, and operational manuals:</p>

            {catalog_content}
        </section>

        {build_page_nav_footer(0)}

        <footer>
            Microservice Mapper &mdash; technical reference. Figures measured on live targets, September 2026.
        </footer>
    </div>
    <script>{JS_SCRIPTS}</script>
</body>
</html>"""
    
    out_file = OUTPUT_DIR / "index.html"
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(html_page)
    print(f"Generated {out_file}")

def generate_architecture_map_page():
    """
    Generates the standalone master architecture flowchart page (architecture-map.html).
    """
    doc_info = DOCS_CONFIG[1] # architecture-map
    top_bar = build_top_bar(doc_info, 1)
    flowchart_html = build_master_architecture_flowchart_html()
    page_nav = build_page_nav_footer(1)

    html_page = f"""<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>Master Architecture Flowchart & Interactive Map | Microservice Mapper Wiki</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
    <style>{CSS_STYLES}</style>
</head>
<body>
    <div class="wrap">
        {top_bar}

        <header class="hd">
            <div class="eye">SYSTEM TOPOLOGY &middot; MASTER FLOWCHART MAP &middot; 2026</div>
            <h1>Master Architecture Flowchart</h1>
            <p class="lead">
                Every single subsystem, daemon, database store, intelligence engine, and presentation layer mapped out in an interactive flowchart. Every component is directly linked to its technical documentation and source specifications.
            </p>
            <div class="metadata-strip">
                <span class="badge badge-cyan">INTERACTIVE MAP</span>
                <span class="badge badge-blue">ALL SUBSYSTEMS LINKED</span>
                <span class="meta-item">⏱ ~5 min overview</span>
            </div>
            <nav class="toc">
                <a href="#master-arch-flowchart">01 Complete Architecture Map</a>
                <a href="#data-flow-traces">02 Data Flow Tracing</a>
                <a href="#subsystem-index">03 Subsystem Directory</a>
            </nav>
        </header>

        <section id="master-arch-flowchart">
            <h2><span class="id">01</span> End-to-End Microservice Mapper System Flowchart</h2>
            {flowchart_html}
        </section>

        <section id="data-flow-traces">
            <h2><span class="id">02</span> Key System Data Flow Paths</h2>
            <div class="grid-cards">
                <div class="feature-card">
                    <div class="feature-card-header">
                        <span class="badge badge-cyan">TELEMETRY FLOW</span>
                    </div>
                    <div class="feature-card-title">1. Real-Time Ingestion Path (5s Pulse)</div>
                    <div class="feature-card-desc">
                        <code>EC2 Host</code> &rarr; <code>remote-collector</code> &rarr; <code>Reverse SSH Tunnel (:3001)</code> &rarr; <code>POST /api/ingest</code> &rarr; <code>normalizeId()</code> &rarr; <code>GraphStore</code> &rarr; <code>WebSocket Broadcast</code> &rarr; <code>React 19 (XYFlow & Three.js)</code>.
                    </div>
                    <div class="feature-card-footer">
                        <a href="05-telemetry-ingestion.html">View Ingestion Spec &rarr;</a>
                    </div>
                </div>

                <div class="feature-card">
                    <div class="feature-card-header">
                        <span class="badge badge-red">RCA INCIDENT FLOW</span>
                    </div>
                    <div class="feature-card-title">2. Root Cause & Blast Radius Detection</div>
                    <div class="feature-card-desc">
                        <code>Metric Anomaly (Z-Score &ge; 2.5)</code> &rarr; <code>IncidentManager</code> &rarr; <code>RiskEngine (Betweenness Centrality)</code> &rarr; <code>RCAEngine (4-Factor Formula)</code> &rarr; <code>BFS Reverse Propagation</code> &rarr; <code>INCIDENT_ALERT WS Frame</code>.
                    </div>
                    <div class="feature-card-footer">
                        <a href="08-rca-engine.html">View RCA Engine Spec &rarr;</a>
                    </div>
                </div>

                <div class="feature-card">
                    <div class="feature-card-header">
                        <span class="badge badge-purple">ML DRIFT FLOW</span>
                    </div>
                    <div class="feature-card-title">3. Unsupervised Outlier Detection</div>
                    <div class="feature-card-desc">
                        <code>GraphStore Ring Buffers</code> &rarr; <code>collector.py</code> &rarr; <code>preprocess.py (StandardScaler)</code> &rarr; <code>train.py (IsolationForest)</code> &rarr; <code>score.py</code> &rarr; <code>latest_scores.json</code> &rarr; <code>GET /api/ml/features (Tail CSV)</code>.
                    </div>
                    <div class="feature-card-footer">
                        <a href="11-ml-pipeline.html">View ML Pipeline &rarr;</a>
                    </div>
                </div>
            </div>
        </section>

        {page_nav}

        <footer>
            Microservice Mapper &mdash; technical reference. Figures measured on live targets, September 2026.
        </footer>
    </div>
    <script>{JS_SCRIPTS}</script>
</body>
</html>"""

    out_file = OUTPUT_DIR / "architecture-map.html"
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(html_page)
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

    extra_flowchart = ""
    if doc_info["id"] == "wiki-02-architecture":
        extra_flowchart = f"""
        <section id="interactive-master-flowchart" style="margin: 2rem 0;">
            <h2><span class="id">00</span> Interactive Master Architecture Flowchart</h2>
            <p class="lead">Interactive system diagram with direct links to every subsystem:</p>
            {build_master_architecture_flowchart_html()}
        </section>
        """

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
<body>
    <div class="wrap">
        {top_bar}

        <header class="hd">
            <div class="eye">{escape_html(doc_info["category"])} &middot; TECHNICAL REFERENCE &middot; 2026</div>
            <h1>{escape_html(doc_info["title"])}</h1>
            <p class="lead">{escape_html(doc_info["desc"])}</p>
            <div class="metadata-strip">
                <span class="badge badge-{doc_info["badge_color"]}">{doc_info["badge"]}</span>
                <span class="meta-item">📁 <code>{doc_info["source"]}</code></span>
                <span class="meta-item">⏱ ~{read_time} min read</span>
                <span class="meta-item">📝 {word_count:,} words</span>
            </div>
            {toc_pills}
        </header>

        {extra_interactive_lab}

        {extra_flowchart}

        <article class="doc-body">
            {html_content}
        </article>

        {page_nav}

        <footer>
            Microservice Mapper &mdash; technical reference. Figures measured on live targets, September 2026.
        </footer>
    </div>
    <script>{JS_SCRIPTS}</script>
</body>
</html>"""

    out_file = OUTPUT_DIR / doc_info["filename"]
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(html_page)
    print(f"Generated {out_file}")

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating Wiki Visualizer V4 matching 'Mapper Technical Reference.html' into: {OUTPUT_DIR}")
    
    generate_index_html()
    generate_architecture_map_page()
    
    for idx, doc in enumerate(DOCS_CONFIG):
        if doc["source"] is not None:
            generate_doc_page(doc, idx)
            
    print(f"\nSuccessfully generated {len(DOCS_CONFIG)} documentation pages matching Mapper Technical Reference design in '{OUTPUT_DIR}'!")

if __name__ == "__main__":
    main()
