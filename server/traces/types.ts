export interface ConnectionEvent {
  timestamp: string; // ISO-8601
  targetId: string;
  sourceServiceId: string;
  destServiceId: string;
  destPort: number;
  state: string; // e.g., ESTABLISHED, LISTEN
}

export interface TraceGraphEdge {
  sourceServiceId: string;
  destServiceId: string;
  eventCount: number;
  firstSeen: string;
  lastSeen: string;
  destPorts: string[];
}

export interface TraceGraph {
  nodes: string[]; // serviceIds
  edges: TraceGraphEdge[];
}
