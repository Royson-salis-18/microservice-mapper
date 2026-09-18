/**
 * Every remote command run against a target must go through this
 * abstraction. No arbitrary shell strings from user input are executed
 * without being wrapped as a named, bounded, auditable RemoteCommand.
 */

export interface RemoteCommandResult<T = unknown> {
  name: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  parsed?: T;
  error?: string;
}

export interface RemoteCommand<T = unknown> {
  /** Human-readable, logged name — e.g. "docker.ps" */
  name: string;
  /** The literal command to execute. No string interpolation of raw user input. */
  command: string;
  /** Hard timeout in ms. Command is killed if it exceeds this. */
  timeoutMs: number;
  /** Max bytes of stdout/stderr retained (protects against unbounded output). */
  maxOutputBytes: number;
  /** Structured parser turning raw stdout into a typed result. */
  parser?: (stdout: string) => T;
}

/** Registry of known-safe, pre-defined commands (spec section 5 & 6). */
export const REMOTE_COMMANDS = {
  unameAll: (): RemoteCommand<string> => ({
    name: "uname.all",
    command: "uname -a",
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    parser: (out) => out.trim(),
  }),
  hostname: (): RemoteCommand<string> => ({
    name: "hostname",
    command: "hostname",
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
    parser: (out) => out.trim(),
  }),
  dateUtc: (): RemoteCommand<string> => ({
    name: "date.utc",
    command: "date -u +%Y-%m-%dT%H:%M:%S.%3NZ",
    timeoutMs: 5_000,
    maxOutputBytes: 256,
    parser: (out) => out.trim(),
  }),
  // Timeouts below are sized for a host under heavy load, not a healthy one.
  // These are all round-trips to a Docker daemon that competes with the
  // containers it's running: on a swap-thrashing 2GB box with ~18 JVM
  // services, `docker ps` was measured at 45s and `docker inspect` at ~3s.
  // A timeout shorter than that doesn't degrade gracefully — discovery
  // returns zero services and the whole target disappears from the graph.
  dockerVersion: (): RemoteCommand<string> => ({
    name: "docker.version",
    command: "docker version --format '{{json .}}' 2>&1",
    timeoutMs: 20_000,
    maxOutputBytes: 16_384,
  }),
  dockerPs: (): RemoteCommand<string> => ({
    name: "docker.ps",
    command: "docker ps --no-trunc --format '{{json .}}'",
    timeoutMs: 90_000,
    maxOutputBytes: 262_144,
  }),
  dockerInspect: (containerId: string): RemoteCommand<string> => ({
    name: "docker.inspect",
    command: `docker inspect ${sanitizeContainerId(containerId)}`,
    timeoutMs: 20_000,
    maxOutputBytes: 262_144,
  }),
  dockerStats: (): RemoteCommand<string> => ({
    name: "docker.stats",
    command:
      "docker stats --no-stream --no-trunc --format '{{json .}}'",
    timeoutMs: 30_000,
    maxOutputBytes: 262_144,
  }),
  dockerNetworkInspect: (network: string): RemoteCommand<string> => ({
    name: "docker.network.inspect",
    command: `docker network inspect ${sanitizeContainerId(network)}`,
    timeoutMs: 10_000,
    maxOutputBytes: 262_144,
  }),
  dockerLogs: (
    containerId: string,
    sinceIso: string,
    tailLines: number,
  ): RemoteCommand<string> => ({
    name: "docker.logs",
    command: `docker logs --timestamps --since ${sanitizeIso(
      sinceIso,
    )} --tail ${sanitizeTail(tailLines)} ${sanitizeContainerId(containerId)}`,
    timeoutMs: 15_000,
    maxOutputBytes: 5_000_000,
  }),
  ssLtnp: (): RemoteCommand<string> => ({
    name: "ss.ltnp",
    command: "ss -ltnp 2>&1",
    timeoutMs: 8_000,
    maxOutputBytes: 65_536,
  }),
  dockerInspectLite: (containerId: string): RemoteCommand<string> => ({
    name: "docker.inspect.lite",
    command: `docker inspect --format '{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}' ${sanitizeContainerId(
      containerId,
    )}`,
    timeoutMs: 8_000,
    maxOutputBytes: 1_024,
  }),
  /**
   * A container's socket table, read from the HOST rather than from inside
   * the container.
   *
   * This used to run `docker exec <id> sh -c 'cat /proc/net/tcp ...'`, which
   * silently returned nothing for any image without a shell. That is not an
   * edge case: the OpenTelemetry demo's `frontend` runs
   * ghcr.io/open-telemetry/demo:3.0.0-frontend, a distroless image whose
   * entrypoint is /nodejs/bin/node and which has no `sh` at all, so every
   * scan of it failed with exit 127 ("exec: sh: executable file not found").
   * collectObservedEdges treats a non-zero exit as "skip this service", so
   * frontend's outbound connections were invisible 100% of the time —
   * permanently, not intermittently.
   *
   * That mattered more than it sounds: frontend is the service that actually
   * calls cart / currency / checkout / shipping / product-catalog when it
   * serves /api/*. So none of those edges could ever be observed, none could
   * ever be discovered from traffic, and no amount of load would ever make
   * them light up — which is exactly the "stress doesn't show in the edges"
   * and "several edges are missing" symptoms.
   *
   * Reading /proc/<hostPid>/net/tcp from the host is the same data (the file
   * is per network namespace either way) and needs nothing whatsoever inside
   * the container, so it works for distroless, scratch and normal images
   * alike. Verified on the live host: no sudo required, and the output
   * format is byte-identical to the old command's, so the parser downstream
   * is unchanged.
   */
  dockerContainerTcp: (containerId: string): RemoteCommand<string> => ({
    name: "docker.container.tcp",
    // `if` rather than `a && b && c` on purpose: a stopped container reports
    // PID 0, and that should read as "no connections" (exit 0, empty output),
    // which is true, not as a scan failure the caller warns about.
    command: `PID=$(docker inspect ${sanitizeContainerId(containerId)} --format '{{.State.Pid}}' 2>/dev/null); if [ -n "$PID" ] && [ "$PID" != "0" ]; then cat /proc/$PID/net/tcp /proc/$PID/net/tcp6 2>&1; fi`,
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
  }),
  catFile: (path: string): RemoteCommand<string> => ({
    name: "cat.file",
    command: `cat ${sanitizePath(path)} 2>&1`,
    timeoutMs: 5_000,
    maxOutputBytes: 1_000_000,
  }),
} as const;

