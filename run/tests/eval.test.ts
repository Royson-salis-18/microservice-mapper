import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedger, score, wilson, auc, norm, parseTrafficLog, type Snapshot, type SnapIncident, type LedgerFault, type ImpactSample } from '../../algorithms/evaluation/score.ts';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (s: number) => T0 + s * 1000;
const fault = (id: string, cls: string, target: string, a: number, b: number, affected: string[]): LedgerFault => ({
  id, class: cls, target, source: 'plan', durationSec: b - a, a: at(a), b: at(b), truth: { rootCause: target, expectedAffected: affected, blastShare: 0.3 },
});
const inc = (id: string, startS: number, endS: number | null, cands: string[], affected: string[], atRisk: [string, number][] = []): SnapIncident => ({
  id, status: endS ? 'RESOLVED' : 'INCIDENT', severity: 'HIGH', startedAt: at(startS), endedAt: endS ? at(endS) : null, root: cands[0] ?? null,
  confidence: 'HIGH', candidates: cands, affected, atRisk: atRisk.map(([i, risk]) => ({ id: i, risk })),
});

// db fails 100-200 s; api degrades at 130, web at 150. The mapper opens an incident at 115 that names db. A second incident at 340-370 has no fault behind it
// (it starts after the end of cache's detection window, 270 s + 30 s grace, so it cannot count as a late detection).
// cache fails 250-270 and is never noticed.
function scenario() {
  const snaps: Snapshot[] = [];
  for (let s = 0; s <= 400; s += 5) {
    const status: Record<string, string> = { db: s >= 100 && s <= 200 ? 'critical' : 'healthy', api: s >= 130 && s <= 210 ? 'degraded' : 'healthy', web: s >= 150 && s <= 210 ? 'degraded' : 'healthy', cache: 'healthy' };
    const incidents: SnapIncident[] = [];
    if (s >= 115 && s <= 210) incidents.push(inc('I1', 115, s >= 210 ? 210 : null, ['db', 'api'], s >= 130 ? ['db', 'api'] : ['db'], s < 150 ? [['web', 0.6]] : []));
    if (s >= 340 && s <= 370) incidents.push(inc('I2', 340, s >= 370 ? 370 : null, ['cache'], ['cache']));
    snaps.push({ ts: at(s), incidents, status });
  }
  return snaps;
}

test('wilson interval: known values, and sane at the edges', () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.lo - 0.4902) < 0.002 && Math.abs(w.hi - 0.9433) < 0.002, `${w.lo} ${w.hi}`);
  assert.equal(wilson(0, 10).lo, 0);
  assert.ok(Math.abs(wilson(0, 10).hi - 0.2775) < 0.002);
  assert.ok(Number.isNaN(wilson(0, 0).p));
});

