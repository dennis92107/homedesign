// Plan JSON + Style JSON -> THREE scene graph.
// Plan coordinates are centimetres, origin top-left of the drawing, x → right, y → down.
// World: X = x/100, Z = y/100, Y up (metres).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { surfaceMaterial, buildRoleMaterials, withOverrides } from './materials.js';
import { FURNITURE, DEFAULT_SIZES, NON_SOLID, pendant, boxGeo } from './furniture.js';
import { modelInstance, modelEntry, pickDefault, pickSpec, MODEL_FIT } from './assets.js';
import { decorContext, addDecor, settleDecor, loadDecorModels } from './decor.js';
import * as TX from './textures.js';
import { kelvinColor, roomLighting, addRoomFixtures, addWallWash, addSkirting } from './lighting.js';

const cm = (v) => v / 100;

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a / 2);
}
export function centroid(poly) {
  let x = 0, y = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length]; const f = x1 * y2 - x2 * y1;
    x += (x1 + x2) * f; y += (y1 + y2) * f; a += f;
  }
  if (Math.abs(a) < 1e-6) return poly[0];
  return [x / (3 * a), y / (3 * a)];
}
export function pointInPoly([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function roomAt(plan, p) { return (plan.rooms || []).find((r) => pointInPoly(p, r.polygon)); }

/** the full-height wall right behind a piece (≤ 45 cm gap), for wall art: { dist (m, centre → wall face), span (m) }
 *  or null. span = free width along the wall around the piece's centre (no window / door / opening). */
function wallBehind(it, item, wallInfo) {
  const r = ((it.rotation || 0) * Math.PI) / 180;
  const bx = Math.sin(r), by = -Math.cos(r); // back direction in plan cm (front of rotation 0 = +y)
  const half = item.d * 50;
  let best = null;
  for (const w of wallInfo) {
    if (w.railing || (w.h && w.h < 200)) continue;
    // ray p + t·b  vs  segment a + s·u
    const den = bx * w.uy - by * w.ux; if (Math.abs(den) < 1e-6) continue;
    const dx = w.a[0] - it.x, dy = w.a[1] - it.y;
    const t = (dx * w.uy - dy * w.ux) / den, s = (dx * by - dy * bx) / den;
    if (s < 0 || s > w.L || t < half - 15 || t > half + 45 + w.t / 2) continue;
    if (!best || t < best.t) best = { t, s, w };
  }
  if (!best) return null;
  const { t, s, w } = best;
  // free span along the wall: up to the nearest opening on each side (capped at the piece width)
  let lo = Math.max(0, s - item.w * 50), hi = Math.min(w.L, s + item.w * 50);
  for (const o of w.ops) {
    if (o.e <= s) lo = Math.max(lo, o.e + 10); else if (o.s >= s) hi = Math.min(hi, o.s - 10); else return null; // opening right behind
  }
  const span = 2 * Math.min(s - lo, hi - s) / 100;
  // full free width of the wall around the hit (for a wall panel wider than the piece)
  let flo = 0, fhi = w.L;
  for (const o of w.ops) { if (o.e <= s) flo = Math.max(flo, o.e + 5); else if (o.s >= s) fhi = Math.min(fhi, o.s - 5); }
  const spanFull = 2 * Math.min(s - flo, fhi - s) / 100;
  return span > 0.3 ? { dist: (t - w.t / 2) / 100, span, spanFull } : null;
}

// ---------- wall joints ----------
// Walls used to be boxes that all ran half a thickness past both ends, so at every corner two boxes overlapped and
// their faces lay in the same plane → z-fighting (flicker). Like floor-plan editors do (offset each wall's two side
// lines by ±t/2 and intersect them with the neighbours' side lines), we now compute where each SIDE of each wall
// ends:  L/X/Y corners → mitred (side lines intersected, walls sorted by angle around the joint),
//        straight continuation → butt at the joint point,  T (end on another wall's middle) → stop at that wall's face,
//        duplicated collinear walls → the thinner one starts where the thicker one ends,  free end → old t/2 overhang.
// Result per wall (cm along the wall from a): { P0, N0, P1, N1, T0, T1, lower } — P/N = +/- side (+Z in wall space).
// default heights (cm) of pieces that may stand under a window, when the item has no explicit h (curtain hems)
const FURN_H = { desk: 75, sideboard: 80, tv_cabinet: 50, nightstand: 55, shoe_cabinet: 100, bookshelf: 180, wardrobe: 220, kitchen_counter: 90, vanity: 85, bathtub: 55, box: 50, display_shelf: 180 };
const HEM_SKIP = new Set(['sofa', 'armchair', 'bed', 'chair', 'plant', 'floor_lamp', 'rug', 'ottoman', 'stool', 'art', 'mirror']);
const JOINT_TOL = 3; // cm: wall ends closer than this belong to the same joint
function lineHit(px, py, dx, dy, qx, qy, ex, ey) {
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((qx - px) * ey - (qy - py) * ex) / den;
  return [px + dx * t, py + dy * t];
}
export function wallJoints(plan) {
  const defT = plan.wallThickness || 12, extT = plan.exteriorThickness || 20;
  const W = (plan.walls || []).map((w, i) => {
    const [ax, ay] = w.a, [bx, by] = w.b; const L = Math.hypot(bx - ax, by - ay) || 1;
    const t = w.thickness || (w.exterior ? extT : defT);
    return { i, w, ax, ay, bx, by, L, ux: (bx - ax) / L, uy: (by - ay) / L, t, ok: L >= 1 && !w.railing && w.extend == null };
  });
  const res = W.map((o) => { const e = o.w.extend ?? o.t / 2; return { P0: -e, N0: -e, P1: o.L + e, N1: o.L + e, T0: false, T1: false, lower: 0 }; });
  // set the extent of one side of one end: sigma = distance from the end point along the outgoing direction
  const setEnd = (e, plusSide, sigma) => {
    const r = res[e.o.i];
    if (e.end === 0) r[plusSide ? 'P0' : 'N0'] = sigma; else r[plusSide ? 'N1' : 'P1'] = e.o.L - sigma;
  };
  const ends = [];
  for (const o of W) if (o.ok) {
    ends.push({ o, end: 0, x: o.ax, y: o.ay, dx: o.ux, dy: o.uy });
    ends.push({ o, end: 1, x: o.bx, y: o.by, dx: -o.ux, dy: -o.uy });
  }
  const done = new Set();
  for (const e of ends) {
    if (done.has(e)) continue;
    const joint = ends.filter((f) => !done.has(f) && Math.hypot(f.x - e.x, f.y - e.y) <= JOINT_TOL);
    joint.forEach((f) => done.add(f));
    for (const f of joint) f.ang = Math.atan2(f.dy, f.dx);
    // duplicated collinear walls leaving the joint in the same direction: keep the thickest, trim the others
    const prim = [];
    for (const f of [...joint].sort((a, b) => b.o.t - a.o.t || a.o.i - b.o.i)) {
      const p = prim.find((q) => Math.abs(Math.atan2(Math.sin(q.ang - f.ang), Math.cos(q.ang - f.ang))) < 0.05);
      if (!p) { prim.push(f); continue; }
      const d = Math.min(p.o.L, f.o.L);
      if (d < f.o.L - 1) { setEnd(f, true, d); setEnd(f, false, d); }
      res[f.o.i].lower = Math.max(res[f.o.i].lower, 1); // its cap would lie in the thicker wall's cap plane
    }
    if (prim.length >= 2) {
      prim.sort((a, b) => a.ang - b.ang);
      const n = prim.length;
      for (let k = 0; k < n; k++) {
        const f = prim[k], g = prim[(k + 1) % n]; // g is the next wall counter-clockwise (+perp side of f)
        let da = g.ang - f.ang; if (da <= 0) da += Math.PI * 2;
        const fx = -f.dy, fy = f.dx, gx = -g.dy, gy = g.dx; // perpendiculars (+side)
        let sf = 0, sg = 0; // butt at the joint for straight continuations
        if (!(n === 2 && Math.abs(da - Math.PI) < 0.05)) {
          const X = lineHit(f.x + fx * f.o.t / 2, f.y + fy * f.o.t / 2, f.dx, f.dy, g.x - gx * g.o.t / 2, g.y - gy * g.o.t / 2, g.dx, g.dy);
          if (X) {
            const lim = 3 * Math.max(f.o.t, g.o.t); // very acute angles: don't let the mitre run away
            sf = Math.max(-lim, Math.min(lim, (X[0] - f.x) * f.dx + (X[1] - f.y) * f.dy));
            sg = Math.max(-lim, Math.min(lim, (X[0] - g.x) * g.dx + (X[1] - g.y) * g.dy));
          }
        }
        setEnd(f, true, sf); setEnd(g, false, sg);
      }
      continue;
    }
    // a single wall ends here: T-joint if it ends on another wall's body → stop at that wall's near face
    const f = prim[0];
    let best = null;
    for (const v of W) {
      if (v === f.o || v.w.railing) continue;
      const nx = -v.uy, ny = v.ux;
      const off = (f.x - v.ax) * nx + (f.y - v.ay) * ny, along = (f.x - v.ax) * v.ux + (f.y - v.ay) * v.uy;
      if (Math.abs(off) > v.t / 2 + JOINT_TOL || along < -JOINT_TOL || along > v.L + JOINT_TOL) continue;
      const cos = f.dx * nx + f.dy * ny; // body direction vs the other wall's normal
      if (Math.abs(cos) < 0.17) continue; // (nearly) parallel: not a T
      if (!best || Math.abs(off) < best.off) best = { v, nx, ny, sgn: Math.sign(cos), off: Math.abs(off) };
    }
    if (!best) continue; // free end: keep the default overhang
    const { v, nx, ny, sgn } = best;
    const qx = v.ax + nx * sgn * v.t / 2, qy = v.ay + ny * sgn * v.t / 2; // near face line
    for (const plus of [true, false]) {
      const s = plus ? 1 : -1, px = -f.dy * s * f.o.t / 2, py = f.dx * s * f.o.t / 2;
      const X = lineHit(f.x + px, f.y + py, f.dx, f.dy, qx, qy, v.ux, v.uy);
      if (X) setEnd(f, plus, Math.max(-f.o.t, Math.min(f.o.L / 2, (X[0] - f.x) * f.dx + (X[1] - f.y) * f.dy)));
    }
    res[f.o.i][f.end === 0 ? 'T0' : 'T1'] = true;
  }
  // walls that still overlap a non-joined wall (e.g. a thick column drawn over an exterior wall): the thinner one's
  // cap is dropped 1 mm under the thicker one's so the two tops never share a plane (priority like CAD wall joins)
  const quad = (o) => { const r = res[o.i], nx = -o.uy * o.t / 2, ny = o.ux * o.t / 2;
    return [[o.ax + o.ux * r.P0 + nx, o.ay + o.uy * r.P0 + ny], [o.ax + o.ux * r.P1 + nx, o.ay + o.uy * r.P1 + ny],
      [o.ax + o.ux * r.N1 - nx, o.ay + o.uy * r.N1 - ny], [o.ax + o.ux * r.N0 - nx, o.ay + o.uy * r.N0 - ny]]; };
  const sep = (A, B) => { // separating axis test for two convex quads (shrunk by 0.5 cm so touching joints don't count)
    for (const P of [A, B]) for (let i = 0; i < 4; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % 4]; const ax = y1 - y2, ay = x2 - x1; const l = Math.hypot(ax, ay) || 1;
      const pa = A.map(([x, y]) => (x * ax + y * ay) / l), pb = B.map(([x, y]) => (x * ax + y * ay) / l);
      if (Math.max(...pa) - 0.5 <= Math.min(...pb) || Math.max(...pb) - 0.5 <= Math.min(...pa)) return true;
    }
    return false;
  };
  const okW = W.filter((o) => o.ok);
  const Q = new Map(okW.map((o) => [o, quad(o)]));
  for (let i = 0; i < okW.length; i++) for (let j = i + 1; j < okW.length; j++) {
    const a = okW[i], b = okW[j];
    if (sep(Q.get(a), Q.get(b))) continue;
    const thin = a.t < b.t || (a.t === b.t && a.i > b.i) ? a : b;
    res[thin.i].lower = Math.max(res[thin.i].lower, 1);
  }
  return res;
}

/** wall piece as a prism with a (possibly mitred) quad footprint: P side z=zP from p0..p1, N side z=zN from n0..n1.
 *  Face groups follow BoxGeometry (0 +x end, 1 -x end, 2 top, 3 bottom, 4 +z = P, 5 -z = N) so the wall materials
 *  and the P/N picking keep working; UVs are in metres along the wall so textures continue across pieces. */
function prismGeo(p0, p1, n0, n1, zP, zN, y0, y1, ox = 0, oy = 0) {
  const pos = [], nor = [], uv = [], idx = [], groups = [];
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const quadF = (A, Bv, Cv, D, uvs, g) => {
    const n = new THREE.Vector3().subVectors(v3(Cv), v3(A)).cross(new THREE.Vector3().subVectors(v3(D), v3(Bv)));
    if (n.lengthSq() < 1e-12) return; // zero-area side (fully mitred away)
    n.normalize();
    const base = pos.length / 3;
    for (const p of [A, Bv, Cv, D]) pos.push(p[0] - ox, p[1] - oy, p[2]);
    for (let k = 0; k < 4; k++) nor.push(n.x, n.y, n.z);
    uvs.forEach((u) => uv.push(u[0], u[1]));
    groups.push({ start: idx.length, count: 6, materialIndex: g });
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const eP = Math.hypot(p1 - n1, zP - zN), eN = Math.hypot(p0 - n0, zP - zN);
  quadF([p1, y0, zP], [n1, y0, zN], [n1, y1, zN], [p1, y1, zP], [[0, y0], [eP, y0], [eP, y1], [0, y1]], 0); // +x end
  quadF([n0, y0, zN], [p0, y0, zP], [p0, y1, zP], [n0, y1, zN], [[0, y0], [eN, y0], [eN, y1], [0, y1]], 1); // -x end
  quadF([p0, y1, zP], [p1, y1, zP], [n1, y1, zN], [n0, y1, zN], [[p0, zP], [p1, zP], [n1, zN], [n0, zN]], 2); // top
  quadF([n0, y0, zN], [n1, y0, zN], [p1, y0, zP], [p0, y0, zP], [[n0, zN], [n1, zN], [p1, zP], [p0, zP]], 3); // bottom
  quadF([p0, y0, zP], [p1, y0, zP], [p1, y1, zP], [p0, y1, zP], [[p0, y0], [p1, y0], [p1, y1], [p0, y1]], 4); // P
  quadF([n1, y0, zN], [n0, y0, zN], [n0, y1, zN], [n1, y1, zN], [[-n1, y0], [-n0, y0], [-n0, y1], [-n1, y1]], 5); // N
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);
  return geo;
}

/** Resolve the effective style for a room type (style.rooms[type] / style.rooms[name] overrides).
 *  A locked room (rooms[name].locked, set in the design layer) ignores the template's room-type spec. */
function roomStyle(style, room) {
  if (!room) return {};
  const r = style.rooms || {};
  const named = r[room.name] || {};
  if (named.locked) return named;
  return { ...(r[room.type] || {}), ...named };
}
// what a locked room falls back to when it leaves a surface unset (never the template's)
const LOCKED_FALLBACK = { wall: { material: 'paint', color: '#f2f0eb' }, floor: { material: 'tile', color: '#d9d6d0' }, ceiling: '#f7f6f3' };

/**
 * @param opts.cut  cut height in cm for the dollhouse view (walls, doors, windows are built only up to it); null = full height
 */
export function buildScene(plan, style, opts = {}) {
  const root = new THREE.Group(); root.name = 'house';
  const groups = {
    floors: new THREE.Group(), walls: new THREE.Group(), openings: new THREE.Group(),
    ceilings: new THREE.Group(), furniture: new THREE.Group(), lights: new THREE.Group(), labels: new THREE.Group(),
    underlay: new THREE.Group(), fixtureLights: new THREE.Group(), // downlights / coves: invisible, path tracer only
  };
  for (const [k, g] of Object.entries(groups)) { g.name = k; root.add(g); }

  const Hcm = plan.wallHeight || 280;
  const H = cm(Hcm);
  const cut = opts.cut ? Math.min(opts.cut, Hcm) : null;
  const Hc = cut ?? Hcm; // build height in cm
  const defT = plan.wallThickness || 12;
  const grooveMats = new Map();
  const grooveMat = (c) => { if (!grooveMats.has(c)) grooveMats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })); return grooveMats.get(c); };
  const M = buildRoleMaterials(style);
  const S_ = style.furniture || {};
  const matCache = new Map();
  const mat = (spec, fb, surface = 'floor') => {
    const k = JSON.stringify(spec) + fb + surface;
    if (!matCache.has(k)) matCache.set(k, surfaceMaterial(spec, fb, { surface }));
    return matCache.get(k);
  };

  // ---------- floors / ceilings / room lights / labels ----------
  const defaultFloor = style.floor || { material: 'wood', color: '#c49a6c' };
  const ceilingColor = style.ceiling?.color || '#f7f6f3';
  const roomLight = style.lighting?.room || {};
  for (const room of plan.rooms || []) {
    const rs = roomStyle(style, room);
    const shape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(cm(x), -cm(y))));
    const geo = new THREE.ShapeGeometry(shape);
    const fspec = rs.floor || (rs.locked ? LOCKED_FALLBACK.floor : defaultFloor);
    const floor = new THREE.Mesh(geo, mat(fspec, '#c49a6c'));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.y = 0.001;
    floor.userData = { kind: 'floor', room: room.name, floorSpec: fspec }; // floorSpec: reflect.js
    groups.floors.add(floor);

    // ceiling: "#hex" or a surface spec (paint / woodPanel / concrete …)
    const cspec = rs.ceiling ?? (rs.locked ? LOCKED_FALLBACK.ceiling : style.ceiling ?? ceilingColor);
    const cs = typeof cspec === 'string' ? { material: 'paint', color: cspec } : { material: 'paint', ...cspec, color: cspec.color || ceilingColor };
    const cmat = mat({ ...cs, pbr: cs.pbr ?? (cs.material === 'paint' ? false : undefined) }, ceilingColor, 'ceiling');
    const ceil = new THREE.Mesh(geo, cmat);
    ceil.rotation.x = -Math.PI / 2; ceil.position.y = H; ceil.castShadow = true;
    ceil.userData = { kind: 'ceiling', room: room.name };
    groups.ceilings.add(ceil);

    const [cx, cy] = room.light ? [room.light.x, room.light.y] : centroid(room.polygon);
    const lt = roomLighting(style, rs, room);
    if (roomLight.enabled !== false && room.type !== 'balcony') {
      const lcol = lt.kelvin ? kelvinColor(lt.kelvin) : (roomLight.color || '#ffe2bd');
      const pl = new THREE.PointLight(lcol, roomLight.intensity ?? 4, 0, 2);
      pl.position.set(cm(cx), H - 0.3, cm(cy));
      pl.userData.base = roomLight.intensity ?? 4;
      groups.lights.add(pl);
      if (roomLight.fixture !== false) {
        const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 32), M.lampshade);
        fixture.position.set(cm(cx), H - 0.015, cm(cy));
        groups.ceilings.add(fixture);
      } else { // no ceiling lamp drawn: a soft fill for the realtime preview, hung at eye height so the ceiling gets no hot spot
        pl.userData.realtimeOnly = true; pl.position.y = 1.5; pl.userData.base = (roomLight.intensity ?? 4) * 0.5; pl.intensity = pl.userData.base;
      }
    }
    lt.ceilingMat = cmat; lt.walls = plan.walls || []; lt.openings = plan.openings || []; lt.extT = plan.exteriorThickness || 20; lt.defT = defT;
    if (lt.downlights || lt.cove) addRoomFixtures({ room, opts: lt, H, groups });
    if (lt.skirting) addSkirting({ room, opts: lt, groups });

    const area = polygonArea(room.polygon) / 10000;
    const div = document.createElement('div');
    div.className = 'room-label';
    div.innerHTML = `<b>${room.name}</b><span>${area.toFixed(1)} m² · ${(area / 3.3058).toFixed(1)} 坪</span>`;
    const lab = new CSS2DObject(div);
    const [lx, ly] = room.label ? [room.label.x, room.label.y] : centroid(room.polygon);
    lab.position.set(cm(lx), 0.1, cm(ly));
    groups.labels.add(lab);
  }

  // ---------- wall-wash slots (custom layer: wallFaces["<room>|<wall>|<P|N>"].wash) ----------
  for (const [key, face] of Object.entries(style.wallFaces || {})) {
    if (!face?.wash) continue;
    const [rname, wiS, side] = key.split('|');
    const w = plan.walls?.[+wiS]; const room = (plan.rooms || []).find((r) => r.name === rname);
    if (!w || !room) continue;
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], L = Math.hypot(dx, dy);
    if (L < 1) continue;
    const t = w.thickness || (w.exterior ? plan.exteriorThickness || 20 : defT);
    addWallWash({ wall: { a: w.a, t, L, ux: dx / L, uy: dy / L }, side, room, H, groups, style, opts: typeof face.wash === 'object' ? face.wash : {} });
  }

  // ---------- walls ----------
  const wallInfo = [];
  const exteriorMat = mat(style.exteriorWall || '#d9d6d0', '#d9d6d0', 'wall');
  const defaultWall = style.wall || { material: 'paint', color: '#f2f0eb' };
  const baseH = cm(style.baseboardHeight ?? 8);
  const joints = wallJoints(plan);

  (plan.walls || []).forEach((w, wi) => {
    const [ax, ay] = w.a; const [bx, by] = w.b;
    const t = w.thickness || (w.exterior ? plan.exteriorThickness || 20 : defT);
    const dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy);
    if (L < 1) return;
    const ux = dx / L, uy = dy / L; const nx = -uy, ny = ux; // +Z side normal in plan coords
    const probeAt = (s, side) => roomAt(plan, [ax + ux * s + nx * side * (t / 2 + 8), ay + uy * s + ny * side * (t / 2 + 8)]);
    // top (m) of furniture standing in the curtain line between s0..s1 cm along this wall (window seat, desk…):
    // the curtain hem then rests on it instead of passing through it
    const hemTop = (s0, s1, side, offCm) => {
      let top = 0;
      for (const f of plan.furniture || []) {
        if (f.hidden || f.removed || !f.w || !f.d || (f.elevation || 0) > 100 || HEM_SKIP.has(f.type)) continue; // wall-hung pieces, and pieces curtains hang behind, don't count
        const fh = (f.elevation || 0) + (f.h ?? FURN_H[f.type] ?? 0); if (fh <= 0 || fh > 120) continue; // tall pieces (a wardrobe beside the window) stand next to the curtain, not under it
        const r = (f.rotation || 0) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
        for (let s = s0; s <= s1; s += 6) {
          const px = ax + ux * s + nx * side * offCm - f.x, py = ay + uy * s + ny * side * offCm - f.y;
          if (Math.abs(px * c + py * sn) <= f.w / 2 + 2 && Math.abs(-px * sn + py * c) <= f.d / 2 + 2) { top = Math.max(top, fh); break; }
        }
      }
      return cm(top);
    };
    // per-face override (one wall side inside one room) > room override > global wall
    const sideMat = (room, side) => {
      if (!room) return exteriorMat;
      const { wash, ...face } = style.wallFaces?.[`${room.name}|${wi}|${side}`] || {}; // wash = lighting only, not a surface
      const rs = roomStyle(style, room);
      return mat((Object.keys(face).length ? face : null) || rs.wall || (rs.locked ? LOCKED_FALLBACK.wall : defaultWall), '#f2f0eb', 'wall');
    };
    // decorative grooves (分割溝縫) on a face: face spec > room wall spec > global wall spec; a face with its own
    // finish (e.g. a marble TV wall) does not inherit the room's grooves
    const grooveSpec = (room, side) => {
      if (!room) return null;
      const face = style.wallFaces?.[`${room.name}|${wi}|${side}`];
      if (face?.grooves !== undefined) return face.grooves || null;
      if (face && (face.material || face.color || face.image)) return null;
      const rs = roomStyle(style, room);
      return rs.wall?.grooves ?? (rs.locked ? null : defaultWall.grooves) ?? null;
    };
    const J = joints[wi]; // per-side extents (cm along the wall), see wallJoints()
    const start = Math.min(J.P0, J.N0), end = Math.max(J.P1, J.N1);
    // A long wall can border several rooms: split it into spans with constant rooms on both sides.
    const spans = [];
    const STEP = 5;
    for (let s = start; s < end; s += STEP) {
      const c = Math.min(Math.max(s + STEP / 2, 1), L - 1);
      const rp = probeAt(c, 1), rn = probeAt(c, -1);
      const last = spans[spans.length - 1];
      if (last && last.rp === rp && last.rn === rn) last.e = Math.min(end, s + STEP);
      else spans.push({ s, e: Math.min(end, s + STEP), rp, rn, mP: sideMat(rp, 'P'), mN: sideMat(rn, 'N'), gP: grooveSpec(rp, 'P'), gN: grooveSpec(rn, 'N') });
    }
    const ops = (plan.openings || []).filter((o) => o.wall === wi).map((o) => {
      const width = o.width || (o.type === 'door' ? 90 : 120);
      const sill = o.sill ?? (o.type === 'window' ? 90 : 0);
      const height = o.height || (o.type === 'door' ? 210 : 130);
      return { ...o, s: o.at - width / 2, e: o.at + width / 2, width, sill, height };
    }).sort((a, b) => a.s - b.s);
    wallInfo.push({ a: w.a, b: w.b, t, L, ux, uy, ops, h: w.height, railing: !!w.railing });

    const wallGroup = new THREE.Group();
    wallGroup.position.set(cm(ax), 0, cm(ay));
    wallGroup.rotation.y = Math.atan2(-dy, dx);
    groups.walls.add(wallGroup);

    // balcony railing: glass panel + handrail instead of a solid wall
    if (w.railing) {
      const rh = cm(Math.min(w.height || 110, Hc));
      const len = cm(L);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(len, rh - 0.05), M.glass);
      glass.position.set(len / 2, (rh - 0.05) / 2, 0); wallGroup.add(glass);
      const rail = new THREE.Mesh(boxGeo(len + 0.04, 0.04, 0.06), M.frame);
      rail.position.set(len / 2, rh - 0.02, 0); rail.castShadow = true; wallGroup.add(rail);
      for (let s = 0; s <= len + 0.001; s += Math.max(0.6, len / Math.ceil(len / 1.2))) {
        const post = new THREE.Mesh(boxGeo(0.04, rh, 0.04), M.frame); post.position.set(s, rh / 2, 0); wallGroup.add(post);
      }
      wallGroup.userData = { kind: 'railing', wall: wi };
      return;
    }

    const zP = cm(t) / 2, BT = 0.012; // baseboard thickness (m)
    const capDrop = J.lower ? 0.1 : 0; // cm: overlapped thinner wall sits 1 mm under the thicker one's cap
    const piece = (x0, x1, y0, y1) => {
      y1 = Math.min(y1, Hc, w.height || Infinity) - (y1 >= Math.min(Hc, w.height || Infinity) ? capDrop : 0); // w.height: low wall / parapet
      if (y1 - y0 < 0.5) return;
      for (const sp of spans) {
        const a0 = Math.max(x0, sp.s), a1 = Math.min(x1, sp.e);
        if (a1 - a0 <= 0.1 || y1 - y0 <= 0.1) continue;
        // each side is clipped to its own (mitred) extent; interior cuts (span / opening edges) stay square
        const p0 = cm(Math.max(a0, J.P0)), p1 = cm(Math.max(Math.max(a0, J.P0), Math.min(a1, J.P1)));
        const n0 = cm(Math.max(a0, J.N0)), n1 = cm(Math.max(Math.max(a0, J.N0), Math.min(a1, J.N1)));
        const ox = cm((a0 + a1) / 2), oy = cm((y0 + y1) / 2);
        const m = new THREE.Mesh(prismGeo(p0, p1, n0, n1, zP, -zP, cm(y0), cm(y1), ox, oy), [sp.mP, sp.mP, M.cap, M.cap, sp.mP, sp.mN]);
        m.position.set(ox, oy, 0);
        m.castShadow = true; m.receiveShadow = true;
        m.userData = { kind: 'wall', wall: wi, P: sp.rp?.name ?? null, N: sp.rn?.name ?? null };
        wallGroup.add(m);
        // grooves: thin dark strips 2 mm proud of the face (not coplanar → no z-fighting), on a grid that starts at
        // the span start so pieces split by openings stay aligned
        for (const [g, side, lo, hi] of [[sp.gP, 1, Math.max(a0, J.P0), Math.min(a1, J.P1)], [sp.gN, -1, Math.max(a0, J.N0), Math.min(a1, J.N1)]]) {
          if (!g) continue;
          const gw = g.width ?? 0.8, gm = grooveMat(g.color || '#2b2927');
          const yb = y0 === 0 ? Math.max(y0, style.baseboardHeight ?? 8) : y0;
          if (y1 - yb > 1) for (let x = sp.s + (g.spacing || 60); x < sp.e - 2; x += g.spacing || 60) {
            if (x - gw / 2 <= lo || x + gw / 2 >= hi) continue;
            const strip = new THREE.Mesh(boxGeo(cm(gw), cm(y1 - yb), 0.003), gm);
            strip.position.set(cm(x), cm((yb + y1) / 2), side * (zP + 0.0005)); strip.receiveShadow = true;
            wallGroup.add(strip);
          }
          for (const hy of g.horizontal || []) {
            if (hy <= y0 + gw || hy >= y1 - gw || hi - lo < 2) continue;
            const strip = new THREE.Mesh(boxGeo(cm(hi - lo), cm(gw), 0.003), gm);
            strip.position.set(cm((lo + hi) / 2), cm(hy), side * (zP + 0.0005)); strip.receiveShadow = true;
            wallGroup.add(strip);
          }
        }
        // baseboards on room-facing sides of floor-level pieces; their ends follow the wall's end line (mitre),
        // and at a T-joint they stop one baseboard-thickness short so they don't run into the other wall's baseboard
        if (y0 === 0 && baseH > 0) {
          for (const [room, side] of [[sp.rp, 1], [sp.rn, -1]]) {
            if (!room || room.type === 'bathroom' || room.type === 'balcony') continue;
            let [i0, i1] = side > 0 ? [p0, p1] : [n0, n1];
            const atStart = side > 0 ? a0 <= J.P0 : a0 <= J.N0, atEnd = side > 0 ? a1 >= J.P1 : a1 >= J.N1;
            const k0 = atStart ? (side > 0 ? (J.P0 - J.N0) : (J.N0 - J.P0)) / t : 0; // end-line slope per metre outward
            const k1 = atEnd ? (side > 0 ? (J.P1 - J.N1) : (J.N1 - J.P1)) / t : 0;
            if (atStart && J.T0) i0 += BT; if (atEnd && J.T1) i1 -= BT;
            const o0 = i0 + k0 * BT, o1 = i1 + k1 * BT;
            if (i1 - i0 < 0.005 && o1 - o0 < 0.005) continue;
            const zi = side * zP, zo = side * (zP + BT);
            const geo = side > 0 ? prismGeo(o0, o1, i0, i1, zo, zi, 0, baseH, ox, 0) : prismGeo(i0, i1, o0, o1, zi, zo, 0, baseH, ox, 0);
            const bb = new THREE.Mesh(geo, M.baseboard);
            bb.position.set(ox, 0, 0);
            bb.receiveShadow = true;
            wallGroup.add(bb);
          }
        }
      }
    };
    let curX = start;
    for (const o of ops) {
      piece(curX, o.s, 0, Hcm);
      if (o.sill > 0) piece(o.s, o.e, 0, o.sill);
      if (o.sill + o.height < Hcm) piece(o.s, o.e, o.sill + o.height, Hcm);
      curX = o.e;
    }
    piece(curX, end, 0, Hcm);

    // ---------- openings ----------
    for (const o of ops) {
      if (o.sill >= Hc) continue;
      const og = new THREE.Group(); wallGroup.add(og);
      og.userData = { kind: o.type, wall: wi };
      const cx = cm(o.at), wd = cm(o.width), sill = cm(o.sill), T = cm(t);
      const fullH = cm(o.height);
      // cut by the dollhouse section: stop 2 mm under the wall caps so frame tops never share the cap plane
      const clipped = fullH > cm(Hc) - sill - 1e-4; const oh = clipped ? cm(Hc) - sill - 0.002 : fullH;
      if (o.type === 'door') {
        const fw = 0.04;
        for (const s of [-1, 1]) {
          // 1 mm inside the opening: a door next to a corner would otherwise share the neighbour wall's face plane
          const f = new THREE.Mesh(boxGeo(fw - 0.001, oh, T + 0.02), M.frame); f.position.set(cx + s * (wd / 2 - fw / 2 - 0.0005), oh / 2, 0); og.add(f);
        }
        if (!clipped) { const top = new THREE.Mesh(boxGeo(wd, fw, T + 0.02), M.frame); top.position.set(cx, oh - fw / 2, 0); og.add(top); }
        if (o.leaf !== false) {
          const hinge = o.hinge === 'end' ? 1 : -1; // which jamb the hinge is on
          const swing = o.swing === 'out' ? -1 : 1; // +1 opens towards +Z side
          const pivot = new THREE.Group(); pivot.position.set(cx + hinge * (wd / 2 - fw), 0, swing * T / 2); og.add(pivot);
          const lw = wd - fw * 2; const lh = Math.min(fullH - fw, oh);
          const leaf = new THREE.Mesh(boxGeo(lw, lh, 0.04), M.doorLeaf);
          leaf.position.set(-hinge * lw / 2, lh / 2, 0); leaf.castShadow = true; leaf.receiveShadow = true; pivot.add(leaf);
          const handle = new THREE.Mesh(boxGeo(0.12, 0.02, 0.06), M.metal); handle.position.set(-hinge * (lw - 0.08), 1.0, 0); if (lh > 1.02) pivot.add(handle);
          pivot.rotation.y = hinge * swing * (o.open ?? 80) * Math.PI / 180;
        }
      } else if (o.type === 'window') {
        const fw = 0.05, fd = 0.07, fm = M.frame;
        const add = (w_, h_, x, y) => { const m = new THREE.Mesh(boxGeo(w_, h_, fd), fm); m.position.set(x, y, 0); m.castShadow = true; m.receiveShadow = true; og.add(m); };
        add(wd, fw, cx, sill + fw / 2);
        if (!clipped) add(wd, fw, cx, sill + oh - fw / 2);
        add(fw, oh, cx - wd / 2 + fw / 2, sill + oh / 2); add(fw, oh, cx + wd / 2 - fw / 2, sill + oh / 2);
        const panels = o.panels || (o.width > 250 ? 4 : o.width > 140 ? 2 : 1);
        for (let i = 1; i < panels; i++) add(0.035, oh - fw, cx - wd / 2 + (wd / panels) * i, sill + oh / 2);
        const gh = oh - fw * (clipped ? 1 : 2);
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(wd - fw * 2, gh), M.glass);
        glass.position.set(cx, sill + fw + gh / 2, 0); og.add(glass);
        if (o.sill > 0) { const ledge = new THREE.Mesh(boxGeo(wd + 0.06, 0.025, T + 0.06), M.stone || M.white); ledge.position.set(cx, sill - 0.012, 0); ledge.receiveShadow = true; og.add(ledge); }
        // curtains on the indoor side(s) — only in full-height view
        const cur = style.decor?.curtains;
        if (!cut && cur && cur.enabled !== false && o.curtains !== false) {
          for (const side of [1, -1]) {
            const room = probeAt(o.at, side);
            if (!room || ['bathroom', 'kitchen', 'balcony'].includes(room.type)) continue;
            const drop = o.sill > 0 && cur.length === 'sill' ? Math.max(0.2, sill - 0.15) : 0.01;
            const topY = Math.min(H - 0.04, sill + oh + 0.25);
            const panelW = Math.max(0.35, wd * 0.22) + 0.1;
            if (cur.type === 'blinds') { // zebra roller blind (調光捲簾) inside the window instead of drapes
              const bh = Math.min(oh * 0.62, 1.4), bw = wd + 0.04;
              const blind = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), zebraMat(cur.color || '#8a7f74', bh));
              blind.position.set(cx, sill + oh - bh / 2, side * (T / 2 + 0.03)); blind.rotation.y = side > 0 ? 0 : Math.PI; og.add(blind);
              const head = new THREE.Mesh(boxGeo(bw + 0.04, 0.07, 0.07), M.metal); head.position.set(cx, sill + oh + 0.035, side * (T / 2 + 0.04)); og.add(head);
              continue;
            }
            // hem above any furniture in the curtain line (e.g. 次臥A window seat), never above 30 cm under the rod
            const hemAt = (x0, x1, off) => { const top = hemTop(x0 * 100, x1 * 100, side, t / 2 + off * 100); return top > drop && top < topY - 0.3 ? top + 0.015 : drop; };
            for (const endS of [-1, 1]) {
              const px = cx + endS * (wd / 2 + 0.17 - panelW / 2);
              const d0 = hemAt(px - panelW / 2, px + panelW / 2, 0.12);
              const c = curtain(panelW, topY - d0, M.curtain);
              c.position.set(px, d0, side * (T / 2 + 0.12));
              og.add(c);
            }
            // decor.curtains.sheerLayer: a full-width sheer (白紗) between the window and the drapes — double curtains
            if (cur.sheerLayer) {
              const sm = sheerMat(typeof cur.sheerLayer === 'string' ? cur.sheerLayer : '#f4f1ec');
              const d1 = hemAt(cx - (wd + 0.3) / 2, cx + (wd + 0.3) / 2, 0.07);
              const sh = curtain(wd + 0.3, topY - d1, sm); sh.position.set(cx, d1, side * (T / 2 + 0.07)); sh.castShadow = false; og.add(sh);
            }
            const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, wd + 0.5, 8), M.metal);
            rod.rotation.z = Math.PI / 2; rod.position.set(cx, topY + 0.02, side * (T / 2 + 0.12)); og.add(rod);
          }
        }
      }
    }
  });

  // ---------- furniture ----------
  const colliders = [];
  const ctx = {
    rugMat: (() => {
      const r = style.decor?.rug || {};
      const tex = TX.rugPattern({ color: r.color || '#d8d0c3', accent: r.accent || '#8b7d6b', pattern: r.pattern || 'border' });
      const pile = TX.pileNormal(); pile.repeat.set(10, 10); // short pile: light catches the tufts (擬真度 ⑧); box UVs span the rug
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 1, normalMap: pile, normalScale: new THREE.Vector2(0.7, 0.7) });
    })(),
    artPalette: style.decor?.artPalette || style.palette || ['#c96f4a', '#e3c9a8', '#36454f', '#f4efe6'],
    bookMats: (style.decor?.bookColors || ['#8c6e54', '#c9b79c', '#3f4e4f', '#a65f46', '#e5ddd0', '#6b7b5b']).map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 })),
  };
  const modelJobs = [];
  const byId = new Map();
  const decorCtx = decorContext(style, M);
  const nightCount = new Map(); // nightstands seen per room (decor: lamp on one side, pendant on the other)
  const roomMats = new Map(); // room name → role set with that room's own furniture colours
  for (let it of plan.furniture || []) {
    const fn = FURNITURE[it.type];
    if (!fn) { console.warn('unknown furniture type', it.type); continue; }
    if (it.type === 'rug' && style.decor?.rugs === false) continue;
    if (it.type === 'plant' && style.decor?.plants === false) continue;
    const [dw, dd] = DEFAULT_SIZES[it.type] || [60, 60];
    // ceiling fixtures sit at the ceiling by default; h: "full" = floor-to-ceiling (follows the plan's wall height)
    if (it.type === 'ring_light' && it.elevation == null) it = { ...it, elevation: Hcm - 1 };
    const item = { ...it, w: cm(it.w ?? dw), d: cm(it.d ?? dd), h: it.h === 'full' ? cm(Hcm - (it.elevation || 0)) : it.h != null ? cm(it.h) : undefined };
    // a room can carry its own furniture colours / models (rooms.<name>.materials / .models); a locked room
    // uses only those, never the template's (fixtures that stay the same whatever template is applied)
    const furnRoom = roomAt(plan, [it.x, it.y]);
    const frs = furnRoom ? roomStyle(style, furnRoom) : {};
    let Mroom = M;
    if (frs.materials || frs.locked) {
      const k = furnRoom.name;
      if (!roomMats.has(k)) roomMats.set(k, frs.locked ? buildRoleMaterials({ materials: frs.materials || {} }) : withOverrides(M, frs.materials));
      Mroom = roomMats.get(k);
    }
    const Mi = withOverrides(Mroom, it.colors);
    const variant = { ...(frs.locked ? frs.furniture || {} : S_), ...(it.variant || {}) };
    // record which material roles this piece uses, so the editor can offer exactly those colour pickers
    const roles = new Set();
    const MiTracked = new Proxy(Mi, { get(t, k) { if (typeof k === 'string') roles.add(k); return t[k]; } });
    const obj = fn(item, MiTracked, variant, ctx);
    obj.position.set(cm(it.x), cm(it.elevation || 0), cm(it.y));
    obj.rotation.y = -((it.rotation || 0) * Math.PI) / 180;
    obj.userData = { kind: 'furniture', id: it.id, item: it, roles };
    obj.visible = !it.hidden;
    if (it.id) byId.set(it.id, obj);
    (it.type === 'ring_light' ? groups.ceilings : groups.furniture).add(obj); // ceiling fixtures hide with the ceiling in cutaway views
    const rotRad = -((it.rotation || 0) * Math.PI) / 180;
    if (!NON_SOLID.has(it.type) && it.solid !== false && !it.elevation) {
      colliders.push({ obj, x: cm(it.x), z: cm(it.y), hw: item.w / 2, hd: item.d / 2, rot: rotRad });
    }
    // L-shaped sofa: the chaise sticks out in front of the plan's w×d on one side → its own collider box
    // (ox/oz = offset in the piece's frame; refined from the real model's footprint once it has loaded)
    let chaiseCollider = null;
    if (it.type === 'sofa' && it.chaise && it.solid !== false && !it.elevation) {
      const side = it.chaise === 'left' ? -1 : 1, cw = Math.min(item.w * 0.36, 1.0), ext = 0.75;
      chaiseCollider = { obj, x: cm(it.x), z: cm(it.y), rot: rotRad, ox: side * (item.w / 2 - cw / 2), oz: item.d / 2 + ext / 2, hw: cw / 2, hd: ext / 2, side };
      colliders.push(chaiseCollider);
    }
    const roomType = furnRoom?.type;
    // real 3D model replacement (whole piece, or sub-slots such as dining chairs)
    const modelFor = (type, explicit, slotVariant) => {
      if (explicit === false) return null;
      const withFit = (spec) => {
        if (!spec) return null;
        const e = modelEntry(spec.id) || {};
        return { ...(MODEL_FIT[spec.id] || {}), ...(e.by ? { by: e.by } : {}), rotate: e.rotate || 0, ...spec };
      };
      if (typeof explicit === 'string') return withFit({ id: explicit });
      const sm = frs.locked ? frs.models?.[type] : frs.models?.[type] ?? style.models?.[type];
      if (sm === false) return null;
      if (typeof sm === 'string') return withFit({ id: sm });
      if (Array.isArray(sm)) { // e.g. [{ id, if: { chaise: true } }, { id }] — no match → the built-in default
        const one = slotVariant ? {} : it, v = slotVariant || variant;
        return withFit(pickSpec(sm, one, v, roomType) || pickDefault(type, one, v, roomType));
      }
      if (sm && typeof sm === 'object') return withFit(sm);
      return withFit(pickDefault(type, slotVariant ? {} : it, slotVariant || variant, roomType));
    };
    const tintFor = (type, explicit) => {
      const role = explicit ?? (frs.locked ? frs.modelTint : style.modelTint)?.[type];
      if (!role) return null;
      if (role.startsWith('#')) return new THREE.Color(role);
      const m = Mi[role];
      return m?.userData.baseColor ? new THREE.Color(m.userData.baseColor) : null;
    };
    // the model's colour regions follow the template's material roles (catalogue `roles`); explicit
    // modelColors win, an explicit tint switches this off, style.modelRecolor = false keeps original colours
    const roleColors = (spec, type, explicitTint) => {
      const e = modelEntry(spec.id); const roles = { ...(e?.roles || {}), ...(spec.roles || {}) }; // a template spec may re-map roles
      if (!Object.keys(roles).length || explicitTint || style.modelRecolor === false) return {};
      const leather = it.leather || variant.sofaMaterial === 'leather';
      const alias = { upholstery: type === 'sofa' ? (leather ? 'leather' : 'fabric') : type === 'armchair' ? (it.leather ? 'leather' : 'fabricAlt') : 'fabric' };
      const out = {};
      for (const [k, role] of Object.entries(roles)) {
        const c = role.startsWith('#') ? role : Mi[alias[role] || role]?.userData.baseColor;
        if (c) out[k] = c;
      }
      return out;
    };
    const whole = modelFor(it.type, it.model);
    const fitH = item.h ?? (it.type === 'plant' ? (it.kind === 'tall' ? 1.5 : 0.95) : undefined);
    if (whole) {
      obj.userData.modelId = whole.id;
      const e = modelEntry(whole.id) || {};
      const tint = tintFor(it.type, it.tint);
      const chaiseFit = it.type === 'sofa' && it.chaise && e.chaise ? { byWidth: true, align: 'back', mirror: e.chaise !== it.chaise } : {};
      modelJobs.push({ target: obj, type: it.type, spec: whole, chaiseCollider, fit: { w: item.w, d: item.d, h: fitH, by: whole.by, byWidth: whole.byWidth, align: whole.align, ...chaiseFit, rotate: (whole.rotate || 0) + (it.modelRotate || 0), colors: { ...roleColors(whole, it.type, it.tint), ...(it.modelColors || {}) }, variant: it.modelVariant }, tint, tintFilter: whole.tintFilter });
    }
    obj.traverse((o) => {
      if (o.userData.slot && o !== obj) {
        const sv = { ...variant, chair: o.userData.slot.style || it.chairStyle || variant.chair };
        const spec = modelFor(o.userData.slot.type, it.slotModel, sv);
        if (spec) modelJobs.push({ target: o, type: o.userData.slot.type, spec, fit: { w: o.userData.slot.w, d: o.userData.slot.d, h: o.userData.slot.h, rotate: spec.rotate, colors: { ...roleColors(spec, 'chair', it.slotTint), ...(it.slotModelColors || {}) }, variant: it.slotModelVariant }, tint: tintFor(o.userData.slot.type, it.slotTint) });
      }
    });
    // accessories (pillows, books, lamps, bedding, wall art …) — see decor.js
    {
      const env = { roomType, ceiling: H, seed: Math.round(Math.abs(it.x * 7 + it.y * 13)) + 1, modelHasPillows: !!(whole && modelEntry(whole.id)?.pillows) };
      if (it.type === 'nightstand') { const k = roomAt(plan, [it.x, it.y])?.name || ''; env.nightIndex = nightCount.get(k) || 0; nightCount.set(k, env.nightIndex + 1); }
      if (['sofa', 'bed', 'sideboard', 'nightstand'].includes(it.type)) {
        env.wall = wallBehind(it, item, wallInfo);
        env.artNear = (plan.furniture || []).some((o) => o.type === 'art' && Math.hypot(o.x - it.x, o.y - it.y) < (it.w || 100) / 2 + 60);
      }
      if (it.type === 'bed') { // which side of the bed is free (in the room, no other furniture) → slippers go there
        const th = ((it.rotation || 0) * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
        const inside = (o, px, py) => { const a = ((o.rotation || 0) * Math.PI) / 180, dx = px - o.x, dy = py - o.y; return Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) <= (o.w || 60) / 2 + 8 && Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)) <= (o.d || 60) / 2 + 8; };
        const score = (sx) => {
          const lx = sx * ((it.w || 160) / 2 + 25), lz = (it.d || 200) * 0.05;
          const px = it.x + c * lx - s * lz, py = it.y + s * lx + c * lz;
          if (roomAt(plan, [px, py])?.name !== roomAt(plan, [it.x, it.y])?.name) return -1;
          return (plan.furniture || []).some((o) => o.id !== it.id && o !== it && o.type !== 'rug' && o.type !== 'art' && inside(o, px, py)) ? 0 : 1;
        };
        const r = score(1), l = score(-1);
        env.bedFree = Math.max(r, l) <= 0 ? 0 : r >= l ? 1 : -1;
      }
      addDecor(obj, it, item, decorCtx, env);
      settleDecor(obj);
    }

    // auto pendant above dining tables / islands (not in the dollhouse cut view)
    const pk = style.decor?.pendant;
    if (!cut && pk && pk !== 'none' && (it.type === 'dining_table' || it.type === 'island') && it.pendant !== false) {
      const p = pendant(pk, M, H, 1.55, it.type === 'island' ? 2 : pk === 'linear' ? 1 : (item.w > 1.5 ? 2 : 1), item.w * 0.5);
      p.position.set(cm(it.x), 0, cm(it.y)); p.rotation.y = obj.rotation.y;
      p.userData = { kind: 'pendant', id: it.id };
      p.visible = !it.hidden;
      groups.furniture.add(p);
    }
  }

  // ---------- underlay (source floor-plan image) ----------
  if (plan.underlay?.image) {
    const u = plan.underlay;
    const tex = new THREE.TextureLoader().load(u.image); tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(cm(u.width), cm(u.height)), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: u.opacity ?? 0.65, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(cm((u.x || 0) + u.width / 2), 0.02, cm((u.y || 0) + u.height / 2));
    m.renderOrder = 10;
    groups.underlay.add(m);
  }

  const xs = [], ys = [];
  for (const w of plan.walls || []) { xs.push(w.a[0], w.b[0]); ys.push(w.a[1], w.b[1]); }
  for (const r of plan.rooms || []) for (const [x, y] of r.polygon) { xs.push(x); ys.push(y); }
  const bounds = { minX: cm(Math.min(...xs)), maxX: cm(Math.max(...xs)), minZ: cm(Math.min(...ys)), maxZ: cm(Math.max(...ys)), H };

  return { root, groups, wallInfo, colliders, bounds, materials: M, modelJobs, byId };
}

