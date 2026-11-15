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
  // pillows
  const p1 = R(g, 0.42, 0.42, 0.12, 0.05, M.accent, -inner / 2 + 0.28, legH + baseH + 0.14, -d / 2 + 0.38); p1.rotation.set(-0.25, 0.25, 0.1);
  const p2 = R(g, 0.42, 0.42, 0.12, 0.05, M.fabricAlt, inner / 2 - 0.28, legH + baseH + 0.14, -d / 2 + 0.38); p2.rotation.set(-0.25, -0.25, -0.1);
  return g;
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
  const top = S_.tableTop === 'stone' ? M.stone : S_.tableTop === 'glass' ? M.glass : M.wood;
  if (it.shape === 'round') {
    C(g, w / 2, w / 2, 0.03, top, 0, h - 0.03, 0, 48);
    C(g, w / 2 - 0.08, w / 2 - 0.08, h - 0.03, S_.legs === 'metal' ? M.metal : M.woodDark, 0, 0, 0, 48);
  } else {
    B(g, w, 0.035, d, top, 0, h - 0.035);
    legs(g, w, d, h - 0.035, M, S_.legs === 'plinth' ? 'block' : (S_.legs || 'tapered'), 0.06);
    B(g, w - 0.12, 0.02, d - 0.12, M.wood, 0, 0.12);
  }
  // decor: books + vase
  B(g, 0.24, 0.03, 0.17, M.accent, -w * 0.2, h); B(g, 0.22, 0.025, 0.16, M.white, -w * 0.2, h + 0.03);
  C(g, 0.04, 0.05, 0.14, M.pot, w * 0.22, h, 0);
  return g;
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
  if (it.tv !== false) {
    const tw = Math.min(w * 0.8, 1.45); const th = tw * 0.5625;
    if (it.wallTv) { B(g, tw, th, 0.03, M.screen, 0, 1.0, -d / 2 + 0.03); }
    else {
      B(g, 0.3, 0.02, 0.2, M.metal, 0, h); B(g, 0.05, 0.12, 0.03, M.metal, 0, h, -0.03);
      B(g, tw, th, 0.035, M.screen, 0, h + 0.08, -0.03);
    }
  }
  C(g, 0.06, 0.05, 0.22, M.pot, w / 2 - 0.2, h); // vase
  return g;
};

F.sideboard = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.6, d = it.d || 0.45, h = it.h || 0.8;
  const legH = S_.legs === 'plinth' || S_.legs === 'none' ? 0.05 : 0.16;
  legs(g, w, d, legH, M, S_.legs === 'none' ? 'plinth' : (S_.legs || 'tapered'));
  B(g, w, h - legH, d, M.wood, 0, legH);
  const n = Math.max(2, Math.round(w / 0.5));
  for (let i = 1; i < n; i++) B(g, 0.006, h - legH - 0.04, 0.005, M.woodDark, -w / 2 + (w / n) * i, legH + 0.02, d / 2);
  C(g, 0.07, 0.05, 0.3, M.pot, -w / 2 + 0.25, h); S(g, 0.12, M.plant, -w / 2 + 0.25, h + 0.38, 0, 1, 0.8, 1, 1);
  B(g, 0.5, 0.35, 0.02, M.frame, w / 4, h, -d / 2 + 0.06).rotation.x = -0.08;
  return g;
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
  const top = S_.tableTop === 'stone' ? M.stone : S_.tableTop === 'glass' ? M.glass : M.wood;
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
  C(g, 0.05, 0.07, 0.2, M.pot, 0, h); S(g, 0.1, M.plant, 0, h + 0.25, 0, 1.2, 0.8, 1.2, 1);
  return g;
};

