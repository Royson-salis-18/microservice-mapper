import type { ServiceNode } from '../models/ServiceNode.js';

/**
 * What the container runtime says about a service, as one fact. PURE.
 *
 * Both collection paths feed this: the SSH path writes states like "exited (137)" or "exited (0)", the push collector writes
 * plain "exited" plus an exit code. Before this, the detector and the RCA engine each matched raw strings, so a crashed
 * container ("exited (137)") was not hard evidence for the RCA engine, while a job that finished cleanly ("Exited (0)")
 * or a load generator someone switched off was reported as a failure.
 *
 *   down              exited with a non-zero code, dead, removed, or vanished while the rest of the host still reports
 *   paused / restarting
 *   detached          running, but attached to no network
 *   benign            stopped on purpose or never meant to run: finished cleanly (exit 0), created but never started,
 *                     or a load generator (traffic is started and stopped by people, not by faults)
 *   null              running normally, or nothing is known
 */
export type ContainerFact = 'down' | 'paused' | 'restarting' | 'detached' | 'benign' | null;

const LOAD_GENERATOR = /(^|[-_])(traffic|user-sim|usersim|load-?gen|loadgenerator|locust|k6|jmeter|gatling|stress|wrk2?|siege|vegeta|artillery)([-_]|$)/i;

export function exitCodeOf(n: ServiceNode): number | null {
  const m = n.metadata as any;
  if (typeof m?.exitCode === 'number') return m.exitCode;
  const s = `${m?.state ?? ''} ${m?.status ?? ''}`;
  const hit = /exited \((\d+)\)/i.exec(s);
  return hit ? Number(hit[1]) : null;
}

export function containerFact(n: ServiceNode): ContainerFact {
  const m = (n.metadata ?? {}) as any;
  const state = String(m.state ?? '').toLowerCase();
  const base = state.split(/[\s(]/)[0];
  if (m.networkDetached && base === 'running') return 'detached';
  if (base === 'paused') return 'paused';
  if (base === 'restarting') return 'restarting';
  if (base === 'created') return 'benign';
  if (base === 'exited' || base === 'dead' || base === 'removing' || state === 'not found' || m.vanished) {
    if (LOAD_GENERATOR.test(n.name ?? '')) return 'benign';
    if (base === 'exited' && exitCodeOf(n) === 0) return 'benign';
    return 'down';
  }
  // No runtime state at all, but the source marked it critical (for example: listed by the compose file, absent from docker ps).
  if (!base && n.status === 'critical') return 'down';
  return null;
}
