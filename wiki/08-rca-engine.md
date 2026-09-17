# RCA Engine — Root Cause Analysis

**Files:** `server/rca/RCAEngine.ts`, `IncidentManager.ts`, `TemporalAnalyzer.ts`, `ExplanationEngine.ts`, `AnomalyDetector.ts`

---

## What It Does

When services degrade or fail, the RCA engine tries to identify the root cause — the original node that triggered a cascade — by scoring each failing node on multiple evidence factors.

This is **evidence-based scoring**, not ML inference. It's deterministic and explainable. The score tells you "this node is most likely the root cause because it had the earliest anomaly AND it's connected to all the failing downstream services."

---

## Trigger Conditions

`IncidentManager.evaluateTarget(targetId)` is called every 5 seconds (server polling interval). It triggers `RCAEngine.analyzeIncident()` if:
- Any node has `status === 'critical'` or `status === 'degraded'`
- OR the ML pipeline has recorded any anomaly for nodes in this target

If neither condition is met, the result is `{ incidentDetected: false }`.

---

## Scoring Algorithm

For each failing node, a score from 0.0 to ~1.1 is built additively:

### Factor 1: Temporal Precedence (+0.30)

The node whose anomaly was detected earliest gets +0.30. All others get +0.10 if they have an anomaly at all.

```typescript
const earliestNodeId = this.temporalAnalyzer.findEarliestAnomalousNode(targetAnomalies);

if (node.id === earliestNodeId) {
  score += 0.30;  // Most likely root cause
} else if (targetAnomalies.some(a => a.nodeId === node.id)) {
  score += 0.10;  // Anomalous but not first
}
```

**Rationale:** Failure propagates downstream. The node that went anomalous first most likely caused the others. This is the strongest single signal for root cause identification.

### Factor 2: Health Status (+0.35 or +0.15)

```typescript
if (node.status === 'critical' || node.metadata?.state === 'exited') {
  score += 0.35;  // Container process exited — strong signal
} else if (node.status === 'degraded') {
  score += 0.15;  // Resource pressure — weaker signal
}
```

**Rationale:** A container that has actually exited is much more likely to be a root cause than one that's merely running slowly. `state === 'exited'` (from Docker container state) is a definitive indicator of failure.

### Factor 3: Dependency Evidence (+0.20 or +0.05)

```typescript
const connectedEdges = edges.filter(e => e.source === node.id || e.target === node.id);
const hasObservedEdge = connectedEdges.some(e => e.observed);

if (hasObservedEdge) {
  score += 0.20;  // Runtime TCP/HTTP traffic confirms the dependency path
} else if (connectedEdges.some(e => e.declared)) {
  score += 0.05;  // Only Compose-declared — weak circumstantial evidence
}
```

**Rationale:** If we can see actual traffic (observed edge), the causal path is confirmed. A declared-only edge just means "they were supposed to talk" — not that they actually did.

### Factor 4: Downstream Blast Radius (+0.15)

```typescript
const downstreamFailing = edges
  .filter(e => e.source === node.id)
  .filter(e => {
    const target = nodes.find(n => n.id === e.target);
    return target && (target.status === 'critical' || target.status === 'degraded');
  });

if (downstreamFailing.length > 0) {
  score += 0.15;  // More downstream failures = higher root cause probability
}
```

**Rationale:** A true root cause will have cascading downstream failures. A node that's failing in isolation is less likely to be the origin of a cascade.

### Confidence Mapping

| Score | Confidence |
|---|---|
| ≥ 0.75 | `HIGH` |
| ≥ 0.50 | `MEDIUM` |
| > 0.00 | `LOW` |
| 0.00 | `UNKNOWN` |

---

## Propagation Path — BFS

```typescript
private buildPropagationPath(rootCause: ServiceNode, nodes: ServiceNode[], edges: DependencyEdge[]): PropagationStep[] {
  const visited = new Set([rootCause.id]);
  const queue = [rootCause.id];
  const steps: PropagationStep[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    // Only traverse observed edges — declared-only paths are not confirmed
    const outgoing = edges.filter(e => e.source === currentId && e.observed);
    for (const edge of outgoing) {
      const target = nodes.find(n => n.id === edge.target);
      if (!target || visited.has(target.id)) continue;
      visited.add(target.id);
      steps.push({ sourceId: currentId, targetId: target.id, edgeId: edge.id, ... });
      if (target.status === 'critical' || target.status === 'degraded') {
        queue.push(target.id);  // Continue traversal from failing nodes
      }
    }
  }
  return steps;
}
```

**Only observed edges in propagation:** Traversing declared-only edges would follow theoretical architecture paths. We only follow paths where we've actually seen traffic — those are the real propagation routes.

---

## Supporting Components

### `TemporalAnalyzer`

Builds a timeline from `AnomalyRecord[]` objects:

```typescript
buildTimeline(anomalies: AnomalyRecord[]): AnomalyRecord[] {
  return [...anomalies].sort((a, b) =>
    new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime()
  );
}

findEarliestAnomalousNode(anomalies: AnomalyRecord[]): string | null {
  const sorted = this.buildTimeline(anomalies);
  return sorted[0]?.nodeId ?? null;
}
```

### `ExplanationEngine`

Generates a structured natural-language explanation from RCA results:

```typescript
generateExplanation(params: ExplanationParams): RCAExplanation {
  return {
    whatHappened: `${params.affectedServices.length} services are experiencing issues`,
    whenStarted: params.incidentStartedAt,
    likelyRootCause: params.primaryRootCause?.name ?? 'Unknown',
    why: this.buildWhyNarrative(params),
    propagationPath: params.propagationPath.map(s => `${s.sourceId} → ${s.targetId}`),
    affectedServices: params.affectedServices.map(s => s.name),
    confidence: params.confidence,
    alternativeCandidates: params.alternativeCandidates.map(c => ({
      name: c.node.name, score: c.score, confidence: c.confidence
    })),
    evidenceSummary: params.evidence.map(e => e.description),
    recommendedInvestigation: this.buildRecommendations(params),
  };
}
```

### `AnomalyDetector`

Reads `ml/data/latest_scores.json` and converts them to `AnomalyRecord[]`:

```typescript
getAnomalies(targetId: string, nodes: ServiceNode[]): AnomalyRecord[] {
  const scores = readScoresFromDisk();
  return nodes
    .filter(n => n.project === targetId && scores[n.id]?.anomaly_score > threshold)
    .map(n => ({
      nodeId: n.id,
      targetId,
      score: scores[n.id].anomaly_score,
      persistent: scores[n.id].persistent,
      detectedAt: new Date().toISOString(),
    }));
}
```

---

## `IncidentManager` — Lifecycle

```
NORMAL → INCIDENT → RECOVERING → RESOLVED
           ↑                         ↓
           └────── re-opened ─────── ┘ (if failure re-detected during RECOVERING)
```

### Deduplication

Only one incident per target is tracked at a time. If `evaluateTarget()` fires again while an incident is active for the same target, the existing incident is **updated in place** (symptoms appended, confidence refreshed, timestamp updated) rather than creating a duplicate.

### History

Resolved incidents are kept in an in-memory list (last N per target) for display in `RCAView`. They are not persisted to disk between restarts.