/** Swap procedural pieces for real glTF models (async). Returns a promise resolved when all jobs settled. */
export function applyModels(built, isCurrent = () => true) {
  const jobs = built.modelJobs.map(async (job) => {
    const inst = await modelInstance(job.spec.id, { ...job.fit, tint: job.tint, tintFilter: job.tintFilter });
    if (!isCurrent()) return;
    const t = job.target;
    // replace the procedural geometry, but keep sub-slots (dining chairs get their own model) and accessories
    for (const c of [...t.children]) { if (c.userData.slot || c.userData.decorPiece) continue; t.remove(c); disposeObj(c); }
    t.add(inst);
    // L sofa: the chaise collider follows the real model's footprint
    const cc = job.chaiseCollider, fb = inst.userData.fitBox;
    if (cc && fb) { const front = fb.max.z, d = job.fit.d; if (front > d / 2 + 0.1) { cc.oz = (d / 2 + front) / 2; cc.hd = (front - d / 2) / 2; } }
    // accessories ride on the new surfaces (the chairs' table, the sofa's seat …)
    const furn = t.userData.kind === 'furniture' ? t : t.parent;
    if (furn) settleDecor(furn);
  });
  return Promise.allSettled([...jobs, loadDecorModels(built.root, isCurrent)]);
}
function disposeObj(o) { o.traverse((c) => { if (c.geometry) c.geometry.dispose(); }); }

