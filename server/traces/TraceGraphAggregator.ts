import { ConnectionEvent, TraceGraph, TraceGraphEdge } from "./types.js";
import { TraceStore } from "./TraceStore.js";

export class TraceGraphAggregator {
  constructor(private readonly traceStore: TraceStore) {}

  async aggregate(windowSec: number): Promise<TraceGraph> {
    const now = Date.now();
    const since = new Date(now - windowSec * 1000).toISOString();
    const events = await this.traceStore.loadEvents(since);

    const edgeMap = new Map<string, TraceGraphEdge>();
    const nodes = new Set<string>();

    for (const event of events) {
      nodes.add(event.sourceServiceId);
      nodes.add(event.destServiceId);

      const key = `${event.sourceServiceId}->${event.destServiceId}`;
      const existing = edgeMap.get(key);

      if (!existing) {
        edgeMap.set(key, {
          sourceServiceId: event.sourceServiceId,
          destServiceId: event.destServiceId,
          eventCount: 1,
          firstSeen: event.timestamp,
          lastSeen: event.timestamp,
          destPorts: [event.destPort.toString()],
        });
      } else {
        existing.eventCount++;
        if (event.timestamp < existing.firstSeen) existing.firstSeen = event.timestamp;
        if (event.timestamp > existing.lastSeen) existing.lastSeen = event.timestamp;
        if (!existing.destPorts.includes(event.destPort.toString())) {
          existing.destPorts.push(event.destPort.toString());
        }
      }
    }

    return {
      nodes: Array.from(nodes),
      edges: Array.from(edgeMap.values()),
    };
  }
}
