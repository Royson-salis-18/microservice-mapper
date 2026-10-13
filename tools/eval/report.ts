// tools/eval/report.ts: turn a Score into one self-contained HTML page (inline SVG, no dependencies).
import type { Score, FaultResult } from './score.ts';

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const pct = (x: number, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : 'n/a');
const sec = (x: number) => (Number.isFinite(x) ? (x >= 90 ? `${(x / 60).toFixed(1)} min` : `${Math.round(x)} s`) : 'n/a');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

// Fixed categorical order, one slot per fault class (validated palette, dark and light steps). Colour follows the class, never its rank.
const CLASS_ORDER = ['crash', 'crash-loop', 'stop', 'pause', 'brownout', 'memory', 'partition', 'flap'];
const slot = (c: string) => `var(--c${Math.max(0, CLASS_ORDER.indexOf(c)) + 1})`;

interface Meta { subject: string; generatedAt: string; seed?: string; mapperTarget: string; observedSnapshots: number; spanMin: number }

function kpi(label: string, value: string, sub: string) {
  return `<div class="kpi"><div class="kpi-l">${esc(label)}</div><div class="kpi-v">${esc(value)}</div><div class="kpi-s">${esc(sub)}</div></div>`;
}
const ci = (w: { p: number; lo: number; hi: number; n: number }) => `${pct(w.p)} (95% CI ${pct(w.lo)}–${pct(w.hi)}, n=${w.n})`;

/** Horizontal bars with Wilson whiskers: one measure, classes down the side. */
function barChart(title: string, rows: { label: string; p: number; lo: number; hi: number; n: number }[], note = '') {
  const W = 360, L = 92, R = 14, rowH = 26, H = rows.length * rowH + 30, x = (v: number) => L + v * (W - L - R);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => `<line x1="${x(g)}" x2="${x(g)}" y1="6" y2="${H - 22}" class="grid"/><text x="${x(g)}" y="${H - 8}" class="tick" text-anchor="middle">${g * 100}%</text>`).join('');
  const bars = rows.map((r, i) => {
    const y = 10 + i * rowH, v = Number.isFinite(r.p) ? r.p : 0;
    return `<g><title>${esc(r.label)}: ${pct(r.p)} (95% CI ${pct(r.lo)}–${pct(r.hi)}), n=${r.n}</title>
      <text x="${L - 8}" y="${y + 11}" class="lab" text-anchor="end">${esc(r.label)}</text>
      <rect x="${L}" y="${y}" width="${Math.max(0, x(v) - L)}" height="14" rx="3" class="bar"/>
      ${r.n ? `<line x1="${x(r.lo)}" x2="${x(r.hi)}" y1="${y + 7}" y2="${y + 7}" class="whisker"/><line x1="${x(r.lo)}" x2="${x(r.lo)}" y1="${y + 3}" y2="${y + 11}" class="whisker"/><line x1="${x(r.hi)}" x2="${x(r.hi)}" y1="${y + 3}" y2="${y + 11}" class="whisker"/>` : ''}
      <text x="${Math.min(W - 4, x(r.hi) + 5)}" y="${y + 11}" class="val">${r.n ? pct(v) : '–'}</text></g>`;
  }).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${bars}</svg>${note ? `<p class="note">${esc(note)}</p>` : ''}</figure>`;
}

function histogram(values: number[], median: number, p90: number) {
  const W = 560, H = 190, L = 40, R = 12, T = 12, B = 34;
  if (!values.length) return `<figure><figcaption>Detection delay</figcaption><p class="note">No fault was detected, so there is no delay to show.</p></figure>`;
  const max = Math.max(60, Math.ceil(Math.max(...values) / 10) * 10), bw = max > 240 ? 30 : 10, nb = Math.ceil(max / bw);
  const bins = new Array(nb).fill(0); for (const v of values) bins[Math.min(nb - 1, Math.floor(v / bw))]++;
  const top = Math.max(...bins), x = (v: number) => L + (v / max) * (W - L - R), y = (c: number) => T + (1 - c / top) * (H - T - B);
  const bars = bins.map((c, i) => `<g><title>${i * bw}–${(i + 1) * bw} s: ${c} fault${c === 1 ? '' : 's'}</title><rect x="${x(i * bw) + 1}" y="${y(c)}" width="${x(bw) - L - 2}" height="${H - B - y(c)}" rx="2" class="bar"/></g>`).join('');
  const ticks = Array.from({ length: Math.floor(max / (bw * 2)) + 1 }, (_, i) => i * bw * 2).filter((t) => t <= max).map((t) => `<text x="${x(t)}" y="${H - 16}" class="tick" text-anchor="middle">${t}</text>`).join('');
  const mark = (v: number, label: string, dy: number) => `<line x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}" class="ref"/><text x="${x(v) + 4}" y="${T + 10 + dy}" class="val">${label}</text>`;
  return `<figure><figcaption>Detection delay (seconds from fault applied to first incident that names it)</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Detection delay histogram">
    <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/>${bars}${ticks}${mark(median, `median ${sec(median)}`, 0)}${mark(p90, `p90 ${sec(p90)}`, 14)}
    <text x="${(L + W - R) / 2}" y="${H - 2}" class="tick" text-anchor="middle">seconds</text></svg></figure>`;
}

