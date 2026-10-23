import type { DockerPsEntry } from "../discovery/parsers/dockerPs.js";
import { parseLabelsString } from "../discovery/parsers/dockerPs.js";
import { deriveServiceName, buildServiceId } from "../discovery/serviceIdentity.js";

/**
 * Turning container state into node status.
 *
 * Before this existed, a node could only ever be `healthy` or `degraded`
 * (CPU or memory over 80%). A crashed container produces no `docker stats`
 * sample at all, so its node simply kept whatever status it last had - a
 * dead database kept reading "healthy". Nothing anywhere set `critical`,
 * which meant the root-cause engine's strongest signal ("this container
 * exited") could never fire on real data.
 *
 * Kept pure so the decisions are testable without an SSH connection.
 */

export type NodeStatus = "healthy" | "degraded" | "critical" | "unknown";

export interface ContainerHealth {
  status: NodeStatus;
  /** Short machine-readable state: "running", "exited (137)", "restarting"… */
  state: string;
  /** One line a person can read on the node card. */
  reason: string;
  exitCode?: number;
}

/** A restart this recent still counts as an active problem. */
export const RECENT_RESTART_SECONDS = 120;
/** Matches the long-standing resource threshold used for `degraded`. */
export const RESOURCE_DEGRADED_PERCENT = 80;

export interface SampleSignals {
  /** As docker stats reports it: percent of ONE core (can exceed 100). */
  cpuPercent: number | null;
  /** Cores the container may use (its limit, else the host's). When known,
   *  saturation is judged as a share of this rather than of one core. */
  cpuAllowanceCores?: number | null;
  memoryPercent: number | null;
  restartCount: number | null;
  restartDelta: number | null;
  containerState: string | null;
  containerUptimeSeconds: number | null;
}

/**
 * Status for a container that appeared in `docker stats`, i.e. one that is
 * currently running or at least present.
 *
 * Order matters: a crash-looping container is critical whatever its CPU
 * reads, and a container that has just come back from a crash is degraded
 * even if it now looks quiet - the crash is the event worth surfacing.
 */
export function statusFromSample(s: SampleSignals): ContainerHealth {
  const state = (s.containerState ?? "running").toLowerCase();

  if (state === "restarting") {
    return { status: "critical", state: "restarting", reason: "crash-looping: the runtime keeps restarting it" };
  }
  if (state === "dead" || state === "exited") {
    return { status: "critical", state, reason: `container is ${state}` };
  }
  if (state === "paused") {
    return { status: "critical", state: "paused", reason: "container is paused and serving nothing" };
  }

  // restartDelta is the change since the previous poll; uptime catches a
  // restart that landed between two polls or in the first poll after start.
  const restartedNow = (s.restartDelta ?? 0) > 0;
  const restartedRecently =
    (s.restartCount ?? 0) > 0 &&
    s.containerUptimeSeconds !== null &&
    s.containerUptimeSeconds < RECENT_RESTART_SECONDS;
  if (restartedNow || restartedRecently) {
    const when = restartedNow ? "since the last poll" : `${Math.round(s.containerUptimeSeconds!)}s ago`;
    return {
      status: "degraded",
      state: "running",
      reason: `restarted ${when} (restart count ${s.restartCount ?? "?"}) - it crashed and came back`,
    };
  }

  // CPU as a share of what the container is allowed. With the allowance
  // unknown it falls back to docker's per-core figure, as before.
  const allowance = s.cpuAllowanceCores ?? null;
  const cpu = cpuShareOfAllowance(s.cpuPercent, allowance) ?? 0;
  const mem = s.memoryPercent ?? 0;
  if (cpu > RESOURCE_DEGRADED_PERCENT || mem > RESOURCE_DEGRADED_PERCENT) {
    const which = cpu > RESOURCE_DEGRADED_PERCENT
      ? `CPU ${Math.round(cpu)}%${allowance ? ` of its ${formatCores(allowance)} allowance` : ''}`
      : `memory ${Math.round(mem)}%`;
    return { status: "degraded", state: "running", reason: `resource saturation: ${which}` };
  }

  return { status: "healthy", state: "running", reason: "running normally" };
}

