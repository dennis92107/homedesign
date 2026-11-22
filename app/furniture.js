// Procedural furniture library. Units: metres. Each builder returns a Group whose origin is the
// centre of the footprint at floor level; the "front" of the piece faces local +Z, back is -Z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as TX from './textures.js';

// ---------- geometry helpers ----------
function worldUV(geo, w, h, d) {
  // BoxGeometry face order: px nx py ny pz nz (4 verts each). Scale UVs to metres.
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const per = uv.count / 6;
  for (let f = 0; f < 6; f++) for (let i = 0; i < per; i++) {
    const k = f * per + i;
    uv.setXY(k, uv.getX(k) * dims[f][0], uv.getY(k) * dims[f][1]);
  }
  return geo;
}
export function boxGeo(w, h, d) { return worldUV(new THREE.BoxGeometry(w, h, d), w, h, d); }

function mesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
/** box with its BOTTOM at y */
export function B(g, w, h, d, mat, x = 0, y = 0, z = 0, ry = 0) {
  const m = mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y + h / 2, z); m.rotation.y = ry; g.add(m); return m;
}
function R(g, w, h, d, r, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const m = mesh(new RoundedBoxGeometry(w, h, d, 3, Math.max(0.002, r)), mat);
  m.position.set(x, y + h / 2, z); m.rotation.set(rx, ry, rz); g.add(m); return m;
}
function C(g, rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 24) {
  const m = mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y + h / 2, z); g.add(m); return m;
}
function S(g, r, mat, x, y, z, sx = 1, sy = 1, sz = 1, detail = 2) {
  const m = mesh(new THREE.IcosahedronGeometry(r, detail), mat);
  m.position.set(x, y, z); m.scale.set(sx, sy, sz); g.add(m); return m;
}

function legs(g, w, d, h, M, kind = 'tapered', inset = 0.05) {
  const xs = [-w / 2 + inset, w / 2 - inset]; const zs = [-d / 2 + inset, d / 2 - inset];
  if (kind === 'none') return;
  if (kind === 'plinth') { B(g, w - inset * 2.5, h, d - inset * 2.5, M.woodDark); return; }
  for (const x of xs) for (const z of zs) {
    if (kind === 'metal') B(g, 0.025, h, 0.025, M.metal, x, 0, z);
    else if (kind === 'hairpin') { C(g, 0.006, 0.006, h, M.metal, x - 0.02, 0, z); C(g, 0.006, 0.006, h, M.metal, x + 0.02, 0, z); }
    else if (kind === 'block') B(g, 0.06, h, 0.06, M.wood, x, 0, z);
    else { // tapered wooden, slightly splayed
      const l = C(g, 0.022, 0.014, h, M.wood, x, 0, z, 12);
      l.rotation.z = Math.sign(x) * -0.08; l.rotation.x = Math.sign(z) * 0.08;
    }
  }
}

// ---------- pieces ----------
const F = {};

F.sofa = (it, M, S_) => {
  const g = new THREE.Group();
  const w = it.w, d = it.d; const rounded = S_.sofa === 'rounded';
  const legH = S_.legs === 'plinth' || S_.legs === 'none' ? 0.08 : 0.14; const legKind = S_.legs || 'tapered';
  const mat = it.leather || S_.sofaMaterial === 'leather' ? M.leather : M.fabric;
  const arm = rounded ? 0.22 : 0.16; const armH = rounded ? 0.55 : 0.62; const baseH = 0.22;
  legs(g, w - 0.1, d - 0.1, legH, M, legKind);
  const r = rounded ? 0.09 : 0.03;
  R(g, w, baseH, d, r, mat, 0, legH);
  R(g, arm, armH - legH, d, rounded ? 0.1 : r, mat, -w / 2 + arm / 2, legH);
  R(g, arm, armH - legH, d, rounded ? 0.1 : r, mat, w / 2 - arm / 2, legH);
  R(g, w - arm * 2, 0.82 - legH, 0.2, r, mat, 0, legH, -d / 2 + 0.1);
  const inner = w - arm * 2; const n = it.seats || (inner > 1.7 ? 3 : 2); const cw = inner / n;
  for (let i = 0; i < n; i++) {
    const x = -inner / 2 + cw * (i + 0.5);
    R(g, cw - 0.01, 0.16, d - 0.24, rounded ? 0.07 : 0.04, mat, x, legH + baseH, 0.1);
    const back = R(g, cw - 0.02, 0.42, 0.16, rounded ? 0.07 : 0.04, mat, x, legH + baseH + 0.08, -d / 2 + 0.24);
    back.rotation.x = -0.12;
  }
  if (it.chaise) R(g, cw, 0.16, 0.9, 0.05, mat, (it.chaise === 'left' ? -1 : 1) * (inner / 2 - cw / 2), legH + baseH, d / 2 + 0.3);
  return g; // throw pillows / throw: decor.js
};

