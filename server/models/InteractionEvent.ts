export interface InteractionEvent {
  id: string;
  timestamp: string;
  source: string;
  target: string;

  protocol?: string;
  method?: string;
  route?: string;

  statusCode?: number;
  latency?: number;

  traceId?: string;
  spanId?: string;

  bytesSent?: number;
  bytesReceived?: number;

  evidenceSource: string;
}