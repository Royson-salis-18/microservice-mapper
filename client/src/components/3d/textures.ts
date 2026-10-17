import * as THREE from 'three';

/**
 * Procedural textures shared by every unit in the scene. Each is drawn once
 * on a 2D canvas the first time it is asked for and reused after that: one
 * GPU texture for sixty cabinets, not sixty identical ones.
 */

const cache = new Map<string, THREE.CanvasTexture>();

function make(key: string, size: [number, number], draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true): THREE.CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const [w, h] = size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Soft round falloff, white: tinted by the material that uses it. */
export function glowTexture(): THREE.CanvasTexture {
  return make('glow', [128, 128], (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  });
}

/**
 * A cabinet door: dark perforated mesh between two rails, with a handle.
 * Detail the eye reads as "server rack" at any distance, for one draw call.
 */
export function doorTexture(): THREE.CanvasTexture {
  return make('door', [128, 256], (ctx, w, h) => {
    ctx.fillStyle = '#161618';
    ctx.fillRect(0, 0, w, h);
    // Perforation: a fine dot grid.
    ctx.fillStyle = 'rgba(160,160,162,0.16)';
    for (let y = 14; y < h - 14; y += 5) {
      for (let x = 12; x < w - 24; x += 5) ctx.fillRect(x, y, 2, 2);
    }
    // Rails and frame.
    ctx.strokeStyle = 'rgba(185,185,187,0.28)';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = 'rgba(185,185,187,0.22)';
    for (const y of [h * 0.33, h * 0.66]) ctx.fillRect(8, y, w - 30, 2);
    // Handle.
    ctx.fillStyle = 'rgba(217,217,219,0.55)';
    ctx.fillRect(w - 16, h * 0.4, 5, h * 0.2);
  });
}

/**
 * The backdrop behind everything: near-black at the edges, deep atmospheric glow behind the site.
 */
