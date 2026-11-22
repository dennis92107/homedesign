// Auto accessories (自動擺飾 / 軟裝) — 2026-11-22「真實版升級」.
// Every furniture piece gets a small styled set by type, coloured from the template palette:
//   sofa: throw pillows (count by width: 2 / 3 / 5 for a sectional — Raymour & Flanigan, Crate & Barrel) + folded throw
//   coffee table: book stack + tray with a candle + small vase (the designers' "rule of three": low anchor, mid, tall)
//   bed: duvet + sleeping pillows (bedding, always on) · accent pillows + bed-end runner (foot third of the bed)
//   nightstand / desk / side table: table lamp + books · dining table: vase with branches
//   tv cabinet / sideboard: vase + books · wall art above sofa / bed / sideboard: about 2/3 of the furniture width,
//   centre ≈ 145 cm (57" gallery rule) or 20 cm above the back, never over a window or door
// Lived-in touches (2026-11-22 擬真度 ③; 'realism comes from the small details': cushions not identical, a throw
// tossed, a mug — but little clutter): seeded jitter on pillows / throws, a mug on the coffee table, an open book on
// the sofa, slippers by the bed, cups on the dining table. decor.lived = false turns these off.
// Toggle: style.decor.accessories = false (template / customisation layer) or item.decor = false.
// Bedding and the TV are not "accessories" and stay on.
//
// Pieces are children of the furniture group (they move with it) tagged userData.decorPiece. Their height is not
// hard-coded: `settleDecor()` ray-casts the furniture's own meshes (procedural or the real model, whichever is there)
// to find the seat / table top / mattress / backrest, so the same set works on any model.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as TX from './textures.js';
import { makeRole } from './materials.js';
import { modelInstance } from './assets.js';
import { boxGeo, lampLight } from './furniture.js';

const ABO = (i) => 'local:abo_' + i;
export const DECOR_MODELS = {
  pillow: ABO('B07MBFDS2R'), lumbar: ABO('B07MBFF1K5'), lamp: ABO('B07M6PHS6W'),
  vaseTall: ABO('B07QD6ZV9Q'), vasePair: ABO('B07QHL8W81'), vaseRound: ABO('B07B8NZQ68'), tray: ABO('B078JMXRGC'),
};

// ---------- colours ----------
const hexOf = (v) => (typeof v === 'string' ? v : v?.color);
function rgb(h) { const c = new THREE.Color(h); return [c.r, c.g, c.b]; }
const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const dist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

/** per-build context: palette, material cache, on/off */
export function decorContext(style, M) {
  const pal = (style.palette?.length ? style.palette : ['#d8d0c3', '#8b7d6b', '#c4744f', '#36454f', '#f4efe6']).filter(Boolean);
  const mats = style.materials || {};
  // decor.softColors given → only those (a template that lists its cushion colours means it); else accent, fabricAlt, palette
  const soft = style.decor?.softColors?.length ? [...style.decor.softColors] : [...new Set([hexOf(mats.accent), hexOf(mats.fabricAlt), ...pal].filter(Boolean))];
  const cache = new Map();
  const cacheRef = cache;
  const fabric = (c) => { const k = 'f' + c; if (!cache.has(k)) cache.set(k, makeRole({ color: c, texture: 'fabric', roughness: 0.97 }, 'fabricAlt')); return cache.get(k); };
  const plain = (c, roughness = 0.6, metalness = 0) => { const k = `p${c}|${roughness}|${metalness}`; if (!cache.has(k)) { const m = new THREE.MeshStandardMaterial({ color: c, roughness, metalness }); m.userData.baseColor = c; cache.set(k, m); } return cache.get(k); };
  return {
    style, M, pal, soft, fabric, plain, cache: cacheRef,
    on: style.decor?.accessories !== false,
    opt: style.decor || {},
    artPalette: style.decor?.artPalette || pal,
    bookColors: style.decor?.bookColors || ['#8c6e54', '#c9b79c', '#3f4e4f', '#a65f46', '#e5ddd0'],
    /** n textile colours that stand out from `base` (the sofa / bedding colour) */
    softFor(base, n, offset = 0) {
      const far = soft.filter((c) => dist(c, base) > 0.18);
      const list = far.length >= 2 ? far : soft;
      return Array.from({ length: n }, (_, i) => list[(i + offset) % list.length]);
    },
  };
}

// ---------- small geometry helpers ----------
function mesh(geo, mat) { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; return m; }
function rbox(w, h, d, r, mat) { r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001); return mesh(new RoundedBoxGeometry(w, h, d, 3, Math.max(0.002, r)), mat); }
function piece(kind, settle, extra = {}) {
  const g = new THREE.Group();
  g.userData = { decorPiece: kind, settle, ...extra };
  return g;
}
const ph = (o) => { o.userData.ph = true; return o; }; // placeholder, replaced when the real model arrives

function pillow(ctx, color, { w = 0.5, lumbar = false } = {}) {
  const h = lumbar ? w * 0.48 : w * 0.96, t = lumbar ? 0.13 : 0.16;
  // decor.pillows: "plain" = solid linen cushions (no striped ABO model)
  const g = piece('pillow', null, ctx.opt.pillows === 'plain' ? {} : { model: { id: lumbar ? DECOR_MODELS.lumbar : DECOR_MODELS.pillow, fit: { w, d: t + 0.04, h, by: 'height' }, tint: color } });
  const m = ph(rbox(w, h, t, 0.06, ctx.fabric(color))); m.position.y = h / 2; g.add(m);
  return g;
}
/** knit material for throws: fabric colour + chunky-knit normal map (shared per colour) */
function knitMat(ctx, color) {
  const k = 'knit' + color; const c = ctx.cache;
  if (!c.has(k)) { const m = ctx.fabric(color).clone(); m.normalMap = TX.knitNormal(); m.normalMap.repeat.set(2.5, 2.5); /* plane UVs span the whole throw: ≈ 2.5 cm stitches */ m.normalScale = new THREE.Vector2(0.9, 0.9); m.side = THREE.DoubleSide; m.roughness = 1; c.set(k, m); }
  return c.get(k);
}
/**
 * Cloth sheet draped over an edge (擬真度 ⑧): lies flat for `top` metres (local −z → +z), rolls over the edge with
 * radius r, hangs down `hang` metres. Soft wrinkles everywhere, deeper vertical folds in the hanging part, an
 * uneven hem. Origin = the edge line at the top surface (y = 0, z = 0); the flat part is at z < 0.
 */