F.armchair = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 0.8, d = it.d || 0.8;
  const mat = it.leather ? M.leather : M.fabricAlt;
  legs(g, w - 0.1, d - 0.1, 0.16, M, S_.legs || 'tapered');
  R(g, w, 0.24, d, 0.05, mat, 0, 0.16);
  R(g, 0.12, 0.3, d, 0.05, mat, -w / 2 + 0.06, 0.4); R(g, 0.12, 0.3, d, 0.05, mat, w / 2 - 0.06, 0.4);
  const b = R(g, w, 0.55, 0.16, 0.06, mat, 0, 0.36, -d / 2 + 0.08); b.rotation.x = -0.15;
  R(g, w - 0.26, 0.12, d - 0.2, 0.05, mat, 0, 0.4, 0.06);
  return g;
};

F.coffee_table = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.1, d = it.d || 0.6, h = it.h || 0.4;
  const top = S_.tableTop === 'stone' ? M.stone : S_.tableTop === 'glass' ? (M.glassClear || M.glass) : M.wood;
  if (it.shape === 'round') {
    C(g, w / 2, w / 2, 0.03, top, 0, h - 0.03, 0, 48);
    C(g, w / 2 - 0.08, w / 2 - 0.08, h - 0.03, S_.legs === 'metal' ? M.metal : M.woodDark, 0, 0, 0, 48);
  } else {
    B(g, w, 0.035, d, top, 0, h - 0.035);
    legs(g, w, d, h - 0.035, M, S_.legs === 'plinth' ? 'block' : (S_.legs || 'tapered'), 0.06);
    B(g, w - 0.12, 0.02, d - 0.12, M.wood, 0, 0.12);
  }
  return g; // books / tray / vase: decor.js
};

F.side_table = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 0.45; const h = it.h || 0.55;
  C(g, w / 2, w / 2, 0.025, S_.tableTop === 'stone' ? M.stone : M.wood, 0, h - 0.025, 0, 32);
  C(g, 0.02, 0.02, h - 0.025, M.metal, 0, 0, 0, 12); C(g, w / 3, w / 3, 0.02, M.metal, 0, 0, 0, 24);
  return g;
};

F.tv_cabinet = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.8, d = it.d || 0.42, h = it.h || 0.45;
  const legH = S_.legs === 'plinth' || S_.legs === 'none' ? 0.04 : 0.12;
  legs(g, w, d, legH, M, S_.legs === 'none' ? 'plinth' : (S_.legs || 'tapered'));
  B(g, w, h - legH, d, M.wood, 0, legH);
  const n = Math.max(2, Math.round(w / 0.6));
  for (let i = 1; i < n; i++) B(g, 0.006, h - legH - 0.04, 0.005, M.woodDark, -w / 2 + (w / n) * i, legH + 0.02, d / 2);
  return g; // TV + vase / books: decor.js (the TV stays when accessories are off)
};

F.sideboard = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.6, d = it.d || 0.45, h = it.h || 0.8;
  const legH = S_.legs === 'plinth' || S_.legs === 'none' ? 0.05 : 0.16;
  legs(g, w, d, legH, M, S_.legs === 'none' ? 'plinth' : (S_.legs || 'tapered'));
  B(g, w, h - legH, d, M.wood, 0, legH);
  const n = Math.max(2, Math.round(w / 0.5));
  for (let i = 1; i < n; i++) B(g, 0.006, h - legH - 0.04, 0.005, M.woodDark, -w / 2 + (w / n) * i, legH + 0.02, d / 2);
  return g; // vase / books / art: decor.js
};

function chair(M, S_, kind) {
  const g = new THREE.Group(); kind = kind || S_.chair || 'spindle';
  const seatH = 0.45; const w = 0.46, d = 0.48;
  legs(g, w, d, seatH - 0.04, M, S_.legs === 'metal' ? 'metal' : 'tapered', 0.03);
  if (kind === 'upholstered') {
    R(g, w, 0.08, d, 0.03, M.fabric, 0, seatH - 0.04);
    const b = R(g, w, 0.5, 0.07, 0.03, M.fabric, 0, seatH + 0.02, -d / 2 + 0.04); b.rotation.x = -0.08;
  } else if (kind === 'solid') {
    B(g, w, 0.04, d, M.wood, 0, seatH - 0.04);
    const b = B(g, w, 0.4, 0.025, M.wood, 0, seatH + 0.04, -d / 2 + 0.02); b.rotation.x = -0.08;
  } else {
    B(g, w, 0.035, d, M.wood, 0, seatH - 0.04);
    for (let i = 0; i < 5; i++) C(g, 0.008, 0.008, 0.36, M.wood, -w / 2 + 0.05 + i * ((w - 0.1) / 4), seatH, -d / 2 + 0.03, 8);
    B(g, w, 0.06, 0.03, M.wood, 0, seatH + 0.34, -d / 2 + 0.03);
  }
  return g;
}
F.chair = (it, M, S_) => chair(M, S_, it.style);