test('auc: rank identity, ties and degenerate labels', () => {
  assert.equal(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  assert.equal(auc([1, 1, 1, 1], [0, 1, 0, 1]), 0.5);
  assert.ok(Number.isNaN(auc([0.2, 0.3], [1, 1])));
});

test('ids are compared without the project prefix', () => {
  assert.equal(norm('shopflow:cart'), 'cart');
  assert.equal(norm('cart'), 'cart');
  assert.equal(norm(null), '');
});

test('ledger: start and end records are merged into one window per fault; failed injections are excluded from scoring', () => {
  const text = [
    { type: 'fault-start', id: 'f1', class: 'pause', target: 'db', startedAt: at(0), durationSec: 60, truth: { rootCause: 'db', expectedAffected: ['api'], blastShare: 0.2 } },
    { type: 'fault-end', id: 'f1', appliedAt: at(1), healedAt: at(70), endedAt: at(71) },
    { type: 'fault-start', id: 'f2', class: 'memory', target: 'api', startedAt: at(100), durationSec: 60, truth: { rootCause: 'api', expectedAffected: [], blastShare: 0.1 } },
    { type: 'fault-end', id: 'f2', error: 'docker update: refused', endedAt: at(101) },
  ].map((r) => JSON.stringify({ ts: 0, ...r })).join('\n');
  const { faults } = parseLedger(text);
  assert.equal(faults.length, 2);
  assert.deepEqual([faults[0].a, faults[0].b], [at(1), at(70)]);
  const s = score(faults, []);
  assert.deepEqual(s.excluded.map((e) => e.id), ['f2']);
  assert.equal(s.faults.length, 1);
});

test('scenario: detection, delay, root accuracy, cascade, pre-warning, false alarm', () => {
  const f1 = fault('f1', 'pause', 'db', 100, 200, ['api', 'web']);
  const f2 = fault('f2', 'crash', 'cache', 250, 270, ['api']);
  const s = score([f1, f2], scenario(), { graceSec: 30 });
  const r1 = s.faults.find((r) => r.id === 'f1')!, r2 = s.faults.find((r) => r.id === 'f2')!;

  assert.equal(r1.detected, true);
  assert.equal(r1.delaySec, 15);
  assert.equal(r1.preexisting, false);
  assert.equal(r1.rankSettled, 1);
  assert.equal(r1.top1, true);
  assert.equal(r1.top3, true);
  // settled ranking names db and lists api as affected: truth is {api, web}
  assert.deepEqual([r1.structural!.precision, r1.structural!.recall], [1, 0.5]);
  // both api and web really went non-healthy; the mapper only listed api
  assert.equal(r1.observed!.impacted, 2);
  assert.deepEqual([r1.observed!.precision, r1.observed!.recall], [1, 0.5]);
  // web was on the at-risk list (until 145) before it degraded at 150; api never was
  assert.deepEqual(r1.preWarned, { warned: 1, of: 2 });

  assert.equal(r2.detected, false);
  assert.equal(r2.rankSettled, null);

  assert.equal(s.overall.n, 2);
  assert.equal(s.overall.detected.p, 0.5);
  assert.equal(s.overall.top1.p, 1);
  assert.equal(s.byClass.pause.detected.p, 1);
  assert.equal(s.byClass.crash.detected.p, 0);

  // incident I2 (340-370 s) has no fault behind it; I1 is covered
  assert.equal(s.falseAlarm.episodes, 1);
  assert.ok(Math.abs(s.falseAlarm.minutes - 0.5) < 0.05, `${s.falseAlarm.minutes}`);
  assert.ok(Math.abs(s.falseAlarm.spanHours - 400 / 3600) < 1e-9);
});

test('an incident that was already open counts as detected with delay 0 and is flagged', () => {
  const f = fault('f', 'pause', 'db', 100, 200, ['api']);
  const snaps: Snapshot[] = [];
  for (let s = 0; s <= 250; s += 5) snaps.push({ ts: at(s), status: { db: 'healthy', api: 'healthy' }, incidents: s >= 90 ? [inc('I', 50, null, ['db'], ['db'])] : [] });
  const r = score([f], snaps).faults[0];
  assert.equal(r.delaySec, 0);
  assert.equal(r.preexisting, true);
});

test('root ranked second: Top-3 but not Top-1; MRR is 1/2', () => {
  const f = fault('f', 'pause', 'db', 100, 200, ['api']);
  const snaps: Snapshot[] = [];
  for (let s = 0; s <= 250; s += 5) snaps.push({ ts: at(s), status: { db: 'healthy', api: 'healthy' }, incidents: s >= 110 && s <= 210 ? [inc('I', 110, null, ['api', 'db'], ['api'])] : [] });
  const sc = score([f], snaps);
  const r = sc.faults[0];
  assert.deepEqual([r.rankSettled, r.top1, r.top3], [2, false, true]);
  assert.equal(sc.overall.mrr, 0.5);
});

test('overlapping faults: naming the OTHER active root counts only under the lenient rule', () => {
  const f1 = fault('f1', 'pause', 'db', 100, 200, ['api']);
  const f2 = fault('f2', 'brownout', 'cache', 120, 220, ['api']);
  const snaps: Snapshot[] = [];
  for (let s = 0; s <= 260; s += 5) snaps.push({ ts: at(s), status: { db: 'healthy', cache: 'healthy', api: 'healthy' }, incidents: s >= 125 && s <= 230 ? [inc('I', 125, null, ['cache', 'db'], ['cache', 'db', 'api'])] : [] });
  const sc = score([f1, f2], snaps);
  const r1 = sc.faults.find((r) => r.id === 'f1')!, r2 = sc.faults.find((r) => r.id === 'f2')!;
  assert.deepEqual([r1.concurrent, r1.top1, r1.top1AnyActive], [2, false, true]);
  assert.deepEqual([r2.top1, r2.top1AnyActive], [true, true]);
  assert.equal(sc.overall.overlapping.n, 2);
  assert.equal(sc.overall.isolated.n, 0);
});

test('calibration: at-risk probabilities are checked against what happened', () => {
  const f = fault('f', 'pause', 'db', 100, 300, ['web']);
  const snaps: Snapshot[] = [];
  for (let s = 0; s <= 400; s += 5) {
    snaps.push({
      ts: at(s), status: { db: 'healthy', web: s >= 140 && s <= 200 ? 'degraded' : 'healthy', ghost: 'healthy' },
      incidents: s >= 110 && s <= 130 ? [inc('I', 110, null, ['db'], ['db'], [['web', 0.8], ['ghost', 0.2]])] : [],
    });
  }
  const c = score([f], snaps).calibration!;
  assert.ok(c.n > 0);
  // web (risk 0.8) degrades within 120 s every time; ghost (risk 0.2) never does: perfectly ranked, and Brier is small
  assert.equal(c.auc, 1);
  assert.ok(c.brier < 0.05, `${c.brier}`);
  assert.ok(c.ece < 0.25);
});

test('confusion matrix puts missed faults in their own column', () => {
  const f1 = fault('f1', 'pause', 'db', 100, 200, ['api']);
  const f2 = fault('f2', 'crash', 'cache', 250, 270, ['api']);
  const c = score([f1, f2], scenario(), { graceSec: 30 }).confusion;
  const row = (name: string) => c.counts[c.truth.indexOf(name)];
  assert.equal(row('db')[c.predicted.indexOf('db')], 1);
  assert.equal(row('cache')[c.predicted.indexOf('(missed)')], 1);
});

test('traffic log lines are parsed (docker -t prefix, p95 and error rate)', () => {
  const text = '2026-10-13T15:03:23.456Z 15:03:23 n=23 p50=5ms p95=10ms err5xx/net=0.0%\n2026-10-13T15:03:28.456Z 15:03:28 n=29 p50=7ms p95=480ms err5xx/net=12.5%\nnoise line\n  sessions started=42 in-flight=11';
  const s = parseTrafficLog(text);
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].n, s[0].p95, s[0].err], [23, 10, 0]);
  assert.deepEqual([s[1].p95, s[1].err], [480, 12.5]);
  assert.equal(s[1].ts - s[0].ts, 5000);
});