function drape(mat, w, top, hang, seed, { r = 0.03, t = 0.012, folds = 5, amp = 0.025, sag = 0.01 } = {}) {
  const rr = TX.rng(seed); const ph = [rr() * 6, rr() * 6, rr() * 6, rr() * 6];
  const L = top + (Math.PI / 2) * r + hang;
  const nu = Math.max(24, Math.round(w / 0.015)), nv = Math.max(28, Math.round(L / 0.015));
  const geo = new THREE.PlaneGeometry(w, L, nu, nv); const P = geo.attributes.position;
  const foldK = (folds * Math.PI) / w;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), s = L / 2 - P.getY(i); // s = arc length from the far (flat) end
    const wr = 0.004 * Math.sin(x * 23 + s * 11 + ph[0]) + 0.003 * Math.sin(x * 41 - s * 17 + ph[1]);
    let px = x, py, pz, n0;
    if (s < top) { // flat, lifted a little at random (it's not ironed)
      py = t / 2 + Math.max(0, wr) + sag * Math.sin(Math.PI * s / top) * (0.5 + 0.5 * Math.sin(x * 5 + ph[2]));
      pz = s - top;
    } else if (s < top + (Math.PI / 2) * r) { // roll over the edge
      const a = (s - top) / r;
      py = t / 2 + wr - r + r * Math.cos(a); pz = r * Math.sin(a);
    } else { // hanging: vertical folds that deepen towards the hem, hem a bit irregular
      const hgt = s - top - (Math.PI / 2) * r, k = hgt / Math.max(hang, 1e-3);
      const fold = amp * k * (0.75 * Math.sin(x * foldK + ph[3]) + 0.25 * Math.sin(x * foldK * 2.3 + ph[1]));
      py = t / 2 - r - hgt + 0.012 * k * Math.sin(x * 9 + ph[0]);
      pz = r + fold + 0.004 + wr * 0.5 + k * k * 0.01;
    }
    P.setXYZ(i, px, py, pz);
  }
  geo.computeVertexNormals();
  const m = mesh(geo, mat); return m;
}
/** folded throw lying on a seat / bed with one edge hanging over the front (soft cloth, see drape) */
function folded(ctx, color, w, d, flap = 0.22, t = 0.022, seed = 3) {
  const g = new THREE.Group(); const mat = knitMat(ctx, color);
  // two layers (it is folded): the lower one a touch wider, the top one with the draped front edge
  const under = drape(mat, w - 0.02, d - 0.03, 0.02, seed + 1, { amp: 0.004, sag: 0.006 }); under.position.set(0, 0.002, d / 2 - 0.01); g.add(under);
  const over = drape(mat, w, d, flap, seed, { amp: 0.03, sag: 0.012 }); over.position.set(0, t, d / 2); g.add(over);
  return g;
}
function books(ctx, n, seed, { maxW = 0.3 } = {}) {
  const r = TX.rng(seed); const g = new THREE.Group(); let y = 0;
  const pages = ctx.plain('#efe9dd', 0.9);
  for (let i = 0; i < n; i++) {
    const w = Math.min(maxW, 0.2 + r() * 0.1), d = w * (0.7 + r() * 0.1), h = 0.022 + r() * 0.022;
    const cover = ctx.plain(ctx.bookColors[Math.floor(r() * ctx.bookColors.length)], 0.75);
    const b = new THREE.Group();
    const c = mesh(new THREE.BoxGeometry(w, h, d), cover); c.position.y = h / 2; b.add(c);
    const p = mesh(new THREE.BoxGeometry(w * 0.97, h * 0.8, 0.004), pages); p.position.set(-0.002, h / 2, d / 2 + 0.001); b.add(p); // page block on the fore-edge
    b.position.y = y; b.rotation.y = (r() - 0.5) * 0.35; g.add(b); y += h;
  }
  g.userData.height = y;
  return g;
}
function vase(ctx, kind, color, h) {
  const id = { tall: DECOR_MODELS.vaseTall, pair: DECOR_MODELS.vasePair, round: DECOR_MODELS.vaseRound }[kind];
  const w = kind === 'pair' ? h * 1.4 : h * (kind === 'round' ? 0.75 : 0.5);
  const g = piece('vase', null, { model: { id, fit: { w, d: w, h, by: 'height' }, tint: color } });
  const m = ph(mesh(new THREE.CylinderGeometry(w * 0.3, w * 0.4, h, 24), ctx.plain(color, 0.4))); m.position.y = h / 2; g.add(m);
  return g;
}
/** a few branches with leaves standing in a vase (stays when the vase model loads) */
function branches(ctx, h, seed, { dry = false } = {}) {
  const g = new THREE.Group(); const r = TX.rng(seed);
  const stem = ctx.plain(dry ? '#3f342b' : '#5b4a3a', 0.85); const leaf = dry ? ctx.plain('#6a5646', 0.9) : ctx.plain(hexOf(ctx.style.materials?.plant) || '#56683f', 0.75);
  const n = dry ? 4 : 5;
  for (let i = 0; i < n; i++) {
    const L = h * (0.7 + r() * 0.5), a = r() * Math.PI * 2, tilt = (dry ? 0.3 : 0.15) + r() * 0.35;
    const s = new THREE.Group(); s.rotation.set(Math.cos(a) * tilt, 0, Math.sin(a) * tilt);
    const c = mesh(new THREE.CylinderGeometry(dry ? 0.002 : 0.003, dry ? 0.006 : 0.004, L, 5), stem); c.position.y = L / 2; s.add(c);
    if (dry) { // forked twigs with small buds (枯枝)
      for (let j = 0; j < 6; j++) {
        const tw = new THREE.Group(); const tl = L * (0.18 + r() * 0.22), y0 = L * (0.35 + r() * 0.6);
        tw.position.y = y0; tw.rotation.set((r() - 0.5) * 2.2, r() * 6.28, (r() - 0.5) * 2.2);
        const tc = mesh(new THREE.CylinderGeometry(0.0012, 0.0025, tl, 4), stem); tc.position.y = tl / 2; tw.add(tc);
        for (let k = 0; k < 3; k++) { const b = mesh(new THREE.SphereGeometry(0.006, 5, 4), leaf); b.position.y = tl * (0.5 + k * 0.22); tw.add(b); }
        s.add(tw);
      }
    } else for (let j = 0; j < 4; j++) {
      const lf = mesh(new THREE.SphereGeometry(0.03, 6, 4), leaf); lf.scale.set(1, 0.18, 0.55);
      lf.position.set((r() - 0.5) * 0.04, L * (0.55 + j * 0.12), (r() - 0.5) * 0.04); lf.rotation.set(r(), r() * 6, r()); s.add(lf);
    }
    g.add(s);
  }
  return g;
}
/** wooden bowl with pillar candles (and two oranges) — the wabi coffee-table set */
function bowl(ctx, seed) {
  const g = new THREE.Group(); const r = TX.rng(seed);
  const pts = [[0, 0], [0.06, 0], [0.12, 0.02], [0.16, 0.055], [0.17, 0.085], [0.163, 0.085], [0.152, 0.058], [0.11, 0.028], [0.0, 0.02]].map(([x, y]) => new THREE.Vector2(x, y));
  g.add(mesh(new THREE.LatheGeometry(pts, 40), ctx.M.woodDark));
  const wax = ctx.plain('#f2ebdf', 0.85);
  [[-0.04, 0.0, 0.12], [0.05, 0.03, 0.08]].forEach(([x, z, h]) => { const c = mesh(new THREE.CylinderGeometry(0.035, 0.035, h, 24), wax); c.position.set(x, 0.02 + h / 2, z); g.add(c); });
  const fruit = ctx.plain('#d98a2b', 0.55);
  for (let i = 0; i < 2; i++) { const f = mesh(new THREE.SphereGeometry(0.035, 16, 12), fruit); f.position.set(0.02 + (r() - 0.5) * 0.1, 0.055, -0.07 + i * 0.03); g.add(f); }
  return g;
}
/** mushroom table lamp: round ceramic base + wide shallow linen shade */
function mushroomLamp(ctx, h = 0.42) {
  const g = new THREE.Group();
  const base = mesh(new THREE.SphereGeometry(h * 0.26, 28, 20), ctx.plain(hexOf(ctx.style.materials?.pot) || '#e4dccf', 0.55)); base.scale.y = 0.95; base.position.y = h * 0.25; g.add(base);
  const neck = mesh(new THREE.CylinderGeometry(0.012, 0.012, h * 0.3, 8), ctx.plain('#8a7a68', 0.5)); neck.position.y = h * 0.6; g.add(neck);
  const shadeMat = ctx.M.lampshade.clone(); shadeMat.side = THREE.DoubleSide; shadeMat.userData.isLampshade = true;
  const shade = mesh(new THREE.CylinderGeometry(h * 0.1, h * 0.6, h * 0.3, 40, 1, true), shadeMat); shade.position.y = h * 0.82; shade.castShadow = false; g.add(shade);
  g.add(lampLight(2.2, { y: h * 0.76 }));
  return g;
}
/** Panton-Moon-like pendant: nested white spherical bands turned around the cord (furniture frame, y = floor) */
function moonPendant(ctx, dropTo, ceiling, d = 0.34) {
  const g = new THREE.Group(); const white = ctx.plain('#f4f1ec', 0.45).clone(); white.side = THREE.DoubleSide;
  const cord = mesh(new THREE.CylinderGeometry(0.002, 0.002, ceiling - dropTo, 5), ctx.plain('#d8d4ce', 0.6)); cord.position.y = (ceiling + dropTo) / 2; g.add(cord);
  for (let i = 0; i < 7; i++) {
    const band = mesh(new THREE.SphereGeometry(d / 2 - i * 0.012, 32, 16, 0, Math.PI * 0.62), white); band.rotation.y = i * 0.5; band.position.y = dropTo - d / 2; g.add(band);
  }
  const bulb = mesh(new THREE.SphereGeometry(0.04, 12, 8), ctx.M.lampshade); bulb.position.y = dropTo - d / 2; g.add(bulb);
  g.add(lampLight(2.6, { y: dropTo - d / 2 }));
  return g;
}
/** round frosted-disc wall sconce with a dark centre cap (origin = wall face, front +Z) */
function discSconce(ctx, D = 0.38) {
  const g = new THREE.Group();
  const glass = new THREE.MeshStandardMaterial({ color: '#f3efe8', roughness: 0.35, emissive: '#ffd9a8', emissiveIntensity: 0.6, transparent: true, opacity: 0.9 });
  glass.userData.isLampshade = true;
  const disc = mesh(new THREE.CylinderGeometry(D / 2, D / 2, 0.008, 64), glass); disc.rotation.x = Math.PI / 2; disc.position.z = 0.05; g.add(disc);
  const cap = mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.045, 32), ctx.plain('#2b2724', 0.5)); cap.rotation.x = Math.PI / 2; cap.position.z = 0.075; g.add(cap);
  const arm = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8), ctx.plain('#2b2724', 0.5)); arm.rotation.x = Math.PI / 2; arm.position.z = 0.025; g.add(arm);
  g.add(lampLight(1.6, { z: 0.03 })); // behind the disc: a halo on the wall
  return g;
}
/** PH-style lamp: three stacked brass shades (Poul Henningsen silhouette) */
function phLamp(ctx, h = 0.45) {
  const g = new THREE.Group(); const brass = ctx.plain('#b08d57', 0.35, 0.8); brass.side = THREE.DoubleSide;
  const base = mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.02, 32), brass); base.position.y = 0.01; g.add(base);
  const stem = mesh(new THREE.CylinderGeometry(0.008, 0.008, h * 0.62, 10), brass); stem.position.y = h * 0.31; g.add(stem);
  [[0.15, 0.06, 0.9], [0.115, 0.05, 0.79], [0.07, 0.035, 0.7]].forEach(([r, hh, y]) => {
    const sh = mesh(new THREE.CylinderGeometry(r * 0.35, r, hh, 40, 1, true), brass); sh.position.y = h * y; g.add(sh);
  });
  const bulb = mesh(new THREE.SphereGeometry(0.03, 12, 8), ctx.M.lampshade); bulb.position.y = h * 0.74; g.add(bulb);
  g.add(lampLight(2.0, { y: h * 0.72 }));
  return g;
}
/** white dome lamp (墨 bedroom: a white dish shade on a thin black stem) */
function domeLamp(ctx, h = 0.42) {
  const g = new THREE.Group(); const black = ctx.plain('#1d1d1d', 0.45, 0.3);
  const base = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.015, 32), black); base.position.y = 0.0075; g.add(base);
  const stem = mesh(new THREE.CylinderGeometry(0.006, 0.006, h * 0.7, 8), black); stem.position.y = h * 0.35; g.add(stem);
  const white = ctx.plain('#f3f1ed', 0.3).clone(); white.side = THREE.DoubleSide;
  const shade = mesh(new THREE.SphereGeometry(0.13, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), white); shade.position.y = h * 0.72; shade.rotation.x = Math.PI + 0.5; g.add(shade);
  const bulb = mesh(new THREE.SphereGeometry(0.035, 12, 8), ctx.M.lampshade); bulb.position.y = h * 0.74; g.add(bulb);
  g.add(lampLight(2.0, { y: h * 0.7 }));
  return g;
}
/** small black wall cube sconce (up/down light), origin = wall face, front +Z */
function cubeSconce(ctx) {
  const g = new THREE.Group();
  const c = mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), ctx.plain('#1c1c1c', 0.5, 0.4)); c.position.z = 0.045; g.add(c);
  for (const s of [-1, 1]) { const l = mesh(new THREE.CircleGeometry(0.025, 16), ctx.M.lampshade); l.rotation.x = s * Math.PI / 2; l.position.set(0, s * 0.0451, 0.045); g.add(l); }
  g.add(lampLight(1.3, { z: 0.1 }));
  return g;
}
/** black pedestal tray side table with a marble base (墨) */
function trayTable(ctx) {
  const g = new THREE.Group(); const black = ctx.plain('#1e1e1e', 0.35, 0.6);
  const base = mesh(new THREE.CylinderGeometry(0.13, 0.14, 0.06, 40), ctx.plain('#2b2b2c', 0.25)); base.position.y = 0.03; g.add(base);
  const stem = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 10), black); stem.position.y = 0.31; g.add(stem);
  const top = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.012, 48), black); top.position.y = 0.56; g.add(top);
  const rim = mesh(new THREE.TorusGeometry(0.2, 0.006, 6, 48), black); rim.rotation.x = Math.PI / 2; rim.position.y = 0.57; g.add(rim);
  return g;
}
/** ceramic mug (origin = bottom) */
function mug(ctx, color) {
  const g = new THREE.Group(); const m = ctx.plain(color, 0.35);
  const inMat = ctx.plain(color, 0.36).clone(); inMat.side = THREE.BackSide;
  const body = mesh(new THREE.CylinderGeometry(0.041, 0.038, 0.095, 28, 1, true), m); body.position.y = 0.0475; g.add(body);
  const bottom = mesh(new THREE.CircleGeometry(0.038, 28), m); bottom.rotation.x = -Math.PI / 2; bottom.position.y = 0.004; g.add(bottom);
  const inner = mesh(new THREE.CylinderGeometry(0.037, 0.035, 0.088, 28, 1, true), inMat); inner.position.y = 0.051; g.add(inner);
  const coffee = mesh(new THREE.CircleGeometry(0.036, 24), ctx.plain('#3b2416', 0.15)); coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.075; g.add(coffee);
  const handle = mesh(new THREE.TorusGeometry(0.025, 0.006, 8, 18, Math.PI * 1.25), m); handle.position.set(0.041, 0.05, 0); handle.rotation.z = -Math.PI * 0.62; g.add(handle);
  return g;
}
/** paperback left open face-down (a tent), origin = bottom */
function openBook(ctx, seed) {
  const r = TX.rng(seed); const g = new THREE.Group();
  const cover = ctx.plain(ctx.bookColors[Math.floor(r() * ctx.bookColors.length)], 0.75), pages = ctx.plain('#efe9dd', 0.9);
  for (const s of [-1, 1]) {
    const half = new THREE.Group(); half.rotation.z = s * -0.2; // spine up, halves sloping down
    const c = mesh(new THREE.BoxGeometry(0.13, 0.003, 0.2), cover); c.position.set(s * 0.065, 0.0015, 0); half.add(c);
    const p = mesh(new THREE.BoxGeometry(0.125, 0.012, 0.19), pages); p.position.set(s * 0.064, -0.006, 0); half.add(p);
    half.position.y = 0.03; g.add(half);
  }
  return g;
}
/** pair of felt slippers, slightly splayed (origin = floor) */
function slippers(ctx, color, seed) {
  const r = TX.rng(seed); const g = new THREE.Group(); const m = ctx.fabric(color); const sole = ctx.plain('#d9d2c6', 0.9);
  for (const s of [-1, 1]) {
    const sl = new THREE.Group(); sl.position.set(s * 0.065, 0, (r() - 0.5) * 0.05); sl.rotation.y = s * (0.08 + r() * 0.12);
    const so = rbox(0.095, 0.018, 0.27, 0.008, sole); so.position.y = 0.009; sl.add(so);
    const up = mesh(new THREE.SphereGeometry(0.05, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), m); up.scale.set(0.95, 0.75, 1.55); up.position.set(0, 0.016, 0.055); sl.add(up);
    g.add(sl);
  }
  return g;
}
/** pair of black candlesticks with tall white candles (隱 dining table) */
function candlesticks(ctx) {
  const g = new THREE.Group(); const black = ctx.plain('#1a1a1a', 0.35, 0.6); const wax = ctx.plain('#f4efe6', 0.8);
  [[-0.06, 0, 0.22], [0.06, 0.05, 0.16]].forEach(([x, z, h]) => {
    const b = mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.012, 24), black); b.position.set(x, 0.006, z); g.add(b);
    const s = mesh(new THREE.CylinderGeometry(0.007, 0.007, h, 8), black); s.position.set(x, 0.012 + h / 2, z); g.add(s);
    const c = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.2, 12), wax); c.position.set(x, 0.012 + h + 0.1, z); g.add(c);
  });
  return g;
}
/** linen duvet with soft wrinkles (top sheet + sides hanging down), origin = top of the mattress centre */
function duvet(ctx, color, w, l, hang, seed) {
  const g = new THREE.Group(); const r = TX.rng(seed);
  const mat = ctx.fabric(color).clone(); mat.side = THREE.DoubleSide;
  const ph1 = r() * 6, ph2 = r() * 6, ph3 = r() * 6, ph4 = r() * 6, T = 0.06;
  // soft wrinkles: low-frequency puffs + a few long diagonal creases (where someone sat / pulled the cover)
  const crease = (x, z) => { let c = 0; for (let k = 0; k < 3; k++) { const a = ph1 + k * 2.1, d = Math.abs((x * Math.cos(a) + z * Math.sin(a)) - (k - 1) * 0.35); c -= 0.008 * Math.exp(-d * d / 0.0018); } return c; };
  const wr = (x, z, a) => a * (0.55 * Math.sin(x * 9 + z * 3 + ph1) * Math.sin(z * 7 + ph2) + 0.3 * Math.sin((x - z) * 17 + ph3) + 0.15 * Math.sin(x * 31 + z * 23)) + crease(x, z);
  const top = new THREE.PlaneGeometry(w, l, 72, 60); top.rotateX(-Math.PI / 2);
  const P = top.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), z = P.getZ(i);
    const edge = Math.min(1, (w / 2 - Math.abs(x)) / 0.1, (l / 2 - Math.abs(z)) / 0.1);
    const e = Math.max(0, edge);
    P.setY(i, T + wr(x, z, 0.014) * e - (1 - e) * (1 - e) * 0.03); // a soft rounded shoulder, not a box edge
  }
  top.computeVertexNormals(); g.add(mesh(top, mat));
  // sides: hang in loose vertical folds that open towards the hem (cloth drape), hem not dead straight
  const side = (len, sx, sz, ry, seedK) => {
    const geo = new THREE.PlaneGeometry(len, hang, Math.round(len / 0.02), 14); const Q = geo.attributes.position;
    const nf = Math.max(3, Math.round(len / 0.32));
    for (let i = 0; i < Q.count; i++) {
      const u = Q.getX(i), v = Q.getY(i); const t = (hang / 2 - v) / hang; // 0 top → 1 hem
      const fold = (0.006 + t * t * 0.03) * (0.65 * Math.sin((u / len) * nf * Math.PI * 2 + ph1 + seedK) + 0.35 * Math.sin(u * 13.7 + ph2 + t * 2));
      Q.setZ(i, fold + t * 0.018);
      Q.setY(i, v + 0.008 * t * Math.sin(u * 6 + ph4 + seedK));
    }
    geo.computeVertexNormals(); const m = mesh(geo, mat); m.position.set(sx, T - 0.03 - hang / 2, sz); m.rotation.y = ry; g.add(m);
  };
  side(l, -w / 2, 0, -Math.PI / 2, 0); side(l, w / 2, 0, Math.PI / 2, 1.3); side(w, 0, l / 2, 0, 2.6);
  // turn-down: the head end of the duvet folded back over itself (a rolled band, like a made bed)
  const band = new THREE.PlaneGeometry(w + 0.01, 0.26, 72, 10); band.rotateX(-Math.PI / 2); const B = band.attributes.position;
  for (let i = 0; i < B.count; i++) {
    const x = B.getX(i), z = B.getZ(i); const t = (z + 0.13) / 0.26; // 0 = fold line (head side), 1 = loose edge
    const lift = 0.035 * Math.sin(Math.min(1, t * 1.4) * Math.PI * 0.5) * (1 - 0.4 * t) + 0.006 * Math.sin(x * 11 + ph3);
    B.setY(i, T + lift + 0.006); B.setZ(i, z + 0.01 * Math.sin(x * 4 + ph4) * t);
  }
  band.computeVertexNormals(); const bm = mesh(band, mat); bm.position.z = -l / 2 + 0.13; g.add(bm);
  const roll = mesh(new THREE.CylinderGeometry(0.022, 0.022, w + 0.01, 24, 1, true), mat); roll.rotation.z = Math.PI / 2; roll.position.set(0, T + 0.01, -l / 2 + 0.005); g.add(roll);
  return g;
}
function tray(ctx) {
  const g = piece('tray', null, { model: { id: DECOR_MODELS.tray, fit: { w: 0.4, d: 0.24, h: 0.06 } } });
  g.add(ph(rbox(0.4, 0.02, 0.24, 0.008, ctx.plain('#3d3b39', 0.5))));
  const candle = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.08, 20), ctx.plain('#f1ece2', 0.8)); candle.position.set(0.09, 0.016 + 0.04, 0); g.add(candle);
  return g;
}
function lamp(ctx, h = 0.45) {
  const g = piece('lamp', null, { model: { id: DECOR_MODELS.lamp, fit: { w: h * 0.55, d: h * 0.55, h, by: 'height' } } });
  const base = ph(mesh(new THREE.CylinderGeometry(0.05, 0.065, h * 0.45, 20), ctx.plain('#d9d4cb', 0.3))); base.position.y = h * 0.225; g.add(base);
  const shade = ph(mesh(new THREE.CylinderGeometry(h * 0.24, h * 0.27, h * 0.45, 24, 1, true), ctx.M.lampshade)); shade.position.y = h * 0.72; shade.castShadow = false; g.add(shade);
  g.add(lampLight(2.2, { y: h * 0.7 }));
  return g;
}
/** framed print: frame + white mat + palette art; origin = centre of the picture, back on z = 0 */
function art(ctx, w, h, seed, kind) {
  const g = new THREE.Group();
  const frameMat = ctx.M.woodDark || ctx.plain('#2a2623', 0.5);
  const fw = 0.025, depth = 0.03;
  const mk = (ww, hh, x, y) => { const m = mesh(new THREE.BoxGeometry(ww, hh, depth), frameMat); m.position.set(x, y, depth / 2); g.add(m); };
  mk(w, fw, 0, h / 2 - fw / 2); mk(w, fw, 0, -h / 2 + fw / 2); mk(fw, h - 2 * fw, -w / 2 + fw / 2, 0); mk(fw, h - 2 * fw, w / 2 - fw / 2, 0);
  const matBoard = mesh(new THREE.PlaneGeometry(w - 2 * fw, h - 2 * fw), ctx.plain('#f3f0ea', 0.95)); matBoard.position.z = depth - 0.012; g.add(matBoard);
  const m = Math.min(w, h) * 0.1; // passe-partout margin
  const tex = TX.artCanvas({ palette: ctx.artPalette, seed, kind });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(w - 2 * fw - 2 * m, h - 2 * fw - 2 * m), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  p.position.z = depth - 0.011; p.receiveShadow = true; g.add(p);
  return g;
}

