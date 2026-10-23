import type { Connection } from "../connection/Connection.js";
import { REMOTE_COMMANDS, NETDEV_MARKER } from "../connection/RemoteCommand.js";
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

/** Exact network counters for one container, and the rate since the last
 *  reading. Rates are null until a second reading exists, never a guess. */
export interface NetworkReading {
  rxBytes: number;
  txBytes: number;
  rxPerSec: number | null;
  txPerSec: number | null;
  /** When this reading was taken (ms since epoch). */
  at: number;
}

/**
 * Sums the byte counters in a /proc/<pid>/net/dev listing across every
 * interface except loopback. Returns null if no interface line parsed.
 *
 *   Inter-|   Receive                            |  Transmit
 *    face |bytes    packets errs drop fifo frame compressed multicast|bytes ...
 *     eth0: 527338211 412345  0  0  0  0  0  0  579104422 ...
 */
export function parseNetDev(text: string): { rxBytes: number; txBytes: number } | null {
  let rx = 0, tx = 0, found = false;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    if (!iface || iface === 'lo' || iface.includes('|')) continue;
    const f = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    rx += f[0];
    tx += f[8];
    found = true;
  }
  return found ? { rxBytes: rx, txBytes: tx } : null;
}

/**
 * Collects one round of container-level telemetry. Network/restart rates
 * are only derived once a second, later sample exists for that service -
 * the first poll after start always has `null` rates, never a guessed 0
 * (spec section 13, section 32).
 */
export class MetricCollector {
  private previous = new Map<string, PreviousSample>();
  private serviceByIp = new Map<string, Service>();
  /** Which service publishes each host port, from docker inspect. A container that calls another through the host's
   *  address (a UI pointed at host:8080, not at the service's own name) shows up as a connection to an address no
   *  container owns, and used to be dropped as an unknown peer. */
  private serviceByHostPort = new Map<number, Service>();
  /** Latest exact network counters per service, from /proc/<pid>/net/dev. */
  readonly network = new Map<string, NetworkReading>();
  /** Container ids already inspected for addresses and CPU limits. */
  private inspected = new Set<string>();
  /** CPU limit per service in cores, from docker inspect; null = unlimited. */
  private cpuLimitCores = new Map<string, number | null>();
  /** Online CPUs on the host, read once per connection. */
  private hostCores: number | null = null;
  private hostCoresRead = false;

