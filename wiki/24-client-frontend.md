# 24 - Client Frontend Architecture & Views

## Overview

The client (`client/src/`) is a React 19 + TypeScript application built with Vite, using React Flow (XYFlow) for the 2D graph and three.js through react-three-fiber for the 3D scene. It provides 11 view tabs, each a different perspective on the monitored systems. What every colour, width and pulse means is in [Reading the picture](33-visual-language.md).

## Technology Stack

- **React 19** with hooks-based architecture
- **Vite** for build tooling
- **React Flow (@xyflow/react)** for 2D graph canvas
- **three.js + @react-three/fiber + drei** for the 3D scene (`components/3d/`)
- **WebSocket** for real-time graph updates and terminal streaming
- **CSS** custom design system (no framework)

## Application Entry Point (App.tsx)

The main `App` component manages:
- **Selected project** (multi-project support with 'ALL' option)
- **Active tab** (3D Vision, Telemetry, Dependencies, etc.)
- **Node/Edge selection** for inspection panels
- **View mode** (combined, architecture, runtime)
- **2D layout algorithm** (clusters, hierarchy, tiers, grid, circle, polygon, radial, spiral)
- **Filter state** (services, databases, queues, gateways, infrastructure)
- **Terminal state** (position, visibility)

## View Tabs

| Tab | Component | Size | Description |
|-----|-----------|------|-------------|
| 3D Vision | `Scene3D` | - | Islands layout: a district per project, a raised platform per role, rate-driven link pulses, HUD with layout / routing / bloom toggles and the consistency chip |
| Graph | `GraphCanvas` + `GraphControls` | - | React Flow 2D graph with layout picker |
| Telemetry | `TelemetryView` | 27KB | Live CPU/memory/network metrics per service |
| Dependencies | `DependenciesView` | 10KB | Edge analysis: declared vs observed |
| TRACES | `TracesView` | 29KB | TCP connection event stream |
| Analytics | `AnalyticsView` | 14KB | Top consumers, most connected nodes |
| RCA / INCIDENTS | `RCAView` | 15KB | Incident details with root cause breakdown |
| EXPERIMENTS | `ExperimentHistoryPanel` | 7KB | Traffic experiment history |
| ML PIPELINE | `MLPipelineView` | **73KB** | Full ML pipeline management |
| FINDINGS | `FindingsView` | 9KB | ML anomaly detection results |
| RELIABILITY | `ReliabilityView` | 15KB | Risk scores and health breakdowns |

## Layout System

Layouts are deterministic functions, not a force simulation, so the picture does not wobble every time data arrives.

**2D** (`layouts2d.ts`): `clusters` (each project separately, stacked by role), `hierarchy` (left to right by dependency depth), `tiers` (shared rows by role), `grid`, `circle`, `polygon`, `radial` (busiest in the middle), `spiral`.

**3D** (`3d/layouts.ts`): `halls`, labelled **Islands**, the default (delegates to `3d/site.ts`); `clusters`, `tiers` and others. The islands layout returns geometry as well as positions (districts, platforms with their heights, tracks between sections that call each other, scenery pads and roads), so the scene can draw the landscape. `tests/logic.test.ts` checks that services stand exactly on their platform, that platforms never overlap, and that tracks appear only between sections that really call each other.

### Layout Stability

A key optimization prevents layout thrashing from telemetry polls:

```typescript
// Layout only depends on topology, not metrics
const layoutSignature2d = useMemo(() => {
  const nodePart = filteredNodes
    .map(n => `${n.id}:${n.type}:${n.project}`)
    .sort().join('|');
  const edgePart = filteredEdges
    .map(e => `${e.source}>${e.target}`)
    .sort().join('|');
  return `${nodePart}||${edgePart}`;
}, [filteredNodes, filteredEdges]);
```

Positions only recompute when topology changes (node added/removed, edge changed), not when metrics update every 5 seconds.

## Multi-Project Support

The `ProjectSections` component renders per-project collapsible sections when "ALL" is selected:

```typescript
const projectIds = useMemo(() => {
  const fromNodes = new Set(
    nodes.map(n => n.data.project).filter(Boolean)
  );
  if (fromNodes.size > 0) return Array.from(fromNodes).sort();
  return targets.map(t => t.targetId).sort();
}, [nodes, targets]);
```

