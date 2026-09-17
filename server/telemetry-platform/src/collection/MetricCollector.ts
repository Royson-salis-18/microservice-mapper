import type { Connection } from "../connection/Connection.js";
import { REMOTE_COMMANDS } from "../connection/RemoteCommand.js";
import { parseDockerStats, parseDockerInspectLite } from "./parsers/dockerStats.js";
import type { ContainerMetricSample } from "../types/metrics.js";
import type { Service } from "../types/service.js";
import type { InteractionEvent } from "../types/interactions.js";

export interface MetricCollectionResult {
  samples: ContainerMetricSample[];
  observedEdges: { source: string; target: string; protocol: 'tcp'; evidenceSources: string[] }[];
  interactions: InteractionEvent[];
  connectionEvents: any[];
  warnings: string[];
}

/** Per-service state needed to derive rates across polls. */
interface PreviousSample {
  timestamp: string;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  restartCount: number | null;
}

/**
 * Collects one round of container-level telemetry. Network/restart rates
 * are only derived once a second, later sample exists for that service —
 * the first poll after start always has `null` rates, never a guessed 0
 * (spec section 13, section 32).
 */
export class MetricCollector {
  private previous = new Map<string, PreviousSample>();
  private serviceByIp = new Map<string, Service>();

  constructor(
    private readonly targetId: string,
    private connection: Connection,
  ) {}

  setConnection(connection: Connection): void {
    this.connection = connection;
  }

  /**
   * @param services Known services (from discovery), used to map a
   *   containerId -> stable serviceId. A container running that isn't in
   *   this list still produces a sample, but with serviceId derived
   *   ad-hoc, and a warning is recorded (spec section 48: don't drop
   *   evidence just because it's unexpected).
   */
  async collectOnce(services: Service[]): Promise<MetricCollectionResult> {
    const warnings: string[] = [];
    const now = new Date().toISOString();

    const statsRes = await this.connection.execute(REMOTE_COMMANDS.dockerStats());
    if (statsRes.error || statsRes.exitCode !== 0) {
      warnings.push(`docker stats failed: ${statsRes.error ?? statsRes.stderr}`);
      return { samples: [], observedEdges: [], interactions: [], connectionEvents: [], warnings };
    }

    const { entries, skippedLines } = parseDockerStats(statsRes.stdout);
    if (skippedLines > 0) {
      warnings.push(`Skipped ${skippedLines} unparseable docker stats line(s)`);
    }

    const samples: ContainerMetricSample[] = [];

    for (const entry of entries) {
      const service = services.find(s => s.containerId && (s.containerId.startsWith(entry.containerId) || entry.containerId.startsWith(s.containerId)));
      const serviceId = service?.serviceId ?? `${this.targetId}:unknown-${entry.containerId.slice(0, 12)}`;
      if (!service) {
        warnings.push(
          `Container ${entry.containerId} (${entry.name}) has no matching discovered service — using ad-hoc serviceId`,
        );
      }

      const liteRes = await this.connection.execute(
        REMOTE_COMMANDS.dockerInspectLite(entry.containerId),
      );
      const lite =
        liteRes.exitCode === 0 && !liteRes.error ? parseDockerInspectLite(liteRes.stdout) : null;
      if (!lite) {
        warnings.push(`docker inspect (lite) failed for container ${entry.containerId}`);
      }

      const prev = this.previous.get(serviceId) ?? null;
      const { rxRate, txRate } = computeRates(now, prev, entry.networkRxBytes, entry.networkTxBytes);
      const restartDelta = computeRestartDelta(prev, lite?.restartCount ?? null);
      const uptimeSeconds = computeUptimeSeconds(lite?.state ?? null, lite?.startedAt ?? null, now);

      samples.push({
        timestamp: now,
        collectorReceivedAt: now,
        targetId: this.targetId,
        serviceId,
        containerId: entry.containerId,

        cpuPercent: entry.cpuPercent,
        cpuRaw: null, // not available over CLI — see collection/cpu.ts header note

        memoryBytes: entry.memoryBytes,
        memoryLimitBytes: entry.memoryLimitBytes,
        memoryPercent: entry.memoryPercent,

        networkRxBytes: entry.networkRxBytes,
        networkTxBytes: entry.networkTxBytes,
        networkRxBytesPerSecond: rxRate,
        networkTxBytesPerSecond: txRate,

        pids: entry.pids,
        blockReadBytes: entry.blockReadBytes,
        blockWriteBytes: entry.blockWriteBytes,

        restartCount: lite?.restartCount ?? null,
        restartDelta,

        containerState: lite?.state ?? null,
        containerUptimeSeconds: uptimeSeconds,

        valid: true,
      });

      this.previous.set(serviceId, {
        timestamp: now,
        networkRxBytes: entry.networkRxBytes,
        networkTxBytes: entry.networkTxBytes,
        restartCount: lite?.restartCount ?? null,
      });
    }

    this.serviceByIp.clear();
    for (const service of services) {
      const inspectRes = await this.connection.execute(REMOTE_COMMANDS.dockerInspect(service.containerId!));
      if (inspectRes.exitCode !== 0 || inspectRes.error) continue;
      try {
        const inspected = JSON.parse(inspectRes.stdout) as Array<{ NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }>;
        for (const network of Object.values(inspected[0]?.NetworkSettings?.Networks ?? {})) {
          if (network.IPAddress) this.serviceByIp.set(network.IPAddress, service);
        }
      } catch {
        warnings.push(`Could not parse network address for ${service.serviceId}`);
      }
    }

    const { observedEdges, connectionEvents } = await this.collectObservedEdges(services, warnings);
    const interactions = await this.collectHttpInteractions(services, warnings);

    return { samples, observedEdges, interactions, connectionEvents, warnings };
  }