function heat(title: string, rowLabels: string[], colLabels: string[], counts: number[][]) {
  const cw = 46, rh = 24, L = 118, T = 78, W = L + colLabels.length * cw + 8, H = T + rowLabels.length * rh + 8, max = Math.max(1, ...counts.flat());
  const cells = counts.map((row, i) => row.map((c, j) => {
    const t = c / max, miss = colLabels[j] === '(missed)';
    return `<g><title>true ${esc(rowLabels[i])} → predicted ${esc(colLabels[j])}: ${c}</title><rect x="${L + j * cw + 1}" y="${T + i * rh + 1}" width="${cw - 2}" height="${rh - 2}" rx="3" class="${c ? (miss ? 'cell miss' : 'cell') : 'cell zero'}" style="--t:${t.toFixed(2)}"/>${c ? `<text x="${L + j * cw + cw / 2}" y="${T + i * rh + 16}" class="cellv" text-anchor="middle">${c}</text>` : ''}</g>`;
  }).join('')).join('');
  const cols = colLabels.map((c, j) => `<text transform="translate(${L + j * cw + cw / 2},${T - 8}) rotate(-50)" class="lab">${esc(c)}</text>`).join('');
  const rows = rowLabels.map((r, i) => `<text x="${L - 8}" y="${T + i * rh + 16}" class="lab" text-anchor="end">${esc(r)}</text>`).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${cols}${rows}${cells}</svg><p class="note">Rows are the service that was faulted; columns are the root cause the mapper named first. The diagonal is right. The last column is faults with no incident at all.</p></figure>`;
}

function reliability(c: NonNullable<Score['calibration']>) {
  const S = 260, L = 38, B = 32, T = 10, R = 10, x = (v: number) => L + v * (S - L - R), y = (v: number) => T + (1 - v) * (S - T - B);
  const pts = c.bins.filter((b) => b.n).map((b) => `<g><title>predicted ${pct(b.meanRisk)} → happened ${pct(b.rate)} (n=${b.n})</title><circle cx="${x(b.meanRisk)}" cy="${y(b.rate)}" r="${Math.min(10, 3 + Math.sqrt(b.n))}" class="dot"/></g>`).join('');
  const line = c.bins.filter((b) => b.n).map((b) => `${x(b.meanRisk)},${y(b.rate)}`).join(' ');
  const ticks = [0, 0.5, 1].map((t) => `<text x="${x(t)}" y="${S - 14}" class="tick" text-anchor="middle">${t * 100}%</text><text x="${L - 6}" y="${y(t) + 3}" class="tick" text-anchor="end">${t * 100}%</text>`).join('');
  return `<figure><figcaption>Is "at risk" honest? (reliability of the cascade warnings)</figcaption><svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Reliability diagram">
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" class="ref"/><polyline points="${line}" class="trace"/>${pts}${ticks}
    <text x="${(L + S) / 2}" y="${S - 2}" class="tick" text-anchor="middle">stated risk</text><text transform="translate(9,${S / 2}) rotate(-90)" class="tick" text-anchor="middle">went unhealthy soon after</text></svg>
    <p class="note">${c.n} warnings. Brier ${num(c.brier, 3)}, ECE ${num(c.ece, 3)}, AUC ${num(c.auc, 2)}. Points above the dashed diagonal mean the warnings were too timid; below, too alarmist.</p></figure>`;
}

function timeline(score: Score, serviceOrder: string[], t0: number, t1: number, incidents: { id: string; s: number; e: number; root: string | null }[]) {
  const W = 980, L = 130, R = 16, rowH = 24, T = 26, rows = [...serviceOrder, '(mapper incidents)'], H = T + rows.length * rowH + 30;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const grid = rows.map((r, i) => `<line x1="${L}" x2="${W - R}" y1="${T + (i + 1) * rowH - 2}" y2="${T + (i + 1) * rowH - 2}" class="grid"/><text x="${L - 8}" y="${T + i * rowH + 15}" class="lab" text-anchor="end">${esc(r)}</text>`).join('');
  const nTicks = 8, ticks = Array.from({ length: nTicks + 1 }, (_, i) => t0 + ((t1 - t0) * i) / nTicks).map((t) => `<text x="${x(t)}" y="${H - 10}" class="tick" text-anchor="middle">${Math.round((t - t0) / 60000)} min</text>`).join('');
  const bars = score.faults.map((f) => {
    const i = serviceOrder.indexOf(f.target); if (i < 0) return '';
    return `<g><title>${esc(f.id)} ${esc(f.class)} on ${esc(f.target)}: ${f.detected ? `detected after ${sec(f.delaySec ?? NaN)}, ranked #${f.rankSettled ?? 'none'}` : 'not detected'}</title><rect x="${x(f.a)}" y="${T + i * rowH + 3}" width="${Math.max(3, x(f.b) - x(f.a))}" height="${rowH - 8}" rx="3" fill="${slot(f.class)}" opacity="${f.detected ? 1 : 0.45}"/>${f.detected ? '' : `<line x1="${x(f.a)}" x2="${x(f.b)}" y1="${T + i * rowH + rowH / 2 - 1}" y2="${T + i * rowH + rowH / 2 - 1}" class="missline"/>`}</g>`;
  }).join('');
  const ir = rows.length - 1;
  const inc = incidents.map((i) => `<g><title>incident ${esc(i.id)}, root named: ${esc(i.root ?? 'none')}</title><rect x="${x(i.s)}" y="${T + ir * rowH + 3}" width="${Math.max(3, x(i.e) - x(i.s))}" height="${rowH - 8}" rx="3" class="incbar"/></g>`).join('');
  const legend = CLASS_ORDER.map((c, k) => `<span class="lg"><i style="background:var(--c${k + 1})"></i>${c}</span>`).join('');
  return `<figure class="wide"><figcaption>Timeline: what was broken, and when the mapper noticed</figcaption><div class="legend">${legend}<span class="lg"><i class="inc"></i>mapper incident</span><span class="lg"><i class="ghost"></i>fault the mapper did not report</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fault and incident timeline">${grid}${bars}${inc}${ticks}</svg></figure>`;
}

