#!/usr/bin/env node
/**
 * v2/report/postmortem.ts: a postmortem page for a run. One self-contained HTML file per run that shows, on one time
 * axis, what every service looked like, which faults were injected, when the engine alarmed, whom it named first, and
 * whether that was right. Made for reviewing misses and for demos.
 *
 *   node server/node_modules/tsx/dist/cli.mjs v2/report/postmortem.ts v2/.cache/real.json [--engine hybrid|ml|rules] [--out v2/reports]
 *
 * Rows: one per service, coloured by the v1 ML level (grey typical, amber over its own line, red at the alarm level,
 * black for a container fact). Fault bands sit on the faulted service's row. Below: the alarm band and the name the engine
 * put first at each moment (green when it is the service that was actually faulted at that time).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTraces, type Trace } from '../core/trace.ts';
import { score, V1, type Engine } from '../core/score.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const engineName = opt('engine', 'hybrid') as keyof typeof V1;
const outDir = path.resolve(opt('out', 'v2/reports'));
const engine: Engine = V1[engineName] ?? V1.hybrid;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const clock = (ts: number) => new Date(ts).toISOString().slice(11, 19);

function page(t: Trace): string {
  const n = t.moments.length;
  const services = [...new Set(t.moments.flatMap((m) => m.services))].filter((s) => s !== 'traffic').sort();
  const W = 1200, label = 150, rowH = 16, cols = Math.min(n, W);
  const per = n / cols;                                   // moments per pixel column
  const x = (i: number) => label + (i / per);
  const xs = (ts: number) => { const i = t.moments.findIndex((m) => m.ts >= ts); return x(i < 0 ? n : i); };
  const top = 28, H = top + services.length * rowH + 3 * rowH + 30;
  const verdict = t.moments.map((_, i) => engine(t, i));
  const alarm = verdict.map((v, i) => v.max >= 1 && i > 0 && verdict[i - 1].max >= 1);
  const svg: string[] = [];

  // service rows: worst level in each pixel column
  services.forEach((id, r) => {
    const y = top + r * rowH;
    svg.push(`<text x="${label - 6}" y="${y + 12}" class="lbl" text-anchor="end">${esc(id)}</text>`);
    for (let c = 0; c < cols; c++) {
      let lv = 0, hard = false;
      for (let i = Math.floor(c * per); i < Math.min(n, Math.floor((c + 1) * per) || 1); i++) { const v = t.moments[i].ml[id]; if (v) { lv = Math.max(lv, v[0]); hard ||= v[4] === 1; } }
      const cls = hard ? 'fact' : lv >= 2 ? 'hi' : lv >= 1 ? 'mid' : lv > 0.3 ? 'low' : '';
      if (cls) svg.push(`<rect x="${label + c}" y="${y + 2}" width="1.2" height="${rowH - 4}" class="${cls}"/>`);
    }
  });
  // faults on their target's row
  for (const f of t.faults) {
    const r = services.indexOf(f.target); if (r < 0) continue;
    const x0 = xs(f.a), x1 = Math.max(x0 + 2, xs(f.b));
    svg.push(`<rect x="${x0}" y="${top + r * rowH}" width="${x1 - x0}" height="${rowH}" class="fault"><title>${esc(`${f.id} ${f.class} on ${f.target}, ${clock(f.a)} to ${clock(f.b)}`)}</title></rect>`);
    svg.push(`<text x="${x0}" y="${top - 6}" class="flbl">${esc(f.id)}</text>`);
  }
  // alarm band and who was named first
  const yA = top + services.length * rowH + 8, yN = yA + rowH + 4;
  svg.push(`<text x="${label - 6}" y="${yA + 12}" class="lbl" text-anchor="end">alarm</text><text x="${label - 6}" y="${yN + 12}" class="lbl" text-anchor="end">named first</text>`);
  for (let c = 0; c < cols; c++) {
    const i = Math.min(n - 1, Math.floor(c * per));
    if (alarm[i]) {
      svg.push(`<rect x="${label + c}" y="${yA}" width="1.2" height="${rowH - 2}" class="alarm"/>`);
      const who = verdict[i].ranked[0], active = t.faults.filter((f) => t.moments[i].ts >= f.a && t.moments[i].ts <= f.b).map((f) => f.target);
      svg.push(`<rect x="${label + c}" y="${yN}" width="1.2" height="${rowH - 2}" class="${active.includes(who) ? 'right' : active.length ? 'wrong' : 'none'}"/>`);
    }
  }
  // time axis
  for (let k = 0; k <= 6; k++) { const i = Math.min(n - 1, Math.round((k / 6) * (n - 1))); svg.push(`<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${clock(t.moments[i].ts)}</text>`); }

  const s = score([t], engine);
  const rows = s.outcomes.map((o) => `<tr class="${o.detected && o.top1 ? 'ok' : o.detected ? 'part' : 'miss'}"><td>${o.id}</td><td>${esc(o.class)}</td><td>${esc(o.target)}</td><td>${o.detected ? 'yes' : 'no'}</td><td>${o.delaySec === null ? '' : `${o.delaySec.toFixed(0)} s`}</td><td>${esc(o.predicted ?? '')}</td><td>${o.detected && o.top1 ? 'right' : o.detected ? 'wrong service' : 'missed'}</td></tr>`).join('');
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Postmortem ${esc(t.name)}</title><style>
:root{--bg:#fbfbfa;--fg:#1d1f23;--muted:#6b7078;--line:#e3e4e6;--low:#d8dbe0;--mid:#f0b54a;--hi:#e0594b;--fact:#2b2d31;--fault:rgba(80,120,230,.16);--fault-edge:#5078e6;--right:#3aa76d;--wrong:#e0594b;--none:#b9bdc4}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15171a;--fg:#e6e7e9;--muted:#9aa0a8;--line:#2a2d32;--low:#3a3e45;--fact:#f2f2f2;--fault:rgba(110,150,255,.2);--none:#555a62}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1400px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 16px}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 18px}.kpi{border:1px solid var(--line);border-radius:8px;padding:8px 12px}.kpi b{display:block;font-size:20px}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;padding:8px}svg text{fill:var(--fg)}.lbl{font-size:11px}.flbl{font-size:9px;fill:var(--muted)!important}.axis{font-size:10px;fill:var(--muted)!important}
.low{fill:var(--low)}.mid{fill:var(--mid)}.hi{fill:var(--hi)}.fact{fill:var(--fact)}.fault{fill:var(--fault);stroke:var(--fault-edge);stroke-width:1}.alarm{fill:var(--hi)}.right{fill:var(--right)}.wrong{fill:var(--wrong)}.none{fill:var(--none)}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin:8px 0}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;margin-top:18px;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}tr.miss td:last-child{color:var(--wrong)}tr.part td:last-child{color:var(--mid)}tr.ok td:last-child{color:var(--right)}
</style></head><body><main>
<h1>Postmortem: ${esc(t.name)}</h1><p class="sub">${t.faults.length} injected faults, ${services.length} services, ${clock(t.t0)} to ${clock(t.t1)}. Engine: v1 ${esc(engineName)}.</p>
<div class="kpis"><div class="kpi">Detected<b>${pct(s.detected)}</b></div><div class="kpi">Right service first<b>${pct(s.top1OfDetected)}</b></div><div class="kpi">Caught and named<b>${pct(s.caughtAndNamed)}</b></div><div class="kpi">False alarms per hour<b>${s.falseAlarmsPerHour.toFixed(1)}</b></div><div class="kpi">Time in alarm (fault-free)<b>${pct(s.alarmShare)}</b></div></div>
<div class="legend"><span><i class="sw" style="background:var(--low)"></i>a little off</span><span><i class="sw" style="background:var(--mid)"></i>over its own line</span><span><i class="sw" style="background:var(--hi)"></i>alarm level</span><span><i class="sw" style="background:var(--fact)"></i>down, stopped, restarting</span><span><i class="sw" style="background:var(--fault);border:1px solid var(--fault-edge)"></i>injected fault</span><span><i class="sw" style="background:var(--right)"></i>named the faulted service</span><span><i class="sw" style="background:var(--wrong)"></i>named another service</span></div>
<div class="wrap"><svg width="${label + cols + 20}" height="${H}" role="img" aria-label="timeline">${svg.join('')}</svg></div>
<table><thead><tr><th>Fault</th><th>Class</th><th>Target</th><th>Detected</th><th>Delay</th><th>Named first</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>
</main></body></html>`;
}

fs.mkdirSync(outDir, { recursive: true });
for (const f of files) for (const t of loadTraces(f)) {
  const file = path.join(outDir, `${t.name.replace(/[^\w.-]+/g, '_')}.html`);
  fs.writeFileSync(file, page(t));
  console.log(path.relative(process.cwd(), file));
}
