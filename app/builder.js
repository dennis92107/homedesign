// Plan JSON + Style JSON -> THREE scene graph.
// Plan coordinates are centimetres, origin top-left of the drawing, x → right, y → down.
// World: X = x/100, Z = y/100, Y up (metres).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { surfaceMaterial, buildRoleMaterials, withOverrides } from './materials.js';
import { FURNITURE, DEFAULT_SIZES, NON_SOLID, pendant, boxGeo } from './furniture.js';
import { modelInstance, modelEntry, MODEL_DEFAULTS, MODEL_FIT } from './assets.js';
import * as TX from './textures.js';

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

/** Resolve the effective style for a room type (style.rooms[type] / style.rooms[name] overrides) */
function roomStyle(style, room) {
  if (!room) return {};
  const r = style.rooms || {};
  return { ...(r[room.type] || {}), ...(r[room.name] || {}) };
}

/**
 * @param opts.cut  cut height in cm for the dollhouse view (walls, doors, windows are built only up to it); null = full height
 */
export function buildScene(plan, style, opts = {}) {
  const root = new THREE.Group(); root.name = 'house';
  const groups = {
    floors: new THREE.Group(), walls: new THREE.Group(), openings: new THREE.Group(),
    ceilings: new THREE.Group(), furniture: new THREE.Group(), lights: new THREE.Group(), labels: new THREE.Group(),
    underlay: new THREE.Group(),
  };
  for (const [k, g] of Object.entries(groups)) { g.name = k; root.add(g); }

  const Hcm = plan.wallHeight || 280;
  const H = cm(Hcm);
  const cut = opts.cut ? Math.min(opts.cut, Hcm) : null;
  const Hc = cut ?? Hcm; // build height in cm
  const defT = plan.wallThickness || 12;
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
    const floor = new THREE.Mesh(geo, mat(rs.floor || defaultFloor, '#c49a6c'));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.y = 0.001;
    floor.userData = { kind: 'floor', room: room.name };
    groups.floors.add(floor);

    // ceiling: "#hex" or a surface spec (paint / woodPanel / concrete …)
    const cspec = rs.ceiling ?? style.ceiling ?? ceilingColor;
    const cs = typeof cspec === 'string' ? { material: 'paint', color: cspec } : { material: 'paint', ...cspec, color: cspec.color || ceilingColor };
    const cmat = mat({ ...cs, pbr: cs.pbr ?? (cs.material === 'paint' ? false : undefined) }, ceilingColor, 'ceiling');
    const ceil = new THREE.Mesh(geo, cmat);
    ceil.rotation.x = -Math.PI / 2; ceil.position.y = H; ceil.castShadow = true;
    ceil.userData = { kind: 'ceiling', room: room.name };
    groups.ceilings.add(ceil);

    const [cx, cy] = room.light ? [room.light.x, room.light.y] : centroid(room.polygon);
    if (roomLight.enabled !== false && room.type !== 'balcony') {
      const pl = new THREE.PointLight(roomLight.color || '#ffe2bd', roomLight.intensity ?? 4, 0, 2);
      pl.position.set(cm(cx), H - 0.3, cm(cy));
      pl.userData.base = roomLight.intensity ?? 4;
      groups.lights.add(pl);
      const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 32), M.lampshade);
      fixture.position.set(cm(cx), H - 0.015, cm(cy));
      groups.ceilings.add(fixture);
    }

    const area = polygonArea(room.polygon) / 10000;
    const div = document.createElement('div');
    div.className = 'room-label';
    div.innerHTML = `<b>${room.name}</b><span>${area.toFixed(1)} m² · ${(area / 3.3058).toFixed(1)} 坪</span>`;
    const lab = new CSS2DObject(div);
    const [lx, ly] = room.label ? [room.label.x, room.label.y] : centroid(room.polygon);
    lab.position.set(cm(lx), 0.1, cm(ly));
    groups.labels.add(lab);
  }

  // ---------- walls ----------
  const wallInfo = [];
  const exteriorMat = mat(style.exteriorWall || '#d9d6d0', '#d9d6d0', 'wall');
  const defaultWall = style.wall || { material: 'paint', color: '#f2f0eb' };
  const baseH = cm(style.baseboardHeight ?? 8);

  (plan.walls || []).forEach((w, wi) => {
    const [ax, ay] = w.a; const [bx, by] = w.b;
    const t = w.thickness || (w.exterior ? plan.exteriorThickness || 20 : defT);
    const dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy);
    if (L < 1) return;
    const ux = dx / L, uy = dy / L; const nx = -uy, ny = ux; // +Z side normal in plan coords
    const probeAt = (s, side) => roomAt(plan, [ax + ux * s + nx * side * (t / 2 + 8), ay + uy * s + ny * side * (t / 2 + 8)]);
    // per-face override (one wall side inside one room) > room override > global wall
    const sideMat = (room, side) => {
      if (!room) return exteriorMat;
      const face = style.wallFaces?.[`${room.name}|${wi}|${side}`];
      return mat(face || roomStyle(style, room).wall || defaultWall, '#f2f0eb', 'wall');
    };
    const ext = w.extend ?? t / 2;
    const start = -ext, end = L + ext;
    // A long wall can border several rooms: split it into spans with constant rooms on both sides.
    const spans = [];
    const STEP = 5;
    for (let s = start; s < end; s += STEP) {
      const c = Math.min(Math.max(s + STEP / 2, 1), L - 1);
      const rp = probeAt(c, 1), rn = probeAt(c, -1);
      const last = spans[spans.length - 1];
      if (last && last.rp === rp && last.rn === rn) last.e = Math.min(end, s + STEP);
      else spans.push({ s, e: Math.min(end, s + STEP), rp, rn, mP: sideMat(rp, 'P'), mN: sideMat(rn, 'N') });
    }
    const ops = (plan.openings || []).filter((o) => o.wall === wi).map((o) => {
      const width = o.width || (o.type === 'door' ? 90 : 120);
      const sill = o.sill ?? (o.type === 'window' ? 90 : 0);
      const height = o.height || (o.type === 'door' ? 210 : 130);
      return { ...o, s: o.at - width / 2, e: o.at + width / 2, width, sill, height };
    }).sort((a, b) => a.s - b.s);
    wallInfo.push({ a: w.a, b: w.b, t, L, ux, uy, ops });

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

    const piece = (x0, x1, y0, y1) => {
      y1 = Math.min(y1, Hc, w.height || Infinity); // w.height: low wall / parapet
      if (y1 - y0 < 0.5) return;
      for (const sp of spans) {
        const a0 = Math.max(x0, sp.s), a1 = Math.min(x1, sp.e);
        const len = cm(a1 - a0), hgt = cm(y1 - y0);
        if (len <= 0.001 || hgt <= 0.001) continue;
        const m = new THREE.Mesh(boxGeo(len, hgt, cm(t)), [sp.mP, sp.mP, M.cap, M.cap, sp.mP, sp.mN]);
        m.position.set(cm((a0 + a1) / 2), cm((y0 + y1) / 2), 0);
        m.castShadow = true; m.receiveShadow = true;
        m.userData = { kind: 'wall', wall: wi, P: sp.rp?.name ?? null, N: sp.rn?.name ?? null };
        wallGroup.add(m);
        // baseboards on room-facing sides of floor-level pieces
        if (y0 === 0 && baseH > 0) {
          for (const [room, side] of [[sp.rp, 1], [sp.rn, -1]]) {
            if (!room || room.type === 'bathroom' || room.type === 'balcony') continue;
            const bb = new THREE.Mesh(boxGeo(len, baseH, 0.012), M.baseboard);
            bb.position.set(cm((a0 + a1) / 2), baseH / 2, side * (cm(t) / 2 + 0.006));
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
      const oh = Math.min(fullH, cm(Hc) - sill); const clipped = oh < fullH - 1e-4;
      if (o.type === 'door') {
        const fw = 0.04;
        for (const s of [-1, 1]) {
          const f = new THREE.Mesh(boxGeo(fw, oh, T + 0.02), M.frame); f.position.set(cx + s * (wd / 2 - fw / 2), oh / 2, 0); og.add(f);
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
            for (const endS of [-1, 1]) {
              const c = curtain(panelW, topY - drop, M.curtain);
              c.position.set(cx + endS * (wd / 2 + 0.17 - panelW / 2), drop, side * (T / 2 + 0.12));
              og.add(c);
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
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    })(),
    artPalette: style.decor?.artPalette || style.palette || ['#c96f4a', '#e3c9a8', '#36454f', '#f4efe6'],
    bookMats: (style.decor?.bookColors || ['#8c6e54', '#c9b79c', '#3f4e4f', '#a65f46', '#e5ddd0', '#6b7b5b']).map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 })),
  };
  const modelJobs = [];
  const byId = new Map();
  for (const it of plan.furniture || []) {
    const fn = FURNITURE[it.type];
    if (!fn) { console.warn('unknown furniture type', it.type); continue; }
    if (it.type === 'rug' && style.decor?.rugs === false) continue;
    if (it.type === 'plant' && style.decor?.plants === false) continue;
    const [dw, dd] = DEFAULT_SIZES[it.type] || [60, 60];
    const item = { ...it, w: cm(it.w ?? dw), d: cm(it.d ?? dd), h: it.h != null ? cm(it.h) : undefined };
    const Mi = withOverrides(M, it.colors);
    const variant = { ...S_, ...(it.variant || {}) };
    // record which material roles this piece uses, so the editor can offer exactly those colour pickers
    const roles = new Set();
    const MiTracked = new Proxy(Mi, { get(t, k) { if (typeof k === 'string') roles.add(k); return t[k]; } });
    const obj = fn(item, MiTracked, variant, ctx);
    obj.position.set(cm(it.x), cm(it.elevation || 0), cm(it.y));
    obj.rotation.y = -((it.rotation || 0) * Math.PI) / 180;
    obj.userData = { kind: 'furniture', id: it.id, item: it, roles };
    obj.visible = !it.hidden;
    if (it.id) byId.set(it.id, obj);
    groups.furniture.add(obj);
    if (!NON_SOLID.has(it.type) && it.solid !== false && !it.elevation) {
      colliders.push({ obj, x: cm(it.x), z: cm(it.y), hw: item.w / 2, hd: item.d / 2, rot: -((it.rotation || 0) * Math.PI) / 180 });
    }
    // real 3D model replacement (whole piece, or sub-slots such as dining chairs)
    const modelFor = (type, explicit) => {
      if (explicit === false) return null;
      const withFit = (spec) => {
        if (!spec) return null;
        const e = modelEntry(spec.id) || {};
        return { ...(MODEL_FIT[spec.id] || {}), ...(e.by ? { by: e.by } : {}), rotate: e.rotate || 0, ...spec };
      };
      if (typeof explicit === 'string') return withFit({ id: explicit });
      const sm = style.models?.[type];
      if (sm === false) return null;
      if (typeof sm === 'string') return withFit({ id: sm });
      if (sm && typeof sm === 'object') return withFit(sm);
      return withFit(MODEL_DEFAULTS[type]);
    };
    const tintFor = (type, explicit) => {
      const role = explicit ?? style.modelTint?.[type];
      if (!role) return null;
      if (role.startsWith('#')) return new THREE.Color(role);
      const m = Mi[role];
      return m?.userData.baseColor ? new THREE.Color(m.userData.baseColor) : null;
    };
    const whole = modelFor(it.type, it.model);
    const fitH = item.h ?? (it.type === 'plant' ? (it.kind === 'tall' ? 1.5 : 0.95) : undefined);
    if (whole) {
      obj.userData.modelId = whole.id;
      modelJobs.push({ target: obj, type: it.type, spec: whole, fit: { w: item.w, d: item.d, h: fitH, by: whole.by, rotate: (whole.rotate || 0) + (it.modelRotate || 0), colors: it.modelColors, variant: it.modelVariant }, tint: tintFor(it.type, it.tint), tintFilter: whole.tintFilter });
    }
    obj.traverse((o) => {
      if (o.userData.slot && o !== obj) {
        const spec = modelFor(o.userData.slot.type, it.slotModel);
        if (spec) modelJobs.push({ target: o, type: o.userData.slot.type, spec, fit: { w: o.userData.slot.w, d: o.userData.slot.d, h: o.userData.slot.h, rotate: spec.rotate, colors: it.slotModelColors, variant: it.slotModelVariant }, tint: tintFor(o.userData.slot.type, it.slotTint) });
      }
    });

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
  return Promise.allSettled(built.modelJobs.map(async (job) => {
    const inst = await modelInstance(job.spec.id, { ...job.fit, tint: job.tint, tintFilter: job.tintFilter });
    if (!isCurrent()) return;
    const t = job.target;
    // keep the procedural decor that sits on top of tables? no — replace children entirely
    for (const c of [...t.children]) { t.remove(c); disposeObj(c); }
    t.add(inst);
  }));
}
function disposeObj(o) { o.traverse((c) => { if (c.geometry) c.geometry.dispose(); }); }

function curtain(w, h, material) {
  const geo = new THREE.PlaneGeometry(w, h, 32, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin((x / w) * Math.PI * 7) * 0.035);
  }
  geo.translate(0, h / 2, 0);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/** 2D collision for walk mode: push point (x,z metres) out of walls (except door openings) & furniture */
export function resolveCollision(scene3d, x, z, radius = 0.25) {
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
    const dx0 = x - c.x, dz0 = z - c.z;
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
    x = c.x + nlx * cb + nlz * sb; z = c.z - nlx * sb + nlz * cb;
  }
  return [x, z];
}
