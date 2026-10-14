import fs from 'fs';
import path from 'path';

interface ServiceNode {
  id: string;
  name: string;
  type: string;
  project: string;
  status: string;
  metrics?: {
    cpu?: number;
    memory?: number;
    memoryPercent?: number;
    networkRx?: number;
    networkTx?: number;
    latency?: number | null;
    requestRate?: number | null;
    errorRate?: number | null;
  };
  metadata?: {
    containerId?: string;
    restartCount?: number;
    uptime?: string;
    state?: string;
  };
  analytics?: {
    upstreamCount?: number;
    downstreamCount?: number;
  };
}

interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  declared: boolean;
  observed: boolean;
  status: string;
  metrics?: {
    requestCount?: number;
    errorRate?: number;
    latency?: number;
  };
}

interface TelemetryVector {
  serviceId: string;
  serviceName: string;
  project: string;
  timestamp: string;
  // Vector Features
  features: {
    cpuPercent: number;
    memoryPercent: number;
    memoryBytesMB: number;
    networkRxKB: number;
    networkTxKB: number;
    statusCode: number; // 0: healthy, 1: degraded, 2: critical, 3: unknown
    upstreamCount: number;
    downstreamCount: number;
    edgeErrorRate: number;
    edgeLatencyMs: number;
    zScoreCpu: number;
  };
  // Flat Numerical Array Representation
  vector: number[];
}

const FEATURE_HEADER = [
  'cpuPercent',
  'memoryPercent',
  'memoryBytesMB',
  'networkRxKB',
  'networkTxKB',
  'statusCode',
  'upstreamCount',
  'downstreamCount',
  'edgeErrorRate',
  'edgeLatencyMs',
  'zScoreCpu'
];

function statusCodeToNumeric(status: string): number {
  switch (status.toLowerCase()) {
    case 'healthy': return 0;
    case 'degraded': return 1;
    case 'critical': return 2;
    case 'failed': return 2;
    default: return 3;
  }
}

