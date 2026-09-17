import fs from 'fs';
import path from 'path';

export interface ExperimentRecord {
  experimentId: string;
  targetId: string;
  workloadSource: 'EXTERNAL' | 'USER_SIM';
  profile: string;
  configuration: {
    mode: string;
    rate?: number;
    concurrency?: number;
    durationSeconds?: number;
  };
  startedAt: string;
  stoppedAt: string | null;
  /** INTERRUPTED = was RUNNING when the process died; see reconcileOrphanedRuns(). */
  status: 'RUNNING' | 'COMPLETED' | 'ABORTED_SAFETY' | 'STOPPED' | 'INTERRUPTED';
  stopReason?: string;
  trafficStatistics: {
    requestsAttempted: number;
    requestsCompleted: number;
    requestsSuccessful: number;
    requestsFailed: number;
    timeouts: number;
    durationSeconds: number;
    peakRate: number;
  };
  peakObservedMetrics: {
    cpuPercent: number;
    memoryPercent: number;
    latencyP95: number;
    errorRate: number;
  };
  affectedServices: string[];
}

export class ExperimentStore {
  private records: Map<string, ExperimentRecord> = new Map();
  private storagePath: string;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.storagePath = path.resolve(process.cwd(), 'data', 'experiments_db.json');
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const rec of data) {
            this.records.set(rec.experimentId, rec as ExperimentRecord);
          }
        }
        console.log(`[ExperimentStore] Loaded ${this.records.size} experiment records from disk`);
        this.reconcileOrphanedRuns();
      }
    } catch (e) {
      console.warn('[ExperimentStore] Failed to load experiments from disk:', e);
    }
  }

  /**
   * Nothing survives a process restart, so any record still marked RUNNING
   * on load belongs to a run that is definitively over — the traffic it
   * described stopped when the previous process died. Left alone these
   * accumulate and make the UI report active experiments that nobody can
   * stop because nothing is driving them. Mark them INTERRUPTED rather
   * than deleting, so the history stays intact.
   */
  private reconcileOrphanedRuns(): void {
    const orphaned = Array.from(this.records.values()).filter(r => r.status === 'RUNNING');
    if (orphaned.length === 0) return;
    const now = new Date().toISOString();
    for (const rec of orphaned) {
      rec.status = 'INTERRUPTED';
      rec.stoppedAt = rec.stoppedAt || now;
      rec.stopReason = rec.stopReason || 'Server restarted while this run was active';
    }
    console.log(`[ExperimentStore] Marked ${orphaned.length} orphaned RUNNING experiment(s) as INTERRUPTED`);
    this.scheduleSave();
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
      const payload = JSON.stringify(Array.from(this.records.values()));
      fs.writeFileSync(this.storagePath, payload, 'utf8');
    } catch (e) {
      console.error('[ExperimentStore] Failed to save experiments to disk:', e);
    }
  }

  public getRecord(experimentId: string): ExperimentRecord | undefined {
    return this.records.get(experimentId);
  }

  public getAllRecords(targetId?: string): ExperimentRecord[] {
    const all = Array.from(this.records.values());
    if (targetId) {
      return all.filter(r => r.targetId === targetId).sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    }
    return all.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  public createRecord(record: ExperimentRecord): void {
    this.records.set(record.experimentId, record);
    this.scheduleSave();
  }

  public updateRecord(experimentId: string, updates: Partial<ExperimentRecord>): void {
    const rec = this.records.get(experimentId);
    if (rec) {
      Object.assign(rec, updates);
      this.scheduleSave();
    }
  }
}