// ---------- per-type sets ----------
/**
 * Add the accessory set for one piece. `item` is in metres (w, d, h), `it` the plan item (cm).
 * env: { roomType, wall: { dist (m, centre → wall face behind), span (m usable width along the wall) } | null,
 *        ceiling (m), artNear (bool: the plan already has art near this piece), seed }
 */
export function addDecor(obj, it, item, ctx, env) {
  const t = it.type, w = item.w, d = item.d;
  const acc = ctx.on && it.decor !== false && env.roomType !== 'storage';
  const add = (p, x = 0, z = 0, ry = 0) => { p.position.set(x, 0, z); p.rotation.y = ry; obj.add(p); return p; };
  const seed = env.seed;
  const sofaColor = hexOf(it.colors?.fabric) || ctx.M.fabric?.userData.baseColor || '#cccccc';

  if (t === 'sofa' && acc) {
    const arm = 0.18, inner = w - 2 * arm;
    const n = it.chaise || inner > 2.1 ? 5 : inner > 1.45 ? 3 : 2;
    const [c0, c1, c2] = ctx.softFor(sofaColor, 3, seed % 2);
    const zs = -d / 2 + d * 0.55;
    const jr = TX.rng(seed * 7 + 3); const lived = ctx.opt.lived !== false;
    const lean = (x, c, opt) => {
      const p = add(pillow(ctx, c, opt), x);
      // not lined up like a showroom: each cushion leans a little differently, some a bit squashed
      const j = lived ? { tilt: -0.2 - jr() * 0.18, jy: (jr() - 0.5) * 0.22, jz: (jr() - 0.5) * 0.2 } : { tilt: -0.2, jy: 0, jz: 0 };
      if (lived) p.scale.set(1 + (jr() - 0.5) * 0.06, 1 - jr() * 0.08, 1);
      p.userData.settle = { mode: 'lean', x, zProbe: zs, t: opt?.lumbar ? 0.13 : 0.16, sink: 0.03, ...j };
    };
    const xe = inner / 2 - 0.3;
    lean(-xe, c0); lean(xe, c0);
    if (n >= 5) { lean(-xe + 0.4, c1, { w: 0.45 }); lean(xe - 0.4, c1, { w: 0.45 }); }
    if (n !== 2) lean(n >= 5 ? -0.1 : -inner * 0.12, c2, { w: 0.55, lumbar: true });
    // folded throw on the seat at the end without the chaise
    const side = it.chaise === 'left' ? 1 : -1;
    const tD = 0.36, tz = d / 2 - 0.03 - tD / 2; // front edge on the seat front, the flap hangs over it
    const th = add(folded(ctx, ctx.softFor(sofaColor, 1, 2)[0], 0.42, tD), side * (inner / 2 - 0.32 - (lived ? jr() * 0.08 : 0)), tz, side * (lived ? 0.1 + jr() * 0.22 : 0.06));
    if (lived && inner > 1.45) { // a book left open face-down on the seat, at the other end
      const ox = -side * (inner / 2 - 0.45), oz = d / 2 - 0.3;
      const ob = add(piece('openBook', { mode: 'top', x: ox, z: oz, dy: -0.01 }), ox, oz, (jr() - 0.5) * 0.9); ob.add(openBook(ctx, seed + 11));
    }
    th.userData.decorPiece = 'throw'; th.userData.settle = { mode: 'top', x: th.position.x, z: th.position.z, dy: 0.005 };
    // decor.branches: dry branches in a big vase on a low black stool beside the sofa end (侘寂 枯枝花器)
    if (ctx.opt.sofaSide === 'floorLamp') { // a task floor lamp beside the sofa end
      const fl = piece('floorLamp', null, { model: { id: 'local:abo_B07374K536', fit: { w: 0.3, d: 0.5, h: 1.55, by: 'height' } } });
      const ph0 = ph(mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.5, 8), ctx.plain('#1d1d1d', 0.5))); ph0.position.y = 0.75; fl.add(ph0);
      fl.add(lampLight(2.6, { y: 1.3 }));
      add(fl, side * (w / 2 + 0.22), -d / 2 + 0.25, side > 0 ? Math.PI / 2 : -Math.PI / 2);
    } else if (ctx.opt.sofaSide === 'trayTable') {
      const tt = piece('sideTable', null); tt.add(trayTable(ctx));
      const v = vase(ctx, 'tall', ctx.pal[0], 0.18); v.position.y = 0.576; tt.add(v);
      add(tt, side * (w / 2 + 0.26), -d / 2 + 0.3);
    }
    if (ctx.opt.branches || ctx.opt.sofaSide === 'branches') {
      const fl = piece('floorVase', null); const stool = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.36, 32), ctx.plain('#2a2725', 0.6)); stool.position.y = 0.18; fl.add(stool);
      const v = vase(ctx, 'round', hexOf(ctx.style.materials?.pot) || '#d6ccbf', 0.3); v.position.y = 0.36; fl.add(v);
      const br = branches(ctx, 0.75, seed + 5, { dry: true }); br.position.y = 0.36 + 0.24; fl.add(br);
      add(fl, side * (w / 2 + 0.24), -d / 2 + 0.22);
    }
  }
  if (t === 'armchair' && acc) {
    const zs = -d / 2 + d * 0.55;
    add(pillow(ctx, ctx.softFor(hexOf(it.colors?.fabricAlt) || ctx.M.fabricAlt?.userData.baseColor || '#888', 1, 1)[0], { w: 0.42, lumbar: true }))
      .userData.settle = { mode: 'lean', x: 0, zProbe: zs, t: 0.13, tilt: -0.2, sink: 0.03 };
  }
  if (t === 'coffee_table' && acc && ctx.opt.tabletop === 'bowl') { // wooden bowl with candles + one book
    const bw = add(bowl(ctx, seed), w * 0.12, 0); bw.userData.decorPiece = 'bowl'; bw.userData.settle = { mode: 'top', x: w * 0.12, z: 0 };
    const bx = -Math.min(w, 0.9) * 0.3;
    const b = add(books(ctx, 1, seed, { maxW: 0.26 }), bx, 0.04, 0.35); b.userData.decorPiece = 'books'; b.userData.settle = { mode: 'top', x: bx, z: 0.04 };
  } else if (t === 'coffee_table' && acc) {
    const round = it.shape === 'round', small = (round ? w : Math.min(w, d)) < 0.75;
    const bx = round ? -w * 0.18 : -w * 0.25, bz = round ? w * 0.05 : 0;
    const b = add(books(ctx, small ? 2 : 3, seed, { maxW: small ? 0.24 : 0.3 }), bx, bz, 0.15); b.userData.decorPiece = 'books';
    b.userData.settle = { mode: 'top', x: bx, z: bz };
    const v = vase(ctx, 'pair', ctx.M.pot?.userData.baseColor || '#ddd', 0.13); v.position.y = b.userData.height; b.add(v);
    if (!small) { const tr = add(tray(ctx), w * 0.2, 0, -0.1); tr.userData.settle = { mode: 'top', x: w * 0.2, z: 0 }; }
    else { const v2 = add(vase(ctx, 'tall', ctx.pal[0], 0.2), w * 0.22, -0.02); v2.userData.settle = { mode: 'top', x: w * 0.22, z: -0.02 }; }
  }
  if (t === 'coffee_table' && acc && ctx.opt.lived !== false) { // a mug left on the table edge, on the sofa side
    const jr = TX.rng(seed * 5 + 1); const round = it.shape === 'round';
    const mx = -w * 0.05 + (jr() - 0.5) * 0.08, mz = -(round ? w * 0.26 : d * 0.28);
    const mg = add(piece('mug', { mode: 'top', x: mx, z: mz }), mx, mz, jr() * 6.28); mg.add(mug(ctx, ctx.opt.mugColor || '#eee9e1'));
  }
  if (t === 'side_table' && acc) {
    const p = add(env.roomType === 'living' ? lamp(ctx, 0.5) : vase(ctx, 'round', ctx.M.pot?.userData.baseColor || '#ddd', 0.2));
    p.userData.settle = { mode: 'top', x: 0, z: 0 };
  }
  if (t === 'nightstand' && acc && it.lamp !== false) {
    if (ctx.opt.bedPendant === 'moon' && env.nightIndex % 2 === 1) { // the 2nd nightstand of a room gets a hanging Moon pendant
      const pd = piece('pendant', null); pd.add(moonPendant(ctx, 1.2, env.ceiling)); add(pd, 0, -d * 0.05);
    } else if (ctx.opt.tableLamp === 'sconce') { // wall cube sconce above the nightstand (no table lamp)
      const sc = add(piece('sconce', null), 0, env.wall ? -env.wall.dist + 0.002 : -d / 2 + 0.005); const c = cubeSconce(ctx); c.position.y = 1.05; sc.add(c);
    } else if (['mushroom', 'ph', 'dome'].includes(ctx.opt.tableLamp)) {
      const mk = { mushroom: mushroomLamp, ph: phLamp, dome: domeLamp }[ctx.opt.tableLamp];
      const l = add(piece('lamp', { mode: 'top', x: 0, z: -d * 0.1 }), 0, -d * 0.1); l.add(mk(ctx, 0.42));
    } else { const l = add(lamp(ctx, 0.45), 0, -d * 0.12); l.userData.settle = { mode: 'top', x: 0, z: -d * 0.12 }; }
    const b = add(books(ctx, 2, seed, { maxW: 0.22 }), w * 0.12, d * 0.22, 0.3); b.userData.decorPiece = 'books'; b.userData.settle = { mode: 'top', x: w * 0.12, z: d * 0.22 };
  }
  if (t === 'desk' && acc) {
    const l = add(lamp(ctx, 0.42), w / 2 - 0.16, -d / 2 + 0.14); l.userData.settle = { mode: 'top', x: w / 2 - 0.16, z: -d / 2 + 0.14 };
    const b = add(books(ctx, 3, seed, { maxW: 0.24 }), -w / 2 + 0.18, -d / 2 + 0.16, 0.1); b.userData.decorPiece = 'books'; b.userData.settle = { mode: 'top', x: -w / 2 + 0.18, z: -d / 2 + 0.16 };
    if (w > 0.9) { // closed laptop
      const lp = piece('laptop', { mode: 'top', x: -0.05, z: 0.04 }); const m = mesh(new THREE.BoxGeometry(0.32, 0.016, 0.22), ctx.plain('#9a9b9d', 0.35, 0.7)); m.position.y = 0.008; lp.add(m); add(lp, -0.05, 0.04, 0.08);
    }
  }
  if (t === 'dining_table' && acc && ctx.opt.diningDecor === 'candles') {
    const c = add(piece('candles', { mode: 'top', x: 0, z: 0 })); c.add(candlesticks(ctx));
  } else if (t === 'dining_table' && acc) {
    const v = add(vase(ctx, 'round', ctx.M.pot?.userData.baseColor || '#ddd', 0.22)); v.userData.settle = { mode: 'top', x: 0, z: 0 };
    const br = branches(ctx, 0.45, seed); br.position.y = 0.16; v.add(br);
  }
  if (t === 'dining_table' && acc && ctx.opt.lived !== false) { // two cups on the table, as if someone just got up
    const jr = TX.rng(seed * 3 + 9); const R = Math.min(w, d) / 2;
    for (const [a, k] of [[0.6 + jr() * 0.5, 0], [2.6 + jr() * 0.7, 1]]) {
      const x = Math.cos(a) * R * 0.55, z = Math.sin(a) * R * 0.55;
      const c = add(piece('mug', { mode: 'top', x, z }), x, z, jr() * 6.28); c.add(mug(ctx, k ? (ctx.opt.mugColor || '#eee9e1') : '#d8cfc2'));
    }
  }
  if ((t === 'tv_cabinet' || t === 'sideboard') && acc) {
    const L = Math.min(w / 2 - 0.22, 0.8);
    const v = add(vase(ctx, 'tall', ctx.pal[3] || ctx.pal[0], 0.32), L, -d * 0.1); v.userData.settle = { mode: 'top', x: L, z: -d * 0.1 };
    if (t === 'sideboard') { const br = branches(ctx, 0.35, seed); br.position.y = 0.26; v.add(br); }
    const b = add(books(ctx, 2, seed, { maxW: 0.26 }), -L, 0, -0.1); b.userData.decorPiece = 'books'; b.userData.settle = { mode: 'top', x: -L, z: 0 };
    if (t === 'sideboard' && !(env.wall && !env.artNear)) { // no wall art above → a small frame leaning on the top
      const a = art(ctx, 0.42, 0.52, seed + 7, 'lines'); const p = piece('art', { mode: 'top', x: -L + 0.32, z: -d / 2 + 0.06 }); a.position.y = 0.26; a.rotation.x = -0.1; p.add(a); add(p, -L + 0.32, -d / 2 + 0.06);
    }
  }
  // the TV belongs to the cabinet, not to the accessories (stays when they are off, survives the model swap)
  if (t === 'tv_cabinet' && it.tv !== false) {
    const tw = Math.min(w * 0.8, 1.45), th = tw * 0.5625;
    const tv = piece('tv', it.wallTv ? null : { mode: 'top', x: 0, z: -0.04 }, { keep: true });
    const scr = ctx.M.screen, frame = ctx.M.metal;
    if (it.wallTv) { const s = mesh(new THREE.BoxGeometry(tw, th, 0.03), scr); s.position.set(0, 1.0 + th / 2, -d / 2 + 0.03); tv.add(s); }
    else {
      const foot = mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2), frame); foot.position.y = 0.01; tv.add(foot);
      const neck = mesh(new THREE.BoxGeometry(0.05, 0.12, 0.03), frame); neck.position.set(0, 0.06, -0.03); tv.add(neck);
      const s = mesh(new THREE.BoxGeometry(tw, th, 0.035), scr); s.position.set(0, 0.08 + th / 2, -0.03); tv.add(s);
    }
    add(tv, 0, it.wallTv ? 0 : -0.04);
  }
  if (t === 'bed') {
    const bedding = hexOf(it.colors?.bedding) || ctx.M.bedding?.userData.baseColor || '#e9e4da';
    const white = ctx.opt.pillowColor || hexOf(ctx.style.materials?.white) || '#f3f1ec';
    // duvet over the lower ~70 % of the mattress, hanging down the sides and the foot
    const duv = piece('duvet', { mode: 'top', x: 0, z: 0, dy: -0.025 }, { keep: true });
    const dl = d * 0.72;
    duv.add(duvet(ctx, bedding, w + 0.06, dl, 0.26, seed));
    add(duv, 0, d / 2 - dl / 2 + 0.03);
    // decor.bedWall: half-height wood panel on the wall behind the bed (床頭半高木牆裙), wider than the bed
    const bwl = ctx.opt.bedWall;
    if (bwl && env.wall) {
      const W = Math.min(env.wall.spanFull ?? env.wall.span, w + 1.3), Hh = (bwl.height || 110) / 100;
      const pm = bwl.color ? ctx.plain(bwl.color, 0.6) : (ctx.M[bwl.role || 'wood'] || ctx.M.wood);
      const panel = piece('bedWall', null, { keep: true });
      const pb = mesh(boxGeo(W, Hh, 0.025), pm); pb.position.set(0, Hh / 2, 0.0125); panel.add(pb); // UVs in metres → real grain scale
      const cap = mesh(boxGeo(W, 0.02, 0.06), pm); cap.position.set(0, Hh + 0.01, 0.03); panel.add(cap); // shelf ledge on top
      add(panel, 0, -env.wall.dist + 0.001);
    }
    // sleeping pillows, unless the model already has them
    if (!env.modelHasPillows) {
      const pw = Math.min(0.66, (w - 0.16) / 2), xs = w > 1.3 ? [-1, 1] : [0];
      for (const sx of xs) {
        const jb = TX.rng(seed * 13 + sx + 2); const lv = ctx.opt.lived !== false;
        const p = piece('sleepPillow', { mode: 'top', x: sx * (pw / 2 + 0.03), z: -d / 2 + 0.3, dy: -0.01, tilt: -0.22 - (lv ? jb() * 0.1 : 0), jy: lv ? (jb() - 0.5) * 0.12 : 0, jz: lv ? (jb() - 0.5) * 0.06 : 0 }, { keep: true });
        const m = rbox(pw, 0.12, 0.42, 0.045, ctx.fabric(white)); m.scale.y = 0.9; m.position.y = 0.055; p.add(m);
        add(p, sx * (pw / 2 + 0.03), -d / 2 + 0.3);
      }
    }
    if (acc) {
      const [a0, a1] = ctx.softFor(bedding, 2, 1);
      for (const sx of w > 1.3 ? [-1, 1] : [0]) {
        const x = sx * Math.min(0.32, w / 4);
        const jb = TX.rng(seed * 17 + sx); const lv = ctx.opt.lived !== false;
        add(pillow(ctx, a0, { w: 0.45 }), x, -d / 2 + 0.5).userData.settle = { mode: 'top', x, z: -d / 2 + 0.5, dy: -0.04, tilt: -0.45 - (lv ? jb() * 0.15 : 0), jy: lv ? (jb() - 0.5) * 0.25 : 0, jz: lv ? (jb() - 0.5) * 0.12 : 0 };
      }
      add(pillow(ctx, a1, { w: 0.5, lumbar: true }), 0, -d / 2 + 0.62).userData.settle = { mode: 'top', x: 0, z: -d / 2 + 0.62, dy: -0.03, tilt: -0.35 };
      // slippers on the floor beside the bed (env.bedFree: +1 / -1 = side with more room; default right)
      if (ctx.opt.lived !== false && env.roomType === 'bedroom' && env.bedFree) {
        const js = TX.rng(seed * 19 + 4); const sx = env.bedFree;
        const sl = add(piece('slippers', null), sx * (w / 2 + 0.2), -d / 2 + d * (0.45 + js() * 0.15), sx * (Math.PI / 2 + (js() - 0.5) * 0.5));
        sl.add(slippers(ctx, ctx.softFor(bedding, 1, 1)[0], seed));
      }
      // bed-end runner across the foot third (decor.bedRunner: false = none)
      if (ctx.opt.bedRunner !== false) {
      // bedRunner: true/'runner' = 50 cm band · 'throw' = big knit throw over the foot half · 'diagonal' = throw tossed across a corner
      const kind = ctx.opt.bedRunner === true || ctx.opt.bedRunner == null ? 'runner' : ctx.opt.bedRunner;
      const rd = kind === 'runner' ? 0.5 : 0.85, rz = d / 2 - rd / 2 - 0.1;
      const run = piece('runner', { mode: 'top', x: 0, z: rz, dy: 0.055 }); // on top of the duvet (decor is not ray-cast)
      const rc = ctx.opt.throwColor || ctx.softFor(bedding, 1, 0)[0];
      const rm = kind === 'runner' ? ctx.fabric(rc).clone() : knitMat(ctx, rc); rm.side = THREE.DoubleSide;
      if (kind !== 'diagonal') { // a band across the bed, both ends draped down the sides (cloth: drape over each side edge)
        const half = (w + 0.02) / 2;
        for (const s of [-1, 1]) { const dr = drape(rm, rd, half, 0.26, seed + (s > 0 ? 5 : 9), { amp: 0.03, r: 0.035 }); dr.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2; dr.position.set(s * half, 0.012, 0); run.add(dr); } // local +z (the hanging side) → outwards
      } else { // tossed across the foot corner: flat on the bed, one corner draped over the foot edge
        const dr = drape(rm, rd, w * 0.55, 0.3, seed + 4, { amp: 0.035, r: 0.035 }); dr.position.set(w * 0.2, 0.012, rd / 2 + 0.1); run.add(dr); // edge on the bed foot
      }
      const rr = add(run, kind === 'diagonal' ? w * 0.08 : 0, rz, kind === 'diagonal' ? -0.42 : 0);
      if (kind === 'diagonal') rr.userData.settle.x = w * 0.08;
      }
    }
  }
  // wall art above sofa / bed / sideboard
  const wallMode = t === 'sofa' ? (ctx.opt.sofaWall || 'art') : t === 'bed' ? (ctx.opt.bedWallArt || 'art') : 'art';
  const artRoom = ['living', 'bedroom', 'dining', 'study'].includes(env.roomType);
  if (acc && env.wall && artRoom && ['sofa', 'bed'].includes(t) && wallMode === 'sconce') {
    const sc = piece('sconce', null); const s1 = discSconce(ctx); s1.position.y = Math.min(1.75, env.ceiling - 0.5); sc.add(s1);
    add(sc, Math.min(env.wall.span / 2 - 0.25, w * 0.18), -env.wall.dist + 0.001);
  } else if (acc && env.wall && artRoom && ['sofa', 'bed'].includes(t) && wallMode === 'small' && !env.artNear) {
    // one small dark textured piece, off-centre (侘寂: quiet, not a big statement)
    const p = piece('wallArt', { mode: 'above', minCenter: 1.5, gap: 0.3, ceiling: env.ceiling, h: 0.52 });
    p.add(art(ctx, 0.42, 0.52, seed + 2, ctx.opt.artKind || 'texture'));
    add(p, Math.min(env.wall.span / 2 - 0.3, w * 0.25), -env.wall.dist + 0.002);
  } else if (acc && wallMode === 'art' && env.wall && !env.artNear && ['sofa', 'bed', 'sideboard'].includes(t) && artRoom) {
    const span = Math.min(env.wall.span, w);
    const total = Math.min(span * 0.66, t === 'sideboard' ? 1.0 : 1.5);
    if (total >= 0.45) {
      const p = piece('wallArt', { mode: 'above', minCenter: 1.45, gap: t === 'bed' ? 0.25 : 0.2, ceiling: env.ceiling });
      let h;
      if (t === 'sofa' && total > 0.9) { // diptych: two portrait frames
        const fw = (total - 0.06) / 2; h = Math.min(fw * 1.3, 0.95);
        for (const s of [-1, 1]) { const a = art(ctx, fw, h, seed + (s > 0 ? 3 : 0), ctx.opt.artKind || 'shapes'); a.position.x = s * (fw / 2 + 0.03); p.add(a); }
      } else { h = Math.min(total * 0.7, 0.8); p.add(art(ctx, total, h, seed + 1, ctx.opt.artKind || (t === 'bed' ? 'lines' : 'shapes'))); }
      p.userData.settle.h = h;
      add(p, 0, -env.wall.dist + 0.002);
    }
  }
}