// --- Minimal sanitizers: only allow the identifier shapes Docker itself
// produces (container IDs, names, network names). Reject anything else. ---

function sanitizeContainerId(id: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
    throw new Error(`Refusing to build command: unsafe identifier "${id}"`);
  }
  return id;
}

// Strict ISO-8601. Date.parse() is NOT sufficient here: V8 accepts
// non-ISO formats with trailing garbage, so `Date.parse("Jan 1 2026
// $(whoami)")` succeeds and the payload reaches the remote shell through
// `docker logs --since`. This value is currently computed server-side, but a
// sanitizer whose whole job is blocking injection must not depend on the
// caller staying trustworthy.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function sanitizeIso(iso: string): string {
  if (typeof iso !== "string" || !ISO_8601.test(iso) || Number.isNaN(Date.parse(iso))) {
    throw new Error(`Refusing to build command: invalid ISO timestamp "${iso}"`);
  }
  return iso;
}

function sanitizePath(path: string): string {
  // Absolute paths only, no shell metacharacters, no "..".
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes("..")) {
    throw new Error(`Refusing to build command: unsafe path "${path}"`);
  }
  return path;
}

function sanitizeTail(tail: number): number {
  if (!Number.isInteger(tail) || tail <= 0 || tail > 100_000) {
    throw new Error(`Refusing to build command: unsafe tail line count "${tail}"`);
  }
  return tail;
}
