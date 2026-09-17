import type { ConnectionEvent } from "./types.js";
import fs from "fs/promises";
import path from "path";

/**
 * Stores raw TCP connection events per target. These are SSH-sampled
 * snapshots of /proc/net/tcp, NOT distributed trace spans.
 * 
 * Events are kept for 24 hours and stored as JSON on disk. This store
 * is intended to be instantiated once per target and shared across the
 * TraceRouter and GraphStore.
 */
export class TraceStore {
  private readonly filePath: string;
  /** In-memory buffer for recent events (used for WebSocket streaming) */
  private recentEvents: ConnectionEvent[] = [];
  private readonly maxRecentEvents = 500;

  constructor(targetId: string) {
    // Store in the project's data/ directory (same level as graph_db.json)
    this.filePath = path.join(process.cwd(), "data", `traces_${targetId}.json`);
  }

  async saveEvents(events: ConnectionEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Update in-memory buffer
    this.recentEvents.push(...events);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents = this.recentEvents.slice(-this.maxRecentEvents);
    }

    // Persist to disk
    const existing = await this.loadEvents();
    const updated = [...existing, ...events];
    // Keep only last 24 hours to prevent file growth
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const filtered = updated.filter(e => e.timestamp >= oneDayAgo);

    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {}
    await fs.writeFile(this.filePath, JSON.stringify(filtered, null, 2));
  }

  async loadEvents(since?: string): Promise<ConnectionEvent[]> {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      const events: ConnectionEvent[] = JSON.parse(data);
      if (since) {
        return events.filter(e => e.timestamp >= since);
      }
      return events;
    } catch (e) {
      return [];
    }
  }

  getRecentEvents(limit: number = 100): ConnectionEvent[] {
    return this.recentEvents.slice(-limit);
  }

  async clear(): Promise<void> {
    this.recentEvents = [];
    try {
      await fs.unlink(this.filePath);
    } catch (e) {}
  }
}

export type { ConnectionEvent };
