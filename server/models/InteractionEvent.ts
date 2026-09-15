export interface InteractionEvent {
  id: string;
  timestamp: string;
  source: string;
  target: string;

  protocol?: string;
  method?: string;
  route?: string;

  statusCode?: number | null;
  latency?: number | null;
  latencyMs?: number | null;

  traceId?: string;
  spanId?: string;

  bytesSent?: number | null;
  bytesReceived?: number | null;
  success?: boolean | null;

  evidenceSource: string;
}