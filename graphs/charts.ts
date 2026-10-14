// graphs/charts.ts: dependency-free SVG charts for the model lab report. PURE (strings in, strings out).
// One visual language: thin axes, light grid, a fixed categorical palette that follows the series (never its rank), titles say what is measured.

export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const f2 = (x: number | null | undefined, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : 'n/a');
export const pct = (x: number | null | undefined, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : 'n/a');
export const PAL = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

const nice = (lo: number, hi: number, n = 5) => {
  if (!(hi > lo)) return { lo: lo - 1, hi: hi + 1, ticks: [lo - 1, lo, hi + 1] };
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo: a, hi: b, ticks };
};
const tick = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : Math.abs(v) < 1 && v !== 0 ? v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : String(Math.round(v * 100) / 100));

function frame(title: string, w: number, h: number, body: string, note = '') {
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">${body}</svg>${note ? `<p class="note">${note}</p>` : ''}</figure>`;
}
const legend = (items: { label: string; color: string }[]) => items.length > 1
  ? `<div class="legend">${items.map((i) => `<span class="lg"><i style="background:${i.color}"></i>${esc(i.label)}</span>`).join('')}</div>` : '';

export interface Series { label: string; color: string; values: number[] }

/** Overlaid histograms on one shared set of bins; heights are shares of each series so different sample sizes stay comparable. */
export function histogram(o: { title: string; series: Series[]; bins?: number; range?: [number, number]; xlabel?: string; note?: string; w?: number; h?: number }) {
  const W = o.w ?? 460, H = o.h ?? 210, L = 40, R = 12, T = 12, B = 38, nb = o.bins ?? 28;
  const all = o.series.flatMap((s) => s.values.filter(Number.isFinite));
  if (all.length < 2) return frame(o.title, W, 60, `<text x="10" y="30" class="lab">not enough data</text>`, o.note);
  const sorted = [...all].sort((a, b) => a - b), q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
  const lo = o.range?.[0] ?? q(0.005), hi = o.range?.[1] ?? q(0.995), span = hi > lo ? hi - lo : 1, bw = span / nb;
  const counts = o.series.map((s) => { const c = new Array(nb).fill(0); let n = 0; for (const v of s.values) { if (!Number.isFinite(v)) continue; n++; c[Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / bw)))]++; } return c.map((x) => (n ? x / n : 0)); });
  const top = Math.max(0.0001, ...counts.flat()), x = (v: number) => L + ((v - lo) / span) * (W - L - R), y = (c: number) => T + (1 - c / top) * (H - T - B);
  const yt = nice(0, top, 4).ticks.filter((t) => t <= top * 1.001);
  const grid = yt.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 3}" class="tick" text-anchor="end">${pct(t, 0)}</text>`).join('');
  const bars = counts.map((c, si) => c.map((v, i) => `<rect x="${x(lo + i * bw) + 0.5}" y="${y(v)}" width="${Math.max(1, x(lo + bw) - x(lo) - 1)}" height="${H - B - y(v)}" fill="${o.series[si].color}" opacity="${o.series.length > 1 ? 0.55 : 0.9}"/>`).join('')).join('');
  const xt = nice(lo, hi, 5).ticks.filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9).map((t) => `<text x="${x(t)}" y="${H - B + 14}" class="tick" text-anchor="middle">${tick(t)}</text>`).join('');
  const body = `${grid}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/>${bars}${xt}${o.xlabel ? `<text x="${(L + W - R) / 2}" y="${H - 4}" class="tick" text-anchor="middle">${esc(o.xlabel)}</text>` : ''}`;
  return frame(o.title, W, H, body, o.note).replace('</figcaption>', `</figcaption>${legend(o.series)}`);
}

export interface Line { label: string; color: string; points: [number, number][]; dash?: boolean; width?: number }