// ---------- settle on the actual furniture surface ----------
const rc = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
function isDecor(o, root) { for (let p = o; p && p !== root; p = p.parent) if (p.userData.decorPiece) return true; return false; }
function solidMeshes(furn) { const out = []; furn.traverse((o) => { if (o.isMesh && !isDecor(o, furn) && !o.userData.noSettle) out.push(o); }); return out; }
function surfaceY(furn, meshes, x, z) {
  const o = furn.localToWorld(new THREE.Vector3(x, 4, z));
  rc.set(o, DOWN); rc.near = 0; rc.far = 6;
  const hit = rc.intersectObjects(meshes, false)[0];
  return hit ? furn.worldToLocal(hit.point.clone()).y : null;
}
function backZ(furn, meshes, x, y, zFrom) {
  const o = furn.localToWorld(new THREE.Vector3(x, y, zFrom));
  const dir = new THREE.Vector3(0, 0, -1).transformDirection(furn.matrixWorld);
  rc.set(o, dir); rc.near = 0; rc.far = 4;
  const hit = rc.intersectObjects(meshes, false)[0];
  return hit ? furn.worldToLocal(hit.point.clone()).z : null;
}
function topOf(furn, meshes) {
  const inv = new THREE.Matrix4().copy(furn.matrixWorld).invert(); let top = 0; const b = new THREE.Box3();
  for (const m of meshes) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); b.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld).applyMatrix4(inv); top = Math.max(top, b.max.y); }
  return top;
}