const _zebra = new Map();
function zebraMat(color, h) {
  const k = color + h.toFixed(2);
  if (!_zebra.has(k)) {
    const c = document.createElement('canvas'); c.width = 8; c.height = 256; const g = c.getContext('2d');
    const bands = Math.max(4, Math.round(h / 0.075)); const bh = 256 / bands;
    for (let i = 0; i < bands; i++) { g.fillStyle = color; g.globalAlpha = i % 2 ? 0.35 : 1; g.fillRect(0, i * bh, 8, bh); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
    _zebra.set(k, new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.95, side: THREE.DoubleSide, depthWrite: false }));
  }
  return _zebra.get(k);
}
const _sheer = new Map();
function sheerMat(c) {
  if (!_sheer.has(c)) _sheer.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 1, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }));
  return _sheer.get(c);
}
/**
 * Curtain panel with ripplefold-style waves (擬真度 ⑧): one full wave ≈ 25 cm, depth ≈ 11 cm (single-layer
 * ripplefold ≈ 4–4.5", carrier spacing ≈ 5" — TWOPAGES / Drapery Rods Direct specs), each fold a little different,
 * the folds open slightly towards the hem, hem not perfectly straight. Origin = bottom centre.
 */
function curtain(w, h, material, seed = 1) {
  const waves = Math.max(2, Math.round(w / 0.25)), seg = waves * 14;
  const geo = new THREE.PlaneGeometry(w, h, seg, 12);
  const pos = geo.attributes.position;
  let r = seed * 9301 + 49297; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const amp = Array.from({ length: waves * 2 + 2 }, () => 0.85 + rnd() * 0.3); // per-fold depth variation
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = (x / w + 0.5) * waves * 2;                       // fold index (half waves)
    const k = amp[Math.min(amp.length - 1, Math.max(0, Math.floor(u)))];
    const t = 0.5 - y / h;                                      // 0 top → 1 hem
    pos.setZ(i, Math.sin(u * Math.PI) * 0.052 * k * (1 + 0.15 * t) + 0.006 * Math.sin(x * 17 + seed));
    pos.setY(i, y + (t > 0.97 ? 0.006 * Math.sin(x * 9 + seed * 2) : 0));
  }
  geo.translate(0, h / 2, 0);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/** 2D collision for walk mode: push point (x,z metres) out of walls (except door openings) & furniture */
