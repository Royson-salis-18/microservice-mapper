import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestLines, summarize } from '../../server/algorithms/detection/requestStats.ts';

test('service JSON and nginx lines are both counted; 5xx are errors', () => {
  const w = parseRequestLines([
    '{"msg":"request","method":"GET","status":200,"ms":4}',
    '{"msg":"request","method":"GET","status":503,"ms":900}',
    '{"status":"200","request_time":"0.010"}',
    '{"msg":"listening","port":3000}', 'plain text', '',
  ]);
  assert.equal(w.count, 3); assert.equal(w.errors, 1);
  const s = summarize(w, 3);
  assert.equal(s.requestRate, 1); assert.equal(s.errorRate, 0.33); assert.ok(s.p95Latency! >= 10);
});
test('a quiet window is a real zero rate with unknown latency', () => {
  const s = summarize(parseRequestLines([]), 5);
  assert.equal(s.requestRate, 0); assert.equal(s.errorRate, null); assert.equal(s.p95Latency, null);
});

import { mergeWindows, throttledPercent } from '../../server/algorithms/detection/requestStats.ts';
test('rolling window: sparse windows add up to enough requests', () => {
  const w = mergeWindows([{ count: 2, errors: 0, ms: [3, 4] }, { count: 3, errors: 1, ms: [5, 6, 900] }]);
  assert.equal(w.count, 5); assert.equal(w.errors, 1); assert.equal(w.ms.length, 5);
});
test('throttling: share of scheduler periods held back by the CPU limit', () => {
  assert.equal(throttledPercent({ periods: 200, throttled: 150 }, { periods: 100, throttled: 100 }), 50);
  assert.equal(throttledPercent({ periods: 100, throttled: 5 }, { periods: 100, throttled: 5 }), 0);
  assert.equal(throttledPercent(undefined, { periods: 1, throttled: 0 }), undefined);
});
