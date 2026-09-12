import Docker from 'dockerode';
import axios from 'axios';

const MAPPER_URL = process.env.MAPPER_URL;
if (!MAPPER_URL) {
  console.error("CRITICAL: MAPPER_URL is not defined. Refusing to default to localhost. Must specify explicit backend URL.");
  process.exit(1);
}

const INGEST_TOKEN = process.env.INGEST_TOKEN || 'mapper-secret-token';
const TARGET_ID = process.env.TARGET_ID || 'sock-shop-aws';
const ENVIRONMENT = process.env.ENVIRONMENT || 'aws';
const REGION = process.env.REGION || 'ap-south-1';
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL || '5000', 10);

const docker = new Docker();

interface ServiceNode {
  id: string;
  name: string;
  type: string;
  project: string;
  status: string;
  metadata: any;
}

interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  declared: boolean;
  observed: boolean;
  evidenceSources: string[];
  status: string;
}

interface MetricSnapshot {
  timestamp: string;
  cpu?: number;
  memory?: number;
  memoryPercent?: number;
  networkRx?: number;
  networkTx?: number;
}

interface InteractionEvent {
  timestamp: string;
  source: string;
  target: string;
  protocol: string;
  method?: string;
  route?: string;
  statusCode?: number;
  latency?: number;
  bytesSent?: number;
  evidenceSource: string;
}

function determineType(name: string, image: string): string {
  const n = name.toLowerCase();
  const img = image.toLowerCase();
  if (n.includes('db') || img.includes('mongo') || img.includes('mysql') || img.includes('postgres')) return 'database';
  if (n.includes('rabbitmq') || n.includes('queue')) return 'queue';
  if (n.includes('edge-router') || n.includes('gateway') || img.includes('traefik')) return 'gateway';
  if (n.includes('front-end') || n.includes('ui')) return 'frontend';
  return 'service';
}

function calculateCpuPercent(stats: any): number | undefined {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    if (systemDelta > 0 && cpuDelta > 0) {
      return (cpuDelta / systemDelta) * (stats.cpu_stats.online_cpus || 1) * 100;
    }
  } catch (e) {}
  return undefined;
}

function hexToIp(hex: string): string {
  if (hex.length !== 8) return '';
  const a = parseInt(hex.substring(6, 8), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const c = parseInt(hex.substring(2, 4), 16);
  const d = parseInt(hex.substring(0, 2), 16);
  return `${a}.${b}.${c}.${d}`;
}

function demuxDockerLogs(buffer: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) {
      const chunk = buffer.subarray(offset + 8).toString('utf8');
      lines.push(...chunk.split('\n'));
      break;
    }
    const chunk = buffer.subarray(offset + 8, offset + 8 + size).toString('utf8');
    lines.push(...chunk.split('\n'));
    offset += 8 + size;
  }
  if (lines.length === 0 && buffer.length > 0) {
    lines.push(...buffer.toString('utf8').split('\n'));
  }
  return lines;
}

let lastLogCheckTime = Math.floor((Date.now() - 10000) / 1000);