async function exportAndVectorize() {
  const API_BASE = 'http://localhost:3001';
  console.log(`[Vectorization Engine] Connecting to Telemetry Ingestion Server at ${API_BASE}...`);

  try {
    const graphRes = await fetch(`${API_BASE}/api/graph`);
    const statusRes = await fetch(`${API_BASE}/api/status`);
    const incidentsRes = await fetch(`${API_BASE}/api/incidents`);

    if (!graphRes.ok || !statusRes.ok) {
      throw new Error(`Failed to fetch graph data: ${graphRes.statusText}`);
    }

    const graph: { nodes: ServiceNode[]; edges: DependencyEdge[] } = await graphRes.json();
    const statusData = await statusRes.json();
    const incidents = incidentsRes.ok ? await incidentsRes.json() : [];

    const now = new Date().toISOString();
    console.log(`[Vectorization Engine] Fetched ${graph.nodes.length} nodes and ${graph.edges.length} edges.`);

    // 1. Build Combined Parsed Telemetry Data Structure
    const combinedDataset = {
      exportedAt: now,
      systemStatus: statusData.status,
      activeIncidents: incidents.length,
      targetCounts: statusData.targets?.length || 0,
      nodes: graph.nodes,
      edges: graph.edges,
      incidents: incidents
    };

    // 2. Vectorize Each Service Node
    const vectorizedRecords: TelemetryVector[] = [];
    const vectorMatrix: number[][] = [];

    // Compute dynamic population statistics for Z-Scores
    const cpuValues = graph.nodes.map(n => n.metrics?.cpu || 0);
    const meanCpu = cpuValues.length > 0 ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length : 0;
    const varianceCpu = cpuValues.length > 0 ? cpuValues.reduce((a, b) => a + Math.pow(b - meanCpu, 2), 0) / cpuValues.length : 0;
    const stdDevCpu = Math.sqrt(varianceCpu) || 1;

    for (const node of graph.nodes) {
      const cpu = node.metrics?.cpu || 0;
      const memPct = node.metrics?.memoryPercent || 0;
      const memMB = (node.metrics?.memory || 0) / (1024 * 1024);
      const rxKB = (node.metrics?.networkRx || 0) / 1024;
      const txKB = (node.metrics?.networkTx || 0) / 1024;
      const statusNum = statusCodeToNumeric(node.status);
      const upstream = node.analytics?.upstreamCount || 0;
      const downstream = node.analytics?.downstreamCount || 0;

      // Find max edge error rate & latency connected to this node
      let maxErrorRate = 0;
      let maxLatency = 0;
      for (const edge of graph.edges) {
        if (edge.source === node.id || edge.target === node.id) {
          if (edge.metrics?.errorRate && edge.metrics.errorRate > maxErrorRate) {
            maxErrorRate = edge.metrics.errorRate;
          }
          if (edge.metrics?.latency && edge.metrics.latency > maxLatency) {
            maxLatency = edge.metrics.latency;
          }
        }
      }

      // Compute dynamic population Z-Score feature
      const zScoreCpu = (cpu - meanCpu) / stdDevCpu;

      const features = {
        cpuPercent: parseFloat(cpu.toFixed(2)),
        memoryPercent: parseFloat(memPct.toFixed(2)),
        memoryBytesMB: parseFloat(memMB.toFixed(2)),
        networkRxKB: parseFloat(rxKB.toFixed(2)),
        networkTxKB: parseFloat(txKB.toFixed(2)),
        statusCode: statusNum,
        upstreamCount: upstream,
        downstreamCount: downstream,
        edgeErrorRate: parseFloat(maxErrorRate.toFixed(4)),
        edgeLatencyMs: parseFloat(maxLatency.toFixed(2)),
        zScoreCpu: parseFloat(zScoreCpu.toFixed(2))
      };

      const vec = [
        features.cpuPercent,
        features.memoryPercent,
        features.memoryBytesMB,
        features.networkRxKB,
        features.networkTxKB,
        features.statusCode,
        features.upstreamCount,
        features.downstreamCount,
        features.edgeErrorRate,
        features.edgeLatencyMs,
        features.zScoreCpu
      ];

      vectorizedRecords.push({
        serviceId: node.id,
        serviceName: node.name,
        project: node.project,
        timestamp: now,
        features,
        vector: vec
      });

      vectorMatrix.push(vec);
    }

    // 3. Ensure Output Directory Exists
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 4. Save Parsed Combined JSON
    const parsedPath = path.join(dataDir, 'parsed_telemetry_combined.json');
    fs.writeFileSync(parsedPath, JSON.stringify(combinedDataset, null, 2), 'utf8');
    console.log(`✓ Saved Combined Telemetry JSON: ${parsedPath}`);

    // 5. Save Vectorized JSON
    const vectorizedPath = path.join(dataDir, 'vectorized_telemetry_matrix.json');
    fs.writeFileSync(vectorizedPath, JSON.stringify({
      exportedAt: now,
      featureHeader: FEATURE_HEADER,
      vectorDimensions: [vectorMatrix.length, FEATURE_HEADER.length],
      records: vectorizedRecords,
      matrix: vectorMatrix
    }, null, 2), 'utf8');
    console.log(`✓ Saved Vectorized Telemetry JSON: ${vectorizedPath}`);

    // 6. Save Vectorized CSV Matrix
    const csvPath = path.join(dataDir, 'vectorized_telemetry_matrix.csv');
    const csvRows = [
      ['serviceId', 'serviceName', 'project', ...FEATURE_HEADER].join(','),
      ...vectorizedRecords.map(r => [
        `"${r.serviceId}"`,
        `"${r.serviceName}"`,
        `"${r.project}"`,
        ...r.vector
      ].join(','))
    ];
    fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
    console.log(`✓ Saved Vectorized Telemetry CSV: ${csvPath}`);

    console.log(`\n==================================================`);
    console.log(`Successfully Processed & Vectorized Telemetry Data!`);
    console.log(`Matrix Shape: [${vectorMatrix.length} services × ${FEATURE_HEADER.length} features]`);
    console.log(`==================================================\n`);

  } catch (err) {
    console.error('Vectorization Export Error:', err);
  }
}

exportAndVectorize();