export function backdropTexture(preset: 'cyber' | 'studio' | 'holo' = 'cyber'): THREE.CanvasTexture {
  return make(`backdrop_${preset}`, [1024, 1024], (ctx, w, h) => {
    const bg = preset === 'holo' ? '#080214' : preset === 'studio' ? '#090a0f' : '#05070e';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(w * 0.5, h * 0.44, 0, w * 0.5, h * 0.44, w * 0.68);
    if (preset === 'holo') {
      g.addColorStop(0, '#4a0e78');
      g.addColorStop(0.25, '#350a58');
      g.addColorStop(0.52, '#1e0534');
      g.addColorStop(0.82, '#0f021c');
      g.addColorStop(1, '#080214');
    } else if (preset === 'studio') {
      g.addColorStop(0, '#262a36');
      g.addColorStop(0.32, '#181c25');
      g.addColorStop(0.68, '#101219');
      g.addColorStop(1, '#090a0f');
    } else {
      // cyber: vibrant electric navy and teal-cyan horizon haze
      g.addColorStop(0, '#1c345a');
      g.addColorStop(0.28, '#12233e');
      g.addColorStop(0.62, '#0a1424');
      g.addColorStop(0.88, '#060a13');
      g.addColorStop(1, '#05070e');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/**
 * Procedural skyscraper window facade:
 * Grids of illuminated office windows and dark panels for realistic high-rise towers.
 */
export function facadeTexture(preset: 'cyber' | 'studio' | 'holo' = 'cyber'): THREE.CanvasTexture {
  return make(`facade_${preset}`, [256, 512], (ctx, w, h) => {
    ctx.fillStyle = '#080a0e';
    ctx.fillRect(0, 0, w, h);

    const cols = 8;
    const rows = 32;
    const colW = w / cols;
    const rowH = h / rows;
    const padX = 4;
    const padY = 3;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const hash = Math.imul(r * 37 + c * 19 + 11, 2654435761) >>> 0;
        const lit = (hash % 100) < 45; // ~45% of windows illuminated
        const x = c * colW + padX;
        const y = r * rowH + padY;
        const winW = colW - padX * 2;
        const winH = rowH - padY * 2;

        if (!lit) {
          ctx.fillStyle = '#101216';
          ctx.fillRect(x, y, winW, winH);
          continue;
        }

        // Color palette based on environment preset
        if (preset === 'holo') {
          const pal = ['#c084fc', '#22d3ee', '#f472b6', '#a855f7', '#38bdf8'];
          ctx.fillStyle = pal[hash % pal.length];
        } else if (preset === 'studio') {
          const pal = ['#e2e8f0', '#94a3b8', '#cbd5e1', '#64748b'];
          ctx.fillStyle = pal[hash % pal.length];
        } else {
          // cyber: warm amber, electric cyan, hot magenta
          const pal = ['#fbbf24', '#00f0ff', '#38bdf8', '#f59e0b', '#f43f5e', '#3ecf8e'];
          ctx.fillStyle = pal[hash % pal.length];
        }
        ctx.fillRect(x, y, winW, winH);
      }
    }
  });
}

/**
 * Raised-floor tiles: a dark panel grid with a faint seam and a little
 * variation from tile to tile, the texture of a machine-room floor. Repeats;
 * callers clone it and set their own repeat.
 */
export function floorTexture(): THREE.CanvasTexture {
  const tex = make('floor', [256, 256], (ctx, w) => {
    const tile = w / 4;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        // Deterministic per-tile shade, so the floor is not a flat sheet.
        const v = ((i * 7 + j * 13) % 5) * 3;
        ctx.fillStyle = `rgb(${17 + v}, ${18 + v}, ${21 + v})`;
        ctx.fillRect(i * tile, j * tile, tile, tile);
      }
    }
    ctx.strokeStyle = 'rgba(8,10,20,0.9)';
    ctx.lineWidth = 4;
    for (let k = 0; k <= 4; k++) {
      ctx.beginPath(); ctx.moveTo(k * tile, 0); ctx.lineTo(k * tile, w); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, k * tile); ctx.lineTo(w, k * tile); ctx.stroke();
    }
    // Corner studs.
    // A faint highlight along each tile's top-left edge: bevelled panels.
    ctx.strokeStyle = 'rgba(170,170,172,0.14)';
    ctx.lineWidth = 2;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath(); ctx.moveTo(k * tile + 3, 0); ctx.lineTo(k * tile + 3, w); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, k * tile + 3); ctx.lineTo(w, k * tile + 3); ctx.stroke();
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** A floor texture with its own repeat, sharing the one image. */
export function tiledFloor(repeatX: number, repeatY: number): THREE.Texture {
  const tex = floorTexture().clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.needsUpdate = true;
  return tex;
}

/** The top of a cooling unit: a round fan behind a grille. */
export function grilleTexture(): THREE.CanvasTexture {
  return make('grille', [128, 128], (ctx, w) => {
    ctx.fillStyle = '#1a1a1c';
    ctx.fillRect(0, 0, w, w);
    ctx.strokeStyle = 'rgba(167,167,169,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(w / 2, w / 2, w * 0.38, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(167,167,169,0.18)';
    for (let r = 8; r < w * 0.38; r += 8) { ctx.beginPath(); ctx.arc(w / 2, w / 2, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(167,167,169,0.25)';
    ctx.strokeRect(6, 6, w - 12, w - 12);
  });
}

/**
 * A linear falloff, opaque along one edge and clear at the other: laid on the
 * floor against a wall, tinted black, it is the contact shade that makes the
 * wall sit on the floor.
 */
export function shadeTexture(): THREE.CanvasTexture {
  return make('shade', [4, 128], (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/**
 * A monitoring screen: a dark panel with a gridline, an area chart and a few
 * bars. Decorative: it is the observability island's wall of dashboards.
 */
export function screenTexture(): THREE.CanvasTexture {
  return make('screen', [256, 160], (ctx, w, h) => {
    ctx.fillStyle = '#151517';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(138,180,255,0.18)';
    ctx.lineWidth = 1;
    for (let y = 30; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(w - 10, y); ctx.stroke(); }
    // Area chart.
    const pts: [number, number][] = [];
    for (let i = 0; i <= 24; i++) pts.push([10 + (i / 24) * (w * 0.62), 110 - (Math.sin(i * 0.7) * 18 + Math.sin(i * 1.9) * 9 + i * 1.4)]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h - 20);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], h - 20);
    ctx.closePath();
    ctx.fillStyle = 'rgba(138,180,255,0.22)';
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = 'rgba(138,180,255,0.95)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Bars.
    const bx = w * 0.72;
    [0.5, 0.8, 0.35, 0.65].forEach((v, i) => {
      ctx.fillStyle = i === 1 ? 'rgba(167,167,169,0.9)' : 'rgba(167,167,169,0.55)';
      ctx.fillRect(bx + i * 16, h - 20 - v * 90, 10, v * 90);
    });
    ctx.strokeStyle = 'rgba(138,180,255,0.5)';
    ctx.strokeRect(2, 2, w - 4, h - 4);
  });
}