export function lines(o: { title: string; series: Line[]; xlabel?: string; ylabel?: string; yRange?: [number, number]; xRange?: [number, number]; bands?: { a: number; b: number; label?: string }[];
  vlines?: { x: number; label: string }[]; diag?: boolean; note?: string; w?: number; h?: number; xFmt?: (v: number) => string; yFmt?: (v: number) => string; logX?: boolean; dots?: boolean }) {
  const W = o.w ?? 460, H = o.h ?? 230, L = 46, R = 14, T = 12, B = 40;
  const pts = o.series.flatMap((s) => s.points).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pts.length < 2) return frame(o.title, W, 60, `<text x="10" y="30" class="lab">not enough data</text>`, o.note);
  const tx = (v: number) => (o.logX ? Math.log10(Math.max(v, 1e-9)) : v);
  let xl = o.xRange?.[0] ?? Math.min(...pts.map((p) => p[0])), xh = o.xRange?.[1] ?? Math.max(...pts.map((p) => p[0]));
  let yl = o.yRange?.[0] ?? Math.min(...pts.map((p) => p[1])), yh = o.yRange?.[1] ?? Math.max(...pts.map((p) => p[1]));
  const yn = o.yRange ? { lo: yl, hi: yh, ticks: nice(yl, yh, 4).ticks.filter((t) => t >= yl - 1e-9 && t <= yh + 1e-9) } : nice(yl, yh, 4);
  yl = yn.lo; yh = yn.hi;
  const xn = o.logX ? { lo: tx(xl), hi: tx(xh), ticks: [] as number[] } : (o.xRange ? { lo: xl, hi: xh, ticks: nice(xl, xh, 6).ticks.filter((t) => t >= xl - 1e-9 && t <= xh + 1e-9) } : nice(xl, xh, 6));
  const x = (v: number) => L + ((tx(v) - xn.lo) / (xn.hi - xn.lo || 1)) * (W - L - R), y = (v: number) => T + (1 - (v - yl) / (yh - yl || 1)) * (H - T - B);
  const xticks = o.logX ? [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b) : xn.ticks;
  const grid = yn.ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 3}" class="tick" text-anchor="end">${(o.yFmt ?? tick)(t)}</text>`).join('')
    + xticks.map((t) => `<text x="${x(t)}" y="${H - B + 14}" class="tick" text-anchor="middle">${(o.xFmt ?? tick)(t)}</text>`).join('');
  const bands = (o.bands ?? []).map((b) => `<rect x="${Math.max(L, x(b.a))}" y="${T}" width="${Math.max(2, Math.min(W - R, x(b.b)) - Math.max(L, x(b.a)))}" height="${H - T - B}" class="band"/>`).join('');
  const vl = (o.vlines ?? []).map((v) => { const right = x(v.x) > W - R - 60; return `<line x1="${x(v.x)}" x2="${x(v.x)}" y1="${T}" y2="${H - B}" class="ref"/><text x="${x(v.x) + (right ? -4 : 3)}" y="${T + 10}" class="val" text-anchor="${right ? 'end' : 'start'}">${esc(v.label)}</text>`; }).join('');
  const diag = o.diag ? `<line x1="${x(xl)}" y1="${y(yl)}" x2="${x(xh)}" y2="${y(yh)}" class="ref"/>` : '';
  const ls = o.series.map((s) => {
    const p = s.points.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((a, b) => a[0] - b[0]);
    return `<polyline points="${p.map(([a, b]) => `${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`
      + (o.dots || p.length <= 12 ? p.map(([a, b]) => `<circle cx="${x(a).toFixed(1)}" cy="${y(b).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.label)}: ${tick(a)} → ${f2(b, 3)}</title></circle>`).join('') : '');
  }).join('');
  const axes = `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" class="axis"/>`
    + (o.xlabel ? `<text x="${(L + W - R) / 2}" y="${H - 4}" class="tick" text-anchor="middle">${esc(o.xlabel)}</text>` : '')
    + (o.ylabel ? `<text transform="translate(11,${(T + H - B) / 2}) rotate(-90)" class="tick" text-anchor="middle">${esc(o.ylabel)}</text>` : '');
  return frame(o.title, W, H, `${grid}${bands}${diag}${vl}${ls}${axes}`, o.note).replace('</figcaption>', `</figcaption>${legend(o.series.map((s) => ({ label: s.label, color: s.color })))}`);
}

