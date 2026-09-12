import { Router } from 'express';
import { GraphStore } from '../graph/GraphStore.js';
import { GraphAnalytics } from '../graph/GraphAnalytics.js';
import type { TelemetryEnvelope } from '../models/index.js';

import type { WebSocketManager } from './websocket.js';
import type { IncidentManager } from '../rca/IncidentManager.js';

export function createRouter(graphStore: GraphStore, wsManager?: WebSocketManager, incidentManager?: IncidentManager) {
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
    res.json(analytics.performRCA());
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
      graphStore.ingestRemote(payload);
      if (wsManager) {
        wsManager.broadcast('graph-update', graphStore.getGraph());
      }
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

  return router;
}