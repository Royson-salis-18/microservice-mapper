/**
 * v2 diagnose: what to check first, per fault class. Short and concrete, so the operator can start right away.
 * Each entry has a one-line meaning and 2 to 4 checks (a command, then what to look for). <svc> is the suspect service.
 *
 * PURE data plus one helper that fills in the service name.
 */
export interface Runbook { meaning: string; checks: { run: string; lookFor: string }[] }

export const RUNBOOKS: Record<string, Runbook> = {
  crash: {
    meaning: 'The container died with an error and was restarted once.',
    checks: [
      { run: 'docker compose ps -a <svc>', lookFor: 'Exit code and restart count. 137 means killed (often out of memory), 1 means the app exited with an error.' },
      { run: 'docker compose logs --tail=200 <svc>', lookFor: 'The last lines before the restart: a stack trace, a panic, or a failed connection at startup.' },
      { run: 'docker inspect -f "{{.State.OOMKilled}} {{.State.FinishedAt}}" <svc>', lookFor: 'OOMKilled=true points to memory, not a code bug.' },
    ],
  },
  'crash-loop': {
    meaning: 'The container keeps dying and restarting.',
    checks: [
      { run: 'docker compose ps -a <svc>', lookFor: 'Status "Restarting" and a restart count that keeps rising.' },
      { run: 'docker compose logs --tail=300 <svc>', lookFor: 'The same error at every start: missing config, bad env var, a dependency that is down.' },
      { run: 'docker compose config <svc>', lookFor: 'Recent changes to image tag, env, mounts or command.' },
      { run: 'docker compose stop <svc>', lookFor: 'If it hurts its callers, stop it, fix the cause, then start it again.' },
    ],
  },
  stop: {
    meaning: 'The container was stopped cleanly (exit code 0) and is not coming back on its own.',
    checks: [
      { run: 'docker compose ps -a <svc>', lookFor: 'State "exited (0)". A clean exit is usually a person or a script, not a crash.' },
      { run: 'docker events --since 30m --filter container=<svc>', lookFor: 'Who sent the stop or kill, and when.' },
      { run: 'docker compose up -d <svc>', lookFor: 'Start it again, then check that its callers recover.' },
    ],
  },
  pause: {
    meaning: 'The container is frozen (paused). It holds memory but does no work, so callers time out.',
    checks: [
      { run: 'docker compose ps <svc>', lookFor: 'Status "Paused".' },
      { run: 'docker events --since 30m --filter container=<svc> --filter event=pause', lookFor: 'Who paused it.' },
      { run: 'docker compose unpause <svc>', lookFor: 'Traffic and latency of its callers should return within a few seconds.' },
    ],
  },
  flap: {
    meaning: 'The container goes down and up again and again, with short outages.',
    checks: [
      { run: 'docker events --since 30m --filter container=<svc>', lookFor: 'A repeating stop/start or die/start pattern and its period.' },
      { run: 'docker inspect -f "{{json .State.Health}}" <svc>', lookFor: 'A health check that fails and makes an orchestrator or script restart it.' },
      { run: 'docker compose logs --since 30m <svc>', lookFor: 'Graceful shutdown messages between starts, and what triggers them.' },
    ],
  },
  memory: {
    meaning: 'Memory keeps growing (a leak). Expect an out-of-memory kill when it hits the limit.',
    checks: [
      { run: 'docker stats --no-stream <svc>', lookFor: 'MEM USAGE close to LIMIT, and rising between two runs.' },
      { run: 'docker inspect -f "{{.State.OOMKilled}} {{.RestartCount}}" <svc>', lookFor: 'OOMKilled=true or a rising restart count.' },
      { run: 'docker compose logs --since 30m <svc>', lookFor: 'Cache or queue growth, "out of memory", GC warnings.' },
      { run: 'docker compose restart <svc>', lookFor: 'Buys time only. Find the leak before it fills up again.' },
    ],
  },
  brownout: {
    meaning: 'The container is CPU throttled: it runs, but slowly.',
    checks: [
      { run: 'docker stats --no-stream <svc>', lookFor: 'CPU % pinned at the container limit.' },
      { run: 'docker inspect -f "{{.HostConfig.NanoCpus}} {{.HostConfig.CpuQuota}}" <svc>', lookFor: 'A CPU limit that is lower than it should be.' },
      { run: 'cat /sys/fs/cgroup/<container cgroup>/cpu.stat', lookFor: 'nr_throttled and throttled_usec growing fast.' },
      { run: 'docker update --cpus <more> <svc>', lookFor: 'Latency of its callers should drop once the limit is lifted.' },
    ],
  },
  latency: {
    meaning: 'Calls to this service are slow on the network, but the container itself looks healthy.',
    checks: [
      { run: 'docker compose exec <caller> sh -c "time wget -qO- http://<svc>:<port>/health"', lookFor: 'Slow responses from callers, fast ones from inside <svc>.' },
      { run: 'docker compose exec <svc> tc qdisc show', lookFor: 'A netem delay or loss rule on the interface.' },
      { run: 'docker stats --no-stream <svc>', lookFor: 'Normal CPU and memory: the slowness is on the path, not in the app.' },
    ],
  },
  partition: {
    meaning: 'The container is cut off from the network: no traffic in or out, but it is still running.',
    checks: [
      { run: 'docker inspect -f "{{json .NetworkSettings.Networks}}" <svc>', lookFor: 'The compose network is missing from the list.' },
      { run: 'docker network inspect <project>_default', lookFor: 'Whether <svc> is still attached.' },
      { run: 'docker network connect <project>_default <svc>', lookFor: 'Reattach it, then confirm its callers recover.' },
    ],
  },
};

/** The runbook for a class with the suspect's name filled in. */
export function runbookFor(cls: string, service: string): Runbook {
  const rb = RUNBOOKS[cls] ?? { meaning: 'Unknown fault type.', checks: [{ run: 'docker compose ps -a <svc>', lookFor: 'Container state.' }, { run: 'docker compose logs --tail=200 <svc>', lookFor: 'Recent errors.' }] };
  const fill = (s: string) => s.replaceAll('<svc>', service);
  return { meaning: rb.meaning, checks: rb.checks.map((c) => ({ run: fill(c.run), lookFor: fill(c.lookFor) })) };
}