/** Grouped vertical bars: one group per category, one bar per series. Null values are drawn as an empty slot. */
export function bars(o: { title: string; groups: string[]; series: { label: string; color: string; values: (number | null)[]; err?: ([number, number] | null)[] }[]; yMax?: number; fmt?: (v: number) => string; note?: string; w?: number; h?: number; yLabel?: string }) {
  const W = o.w ?? Math.max(420, 70 + o.groups.length * (28 + o.series.length * 20)), H = o.h ?? 230, L = 44, R = 10, T = 12, B = 52;
  const vals = o.series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const yh = o.yMax ?? nice(0, Math.max(0.0001, ...vals, ...o.series.flatMap((s) => (s.err ?? []).map((e) => (e ? e[1] : 0)))), 4).hi;
  const y = (v: number) => T + (1 - v / yh) * (H - T - B), gw = (W - L - R) / o.groups.length, bw = Math.min(26, (gw * 0.8) / o.series.length);
  const fmt = o.fmt ?? tick;
  const grid = nice(0, yh, 4).ticks.filter((t) => t <= yh + 1e-9).map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 3}" class="tick" text-anchor="end">${fmt(t)}</text>`).join('');
  const body = o.groups.map((g, gi) => {
    const x0 = L + gi * gw + (gw - bw * o.series.length) / 2;
    const rects = o.series.map((s, si) => {
      const v = s.values[gi]; if (v === null || !Number.isFinite(v)) return `<text x="${x0 + si * bw + bw / 2}" y="${H - B - 4}" class="tick" text-anchor="middle">–</text>`;
      const e = s.err?.[gi];
      return `<rect x="${x0 + si * bw}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, H - B - y(v))}" rx="2" fill="${s.color}"><title>${esc(s.label)} · ${esc(g)}: ${fmt(v)}</title></rect>`
        + (e ? `<line x1="${x0 + si * bw + bw / 2 - 1}" x2="${x0 + si * bw + bw / 2 - 1}" y1="${y(e[0])}" y2="${y(e[1])}" class="whisker"/>` : '');
    }).join('');
    const label = g.length > 11 ? `<text transform="translate(${L + gi * gw + gw / 2},${H - B + 12}) rotate(-35)" class="tick" text-anchor="end">${esc(g)}</text>` : `<text x="${L + gi * gw + gw / 2}" y="${H - B + 14}" class="tick" text-anchor="middle">${esc(g)}</text>`;
    return rects + label;
  }).join('');
  return frame(o.title, W, H, `${grid}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/>${body}${o.yLabel ? `<text transform="translate(11,${(T + H - B) / 2}) rotate(-90)" class="tick" text-anchor="middle">${esc(o.yLabel)}</text>` : ''}`, o.note)
    .replace('</figcaption>', `</figcaption>${legend(o.series.map((s) => ({ label: s.label, color: s.color })))}`);
}

/** Horizontal bars, optionally signed (weights): the zero line sits in the middle when there are negative values. */
export function hbars(o: { title: string; rows: { label: string; value: number; color?: string }[]; fmt?: (v: number) => string; note?: string; w?: number }) {
  const rowH = 22, L = 150, R = 56, T = 8, W = o.w ?? 520, H = T + o.rows.length * rowH + 14;
  const mn = Math.min(0, ...o.rows.map((r) => r.value)), mx = Math.max(0.0001, ...o.rows.map((r) => r.value));
  const x = (v: number) => L + ((v - mn) / (mx - mn || 1)) * (W - L - R), zero = x(0), fmt = o.fmt ?? ((v: number) => f2(v, 2));
  const body = o.rows.map((r, i) => {
    const yy = T + i * rowH, a = Math.min(zero, x(r.value)), b = Math.max(zero, x(r.value));
    return `<text x="${L - 8}" y="${yy + 13}" class="lab" text-anchor="end">${esc(r.label)}</text><rect x="${a}" y="${yy + 3}" width="${Math.max(1, b - a)}" height="${rowH - 8}" rx="2" fill="${r.color ?? (r.value < 0 ? 'var(--c2)' : 'var(--c1)')}"><title>${esc(r.label)}: ${fmt(r.value)}</title></rect><text x="${b + 6}" y="${yy + 13}" class="val">${fmt(r.value)}</text>`;
  }).join('');
  return frame(o.title, W, H, `<line x1="${zero}" x2="${zero}" y1="${T}" y2="${H - 10}" class="axis"/>${body}`, o.note);
}

