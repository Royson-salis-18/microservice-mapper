import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshAnomalyScore, ANOMALY_SCORE_MAX_AGE_MS } from '../../server/graph/GraphStore.ts';

// An ML score stands for "now" only while the scorer is producing it. After a
// restart with the scorer off, yesterday's verdicts used to be applied as
// current: six services at "anomaly 100%", painted red before anything had
// been measured.

const now = Date.parse('2026-10-01T11:00:00Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

test('freshness: a score from the last scoring cycle is used as is', () => {
  assert.deepEqual(freshAnomalyScore({ anomaly_score: 0.42, persistent: true, scored_at: at(10_000) }, now), { score: 0.42, persistent: true });
});

test('freshness: a score older than the window is ignored, however alarming', () => {
  assert.equal(freshAnomalyScore({ anomaly_score: 1, persistent: true, scored_at: at(ANOMALY_SCORE_MAX_AGE_MS + 1) }, now), null);
  assert.equal(freshAnomalyScore({ anomaly_score: 1, persistent: true, scored_at: at(17 * 3_600_000) }, now), null);
});

test('freshness: no timestamp, a bad one, or one from the future is not trusted', () => {
  assert.equal(freshAnomalyScore({ anomaly_score: 0.9, persistent: true }, now), null);
  assert.equal(freshAnomalyScore({ anomaly_score: 0.9, persistent: true, scored_at: 'yesterday' }, now), null);
  assert.equal(freshAnomalyScore({ anomaly_score: 0.9, persistent: true, scored_at: at(-10 * 60_000) }, now), null);
});

test('freshness: a missing or non-numeric score is absent, not zero', () => {
  assert.equal(freshAnomalyScore(undefined, now), null);
  assert.equal(freshAnomalyScore({ anomaly_score: 'high', scored_at: at(1000) }, now), null);
});

test('freshness: the timestamp format score.py writes (+00:00 offset) parses', () => {
  const r = freshAnomalyScore({ anomaly_score: 0.5, persistent: false, scored_at: '2026-10-01T10:59:30.123456+00:00' }, now);
  assert.deepEqual(r, { score: 0.5, persistent: false });
});
