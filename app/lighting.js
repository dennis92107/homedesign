// Architectural lighting: recessed downlights, ceiling coves (perimeter soffit + up-light), wall-wash slots,
// colour temperature in kelvin.
//
// Realtime preview only shows the fixtures (trims, soffits, glowing strips) and keeps the per-room fill light;
// the actual light sources are THREE.SpotLight / THREE.RectAreaLight kept invisible in `groups.fixtureLights`
// and handed to the path tracer (three-gpu-pathtracer supports spot lights with a `radius` and rect area lights).
//
// Style JSON:
//   lighting.kelvin: 3000                                  全屋色溫（K）
//   lighting.room.fixture: false                           不畫房間中央吸頂燈（只留即時預覽的補光）
//   lighting.downlights: { enabled, spacing, inset, intensity, angle, kelvin, trim, skip: [room types] }
//   lighting.cove: { enabled, rooms: [room types], width, drop, intensity, kelvin }
//   rooms.<type|name>.lighting: { kelvin, downlights: false | {...}, cove: true | false | {...} }
//   wallFaces["<room>|<wall>|<P|N>"].wash: true | { intensity, kelvin }      洗牆燈槽（客製層）
import * as THREE from 'three';

const cmToM = (v) => v / 100;

/**
 * Light colour for a colour temperature, white-balanced like an interior photo (camera WB ≈ 4200 K):
 * 3000 K reads warm but not orange, 4000 K ≈ neutral, 5000 K+ slightly cool.
 */