function trafficFor(errFrom: number, errTo: number, err: number, p95: number): ImpactSample[] {
  const out: ImpactSample[] = [];
  for (let s = 0; s <= 400; s += 5) out.push({ ts: at(s), n: 20, p95: s >= errFrom && s <= errTo ? p95 : 10, err: s >= errFrom && s <= errTo ? err : 0 });
  return out;
}

test('user impact: an isolated fault that users felt is "visible"; one with no effect is not', () => {
  const felt = fault('a', 'stop', 'db', 100, 160, ['api']);
  const quiet = fault('b', 'brownout', 'cache', 250, 310, []);
  const r = score([felt, quiet], scenario(), { graceSec: 30 }, trafficFor(105, 160, 20, 900)).faults;
  assert.equal(r[0].isolated, true);
  assert.equal(r[0].userImpact!.visible, true);
  assert.ok(r[0].userImpact!.errPctMean > 5);
  assert.equal(r[1].userImpact!.visible, false);
  const s = score([felt, quiet], scenario(), { graceSec: 30 }, trafficFor(105, 160, 20, 900)).overall;
  assert.equal(s.visible, 1);
});

test('user impact is not attributed when another fault overlaps', () => {
  const a = fault('a', 'stop', 'db', 100, 200, ['api']);
  const b = fault('b', 'pause', 'cache', 150, 250, []);
  const r = score([a, b], scenario(), { graceSec: 30 }, trafficFor(110, 240, 30, 900)).faults;
  assert.deepEqual([r[0].isolated, r[0].userImpact], [false, null]);
  assert.deepEqual([r[1].isolated, r[1].userImpact], [false, null]);
});