F.dining_table = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.6, d = it.d || 0.9, h = 0.75;
  const top = S_.tableTop === 'stone' ? M.stone : S_.tableTop === 'glass' ? (M.glassClear || M.glass) : M.wood;
  if (it.shape === 'round') {
    C(g, w / 2, w / 2, 0.04, top, 0, h - 0.04, 0, 48); C(g, 0.06, 0.08, h - 0.04, M.woodDark, 0, 0, 0); C(g, 0.3, 0.3, 0.03, M.woodDark, 0, 0, 0);
  } else {
    B(g, w, 0.04, d, top, 0, h - 0.04);
    legs(g, w, d, h - 0.04, M, S_.legs === 'plinth' ? 'block' : (S_.legs || 'tapered'), 0.08);
  }
  const seats = it.seats ?? 4; const perSide = Math.ceil(seats / 2);
  for (let s = 0; s < 2; s++) for (let i = 0; i < perSide && s * perSide + i < seats; i++) {
    const c = chair(M, S_, it.chairStyle);
    c.userData.slot = { type: 'chair', w: 0.46, d: 0.52, h: 0.9 };
    const x = -w / 2 + (w / perSide) * (i + 0.5);
    c.position.set(x, 0, (s ? -1 : 1) * (d / 2 + 0.12)); c.rotation.y = s ? 0 : Math.PI;
    g.add(c);
  }
  return g; // centrepiece: decor.js
};

F.bed = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.8, d = it.d || 2.1; const kind = S_.bed || 'legs';
  const frameH = kind === 'platform' ? 0.22 : 0.32;
  const frameMat = kind === 'upholstered' ? M.fabric : M.wood;
  if (kind === 'legs') { legs(g, w, d, 0.14, M, S_.legs === 'metal' ? 'metal' : 'block', 0.06); B(g, w, frameH - 0.14, d, frameMat, 0, 0.14); }
  else if (kind === 'platform') { B(g, w + 0.2, 0.06, d + 0.15, M.wood, 0, 0, 0.07); B(g, w - 0.1, frameH - 0.06, d - 0.1, M.woodDark, 0, 0.0); }
  else R(g, w + 0.06, frameH, d, 0.03, frameMat, 0, 0);
  R(g, w - 0.04, 0.22, d - 0.08, 0.06, M.mattress, 0, frameH, 0.02);
  // duvet, pillows, accent pillows, bed-end runner: decor.js
  // headboard
  if (kind === 'upholstered') R(g, w + 0.1, 1.1, 0.1, 0.04, M.fabric, 0, 0, -d / 2 - 0.05);
  else if (kind === 'platform') B(g, w + 0.2, 0.9, 0.05, M.wood, 0, 0, -d / 2 - 0.02);
  else { B(g, w + 0.06, 1.0, 0.05, M.wood, 0, 0, -d / 2 - 0.02); R(g, w - 0.1, 0.5, 0.05, 0.02, M.fabric, 0, 0.5, -d / 2 + 0.02); }
  return g;
};

F.nightstand = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 0.48, d = it.d || 0.4, h = it.h || 0.5;
  const legH = S_.legs === 'plinth' || S_.legs === 'none' ? 0 : 0.12;
  if (legH) legs(g, w, d, legH, M, S_.legs || 'tapered', 0.04);
  B(g, w, h - legH, d, M.wood, 0, legH);
  B(g, w - 0.06, 0.006, 0.004, M.woodDark, 0, legH + (h - legH) / 2, d / 2);
  return g; // table lamp: decor.js
};

F.wardrobe = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 2, d = it.d || 0.6, h = it.h || 2.3;
  B(g, w, 0.08, d - 0.03, M.woodDark, 0, 0, -0.015);
  B(g, w, h - 0.08, d, M.cabinet, 0, 0.08);
  const n = Math.max(2, Math.round(w / 0.5));
  for (let i = 1; i < n; i++) B(g, 0.004, h - 0.1, 0.004, M.woodDark, -w / 2 + (w / n) * i, 0.09, d / 2);
  if (S_.handles !== 'none') for (let i = 0; i < n; i++) if (i % 2 === 0 || i === n - 1) {
    const x = -w / 2 + (w / n) * (i + (i % 2 ? 0.1 : 0.9));
    B(g, 0.015, 0.3, 0.02, M.metal, x, 1.0, d / 2 + 0.01);
  }
  return g;
};

F.desk = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.2, d = it.d || 0.6, h = 0.75;
  B(g, w, 0.03, d, M.wood, 0, h - 0.03);
  legs(g, w, d, h - 0.03, M, S_.legs === 'plinth' ? 'block' : (S_.legs || 'metal'), 0.04);
  // lamp / books / laptop: decor.js · the chair is a slot like the dining chairs (gets the default chair model)
  // chairs: n seats spread along the desk (a long desk shared by two people)
  const nc = it.chair === false ? 0 : Math.max(1, it.chairs || 1);
  for (let i = 0; i < nc; i++) { const c = chair(M, S_, it.chairStyle || 'upholstered'); c.userData.slot = { type: 'chair', w: 0.46, d: 0.52, h: 0.9, style: it.chairStyle || 'upholstered' }; c.position.set(-w / 2 + (w / nc) * (i + 0.5), 0, d / 2 + 0.05); c.rotation.y = Math.PI; g.add(c); }
  return g;
};