export function kelvinColor(k = 3000, whiteBalance = 4200) {
  const c = rawKelvin(k), wb = rawKelvin(whiteBalance);
  const r = c.r / wb.r, g = c.g / wb.g, b = c.b / wb.b, m = Math.max(r, g, b);
  return new THREE.Color(r / m, g / m, b / m); // linear working-space colour
}
/** black-body colour approximation (Tanner Helland), linear */
function rawKelvin(k) {
  const t = Math.min(40000, Math.max(1000, k)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

function inPoly(poly, [x, y]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToEdges(poly, [x, y]) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    d = Math.min(d, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return d;
}
/** inward offset of a simple polygon by d (cm); mitred corners */
function insetPoly(poly, d) {
  const n = poly.length;
  const edges = poly.map((p, i) => {
    const q = poly[(i + 1) % n]; const dx = q[0] - p[0], dy = q[1] - p[1]; const L = Math.hypot(dx, dy) || 1;
    let nx = -dy / L, ny = dx / L;
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (!inPoly(poly, [m[0] + nx * 0.5, m[1] + ny * 0.5])) { nx = -nx; ny = -ny; }
    return { p: [p[0] + nx * d, p[1] + ny * d], u: [dx / L, dy / L] };
  });
  return edges.map((e, i) => {
    const f = edges[(i + n - 1) % n]; // previous edge
    const den = f.u[0] * e.u[1] - f.u[1] * e.u[0];
    if (Math.abs(den) < 1e-6) return e.p;
    const t = ((e.p[0] - f.p[0]) * e.u[1] - (e.p[1] - f.p[1]) * e.u[0]) / den;
    return [f.p[0] + f.u[0] * t, f.p[1] + f.u[1] * t];
  });
}

function glowMaterial(color, strength = 2) {
  return new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: color, emissiveIntensity: strength, roughness: 1 });
}

/** per-room lighting options after style + room overrides */
export function roomLighting(style, rs, room) {
  const L = style.lighting || {};
  const rl = rs.lighting || {};
  const kelvin = rl.kelvin ?? L.kelvin;
  const dlBase = L.downlights;
  const dlOn = !!dlBase && dlBase.enabled !== false && rl.downlights !== false && !(dlBase.skip || ['balcony']).includes(room.type);
  const coveBase = L.cove;
  const coveOn = !!coveBase && coveBase.enabled !== false && (rl.cove != null ? rl.cove !== false : (coveBase.rooms || []).includes(room.type));
  const skBase = L.skirting;
  const skOn = !!skBase && skBase.enabled !== false && (rl.skirting != null ? rl.skirting !== false : (skBase.rooms || []).includes(room.type));
  return {
    kelvin,
    downlights: dlOn ? { spacing: 120, inset: 55, intensity: 1, angle: 32, trim: '#1f1d1b', ...dlBase, ...(typeof rl.downlights === 'object' ? rl.downlights : {}), kelvin: (typeof rl.downlights === 'object' && rl.downlights.kelvin) || dlBase.kelvin || kelvin || 3000 } : null,
    skirting: skOn ? { height: 2, ...skBase, kelvin: skBase.kelvin || kelvin || 2700 } : null,
    cove: coveOn ? { width: 35, drop: 15, intensity: 1, ...coveBase, ...(typeof rl.cove === 'object' ? rl.cove : {}), kelvin: (typeof rl.cove === 'object' && rl.cove.kelvin) || coveBase.kelvin || kelvin || 2700 } : null,
  };
}

/**
 * Add fixtures for one room.
 * @param ctx { room, opts (from roomLighting), H (m), groups, cut }
 */
export function addRoomFixtures({ room, opts, H, groups }) {
  const poly = room.polygon;
  // ---- recessed downlights ----
  if (opts.downlights) {
    const d = opts.downlights;
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const minD = d.inset * 0.85;
    const pts = [];
    const nx = Math.max(1, Math.round((x1 - x0 - 2 * d.inset) / d.spacing) + 1);
    const ny = Math.max(1, Math.round((y1 - y0 - 2 * d.inset) / d.spacing) + 1);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const x = nx === 1 ? (x0 + x1) / 2 : x0 + d.inset + (i * (x1 - x0 - 2 * d.inset)) / (nx - 1);
      const y = ny === 1 ? (y0 + y1) / 2 : y0 + d.inset + (j * (y1 - y0 - 2 * d.inset)) / (ny - 1);
      if (inPoly(poly, [x, y]) && distToEdges(poly, [x, y]) >= minD) pts.push([x, y]);
    }
    if (!pts.length) { // tiny room: one light at the most interior grid point
      let best = null, bd = -1;
      for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
        const p = [x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * j) / 8];
        if (!inPoly(poly, p)) continue; const dd = distToEdges(poly, p); if (dd > bd) { bd = dd; best = p; }
      }
      if (best) pts.push(best);
    }
    const col = kelvinColor(d.kelvin);
    const trimMat = new THREE.MeshStandardMaterial({ color: d.trim, roughness: 0.5, metalness: 0.3 });
    const glow = glowMaterial(col, 3);
    const yC = opts.ceilingY ?? H;
    for (const [x, y] of pts) {
      const X = cmToM(x), Z = cmToM(y);
      const trim = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.006, 28), trimMat);
      trim.position.set(X, yC - 0.004, Z); groups.ceilings.add(trim);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), glow);
      lens.rotation.x = Math.PI / 2; lens.position.set(X, yC - 0.0075, Z); lens.userData.lightGlow = true; groups.ceilings.add(lens);
      const s = new THREE.SpotLight(col, 9 * d.intensity, 0, THREE.MathUtils.degToRad(d.angle), 0.65, 2);
      s.radius = 0.03; // soft-edged shadows in the path tracer
      s.position.set(X, yC - 0.02, Z); s.target.position.set(X, 0, Z);
      s.visible = false; s.userData.artificial = true; s.userData.base = s.intensity;
      groups.fixtureLights.add(s, s.target);
    }
  }
  // ---- ceiling cove: soffit (降板) along the room's WALLED edges, hidden up-light on its inner edge ----
  // Open edges (living ↔ dining with no wall between) get no soffit, so an open-plan space reads as one ceiling.
  if (opts.cove) {
    const c = opts.cove, W = c.width, D = cmToM(c.drop);
    const n = poly.length;
    const walled = poly.map((p, i) => edgeHasWall(p, poly[(i + 1) % n], opts.walls || []));
    const col = kelvinColor(c.kelvin);
    const glow = glowMaterial(col, 2.5);
    const add = (mesh, glowing) => { mesh.userData = glowing ? { lightGlow: true } : { kind: 'ceiling', room: room.name }; groups.ceilings.add(mesh); return mesh; };
    for (let i = 0; i < n; i++) {
      if (!walled[i]) continue;
      const p = poly[i], q = poly[(i + 1) % n];
      const dx = q[0] - p[0], dy = q[1] - p[1]; const Lcm = Math.hypot(dx, dy);
      if (Lcm < 30) continue;
      const ux = dx / Lcm, uy = dy / Lcm;
      let nx = -uy, ny = ux; // into the room
      const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (!inPoly(poly, [mid[0] + nx, mid[1] + ny])) { nx = -nx; ny = -ny; }
      // corners: the next soffit owns the shared W×W corner square (no overlapping coplanar boxes)
      const s0 = 0, s1 = Lcm - (walled[(i + 1) % n] ? W : 0);
      const sm = (s0 + s1) / 2, len = cmToM(s1 - s0);
      const at = (s, o) => [cmToM(p[0] + ux * s + nx * o), cmToM(p[1] + uy * s + ny * o)];
      const rotY = -Math.atan2(uy, ux);
      const [bx, bz] = at(sm, W / 2);
      const box = add(new THREE.Mesh(new THREE.BoxGeometry(len, D, cmToM(W)), opts.ceilingMat));
      box.position.set(bx, H - D / 2 - 0.002, bz); box.rotation.y = rotY; box.castShadow = true; box.receiveShadow = true;
      // LED on a ledge just inside the soffit edge, hidden behind a lip
      const off = 6, slen = Math.max(0.1, len - 0.1);
      const [lx, lz] = at(sm, W + off + 5);
      const lip = add(new THREE.Mesh(new THREE.BoxGeometry(slen + 0.08, 0.07, 0.015), opts.ceilingMat));
      lip.position.set(lx, H - D + 0.005, lz); lip.rotation.y = rotY;
      const [gx, gz] = at(sm, W + off / 2 + 3);
      const ledge = add(new THREE.Mesh(new THREE.BoxGeometry(slen + 0.08, 0.012, cmToM(off + 6)), opts.ceilingMat));
      ledge.position.set(gx, H - D - 0.004, gz); ledge.rotation.y = rotY;
      const [cx, cz] = at(sm, W + off); const y = H - D + 0.025;
      const strip = add(new THREE.Mesh(new THREE.BoxGeometry(slen, 0.006, 0.02), glow), true);
      strip.position.set(cx, y - 0.015, cz); strip.rotation.y = rotY;
      const a = new THREE.RectAreaLight(col, 24 * c.intensity, slen, 0.03);
      a.position.set(cx, y, cz);
      a.up.set(nx, 0, ny);
      a.lookAt(cx, y + 1, cz); // shine up onto the higher central ceiling
      a.visible = false; a.userData.artificial = true; a.userData.base = a.intensity;
      groups.fixtureLights.add(a);
    }
  }
}

