import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { GraphStore } from '../graph/GraphStore.js';
import { GraphAnalytics } from '../graph/GraphAnalytics.js';
import type { TelemetryEnvelope } from '../models/index.js';
import { createTraceRouter } from '../traces/TraceRouter.js';

import type { WebSocketManager } from './websocket.js';
import type { IncidentManager } from '../rca/IncidentManager.js';
import type { TrafficController } from '../traffic/TrafficController.js';
import type { ExperimentManager } from '../traffic/ExperimentManager.js';

export function createRouter(graphStore: GraphStore, wsManager?: WebSocketManager, incidentManager?: IncidentManager, trafficController?: TrafficController, experimentManager?: ExperimentManager) {
  const router = Router();
  const analytics = new GraphAnalytics(graphStore);

  router.use('/traces', createTraceRouter(graphStore, wsManager));

  router.get('/graph', (_req, res) => {
    res.json(graphStore.getGraph());
  });

  router.get('/nodes/:id', (req, res) => {
    const node = graphStore.getNode(req.params.id);
    if (node) res.json(node);
    else res.status(404).json({ error: 'Node not found' });
  });

  router.get('/nodes/:id/metrics', (req, res) => {
    const range = (req.query.range as string) || '5m';
    const history = graphStore.metricStore.getHistory(req.params.id, range);
    res.json(history);
  });

  router.get('/traffic', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const events = graphStore.metricStore.getEvents(limit);
    res.json(events);
  });

  router.get('/analytics', (_req, res) => {
    res.json(analytics.getAnalytics());
  });


  router.get('/diagnostics', (_req, res) => {
    const targets = Array.from(graphStore.targets.values());
    const diagnostics = targets.map(target => {
      const nodes = graphStore.nodesByTarget.get(target.targetId);
      const edges = graphStore.edgesByTarget.get(target.targetId);
      return {
        ...target,
        nodeCount: nodes ? nodes.size : 0,
        edgeCount: edges ? edges.size : 0,
      };
    });
    res.json(diagnostics);
  });

  router.get('/targets', (_req, res) => {
    res.json(Array.from(graphStore.targets.values()));
  });

  router.get('/targets/:targetId/diagnostics', (req, res) => {
    const target = graphStore.targets.get(req.params.targetId);
    if (!target) return res.status(404).json({ error: 'Target not found' });
    const nodes = graphStore.nodesByTarget.get(target.targetId);
    const edges = graphStore.edgesByTarget.get(target.targetId);
    res.json({
      ...target,
      nodeCount: nodes ? nodes.size : 0,
      edgeCount: edges ? edges.size : 0,
    });
  });

  // --- ENDPOINT DISCOVERY & SERVICE REGISTRY API ENDPOINTS ---
  router.get('/targets/:targetId/discovery', (req, res) => {
    const summary = graphStore.endpointRegistry.getSummary(req.params.targetId);
    res.json(summary);
  });

  router.get('/targets/:targetId/services', (req, res) => {
    const services = graphStore.endpointRegistry.getServices(req.params.targetId);
    res.json(services);
  });

  router.get('/nodes/:id/logs', async (req, res) => {
    const nodeId = req.params.id;
    const tail = Math.min(parseInt(req.query.tail as string, 10) || 200, 2000);
    const [targetId] = nodeId.split(':');
    const nodesMap = graphStore.nodesByTarget.get(targetId);
    const node = nodesMap?.get(nodeId);
    const containerId = node?.metadata?.containerId;
    if (!containerId) {
      return res.status(404).json({ error: `No container ID known for node ${nodeId}` });
    }
    try {
      const lines = await graphStore.discoveryEngine.getServiceLogs(targetId, containerId, tail);
      res.json({ nodeId, containerId, tail, lines });
    } catch (e: any) {
      res.status(502).json({ error: e.message ?? 'Failed to fetch logs' });
    }
  });

  router.get('/targets/:targetId/endpoints', (req, res) => {
    const publicOnly = req.query.publicOnly === 'true';
    const endpoints = graphStore.endpointRegistry.getEndpoints(req.params.targetId, publicOnly);
    res.json(endpoints);
  });

  router.get('/targets/:targetId/routes', (req, res) => {
    const serviceId = req.query.serviceId as string;
    const endpointId = req.query.endpointId as string;
    const routes = graphStore.endpointRegistry.getRoutes(req.params.targetId, serviceId, endpointId);
    res.json(routes);
  });

  router.post('/discovery/refresh', async (req, res) => {
    const { targetId } = req.body || {};
    if (targetId) {
      await graphStore.discoveryEngine.refreshTarget(targetId);
    } else {
      await graphStore.discoveryEngine.discoverAll();
    }
    res.json({ success: true, message: 'Discovery refreshed' });
  });


  // --- RCA INCIDENT API ENDPOINTS ---
  router.get('/incidents', (req, res) => {
    const targetId = req.query.targetId as string;
    if (!incidentManager) return res.json([]);
    if (targetId) {
      const incident = incidentManager.getIncidentForTarget(targetId);
      return res.json(incident ? [incident] : []);
    }
    res.json(incidentManager.getAllActiveIncidents());
  });

  router.get('/incidents/:id', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) res.json(incident);
    else res.status(404).json({ error: 'Incident not found' });
  });

  router.get('/incidents/:id/timeline', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) {
      res.json(incident.anomalies || []);
    } else {
      res.status(404).json({ error: 'Incident not found' });
    }
  });

  router.get('/incidents/:id/evidence', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) {
      res.json(incident.evidence || []);
    } else {
      res.status(404).json({ error: 'Incident not found' });
    }
  });

  router.get('/incidents/:id/propagation', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) {
      res.json(incident.propagation || []);
    } else {
      res.status(404).json({ error: 'Incident not found' });
    }
  });

  router.get('/services/:id/anomalies', (req, res) => {
    if (!incidentManager) return res.json([]);
    const all = incidentManager.getAllActiveIncidents();
    const anomalies = all.flatMap(i => i.anomalies.filter(a => a.nodeId === req.params.id));
    res.json(anomalies);
  });

  router.get('/targets/:targetId/resolved-url', (req, res) => {
    const endpointId = req.query.endpointId as string;
    const resolvedUrl = trafficController ? trafficController.resolveBaseUrl(req.params.targetId, endpointId) : null;
    res.json({
      targetId: req.params.targetId,
      endpointId,
      resolvedUrl,
      isConfigured: !!resolvedUrl
    });
  });

  router.get('/targets/:targetId/reachability', async (req, res) => {
    const url = req.query.url as string;
    if (!url) return res.json({ status: 'ERROR', message: 'No URL provided' });
    try {
      const controller = new AbortController();
      // [AGY] Increased timeout from 2000ms to 10000ms. High-latency instances
      // (like open-telemetry) were timing out during UI reachability checks.
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const reachRes = await fetch(url, { method: 'HEAD', signal: controller.signal as any }).catch(() => fetch(url, { method: 'GET', signal: controller.signal as any }));
      clearTimeout(timeoutId);
      if (reachRes) {
        res.json({ status: 'REACHABLE' });
      } else {
        res.json({ status: 'UNREACHABLE' });
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        res.json({ status: 'TIMEOUT' });
      } else {
        res.json({ status: 'ERROR', message: e.message });
      }
    }
  });

  router.post('/ingest', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.INGEST_TOKEN || 'mapper-secret-token'}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
      const payload = req.body as TelemetryEnvelope;
      if (!payload.targetId || !payload.schemaVersion) {
        return res.status(400).json({ error: 'Invalid TelemetryEnvelope schema' });
      }
      
      let clientIp = (payload as any).hostIp;
      if (!clientIp || clientIp === 'unknown') {
        clientIp = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').replace(/^.*:/, '');
      }
      // Safety fallback for SSH tunnels overriding remote address
      if (clientIp === '127.0.0.1' || clientIp === '::1') {
         if (process.env.AWS_EC2_PUBLIC_IP) clientIp = process.env.AWS_EC2_PUBLIC_IP;
      }
      
      graphStore.ingestRemote(payload, clientIp);
      if (wsManager) {
        wsManager.broadcast('graph-update', graphStore.getGraph());
      }
      console.log(`[TELEMETRY] targetId=${payload.targetId} nodes=${payload.events?.nodes?.length || 0} metrics=${payload.events?.metrics?.length || 0} edges=${payload.events?.edges?.length || 0} interactions=${payload.events?.interactions?.length || 0} clientIp=${clientIp}`);
      res.json({ success: true, message: 'Telemetry ingested' });
    } catch (e) {
      console.error('Ingest error:', e);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });


  router.get('/status', (_req, res) => {
    const graph = graphStore.getGraph();
    const nodes = graph.nodes;
    const healthy = nodes.filter(n => n.status === 'healthy').length;
    const degraded = nodes.filter(n => n.status === 'degraded').length;
    const critical = nodes.filter(n => n.status === 'critical').length;
    const unknown = nodes.filter(n => n.status === 'unknown').length;

    let overallStatus: string = 'unknown';
    if (critical > 0) overallStatus = 'critical';
    else if (degraded > 0) overallStatus = 'degraded';
    else if (healthy > 0) overallStatus = 'healthy';

    res.json({
      status: overallStatus,
      healthy,
      degraded,
      critical,
      unknown,
      targets: graph.targets,
      lastUpdate: new Date().toISOString(),
    });
  });



  // --- TRAFFIC GENERATOR API ENDPOINTS ---
  router.get('/traffic/health', async (_req, res) => {
    if (!trafficController) return res.json({ reachable: false, url: null, projects: [] });
    res.json(await trafficController.getHealth());
  });

  // Operator-pinned entry point per target. Discovery can only report what a
  // container publishes, which isn't always what's reachable from here — so
  // this records the URL traffic should actually use, and the probe proves
  // it responds before anyone starts a run against it.
  router.get('/traffic/entrypoints', (_req, res) => {
    const cfgPath = path.join(process.cwd(), 'data', 'remote_config.json');
    const cfg = readJsonSafe(cfgPath) || {};
    const result: Record<string, { pinned: string | null; resolved: string | null; staleHost?: string }> = {};
    for (const targetId of Object.keys(cfg)) {
      const pinned = cfg[targetId]?.trafficBaseUrl ?? null;
      const entry: { pinned: string | null; resolved: string | null; staleHost?: string } = {
        pinned,
        resolved: trafficController?.resolveBaseUrl(targetId) ?? null,
      };
      // These instances get a new public IP on every stop/start, so a pin
      // made yesterday can quietly point at an address that now belongs to
      // nobody. Flag the mismatch instead of letting traffic fail silently.
      const currentIp = cfg[targetId]?.ec2PublicIp;
      if (pinned && currentIp && !/localhost|127\.0\.0\.1/.test(pinned) && !pinned.includes(currentIp)) {
        entry.staleHost = currentIp;
      }
      result[targetId] = entry;
    }
    res.json(result);
  });

  router.post('/traffic/entrypoint', (req, res) => {
    const { targetId, url } = req.body || {};
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'url must start with http:// or https://' });
    }
    const cfgPath = path.join(process.cwd(), 'data', 'remote_config.json');
    const cfg = readJsonSafe(cfgPath) || {};
    if (!cfg[targetId]) return res.status(404).json({ error: `unknown target ${targetId}` });
    // Empty string clears the pin and falls back to discovery.
    if (trimmed) cfg[targetId].trafficBaseUrl = trimmed;
    else delete cfg[targetId].trafficBaseUrl;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    res.json({ success: true, targetId, pinned: trimmed || null, resolved: trafficController?.resolveBaseUrl(targetId) ?? null });
  });

  router.post('/traffic/entrypoint/probe', async (req, res) => {
    const { url, path: probePath = '/' } = req.body || {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'url must start with http:// or https://' });
    }
    const target = `${url.replace(/\/$/, '')}${probePath}`;
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const probe = await fetch(target, { signal: controller.signal });
      clearTimeout(timer);
      res.json({ reachable: true, status: probe.status, ms: Date.now() - started, url: target });
    } catch (e: any) {
      res.json({ reachable: false, error: e.name === 'AbortError' ? 'timed out after 10s' : e.message, ms: Date.now() - started, url: target });
    }
  });

  router.get('/traffic/status', (req, res) => {
    const targetId = req.query.targetId as string;
    if (experimentManager) {
      const statuses = trafficController?.getStatus(targetId) || [];
      const result = statuses.map(s => {
        const exp = experimentManager.getActiveExperiment(s.targetId);
        return {
          ...s,
          experimentId: exp?.experimentId,
          trafficStatistics: exp?.trafficStatistics,
          peakObservedMetrics: exp?.peakObservedMetrics
        };
      });
      res.json(result);
    } else if (trafficController) {
      res.json(trafficController.getStatus(targetId));
    } else {
      res.json([]);
    }
  });

  router.post('/traffic/start', (req, res) => {
    if (!trafficController) return res.status(500).json({ error: 'Traffic controller unavailable' });
    const { targetId = 'all', profile = 'normal', mode = 'USER_JOURNEY', routeId, serviceId, endpointId, baseUrl } = req.body;
    
    const opts = { profile, mode, routeId, serviceId, endpointId, overrideUrl: baseUrl };
    if (targetId === 'all') {
      const sockShopStats = trafficController.startTarget('sock-shop', opts);
      const vertikalStats = trafficController.startTarget('vertikal', opts);
      return res.json([sockShopStats, vertikalStats]);
    } else {
      const stats = trafficController.startTarget(targetId, opts);
      return res.json([stats]);
    }
  });


  router.post('/traffic/stop', async (req, res) => {
    if (!trafficController) return res.status(500).json({ error: 'Traffic controller unavailable' });
    const { targetId = 'all' } = req.body;

    if (targetId === 'all') {
      const stats = await trafficController.stopAll();
      if (experimentManager) {
        for (const s of stats) {
          experimentManager.stopExperiment(s.targetId, 'STOPPED');
        }
      }
      return res.json(stats);
    } else {
      if (experimentManager) {
        experimentManager.stopExperiment(targetId, 'STOPPED');
      }
      const stats = trafficController.stopTarget(targetId);
      return res.json([stats]);
    }
  });

  // --- EXPERIMENT API ENDPOINTS ---
  router.get('/experiments', (req, res) => {
    if (!experimentManager) return res.json([]);
    const targetId = req.query.targetId as string;
    res.json(experimentManager.experimentStore.getAllRecords(targetId));
  });

  router.post('/experiments/start', (req, res) => {
    if (!experimentManager || !trafficController) return res.status(500).json({ error: 'Experiment manager unavailable' });
    const { targetId, profile = 'normal', mode = 'USER_JOURNEY', routeId, serviceId, endpointId, baseUrl, workloadSource = 'EXTERNAL', limits, config } = req.body;
    
    if (!targetId || targetId === 'all') {
      return res.status(400).json({ error: 'Must specify a single targetId for an experiment' });
    }

    const expId = experimentManager.startExperiment(
      targetId, 
      workloadSource, 
      profile, 
      config || { mode, rate: 0, concurrency: 1, durationSeconds: 0 },
      limits
    );

    const opts = { profile, mode, routeId, serviceId, endpointId, overrideUrl: baseUrl, workloadSource };
    const stats = trafficController.startTarget(targetId, opts);
    
    return res.json({ experimentId: expId, trafficStatus: stats });
  });

  router.post('/experiments/update_stats', (req, res) => {
    if (!experimentManager) return res.status(500).json({ error: 'Experiment manager unavailable' });
    const { targetId, stats } = req.body;
    
    if (targetId && stats) {
      experimentManager.updateExperimentStats(targetId, stats);
    }
    res.json({ success: true });
  });

  // --- ML PIPELINE STATUS (ml/collector.py, preprocess.py, train.py, score.py) ---
  const mlDataDir = path.resolve(process.cwd(), '..', 'ml', 'data');
  const mlModelsDir = path.resolve(process.cwd(), '..', 'ml', 'models');

  const readJsonSafe = (filePath: string): any => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  };

  router.get('/ml/status', (_req, res) => {
    res.json({
      collection: readJsonSafe(path.join(mlDataDir, 'collection_summary.json')),
      preprocessing: readJsonSafe(path.join(mlDataDir, 'preprocess_summary.json')),
      training: readJsonSafe(path.join(mlModelsDir, 'training_summary.json')),
      scoring: readJsonSafe(path.join(mlDataDir, 'scoring_summary.json')),
      liveScores: readJsonSafe(path.join(mlDataDir, 'latest_scores.json')),
    });
  });

  const mlConfigPath = path.resolve(process.cwd(), '..', 'ml', 'config.json');
  const mlDir = path.resolve(process.cwd(), '..', 'ml');

  router.get('/ml/config', (_req, res) => {
    res.json(readJsonSafe(mlConfigPath) || {});
  });

  const ALL_FEATURE_COLUMNS = ['z_cpu_percent', 'z_memory_percent', 'z_network_rx_rate', 'z_network_tx_rate'];

  router.post('/ml/config', (req, res) => {
    const allowedKeys = [
      'collect_interval_sec', 'min_samples_per_service', 'min_training_samples', 'contamination',
      'score_interval_sec', 'persistence_windows', 'n_estimators', 'max_samples_fraction',
    ];
    const current = readJsonSafe(mlConfigPath) || {};
    const updates: Record<string, any> = {};
    for (const key of allowedKeys) {
      if (req.body[key] === undefined) continue;
      const val = Number(req.body[key]);
      if (!Number.isFinite(val) || val <= 0) {
        return res.status(400).json({ error: `${key} must be a positive number` });
      }
      updates[key] = val;
    }
    if (updates.contamination !== undefined && updates.contamination >= 0.5) {
      return res.status(400).json({ error: 'contamination must be < 0.5 (IsolationForest requirement)' });
    }
    if (updates.max_samples_fraction !== undefined && updates.max_samples_fraction > 1) {
      return res.status(400).json({ error: 'max_samples_fraction must be between 0 and 1' });
    }
    // holdout_fraction is allowed to be 0 (train on everything), so it can't
    // go through the positive-number loop above.
    if (req.body.holdout_fraction !== undefined) {
      const val = Number(req.body.holdout_fraction);
      if (!Number.isFinite(val) || val < 0 || val >= 0.5) {
        return res.status(400).json({ error: 'holdout_fraction must be between 0 and 0.5' });
      }
      updates.holdout_fraction = val;
    }
    if (req.body.feature_columns !== undefined) {
      const cols = req.body.feature_columns;
      if (!Array.isArray(cols) || cols.length === 0 || cols.some((c: any) => !ALL_FEATURE_COLUMNS.includes(c))) {
        return res.status(400).json({ error: `feature_columns must be a non-empty subset of ${ALL_FEATURE_COLUMNS.join(', ')}` });
      }
      updates.feature_columns = cols;
    }
    const next = { ...current, ...updates };
    fs.writeFileSync(mlConfigPath, JSON.stringify(next, null, 2));
    res.json({ success: true, config: next });
  });

  // --- ML LONG-RUNNING PROCESS CONTROL (collector.py, score.py) ---
  // These two run continuously. Previously they could only be started from a
  // shell, so the UI had no way to tell whether the numbers on screen were
  // live or frozen. The server supervises them here, and also detects
  // instances started outside it so the reported state is the truth rather
  // than just "what this server launched".
  const mlLogsDir = path.resolve(process.cwd(), '..', 'ml', 'logs');
  type MlProcName = 'collector' | 'scorer';
  const ML_PROC_SCRIPTS: Record<MlProcName, string> = { collector: 'collector.py', scorer: 'score.py' };
  const managedMlProcs = new Map<MlProcName, { child: ReturnType<typeof spawn>; startedAt: string }>();

  const findExternalPid = (script: string): number | null => {
    try {
      // Anchored: an unanchored match also hits shell wrappers whose command
      // line merely contains "python3 <script>", and killing the wrapper
      // would leave the actual interpreter running.
      const pattern = `^python3 ${script.replace('.', '\\.')}$`;
      const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim();
      const pid = out.split('\n').map((l) => parseInt(l, 10)).find((n) => Number.isFinite(n));
      return pid ?? null;
    } catch {
      return null; // pgrep exits non-zero when nothing matches
    }
  };

  const tailFile = (filePath: string, lines: number): string[] => {
    try {
      return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  };

  const mlProcStatus = (name: MlProcName) => {
    const managed = managedMlProcs.get(name);
    const alive = managed && managed.child.exitCode === null && !managed.child.killed;
    const externalPid = alive ? null : findExternalPid(ML_PROC_SCRIPTS[name]);
    return {
      name,
      script: ML_PROC_SCRIPTS[name],
      running: Boolean(alive || externalPid),
      managed: Boolean(alive),
      pid: alive ? managed!.child.pid : externalPid,
      startedAt: alive ? managed!.startedAt : null,
      log: tailFile(path.join(mlLogsDir, `${name}.log`), 60),
    };
  };

  router.get('/ml/processes', (_req, res) => {
    res.json({ collector: mlProcStatus('collector'), scorer: mlProcStatus('scorer') });
  });

  router.post('/ml/processes/:name/start', (req, res) => {
    const name = req.params.name as MlProcName;
    if (!ML_PROC_SCRIPTS[name]) return res.status(400).json({ error: 'Unknown process' });
    const status = mlProcStatus(name);
    if (status.running) return res.status(409).json({ error: `${name} is already running (pid ${status.pid})` });

    fs.mkdirSync(mlLogsDir, { recursive: true });
    const logPath = path.join(mlLogsDir, `${name}.log`);
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn('python3', [ML_PROC_SCRIPTS[name]], {
      cwd: mlDir,
      stdio: ['ignore', logFd, logFd],
    });
    child.on('close', () => {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      managedMlProcs.delete(name);
    });
    managedMlProcs.set(name, { child, startedAt: new Date().toISOString() });
    res.json({ success: true, pid: child.pid });
  });

  router.post('/ml/processes/:name/stop', (req, res) => {
    const name = req.params.name as MlProcName;
    if (!ML_PROC_SCRIPTS[name]) return res.status(400).json({ error: 'Unknown process' });
    const status = mlProcStatus(name);
    if (!status.running || !status.pid) return res.status(409).json({ error: `${name} is not running` });
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch (e: any) {
      return res.status(500).json({ error: `Failed to stop ${name}: ${e.message}` });
    }
    managedMlProcs.delete(name);
    res.json({ success: true });
  });

  // Per-model metadata (feature set, training size, threshold, holdout
  // evaluation) straight from each models/*.meta.json written by train.py.
  router.get('/ml/models', (_req, res) => {
    try {
      const files = fs.readdirSync(mlModelsDir).filter((f) => f.endsWith('.meta.json'));
      const models = files.map((f) => readJsonSafe(path.join(mlModelsDir, f))).filter(Boolean);
      res.json(models);
    } catch {
      res.json([]);
    }
  });

  // Recent rows of the exact feature table train.py fits on, so the UI can
  // show what the model actually sees rather than a re-derived approximation.
  router.get('/ml/features', (req, res) => {
    const featuresPath = path.join(mlDataDir, 'features.csv');
    if (!fs.existsSync(featuresPath)) return res.json({ columns: [], rows: [] });
    const serviceId = req.query.serviceId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 300, 2000);
    const lines = fs.readFileSync(featuresPath, 'utf8').split('\n').filter(Boolean);
    const columns = lines[0].split(',');
    const sidIndex = columns.indexOf('service_id');
    const rows = lines.slice(1)
      .filter((line) => !serviceId || line.split(',')[sidIndex] === serviceId)
      .slice(-limit)
      .map((line) => {
        const parts = line.split(',');
        const row: Record<string, any> = {};
        columns.forEach((col, i) => {
          const raw = parts[i];
          const num = Number(raw);
          row[col] = raw === '' || raw === undefined ? null : (Number.isFinite(num) && raw.trim() !== '' ? num : raw);
        });
        return row;
      });
    res.json({ columns, rows });
  });

  router.get('/ml/normalization', (_req, res) => {
    res.json(readJsonSafe(path.join(mlDataDir, 'normalization_stats.json')) || {});
  });

  // preprocess.py + train.py are one-shot scripts; run them sequentially on
  // demand so a config/data change can be reflected without a manual SSH
  // session. collector.py/score.py are long-running and hot-reload
  // config.json on their own, so they're not touched here.
  let retrainState: { running: boolean; startedAt: string | null; finishedAt: string | null; log: string[]; exitCode: number | null } = {
    running: false, startedAt: null, finishedAt: null, log: [], exitCode: null,
  };

  router.get('/ml/retrain', (_req, res) => {
    res.json(retrainState);
  });

  router.post('/ml/retrain', (req, res) => {
    if (retrainState.running) {
      return res.status(409).json({ error: 'A retrain is already running' });
    }
    const { since, until } = req.body || {};
    retrainState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, log: [], exitCode: null };

    const runStep = (cmd: string, args: string[]) => new Promise<number>((resolve) => {
      const child = spawn(cmd, args, { cwd: mlDir });
      child.stdout?.on('data', (chunk) => retrainState.log.push(chunk.toString('utf8').trim()));
      child.stderr?.on('data', (chunk) => retrainState.log.push(chunk.toString('utf8').trim()));
      child.on('close', (code) => resolve(code ?? 1));
    });

    (async () => {
      const preCode = await runStep('python3', ['preprocess.py']);
      if (preCode !== 0) {
        retrainState = { ...retrainState, running: false, finishedAt: new Date().toISOString(), exitCode: preCode };
        return;
      }
      const trainArgs = ['train.py'];
      if (since) trainArgs.push('--since', since);
      if (until) trainArgs.push('--until', until);
      const trainCode = await runStep('python3', trainArgs);
      retrainState = { ...retrainState, running: false, finishedAt: new Date().toISOString(), exitCode: trainCode };
    })();

    res.json({ success: true, message: 'Retrain started' });
  });

  router.get('/ml/score-history', (req, res) => {
    const historyPath = path.join(mlDataDir, 'score_history.csv');
    if (!fs.existsSync(historyPath)) return res.json([]);
    const serviceId = req.query.serviceId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 200, 2000);
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    const rows = lines.slice(1) // skip header
      .map((line) => {
        const [timestamp, service_id, anomaly_score, above_threshold, persistent] = line.split(',');
        return { timestamp, service_id, anomaly_score: Number(anomaly_score), above_threshold: above_threshold === 'True', persistent: persistent === 'True' };
      })
      .filter((r) => !serviceId || r.service_id === serviceId);
    res.json(rows.slice(-limit));
  });

  // --- CONFIGURATION API ENDPOINTS ---
  const configPath = path.join(process.cwd(), 'data', 'remote_config.json');

  router.get('/config/remote', (_req, res) => {
    try {
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf8');
        res.json(JSON.parse(data));
      } else {
        res.json({});
      }
    } catch (e) {
      console.error('Error reading remote config:', e);
      res.status(500).json({ error: 'Failed to read config' });
    }
  });

  router.post('/config/remote', (req, res) => {
    try {
      const { targetId, projectName, ec2PublicIp, sshKeyPath, sshUsername, composeFilePath } = req.body;
      let currentConfig: any = {};
      
      if (fs.existsSync(configPath)) {
        try {
          currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) { /* ignore parse error */ }
      }
      
      const key = targetId || 'default';
      const newConfig = {
        ...currentConfig,
        [key]: {
          // Merge onto the existing entry rather than replacing it: this
          // record also holds settings the edit form doesn't send, such as
          // the pinned traffic entry point. Replacing wholesale silently
          // erased them every time someone updated an IP.
          ...(currentConfig[key] || {}),
          ec2PublicIp,
          sshKeyPath,
          sshUsername,
          composeFilePath,
          displayName: projectName || targetId,
          updatedAt: new Date().toISOString()
        }
      };

      if (!fs.existsSync(path.dirname(configPath))) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
      }

      fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
      
      // Register in GraphStore immediately (triggering background SSH discovery)
      graphStore.registerNewProject(targetId, projectName || targetId, ec2PublicIp);
      
      // Sync into memory for runtime usage
      if (ec2PublicIp) {
        process.env.AWS_EC2_PUBLIC_IP = ec2PublicIp;
      }
      
      res.json({ success: true, config: newConfig });
    } catch (e) {
      console.error('Error saving remote config:', e);
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  return router;
}