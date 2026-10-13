// Request statistics read from a service's own log lines. Pure: no docker, no clock.
// Understands the two shapes the benches emit: the services' JSON {"msg":"request","status":200,"ms":4} and nginx's JSON access
// line {"status":"200","request_time":"0.002"}. A window with no request lines is a real zero (traffic stopped), not unknown.
export interface RequestWindow { count: number; errors: number; ms: number[]; }
export interface RequestStats {
  requestCount: number; requestRate: number; errorCount: number; errorRate: number | null;
  latency: number | null; p50Latency: number | null; p95Latency: number | null; p99Latency: number | null;
}

export function parseRequestLines(lines: string[]): RequestWindow {
  const w: RequestWindow = { count: 0, errors: 0, ms: [] };
  for (const raw of lines) {
    const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
    if (i < 0 || j < i) continue;
    let o: any;
    try { o = JSON.parse(raw.slice(i, j + 1)); } catch { continue; }
    let status: number | undefined, ms: number | undefined;
    if (o.msg === 'request' && o.status !== undefined) { status = Number(o.status); ms = Number(o.ms); }
    else if (o.request_time !== undefined && o.status !== undefined) { status = Number(o.status); ms = parseFloat(o.request_time) * 1000; }
    else continue;
    if (!Number.isFinite(status)) continue;
    w.count++;
    if (status >= 500) w.errors++;
    if (Number.isFinite(ms)) w.ms.push(ms as number);
  }
  return w;
}

const q = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];

export function summarize(w: RequestWindow, windowSec: number): RequestStats {
  const s = [...w.ms].sort((a, b) => a - b);
  const r1 = (v: number) => Math.round(v * 100) / 100;
  return {
    requestCount: w.count, requestRate: r1(w.count / Math.max(1, windowSec)), errorCount: w.errors,
    errorRate: w.count ? r1(w.errors / w.count) : null,
    latency: s.length ? r1(s.reduce((a, b) => a + b, 0) / s.length) : null,
    p50Latency: s.length ? r1(q(s, 0.5)) : null, p95Latency: s.length ? r1(q(s, 0.95)) : null, p99Latency: s.length ? r1(q(s, 0.99)) : null,
  };
}