/** floor-level LED strip (踢腳燈條) along the walled edges of a room: glow only (realtime + path-traced emissive) */
export function addSkirting({ room, opts, groups }) {
  const sk = opts.skirting; if (!sk) return;
  const poly = room.polygon, n = poly.length;
  const glow = glowMaterial(kelvinColor(sk.kelvin), 2.2);
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1]; const L = Math.hypot(dx, dy); if (L < 40) continue;
    const ux = dx / L, uy = dy / L; let nx = -uy, ny = ux;
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (!inPoly(poly, [mid[0] + nx, mid[1] + ny])) { nx = -nx; ny = -ny; }
    // only where a wall really stands: a room edge can be walled for part of its length only
    // (e.g. a corridor opening into the living room) — the strip must stop at the wall end and at doors
    for (const [s0, s1, t] of walledSpans(p, q, L, opts)) {
      const len = s1 - s0; if (len < 15) continue;
      const sm = (s0 + s1) / 2, off = t / 2 + 1.2; // 1.2 cm off the wall face
      const strip = new THREE.Mesh(new THREE.BoxGeometry(cmToM(len), cmToM(sk.height), 0.008), glow);
      strip.position.set(cmToM(p[0] + ux * sm + nx * off), cmToM(sk.height / 2 + 0.3), cmToM(p[1] + uy * sm + ny * off));
      strip.rotation.y = -Math.atan2(uy, ux); strip.userData.lightGlow = true;
      groups.floors.add(strip); // floor-level: stays visible in the dollhouse view
    }
  }
}