F.bed = (it, M, S_) => {
  const g = new THREE.Group(); const w = it.w || 1.8, d = it.d || 2.1; const kind = S_.bed || 'legs';
  const frameH = kind === 'platform' ? 0.22 : 0.32;
  const frameMat = kind === 'upholstered' ? M.fabric : M.wood;
  if (kind === 'legs') { legs(g, w, d, 0.14, M, S_.legs === 'metal' ? 'metal' : 'block', 0.06); B(g, w, frameH - 0.14, d, frameMat, 0, 0.14); }
  else if (kind === 'platform') { B(g, w + 0.2, 0.06, d + 0.15, M.wood, 0, 0, 0.07); B(g, w - 0.1, frameH - 0.06, d - 0.1, M.woodDark, 0, 0.0); }
  else R(g, w + 0.06, frameH, d, 0.03, frameMat, 0, 0);
  R(g, w - 0.04, 0.22, d - 0.08, 0.06, M.mattress, 0, frameH, 0.02);
  const top = frameH + 0.22;
  R(g, w + 0.02, 0.08, d * 0.68, 0.04, M.bedding, 0, top - 0.04, d / 2 - d * 0.34 + 0.02);
  R(g, w - 0.1, 0.04, 0.5, 0.02, M.fabricAlt, 0, top + 0.03, d / 2 - 0.35); // throw
  const pw = Math.min(0.65, (w - 0.2) / 2);
  for (const sx of w > 1.3 ? [-1, 1] : [0]) { const p = R(g, pw, 0.14, 0.38, 0.06, M.white, sx * (pw / 2 + 0.03), top - 0.02, -d / 2 + 0.3); p.rotation.x = -0.35; }
  R(g, 0.4, 0.3, 0.1, 0.04, M.accent, 0, top, -d / 2 + 0.45).rotation.x = -0.3;
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
  if (it.lamp !== false) {
    C(g, 0.06, 0.07, 0.04, M.pot, 0.05, h); C(g, 0.01, 0.01, 0.22, M.metal, 0.05, h + 0.04, 0, 8);
    const sh = C(g, 0.09, 0.13, 0.18, M.lampshade, 0.05, h + 0.2); sh.castShadow = false;
  }
  return g;
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
  // laptop + lamp
  B(g, 0.33, 0.015, 0.23, M.metal, -0.1, h, 0.05); const scr = B(g, 0.33, 0.22, 0.008, M.metal, -0.1, h + 0.01, -0.06); scr.rotation.x = -0.25;
  C(g, 0.06, 0.07, 0.02, M.metal, w / 2 - 0.15, h, -d / 2 + 0.12); C(g, 0.008, 0.008, 0.4, M.metal, w / 2 - 0.15, h, -d / 2 + 0.12, 8);
  C(g, 0.04, 0.08, 0.1, M.lampshade, w / 2 - 0.15, h + 0.36, -d / 2 + 0.12);
  if (it.chair !== false) { const c = chair(M, S_, it.chairStyle || 'upholstered'); c.position.z = d / 2 + 0.05; c.rotation.y = Math.PI; g.add(c); }
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
    B(g, 0.6, 0.12, 0.5, M.metal, cx, 1.38, -d / 2 + 0.25); // hood
    B(g, w, 0.6, 0.01, M.white, 0, 0.9, -d / 2 + 0.005); // backsplash
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
  B(g, w, 0.02, d, M.countertop, 0, 0.8);
  const bowl = C(g, 0.2, 0.15, 0.13, M.ceramic, 0, 0.82, 0.02, 32);
  C(g, 0.17, 0.17, 0.006, M.dark, 0, 0.945, 0.02, 32);
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

F.shower = (it, M) => {
  const g = new THREE.Group(); const w = it.w || 0.9, d = it.d || 0.9;
  B(g, w, 0.04, d, M.ceramic); B(g, w, 2.0, 0.01, M.glass, 0, 0.04, d / 2);
  C(g, 0.012, 0.012, 1.9, M.metal, w / 2 - 0.15, 0, -d / 2 + 0.05, 8); C(g, 0.11, 0.11, 0.015, M.metal, w / 2 - 0.15, 1.95, -d / 2 + 0.17, 24);
  return g;
};

F.plant = (it, M) => {
  const g = new THREE.Group(); const h = it.h || 1.3; const kind = it.kind || 'leafy';
  C(g, 0.17, 0.13, 0.3, M.pot, 0, 0, 0, 24);
  C(g, 0.15, 0.15, 0.02, M.woodDark, 0, 0.28, 0, 24);
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
  const light = new THREE.PointLight(0xffd9a0, 1.6, 4, 2); light.position.set(0, h - 0.18, 0); g.add(light);
  return g;
};

F.rug = (it, M, S_, ctx) => {
  const g = new THREE.Group(); const w = it.w || 2.4, d = it.d || 1.7;
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), ctx.rugMat);
  m.position.y = 0.006; m.receiveShadow = true; g.add(m);
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
    else if (kind === 'rattan') { shade = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), M.wood); shade.material = M.wood; shade.position.set(x, dropTo - 0.1, 0); shade.rotation.x = Math.PI; const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 8), M.lampshade); bulb.position.set(x, dropTo - 0.08, 0); g.add(bulb); }
    else { shade = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 16), M.lampshade); shade.position.set(x, dropTo - 0.15, 0); }
    shade.material.side = THREE.DoubleSide;
    g.add(shade);
    if (kind === 'linear') break;
  }
  const light = new THREE.PointLight(0xffd6a0, 3, 5, 2); light.position.set(0, dropTo - 0.3, 0); g.add(light);
  return g;
}

export const FURNITURE = F;
export const DEFAULT_SIZES = {
  sofa: [220, 92], armchair: [80, 80], coffee_table: [110, 60], side_table: [45, 45], tv_cabinet: [180, 42],
  sideboard: [160, 45], chair: [46, 48], dining_table: [160, 90], bed: [180, 210], nightstand: [48, 40],
  wardrobe: [200, 60], desk: [120, 60], bookshelf: [100, 35], kitchen_counter: [300, 60], island: [180, 90],
  fridge: [75, 70], toilet: [40, 70], vanity: [90, 50], bathtub: [170, 75], shower: [90, 90], plant: [40, 40],
  floor_lamp: [40, 40], rug: [240, 170], art: [90, 3], mirror: [60, 3], shoe_cabinet: [120, 38], box: [50, 50], cylinder: [50, 50],
  ottoman: [60, 60], stool: [40, 40],
};
// pieces you can walk through (no collision)
export const NON_SOLID = new Set(['rug', 'art', 'mirror', 'floor_lamp']);
