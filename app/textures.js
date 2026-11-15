// Procedural canvas textures (no image assets needed).
// Every texture represents a fixed real-world size (metres) so UVs in metres can tile them.
import * as THREE from 'three';

const cache = new Map();

export function hexToRgb(hex) {
  const c = new THREE.Color(hex);
  const s = c.getHexString(THREE.SRGBColorSpace);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export function shade(hex, k) {
  // k > 0 lighten towards white, k < 0 darken towards black
  const [r, g, b] = hexToRgb(hex);
  const f = (v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mk(size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}
function finish(canvas, worldSize, key) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData.worldSize = worldSize;
  cache.set(key, t);
  return t;
}
function noise(ctx, size, amount, r) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}
function grain(ctx, x, y, w, h, color, r, horizontal = true) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.strokeStyle = color;
  const n = Math.max(3, Math.round((horizontal ? h : w) / 5));
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 0.08 + r() * 0.18;
    ctx.lineWidth = 0.6 + r() * 1.4;
    ctx.beginPath();
    if (horizontal) {
      const yy = y + r() * h; const amp = r() * 4;
      ctx.moveTo(x, yy);
      for (let s = 0; s <= 8; s++) ctx.lineTo(x + (w * s) / 8, yy + Math.sin(s * 0.9 + r() * 6) * amp);
    } else {
      const xx = x + r() * w; const amp = r() * 4;
      ctx.moveTo(xx, y);
      for (let s = 0; s <= 8; s++) ctx.lineTo(xx + Math.sin(s * 0.9 + r() * 6) * amp, y + (h * s) / 8);
    }
    ctx.stroke();
  }
  // knots
  if (r() < 0.25) {
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x + r() * w, y + r() * h, 3 + r() * 6, 2 + r() * 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------- floors ----------
export function planks({ color = '#c49a6c', plankWidth = 18, variation = 0.12, seed = 3 } = {}) {
  const key = `planks|${color}|${plankWidth}|${variation}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const S = 2.4; const px = 1024; const [c, ctx] = mk(px); const r = rng(seed);
  const pw = (plankWidth / 100 / S) * px;
  const rows = Math.max(1, Math.round(px / pw)); const ph = px / rows;
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  for (let row = 0; row < rows; row++) {
    let x = -r() * px * 0.5;
    while (x < px) {
      const len = px * (0.3 + r() * 0.35);
      const col = shade(color, (r() - 0.5) * 2 * variation);
      const draw = (ox) => {
        ctx.fillStyle = col; ctx.fillRect(x + ox, row * ph, len, ph);
        grain(ctx, x + ox, row * ph, len, ph, shade(color, -0.45), r, true);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + ox, row * ph, 1.5, ph);
      };
      draw(0); if (x < 0) draw(px); if (x + len > px) draw(-px);
      x += len;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, row * ph, px, 1.5);
  }
  noise(ctx, px, 10, r);
  return finish(c, S, key);
}

export function herringbone({ color = '#a97b52', plankWidth = 10, plankLength = 50, variation = 0.14, seed = 5 } = {}) {
  const key = `herring|${color}|${plankWidth}|${plankLength}|${variation}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const w = plankWidth; const L = Math.round(plankLength / w) * w; // cm, L multiple of w
  const P = 2 * L; // period in cm
  const px = 1024; const k = px / P; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = shade(color, -0.5); ctx.fillRect(0, 0, px, px);
  const plank = (x, y, pw, ph, horiz) => {
    const col = shade(color, (r() - 0.5) * 2 * variation);
    ctx.fillStyle = col; ctx.fillRect(x * k + 0.8, y * k + 0.8, pw * k - 1.6, ph * k - 1.6);
    grain(ctx, x * k, y * k, pw * k, ph * k, shade(color, -0.45), r, horiz);
  };
  const steps = Math.ceil(P / w) + 2;
  for (let m = -2; m <= 2; m++) {
    for (let n = -steps; n <= steps * 2; n++) {
      const ox = n * w + m * P; const oy = n * w;
      for (const ty of [-P, 0, P]) {
        plank(ox, oy + ty, L, w, true);
        plank(ox + L, oy - L + w + ty, w, L, false);
      }
    }
  }
  noise(ctx, px, 10, r);
  return finish(c, P / 100, key);
}

export function tiles({ color = '#d9d6d0', grout = '#9c968d', tileSize = 60, groutWidth = 0.3, variation = 0.05, seed = 7, marble = false } = {}) {
  const key = `tiles|${color}|${grout}|${tileSize}|${groutWidth}|${variation}|${marble}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const n = Math.max(1, Math.round(240 / tileSize)); const S = (n * tileSize) / 100;
  const px = 1024; const [c, ctx] = mk(px); const r = rng(seed);
  const t = px / n; const g = Math.max(1, (groutWidth / tileSize) * t);
  ctx.fillStyle = grout; ctx.fillRect(0, 0, px, px);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    ctx.fillStyle = shade(color, (r() - 0.5) * 2 * variation);
    ctx.fillRect(i * t + g / 2, j * t + g / 2, t - g, t - g);
  }
  if (marble) marbleVeins(ctx, px, color, r);
  noise(ctx, px, 6, r);
  return finish(c, S, key);
}

function marbleVeins(ctx, px, color, r) {
  ctx.save();
  for (let v = 0; v < 14; v++) {
    ctx.strokeStyle = shade(color, -0.35 - r() * 0.25);
    ctx.globalAlpha = 0.15 + r() * 0.35;
    ctx.lineWidth = 0.5 + r() * 2.5;
    ctx.beginPath();
    let x = r() * px; let y = -20; ctx.moveTo(x, y);
    while (y < px + 20) {
      x += (r() - 0.45) * 60; y += 20 + r() * 40;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function marble({ color = '#ece9e4', tileSize = 80, grout = '#cfcac2', seed = 11 } = {}) {
  return tiles({ color, tileSize, grout, groutWidth: 0.15, variation: 0.02, seed, marble: true });
}

export function concrete({ color = '#a7a5a0', seed = 13 } = {}) {
  const key = `concrete|${color}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 1024; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  for (let i = 0; i < 260; i++) {
    const x = r() * px; const y = r() * px; const rad = 20 + r() * 120;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const col = shade(color, (r() - 0.5) * 0.25);
    gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.35; ctx.fillStyle = gr;
    for (const ox of [-px, 0, px]) for (const oy of [-px, 0, px]) {
      ctx.save(); ctx.translate(ox, oy); ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2); ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 400; i++) { // pores
    ctx.fillStyle = shade(color, -0.3); ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.arc(r() * px, r() * px, 0.6 + r() * 1.4, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
  noise(ctx, px, 14, r);
  return finish(c, 3, key);
}

export function terrazzo({ color = '#e6e1d8', chips = ['#b9a99a', '#7d8a86', '#d8b9a0', '#ffffff', '#555'], seed = 17 } = {}) {
  const key = `terrazzo|${color}|${chips.join()}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 1024; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = chips[Math.floor(r() * chips.length)];
    const x = r() * px; const y = r() * px; const s = 2 + r() * 9;
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + r();
      const rr = s * (0.6 + r() * 0.6);
      k ? ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.fill();
  }
  noise(ctx, px, 6, r);
  return finish(c, 1.6, key);
}

export function carpet({ color = '#8d8a83', seed = 19 } = {}) {
  const key = `carpet|${color}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 512; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  noise(ctx, px, 40, r);
  return finish(c, 1, key);
}

export function brick({ color = '#9c5a43', mortar = '#d8d0c4', seed = 23 } = {}) {
  const key = `brick|${color}|${mortar}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 1024; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = mortar; ctx.fillRect(0, 0, px, px);
  const rows = 16; const bh = px / rows; const bw = px / 4.5 > 0 ? px / 5 : 200;
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let x = -bw; x < px + bw; x += bw) {
      ctx.fillStyle = shade(color, (r() - 0.5) * 0.35);
      ctx.fillRect(x + off + 3, row * bh + 3, bw - 6, bh - 6);
    }
  }
  noise(ctx, px, 22, r);
  return finish(c, 1.3, key);
}

export function woodPanel({ color = '#a8805a', slat = 4, gap = 1.2, seed = 29 } = {}) {
  const key = `slat|${color}|${slat}|${gap}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const S = 1; const px = 1024; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = shade(color, -0.6); ctx.fillRect(0, 0, px, px);
  const step = ((slat + gap) / 100 / S) * px; const sw = (slat / 100 / S) * px;
  for (let x = 0; x < px; x += step) {
    ctx.fillStyle = shade(color, (r() - 0.5) * 0.15);
    ctx.fillRect(x, 0, sw, px);
    grain(ctx, x, 0, sw, px, shade(color, -0.4), r, false);
  }
  return finish(c, S, key);
}

export function limewash({ color = '#e8e2d6', seed = 31 } = {}) {
  const key = `lime|${color}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 1024; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  for (let i = 0; i < 500; i++) {
    ctx.strokeStyle = shade(color, (r() - 0.5) * 0.16); ctx.globalAlpha = 0.25;
    ctx.lineWidth = 10 + r() * 40; ctx.beginPath();
    const x = r() * px; const y = r() * px; const a = r() * Math.PI;
    ctx.moveTo(x, y); ctx.quadraticCurveTo(x + Math.cos(a) * 60, y + 80 * r(), x + Math.cos(a) * 140, y + Math.sin(a) * 140);
    ctx.stroke();
  }
  ctx.globalAlpha = 1; noise(ctx, px, 6, r);
  return finish(c, 2.5, key);
}

export function woodGrain({ color = '#b48a5e', seed = 37 } = {}) {
  // generic grain for furniture surfaces
  const key = `grain|${color}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 512; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  grain(ctx, 0, 0, px, px, shade(color, -0.4), r, true);
  grain(ctx, 0, 0, px, px, shade(color, -0.3), r, true);
  grain(ctx, 0, 0, px, px, shade(color, 0.2), r, true);
  noise(ctx, px, 8, r);
  return finish(c, 0.8, key);
}

export function fabric({ color = '#bdb7ad', seed = 41 } = {}) {
  const key = `fabric|${color}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 256; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < px; i += 2) {
    ctx.fillStyle = i % 4 ? '#000' : '#fff';
    ctx.fillRect(i, 0, 1, px); ctx.fillRect(0, i, px, 1);
  }
  ctx.globalAlpha = 1; noise(ctx, px, 12, r);
  return finish(c, 0.25, key);
}

export function rugPattern({ color = '#cfc6b8', accent = '#8a7a66', pattern = 'border', seed = 43 } = {}) {
  const key = `rug|${color}|${accent}|${pattern}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const px = 512; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = color; ctx.fillRect(0, 0, px, px);
  ctx.strokeStyle = accent; ctx.fillStyle = accent;
  if (pattern === 'border') {
    ctx.lineWidth = 14; ctx.strokeRect(30, 30, px - 60, px - 60);
    ctx.lineWidth = 4; ctx.strokeRect(60, 60, px - 120, px - 120);
  } else if (pattern === 'stripe') {
    for (let y = 0; y < px; y += 64) ctx.fillRect(0, y, px, 18);
  } else if (pattern === 'diamond') {
    ctx.lineWidth = 5;
    for (let i = -px; i < px * 2; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + px, px); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(i, px); ctx.lineTo(i + px, 0); ctx.stroke();
    }
  } else if (pattern === 'abstract') {
    for (let i = 0; i < 9; i++) {
      ctx.globalAlpha = 0.5 + r() * 0.4;
      ctx.beginPath(); ctx.arc(r() * px, r() * px, 30 + r() * 110, r() * 6, r() * 6 + 2); ctx.lineWidth = 10 + r() * 30; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  noise(ctx, px, 28, r);
  const t = finish(c, 1, key);
  t.userData.stretch = true; // stretched over the whole rug, not tiled
  return t;
}

export function artCanvas({ palette = ['#c96f4a', '#e3c9a8', '#36454f', '#f4efe6'], seed = 47, kind = 'shapes' } = {}) {
  const key = `art|${palette.join()}|${seed}|${kind}`;
  if (cache.has(key)) return cache.get(key);
  const px = 512; const [c, ctx] = mk(px); const r = rng(seed);
  ctx.fillStyle = palette[palette.length - 1]; ctx.fillRect(0, 0, px, px);
  if (kind === 'lines') {
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = palette[i % (palette.length - 1)]; ctx.lineWidth = 4 + r() * 10;
      ctx.beginPath(); ctx.moveTo(0, r() * px);
      ctx.bezierCurveTo(px * 0.3, r() * px, px * 0.6, r() * px, px, r() * px); ctx.stroke();
    }
  } else {
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = palette[i % (palette.length - 1)]; ctx.globalAlpha = 0.85;
      if (r() < 0.5) { ctx.beginPath(); ctx.arc(r() * px, r() * px, 40 + r() * 140, 0, 7); ctx.fill(); }
      else ctx.fillRect(r() * px * 0.7, r() * px * 0.7, 60 + r() * 220, 60 + r() * 220);
    }
  }
  ctx.globalAlpha = 1; noise(ctx, px, 14, r);
  const t = finish(c, 1, key); t.userData.stretch = true; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function clearTextureCache() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