F.bookshelf = (it, M, S_, ctx) => {
  const g = new THREE.Group(); const w = it.w || 1, d = it.d || 0.35, h = it.h || 2;
  const t = 0.025; const shelves = Math.max(3, Math.round(h / 0.38));
  B(g, t, h, d, M.wood, -w / 2 + t / 2); B(g, t, h, d, M.wood, w / 2 - t / 2); B(g, w, h, 0.01, M.wood, 0, 0, -d / 2 + 0.005);
  const r = TX.rng(Math.round((it.x || 1) * 13 + (it.y || 1) * 7));
  const bookMats = ctx.bookMats;
  for (let s = 0; s <= shelves; s++) {
    const y = (h - t) * (s / shelves); B(g, w, t, d, M.wood, 0, y);
    if (s === shelves) break;
    let x = -w / 2 + t + 0.02; const lim = w / 2 - t - 0.02 - r() * w * 0.35;
    while (x < lim) {
      const bw = 0.02 + r() * 0.035; const bh = 0.2 + r() * 0.1;
      B(g, bw, bh, d * 0.75, bookMats[Math.floor(r() * bookMats.length)], x + bw / 2, y + t, 0.01);
      x += bw + 0.002;
    }
    if (r() < 0.5) C(g, 0.05, 0.04, 0.14, M.pot, w / 2 - 0.12, y + t, 0);
  }
  return g;
};

F.kitchen_counter = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 3, d = it.d || 0.6;
  B(g, w, 0.1, d - 0.06, M.dark, 0, 0, -0.03);
  B(g, w, 0.76, d - 0.02, M.cabinet, 0, 0.1, -0.01);
  const n = Math.max(2, Math.round(w / 0.6));
  for (let i = 1; i < n; i++) B(g, 0.004, 0.72, 0.004, M.woodDark, -w / 2 + (w / n) * i, 0.12, d / 2 - 0.01);
  B(g, w, 0.04, d + 0.02, M.countertop, 0, 0.86, 0.01);
  // sink + tap
  const sx = it.sinkAt != null ? it.sinkAt : -w * 0.2;
  B(g, 0.6, 0.005, 0.42, M.metal, sx, 0.9, 0.02); B(g, 0.54, 0.006, 0.36, M.dark, sx, 0.903, 0.02);
  C(g, 0.012, 0.012, 0.3, M.metal, sx, 0.9, -d / 2 + 0.08, 8); B(g, 0.02, 0.02, 0.18, M.metal, sx, 1.18, -d / 2 + 0.16);
  // cooktop
  const cx = it.cooktopAt != null ? it.cooktopAt : w * 0.25;
  B(g, 0.6, 0.008, 0.5, M.screen, cx, 0.9, 0);
  for (const [ox, oz] of [[-0.14, -0.1], [0.14, -0.1], [-0.14, 0.12], [0.14, 0.12]]) C(g, 0.08, 0.08, 0.002, M.metal, cx + ox, 0.909, oz, 24);
  if (it.upper !== false) {
    B(g, w, 0.7, 0.35, M.cabinet, 0, 1.5, -d / 2 + 0.175);
    for (let i = 1; i < n; i++) B(g, 0.004, 0.68, 0.004, M.woodDark, -w / 2 + (w / n) * i, 1.51, -d / 2 + 0.35);
    B(g, 0.6, 0.12, 0.49, M.metal, cx, 1.38, -d / 2 + 0.011 + 0.245); // hood (in front of the backsplash, not sharing its back plane)
    B(g, w, 0.599, 0.01, M.white, 0, 0.9, -d / 2 + 0.005); // backsplash (1 mm under the upper cabinets)
  }
  return g;
};

F.island = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.8, d = it.d || 0.9;
  B(g, w - 0.1, 0.86, d - 0.25, M.cabinet, 0, 0, -0.1);
  B(g, w, 0.04, d, M.countertop, 0, 0.86);
  for (let i = 0; i < (it.stools ?? 2); i++) {
    const x = -w / 2 + (w / (it.stools ?? 2)) * (i + 0.5);
    C(g, 0.17, 0.17, 0.05, M.wood, x, 0.62, d / 2 + 0.05); C(g, 0.015, 0.015, 0.62, M.metal, x, 0, d / 2 + 0.05, 8); C(g, 0.18, 0.18, 0.015, M.metal, x, 0, d / 2 + 0.05);
  }
  return g;
};

F.fridge = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 0.75, d = it.d || 0.7, h = it.h || 1.85;
  const mat = it.color === 'white' ? M.white : new THREE.MeshStandardMaterial({ color: 0xc9cbcc, metalness: 0.7, roughness: 0.3 });
  B(g, w, h, d, mat, 0, 0);
  B(g, w - 0.02, 0.006, 0.004, M.dark, 0, h * 0.65, d / 2);
  B(g, 0.02, 0.5, 0.04, M.metal, w / 2 - 0.06, h * 0.68, d / 2 + 0.02); B(g, 0.02, 0.4, 0.04, M.metal, w / 2 - 0.06, h * 0.2, d / 2 + 0.02);
  return g;
};

F.toilet = (it, M) => {
  const g = new THREE.Group();
  C(g, 0.13, 0.16, 0.38, M.ceramic, 0, 0, 0.05, 24).scale.z = 1.3;
  C(g, 0.19, 0.19, 0.04, M.ceramic, 0, 0.38, 0.08, 32).scale.z = 1.25;
  B(g, 0.4, 0.38, 0.18, M.ceramic, 0, 0.4, -0.24);
  B(g, 0.06, 0.015, 0.03, M.metal, 0.1, 0.78, -0.17);
  return g;
};