async function extractLogInteractions(): Promise<InteractionEvent[]> {
  const interactionEvents: InteractionEvent[] = [];
  const since = lastLogCheckTime;
  lastLogCheckTime = Math.floor(Date.now() / 1000);

  try {
    const containers = await docker.listContainers({ all: false });
    for (const cInfo of containers) {
      const containerName = cInfo.Names[0].replace(/^\//, '');
      const cleanName = containerName.replace(/^docker-compose-/, '').replace(/-\d+$/, '');
      
      try {
        const container = docker.getContainer(cInfo.Id);
        const logsBuf = await container.logs({
          stdout: true,
          stderr: true,
          since,
          timestamps: false
        });

        const lines = demuxDockerLogs(logsBuf);

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let method: string | undefined = undefined;
          let path: string | undefined = undefined;
          let status: number | undefined = undefined;
          let bytes: number | undefined = undefined;
          let latency: number | undefined = undefined;
          let matched = false;
          let ts = new Date().toISOString();

          // Try JSON format
          if (trimmed.includes('{') && trimmed.includes('}')) {
            try {
              const jsonStr = trimmed.substring(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
              const log = JSON.parse(jsonStr);
              if (log.request || log.uri || log.url) {
                method = log.method || (log.request ? log.request.split(' ')[0] : undefined);
                path = log.uri || log.url || (log.request ? log.request.split(' ')[1] : undefined);
                if (log.status || log.upstream_status) status = parseInt(log.status || log.upstream_status);
                if (log.body_bytes_sent || log.bytes_sent) bytes = parseInt(log.body_bytes_sent || log.bytes_sent);
                if (log.upstream_response_time || log.request_time) latency = (parseFloat(log.upstream_response_time || log.request_time) || 0) * 1000;
                if (log.timestamp) ts = log.timestamp;
                matched = true;

                if (log.upstream_addr) {
                  let targetName = 'unknown';
                  if (log.upstream_addr.includes('9999')) targetName = 'vertikal-auth';
                  else if (log.upstream_addr.includes('3000')) targetName = 'vertikal-rest';
                  if (targetName !== 'unknown') {
                    interactionEvents.push({
                      timestamp: ts,
                      source: `${TARGET_ID}-vertikal-gateway`,
                      target: `${TARGET_ID}-${targetName}`,
                      protocol: 'HTTP',
                      method,
                      route: path,
                      statusCode: status,
                      latency,
                      bytesSent: bytes,
                      evidenceSource: 'http-log'
                    });
                    continue;
                  }
                }
              }
            } catch (e) {}
          }

          // Try standard HTTP access log format: "192.168.1.1 - - [10/Oct/2023] "GET /path HTTP/1.1" 200 123"
          if (!matched) {
            const match = trimmed.match(/^([0-9.]+).*?"([A-Z]+)\s+([^\s]+)\s+HTTP\/[0-9.]+"\s+(\d+|-)?\s+(\d+|-)?/);
            if (match) {
              const remoteIp = match[1];
              method = match[2];
              path = match[3];
              if (match[4] && match[4] !== '-') status = parseInt(match[4]);
              if (match[5] && match[5] !== '-') bytes = parseInt(match[5]);
              matched = true;
              
              const resolvedSource = ipToNameMap.get(remoteIp);
              if (resolvedSource) {
                 sourceName = resolvedSource;
                 targetName = cleanName;
              }
            }
          }

          if (!matched || !path) continue;

          let targetName = cleanName;
          let sourceName = 'external';

          if (cleanName.includes('gateway')) {
            sourceName = 'vertikal-gateway';
            if (path.startsWith('/auth/v1')) targetName = 'vertikal-auth';
            else if (path.startsWith('/rest/v1')) targetName = 'vertikal-rest';
            else if (path.startsWith('/storage/v1')) targetName = 'vertikal-storage';
          } else if (cleanName === 'edge-router' || cleanName === 'front-end') {
            sourceName = cleanName;
            if (path.startsWith('/catalogue')) targetName = 'catalogue';
            else if (path.startsWith('/cart')) targetName = 'carts';
            else if (path.startsWith('/orders')) targetName = 'orders';
            else if (path.startsWith('/login') || path.startsWith('/customers') || path.startsWith('/cards') || path.startsWith('/address')) targetName = 'user';
            else if (path.startsWith('/shipping')) targetName = 'shipping';
          if (targetName === cleanName && sourceName === 'external') {
            sourceName = 'unknown-upstream';
          }

          // Only push if we established a clear source/target relationship or if it's external hitting entrypoint
          if (targetName !== sourceName) {
            interactionEvents.push({
              timestamp: ts,
              source: sourceName === 'external' ? 'external' : (sourceName === 'unknown-upstream' ? 'unknown-upstream' : `${TARGET_ID}-${sourceName}`),
              target: `${TARGET_ID}-${targetName}`,
              protocol: 'HTTP',
              method,
              route: path,
              statusCode: status,
              latency,
              bytesSent: bytes,
              evidenceSource: 'http-log'
            });
          }
        }
      } catch (e) {}
    }
  } catch (e) {}

  return interactionEvents;
}

async function discoverAndCollect() {
  const containers = await docker.listContainers({ all: true });
  
  const nodes: ServiceNode[] = [];
  const metrics: { nodeId: string; snapshot: MetricSnapshot }[] = [];
  const ipToNameMap = new Map<string, string>();
  const activeContainerNames = new Set<string>();

  for (const containerInfo of containers) {
    const name = containerInfo.Names[0].replace(/^\//, '');
    const image = containerInfo.Image;
    const isRunning = containerInfo.State === 'running';
    
    let friendlyName = name;
    if (name.startsWith('docker-compose-')) {
      friendlyName = name.replace('docker-compose-', '').replace(/-\d+$/, '');
    }
    const id = `${TARGET_ID}-${friendlyName}`;
    activeContainerNames.add(friendlyName);

    if (containerInfo.NetworkSettings?.Networks) {
      for (const net of Object.values<any>(containerInfo.NetworkSettings.Networks)) {
        if (net.IPAddress) {
          ipToNameMap.set(net.IPAddress, friendlyName);
        }
      }
    }
    
    let cpu: number | undefined = undefined;
    let memory: number | undefined = undefined;
    let memoryPercent: number | undefined = undefined;
    let networkRx: number | undefined = undefined;
    let networkTx: number | undefined = undefined;
    
    if (isRunning) {
      try {
        const container = docker.getContainer(containerInfo.Id);
        const stats = await container.stats({ stream: false });
        cpu = calculateCpuPercent(stats);
        if (stats.memory_stats?.usage !== undefined) {
          memory = stats.memory_stats.usage;
          const memLimit = stats.memory_stats.limit || 1;
          memoryPercent = (memory / memLimit) * 100;
        }
        
        if (stats.networks) {
          networkRx = 0;
          networkTx = 0;
          for (const net of Object.values<any>(stats.networks)) {
            networkRx += net.rx_bytes || 0;
            networkTx += net.tx_bytes || 0;
          }
        }
      } catch (e) {}
    }
    
    let status = isRunning ? 'healthy' : 'critical';
    if (cpu !== undefined && cpu > 80) status = 'degraded';
    if (memoryPercent !== undefined && memoryPercent > 80) status = 'degraded';
    if (containerInfo.State.includes('restart')) status = 'critical';

    nodes.push({
      id,
      name: friendlyName,
      type: determineType(name, image),
      project: TARGET_ID,
      status,
      metadata: {
        containerId: containerInfo.Id.substring(0, 12),
        image,
        state: containerInfo.State,
        status: containerInfo.Status
      }
    });
    
    if (isRunning) {
      metrics.push({
        nodeId: id,
        snapshot: {
          timestamp: new Date().toISOString(),
          cpu, memory, memoryPercent, networkRx, networkTx
        }
      });
    }
  }

  const edgesMap = new Map<string, DependencyEdge>();

  // 2. Discover OBSERVED connections via /proc/net/tcp inspection
  const observedPairs = new Set<string>();

  for (const containerInfo of containers) {
    if (containerInfo.State !== 'running') continue;
    const name = containerInfo.Names[0].replace(/^\//, '');
    let friendlyName = name;
    if (name.startsWith('docker-compose-')) {
      friendlyName = name.replace('docker-compose-', '').replace(/-\d+$/, '');
    }

    try {
      const container = docker.getContainer(containerInfo.Id);
      const exec = await container.exec({
        Cmd: ['cat', '/proc/net/tcp'],
        AttachStdout: true,
        AttachStderr: false,
      });
      const stream = await exec.start({});
      let output = '';
      await new Promise((resolve) => {
        stream.on('data', (chunk) => { output += chunk.toString('utf8'); });
        stream.on('end', resolve);
        setTimeout(resolve, 500);
      });

      const lines = output.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4 && parts[3] === '01') { // ESTABLISHED TCP
          const remoteHexIp = parts[2].split(':')[0];
          const remoteIp = hexToIp(remoteHexIp);
          const targetName = ipToNameMap.get(remoteIp);
          if (targetName && targetName !== friendlyName) {
            observedPairs.add(`${friendlyName}->${targetName}`);
          }
        }
      }
    } catch (e) {}
  }

  const isSockShop = TARGET_ID.includes('sock');
  for (const pair of observedPairs) {
    const [src, tgt] = pair.split('->');
    const srcId = isSockShop ? `sock-shop-${src}` : (src.startsWith('vertikal') ? src : `vertikal-${src}`);
    const tgtId = isSockShop ? `sock-shop-${tgt}` : (tgt.startsWith('vertikal') ? tgt : `vertikal-${tgt}`);
    const edgeId = `edge-${srcId}-${tgtId}`;
    
    // We only set observed=true and add network-tcp evidence. We DO NOT invent interaction events.
    edgesMap.set(edgeId, {
      id: edgeId,
      source: srcId,
      target: tgtId,
      type: 'dependency',
      declared: false,
      observed: true,
      evidenceSources: ['network-tcp'],
      status: 'active',
    });
  }

  // 3. Extract REAL HTTP interaction log events
  const realInteractionEvents = await extractLogInteractions();

  return { nodes, edges: Array.from(edgesMap.values()), metrics, events: realInteractionEvents };
}

async function start() {
  console.log(`Starting remote collector for ${TARGET_ID} in ${ENVIRONMENT}/${REGION}`);
  
  let PUBLIC_IP = 'unknown';
  try {
    const ipRes = await axios.get('http://checkip.amazonaws.com', { timeout: 2000 });
    PUBLIC_IP = ipRes.data.trim();
  } catch(e) {
    console.log('Failed to fetch public IP from checkip.amazonaws.com');
  }
  
  let retryCount = 0;

  const loop = async () => {
    try {
      const payload = await discoverAndCollect();
      const body = {
        schemaVersion: '1.0',
        targetId: TARGET_ID,
        collectorId: `docker-collector-${TARGET_ID}`,
        hostIp: PUBLIC_IP,
        timestamp: new Date().toISOString(),
        source: 'remote-collector',
        capabilities: ['metrics', 'docker-discovery', 'network-tcp-inference', 'http-logs'],
        events: {
          nodes: payload.nodes,
          edges: payload.edges,
          metrics: payload.metrics,
          interactions: payload.events
        }
      };
      
      await axios.post(`${MAPPER_URL}/api/ingest`, body, {
        headers: { Authorization: `Bearer ${INGEST_TOKEN}` }
      });
      console.log(`Ingested ${payload.nodes.length} nodes, ${payload.edges.length} edges, ${payload.events.length} interaction events`);
      
      retryCount = 0;
      setTimeout(loop, POLLING_INTERVAL);
    } catch (e: any) {
      retryCount++;
      const backoff = Math.min(1000 * Math.pow(2, retryCount), 60000);
      console.error(`Ingest failed: ${e.message}. Retrying in ${backoff}ms...`);
      setTimeout(loop, backoff);
    }
  };

  loop();
}

start().catch(console.error);