/** Heat map. `diverge` centres the colour scale on zero (correlations); otherwise darker means larger. */
export function heat(o: { title: string; rows: string[]; cols: string[]; values: number[][]; fmt?: (v: number) => string; diverge?: boolean; note?: string; cell?: number; lo?: number; hi?: number }) {
  const cw = o.cell ?? 34, rh = Math.min(cw, 26), L = 130, T = 96, W = L + o.cols.length * cw + 10, H = T + o.rows.length * rh + 10;
  const flat = o.values.flat().filter(Number.isFinite), lo = o.lo ?? Math.min(...flat), hi = o.hi ?? Math.max(...flat), fmt = o.fmt ?? ((v: number) => f2(v, 2));
  const cells = o.values.map((row, i) => row.map((v, j) => {
    if (!Number.isFinite(v)) return '';
    const t = o.diverge ? Math.min(1, Math.abs(v) / Math.max(Math.abs(lo), Math.abs(hi), 1e-9)) : (v - lo) / (hi - lo || 1);
    const cls = o.diverge ? (v >= 0 ? 'hpos' : 'hneg') : 'hpos';
    return `<g><title>${esc(o.rows[i])} × ${esc(o.cols[j])}: ${fmt(v)}</title><rect x="${L + j * cw + 1}" y="${T + i * rh + 1}" width="${cw - 2}" height="${rh - 2}" rx="3" class="${cls}" style="--t:${t.toFixed(2)}"/>${cw >= 30 ? `<text x="${L + j * cw + cw / 2}" y="${T + i * rh + rh / 2 + 3}" class="cellv" text-anchor="middle">${fmt(v)}</text>` : ''}</g>`;
  }).join('')).join('');
  const cols = o.cols.map((c, j) => `<text transform="translate(${L + j * cw + cw / 2},${T - 6}) rotate(-50)" class="lab">${esc(c)}</text>`).join('');
  const rows = o.rows.map((r, i) => `<text x="${L - 8}" y="${T + i * rh + rh / 2 + 3}" class="lab" text-anchor="end">${esc(r)}</text>`).join('');
  return frame(o.title, W, H, `${cols}${rows}${cells}`, o.note);
}

export function table(headers: string[], rows: (string | number)[][], cls = '') {
  return `<div class="tablewrap ${cls}"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${typeof c === 'string' && c.startsWith('<') ? c : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** A left-to-right pipeline diagram: boxes (label, sub-label, where it is stored) joined by arrows. */
export function flow(stages: { label: string; sub: string; store: string }[]) {
  const bw = 184, gap = 24, H = 124, W = stages.length * (bw + gap) + 10;
  const body = stages.map((s, i) => {
    const x = 6 + i * (bw + gap);
    const wrap = (t: string, n: number) => { const out: string[] = []; let cur = ''; for (const w of t.split(' ')) { if ((cur + ' ' + w).trim().length > n) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); } if (cur) out.push(cur); return out; };
    return `<g><rect x="${x}" y="6" width="${bw}" height="${H - 12}" rx="8" class="box"/><text x="${x + 10}" y="24" class="val" style="font-weight:600">${esc(s.label)}</text>`
      + wrap(s.sub, 30).slice(0, 3).map((l, k) => `<text x="${x + 10}" y="${40 + k * 12}" class="tick">${esc(l)}</text>`).join('')
      + wrap(s.store, 30).slice(0, 2).map((l, k) => `<text x="${x + 10}" y="${H - 30 + k * 11}" class="path">${esc(l)}</text>`).join('')
      + (i < stages.length - 1 ? `<path d="M${x + bw + 4},${H / 2} h${gap - 10} m-5,-4 l5,4 l-5,4" class="arrow"/>` : '') + '</g>';
  }).join('');
  return `<figure class="wide"><div style="overflow:auto"><svg viewBox="0 0 ${W} ${H}" style="min-width:${Math.min(W, 1500)}px" role="img" aria-label="Data flow">${body}</svg></div></figure>`;
}
