import { Router } from 'express';
import { TraceStore } from '../traces/TraceStore.js';
import { TraceGraphAggregator } from '../traces/TraceGraphAggregator.js';

/**
 * API router for connection trace data. These are SSH-sampled TCP
 * connection events from /proc/net/tcp on the remote host, NOT
 * distributed tracing spans (no OpenTelemetry/Zipkin/Jaeger).
 * 
 * Connection events flow in from the remote-collector via the /api/ingest
 * endpoint, get stored in per-target TraceStores on the GraphStore, and
 * are served here as raw events or aggregated into a weighted directed graph.
 * 
 * Limitations:
 * - Samples connections at collection-cycle granularity (~5s)
 * - Short-lived connections between cycles will be missed
 * - No per-request latency information
 */
export function createTraceRouter(
  graphStore: any,
  wsManager?: any
) {
  const router = Router();

  router.get('/status', (req, res) => {
    const { targetId } = req.query;
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });

    const store = graphStore.getTraceStore?.(targetId as string);
    const recentEvents = store?.getRecentEvents(1) || [];
    const hasRecentData = recentEvents.length > 0 && 
      (Date.now() - new Date(recentEvents[0]?.timestamp || 0).getTime()) < 60000;

    res.json({
      active: hasRecentData,
      targetId,
      eventCount: store?.getRecentEvents(500)?.length || 0,
      timestamp: new Date().toISOString()
    });
  });

  // Start/Stop are now UI-level subscriptions — the remote-collector
  // sends connection events continuously via the ingest pipeline.
  // These endpoints exist for API compatibility.
  router.post('/start', async (req, res) => {
    const { targetId } = req.body;
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });

    const target = graphStore.targets.get(targetId);
    if (!target) return res.status(404).json({ error: 'Target not found' });

    if (wsManager) {
      wsManager.broadcast('trace-started', { targetId, status: 'collecting' });
    }

    res.json({ 
      success: true, 
      message: `Trace stream activated for ${targetId}. Connection events flow from the remote-collector automatically.` 
    });
  });

  router.post('/stop', async (req, res) => {
    const { targetId } = req.body;
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });

    if (wsManager) {
      wsManager.broadcast('trace-stopped', { targetId, status: 'idle' });
    }

    res.json({ 
      success: true, 
      message: `Trace stream deactivated for ${targetId}` 
    });
  });

  router.get('/events', async (req, res) => {
    const { targetId, since, limit } = req.query;
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });

    const store = graphStore.getTraceStore?.(targetId as string);
    if (!store) return res.json([]);

    if (since) {
      const events = await store.loadEvents(since as string);
      return res.json(events);
    }

    // Return recent in-memory events for fast response
    const maxEvents = parseInt(limit as string) || 200;
    res.json(store.getRecentEvents(maxEvents));
  });

  router.get('/graph', async (req, res) => {
    const { targetId, windowSec } = req.query;
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });

    const store = graphStore.getTraceStore?.(targetId as string);
    if (!store) return res.json({ nodes: [], edges: [] });

    const window = parseInt(windowSec as string) || 300;
    const aggregator = new TraceGraphAggregator(store);
    const graph = await aggregator.aggregate(window);
    res.json(graph);
  });

  return router;
}