function table(faults: FaultResult[], t0: number) {
  const head = ['fault', 'class', 'faulted service', 'at', 'for', 'concurrent', 'detected', 'delay', 'rank of true root', 'mapper named', 'cascade precision / recall (structural)', 'precision / recall (observed)'];
  const body = faults.map((f) => `<tr><td>${esc(f.id)}</td><td><i class="sw" style="background:${slot(f.class)}"></i>${esc(f.class)}</td><td>${esc(f.target)}</td><td>${Math.round((f.a - t0) / 60000)} min</td><td>${sec((f.b - f.a) / 1000)}</td><td>${f.concurrent}</td>
    <td>${f.detected ? 'yes' : 'no'}${f.preexisting ? ' (already open)' : ''}</td><td>${f.delaySec === null ? '–' : sec(f.delaySec)}</td><td>${f.rankSettled ?? '–'}</td><td>${esc(f.predictedRoot ?? '–')}</td>
    <td>${f.structural ? `${pct(f.structural.precision)} / ${pct(f.structural.recall)}` : '–'}</td><td>${f.observed ? `${pct(f.observed.precision)} / ${pct(f.observed.recall)} (${f.observed.impacted} hit)` : '–'}</td></tr>`).join('');
  return `<details><summary>Table view: every fault</summary><div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div></details>`;
}