/** total overlap depth (m) of a walker circle with walls and furniture — 0 = free */
export function penetration(scene3d, x, z, radius = 0.25) {
  let p = 0;
  for (const w of scene3d.wallInfo) {
    const ax = cm(w.a[0]), az = cm(w.a[1]);
    const L = cm(w.L), ux = w.ux, uz = w.uy;
    const rx = x - ax, rz = z - az;
    const along = rx * ux + rz * uz; const across = -rx * uz + rz * ux;
    const ht = cm(w.t) / 2 + radius;
    if (along < -ht || along > L + ht || Math.abs(across) >= ht) continue;
    const alongCm = along * 100;
    if (w.ops.some((o) => (o.type === 'door' || (o.type === 'window' && o.sill === 0 && o.walkable)) && alongCm > o.s + radius * 60 && alongCm < o.e - radius * 60)) continue;
    p += ht - Math.abs(across);
  }
  for (const c of scene3d.colliders) {
    if (c.obj && !c.obj.visible) continue;
    const cb = Math.cos(c.rot), sb = Math.sin(c.rot);
    const [cx, cz] = colliderCentre(c, cb, sb);
    const dx0 = x - cx, dz0 = z - cz;
    const lx = dx0 * cb - dz0 * sb; const lz = dx0 * sb + dz0 * cb;
    const qx = Math.max(-c.hw, Math.min(c.hw, lx)); const qz = Math.max(-c.hd, Math.min(c.hd, lz));
    const dist = Math.hypot(lx - qx, lz - qz);
    if (dist < radius) p += radius - dist + (dist < 1e-5 ? Math.min(c.hw - Math.abs(lx), c.hd - Math.abs(lz)) : 0);
  }
  return p;
}