/** parts [s0, s1, thickness] (cm along polygon edge p→q) that have a wall face behind them,
 *  minus door / floor-level openings; trimmed at the room corners (perpendicular wall face) and at free wall ends */
function walledSpans(p, q, L, opts) {
  const walls = opts.walls || [], openings = opts.openings || [];
  const ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L;
  const along = (pt) => (pt[0] - p[0]) * ux + (pt[1] - p[1]) * uy;
  const spans = [], cuts = [];
  walls.forEach((w, wi) => {
    if (w.railing) return;
    const [ax, ay] = w.a, [bx, by] = w.b; const wl = Math.hypot(bx - ax, by - ay); if (wl < 1) return;
    const wx = (bx - ax) / wl, wy = (by - ay) / wl;
    if (Math.abs(wx * ux + wy * uy) < 0.995) return; // not parallel
    const off = (pt) => Math.abs((pt[0] - ax) * -wy + (pt[1] - ay) * wx);
    if (off(p) > 6 || off(q) > 6) return;
    const sa = along(w.a), sb = along(w.b);
    const lo = Math.max(0, Math.min(sa, sb)), hi = Math.min(L, Math.max(sa, sb)); if (hi - lo < 1) return;
    const t = w.thickness || (w.exterior ? opts.extT || 20 : opts.defT || 12);
    spans.push([lo, hi, t]);
    for (const o of openings) {
      if (o.wall !== wi || !(o.type === 'door' || (o.sill || 0) < 5)) continue; // doors + floor-level windows
      const c = Math.min(sa, sb) === sa ? sa + o.at : sa - o.at; // opening centre along p→q
      cuts.push([c - (o.width || 90) / 2 - 3, c + (o.width || 90) / 2 + 3]); // + frame/trim
    }
  });
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) { const m = merged[merged.length - 1]; if (m && s[0] <= m[1] + 1) { m[1] = Math.max(m[1], s[1]); m[2] = Math.max(m[2], s[2]); } else merged.push([...s]); }
  // corner at a polygon vertex → stop at the perpendicular wall's face; free wall end → just inside the wall end
  const trimmed = merged.map(([a, b, t]) => [a <= 2 ? a + t / 2 + 2 : a + 2, b >= L - 2 ? b - t / 2 - 2 : b - 2, t]);
  let out = trimmed;
  for (const [c0, c1] of cuts) {
    out = out.flatMap(([a, b, t]) => (c1 <= a || c0 >= b) ? [[a, b, t]] : [[a, Math.min(b, c0), t], [Math.max(a, c1), b, t]].filter(([x, y]) => y - x > 0));
  }
  return out;
}

/** is there a wall running along polygon edge p→q (cm)? */
function edgeHasWall(p, q, walls) { return !!wallAlong(p, q, walls); }
function wallAlong(p, q, walls) {
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  for (const w of walls) {
    const [ax, ay] = w.a, [bx, by] = w.b; const wl = Math.hypot(bx - ax, by - ay);
    if (wl < 1) continue;
    const ux = (bx - ax) / wl, uy = (by - ay) / wl;
    const off = (pt) => Math.abs((pt[0] - ax) * -uy + (pt[1] - ay) * ux); // distance to the wall line
    if (off(p) > 6 || off(q) > 6) continue;
    const s = (pt) => (pt[0] - ax) * ux + (pt[1] - ay) * uy;
    const lo = Math.max(0, Math.min(s(p), s(q))), hi = Math.min(wl, Math.max(s(p), s(q)));
    if (hi - lo >= L * 0.5) return w;
  }
  return null;
}