  /**
   * How many cores a service may use: its own limit if it has one, else the
   * whole host. docker stats reports CPU as a percentage of ONE core (so
   * 180% is normal on a two-core host), and judging that against a fixed 80%
   * called a service at a fifth of its capacity "saturated" on a four-core
   * host while never flagging one pinned at its half-core limit.
   */
  cpuAllowance(serviceId: string): number | null {
    const limit = this.cpuLimitCores.get(serviceId);
    return limit ?? this.hostCores;
  }

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
      // By container id first; failing that by compose name (<project>-<service>-<n>). A container recreated by a restart, a fault
      // injector or `compose up` gets a new id, and until the next discovery pass it was filed as an unknown-<hash> service: a
      // second node for the same service, with its history and learned baseline starting from nothing each time.
      const service = services.find(s => s.containerId && (s.containerId.startsWith(entry.containerId) || entry.containerId.startsWith(s.containerId)))
        ?? services
          .filter(s => s.name && new RegExp(`(^|[-_])${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-_]\\d+$`).test(entry.name))
          .sort((a, b) => b.name.length - a.name.length)[0];
      const serviceId = service?.serviceId ?? `${this.targetId}:unknown-${entry.containerId.slice(0, 12)}`;
      if (!service) {
        warnings.push(
          `Container ${entry.containerId} (${entry.name}) has no matching discovered service - using ad-hoc serviceId`,
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
        cpuRaw: null, // not available over CLI - see collection/cpu.ts header note

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

  /** Updates a service's exact counters and the rate since its last reading. */
  private recordNetwork(serviceId: string, devText: string): void {
    const parsed = parseNetDev(devText);
    if (!parsed) return;
    const now = Date.now();
    const prev = this.network.get(serviceId);
    let rxPerSec: number | null = null;
    let txPerSec: number | null = null;
    if (prev) {
      const dt = (now - prev.at) / 1000;
      // A counter that went backwards means the container restarted: no rate
      // for this interval rather than a negative or invented one.
      if (dt > 0 && parsed.rxBytes >= prev.rxBytes && parsed.txBytes >= prev.txBytes) {
        rxPerSec = (parsed.rxBytes - prev.rxBytes) / dt;
        txPerSec = (parsed.txBytes - prev.txBytes) / dt;
      }
    }
    this.network.set(serviceId, { ...parsed, rxPerSec, txPerSec, at: now });
  }

  async collectObservedEdges(
    services: Service[],
    warnings: string[] = [],
  ): Promise<{ 
    observedEdges: { source: string; target: string; protocol: 'tcp'; evidenceSources: string[] }[],
    connectionEvents: any[] 
  }> {
    // Every container is inspected once, the first time it is seen. This
    // used to run only while the address map was empty, i.e. on the first
    // scan: a container that started later, or was recreated with a new id
    // and address, was never mapped, and every connection to or from it was
    // dropped as "unknown peer".
    if (!this.hostCoresRead) {
      this.hostCoresRead = true;
      const nproc = await this.connection.execute({ name: 'host.nproc', command: 'nproc', timeoutMs: 5_000, maxOutputBytes: 64 });
      const n = parseInt((nproc.stdout ?? '').trim(), 10);
      this.hostCores = nproc.exitCode === 0 && Number.isInteger(n) && n > 0 ? n : null;
    }
    for (const service of services) {
      if (!service.containerId || this.inspected.has(service.containerId)) continue;
      const inspectRes = await this.connection.execute(REMOTE_COMMANDS.dockerInspect(service.containerId));
      if (inspectRes.exitCode !== 0 || inspectRes.error) continue;
      this.inspected.add(service.containerId);
      try {
        const inspected = JSON.parse(inspectRes.stdout) as Array<{
          NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }>; Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
          HostConfig?: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number };
        }>;
        for (const network of Object.values(inspected[0]?.NetworkSettings?.Networks ?? {})) {
          if (network.IPAddress) this.serviceByIp.set(network.IPAddress, service);
        }
        for (const bindings of Object.values(inspected[0]?.NetworkSettings?.Ports ?? {})) {
          for (const b of bindings ?? []) {
            const hostPort = Number(b.HostPort);
            if (hostPort > 0) this.serviceByHostPort.set(hostPort, service);
          }
        }
        const hc = inspected[0]?.HostConfig ?? {};
        const limit = (hc.NanoCpus ?? 0) > 0
          ? hc.NanoCpus! / 1e9
          : (hc.CpuQuota ?? 0) > 0 && (hc.CpuPeriod ?? 0) > 0 ? hc.CpuQuota! / hc.CpuPeriod! : null;
        this.cpuLimitCores.set(service.serviceId, limit);
      } catch {
        warnings.push(`Could not parse network address for ${service.serviceId}`);
      }
    }

    const observedEdges = new Map<string, { source: string; target: string; protocol: 'tcp'; evidenceSources: string[] }>();
    const connectionEvents: any[] = [];
    const timestamp = new Date().toISOString();

    // count TIME_WAIT (06) too, not just ESTABLISHED (01) - it's the ~60s
    // post-close linger state, so it catches fast request/response cycles
    // that finish between two sweeps (currently 5s apart) and would
    // otherwise never show up. We still record which state we actually
    // saw, not a guess.
    const RELEVANT_TCP_STATES: Record<string, string> = { '01': 'ESTABLISHED', '06': 'TIME_WAIT' };
    const LISTEN_STATE = '0A';

    // Every container is scanned, so each connection is seen twice - once
    // from each end. Recording `scanned -> peer` both times (which is what
    // this did before) produced a reverse duplicate for every real link, so
    // the graph was effectively undirected: A->B and B->A for one dependency.
    // That put a cycle on every pair, which made "downstream of X" reach
    // almost the whole graph and is why blast radius and criticality
    // saturated. It also recorded databases as callers of their own clients.
    //
    // Direction is recovered from listening ports. A TCP connection has a
    // server side (the socket is on its listening port) and a client side (an
    // ephemeral port), so whichever end owns the listening port is the callee
    // - the arrow points at it. LISTEN rows are already in the output this
    // command fetches; they were simply being filtered out and discarded.
    const rawByService = new Map<string, string>();
    const listenPortsByService = new Map<string, Set<number>>();

    for (const service of services) {
      if (!service.containerId) continue;
      const tcpRes = await this.connection.execute(REMOTE_COMMANDS.dockerContainerTcp(service.containerId));
      if (tcpRes.exitCode !== 0 || tcpRes.error) {
        // This used to `continue` in silence, which is how a permanent,
        // 100%-reproducible failure stayed invisible: the frontend's scan
        // failed on every single sweep for weeks (no shell in a distroless
        // image - see dockerContainerTcp) and nothing anywhere said so. A
        // service that can never be scanned produces no edges and no
        // activity, so the graph quietly under-reports instead of
        // reporting that it could not look.
        warnings.push(
          `TCP scan failed for ${service.serviceId}: ${tcpRes.error ?? `exit ${tcpRes.exitCode}`}` +
          `${tcpRes.stdout ? ` - ${tcpRes.stdout.trim().slice(0, 120)}` : ''}`,
        );
        continue;
      }
      // Socket table first, interface counters after the marker.
      const markerAt = tcpRes.stdout.indexOf(NETDEV_MARKER);
      const tcpText = markerAt >= 0 ? tcpRes.stdout.slice(0, markerAt) : tcpRes.stdout;
      if (markerAt >= 0) this.recordNetwork(service.serviceId, tcpRes.stdout.slice(markerAt + NETDEV_MARKER.length));
      rawByService.set(service.serviceId, tcpText);

      const listening = new Set<number>();
      for (const line of tcpText.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts[3] !== LISTEN_STATE) continue;
        const port = parseInt(parts[1]?.split(':')[1] ?? '', 16);
        if (Number.isFinite(port) && port > 0) listening.add(port);
      }
      listenPortsByService.set(service.serviceId, listening);
    }