/**
 * Status for a service that discovery knows about but that produced no stats
 * sample this cycle, decided from its `docker ps -a` row.
 *
 * Returns null when the row says it is running: a container missing from one
 * stats snapshot but running per `ps` is a race between two commands, not a
 * failure, and should not be reported as one.
 *
 * Exit code 0 is deliberately NOT critical. That is a job that finished -
 * sock-shop keeps a stress job at "Exited (0)" for days - and flagging it
 * would put a permanent false root cause in every incident.
 */
export function statusFromPsRow(row: DockerPsEntry | undefined): ContainerHealth | null {
  if (!row) {
    return { status: "critical", state: "not found", reason: "container no longer exists on the host" };
  }

  const state = String(row.State ?? "").toLowerCase();
  const statusText = String(row.Status ?? "");

  if (state === "running") return null;

  if (state === "restarting") {
    return { status: "critical", state: "restarting", reason: "crash-looping: the runtime keeps restarting it" };
  }
  if (state === "exited" || state === "dead") {
    const match = /Exited \((-?\d+)\)/.exec(statusText);
    const code = match ? Number(match[1]) : undefined;
    if (code === 0) {
      return { status: "unknown", state: "exited (0)", reason: "finished and exited cleanly (a completed job, not a crash)", exitCode: 0 };
    }
    const label = code !== undefined ? `exited (${code})` : state;
    const hint = code === 137 ? " - killed, commonly out of memory" : code === 143 ? " - terminated by signal" : "";
    return { status: "critical", state: label, reason: `container ${label}${hint}`, exitCode: code };
  }
  if (state === "paused") {
    return { status: "critical", state: "paused", reason: "container is paused and serving nothing" };
  }
  if (state === "removing") {
    return { status: "critical", state: "removing", reason: "container is being removed" };
  }
  // "created": never started. Not a crash, and not healthy either.
  return { status: "unknown", state: state || "unknown", reason: `container state is ${state || "unknown"}` };
}

/**
 * Index `docker ps -a` rows by the same service id discovery would give them.
 *
 * Matching by service id rather than container id is what lets a container
 * that compose recreated (new id, same service) read as running instead of
 * crashed. When several containers map to one service, a running one wins -
 * an old exited replica beside a live one is history, not the current state.
 */
export function indexPsRowsByServiceId(targetId: string, entries: DockerPsEntry[]): Map<string, DockerPsEntry> {
  const byService = new Map<string, DockerPsEntry>();
  for (const entry of entries) {
    const name = String(entry.Names ?? "").split(",")[0].trim();
    if (!name) continue;
    const serviceId = buildServiceId(targetId, deriveServiceName(name, parseLabelsString(entry.Labels)));
    const existing = byService.get(serviceId);
    const isRunning = String(entry.State ?? "").toLowerCase() === "running";
    if (!existing || (isRunning && String(existing.State ?? "").toLowerCase() !== "running")) {
      byService.set(serviceId, entry);
    }
  }
  return byService;
}

/**
 * CPU use as a percentage of the cores the container may use, 0..100.
 * docker stats' figure is percent of one core, so 150% on a 2-core allowance
 * is 75% of what it may use. Null when the reading is missing.
 */
export function cpuShareOfAllowance(cpuPercent: number | null | undefined, allowanceCores: number | null | undefined): number | null {
  if (typeof cpuPercent !== "number" || !Number.isFinite(cpuPercent)) return null;
  if (!allowanceCores || allowanceCores <= 0) return cpuPercent;
  return Math.min(100, cpuPercent / allowanceCores);
}

function formatCores(cores: number): string {
  const n = Math.round(cores * 100) / 100;
  return `${n}-core`;
}