F.vanity = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 0.9, d = it.d || 0.5;
  B(g, w, 0.45, d, M.wood, 0, 0.35);
  if (it.basin === 'undermount') { // white solid-surface top with the basin sunk in (Taiwan builder standard)
    B(g, w, 0.03, d, M.countertop, 0, 0.8);
    const bw = Math.min(0.46, w * 0.7) / 2, bd = Math.min(0.34, d * 0.7) / 2;
    // stacked discs, each top 1 mm above the one below (coplanar tops flicker)
    const ell = C(g, 1, 1, 0.004, M.ceramic, 0, 0.8295, 0.02, 48); ell.scale.set(bw, 1, bd); // basin rim, top 0.8335
    const pit = C(g, 1, 1, 0.004, new THREE.MeshStandardMaterial({ color: 0xd9d9d6, roughness: 0.2 }), 0, 0.8305, 0.02, 48); pit.scale.set(bw * 0.88, 1, bd * 0.85); // basin bowl in shade, top 0.8345
    C(g, 0.018, 0.018, 0.004, M.metal, 0, 0.8315, 0.04, 16); // drain, top 0.8355
    B(g, w, 0.003, 0.02, M.countertop, 0, 0.83, d / 2 - 0.01); // front edge lip
  } else {
    B(g, w, 0.02, d, M.countertop, 0, 0.8);
    C(g, 0.2, 0.15, 0.13, M.ceramic, 0, 0.82, 0.02, 32);
    C(g, 0.17, 0.17, 0.006, M.dark, 0, 0.945, 0.02, 32);
  }
  C(g, 0.01, 0.01, 0.22, M.metal, 0, 0.82, -d / 2 + 0.06, 8); B(g, 0.02, 0.02, 0.13, M.metal, 0, 1.03, -d / 2 + 0.12);
  B(g, w * 0.9, 0.8, 0.02, M.mirror, 0, 1.15, -d / 2 + 0.01);
  return g;
};

F.bathtub = (it, M) => {
  const g = new THREE.Group(); const w = it.w || 1.7, d = it.d || 0.75, h = 0.56, t = 0.07;
  B(g, w, 0.06, d, M.ceramic); // base
  B(g, t, h, d, M.ceramic, -w / 2 + t / 2); B(g, t, h, d, M.ceramic, w / 2 - t / 2);
  B(g, w, h, t, M.ceramic, 0, 0, -d / 2 + t / 2); B(g, w, h, t, M.ceramic, 0, 0, d / 2 - t / 2);
  B(g, w - 2 * t, 0.002, d - 2 * t, new THREE.MeshStandardMaterial({ color: 0xbfe0ea, transparent: true, opacity: 0.6, roughness: 0.05 }), 0, 0.32);
  C(g, 0.012, 0.012, 0.25, M.metal, -w / 2 + 0.15, h, -d / 2 + 0.04, 8);
  return g;
};

// tray: false = tiled floor runs through (no raised base); frame: true = thin metal channels on the glass edges
// + a hinged door with a bar handle (Taiwan builder-standard screen)
F.shower = (it, M) => {
  const g = new THREE.Group(); const w = it.w || 0.9, d = it.d || 0.9;
  const base = it.tray === false ? 0 : 0.04, gh = 2.0, glass = M.glassClear || M.glass;
  if (base) B(g, w, base, d, M.ceramic);
  B(g, w, gh, 0.01, glass, 0, base, d / 2);
  if (it.frame) {
    const f = 0.018;
    B(g, f, gh, f, M.metal, -w / 2 + f / 2, base, d / 2); B(g, f, gh, f, M.metal, w / 2 - f / 2, base, d / 2); // wall channels
    B(g, w, 0.012, f, M.metal, 0, base, d / 2); // bottom sill
    B(g, f * 0.8, gh, f, M.metal, 0, base, d / 2); // fixed pane | door
    B(g, 0.03, 0.03, 0.012, M.metal, w * 0.06, base + 1.0, d / 2 + 0.03); B(g, 0.03, 0.03, 0.012, M.metal, w * 0.06, base + 1.45, d / 2 + 0.03);
    C(g, 0.008, 0.008, 0.45, M.metal, w * 0.06, base + 1.0, d / 2 + 0.045, 8); // bar handle
  }
  C(g, 0.012, 0.012, 1.9, M.metal, w / 2 - 0.15, 0, -d / 2 + 0.05, 8); C(g, 0.11, 0.11, 0.015, M.metal, w / 2 - 0.15, 1.95, -d / 2 + 0.17, 24);
  return g;
};

F.plant = (it, M) => {
  const g = new THREE.Group(); const h = it.h || 1.3; const kind = it.kind || 'leafy';
  C(g, 0.17, 0.13, 0.3, M.pot, 0, 0, 0, 24);
  C(g, 0.15, 0.15, 0.02, M.woodDark, 0, 0.285, 0, 24); // soil sits 5 mm above the pot rim (was coplanar → flicker)
  if (kind === 'tall') {
    C(g, 0.012, 0.015, h - 0.3, M.woodDark, 0, 0.3, 0, 6);
    const r = TX.rng(5);
    for (let i = 0; i < 26; i++) {
      const y = 0.55 + r() * (h - 0.6); const a = r() * 6.28; const rr = 0.08 + r() * 0.15;
      const l = S(g, 0.09, M.plant, Math.cos(a) * rr, y, Math.sin(a) * rr, 1, 0.25, 0.7, 0); l.rotation.set(r(), a, r());
    }
  } else {
    const r = TX.rng(9);
    for (let i = 0; i < 9; i++) S(g, 0.18 + r() * 0.1, M.plant, (r() - 0.5) * 0.3, 0.45 + r() * (h - 0.7), (r() - 0.5) * 0.3, 1, 1.2, 1, 1);
  }
  return g;
};