Shows projects from actual nodes first, falls back to registered targets.

## Selection & Highlighting

When a node or edge is selected:
1. The selected item and its neighbors are highlighted (opacity 1)
2. All other items are dimmed (opacity 0.2)
3. An inspection panel opens on the right

```typescript
const highlightedNodeIds = useMemo(() => {
  if (!selectedNodeId && !selectedEdgeId) return null;
  const ids = new Set<string>();
  if (selectedNodeId) {
    ids.add(selectedNodeId);
    edges.forEach(e => {
      if (e.source === selectedNodeId) ids.add(e.target);
      if (e.target === selectedNodeId) ids.add(e.source);
    });
  }
  return ids;
}, [selectedNodeId, selectedEdgeId, edges]);
```

## View Mode Filtering

Three view modes filter edges differently:

| Mode | Shows |
|------|-------|
| `combined` | Edges that are observed OR declared |
| `architecture` | Only declared edges (from compose/config) |
| `runtime` | Only observed edges (from live traffic) |

## Terminal Panel

A floating, draggable terminal panel that:
- Defaults to bottom-right corner
- Auto-clamps left when the inspection sidebar opens (prevents overlap)
- Sends commands to the selected project's target via WebSocket SSH
- Collapsible to a 40px header bar

### Anti-Overlap Logic

```typescript
const INSPECTOR_WIDTH = 400;
const TERMINAL_WIDTH = 300;
const terminalLeft = isInspectorOpen
  ? Math.min(
      terminalPosition.x,
      Math.max(0, window.innerWidth - INSPECTOR_WIDTH - TERMINAL_WIDTH - 16),
    )
  : terminalPosition.x;
```

## Inspection Panels

### Node Inspection (InspectionPanel)
- Hero: name, type, status, and the reason for the status in words
- Live metrics: CPU as a share of its allowance ("· of N cores", raw figure in the tooltip), memory, network **per second** (totals in the tooltip), de-duplicated ports
- Health with its factor breakdown, risk, criticality, cascade probability and the dependency it arrives through
- What-if: re-solves the cascade model with this service failed
- Incident role: root cause, suspect (another candidate), affected, or uninvolved
- Calls / called by, each clickable

### Edge Inspection (EdgeInspectionPanel)
- Evidence chips (`observed`, `declared`, `direction:listen-port`…)
- Weight, with its confidence basis and the caller's share
- Flow: `req/s` where measured, otherwise "2 open · 8 new/min" (distinct connections)
- Latency (p50/p95/p99) and error rate **only** where a request-level source measured them; otherwise an explicit "unknown, and here is why the link has its colour"
- Status code distribution (Tier 1)

## ML Pipeline View (73KB)

The largest single component. Manages the entire ML workflow from the UI:
- **Collector status** - shows whether `collector.py` is running and sample counts
- **Preprocessing** - trigger `preprocess.py`, view normalization stats
- **Training** - configure and run `train.py` with parameter tuning
- **Scoring** - monitor `score.py` live scoring loop
- **Model comparison** - per-detector scores and votes (Isolation Forest, LOF, one-class SVM, z-score); the verdict is a majority vote with the median score

## Real-Time Data Hook (useGraphData)

The `useGraphData` hook manages:
1. **WebSocket connection** to the server
2. **Graph state** (nodes, edges, targets)
3. **Auto-reconnect** on connection loss
4. **Terminal log streaming**
5. **Graph reload** via REST fallback

All data flows through the single WebSocket connection for `graph-update`, `incident.updated`, and `trace-events` messages.

Each `graph-update` replaces the whole graph, but the hook **reuses** every node and edge whose *displayed* values have not changed (CPU to 0.1%, bytes to the MiB, scores to the percent; see `DISPLAY_PRECISION`). React then skips them, so a 50-service canvas re-renders only what visibly moved. Shared objects are tracked with a `WeakMap` keyed by the data object (`hooks/shareById.ts`), which keeps it correct under React StrictMode's double-invoked updaters.

## Sidebar Navigation (Sidebar.tsx - 6KB)

Vertical icon-based sidebar with tabs:
- Each tab shows an icon and label
- Server status indicator (colored dot)
- "Add Project" button for target registration
- Current active tab highlighted