    for (const service of services) {
      const stdout = rawByService.get(service.serviceId);
      if (!stdout) continue;
      const myListenPorts = listenPortsByService.get(service.serviceId) ?? new Set<number>();

      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const state = RELEVANT_TCP_STATES[parts[3]];
        if (parts.length < 4 || !state) continue;
        const remoteIp = decodeProcNetIp(parts[2]?.split(':')[0] ?? '');
        const localIp = decodeProcNetIp(parts[1]?.split(':')[0] ?? '');
        const localPort = parseInt(parts[1]?.split(':')[1] ?? '', 16);
        const remotePort = parseInt(parts[2]?.split(':')[1] ?? '', 16);
        let peer = this.serviceByIp.get(remoteIp);
        let viaPublishedPort = false;
        // Not a container address: if it is one of the host's own (bridge gateway, private address) and the port is one a
        // service publishes, the call was to that service by way of the host.
        if (!peer && isHostSideAddress(remoteIp)) {
          peer = this.serviceByHostPort.get(remotePort);
          viaPublishedPort = !!peer;
        }
        if (!peer || peer.serviceId === service.serviceId) continue;
        const peerListenPorts = listenPortsByService.get(peer.serviceId) ?? new Set<number>();

        const orientation = orientConnection(localPort, remotePort, myListenPorts, peerListenPorts);
        const callerId = orientation.scannedIsCaller ? service.serviceId : peer.serviceId;
        const calleeId = orientation.scannedIsCaller ? peer.serviceId : service.serviceId;
        const how = orientation.evidence;

        const edgeId = `${callerId}->${calleeId}`;
        const existing = observedEdges.get(edgeId);
        if (existing) {
          // Seen from the other end too, or on another connection. Keep the
          // strongest direction evidence we have for this link.
          if (how === 'direction:listen-port' && !existing.evidenceSources.includes('direction:listen-port')) {
            existing.evidenceSources = existing.evidenceSources
              .filter(s => !s.startsWith('direction:'))
              .concat('direction:listen-port');
          }
        } else {
          observedEdges.set(edgeId, {
            source: callerId,
            target: calleeId,
            protocol: 'tcp',
            evidenceSources: viaPublishedPort ? ['network-tcp', how, 'published-port'] : ['network-tcp', how],
          });
        }

        // The connection's own identity, the same whichever end it was read
        // from: caller ip:port > callee ip:port. A connection appears in both
        // ends' socket tables, and a closed one lingers in TIME_WAIT for about
        // a minute, so counting raw rows counts one connection many times;
        // counting distinct keys counts it once.
        const callerEnd = orientation.scannedIsCaller ? `${localIp}:${localPort}` : `${remoteIp}:${remotePort}`;
        const calleeEnd = orientation.scannedIsCaller ? `${remoteIp}:${remotePort}` : `${localIp}:${localPort}`;

        connectionEvents.push({
          timestamp,
          targetId: this.targetId,
          sourceServiceId: callerId,
          destServiceId: calleeId,
          // The port that identifies the service being called, which is the
          // callee's listening port whichever end we happened to scan from.
          destPort: calleeId === peer.serviceId ? remotePort : localPort,
          state,
          connKey: `${callerEnd}>${calleeEnd}`,
        });
      }
    }

    return {
      observedEdges: Array.from(observedEdges.values()),
      connectionEvents
    };
  }
}