F.floor_lamp = (it, M) => {
  const g = new THREE.Group(); const h = it.h || 1.6;
  C(g, 0.15, 0.15, 0.02, M.metal, 0, 0, 0); C(g, 0.012, 0.012, h - 0.25, M.metal, 0, 0.02, 0, 8);
  const s = C(g, 0.15, 0.22, 0.28, M.lampshade, 0, h - 0.28, 0, 32); s.castShadow = false;
  g.add(lampLight(2.8, { y: h - 0.18 }));
  return g;
};

F.rug = (it, M, S_, ctx) => {
  const g = new THREE.Group(); const w = it.w || 2.4, d = it.d || 1.7;
  // rounded (bound) edge + pile normal map so it reads as a textile, not a painted board (擬真度 ⑧)
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, 0.014, d, 2, 0.006), ctx.rugMat);
  m.position.y = 0.007; m.receiveShadow = true; g.add(m);
  return g;
};

F.art = (it, M, S_, ctx) => {
  const g = new THREE.Group(); const w = it.w || 0.9, h = it.h || 0.6;
  B(g, w + 0.04, h + 0.04, 0.03, M.woodDark, 0, -0.02, 0.015);
  const tex = TX.artCanvas({ palette: ctx.artPalette, seed: Math.round((it.x || 0) + (it.y || 0) * 3), kind: it.kind || 'shapes' });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  p.position.set(0, h / 2, 0.032); g.add(p);
  return g;
};

F.mirror = (it, M) => {
  const g = new THREE.Group(); const w = it.w || 0.6, h = it.h || 1.6;
  B(g, w + 0.04, h + 0.04, 0.03, M.metal, 0, -0.02, 0.015); B(g, w, h, 0.005, M.mirror, 0, 0, 0.032);
  return g;
};

F.shoe_cabinet = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.2, d = it.d || 0.38, h = it.h || 1.0;
  B(g, w, 0.1, d - 0.03, M.woodDark, 0, 0, -0.015); B(g, w, h - 0.1, d, M.cabinet, 0, 0.1);
  const n = Math.max(2, Math.round(w / 0.45));
  for (let i = 1; i < n; i++) B(g, 0.004, h - 0.12, 0.004, M.woodDark, -w / 2 + (w / n) * i, 0.11, d / 2);
  B(g, w + 0.01, 0.025, d + 0.01, M.wood, 0, h);
  C(g, 0.05, 0.04, 0.16, M.pot, w / 2 - 0.15, h + 0.025);
  return g;
};

F.ottoman = (it, M) => {
  const g = new THREE.Group();
  R(g, it.w || 0.6, it.h || 0.42, it.d || 0.6, 0.06, M.fabricAlt);
  return g;
};
F.stool = (it, M) => {
  const g = new THREE.Group(); const h = it.h || 0.65;
  C(g, 0.18, 0.18, 0.05, M.wood, 0, h - 0.05, 0); C(g, 0.015, 0.015, h - 0.05, M.metal, 0, 0, 0, 8); C(g, 0.18, 0.18, 0.015, M.metal);
  return g;
};

F.box = (it, M) => {
  const g = new THREE.Group();
  B(g, it.w || 0.5, it.h || 0.5, it.d || 0.5, M[it.material || 'wood'] || M.wood);
  return g;
};
F.cylinder = (it, M) => {
  const g = new THREE.Group();
  C(g, (it.w || 0.5) / 2, (it.w || 0.5) / 2, it.h || 0.5, M[it.material || 'wood'] || M.wood, 0, 0, 0, 32);
  return g;
};