  private async collectHttpInteractions(services: Service[], warnings: string[]): Promise<InteractionEvent[]> {
    const interactions: InteractionEvent[] = [];
    const since = new Date(Date.now() - 10_000).toISOString();

    for (const service of services) {
      if (!service.containerId) continue;
      const logs = await this.connection.execute(REMOTE_COMMANDS.dockerLogs(service.containerId, since, 500));
      if (logs.exitCode !== 0 || logs.error) continue;

      for (const rawLine of logs.stdout.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const parsed = parseHttpLogLine(line);
        const explicit = parseSockShopServiceInteraction(line, service.serviceId, this.targetId);
        if (explicit) {
          interactions.push(explicit);
          continue;
        }
        if (!parsed) continue;

        const target = parsed.upstreamIp ? this.serviceByIp.get(parsed.upstreamIp) : undefined;
        if (!target || target.serviceId === service.serviceId) continue;

        interactions.push({
          timestamp: parsed.timestamp,
          targetId: this.targetId,
          sourceServiceId: service.serviceId,
          targetServiceId: target.serviceId,
          protocol: 'http',
          method: parsed.method ?? undefined,
          route: parsed.route ?? undefined,
          statusCode: parsed.statusCode ?? undefined,
          latencyMs: parsed.latencyMs ?? undefined,
          bytesSent: parsed.bytesSent ?? undefined,
          bytesReceived: null,
          evidenceSource: 'http-log',
        });
      }
    }

    return interactions;
  }

  async collectObservedEdges(
    services: Service[],
    warnings: string[] = [],
  ): Promise<{ 
    observedEdges: { source: string; target: string; protocol: 'tcp'; evidenceSources: string[] }[],
    connectionEvents: any[] 
  }> {
    if (this.serviceByIp.size === 0) {
      for (const service of services) {
        if (!service.containerId) continue;
        const inspectRes = await this.connection.execute(REMOTE_COMMANDS.dockerInspect(service.containerId));
        if (inspectRes.exitCode !== 0 || inspectRes.error) continue;
        try {
          const inspected = JSON.parse(inspectRes.stdout) as Array<{ NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }>;
          for (const network of Object.values(inspected[0]?.NetworkSettings?.Networks ?? {})) {
            if (network.IPAddress) this.serviceByIp.set(network.IPAddress, service);
          }
        } catch {
          warnings.push(`Could not parse network address for ${service.serviceId}`);
        }
      }
    }

    const observedEdges = new Map<string, { source: string; target: string; protocol: 'tcp'; evidenceSources: string[] }>();
    const connectionEvents: any[] = [];
    const timestamp = new Date().toISOString();

    // count TIME_WAIT (06) too, not just ESTABLISHED (01) — it's the ~60s
    // post-close linger state, so it catches fast request/response cycles
    // that finish between two 1s snapshots and would otherwise never show
    // up. We still record which state we actually saw, not a guess.
    const RELEVANT_TCP_STATES: Record<string, string> = { '01': 'ESTABLISHED', '06': 'TIME_WAIT' };

    for (const service of services) {
      if (!service.containerId) continue;
      const tcpRes = await this.connection.execute(REMOTE_COMMANDS.dockerContainerTcp(service.containerId));
      if (tcpRes.exitCode !== 0 || tcpRes.error) continue;
      for (const line of tcpRes.stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const state = RELEVANT_TCP_STATES[parts[3]];
        if (parts.length < 4 || !state) continue;
        const remoteIp = decodeProcNetIp(parts[2]?.split(':')[0] ?? '');
        const target = this.serviceByIp.get(remoteIp);
        if (!target || target.serviceId === service.serviceId) continue;
        const edgeId = `${service.serviceId}->${target.serviceId}`;
        observedEdges.set(edgeId, {
          source: service.serviceId,
          target: target.serviceId,
          protocol: 'tcp',
          evidenceSources: ['network-tcp'],
        });

        // Parse destPort from the remote address hex (e.g. 0A000001:1F90)
        const remotePortHex = parts[2]?.split(':')[1] ?? '0000';
        const destPort = parseInt(remotePortHex, 16);

        connectionEvents.push({
          timestamp,
          targetId: this.targetId,
          sourceServiceId: service.serviceId,
          destServiceId: target.serviceId,
          destPort,
          state
        });
      }
    }

    return { 
      observedEdges: Array.from(observedEdges.values()), 
      connectionEvents 
    };
  }
}

