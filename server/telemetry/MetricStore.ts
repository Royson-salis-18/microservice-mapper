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

  private scheduleSave(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveToDisk();
    }, 2000);
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

  pushEvent(event: InteractionEvent): void {
    this.events.push(event);
    // Keep last 10,000 events or within a time window (e.g., 1 hour)
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.events = this.events.filter(e => new Date(e.timestamp).getTime() > cutoff).slice(-10000);
    this.scheduleSave();
  }

  getAggregatedEdgeMetrics(source: string, target: string, timeWindowMs: number = 5 * 60 * 1000) {
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
      if (e.statusCode && e.statusCode >= 400) errorCount++;
      if (e.latency !== undefined) latencies.push(e.latency);
      if (e.bytesSent !== undefined) totalBytesSent += e.bytesSent;
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
      bytesSent: totalBytesSent,
      throughput: totalBytesSent / (timeWindowMs / 1000),
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