// pendant lights, hung from the ceiling height
export function pendant(kind, M, ceilingH, dropTo = 1.6, count = 1, spread = 0.6) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const x = count === 1 ? 0 : -spread / 2 + (spread / (count - 1)) * i;
    const cordH = ceilingH - dropTo;
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, cordH, 6), M.metal);
    cord.position.set(x, dropTo + cordH / 2, 0); g.add(cord);
    let shade;
    if (kind === 'cone') { shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.22, 32, 1, true), M.metal); shade.position.set(x, dropTo - 0.05, 0); const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 8), M.lampshade); bulb.position.set(x, dropTo - 0.14, 0); g.add(bulb); }
    else if (kind === 'linear') { shade = new THREE.Mesh(boxGeo(1.2, 0.05, 0.08), M.metal); shade.position.set(0, dropTo - 0.02, 0); const strip = new THREE.Mesh(boxGeo(1.15, 0.005, 0.05), M.lampshade); strip.position.set(0, dropTo - 0.05, 0); g.add(strip); }
    else if (kind === 'saucer') { // flat white "flying saucer" pendant (飛碟吊燈)
      shade = new THREE.Mesh(new THREE.SphereGeometry(0.3, 48, 16), M.white || M.lampshade); shade.scale.y = 0.2; shade.position.set(x, dropTo - 0.02, 0);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.22, 40), M.lampshade); glow.rotation.x = Math.PI / 2; glow.position.set(x, dropTo - 0.081, 0); g.add(glow);
    }
    else if (kind === 'rattan') { shade = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), M.wood); shade.material = M.wood; shade.position.set(x, dropTo - 0.1, 0); shade.rotation.x = Math.PI; const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 8), M.lampshade); bulb.position.set(x, dropTo - 0.08, 0); g.add(bulb); }
    else { shade = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 16), M.lampshade); shade.position.set(x, dropTo - 0.15, 0); }
    shade.material.side = THREE.DoubleSide;
    g.add(shade);
    if (kind === 'linear') break;
  }
  g.add(lampLight(kind === 'linear' ? 4 : count > 1 ? 5 : 3.5, { y: dropTo - (kind === 'linear' ? 0.08 : 0.2) }));
  return g;
}

/**
 * A lamp's real light source (擬真度 ④ 2026-11-22): an invisible point light inside the shade. It is not drawn by the
 * realtime renderer itself — main.js hands the nearest lamps to the realtime light pool, and to the path tracer —
 * and only at night (lighting.room.dayOn = also by day): daylight is far brighter than a bulb, so lamps on in a
 * daytime shot only add noise and odd hot spots (Poliigon, "7 mistakes": https://www.poliigon.com/blog/7-mistakes-arch-viz ).
 * Intensity in the app's light units (room fill ≈ 4, downlight ≈ 9), warm 2700 K.
 */
export function lampLight(intensity, { x = 0, y = 0, z = 0, color = 0xffc98f } = {}) {
  const l = new THREE.PointLight(color, intensity, 0, 2);
  l.position.set(x, y, z); l.visible = false; l.radius = 0.03; l.castShadow = false;
  l.userData = { lamp: true, artificial: true, base: intensity };
  return l;
}