export function renderReport(score: Score, meta: Meta, incidents: { id: string; s: number; e: number; root: string | null }[], t0: number, t1: number, serviceOrder: string[]): string {
  const o = score.overall;
  const classes = Object.keys(score.byClass).sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b));
  const rows = (k: 'detected' | 'top1' | 'top3') => classes.map((c) => ({ label: c, ...score.byClass[c][k] }));
  const css = `
:root{color-scheme:light dark;--bg:#fcfcfb;--panel:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--ink3:#8a8984;--line:#e5e4df;--grid:#ecebe6;--accent:#2a78d6;--c1:#2a78d6;--c2:#eb6834;--c3:#1baf7a;--c4:#eda100;--c5:#e87ba4;--c6:#008300;--c7:#6250d6;--c8:#e34948;--cell:#2a78d6;--miss:#e34948}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121211;--panel:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--ink3:#8a897f;--line:#2e2e2b;--grid:#262624;--accent:#3987e5;--c1:#3987e5;--c2:#d95926;--c3:#199e70;--c4:#c98500;--c5:#d55181;--c6:#008300;--c7:#9085e9;--c8:#e66767;--cell:#3987e5;--miss:#e66767}}
:root[data-theme=dark]{--bg:#121211;--panel:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--ink3:#8a897f;--line:#2e2e2b;--grid:#262624;--accent:#3987e5;--c1:#3987e5;--c2:#d95926;--c3:#199e70;--c4:#c98500;--c5:#d55181;--c6:#008300;--c7:#9085e9;--c8:#e66767;--cell:#3987e5;--miss:#e66767}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:32px 20px 64px}h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:16px;margin:36px 0 12px;letter-spacing:-.01em}
.sub{color:var(--ink2);margin:0 0 24px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.kpi-l{font-size:12px;color:var(--ink2)}.kpi-v{font-size:28px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:2px}.kpi-s{font-size:12px;color:var(--ink3);margin-top:2px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}figure.wide{grid-column:1/-1}
figcaption{font-weight:600;font-size:13px;margin-bottom:8px}svg{width:100%;height:auto;display:block}.note{color:var(--ink2);font-size:12px;margin:8px 0 0}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--ink3);stroke-width:1}.tick{fill:var(--ink3);font-size:10px}.lab{fill:var(--ink2);font-size:11px}.val{fill:var(--ink2);font-size:11px;font-variant-numeric:tabular-nums}
.bar{fill:var(--accent)}.whisker{stroke:var(--ink2);stroke-width:1.4}.ref{stroke:var(--ink3);stroke-width:1;stroke-dasharray:4 4}.trace{fill:none;stroke:var(--accent);stroke-width:2}.dot{fill:var(--accent);stroke:var(--panel);stroke-width:2}
.cell{fill:var(--cell);fill-opacity:calc(.25 + var(--t)*.75)}.cell.miss{fill:var(--miss);fill-opacity:calc(.25 + var(--t)*.6)}.cell.zero{fill:var(--grid);fill-opacity:.55}.cellv{fill:#fff;font-size:11px;font-weight:600}
.incbar{fill:var(--ink2);opacity:.55}.missline{stroke:var(--miss);stroke-width:2;stroke-dasharray:3 3}.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 8px;font-size:12px;color:var(--ink2)}.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}.lg i.inc{background:var(--ink2);opacity:.55}.lg i.ghost{background:transparent;border:1.5px dashed var(--miss)}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}details{margin-top:24px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 16px}summary{cursor:pointer;font-weight:600}.tablewrap{overflow:auto;margin-top:10px}
table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--ink2);font-weight:600}
.caveat{color:var(--ink2);font-size:12px;margin-top:28px}`;
  const cal = score.calibration ? reliability(score.calibration) : `<figure><figcaption>Is "at risk" honest?</figcaption><p class="note">The mapper issued no at-risk warnings during this run, so there is nothing to calibrate.</p></figure>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mapper evaluation: ${esc(meta.subject)}</title><style>${css}</style></head><body><div class="wrap">
<h1>Mapper evaluation: ${esc(meta.subject)}</h1>
<p class="sub">${o.n} injected faults over ${Math.round(meta.spanMin)} min, scored against the injector's private ledger. Mapper target <b>${esc(meta.mapperTarget)}</b>, ${meta.observedSnapshots} snapshots, generated ${esc(meta.generatedAt)}${meta.seed ? `, campaign seed ${esc(meta.seed)}` : ''}.</p>
<div class="kpis">
${kpi('Faults detected', pct(o.detected.p), `${ci(o.detected)}`)}
${kpi('Root cause Top-1', pct(o.top1.p), `of detected. ${ci(o.top1)}`)}
${kpi('Root cause Top-3', pct(o.top3.p), `of detected. ${ci(o.top3)}`)}
${kpi('Median time to notice', sec(o.delaySec.median), `p90 ${sec(o.delaySec.p90)}`)}
${kpi('False alarms', `${num(score.falseAlarm.perHour, 2)}/h`, `${score.falseAlarm.episodes} incident(s), ${num(score.falseAlarm.minutes, 1)} min with no fault`)}
${kpi('Cascade F1 (observed)', pct(o.observed.f1), `precision ${pct(o.observed.precision)}, recall ${pct(o.observed.recall)}`)}
</div>
<h2>When and where</h2><div class="grid2">${timeline(score, serviceOrder, t0, t1, incidents)}</div>
<h2>Detection and root-cause accuracy by fault class</h2><div class="grid2">
${barChart('Detected', rows('detected'))}${barChart('Root cause Top-1 (of detected)', rows('top1'), 'Settled ranking: the last one before the fault was healed.')}${barChart('Root cause Top-3 (of detected)', rows('top3'))}
${histogram(o.delaySec.values, o.delaySec.median, o.delaySec.p90)}</div>
<h2>Which service was blamed</h2><div class="grid2">${heat('True root cause against the mapper\'s first choice', score.confusion.truth, score.confusion.predicted, score.confusion.counts)}${cal}</div>
<h2>Cascade quality</h2><div class="grid2"><figure><figcaption>Affected-set quality (mean over detected faults)</figcaption><table><thead><tr><th></th><th>precision</th><th>recall</th><th>F1</th></tr></thead><tbody>
<tr><td>vs structural truth (everything that depends on the root)</td><td>${pct(o.structural.precision)}</td><td>${pct(o.structural.recall)}</td><td>${pct(o.structural.f1)}</td></tr>
<tr><td>vs observed impact (what actually went unhealthy)</td><td>${pct(o.observed.precision)}</td><td>${pct(o.observed.recall)}</td><td>${pct(o.observed.f1)}</td></tr></tbody></table>
<p class="note">Structural recall is capped by design: retries and caches absorb many faults, so not everything downstream breaks. The observed rows judge the mapper against what really happened.${o.preWarned ? ` Of services that did go unhealthy, ${pct(o.preWarned.p)} were on the at-risk list first (${o.preWarned.n} cases).` : ''}</p></figure>
<figure><figcaption>Isolated against overlapping faults</figcaption><table><thead><tr><th></th><th>faults</th><th>detected</th><th>Top-1</th><th>Top-1 (any active root)</th></tr></thead><tbody>
<tr><td>one fault at a time</td><td>${o.isolated.n}</td><td>${pct(o.isolated.detected.p)}</td><td>${pct(o.isolated.top1.p)}</td><td>${pct(o.isolated.top1AnyActive.p)}</td></tr>
<tr><td>overlapping faults</td><td>${o.overlapping.n}</td><td>${pct(o.overlapping.detected.p)}</td><td>${pct(o.overlapping.top1.p)}</td><td>${pct(o.overlapping.top1AnyActive.p)}</td></tr></tbody></table>
<p class="note">With two faults live, an incident can only be about one of them; the lenient column counts a ranking that names any root that was active.</p></figure></div>
${table(score.faults, t0)}
<p class="caveat">Method: a fault is <i>detected</i> when an incident open during it (plus ${score.options.graceSec} s grace) names its root or something that depends on it among its top three candidates or affected services. Intervals are Wilson 95%. ${score.excluded.length ? `Excluded from scoring because the injection itself failed: ${score.excluded.map((e) => esc(e.id)).join(', ')}.` : ''} The mapper was observed only through its public API; the ledger was read after the run. Small samples give wide intervals: read the whiskers, not just the bars.</p>
</div></body></html>`;
}
