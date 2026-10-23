import type { InteractionEvent } from '../models/InteractionEvent.js';
import type { MetricSnapshot } from '../models/MetricSnapshot.js';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

export class MetricStore {
  private store: Map<string, MetricSnapshot[]> = new Map();
  private events: InteractionEvent[] = [];
  private readonly maxSize: number;
  private storagePath: string;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor(maxSize: number = config.METRIC_HISTORY_SIZE) {
    this.maxSize = maxSize;
    this.storagePath = path.resolve(process.cwd(), 'data', 'telemetry_db.json');
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.store && typeof data.store === 'object') {
          for (const [key, val] of Object.entries(data.store)) {
            if (Array.isArray(val)) {
              this.store.set(key, val as MetricSnapshot[]);
            }
          }
        }
        if (Array.isArray(data.events)) {
          this.events = data.events;
        }
        console.log(`[MetricStore] Loaded persistent telemetry state from disk (${this.store.size} nodes, ${this.events.length} events)`);
      }
    } catch (e) {
      console.warn('[MetricStore] Failed to load telemetry state from disk:', e);
    }
  }

  /**
   * The file is crash recovery for metric history, not the live store, so it
   * does not need writing every couple of seconds. Every poll pushes samples,
   * so a 2s debounce meant serialising a multi-megabyte object (4.3 MB
   * observed, ~18 ms of blocking JSON work) almost continuously.
   */
  static readonly SAVE_DEBOUNCE_MS = 15_000;

  private scheduleSave(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveToDisk();
    }, MetricStore.SAVE_DEBOUNCE_MS);
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const storeObj: Record<string, MetricSnapshot[]> = {};
      for (const [k, v] of this.store.entries()) {
        storeObj[k] = v;
      }
      const payload = JSON.stringify({ store: storeObj, events: this.events });
      fs.writeFileSync(this.storagePath, payload, 'utf8');
    } catch (e) {
      console.error('[MetricStore] Failed to save telemetry state to disk:', e);
    }
  }

  /** Everything held for a node (the ring buffer: about 90 minutes at the usual pace), oldest first. */
  getAll(nodeId: string): MetricSnapshot[] {
    return this.store.get(nodeId) ?? [];
  }

  push(nodeId: string, snapshot: MetricSnapshot): void {
    if (!this.store.has(nodeId)) {
      this.store.set(nodeId, []);
    }
    const history = this.store.get(nodeId)!;
    history.push(snapshot);
    if (history.length > this.maxSize) {
      history.shift();
    }
    this.scheduleSave();
  }

  /**
   * Drops a node's history. Called when the graph prunes a node that has
   * stopped reporting: without this, every container that restarts onto a
   * new id leaves its full metric history behind for the lifetime of the
   * process, and the per-node cap does nothing to bound the map itself.
   */
  deleteNode(nodeId: string): void {
    this.store.delete(nodeId);
  }

  pushEvent(event: InteractionEvent): void {
    this.events.push(event);
    // Keep the last hour, capped at 10,000. Events arrive in time order, so
    // expiry only ever trims the front - this used to re-filter the whole
    // array, parsing up to 10,000 dates, on every single event, which is
    // quadratic in the size of each ingested batch.
    const cutoff = Date.now() - 60 * 60 * 1000;
    let drop = 0;
    while (drop < this.events.length && !(new Date(this.events[drop].timestamp).getTime() > cutoff)) drop++;
    const over = this.events.length - drop - 10_000;
    if (over > 0) drop += over;
    if (drop > 0) this.events.splice(0, drop);
    this.scheduleSave();
  }

  getEvents(limit: number = 100): InteractionEvent[] {
    return this.events.slice(-limit).reverse();
  }

  getAggregatedEdgeMetrics(source: string, target: string, timeWindowMs: number = 2 * 60 * 1000) {
    const cutoff = Date.now() - timeWindowMs;
    const relevant = this.events.filter(e => 
      e.source === source && 
      e.target === target && 
      new Date(e.timestamp).getTime() > cutoff
    );

    if (relevant.length === 0) return null;

    let errorCount = 0;
    let totalBytesSent = 0;
    const latencies: number[] = [];
    
    for (const e of relevant) {
      // 5xx only. A 409 (insufficient funds) or 402 (card declined) is the service working as designed; counting 4xx made a healthy
      // LedgerLine link read 22% failing and ShopFlow's checkout permanently amber before anything had been injected.
      if (e.statusCode !== null && e.statusCode !== undefined && e.statusCode >= 500) errorCount++;
      const latency = e.latencyMs ?? e.latency;
      if (latency !== null && latency !== undefined) latencies.push(latency);
      if (e.bytesSent !== null && e.bytesSent !== undefined) totalBytesSent += e.bytesSent;
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || null;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || null;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || null;
    const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

    return {
      requestCount: relevant.length,
      requestRate: relevant.length / (timeWindowMs / 1000), // requests per second
      errorCount,
      errorRate: errorCount / relevant.length,
      latency: avgLatency,
      p50Latency: p50,
      p95Latency: p95,
      p99Latency: p99,
      bytesSent: relevant.some(e => e.bytesSent !== null && e.bytesSent !== undefined) ? totalBytesSent : null,
      throughput: relevant.some(e => e.bytesSent !== null && e.bytesSent !== undefined)
        ? totalBytesSent / (timeWindowMs / 1000)
        : null,
    };
  }

  getHistory(nodeId: string, range: string): MetricSnapshot[] {
    const history = this.store.get(nodeId) || [];
    const now = Date.now();
    let msRange = 5 * 60 * 1000;
    if (range === '15m') msRange = 15 * 60 * 1000;
    else if (range === '30m') msRange = 30 * 60 * 1000;
    else if (range === '1h') msRange = 60 * 60 * 1000;

    return history.filter(s => now - new Date(s.timestamp).getTime() <= msRange);
  }
}