/**
 * Unit tests for the onset module.
 *   node server/node_modules/tsx/dist/cli.mjs --test v2/onset/onset.test.ts
 * Checks: a step change is found near the true change point by every detector, a constant noisy series raises no
 * change, and in a chain of anomalous services the one whose change began first is ranked first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricTracker, CP_DEFAULTS, type DetectorKind, type CpParams } from './changepoint.ts';
import { rankByOnset } from './rca.ts';

/** Seeded Gaussian noise (mulberry32 + Box-Muller). */
function gauss(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

const KINDS: DetectorKind[] = ['cusum', 'ph', 'bocpd'];

function run(kind: DetectorKind, series: number[], extra: Partial<CpParams> = {}) {
  const tr = new MetricTracker({ ...CP_DEFAULTS, kind, ...extra }, 0.05);
  return series.map((y, i) => tr.update(y, i));
}

for (const kind of KINDS) {
  test(`${kind}: a step change is detected near the true change point`, () => {
    const g = gauss(11), T = 150;
    const series = Array.from({ length: 300 }, (_, i) => 1 + 0.1 * g() + (i >= T ? 0.6 : 0));
    const out = run(kind, series);
    const first = out.findIndex((r, i) => i >= 20 && r.on && r.mag >= CP_DEFAULTS.magMin);
    assert.ok(first >= T && first <= T + 5, `${kind} flagged at ${first}, change at ${T}`);
    assert.ok(Math.abs(out[first].onsetIdx - T) <= 3, `${kind} onset ${out[first].onsetIdx}, change at ${T}`);
    // and it stays on during the change
    assert.ok(out.slice(T + 5, T + 60).every((r) => r.on), `${kind} dropped the change`);
  });

  test(`${kind}: a constant noisy series raises no change`, () => {
    const g = gauss(5);
    const series = Array.from({ length: 2000 }, () => 2 + 0.1 * g());
    const out = run(kind, series);
    const flagged = out.filter((r) => r.on && r.mag >= CP_DEFAULTS.magMin).length;
    assert.ok(flagged <= 4, `${kind} flagged ${flagged} of 2000 moments`);
  });
}

test('earliest onset wins in a chain', () => {
  // db <- api <- gateway, all anomalous; the walk prefers the gateway, but db changed first
  const services = ['gateway', 'api', 'db', 'other'];
  const edges: [string, string][] = [['gateway', 'api'], ['api', 'db']];
  const onset = { gateway: 30_000, api: 15_000, db: 0 } as Record<string, number>;
  const walk = { gateway: 0.5, api: 0.3, db: 0.2, other: 0 } as Record<string, number>;
  const base = ['gateway', 'api', 'db', 'other'];
  for (const form of ['earliest', 'decay', 'rrf'] as const) {
    const r = rankByOnset({ services, edges, base, hard: new Set(), walk: (id) => walk[id], onset: (id) => onset[id] ?? null }, { form, tau: 10, beta: 2, rrfK: 1 });
    assert.equal(r[0], 'db', `${form}: ${r.join(',')}`);
  }
  // an unconnected early change does not take over
  const r2 = rankByOnset({ services, edges, base, hard: new Set(), walk: (id) => walk[id], onset: (id) => (id === 'other' ? -60_000 : onset[id] ?? null) }, { form: 'earliest', tau: 10, beta: 2, rrfK: 1 });
  assert.equal(r2[0], 'db');
});