function decodeProcNetIp(hex: string): string {
  if (hex.length === 32 && /^[0-9a-fA-F]+$/.test(hex)) {
    const groups = hex.match(/.{8}/g) ?? [];
    const bytes = groups.flatMap((group) => [0, 2, 4, 6].map((offset) => parseInt(group.slice(offset, offset + 2), 16)));
    return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
  }
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return '';
  const bytes = [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
}

interface ParsedHttpLog {
  timestamp: string;
  method: string | null;
  route: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  bytesSent: number | null;
  upstreamIp: string | null;
}

function parseHttpLogLine(line: string): ParsedHttpLog | null {
  const timestamp = new Date().toISOString();
  if (line.includes('{') && line.includes('}')) {
    try {
      const json = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
      const request = typeof json.request === 'string' ? json.request.split(' ') : [];
      if (!json.uri && !json.url && !json.request) return null;
      const upstream = typeof json.upstream_addr === 'string' ? json.upstream_addr.split(':')[0] : null;
      const latencyRaw = json.upstream_response_time ?? json.request_time;
      return {
        timestamp: typeof json.timestamp === 'string' ? json.timestamp : timestamp,
        method: json.method ?? request[0] ?? null,
        route: json.uri ?? json.url ?? request[1] ?? null,
        statusCode: json.status !== undefined ? Number(json.status) : json.upstream_status !== undefined ? Number(json.upstream_status) : null,
        latencyMs: latencyRaw !== undefined ? Number(latencyRaw) * 1000 : null,
        bytesSent: json.body_bytes_sent !== undefined ? Number(json.body_bytes_sent) : json.bytes_sent !== undefined ? Number(json.bytes_sent) : null,
        upstreamIp: upstream,
      };
    } catch {
      return null;
    }
  }

  const match = line.match(/^([0-9.]+).*?"([A-Z]+)\s+([^\s]+)\s+HTTP\/[0-9.]+"\s+(\d+|-)\s+(\d+|-)/);
  if (!match) return null;
  return {
    timestamp,
    method: match[2],
    route: match[3],
    statusCode: match[4] === '-' ? null : Number(match[4]),
    latencyMs: null,
    bytesSent: match[5] === '-' ? null : Number(match[5]),
    upstreamIp: null,
  };
}

function parseSockShopServiceInteraction(
  line: string,
  sourceServiceId: string,
  targetId: string,
): InteractionEvent | null {
  const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[^ ]+)/);
  const timestamp = timestampMatch?.[1] ?? new Date().toISOString();
  const source = sourceServiceId.toLowerCase();

  if (source.endsWith(':orders') && /sending payment request/i.test(line)) {
    return {
      timestamp,
      targetId,
      sourceServiceId,
      targetServiceId: `${targetId}:payment`,
      protocol: 'http',
      method: null,
      route: null,
      statusCode: null,
      latencyMs: null,
      bytesSent: null,
      bytesReceived: null,
      success: null,
      evidenceSource: 'application-log',
    };
  }

  if (source.endsWith(':shipping') && /adding shipment to queue/i.test(line)) {
    return {
      timestamp,
      targetId,
      sourceServiceId,
      targetServiceId: `${targetId}:rabbitmq`,
      protocol: 'amqp',
      method: null,
      route: null,
      statusCode: null,
      latencyMs: null,
      bytesSent: null,
      bytesReceived: null,
      success: null,
      evidenceSource: 'application-log',
    };
  }

  return null;
}

function computeRates(
  nowIso: string,
  prev: PreviousSample | null,
  currentRx: number | null,
  currentTx: number | null,
): { rxRate: number | null; txRate: number | null } {
  if (!prev || currentRx === null || currentTx === null) {
    return { rxRate: null, txRate: null };
  }
  if (prev.networkRxBytes === null || prev.networkTxBytes === null) {
    return { rxRate: null, txRate: null };
  }

  const elapsedSeconds = (Date.parse(nowIso) - Date.parse(prev.timestamp)) / 1000;
  if (elapsedSeconds <= 0) return { rxRate: null, txRate: null };

  const rxDelta = currentRx - prev.networkRxBytes;
  const txDelta = currentTx - prev.networkTxBytes;
  return {
    rxRate: rxDelta >= 0 ? rxDelta / elapsedSeconds : null,
    txRate: txDelta >= 0 ? txDelta / elapsedSeconds : null,
  };
}

function computeRestartDelta(
  prev: PreviousSample | null,
  currentRestartCount: number | null,
): number | null {
  if (!prev || currentRestartCount === null || prev.restartCount === null) return null;
  const delta = currentRestartCount - prev.restartCount;
  return delta >= 0 ? delta : null;
}

function computeUptimeSeconds(
  state: string | null,
  startedAt: string | null,
  nowIso: string,
): number | null {
  if (state !== "running" || !startedAt) return null;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  const uptimeMs = Date.parse(nowIso) - startedMs;
  return uptimeMs >= 0 ? uptimeMs / 1000 : null;
}
