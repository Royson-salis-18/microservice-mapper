/**
 * A synthetic target with a known topology and scripted failures.
 *
 * Pushes telemetry envelopes to the mapper's real /api/ingest endpoint - the
 * same GraphStore.ingestRemote() path the SSH collector feeds - so everything
 * downstream runs for real: graph building, edge weights, anomaly detection,
 * root-cause scoring, cascade prediction, the API and the UI.
 *
 * What it is for: the live targets are EC2 hosts that are often stopped, and
 * even when they are up you never know the true root cause of what you see.
 * Here you do. That makes it possible to check the judgement, not just that
 * the pipeline runs: did RCA name the service that was actually broken, and
 * did the cascade model flag the services that actually depend on it?
 *
 * It is a simulation and says so: the target id is `sim-shop`, never a real
 * one, and it should be run against an isolated server (see --help).
 *
 * Usage:
 *   tsx run/scripts/simulate-target.ts --url http://localhost:3099 --token T --scenario db-crash
 *
 * Scenarios:
 *   baseline       everything healthy
 *   db-crash       orders-db dies (exit 137); orders then frontend degrade after it
 *   slow-payment   payment saturates; orders degrades after it
 *   crash-loop     carts-db crash-loops; carts degrades after it
 */

type Status = 'healthy' | 'degraded' | 'critical' | 'unknown';

interface SimService {
  name: string;
  type: 'frontend' | 'service' | 'database' | 'queue';
  baseCpu: number;
  baseMem: number;
}

const DEFAULT_TARGET = 'sim-shop';
/** Set from --target in main(); always starts with "sim-". */
let TARGET = DEFAULT_TARGET;

const SERVICES: SimService[] = [
  { name: 'frontend', type: 'frontend', baseCpu: 18, baseMem: 35 },
  { name: 'catalogue', type: 'service', baseCpu: 12, baseMem: 30 },
  { name: 'carts', type: 'service', baseCpu: 14, baseMem: 40 },
  { name: 'orders', type: 'service', baseCpu: 16, baseMem: 38 },
  { name: 'payment', type: 'service', baseCpu: 8, baseMem: 22 },
  { name: 'shipping', type: 'service', baseCpu: 9, baseMem: 25 },
  { name: 'catalogue-db', type: 'database', baseCpu: 10, baseMem: 55 },
  { name: 'carts-db', type: 'database', baseCpu: 11, baseMem: 50 },
  { name: 'orders-db', type: 'database', baseCpu: 13, baseMem: 60 },
  { name: 'queue', type: 'queue', baseCpu: 6, baseMem: 28 },
];

/** Long-lived connections each link holds open: the truth behind the
 *  mapper's "open connections". */
export const PERSISTENT = 2;
/** How long a closed connection lingers on the caller's side. */
const TIME_WAIT_SEC = 60;
/** Connections each link opens per minute: the truth behind the mapper's
 *  "new connections per minute". A tenth of the link's nominal rate. */
export const newPerMin = (perMin: number) => perMin / 10;
/** A stable address per service, as a container network would give it. */
const ipOf = (name: string) => `10.9.0.${SERVICES.findIndex((s) => s.name === name) + 2}`;

/** caller -> callee, socket samples per minute. */
const CALLS: Array<[string, string, number]> = [
  ['frontend', 'catalogue', 80],
  ['frontend', 'carts', 60],
  ['frontend', 'orders', 40],
  ['orders', 'payment', 30],
  ['orders', 'shipping', 20],
  ['orders', 'orders-db', 90],
  ['carts', 'carts-db', 70],
  ['catalogue', 'catalogue-db', 100],
  ['shipping', 'queue', 15],
];

interface Fault {
  service: string;
  at: number; // seconds from start
  status: Status;
  state: string;
  reason: string;
  cpu?: number;
  mem?: number;
  /** Container gone: no stats sample and no traffic into it. */
  down?: boolean;
}