/** wall-wash slot along one wall face (custom layer: wallFaces[key].wash) */
export function addWallWash({ wall, side, room, H, groups, opts = {}, style }) {
  const t = wall.t;
  const sgn = side === 'P' ? 1 : -1;
  const nx = -wall.uy * sgn, ny = wall.ux * sgn; // from the wall face into the room
  // the part of the wall that borders this room
  let s0 = null, s1 = null;
  for (let s = 5; s < wall.L - 5; s += 5) {
    const p = [wall.a[0] + wall.ux * s + nx * (t / 2 + 10), wall.a[1] + wall.uy * s + ny * (t / 2 + 10)];
    if (inPoly(room.polygon, p)) { if (s0 == null) s0 = s; s1 = s; }
  }
  if (s0 == null || s1 - s0 < 40) return;
  const kelvin = opts.kelvin || style.lighting?.kelvin || 3000;
  const col = kelvinColor(kelvin);
  const len = cmToM(s1 - s0 - 10);
  const sm = (s0 + s1) / 2;
  const fx = wall.a[0] + wall.ux * sm + nx * (t / 2), fy = wall.a[1] + wall.uy * sm + ny * (t / 2); // face point (cm)
  const rotY = -Math.atan2(wall.uy, wall.ux);
  // dark shadow-gap slot in the ceiling + glowing strip
  const slot = new THREE.Mesh(new THREE.BoxGeometry(len + 0.1, 0.004, 0.1), new THREE.MeshStandardMaterial({ color: '#2a2724', roughness: 0.9 }));
  slot.position.set(cmToM(fx + nx * 5), H - 0.004, cmToM(fy + ny * 5)); slot.rotation.y = rotY; groups.ceilings.add(slot);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(len, 0.004, 0.02), glowMaterial(col, 3));
  strip.position.set(cmToM(fx + nx * 6), H - 0.0075, cmToM(fy + ny * 6)); strip.rotation.y = rotY; strip.userData.lightGlow = true;
  groups.ceilings.add(strip);
  const a = new THREE.RectAreaLight(col, 28 * (opts.intensity ?? 1), len, 0.04);
  const ax = cmToM(fx + nx * 8), az = cmToM(fy + ny * 8), ay = H - 0.03;
  a.position.set(ax, ay, az);
  a.lookAt(cmToM(fx - nx * 2), ay - 1.6, cmToM(fy - ny * 2)); // grazing down the wall
  a.visible = false; a.userData.artificial = true; a.userData.base = a.intensity;
  groups.fixtureLights.add(a);
}

/**
 * Realtime light pool: a FIXED number of spot / rect-area lights (so shaders never recompile) that take over the
 * fixture lights nearest to the viewer. Unused slots get intensity 0. No shadow maps (cost).
 * To avoid lights popping on/off while walking: lights fade in/out (~0.4 s) and there is hysteresis — a light that is
 * already on stays on until it drops out of the nearest 1.5×N (Godot's "distance fade" idea for limited light pools).
 */
/** a nested lamp counts only when its furniture (and every parent) is shown — the lamp light itself stays invisible */
function isShown(o) { for (let p = o.parent; p; p = p.parent) if (!p.visible) return false; return true; }