// open display niche: thin metal frame, glass-thin shelves, warm LED strips on the inner sides (e.g. bronze lit shelving)
const _fmat = new Map();
const fmat = (key, make) => { if (!_fmat.has(key)) _fmat.set(key, make()); return _fmat.get(key); };
F.display_shelf = (it, M) => {
  const g = new THREE.Group(); const w = it.w || 0.4, d = it.d || 0.35, h = it.h || 2.4;
  const fc = it.frameColor || '#9a774f', bc = it.backColor || '#5e5044', lc = it.ledColor || '#ffc98a';
  const frame = fmat('f' + fc, () => new THREE.MeshStandardMaterial({ color: fc, metalness: 0.85, roughness: 0.35 }));
  const back = fmat('b' + bc, () => new THREE.MeshStandardMaterial({ color: bc, roughness: 0.65 }));
  const led = fmat('l' + lc, () => new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: lc, emissiveIntensity: 2.4, roughness: 1 }));
  const t = 0.012, n = it.shelves || Math.max(3, Math.round(h / 0.42));
  B(g, t, h, d, frame, -w / 2 + t / 2); B(g, t, h, d, frame, w / 2 - t / 2);
  B(g, w, t, d, frame, 0, 0); B(g, w, t, d, frame, 0, h - t);
  B(g, w - 2 * t, h - 2 * t, 0.01, back, 0, t, -d / 2 + 0.005);
  for (let s = 1; s < n; s++) B(g, w - 2 * t, 0.008, d - 0.02, frame, 0, t + ((h - 2 * t) * s) / n, 0.005);
  for (const sx of [-1, 1]) { const m = B(g, 0.006, h - 2 * t, 0.01, led, sx * (w / 2 - t - 0.004), t, d / 2 - 0.03); m.userData.lightGlow = true; m.castShadow = false; }
  const r = TX.rng(Math.round((it.x || 1) * 31 + (it.y || 1) * 17));
  for (let s = 0; s < n; s++) { // a few objects (vases, books) so it reads as a display niche
    const y = t + ((h - 2 * t) * s) / n + 0.008; if (r() < 0.35) continue;
    if (r() < 0.5) C(g, 0.03 + r() * 0.03, 0.025, 0.1 + r() * 0.12, M.pot, (r() - 0.5) * (w - 0.12), y, -0.02);
    else { const bw = 0.03 + r() * 0.03; B(g, bw, 0.18 + r() * 0.06, d * 0.6, M.woodDark, (r() - 0.5) * (w - 0.15), y, -0.03); }
  }
  return g;
};
// vertical slat panel / slatted door look (格柵)
F.slat_panel = (it) => {
  const g = new THREE.Group(); const w = it.w || 1, h = it.h || 2.6, d = it.d || 0.04;
  const c = it.color || '#1f1e1d';
  const mat = fmat('s' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 }));
  const bmat = fmat('sb' + c, () => new THREE.MeshStandardMaterial({ color: new THREE.Color(c).multiplyScalar(0.6), roughness: 0.8 }));
  const sw = (it.slat || 3) / 100, gap = (it.gap || 1.5) / 100;
  B(g, w, h, 0.01, bmat, 0, 0, -d / 2 + 0.005);
  if (it.dir === 'h') { // horizontal louvres (百葉)
    const n = Math.max(1, Math.floor((h + gap) / (sw + gap)));
    for (let i = 0; i < n; i++) B(g, w, sw, d - 0.012, mat, 0, i * (sw + gap), 0.006);
    return g;
  }
  const n = Math.max(1, Math.floor((w + gap) / (sw + gap))); const used = n * sw + (n - 1) * gap;
  for (let i = 0; i < n; i++) B(g, sw, h, d - 0.012, mat, -used / 2 + sw / 2 + i * (sw + gap), 0, 0.006);
  return g;
};
// recessed circular LED ring in the ceiling (圓形燈帶). Place with elevation ≈ wall height − 1 cm; w = diameter.
F.ring_light = (it) => {
  const g = new THREE.Group(); const D = it.w || 1.4, lc = it.ledColor || '#ffcf99';
  const glow = fmat('ring' + lc, () => new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: lc, emissiveIntensity: 2.6, roughness: 1 }));
  const shadow = fmat('ringgap', () => new THREE.MeshStandardMaterial({ color: '#2a2724', roughness: 1 }));
  const gap = new THREE.Mesh(new THREE.RingGeometry(D / 2 - 0.02, D / 2 + 0.02, 96), shadow); // dark reveal around the LED
  gap.rotation.x = Math.PI / 2; gap.position.y = 0.002; g.add(gap);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(D / 2, 0.008, 8, 128), glow);
  ring.rotation.x = Math.PI / 2; ring.position.y = -0.004; ring.userData.lightGlow = true; g.add(ring);
  return g;
};
// computer monitor on a desk (stand + 16:9 panel). inch = diagonal (27" panel ≈ 59.8 × 33.6 cm); place with
// elevation = desk height (75). The panel's lower edge sits ~11 cm above the desk so the top is near seated eye level.
F.monitor = (it, M) => {
  const g = new THREE.Group(); const inch = it.inch || 27;
  const sw = inch * 0.0254 * 0.8716, sh = sw * 0.5625, bz = 0.008;
  const screen = M.screen, body = M.dark;
  B(g, 0.24, 0.012, 0.18, body, 0, 0, -0.02); // base
  B(g, 0.05, 0.17, 0.025, body, 0, 0.012, -0.07); // neck
  B(g, sw + bz * 2, sh + bz * 2, 0.02, body, 0, 0.11, -0.045); // housing
  B(g, sw, sh, 0.003, screen, 0, 0.11 + bz, -0.034); // panel, 1.5 mm proud of the housing
  if (it.keyboard !== false) { // keyboard + mouse in front of the screen (the monitor stands ~27 cm from the desk's back edge)
    B(g, 0.44, 0.018, 0.14, body, 0, 0, 0.22);
    B(g, 0.42, 0.004, 0.12, M.metal, 0, 0.018, 0.22); // key field, slightly lighter
    B(g, 0.06, 0.03, 0.1, body, 0.32, 0, 0.22); // mouse
  }
  return g;
};
// desktop PC tower (mid tower ≈ 22 × 48 × 46 cm), stands on the floor under / beside the desk
F.pc_tower = (it, M) => {
  const g = new THREE.Group(); const w = it.w || 0.22, d = it.d || 0.46, h = it.h || 0.48;
  B(g, w, 0.02, d - 0.04, M.dark, 0, 0, 0); // feet
  B(g, w, h - 0.02, d, M.dark, 0, 0.02, 0);
  B(g, 0.008, h * 0.7, d * 0.8, M.glassClear || M.glass, w / 2 + 0.002, 0.02 + h * 0.15, 0); // side window
  const led = fmat('pcled', () => new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#9fc8ff', emissiveIntensity: 1.2, roughness: 1 }));
  B(g, w * 0.5, 0.006, 0.004, led, 0, h - 0.06, d / 2 + 0.001); // power LED strip
  return g;
};
export const FURNITURE = F;
export const DEFAULT_SIZES = {
  monitor: [62, 22], pc_tower: [22, 46],
  sofa: [220, 92], armchair: [80, 80], coffee_table: [110, 60], side_table: [45, 45], tv_cabinet: [180, 42],
  sideboard: [160, 45], chair: [46, 48], dining_table: [160, 90], bed: [180, 210], nightstand: [48, 40],
  wardrobe: [200, 60], desk: [120, 60], bookshelf: [100, 35], kitchen_counter: [300, 60], island: [180, 90],
  fridge: [75, 70], toilet: [40, 70], vanity: [90, 50], bathtub: [170, 75], shower: [90, 90], plant: [40, 40],
  floor_lamp: [40, 40], rug: [240, 170], art: [90, 3], mirror: [60, 3], shoe_cabinet: [120, 38], box: [50, 50], cylinder: [50, 50],
  ottoman: [60, 60], stool: [40, 40], display_shelf: [40, 35], slat_panel: [100, 4], ring_light: [140, 140],
};
// pieces you can walk through (no collision)
export const NON_SOLID = new Set(['rug', 'art', 'mirror', 'floor_lamp', 'ring_light']);
