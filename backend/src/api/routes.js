import { GraphAnalytics } from '../graph/GraphAnalytics.js';

export default function registerRoutes(app, graphManager, metricStore) {
  app.get('/api/graph', (req, res) => {
    res.json(graphManager.getSnapshot());
  });

  app.get('/api/services/:id', (req, res) => {
    const id = req.params.id;
    const detail = graphManager.getNodeDetail(id);
    if (!detail) {
      return res.status(404).json({ error: 'Service not found' });
    }
    const upstream = graphManager.getUpstream(id);
    const downstream = graphManager.getDownstream(id);
    const latestMetrics = metricStore.getLatest(id);
    
    res.json({
      ...detail,
      upstream,
      downstream,
      latestMetrics
    });
  });

  app.get('/api/services/:id/metrics', (req, res) => {
    const id = req.params.id;
    const { range } = req.query;
    
    let rangeMs = null;
    if (range) {
      if (range === '5m') rangeMs = 5 * 60 * 1000;
      else if (range === '15m') rangeMs = 15 * 60 * 1000;
      else if (range === '30m') rangeMs = 30 * 60 * 1000;
      else if (range === '1h') rangeMs = 60 * 60 * 1000;
    }

    const history = metricStore.getHistory(id, rangeMs);
    res.json(history);
  });

  app.get('/api/analytics', (req, res) => {
    const snapshot = graphManager.getSnapshot();
    res.json(GraphAnalytics.computeAnalytics(snapshot));
  });
}