test('a slowdown alone (no errors) counts as felt when p95 is 3x worse and at least 50 ms worse', () => {
  const f = fault('a', 'brownout', 'db', 100, 160, ['api']);
  const slow = score([f], scenario(), {}, trafficFor(105, 160, 0, 200)).faults[0].userImpact!;
  const tiny = score([f], scenario(), {}, trafficFor(105, 160, 0, 40)).faults[0].userImpact!;
  assert.equal(slow.visible, true);
  assert.equal(tiny.visible, false);          // 4x but only 30 ms worse: not something a person notices
});

import { inferFamily, FAMILY_OF } from '../../algorithms/evaluation/infer.ts';
import { bootstrapCI, kFold, spearman, binomUpper, moments, kappa } from '../../algorithms/evaluation/stats.ts';

test('fault kind is read from the evidence the mapper holds on its named root', () => {
  assert.equal(inferFamily(['container-health:container-exited-or-critical']), 'down');
  assert.equal(inferFamily(['restarts:container-restarted']), 'down');
  assert.equal(inferFamily(['container-health:container-paused', 'silence:service-went-silent']), 'frozen');
  assert.equal(inferFamily(['silence:service-went-silent']), 'frozen');
  assert.equal(inferFamily(['latency:robust-zscore-persistent', 'errorRate:robust-zscore-persistent']), 'slow');
  assert.equal(inferFamily(['memoryPercent:over-absolute-limit']), 'memory');
  assert.equal(inferFamily(['requestRate:robust-zscore-persistent', 'networkRxRate:robust-zscore-persistent']), 'isolated');
  assert.equal(inferFamily(['container-health:container-network-detached']), 'isolated');
  assert.equal(inferFamily([]), null);
  assert.equal(FAMILY_OF.partition, 'isolated');
});

test('stats helpers: seeded, and right on known values', () => {
  assert.deepEqual(bootstrapCI([1, 0, 1, 1, 0, 1, 1, 1], 500, 3), bootstrapCI([1, 0, 1, 1, 0, 1, 1, 1], 500, 3));
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]) - 1) < 1e-9);
  assert.ok(Math.abs(binomUpper(5, 5, 0.5) - 1 / 32) < 1e-9);
  assert.ok(Math.abs(moments([1, 2, 3, 4, 5]).skew) < 1e-9);
  assert.equal(kappa([[5, 0], [0, 5]]), 1);
  const f = kFold([1, 1, 0, 1, 0, 1, 1, 0, 1, 1], ['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'b'], 5, 1);
  assert.equal(f.folds.reduce((s, x) => s + x.n, 0), 10);
});

test('a soft fault that changed nothing users could feel is not ground truth for the confusion matrix', () => {
  const calmUsers: ImpactSample[] = [];
  for (let s = 0; s <= 400; s += 5) calmUsers.push({ ts: at(s), n: 20, p95: 10, err: 0 });
  const faults = [fault('f1', 'brownout', 'cache', 250, 270, []), fault('f2', 'crash', 'db', 100, 200, ['api', 'web'])];
  const r = score(faults, scenario(), {}, calmUsers);
  assert.equal(r.faults.find((f) => f.id === 'f1')!.effect, 'none');
  assert.equal(r.faults.find((f) => f.id === 'f2')!.effect, 'felt');
  assert.deepEqual(r.confusion.truth, ['db']);
  assert.equal(r.noEffect.n, 1);
  assert.equal(r.noEffect.detected, 0);
  // without a traffic log nothing can be ruled out, so it stays in
  const r2 = score(faults, scenario());
  assert.equal(r2.faults.find((f) => f.id === 'f1')!.effect, 'unknown');
  assert.deepEqual(r2.confusion.truth, ['cache', 'db']);
});
