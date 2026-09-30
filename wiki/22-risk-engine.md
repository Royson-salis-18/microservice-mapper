# 22 — Risk Engine & Blast Radius Analysis

## Overview

The Risk Engine (`server/graph/RiskEngine.ts`) computes a **current reliability exposure score** for every service, based on signals that already exist in the graph. Unlike the RCA Engine (which speaks after something has already gone wrong), the Risk Engine identifies services that are still fine but structurally exposed.

## Core Philosophy

> "Every number here traces back to a signal that was actually collected, through arithmetic a person can redo by hand from the same graph."

Two fields on `ServiceNode.analytics` are **deliberately never set**:
- `failureProbability` — needs labelled outcomes ("it failed, N minutes after this pattern")
- `affectedProbability` — same reason

A plausible-looking number in those fields would be indistinguishable from a measured one on screen, which is the specific failure this engine exists to avoid.

## Health Score Computation

Health is computed from three weighted factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| **Status** | 0.60 | Container health: healthy=1.0, degraded=0.5, critical=0.0, unknown=0.5 |
| **Anomaly** | 0.25 | ML anomaly score (1 - score). **Dropped entirely** if no model exists |
| **Incident** | 0.15 | Root cause=0.0, affected=0.3, clean=1.0 |

### Key Detail: Dynamic Weight Renormalization

When a factor has no data (e.g., no ML model trained yet), it is **dropped** and the remaining weights are renormalized:

```typescript
const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
const breakdown = parts.map(p => ({
  factor: p.factor,
  score: round2((p.value * p.weight) / totalWeight),
  reason: p.reason,
}));
```

This prevents inventing an opinion the models never expressed. A missing anomaly score is not "0.5 anomalous" — it's "we don't know."

### healthBreakdown

Every score comes with its `healthBreakdown` — an array of `ScoreContribution` objects showing exactly what produced the number:

```typescript
interface ScoreContribution {
  factor: string;    // e.g. 'status', 'anomaly', 'incident'
  score: number;     // This factor's weighted contribution
  reason: string;    // Human-readable explanation
}
```

This makes `riskScore`/`healthScore` checkable by hand rather than taken on faith.

## Risk Score Formula

```
riskScore = 0.5 × (1 - healthScore) + 0.5 × criticality
```

When criticality is null (no activity data), risk falls back to just `1 - healthScore`.

## Criticality Computation

Criticality measures: **what share of this project's live observed traffic flows through this node's downstream footprint?**

1. Traverse all edges reachable downstream of the node (BFS)
2. Sum the `activity.samplesPerMin` on those edges
3. Divide by total project activity

```typescript
criticality = reachableActivity / totalActivity;
```

- **Null** when the whole project shows zero observed activity (nothing to divide by)
- **Never zero** when a node's own share is genuinely zero — zero is a real measurement

## Centrality

Degree over observed edges, normalized against the busiest node in the same project:

```typescript
centrality = (upstreamCount + downstreamCount) / maxDegreeInProject;
```

Null when the whole project has zero observed edges.

## Blast Radius Analysis

`computeBlastRadius()` answers: **"If this node fails, what is downstream and how dependent is it?"**

### Algorithm

1. BFS traversal from the failing node, following observed edges only
2. For each reachable node, compute:
   - `hopDistance` — how many edges away
   - `inboundActivitySamplesPerMin` — how much traffic flows into this node (null if unmeasured)
   - `dependentShareOfInbound` — what fraction of this node's inbound traffic arrives through the failing node's reachable set

### Key Design: "Unmeasured ≠ Idle"

```typescript
const inboundActivity = measured.length > 0
  ? round2(measured.reduce((sum, e) => sum + activityOf(e), 0))
  : null;  // null = unmeasured, not 0 = idle
```

### Example Output

```json
{
  "nodeId": "sock-shop:orders",
  "nodeName": "orders",
  "project": "sock-shop",
  "basis": "observed-edges",
  "totalReachable": 3,
  "affected": [
    {
      "nodeId": "sock-shop:payment",
      "hopDistance": 1,
      "inboundActivitySamplesPerMin": 42.5,
      "dependentShareOfInbound": 0.95
    }
  ]
}
```

## Project Scoping

All computations are scoped per project:
- Degree and traffic share are only meaningful within one stack
- Ranking a sock-shop service against a death-star one would compare unrelated systems
- An edge crossing two stacks would be a collection artifact, not a dependency

## Direction Caveat

Observed edges come from per-container `/proc/net/tcp` scans, which record `source = the container that was scanned` and `target = the remote peer`. The scan **cannot tell which side opened the connection**, so a database can appear as the source of an edge to its own caller.

Traversal follows source→target to match RCAEngine's propagation path convention.

## Integration with the Polling Cycle

```typescript
// server/index.ts polling cycle:
function runPollingCycle() {
  // 1. Evaluate incidents first
  incidentManager.evaluateTarget(target.targetId);
  
  // 2. Then recompute risk (uses incident results)
  riskEngine.recomputeAll(incidentManager.getAllActiveIncidents());
  
  // 3. Then broadcast (carries updated risk scores)
  wsManager.broadcast('graph-update', graphStore.getGraph());
}
```

Order matters: incidents run first so RiskEngine's "is this node part of an open incident" factor reflects this cycle rather than lagging by one poll.