/** put every accessory of one furniture group on its real surface (call after the model swap, too) */
export function settleDecor(furn) {
  const pieces = furn.children.filter((c) => c.userData.decorPiece && c.userData.settle);
  if (!pieces.length) return;
  furn.updateWorldMatrix(true, true);
  const meshes = solidMeshes(furn);
  let top = null;
  for (const p of pieces) {
    const s = p.userData.settle;
    if (s.mode === 'top') {
      const y = surfaceY(furn, meshes, s.x, s.z);
      p.visible = y != null;
      if (y != null) p.position.y = y + (s.dy || 0);
      if (s.tilt) p.rotation.x = s.tilt;
      if (s.jy || s.jz) { p.userData.baseRy ??= p.rotation.y; p.rotation.y = p.userData.baseRy + (s.jy || 0); p.rotation.z = s.jz || 0; }
    } else if (s.mode === 'lean') {
      const y = surfaceY(furn, meshes, s.x, s.zProbe);
      if (y == null) { p.visible = false; continue; }
      p.visible = true;
      const bz = backZ(furn, meshes, s.x, y + 0.22, 2);
      p.position.y = y - (s.sink || 0);
      if (bz != null) p.position.z = Math.min(bz + s.t / 2 + 0.03, s.zProbe + 0.1);
      p.rotation.x = s.tilt || 0; p.rotation.y = s.jy || 0; p.rotation.z = s.jz || 0;
    } else if (s.mode === 'above') {
      if (top == null) top = topOf(furn, meshes);
      let c = Math.max(s.minCenter, top + s.gap + s.h / 2);
      if (s.ceiling) c = Math.min(c, s.ceiling - 0.25 - s.h / 2);
      p.position.y = c;
    }
  }
}

