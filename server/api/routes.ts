import { Router } from 'express';
import { GraphStore } from '../graph/GraphStore.js';
import { GraphAnalytics } from '../graph/GraphAnalytics.js';
import type { TelemetryEnvelope } from '../models/index.js';

import type { WebSocketManager } from './websocket.js';
import type { IncidentManager } from '../rca/IncidentManager.js';
import type { TrafficController } from '../traffic/TrafficController.js';
import type { ExperimentManager } from '../traffic/ExperimentManager.js';

export function createRouter(graphStore: GraphStore, wsManager?: WebSocketManager, incidentManager?: IncidentManager, trafficController?: TrafficController, experimentManager?: ExperimentManager) {
  const router = Router();
  const analytics = new GraphAnalytics(graphStore);

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

  router.get('/analytics', (_req, res) => {
    res.json(analytics.getAnalytics());
  });

  router.get('/rca', (_req, res) => {
    if (!incidentManager) {
      return res.json({
        incidentDetected: false,
        message: 'Incident manager uninitialized',
        primaryRootCauses: [],
        cascadingFailures: [],
        blastRadius: { totalImpacted: 0, affectedServices: [] }
      });
    }
    const incidents = incidentManager.getAllActiveIncidents();
    if (incidents.length === 0) {
      return res.json({
        incidentDetected: false,
        message: 'All system components operating within normal telemetry parameters.',
        primaryRootCauses: [],
        cascadingFailures: [],
        blastRadius: { totalImpacted: 0, affectedServices: [] }
      });
    }
    const inc = incidents[0];
    res.json({
      incidentDetected: true,
      timestamp: inc.startedAt,
      primaryRootCauses: inc.candidateCauses.slice(0, 1).map(c => ({
        nodeId: c.serviceId,
        name: c.serviceName,
        status: 'critical',
        failureReason: inc.explanation?.whatHappened || 'Anomaly detected',
        evidence: inc.evidence ? inc.evidence.map(ev => ev.description) : []
      })),
      cascadingFailures: inc.candidateCauses.slice(1).map(c => ({
        nodeId: c.serviceId,
        name: c.serviceName,
        status: 'degraded',
        causedBy: inc.rootCauseServiceId ? [inc.rootCauseServiceId] : [],
        failureReason: `Upstream dependency failure`,
        evidence: inc.explanation?.evidenceSummary || []
      })),
      blastRadius: {
        totalImpacted: inc.affectedServices ? inc.affectedServices.length : 0,
        affectedServices: inc.affectedServices ? inc.affectedServices.map((id: string) => id.replace(/^(sock-shop|vertikal)-/, '')) : []
      },
      remediationGuide: (inc.remediationGuide && inc.remediationGuide.length > 0) ? inc.remediationGuide.join(' && ') : `docker restart ${inc.rootCauseServiceId}`
    });
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
      await graphStore.discoveryEngine.discoverTarget(targetId);
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
      const timeoutId = setTimeout(() => controller.abort(), 2000);
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
         if (payload.targetId.includes('aws')) clientIp = process.env.AWS_EC2_PUBLIC_IP || '13.200.237.137';
      }
      
      graphStore.ingestRemote(payload, clientIp);
      if (wsManager) {
        wsManager.broadcast('graph-update', graphStore.getGraph());
      }
      console.log(`[TELEMETRY] targetId=${payload.targetId} eventsReceived=${payload.events?.metrics?.length || 0} + ${payload.events?.interactions?.length || 0} clientIp=${clientIp}`);
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


  router.post('/traffic/stop', (req, res) => {
    if (!trafficController) return res.status(500).json({ error: 'Traffic controller unavailable' });
    const { targetId = 'all' } = req.body;

    if (targetId === 'all') {
      const stats = trafficController.stopAll();
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

  return router;
}