import type { ConnectionEvent } from "./types.js";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";

/**
 * Stores raw TCP connection events per target. These are SSH-sampled
 * snapshots of /proc/net/tcp, NOT distributed trace spans.
 *
 * Events are kept for 24 hours and persisted as JSON on disk. This store
 * is intended to be instantiated once per target and shared across the
 * TraceRouter and GraphStore.
 *
 * The 24-hour window lives in memory and is written out on a debounce.
 * saveEvents() used to read the whole file, parse it, append, re-filter,
 * pretty-print and rewrite it on every call - about twice every 5 seconds per
 * target, on files up to ~1.8 MB, all synchronous JSON work on the event
 * loop. Two concurrent calls (the metric poll and the connection scan both
 * save) also raced: each read the same old file, and whichever wrote last
 * silently dropped the other's events.
 */
export class TraceStore {
  private readonly filePath: string;
  /** In-memory buffer for recent events (used for WebSocket streaming) */
  private recentEvents: ConnectionEvent[] = [];
  private readonly maxRecentEvents = 500;
  /** Everything inside the retention window, oldest first. */
  private events: ConnectionEvent[] | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  static readonly RETENTION_MS = 24 * 60 * 60 * 1000;
  /** Hard cap so a very chatty target cannot grow memory without bound. */
  static readonly MAX_EVENTS = 100_000;
  static readonly WRITE_DEBOUNCE_MS = 10_000;

  constructor(targetId: string) {
    // Store in the project's data/ directory (same level as graph_db.json)
    this.filePath = path.join(process.cwd(), "data", `traces_${targetId}.json`);
  }

  /** Loaded once, synchronously, on first use - after that memory is the truth. */
  private all(): ConnectionEvent[] {
    if (this.events === null) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
        this.events = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.events = [];
      }
      this.prune();
    }
    return this.events;
  }

  /** Events arrive in time order, so expiry only ever trims the front. */
  private prune(): void {
    if (!this.events) return;
    const cutoff = new Date(Date.now() - TraceStore.RETENTION_MS).toISOString();
    let drop = 0;
    while (drop < this.events.length && this.events[drop].timestamp < cutoff) drop++;
    const over = this.events.length - drop - TraceStore.MAX_EVENTS;
    if (over > 0) drop += over;
    if (drop > 0) this.events.splice(0, drop);
  }

  async saveEvents(events: ConnectionEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Update in-memory buffer
    this.recentEvents.push(...events);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents = this.recentEvents.slice(-this.maxRecentEvents);
    }

    const all = this.all();
    const lastBefore = all.length > 0 ? all[all.length - 1].timestamp : '';
    all.push(...events);
    // The metric poll and the connection scan save independently, so a batch
    // can land slightly older than the one before it. Pruning and the `since`
    // search both rely on time order, so restore it when that happens.
    if (events.some(e => e.timestamp < lastBefore)) {
      all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    }
    this.prune();
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, TraceStore.WRITE_DEBOUNCE_MS);
  }

  /** Serialised: a write never overlaps the previous one. */
  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.events) return;
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        // Compact, not pretty-printed: this file is for the machine, and the
        // indentation alone was a large share of its size and write time.
        const tmp = `${this.filePath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.events));
        await fs.rename(tmp, this.filePath);
      } catch (e) {
        console.error(`[TRACES] Failed to persist ${this.filePath}:`, e);
      }
    });
    return this.writing;
  }

  async loadEvents(since?: string): Promise<ConnectionEvent[]> {
    const events = this.all();
    if (!since) return events.slice();
    // Binary search for the first event at or after `since`.
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].timestamp < since) lo = mid + 1;
      else hi = mid;
    }
    return events.slice(lo);
  }

  getRecentEvents(limit: number = 100): ConnectionEvent[] {
    return this.recentEvents.slice(-limit);
  }

  async clear(): Promise<void> {
    this.recentEvents = [];
    this.events = [];
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      await fs.unlink(this.filePath);
    } catch {
      // Ignorable: clearing a trace file that was never written is a no-op.
    }
  }
}

export type { ConnectionEvent };
