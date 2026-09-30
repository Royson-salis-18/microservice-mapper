# 24 — Client Frontend Architecture & Views

## Overview

The client (`client/src/`) is a React 19 + TypeScript application built with Vite, using React Flow (XYFlow) for 2D graph visualization and Three.js for 3D visualization. It provides 11 distinct view tabs, each showing a different perspective of the monitored microservice systems.

## Technology Stack

- **React 19** with hooks-based architecture
- **Vite** for build tooling
- **React Flow (@xyflow/react)** for 2D graph canvas
- **Three.js** for 3D visualization (`Scene3D`)
- **WebSocket** for real-time graph updates and terminal streaming
- **CSS** custom design system (no framework)

## Application Entry Point (App.tsx)

The main `App` component manages:
- **Selected project** (multi-project support with 'ALL' option)
- **Active tab** (3D Vision, Telemetry, Dependencies, etc.)
- **Node/Edge selection** for inspection panels
- **View mode** (combined, architecture, runtime)
- **2D layout algorithm** (clusters, radial, force, hierarchy, dagre)
- **Filter state** (services, databases, queues, gateways, infrastructure)
- **Terminal state** (position, visibility)

## View Tabs

| Tab | Component | Size | Description |
|-----|-----------|------|-------------|
| 3D Vision | `Scene3D` | - | Three.js 3D graph with orbiting camera |
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

## Layout System (layouts2d.ts)

Five 2D layout algorithms available:

```typescript
type Layout2DId = 'clusters' | 'radial' | 'force' | 'hierarchy' | 'dagre';
```

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

### Node Inspection (InspectionPanel — 21KB)
- Service metadata (container ID, image, ports, uptime)
- Live metrics (CPU, memory, network I/O)
- Health/Risk scores with breakdown
- Connected edges list
- Anomaly score from ML pipeline

### Edge Inspection (EdgeInspectionPanel — 13KB)
- Declared vs observed status
- Evidence sources
- Edge metrics (request count, latency percentiles, error rate)
- Activity rate (samples/min from TCP connections)
- Status code distribution

## ML Pipeline View (73KB)

The largest single component. Manages the entire ML workflow from the UI:
- **Collector status** — shows whether `collector.py` is running and sample counts
- **Preprocessing** — trigger `preprocess.py`, view normalization stats
- **Training** — configure and run `train.py` with parameter tuning
- **Scoring** — monitor `score.py` live scoring loop
- **Model comparison** — cross-model agreement (IsolationForest vs LOF vs OCSVM vs z-score)

## Real-Time Data Hook (useGraphData)

The `useGraphData` hook manages:
1. **WebSocket connection** to the server
2. **Graph state** (nodes, edges, targets)
3. **Auto-reconnect** on connection loss
4. **Terminal log streaming**
5. **Graph reload** via REST fallback

All data flows through the single WebSocket connection for `graph-update`, `incident.updated`, and `trace-events` messages.

## Sidebar Navigation (Sidebar.tsx — 6KB)

Vertical icon-based sidebar with tabs:
- Each tab shows an icon and label
- Server status indicator (colored dot)
- "Add Project" button for target registration
- Current active tab highlighted
