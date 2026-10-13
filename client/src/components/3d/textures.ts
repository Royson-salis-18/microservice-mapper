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
    ctx.fillStyle = '#0b1026';
    ctx.fillRect(0, 0, w, h);
    // Perforation: a fine dot grid.
    ctx.fillStyle = 'rgba(120,140,220,0.16)';
    for (let y = 14; y < h - 14; y += 5) {
      for (let x = 12; x < w - 24; x += 5) ctx.fillRect(x, y, 2, 2);
    }
    // Rails and frame.
    ctx.strokeStyle = 'rgba(140,160,255,0.28)';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = 'rgba(140,160,255,0.22)';
    for (const y of [h * 0.33, h * 0.66]) ctx.fillRect(8, y, w - 30, 2);
    // Handle.
    ctx.fillStyle = 'rgba(190,205,255,0.55)';
    ctx.fillRect(w - 16, h * 0.4, 5, h * 0.2);
  });
}

/**
 * The backdrop behind everything: near-black at the edges, deep navy with a
 * blue bloom behind the site. Drawn into the scene rather than left to CSS,
 * because the bloom pass renders into an opaque target.
 */
export function backdropTexture(): THREE.CanvasTexture {
  return make('backdrop', [1024, 1024], (ctx, w, h) => {
    ctx.fillStyle = '#05060b';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(w * 0.6, h * 0.4, 0, w * 0.6, h * 0.4, w * 0.75);
    g.addColorStop(0, '#16205a');
    g.addColorStop(0.35, '#0c1236');
    g.addColorStop(0.7, '#07091a');
    g.addColorStop(1, '#05060b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
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
        ctx.fillStyle = `rgb(${17 + v}, ${21 + v}, ${36 + v})`;
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
    ctx.strokeStyle = 'rgba(130,150,230,0.14)';
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
    ctx.fillStyle = '#0d1230';
    ctx.fillRect(0, 0, w, w);
    ctx.strokeStyle = 'rgba(120,140,240,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(w / 2, w / 2, w * 0.38, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(120,140,240,0.18)';
    for (let r = 8; r < w * 0.38; r += 8) { ctx.beginPath(); ctx.arc(w / 2, w / 2, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(120,140,240,0.25)';
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
    ctx.fillStyle = '#071226';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(45,212,191,0.18)';
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
    ctx.fillStyle = 'rgba(45,212,191,0.22)';
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = 'rgba(94,234,212,0.95)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Bars.
    const bx = w * 0.72;
    [0.5, 0.8, 0.35, 0.65].forEach((v, i) => {
      ctx.fillStyle = i === 1 ? 'rgba(107,140,255,0.9)' : 'rgba(107,140,255,0.55)';
      ctx.fillRect(bx + i * 16, h - 20 - v * 90, 10, v * 90);
    });
    ctx.strokeStyle = 'rgba(94,234,212,0.5)';
    ctx.strokeRect(2, 2, w - 4, h - 4);
  });
}
