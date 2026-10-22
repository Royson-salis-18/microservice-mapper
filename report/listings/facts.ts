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