/** Linux default ephemeral range, /proc/sys/net/ipv4/ip_local_port_range. */
const EPHEMERAL_MIN = 32768;
const EPHEMERAL_MAX = 60999;

/**
 * Which end of a TCP connection made the call.
 *
 * A connection has a server side, whose socket sits on the port it listens
 * on, and a client side, which got an ephemeral port from the kernel. The
 * server is the one being called, so the dependency arrow points at it.
 *
 * Observed LISTEN tables are the real evidence and are checked first. The
 * ephemeral range is a fallback for when a container's listen table could not
 * be read at all. When neither settles it, the caller is told so rather than
 * handed a coin flip dressed as a measurement.
 *
 * Exported for tests: this is the decision the whole dependency graph's
 * direction rests on.
 */
export function orientConnection(
  localPort: number,
  remotePort: number,
  scannedListenPorts: Set<number>,
  peerListenPorts: Set<number>,
): { scannedIsCaller: boolean; evidence: 'direction:listen-port' | 'direction:ephemeral-port' | 'direction:unresolved' } {
  const scannedIsServer = scannedListenPorts.has(localPort);
  const peerIsServer = peerListenPorts.has(remotePort);

  if (peerIsServer && !scannedIsServer) return { scannedIsCaller: true, evidence: 'direction:listen-port' };
  if (scannedIsServer && !peerIsServer) return { scannedIsCaller: false, evidence: 'direction:listen-port' };

  const localEphemeral = localPort >= EPHEMERAL_MIN && localPort <= EPHEMERAL_MAX;
  const remoteEphemeral = remotePort >= EPHEMERAL_MIN && remotePort <= EPHEMERAL_MAX;
  if (localEphemeral && !remoteEphemeral) return { scannedIsCaller: true, evidence: 'direction:ephemeral-port' };
  if (remoteEphemeral && !localEphemeral) return { scannedIsCaller: false, evidence: 'direction:ephemeral-port' };

  return { scannedIsCaller: true, evidence: 'direction:unresolved' };
}

/**
 * An address from /proc/net/tcp or tcp6, as dotted IPv4.
 *
 * tcp prints one 32-bit word in host (little-endian) byte order:
 * "0100007F" is 127.0.0.1. tcp6 prints four such words, and a service bound
 * to an IPv6 socket sees its IPv4 peers as IPv4-mapped addresses,
 * ::ffff:a.b.c.d, whose IPv4 part is the *last* word ("0000000000000000
 * FFFF00000100007F"). This used to decode the *first* word, so every mapped
 * address came out as 0.0.0.0, matched no service, and every connection on an
 * IPv6 socket was silently dropped. Genuine IPv6 addresses return '' (no
 * container on these networks has one, so they cannot be a service).
 */
/** An address that belongs to the host rather than to the internet: loopback, link-local, or a private range (which
 *  includes every Docker bridge gateway). Calls to these on a published port are calls to that service. */
export function isHostSideAddress(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function decodeProcNetIp(hex: string): string {
  const word = (w: string) => {
    const bytes = [0, 2, 4, 6].map((offset) => parseInt(w.slice(offset, offset + 2), 16));
    return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
  };
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    const words = hex.toUpperCase().match(/.{8}/g)!;
    if (words[0] === '00000000' && words[1] === '00000000' && words[2] === 'FFFF0000') return word(words[3]);
    return '';
  }
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return '';
  return word(hex);
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