/** real lamp models: light-coloured meshes in the upper part are the shade → they glow at night (see main.js) */
function markShades(inst) {
  inst.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(inst), H = box.max.y - box.min.y || 1, b = new THREE.Box3();
  inst.traverse((o) => {
    if (!o.isMesh) return;
    b.setFromObject(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if ((b.min.y + b.max.y) / 2 < box.min.y + H * 0.55) return;
    o.material = mats.map((m) => {
      const c = m.color || new THREE.Color(1, 1, 1); if (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.35) return m;
      const g = m.clone(); g.emissive = new THREE.Color('#ffd2a0'); g.emissiveMap = m.map || null; g.emissiveIntensity = 0.8; g.userData.isLampshade = true; g.userData.emissiveBase = 0.8; return g;
    });
    if (o.material.length === 1) o.material = o.material[0];
  });
}
/** swap accessory placeholders for real models (async, cached); re-settles each piece on arrival */
export function loadDecorModels(root, isCurrent = () => true) {
  const jobs = [];
  root.traverse((p) => {
    const m = p.userData.decorPiece && p.userData.model;
    if (!m || p.userData.modelLoaded) return;
    jobs.push((async () => {
      const inst = await modelInstance(m.id, { ...m.fit, tint: m.tint ? new THREE.Color(m.tint) : null });
      if (!isCurrent()) return;
      for (const c of [...p.children]) if (c.userData.ph) { p.remove(c); c.geometry?.dispose(); }
      inst.traverse((o) => { o.userData.noSettle = true; });
      if (['lamp', 'floorLamp'].includes(p.userData.decorPiece)) markShades(inst);
      p.add(inst); p.userData.modelLoaded = true;
    })().catch(() => {}));
  });
  return Promise.all(jobs);
}
