import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestLines, summarize } from '../remote-collector/requestStats.ts';

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