const SCENARIOS: Record<string, { description: string; rootCause: string | null; faults: Fault[] }> = {
  baseline: { description: 'everything healthy', rootCause: null, faults: [] },
  'db-crash': {
    description: 'orders-db is killed; orders then the frontend degrade as calls to it fail',
    rootCause: 'orders-db',
    faults: [
      { service: 'orders-db', at: 30, status: 'critical', state: 'exited (137)', reason: 'container exited (137) - killed, commonly out of memory', down: true },
      { service: 'orders', at: 40, status: 'degraded', state: 'running', reason: 'resource saturation: CPU 91%', cpu: 91 },
      { service: 'frontend', at: 50, status: 'degraded', state: 'running', reason: 'resource saturation: CPU 88%', cpu: 88 },
    ],
  },
  'slow-payment': {
    description: 'payment saturates; orders degrades waiting on it',
    rootCause: 'payment',
    faults: [
      { service: 'payment', at: 30, status: 'degraded', state: 'running', reason: 'resource saturation: CPU 97%', cpu: 97 },
      { service: 'orders', at: 42, status: 'degraded', state: 'running', reason: 'resource saturation: CPU 86%', cpu: 86 },
    ],
  },
  'crash-loop': {
    description: 'carts-db crash-loops; carts degrades',
    rootCause: 'carts-db',
    faults: [
      { service: 'carts-db', at: 30, status: 'critical', state: 'restarting', reason: 'crash-looping: the runtime keeps restarting it', down: true },
      { service: 'carts', at: 40, status: 'degraded', state: 'running', reason: 'resource saturation: memory 92%', mem: 92 },
    ],
  },
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function jitter(base: number, spread: number): number {
  return Math.max(0, base + (Math.random() * 2 - 1) * spread);
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: tsx run/scripts/simulate-target.ts --url <mapper> --token <ingest token> --scenario <name> [--target sim-<name>] [--duration <s>] [--tick <s>]

Scenarios: ${Object.keys(SCENARIOS).join(', ')}

Run it against an isolated server so the synthetic target never lands in your
real graph data - the server keeps its state in ./data relative to its cwd:

  mkdir -p /tmp/mapper-sim && cd /tmp/mapper-sim
  INGEST_TOKEN=sim PORT=3099 <repo>/server/node_modules/.bin/tsx <repo>/server/index.ts`);
    return;
  }

  const url = arg('url', 'http://localhost:3099')!;
  const token = arg('token', process.env.INGEST_TOKEN ?? 'mapper-secret-token')!;
  const scenarioName = arg('scenario', 'db-crash')!;
  const duration = Number(arg('duration', '90'));
  const tick = Number(arg('tick', '2'));
  // Several can run at once as separate projects. The prefix is enforced so
  // a synthetic target can never share an id with a real one.
  const requestedTarget = arg('target', DEFAULT_TARGET)!;
  if (!requestedTarget.startsWith('sim-')) {
    console.error('--target must start with "sim-", so it can never be mistaken for a real target.');
    process.exit(1);
  }
  TARGET = requestedTarget;
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario "${scenarioName}". Options: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  console.log(`[sim] target=${TARGET} scenario=${scenarioName} - ${scenario.description}`);
  console.log(`[sim] ground truth root cause: ${scenario.rootCause ?? 'none'}`);

  const start = Date.now();
  // Fractional carry so low rates still produce the right number of events.
  const carry = new Map<string, number>();
  /** Per-link socket state: the next ephemeral port, and connections in TIME_WAIT. */
  const links = new Map<string, { nextPort: number; closing: { connKey: string; until: number }[] }>();

  while ((Date.now() - start) / 1000 < duration) {
    const t = (Date.now() - start) / 1000;
    const now = new Date().toISOString();
    const active = new Map(scenario.faults.filter(f => t >= f.at).map(f => [f.service, f]));

    const nodes: any[] = [];
    const metrics: any[] = [];
    for (const s of SERVICES) {
      const fault = active.get(s.name);
      nodes.push({
        id: `${TARGET}:${s.name}`,
        name: s.name,
        type: s.type,
        project: TARGET,
        status: fault?.status ?? 'healthy',
        metadata: {
          state: fault?.state ?? 'running',
          statusReason: fault?.reason ?? 'running normally',
          simulated: true,
        },
      });
      if (fault?.down) continue; // a dead container produces no stats sample
      metrics.push({
        nodeId: `${TARGET}:${s.name}`,
        snapshot: {
          timestamp: now,
          cpu: fault?.cpu !== undefined ? jitter(fault.cpu, 2) : jitter(s.baseCpu, 3),
          memory: 256 * 1024 * 1024,
          memoryPercent: fault?.mem !== undefined ? jitter(fault.mem, 1.5) : jitter(s.baseMem, 2),
          networkRx: 0,
          networkTx: 0,
        },
      });
    }

    const edges: any[] = [];
    const connectionEvents: any[] = [];
    for (const [from, to, perMin] of CALLS) {
      // No connection can be established to a container that is down, so the
      // socket scan would stop seeing this link - exactly what happens live.
      if (active.get(to)?.down || active.get(from)?.down) continue;
      edges.push({
        id: `${TARGET}:${from}->${TARGET}:${to}`,
        source: `${TARGET}:${from}`,
        target: `${TARGET}:${to}`,
        type: 'dependency',
        protocol: 'tcp',
        declared: false,
        observed: true,
        evidenceSources: ['network-tcp', 'direction:listen-port'],
        firstSeen: now,
        lastSeen: now,
        status: 'active',
        metrics: null,
      });
      // Real sockets, as the collector would read them, so what the mapper
      // derives can be checked against known truth: PERSISTENT long-lived
      // connections (seen from both ends every sweep), plus short ones
      // opened at newPerMin(perMin) a minute, each lingering in TIME_WAIT on
      // the caller's side for 60s after it closes.
      const key = `${from}->${to}`;
      const link = links.get(key) ?? { nextPort: 41000, closing: [] as { connKey: string; until: number }[] };
      links.set(key, link);
      const callerIp = ipOf(from), calleeIp = ipOf(to);
      const ev = (connKey: string, state: string) => ({
        timestamp: now, targetId: TARGET,
        sourceServiceId: `${TARGET}:${from}`, destServiceId: `${TARGET}:${to}`,
        destPort: 8080, state, connKey,
      });
      for (let p = 0; p < PERSISTENT; p++) {
        const connKey = `${callerIp}:${40000 + p}>${calleeIp}:8080`;
        connectionEvents.push(ev(connKey, 'ESTABLISHED'), ev(connKey, 'ESTABLISHED'));
      }
      const want = (newPerMin(perMin) * tick) / 60 + (carry.get(key) ?? 0);
      const opened = Math.floor(want);
      carry.set(key, want - opened);
      for (let i = 0; i < opened; i++) link.closing.push({ connKey: `${callerIp}:${link.nextPort++}>${calleeIp}:8080`, until: t + TIME_WAIT_SEC });
      link.closing = link.closing.filter((c) => c.until > t);
      for (const c of link.closing) connectionEvents.push(ev(c.connKey, 'TIME_WAIT'));
    }

    const envelope = {
      schemaVersion: '1.0',
      targetId: TARGET,
      collectorId: 'simulate-target',
      timestamp: now,
      source: 'simulation',
      events: { nodes, metrics, edges, connectionEvents, interactions: [] },
    };

    try {
      const res = await fetch(`${url}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(envelope),
      });
      const faults = [...active.keys()];
      console.log(`[sim] t=${t.toFixed(0).padStart(3)}s ingest ${res.status}  faults: ${faults.length ? faults.join(', ') : 'none'}`);
      if (res.status === 401) {
        console.error('[sim] Unauthorized - pass the server\'s INGEST_TOKEN with --token.');
        process.exit(1);
      }
    } catch (e: any) {
      console.log(`[sim] t=${t.toFixed(0)}s ingest failed: ${e?.message}`);
    }

    await new Promise(r => setTimeout(r, tick * 1000));
  }
  console.log('[sim] done');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
