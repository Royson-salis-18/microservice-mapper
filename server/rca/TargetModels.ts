/**
 * One model per architecture (target), retrained from that target's own baseline every time the app starts and every few
 * minutes after. The training itself is pure (TargetModel.ts); this class holds the models, the time spans to leave out of
 * the baseline (while an incident was open, the system was not healthy), and saves them under data/models/ so they can be
 * inspected. Models are NOT loaded back from disk: each start trains afresh from the persisted metric history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { trainTarget, type TargetModel } from '../algorithms/model/TargetModel.js';
import type { GraphStore } from '../graph/GraphStore.js';
import type { LearnedScorer } from './LearnedScorer.js';

const RETRAIN_MS = 5 * 60_000;
const RECOVERY_MS = 60_000;

export const baselineNeededSec = () => Math.max(1, Number(process.env.MAPPER_BASELINE_MIN ?? 30)) * 60;

export class TargetModels {
  private models = new Map<string, TargetModel>();
  private spans = new Map<string, [number, number | null][]>();
  private timer: NodeJS.Timeout | null = null;
  private readonly dir = path.resolve(process.cwd(), 'data', 'models');

  constructor(private readonly graph: GraphStore, private readonly learned: LearnedScorer) {}

  /** Train every target now (at app start), then keep the models fresh. */
  start(): void {
    this.loadSpans();
    this.trainAll();
    this.timer = setInterval(() => this.trainAll(), RETRAIN_MS);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  get(targetId: string): TargetModel {
    return this.models.get(targetId) ?? this.train(targetId);
  }

  all(): TargetModel[] { return [...this.models.values()]; }

  /** Called every evaluation: remember when an incident was open so those moments stay out of the baseline. */
  noteIncident(targetId: string, open: boolean, now = Date.now()): void {
    const list = this.spans.get(targetId) ?? [];
    const last = list.at(-1);
    if (open && (!last || last[1] !== null)) list.push([now, null]);
    else if (!open && last && last[1] === null) last[1] = now + RECOVERY_MS;
    this.spans.set(targetId, list.filter((s) => (s[1] ?? Infinity) > now - 3 * 3600_000));
  }

  clear(targetId?: string): void {
    for (const id of targetId ? [targetId] : [...this.models.keys()]) {
      this.models.delete(id); this.spans.delete(id);
      try { fs.rmSync(path.join(this.dir, `${id}.json`), { force: true }); } catch { /* nothing saved */ }
    }
  }

  trainAll(): void {
    const targets = new Set([...(this.graph.nodesByTarget?.keys() ?? [])]);
    for (const id of targets) { try { this.train(id); } catch (e) { console.warn(`[TargetModels] training ${id} failed:`, e); } }
  }

  private train(targetId: string): TargetModel {
    const nodes = this.graph.nodesByTarget
      ? [...(this.graph.nodesByTarget.get(targetId)?.values() ?? [])]
      : this.graph.getGraph().nodes.filter((n) => n.project === targetId);
    const edges = (this.graph.edgesByTarget ? [...(this.graph.edgesByTarget.get(targetId)?.values() ?? [])] : this.graph.getGraph().edges).filter((e) => e.observed).map((e) => [e.source, e.target] as [string, string]);
    const spans = this.spans.get(targetId) ?? [];
    const w = this.learned.current();
    const model = trainTarget({
      target: targetId, nodes, edges, needSec: baselineNeededSec(),
      history: (id) => this.graph.metricStore?.getAll?.(id) ?? [],
      weights: w ? { ...w, threshold: w.threshold } : null,
      exclude: (ts) => spans.some(([a, b]) => ts >= a && ts <= (b ?? Infinity)),
    });
    const before = this.models.get(targetId);
    this.models.set(targetId, model);
    if (!before || before.state !== model.state) console.log(`[TargetModels] ${targetId}: ${model.state} (${Math.round(model.baselineSec / 60)} of ${Math.round(model.needSec / 60)} min of baseline, ${model.scorer} scorer, threshold ${model.threshold.toFixed(3)})`);
    this.save(targetId, model);
    return model;
  }

  private save(targetId: string, model: TargetModel): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${targetId}.json`), JSON.stringify({ model, spans: this.spans.get(targetId) ?? [] }, null, 2));
    } catch { /* inspection copy only */ }
  }

  private loadSpans(): void {
    try {
      for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith('.json'))) {
        const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (Array.isArray(d.spans)) this.spans.set(f.replace(/\.json$/, ''), d.spans);
      }
    } catch { /* first start */ }
  }
}