/** world centre of a collider box; ox/oz = offset in the piece's own frame (e.g. an L sofa's chaise) */
function colliderCentre(c, cb, sb) {
  const ox = c.ox || 0, oz = c.oz || 0;
  return [c.x + ox * cb + oz * sb, c.z - ox * sb + oz * cb];
}

/** push the walker out of walls/furniture; a few passes so two close obstacles settle instead of ping-ponging */
export function resolveCollision(scene3d, x, z, radius = 0.25) {
  for (let pass = 0; pass < 4; pass++) {
    [x, z] = resolveOnce(scene3d, x, z, radius);
    if (penetration(scene3d, x, z, radius) < 1e-4) break;
  }
  return [x, z];
}
function resolveOnce(scene3d, x, z, radius) {
  for (const w of scene3d.wallInfo) {
    const ax = cm(w.a[0]), az = cm(w.a[1]);
    const L = cm(w.L), ux = w.ux, uz = w.uy;
    const rx = x - ax, rz = z - az;
    const along = rx * ux + rz * uz; const across = -rx * uz + rz * ux;
    const ht = cm(w.t) / 2 + radius;
    if (along < -ht || along > L + ht || Math.abs(across) >= ht) continue;
    const alongCm = along * 100;
    const inDoor = w.ops.some((o) => (o.type === 'door' || (o.type === 'window' && o.sill === 0 && o.walkable)) && alongCm > o.s + radius * 60 && alongCm < o.e - radius * 60);
    if (inDoor) continue;
    const push = (across >= 0 ? ht : -ht) - across;
    x += -uz * push; z += ux * push;
  }
  for (const c of scene3d.colliders) {
    if (c.obj && !c.obj.visible) continue;
    // object rotation is Ry(rot): world = (lx·cos + lz·sin, −lx·sin + lz·cos)
    const cb = Math.cos(c.rot), sb = Math.sin(c.rot);
    const [cx, cz] = colliderCentre(c, cb, sb);
    const dx0 = x - cx, dz0 = z - cz;
    const lx = dx0 * cb - dz0 * sb; const lz = dx0 * sb + dz0 * cb;
    const qx = Math.max(-c.hw, Math.min(c.hw, lx)); const qz = Math.max(-c.hd, Math.min(c.hd, lz));
    const ddx = lx - qx, ddz = lz - qz; const dist = Math.hypot(ddx, ddz);
    if (dist >= radius) continue;
    let nlx, nlz;
    if (dist > 1e-5) { nlx = qx + (ddx / dist) * radius; nlz = qz + (ddz / dist) * radius; }
    else {
      const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz);
      if (px < pz) { nlx = Math.sign(lx || 1) * (c.hw + radius); nlz = lz; } else { nlx = lx; nlz = Math.sign(lz || 1) * (c.hd + radius); }
    }
    x = cx + nlx * cb + nlz * sb; z = cz - nlx * sb + nlz * cb;
  }
  return [x, z];
}
