/*
 * The contents page's live system.
 *
 * The ground-truth simulator's shop (scripts/simulate-target.ts) drawn as
 * islands, with the mapper's own arithmetic running in the browser:
 *
 *   edge weights   EdgeWeights.ts      share of the caller's traffic × confidence
 *   cascade        CascadeEngine.ts    noisy-OR, τ = 0.7, solved to a fixed point
 *   root cause     RCAEngine.ts        five named factors, MATERIAL_REACH, victim penalty
 *   link look      edgeHeat.ts         trouble first, then volume
 *   pulses         linkFlow.ts         0.3 + 1.6·log10(1 + rate), ≤ 5 per second
 *
 * Same constants, same branch order. What it does not do is measure anything:
 * statuses are whatever you set or the scenario scripts, so it shows what the
 * mapper would conclude from them, not what a real target is doing.
 */
(function () {
  'use strict';
  const root = document.getElementById('live-system');
  if (!root) return;
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const panel = root.querySelector('.ls-panel-body');
  const tip = root.querySelector('.ls-tip');
  const stage = root.querySelector('.ls-stage');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the shop: same services and calls as scripts/simulate-target.ts ----
  const SERVICES = [
    { id: 'frontend', role: 'edge', x: 1.0, y: 3.2 },
    { id: 'catalogue', role: 'services', x: 5.0, y: 1.0 },
    { id: 'carts', role: 'services', x: 5.0, y: 3.2 },
    { id: 'orders', role: 'services', x: 5.0, y: 5.4 },
    { id: 'payment', role: 'services', x: 7.4, y: 4.4 },
    { id: 'shipping', role: 'services', x: 7.4, y: 6.5 },
    { id: 'catalogue-db', role: 'data', x: 11.0, y: 1.0 },
    { id: 'carts-db', role: 'data', x: 11.0, y: 3.2 },
    { id: 'orders-db', role: 'data', x: 11.0, y: 5.4 },
    { id: 'queue', role: 'messaging', x: 10.6, y: 8.4 },
  ];
  /** caller → callee, socket samples per minute. */
  const CALLS = [
    ['frontend', 'catalogue', 80], ['frontend', 'carts', 60], ['frontend', 'orders', 40],
    ['orders', 'payment', 30], ['orders', 'shipping', 20], ['orders', 'orders-db', 90],
    ['carts', 'carts-db', 70], ['catalogue', 'catalogue-db', 100], ['shipping', 'queue', 15],
  ];
  const ROLE = {
    edge: { label: 'EDGE', color: '#38bdf8', top: 0.55 },
    services: { label: 'SERVICES', color: '#6b8cff', top: 0.95 },
    data: { label: 'DATA', color: '#2ed3a0', top: 0.4 },
    messaging: { label: 'MESSAGING', color: '#c084fc', top: 0.7 },
  };
  const STATUS_COLOR = { healthy: '#25e3a3', degraded: '#ffab40', critical: '#ff3d5e' };

  // ---- constants mirrored from the server ----
  const TAU = 0.7;                                      // DEFAULT_TRANSMISSION
  const STATUS_P = { critical: 1.0, degraded: 0.5, healthy: 0 };
  const MATERIAL_REACH = 0.1, EXPLAINS_WEIGHT = 0.25, VICTIM_WEIGHT = 0.25;
  const PASS_THROUGH_WEIGHT = 0.5, MIN_EDGE_WEIGHT = 0.05;

  const byId = new Map(SERVICES.map((s) => [s.id, s]));
  const edges = CALLS.map(([source, target, perMin]) => ({ source, target, perMin, weight: 0, dependency: 0 }));

  // computeEdgeWeights(): every call here is observed with direction from a
  // listening port (confidence 1.0) and carries activity, so the share is the
  // plain proportion of the caller's traffic.
  for (const s of SERVICES) {
    const out = edges.filter((e) => e.source === s.id);
    const total = out.reduce((sum, e) => sum + e.perMin, 0);
    for (const e of out) {
      e.dependency = e.perMin / total;
      e.weight = Math.round(1.0 * e.dependency * 1000) / 1000;
    }
  }

  // ---- state ----
  const status = new Map(SERVICES.map((s) => [s.id, 'healthy']));
  const onset = new Map();
  let cascade = null;
  let rca = null;
  let truth = null;
  let hover = null;
  const waves = [];
  let timers = [];

  // ---- the cascade model (CascadeEngine.solve / describe) ----
  function solveCascade() {
    const p0 = new Map(SERVICES.map((s) => [s.id, STATUS_P[status.get(s.id)] || 0]));
    let P = new Map(p0);
    for (let it = 0; it < 200; it++) {
      const next = new Map();
      let delta = 0;
      for (const s of SERVICES) {
        let survive = 1 - p0.get(s.id);
        for (const e of edges) if (e.source === s.id) survive *= 1 - TAU * e.weight * P.get(e.target);
        next.set(s.id, 1 - survive);
        delta = Math.max(delta, Math.abs(next.get(s.id) - P.get(s.id)));
      }
      P = next;
      if (delta < 1e-6) break;
    }
    const out = new Map();
    for (const s of SERVICES) {
      let survive = 1, best = null;
      for (const e of edges) {
        if (e.source !== s.id) continue;
        const c = TAU * e.weight * P.get(e.target);
        survive *= 1 - c;
        if (c > 0 && (!best || c > best.c)) best = { id: e.target, c };
      }
      const inherited = 1 - survive;
      const p = P.get(s.id);
      const routed = (inherited >= 0.15 || inherited > p0.get(s.id)) && best;
      out.set(s.id, {
        p, p0: p0.get(s.id), inherited, via: routed ? best.id : null,
        band: p >= 0.7 ? 'high' : p >= 0.4 ? 'elevated' : p >= 0.15 ? 'low' : 'minimal',
      });
    }
    return out;
  }

  // ---- root cause (RCAEngine.analyzeIncident) ----
  function dependencyReach(rootId) {
    const reach = new Map([[rootId, 1]]);
    for (let pass = 0; pass <= edges.length; pass++) {
      let changed = false;
      for (const e of edges) {
        const down = reach.get(e.target);
        if (down === undefined) continue;
        const cand = down * e.weight;
        if (cand > (reach.get(e.source) || 0) + 1e-12) { reach.set(e.source, cand); changed = true; }
      }
      if (!changed) break;
    }
    return reach;
  }

  function analyze() {
    const failing = SERVICES.filter((s) => status.get(s.id) !== 'healthy').map((s) => s.id);
    if (!failing.length) return null;
    const first = Math.min(...failing.map((id) => onset.get(id)));
    const earliest = new Set(failing.filter((id) => onset.get(id) - first < 1000));
    const failingSet = new Set(failing);
    const cands = [];
    for (const id of failing) {
      const f = [];
      if (earliest.has(id)) f.push(['first', 0.30, earliest.size > 1 ? 'earliest anomaly (tied)' : 'earliest anomaly']);
      else f.push(['anomaly', 0.10, 'has an anomaly']);
      if (status.get(id) === 'critical') f.push(['down', 0.35, 'container down']);
      else f.push(['degraded', 0.15, 'degraded']);
      f.push(['observed', 0.20, 'observed traffic']);
      const others = failing.filter((o) => o !== id);
      let explains = 0;
      if (others.length) {
        const reach = dependencyReach(id);
        const material = (o) => { const r = reach.get(o) || 0; return r >= MATERIAL_REACH ? r : 0; };
        const coverage = others.reduce((s, o) => s + material(o), 0) / others.length;
        explains = others.filter((o) => material(o) > 0).length;
        const pts = Math.round(EXPLAINS_WEIGHT * coverage * 100) / 100;
        if (pts >= 0.01) f.push(['explains', pts, 'explains ' + explains + ' of ' + others.length]);
      }
      const victimEdges = edges.filter((e) => e.source === id && failingSet.has(e.target));
      const share = Math.min(1, victimEdges.reduce((s, e) => s + e.weight, 0));
      if (share > 0) {
        const pts = Math.round(VICTIM_WEIGHT * share * 100) / 100;
        f.push(['victim', -pts, 'depends on failing ' + victimEdges.map((e) => e.target).join(', ')]);
      }
      const total = f.reduce((s, x) => s + x[1], 0);
      const score = Math.min(Math.max(Math.round(total * 100) / 100, 0), 1);
      const conf = score >= 0.75 ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : score >= 0.25 ? 'LOW' : 'UNKNOWN';
      cands.push({ id, score, conf, factors: f, explains, of: others.length });
    }
    cands.sort((a, b) => b.score - a.score);
    const top = cands[0];
    const independent = cands.length > 1 && top.explains === 0;
    if (independent && top.conf !== 'UNKNOWN') top.conf = 'LOW';

    // Propagation: from the root to its callers, against the arrow.
    const path = [top.id];
    const seen = new Set([top.id]);
    const queue = [top.id];
    while (queue.length) {
      const cur = queue.shift();
      const callers = edges.filter((e) => e.target === cur && e.weight >= MIN_EDGE_WEIGHT).sort((a, b) => b.weight - a.weight);
      for (const e of callers) {
        if (seen.has(e.source)) continue;
        if (!failingSet.has(e.source) && e.weight < PASS_THROUGH_WEIGHT) continue;
        seen.add(e.source); path.push(e.source); queue.push(e.source);
      }
    }
    return { cands, top, independent, path };
  }

  // ---- link appearance (edgeHeat.ts) and pulses (linkFlow.ts) ----
  function linkLook(e) {
    const callee = status.get(e.target);
    if (callee === 'critical') return { color: '#ff3d5e', glow: '#ff7a90', a: 1, why: 'calls a service that is down' };
    if (callee === 'degraded') return { color: '#ff9a3c', glow: '#ffc78a', a: 0.95, why: 'calls a degraded service' };
    const m = e.perMin;
    if (m > 1200) return { color: '#9cf4ff', glow: '#d6fbff', a: 1 };
    if (m > 250) return { color: '#1fd1ff', glow: '#86e8ff', a: 0.95 };
    if (m > 60) return { color: '#2f9bff', glow: '#80c4ff', a: 0.9 };
    return { color: '#4f7dff', glow: '#8fabff', a: 0.85 };
  }
  const pulsesFor = (perSecond) => Math.min(5, Math.max(0.25, 0.3 + 1.6 * Math.log10(1 + Math.max(0, perSecond))));

  // ---- projection ----
  const C = Math.cos(Math.PI / 6), S = 0.5, Z = 1.15;
  let scale = 40, ox = 0, oy = 0, W = 0, H = 0, dpr = 1;
  // Parallax: the scene leans a few pixels toward the pointer, higher things
  // further than the ground, so the islands read as standing at different heights.
  let lean = [0, 0], leanTo = [0, 0];
  const proj = (x, y, z) => [ox + (x - y) * C * scale + lean[0] * (0.4 + z * 0.35), oy + ((x + y) * S - z * Z) * scale + lean[1] * (0.4 + z * 0.35)];

  function islands() {
    const out = [];
    for (const role of Object.keys(ROLE)) {
      const members = SERVICES.filter((s) => s.role === role);
      const pad = 0.95;
      out.push({
        role, top: ROLE[role].top,
        x0: Math.min(...members.map((s) => s.x)) - pad, x1: Math.max(...members.map((s) => s.x)) + pad,
        y0: Math.min(...members.map((s) => s.y)) - pad, y1: Math.max(...members.map((s) => s.y)) + pad,
      });
    }
    return out.sort((a, b) => (a.x0 + a.y0) - (b.x0 + b.y0));
  }
  const ISLANDS = islands();
  const TOWER_H = 0.95, TOWER_A = 0.36;
  const topZ = (s) => ROLE[s.role].top + TOWER_H;

  function fit() {
    const rect = stage.getBoundingClientRect();
    W = Math.max(280, rect.width);
    H = Math.max(320, Math.min(640, W * 0.74));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    // Bounds of the scene in projection units, then scale to fit.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const take = (x, y, z) => {
      const px = (x - y) * C, py = (x + y) * S - z * Z;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    };
    for (const i of ISLANDS) for (const [x, y] of [[i.x0, i.y0], [i.x1, i.y0], [i.x0, i.y1], [i.x1, i.y1]]) { take(x, y, 0); take(x, y, i.top + 2.4); }
    scale = Math.min((W - 28) / (maxX - minX), (H - 28) / (maxY - minY));
    ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
    oy = (H - (maxY - minY) * scale) / 2 - minY * scale + 6;
  }

  // ---- theme ----
  let theme = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    const dark = (() => {
      const t = document.documentElement.getAttribute('data-theme');
      if (t) return t === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    })();
    theme = { dark, ink: v('--ink', '#e7eaf8'), muted: v('--muted', '#7a81a6'), panel: v('--panel', '#0d1122'), panel2: v('--panel-2', '#131a30'), rule: v('--rule', '#1c2340') };
  }
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', readTheme);

  // ---- drawing ----
  function poly(points, fill, stroke, lw) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  const alpha = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };

  function drawGround(t) {
    ctx.save();
    ctx.strokeStyle = theme.dark ? 'rgba(143,156,255,0.06)' : 'rgba(79,91,213,0.07)';
    ctx.lineWidth = 1;
    for (let x = -1; x <= 13; x++) { const a = proj(x, -1, 0), b = proj(x, 10.5, 0); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
    for (let y = -1; y <= 10.5; y++) { const a = proj(-1, y, 0), b = proj(13, y, 0); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
    // A slow scan line across the ground, the only ambient motion.
    if (!reduceMotion) {
      const k = (t / 9000) % 1;
      const x = -1 + k * 14;
      const a = proj(x, -1, 0), b = proj(x, 10.5, 0);
      const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
      g.addColorStop(0, 'rgba(143,156,255,0)'); g.addColorStop(0.5, theme.dark ? 'rgba(143,156,255,0.16)' : 'rgba(79,91,213,0.12)'); g.addColorStop(1, 'rgba(143,156,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    ctx.restore();
  }

  function drawIsland(i) {
    const c = ROLE[i.role].color;
    const t = i.top;
    const top = [proj(i.x0, i.y0, t), proj(i.x1, i.y0, t), proj(i.x1, i.y1, t), proj(i.x0, i.y1, t)];
    const left = [proj(i.x0, i.y1, t), proj(i.x1, i.y1, t), proj(i.x1, i.y1, 0), proj(i.x0, i.y1, 0)];
    const right = [proj(i.x1, i.y0, t), proj(i.x1, i.y1, t), proj(i.x1, i.y1, 0), proj(i.x1, i.y0, 0)];
    // Shadow on the ground.
    poly([proj(i.x0 + 0.3, i.y0 + 0.5, 0), proj(i.x1 + 0.3, i.y0 + 0.5, 0), proj(i.x1 + 0.3, i.y1 + 0.5, 0), proj(i.x0 + 0.3, i.y1 + 0.5, 0)], theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(20,24,60,0.08)');
    poly(left, theme.dark ? alpha(c, 0.10) : alpha(c, 0.12), alpha(c, 0.35));
    poly(right, theme.dark ? alpha(c, 0.06) : alpha(c, 0.08), alpha(c, 0.35));
    poly(top, theme.dark ? alpha(c, 0.07) : alpha(c, 0.09), alpha(c, 0.7), 1.2);
    // Neon edge along the front rim, kept faint.
    ctx.save();
    ctx.shadowColor = c; ctx.shadowBlur = theme.dark ? 8 : 0;
    ctx.strokeStyle = alpha(c, 0.75); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(...top[3]); ctx.lineTo(...top[2]); ctx.lineTo(...top[1]); ctx.stroke();
    ctx.restore();
    const [lx, ly] = proj(i.x0 + 0.15, i.y1, 0);
    ctx.fillStyle = alpha(c, 0.9);
    ctx.font = '600 ' + Math.max(9, scale * 0.24) + 'px "IBM Plex Mono", monospace';
    ctx.fillText(ROLE[i.role].label, lx + 2, ly + Math.max(12, scale * 0.34));
  }

  function curve(e) {
    const a = byId.get(e.source), b = byId.get(e.target);
    const p0 = proj(a.x, a.y, topZ(a));
    const p2 = proj(b.x, b.y, topZ(b));
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const p1 = proj((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(topZ(a), topZ(b)) + 0.7 + d * 0.16);
    return [p0, p1, p2];
  }
  const qpt = ([p0, p1, p2], t) => {
    const u = 1 - t;
    return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
  };
  const qlen = (q) => { let L = 0, prev = q[0]; for (let i = 1; i <= 16; i++) { const p = qpt(q, i / 16); L += Math.hypot(p[0] - prev[0], p[1] - prev[1]); prev = p; } return L; };

  function drawLinks(t) {
    for (const e of edges) {
      const q = curve(e);
      const look = linkLook(e);
      const hot = hover && (hover === e.source || hover === e.target);
      const w = (1 + 3.2 * e.weight) * Math.max(0.8, scale / 42);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.globalAlpha = hover && !hot ? 0.25 : 1;
      ctx.strokeStyle = alpha(look.glow, theme.dark ? 0.16 : 0.12);
      ctx.lineWidth = w + 6;
      ctx.beginPath(); ctx.moveTo(...q[0]); ctx.quadraticCurveTo(...q[1], ...q[2]); ctx.stroke();
      ctx.strokeStyle = alpha(look.color, look.a);
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(...q[0]); ctx.quadraticCurveTo(...q[1], ...q[2]); ctx.stroke();
      // Pulses: none into a container that is down, since nothing reaches it.
      if (status.get(e.target) !== 'critical') {
        const pulses = pulsesFor(e.perMin / 60);
        const trip = Math.max(0.4, qlen(q) / 110);
        const count = Math.min(8, Math.max(1, Math.round(pulses * trip)));
        const phase = reduceMotion ? 0.37 : (t / 1000) * pulses / count;
        for (let i = 0; i < count; i++) {
          const k = (phase + i / count) % 1;
          const [px, py] = qpt(q, k);
          ctx.fillStyle = theme.dark ? 'rgba(255,255,255,0.9)' : alpha(look.color, 0.95);
          ctx.shadowColor = look.glow; ctx.shadowBlur = theme.dark ? 6 : 0;
          ctx.beginPath(); ctx.arc(px, py, Math.max(1.6, scale * 0.055), 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  function drawTower(s, t) {
    const z0 = ROLE[s.role].top, z1 = z0 + TOWER_H, a = TOWER_A;
    const st = status.get(s.id);
    const c = cascade.get(s.id);
    const dim = hover && hover !== s.id && !edges.some((e) => (e.source === hover && e.target === s.id) || (e.target === hover && e.source === s.id));
    ctx.save();
    ctx.globalAlpha = dim ? 0.35 : 1;
    // Cascade risk: a ring on the platform, as wide as the probability.
    if (c.p >= 0.05) {
      const col = c.band === 'high' ? '#ff3d5e' : c.band === 'elevated' ? '#ff9a3c' : '#ffab40';
      const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(t / 380);
      ctx.strokeStyle = alpha(col, 0.35 + 0.35 * pulse * Math.min(1, c.p));
      ctx.lineWidth = 1.5;
      for (let r = 1; r <= 2; r++) {
        const rr = a + 0.25 * r * (0.4 + c.p);
        poly([proj(s.x - rr, s.y - rr, z0), proj(s.x + rr, s.y - rr, z0), proj(s.x + rr, s.y + rr, z0), proj(s.x - rr, s.y + rr, z0)], null, ctx.strokeStyle, 1.2);
      }
    }
    const roleC = ROLE[s.role].color;
    const faceL = theme.dark ? '#121831' : '#e3e6f5';
    const faceR = theme.dark ? '#0c1124' : '#d5d9ee';
    const faceT = theme.dark ? '#1a2244' : '#f4f5fc';
    poly([proj(s.x - a, s.y + a, z1), proj(s.x + a, s.y + a, z1), proj(s.x + a, s.y + a, z0), proj(s.x - a, s.y + a, z0)], faceL, alpha(roleC, 0.45));
    poly([proj(s.x + a, s.y - a, z1), proj(s.x + a, s.y + a, z1), proj(s.x + a, s.y + a, z0), proj(s.x + a, s.y - a, z0)], faceR, alpha(roleC, 0.45));
    poly([proj(s.x - a, s.y - a, z1), proj(s.x + a, s.y - a, z1), proj(s.x + a, s.y + a, z1), proj(s.x - a, s.y + a, z1)], faceT, alpha(roleC, 0.8), 1.1);
    // Server slots on the front face.
    ctx.strokeStyle = alpha(roleC, 0.35);
    ctx.lineWidth = 1;
    for (let k = 1; k <= 3; k++) {
      const z = z0 + (TOWER_H * k) / 4;
      ctx.beginPath(); ctx.moveTo(...proj(s.x - a * 0.7, s.y + a, z)); ctx.lineTo(...proj(s.x + a * 0.7, s.y + a, z)); ctx.stroke();
    }
    // Status light.
    const sc = STATUS_COLOR[st];
    const blink = st === 'critical' ? 0.5 + 0.5 * Math.sin(t / 140) : st === 'degraded' ? 0.6 + 0.4 * Math.sin(t / 420) : 0.85 + 0.15 * Math.sin(t / 1600);
    const [lx, ly] = proj(s.x, s.y, z1);
    ctx.fillStyle = alpha(sc, reduceMotion ? 0.95 : blink);
    ctx.shadowColor = sc; ctx.shadowBlur = theme.dark ? 10 : 2;
    ctx.beginPath(); ctx.ellipse(lx, ly, scale * 0.14, scale * 0.08, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawLabels() {
    ctx.save();
    for (const s of SERVICES) {
      const [x, y] = proj(s.x, s.y, topZ(s) + 0.25);
      const c = cascade.get(s.id);
      const dim = hover && hover !== s.id;
      ctx.globalAlpha = dim ? 0.55 : 1;
      ctx.textAlign = 'center';
      ctx.font = '600 ' + Math.max(10, scale * 0.27) + 'px "IBM Plex Sans", system-ui, sans-serif';
      ctx.fillStyle = theme.ink;
      ctx.fillText(s.id, x, y - 4);
      if (c.p >= 0.15) {
        ctx.font = '500 ' + Math.max(9, scale * 0.22) + 'px "IBM Plex Mono", monospace';
        ctx.fillStyle = c.band === 'high' ? '#ff5f7a' : c.band === 'elevated' ? '#ff9a3c' : '#ffab40';
        ctx.fillText('P ' + c.p.toFixed(2), x, y - 4 - Math.max(11, scale * 0.3));
      }
    }
    ctx.restore();
  }

  // Risk travelling against the arrow when something breaks: a spark from the
  // callee to each caller, as bright as what the cascade model says reaches it.
  function launchWaves(fromId, depth) {
    if (reduceMotion || depth > 3) return;
    for (const e of edges) {
      if (e.target !== fromId) continue;
      const strength = TAU * e.weight * (cascade.get(fromId)?.p || 0);
      if (strength < 0.03) continue;
      waves.push({ e, start: performance.now() + depth * 650, strength, depth });
    }
  }
  function drawWaves(t) {
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      const k = (t - w.start) / 900;
      if (k < 0) continue;
      if (k > 1) {
        waves.splice(i, 1);
        if ((cascade.get(w.e.source)?.p || 0) >= 0.15) launchWaves(w.e.source, w.depth + 1);
        continue;
      }
      const q = curve(w.e);
      const [x, y] = qpt(q, 1 - k);           // callee → caller
      ctx.save();
      ctx.fillStyle = alpha('#ff5f7a', 0.25 + 0.6 * w.strength);
      ctx.shadowColor = '#ff3d5e'; ctx.shadowBlur = theme.dark ? 14 : 4;
      ctx.beginPath(); ctx.arc(x, y, Math.max(2.5, scale * (0.07 + 0.12 * w.strength)), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function frame(t) {
    lean = [lean[0] + (leanTo[0] - lean[0]) * 0.08, lean[1] + (leanTo[1] - lean[1]) * 0.08];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawGround(t);
    for (const i of ISLANDS) drawIsland(i);
    drawLinks(t);
    for (const s of [...SERVICES].sort((a, b) => (a.x + a.y) - (b.x + b.y))) drawTower(s, t);
    drawWaves(t);
    drawLabels();
  }

  // ---- panel ----
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderPanel() {
    let html = '';
    if (!rca) {
      html += '<div class="ls-empty">Everything is healthy. Nothing to explain, and the cascade model predicts nothing.<br><br>' +
        '<strong>Click a service</strong> to make it degraded, click again for critical, once more to heal it. Or replay one of the simulator\'s scenarios above.</div>';
      html += '<div class="ls-h">Structural weights</div><div class="ls-weights">' +
        edges.slice().sort((a, b) => b.weight - a.weight).slice(0, 5).map((e) =>
          '<div class="ls-w"><span>' + esc(e.source) + ' → ' + esc(e.target) + '</span><b>' + e.weight.toFixed(2) + '</b></div>').join('') + '</div>';
      panel.innerHTML = html;
      return;
    }
    const top = rca.top;
    const cc = top.conf === 'HIGH' ? 'var(--err)' : top.conf === 'MEDIUM' ? 'var(--warn)' : 'var(--muted)';
    const why = rca.independent
      ? 'the other affected services do not depend on it: these look like independent problems'
      : top.of === 0 ? 'it is the only service affected'
      : top.explains === top.of ? (top.of === 1 ? 'the other affected service depends on it' : 'all ' + top.of + ' other affected services depend on it')
      : top.explains + ' of the ' + top.of + ' other affected services depend on it';
    html += '<div class="ls-h">Root cause <span>RCAEngine</span></div>';
    html += '<div class="ls-root"><b>' + esc(top.id) + '</b><span class="ls-score">' + top.score.toFixed(2) + '</span><span class="ls-conf" style="color:' + cc + '">' + top.conf + '</span></div>';
    html += '<div class="ls-why">' + esc(why) + '.</div>';
    if (truth) {
      const ok = truth === top.id;
      html += '<div class="ls-truth ' + (ok ? 'ok' : 'bad') + '">ground truth: <b>' + esc(truth) + '</b> ' + (ok ? '✓ named correctly' : '✗ not the top candidate') + '</div>';
    }
    html += '<div class="ls-cands">' + rca.cands.map((c) =>
      '<div class="ls-cand' + (c === top ? ' top' : '') + '"><div class="ls-cand-h"><span>' + esc(c.id) + '</span><span>' + c.score.toFixed(2) + ' ' + c.conf + '</span></div>' +
      '<div class="ls-bar">' + c.factors.map((f) => '<i class="' + (f[1] < 0 ? 'neg ' : '') + 'f-' + f[0] + '" style="flex:' + Math.abs(f[1]) + '" title="' + esc((f[1] >= 0 ? '+' : '−') + Math.abs(f[1]).toFixed(2) + ' ' + f[2]) + '"></i>').join('') + '</div>' +
      '<div class="ls-chips">' + c.factors.map((f) => '<span class="' + (f[1] < 0 ? 'neg' : '') + '">' + (f[1] >= 0 ? '+' : '−') + Math.abs(f[1]).toFixed(2) + ' ' + esc(f[0]) + '</span>').join('') + '</div></div>').join('') + '</div>';
    html += '<div class="ls-path">spread: ' + rca.path.map(esc).join(' <i>→</i> ') + '</div>';

    const atRisk = SERVICES.map((s) => ({ id: s.id, ...cascade.get(s.id) })).filter((c) => c.p0 < 0.15 && c.p >= 0.15).sort((a, b) => b.p - a.p);
    const expected = SERVICES.reduce((s, x) => s + cascade.get(x.id).p, 0);
    html += '<div class="ls-h">Cascade <span>CascadeEngine · τ 0.7</span></div>';
    html += '<div class="ls-kv"><span>expected failures</span><b>' + expected.toFixed(2) + '</b></div>';
    html += atRisk.length
      ? atRisk.map((c) => '<div class="ls-risk"><span>' + esc(c.id) + ' <em>at risk via ' + esc(c.via || '-') + '</em></span><b class="b-' + c.band + '">' + c.p.toFixed(2) + '</b></div>').join('')
      : '<div class="ls-why">No healthy service is pulled above 0.15 through its dependencies.</div>';
    panel.innerHTML = html;
  }

  function recompute(changedId) {
    cascade = solveCascade();
    rca = analyze();
    renderPanel();
    if (changedId && status.get(changedId) !== 'healthy') launchWaves(changedId, 0);
    if (reduceMotion) frame(0);
  }

  function setStatus(id, st) {
    if (st === 'healthy') onset.delete(id);
    else if (!onset.has(id)) onset.set(id, Date.now());
    status.set(id, st);
    recompute(id);
  }

  function reset() {
    timers.forEach(clearTimeout); timers = [];
    for (const s of SERVICES) { status.set(s.id, 'healthy'); onset.delete(s.id); }
    truth = null; waves.length = 0;
    root.querySelectorAll('[data-scenario]').forEach((b) => b.classList.remove('on'));
    recompute(null);
  }

  // The simulator's scripted faults, 10 s of simulated time per 1.5 s here.
  const SCENARIOS = {
    'db-crash': { truth: 'orders-db', faults: [['orders-db', 0, 'critical'], ['orders', 1.5, 'degraded'], ['frontend', 3, 'degraded']] },
    'slow-payment': { truth: 'payment', faults: [['payment', 0, 'degraded'], ['orders', 1.8, 'degraded']] },
    'crash-loop': { truth: 'carts-db', faults: [['carts-db', 0, 'critical'], ['carts', 1.5, 'degraded']] },
  };
  root.querySelectorAll('[data-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-scenario');
      reset();
      if (name === 'reset') return;
      btn.classList.add('on');
      const sc = SCENARIOS[name];
      truth = sc.truth;
      for (const [id, at, st] of sc.faults) timers.push(setTimeout(() => setStatus(id, st), at * 1000 + 50));
      renderPanel();
    });
  });

  // ---- interaction ----
  function hit(mx, my) {
    let best = null, bd = Infinity;
    for (const s of SERVICES) {
      const [x, y] = proj(s.x, s.y, ROLE[s.role].top + TOWER_H / 2);
      const d = Math.hypot(mx - x, my - y);
      if (d < bd) { bd = d; best = s; }
    }
    return bd < Math.max(22, scale * 0.75) ? best : null;
  }
  canvas.addEventListener('mousemove', (ev) => {
    const r = canvas.getBoundingClientRect();
    if (!reduceMotion) leanTo = [((ev.clientX - r.left) / r.width - 0.5) * 10, ((ev.clientY - r.top) / r.height - 0.5) * 6];
    const s = hit(ev.clientX - r.left, ev.clientY - r.top);
    hover = s ? s.id : null;
    canvas.style.cursor = s ? 'pointer' : 'default';
    if (!s) { tip.hidden = true; return; }
    const c = cascade.get(s.id);
    const calls = edges.filter((e) => e.source === s.id).map((e) => e.target + ' ' + Math.round(e.dependency * 100) + '%');
    tip.innerHTML = '<b>' + esc(s.id) + '</b> <span style="color:' + STATUS_COLOR[status.get(s.id)] + '">' + status.get(s.id) + '</span>' +
      '<div>P ' + c.p.toFixed(3) + ' · ' + c.band + (c.via ? ' · via ' + esc(c.via) : '') + '</div>' +
      (calls.length ? '<div>calls ' + calls.map(esc).join(', ') + '</div>' : '<div>calls nothing</div>') +
      '<div class="ls-tip-hint">click to cycle healthy → degraded → critical</div>';
    tip.hidden = false;
    const tx = Math.min(ev.clientX - r.left + 14, W - 240);
    tip.style.left = Math.max(4, tx) + 'px';
    tip.style.top = (ev.clientY - r.top + 14) + 'px';
    if (reduceMotion) frame(0);
  });
  canvas.addEventListener('mouseleave', () => { hover = null; leanTo = [0, 0]; tip.hidden = true; if (reduceMotion) frame(0); });
  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    const s = hit(ev.clientX - r.left, ev.clientY - r.top);
    if (!s) return;
    truth = null;
    root.querySelectorAll('[data-scenario]').forEach((b) => b.classList.remove('on'));
    const next = { healthy: 'degraded', degraded: 'critical', critical: 'healthy' }[status.get(s.id)];
    setStatus(s.id, next);
  });

  // ---- run ----
  let visible = true, raf = 0;
  function loop(t) { frame(t); raf = visible ? requestAnimationFrame(loop) : 0; }
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible && !raf && !reduceMotion) raf = requestAnimationFrame(loop);
  }).observe(canvas);
  window.addEventListener('resize', () => { fit(); if (reduceMotion) frame(0); });

  readTheme();
  fit();
  recompute(null);
  if (reduceMotion) frame(0); else raf = requestAnimationFrame(loop);
})();