export function createLightPool(scene, { spots = 16, areas = 4, points = 6, fade = 0.4 } = {}) {
  const mk = (kind) => {
    const isArea = kind === 'area';
    const l = isArea ? new THREE.RectAreaLight(0xffffff, 0, 1, 0.05) : kind === 'point' ? new THREE.PointLight(0xffffff, 0, 0, 2) : new THREE.SpotLight(0xffffff, 0, 0, 0.5, 0.65, 2);
    if (kind === 'spot') { l.castShadow = false; scene.add(l.target); }
    l.userData.realtimeOnly = true; scene.add(l); // always visible: toggling visibility changes the light count → shader recompile
    return { light: l, fixture: null, cur: 0, target: 0 };
  };
  const S = Array.from({ length: spots }, () => mk('spot')), A = Array.from({ length: areas }, () => mk('area')), P = Array.from({ length: points }, () => mk('point'));
  const _p = new THREE.Vector3();
  let last = performance.now();
  const pick = (slots, cands, center) => {
    const ranked = cands.map((o) => [o, o.getWorldPosition(_p).distanceToSquared(center)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    const n = slots.length, keepZone = new Set(ranked.slice(0, Math.ceil(n * 1.5)));
    const want = new Set(slots.filter((s) => s.fixture && s.target > 0 && keepZone.has(s.fixture)).map((s) => s.fixture));
    for (const o of ranked) { if (want.size >= n) break; want.add(o); }
    for (const s of slots) if (s.fixture && !want.has(s.fixture)) s.target = 0;      // fade out what is no longer wanted
    for (const o of want) {
      if (slots.some((s) => s.fixture === o)) { slots.find((s) => s.fixture === o).target = 1; continue; }
      const free = slots.find((s) => !s.fixture) || slots.find((s) => s.target === 0 && s.cur < 0.05);
      if (!free) continue; // no slot yet: it gets one as soon as another light has faded out
      free.fixture = o; free.cur = 0; free.target = 1;
      const l = free.light; l.color.copy(o.color); o.getWorldPosition(l.position); // lamps are nested in furniture
      if (o.isSpotLight) { l.angle = o.angle; l.penumbra = o.penumbra; l.decay = o.decay; l.target.position.copy(o.target.position); l.target.updateMatrixWorld(); }
      else { l.width = o.width; l.height = o.height; l.quaternion.copy(o.quaternion); }
    }
  };
  return {
    /** @returns true while something changed (caller restarts still-frame accumulation) */
    /** lamps: point lights nested in furniture (table / floor lamps, sconces, pendants), lit with lampScale (0 by day) */
    update(fixtures, center, scale = 1, enabled = true, lamps = [], lampScale = 0, { areas = true } = {}) {
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
      const lights = enabled && fixtures ? fixtures.children.filter((o) => o.isLight) : [];
      const lampOn = lampScale > 0 ? lamps.filter((o) => isShown(o)) : [];
      const alive = new Set([...lights, ...lampOn]);
      for (const s of [...S, ...A, ...P]) if (s.fixture && !alive.has(s.fixture)) s.target = 0; // scene was rebuilt / lamps off
      pick(S, lights.filter((o) => o.isSpotLight), center);
      pick(A, areas ? lights.filter((o) => o.isRectAreaLight) : [], center); // areas: false = baked (bake.js rectDirect)
      pick(P, lampOn, center);
      let moving = false;
      for (const s of [...S, ...A, ...P]) {
        if (s.cur !== s.target) { moving = true; const step = dt / fade; s.cur = s.target > s.cur ? Math.min(s.target, s.cur + step) : Math.max(s.target, s.cur - step); }
        if (s.cur <= 0 && s.target === 0) s.fixture = null;
        const base = s.fixture?.userData.base ?? 0;
        if (s.fixture?.userData.lamp) s.fixture.getWorldPosition(s.light.position); // follows a dragged piece
        s.light.intensity = base * (s.fixture?.userData.lamp ? lampScale : scale) * s.cur * s.cur * (3 - 2 * s.cur); // smoothstep
      }
      if (scale !== this._scale || lampScale !== this._lampScale) { this._scale = scale; this._lampScale = lampScale; moving = true; }
      return moving;
    },
    reset() { for (const s of [...S, ...A, ...P]) { s.fixture = null; s.cur = s.target = 0; s.light.intensity = 0; } },
    /** skip the fade (screenshots): every slot jumps to its target; the next update() applies the intensities */
    settle() { for (const s of [...S, ...A, ...P]) s.cur = s.target; },
  };
}
