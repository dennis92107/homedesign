// 3D 畫面直接拖曳 / 旋轉家具（鳥瞰、平面俯視；漫遊模式可拖已選取的家具）
//
// 互動（參考 Houzz / Planner 5D 這類室內設計工具）：
//   1. 先點一下家具選取 → 再按住拖曳就能沿地面移動（拖未選取的家具仍是轉動視角，避免誤動）
//   2. 地面圓環＝旋轉把手，拖圓環轉向（每 15° 吸附）
//   3. 吸附：5 cm 格線；離牆 15 cm 內自動貼牆，角度差 12° 內轉正；沙發、床、櫃子等大致背對牆時會轉成背貼牆
//      按住 Shift = 自由移動 / 自由旋轉（不吸附）
//   4. 選取時顯示到四周牆面的距離；與牆或其他家具重疊時外框變紅（只警告不阻擋）
//   5. 方向鍵微調 1 cm（Shift 10 cm）、R 轉 90°（Shift+R 反轉）、Esc 取消選取
// 拖曳中只移動該件物件（不重建場景），放開後才寫進客製層（designs/<plan>.json）。
// 輔助線畫在獨立的 overlay 場景，不會被真實渲染（路徑追蹤）烘進去、也不會被點選。
import * as THREE from 'three';
import { DEFAULT_SIZES, NON_SOLID } from './furniture.js';
import { setFurniturePatch, TYPE_LABELS } from './design.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const GRID = 5; // cm
const SNAP_WALL = 15; // cm：離牆多近就貼牆
const SQUARE_UP = 12; // °：和牆差幾度內自動轉正
// 這些家具貼牆時自動「背靠牆」
const BACK_TO_WALL = new Set(['sofa', 'bed', 'tv_cabinet', 'sideboard', 'wardrobe', 'bookshelf', 'desk', 'shoe_cabinet', 'kitchen_counter', 'fridge', 'vanity', 'toilet', 'art', 'mirror', 'nightstand']);
const COL = { normal: 0xff7a2f, warn: 0xe5484d, dist: 0x2a7de1 };
const norm = (deg) => ((Math.round(deg * 10) / 10) % 360 + 360) % 360;

/**
 * api: { renderer, camera, viewport, state, commit, pushUndo, onMoved(), ptOn(), planEditorVisible(), setStatus }
 */
export function createFurnitureDrag(api) {
  const { renderer, camera, viewport, state } = api;
  const dom = renderer.domElement;
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // ---------- overlay helpers ----------
  const overlay = new THREE.Scene();
  const group = new THREE.Group(); overlay.add(group); group.visible = false;
  const lineMat = (color, dashed) => (dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.06, gapSize: 0.045, depthTest: false, transparent: true, toneMapped: false })
    : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, toneMapped: false }));
  const footprint = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3)), lineMat(COL.normal));
  const distLines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24), 3)), lineMat(COL.dist, true));
  const ringGroup = new THREE.Group();
  const flatMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.08, 72), flatMat(COL.normal, 0.6));
  const ringHit = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.25, 48), flatMat(0, 0)); ringHit.material.visible = false; // fatter invisible hit area
  const knob = new THREE.Mesh(new THREE.CircleGeometry(0.075, 24), flatMat(COL.normal, 0.95));
  for (const m of [ring, ringHit, knob]) { m.rotation.x = -Math.PI / 2; ringGroup.add(m); }
  group.add(footprint, distLines, ringGroup);
  group.traverse((o) => { o.renderOrder = 1000; o.frustumCulled = false; });

  const hud = document.createElement('div'); hud.className = 'fd-hud';
  const distLabels = [0, 1, 2, 3].map(() => hud.appendChild(Object.assign(document.createElement('span'), { className: 'fd-dist' })));
  const info = hud.appendChild(Object.assign(document.createElement('span'), { className: 'fd-info' }));
  viewport.appendChild(hud);

  // ---------- data helpers ----------
  const itemOf = (id) => state.eff?.plan.furniture.find((f) => f.id === id);
  const dims = (it) => { const [dw, dd] = DEFAULT_SIZES[it.type] || [60, 60]; return { w: it.w ?? dw, d: it.d ?? dd }; };
  const poseOf = (it) => ({ x: it.x, y: it.y, rot: it.rotation || 0 });
  const axes = (rot) => { const r = rot * D2R; return { lx: [Math.cos(r), Math.sin(r)], lz: [-Math.sin(r), Math.cos(r)] }; }; // lz = 正面方向（圖面座標）
  const walls = () => state.built?.wallInfo || [];
  const enabled = () => !!state.built && !api.ptOn();
  const visibleChain = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };

  // ---------- snapping ----------
  /** half-extent of the rotated footprint along unit direction (dx,dy) */
  const extent = (size, rot, dx, dy) => { const { lx, lz } = axes(rot); return (size.w / 2) * Math.abs(lx[0] * dx + lx[1] * dy) + (size.d / 2) * Math.abs(lz[0] * dx + lz[1] * dy); };
  function snapPose(raw, size, type, free) {
    if (free) return { ...raw };
    let { x, y, rot } = raw;
    x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID;
    const used = [];
    const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
    for (let pass = 0; pass < 2; pass++) {
      const cands = [];
      for (const w of walls()) {
        const nx = -w.uy, ny = w.ux;
        if (used.some((u) => Math.abs(u.nx * nx + u.ny * ny) > 0.3)) continue; // second wall must be roughly perpendicular (corner)
        const rx = x - w.a[0], ry = y - w.a[1];
        const along = rx * w.ux + ry * w.uy, across = rx * nx + ry * ny;
        const ea = extent(size, rot, w.ux, w.uy);
        if (along < -ea * 0.5 || along > w.L + ea * 0.5) continue; // not alongside this wall
        const gap = Math.abs(across) - w.t / 2 - extent(size, rot, nx, ny);
        if (gap > SNAP_WALL || gap < -Math.min(extent(size, rot, nx, ny), 30)) continue;
        const s = Math.sign(across) || 1;
        // rotation whose front points away from this wall: (-sin r, cos r) = s·n
        const face = norm(Math.atan2(-s * nx, s * ny) * R2D);
        cands.push({ w, nx, ny, across, gap, s, face, backs: angDiff(face, rot) < 45 });
      }
      if (!cands.length) break;
      // prefer the wall the piece already has its back to (so a sofa slid into a corner doesn't swing round)
      const pool = BACK_TO_WALL.has(type) && cands.some((c) => c.backs) ? cands.filter((c) => c.backs) : cands;
      const best = pool.reduce((a, c) => (Math.abs(c.gap) < Math.abs(a.gap) ? c : a));
      const s = best.s;
      if (pass === 0) {
        // turn the back flat against the wall only when it's already roughly backing it
        // (sliding a sofa sideways into a wall must not swing it round 90°)
        if (BACK_TO_WALL.has(type) && angDiff(best.face, rot) < 50) rot = best.face;

        const wallDeg = Math.atan2(best.w.uy, best.w.ux) * R2D;
        const rel = (((rot - wallDeg) % 90) + 90) % 90; const off = rel > 45 ? rel - 90 : rel;
        if (Math.abs(off) < SQUARE_UP) rot = norm(rot - off);
      }
      const shift = s * (best.w.t / 2 + extent(size, rot, best.nx, best.ny)) - best.across;
      x += best.nx * shift; y += best.ny * shift;
      used.push(best);
    }
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, rot };
  }

  // ---------- overlap check (2D oriented boxes, cm) ----------
  function obb(cx, cy, rot, hx, hy) { const r = rot * D2R; return { cx, cy, ux: Math.cos(r), uy: Math.sin(r), hx, hy }; }
  function overlap(A, B) {
    for (const [ax, ay] of [[A.ux, A.uy], [-A.uy, A.ux], [B.ux, B.uy], [-B.uy, B.ux]]) {
      const pa = A.hx * Math.abs(A.ux * ax + A.uy * ay) + A.hy * Math.abs(-A.uy * ax + A.ux * ay);
      const pb = B.hx * Math.abs(B.ux * ax + B.uy * ay) + B.hy * Math.abs(-B.uy * ax + B.ux * ay);
      if (Math.abs((B.cx - A.cx) * ax + (B.cy - A.cy) * ay) >= pa + pb - 1) return false; // 1 cm tolerance: flush is fine
    }
    return true;
  }
  function conflicts(it, pose, size) {
    if (NON_SOLID.has(it.type)) return [];
    const me = obb(pose.x, pose.y, pose.rot, size.w / 2, size.d / 2);
    const out = [];
    for (const w of walls()) {
      const wb = { cx: w.a[0] + w.ux * w.L / 2, cy: w.a[1] + w.uy * w.L / 2, ux: w.ux, uy: w.uy, hx: w.L / 2, hy: w.t / 2 };
      if (overlap(me, wb)) { out.push('牆'); break; }
    }
    if (!it.elevation) {
      for (const o of state.eff.plan.furniture) {
        if (o.id === it.id || o.hidden || o.elevation || NON_SOLID.has(o.type)) continue;
        const s = dims(o);
        if (overlap(me, obb(o.x, o.y, o.rotation || 0, s.w / 2, s.d / 2))) out.push(TYPE_LABELS[o.type] || o.type);
      }
    }
    return out;
  }

  // ---------- distances to the surrounding walls ----------
  function rayToWall(px, py, dx, dy) {
    let best = Infinity;
    for (const w of walls()) {
      const nx = -w.uy, ny = w.ux; const den = dx * nx + dy * ny;
      if (Math.abs(den) < 1e-6) continue;
      const rn = (px - w.a[0]) * nx + (py - w.a[1]) * ny;
      for (const side of [-1, 1]) {
        const t = (side * w.t / 2 - rn) / den;
        if (t <= 0.5 || t >= best) continue;
        const along = (px + dx * t - w.a[0]) * w.ux + (py + dy * t - w.a[1]) * w.uy;
        if (along < -w.t / 2 || along > w.L + w.t / 2) continue;
        if (w.ops?.some((o) => o.type === 'door' && along > o.s && along < o.e)) continue; // looks through doorways
        best = t;
      }
    }
    return best;
  }
  function distances(pose, size) {
    const { lx, lz } = axes(pose.rot);
    return [[lz, size.d / 2], [[-lz[0], -lz[1]], size.d / 2], [lx, size.w / 2], [[-lx[0], -lx[1]], size.w / 2]].map(([dir, e]) => {
      const t = rayToWall(pose.x, pose.y, dir[0], dir[1]);
      if (!isFinite(t) || t - e > 800 || t - e < 0.5) return null;
      return { from: [pose.x + dir[0] * e, pose.y + dir[1] * e], to: [pose.x + dir[0] * t, pose.y + dir[1] * t], cm: Math.round(t - e) };
    });
  }

  // ---------- live transform (no rebuild) ----------
  function applyPose(id, pose) {
    const b = state.built; const obj = b?.byId.get(id); if (!obj) return;
    const set = (o) => { o.position.x = pose.x / 100; o.position.z = pose.y / 100; o.rotation.y = -pose.rot * D2R; };
    set(obj);
    b.groups.furniture.children.forEach((o) => { if (o.userData.kind === 'pendant' && o.userData.id === id) set(o); });
    for (const c of b.colliders) if (c.obj === obj) { c.x = pose.x / 100; c.z = pose.y / 100; c.rot = -pose.rot * D2R; }
    api.onMoved();
  }
  function commitPose(it, pose) {
    const patch = {};
    const x = Math.round(pose.x), y = Math.round(pose.y), rotation = Math.round(pose.rot) % 360;
    if (x !== it.x) patch.x = x; if (y !== it.y) patch.y = y; if (rotation !== Math.round(it.rotation || 0)) patch.rotation = rotation;
    if (!Object.keys(patch).length) return;
    applyPose(it.id, { x, y, rot: rotation });
    api.commit((d) => setFurniturePatch(d, it.id, patch), { rebuild: false });
  }

  // ---------- pointer ----------
  let drag = null;
  const ndc = (e) => { const r = dom.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  function planeHit(e, yM) { ray.setFromCamera(ndc(e), camera); plane.constant = -yM; return ray.ray.intersectPlane(plane, new THREE.Vector3()); }
  function selectedTarget() {
    const sel = state.selection; if (sel?.kind !== 'furniture' || !enabled() || api.planEditorVisible()) return null;
    const it = itemOf(sel.id); const obj = state.built.byId.get(sel.id);
    return it && obj?.visible ? { it, obj } : null;
  }
  /** what's under the pointer: 'rotate' (ring) / 'move' (the selected piece) / null */
  function hitMode(e, t) {
    ray.setFromCamera(ndc(e), camera);
    if (group.visible && ringGroup.visible && ray.intersectObject(ringHit, false).length) return 'rotate';
    const parts = [t.obj, ...state.built.groups.furniture.children.filter((o) => o.userData.kind === 'pendant' && o.userData.id === t.it.id)];
    const hit = ray.intersectObjects(parts, true).find((h) => visibleChain(h.object));
    if (!hit) return null;
    const g = state.built.groups;
    const block = ray.intersectObjects([g.walls, ...(g.ceilings.visible ? [g.ceilings] : [])], true).find((h) => visibleChain(h.object) && !(h.object.material?.transparent && h.object.material.opacity < 0.6));
    return !block || block.distance > hit.distance - 0.01 ? 'move' : null;
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== dom || e.button !== 0) return;
    const t = selectedTarget(); if (!t) return;
    const mode = hitMode(e, t); if (!mode) return;
    const yM = (t.it.elevation || 0) / 100;
    const p0 = planeHit(e, yM); if (!p0) return;
    // take over this gesture: OrbitControls / walk-look / click-select never see it
    e.stopPropagation(); e.preventDefault();
    try { dom.setPointerCapture(e.pointerId); } catch {}
    const orig = poseOf(t.it);
    drag = { mode, it: t.it, size: dims(t.it), built: state.built, start: [e.clientX, e.clientY], p0, yM, orig, pose: orig, moved: false, a0: Math.atan2(p0.z * 100 - orig.y, p0.x * 100 - orig.x) };
    dom.style.cursor = mode === 'rotate' ? 'grabbing' : 'move';
  }, true);

  let hoverT = 0;
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) {
      // hover cursor (throttled; only tests the selected piece)
      if (e.target !== dom || e.buttons || performance.now() - hoverT < 60) return;
      hoverT = performance.now();
      const t = selectedTarget(); const m = t && hitMode(e, t);
      dom.style.cursor = m === 'rotate' ? 'grab' : m === 'move' ? 'move' : '';
      return;
    }
    e.stopPropagation();
    if (state.built !== drag.built) { cancel(); return; } // scene was rebuilt (someone else saved) → drop the gesture
    if (!drag.moved && Math.hypot(e.clientX - drag.start[0], e.clientY - drag.start[1]) < 3) return;
    const p = planeHit(e, drag.yM); if (!p) return;
    if (!drag.moved) { drag.moved = true; api.pushUndo(); }
    if (drag.mode === 'move') {
      const raw = { x: drag.orig.x + (p.x - drag.p0.x) * 100, y: drag.orig.y + (p.z - drag.p0.z) * 100, rot: drag.orig.rot };
      drag.pose = snapPose(raw, drag.size, drag.it.type, e.shiftKey);
    } else {
      const a = Math.atan2(p.z * 100 - drag.orig.y, p.x * 100 - drag.orig.x);
      let deg = drag.orig.rot + (a - drag.a0) * R2D;
      if (!e.shiftKey) deg = Math.round(deg / 15) * 15;
      drag.pose = { ...drag.orig, rot: norm(deg) };
    }
    applyPose(drag.it.id, drag.pose);
  }, true);

  function endDrag(e) {
    if (!drag) return;
    e.stopPropagation();
    try { dom.releasePointerCapture(e.pointerId); } catch {}
    const d = drag; drag = null; dom.style.cursor = '';
    if (d.moved && state.built === d.built) {
      commitPose(d.it, d.pose);
      const hit = conflicts(d.it, d.pose, d.size);
      api.setStatus(hit.length ? `已移動（注意：與${[...new Set(hit)].join('、')}重疊）` : '已移動家具（Ctrl+Z 復原）', !!hit.length);
    }
  }
  viewport.addEventListener('pointerup', endDrag, true);
  viewport.addEventListener('pointercancel', (e) => { if (drag) { applyPose(drag.it.id, drag.orig); endDrag(e); } }, true);
  // a double click on the selected piece must not trigger "double-click the floor to walk in"
  viewport.addEventListener('dblclick', (e) => { const t = e.target === dom && selectedTarget(); if (t && hitMode(e, t)) e.stopPropagation(); }, true);
  function cancel() { if (drag) { if (state.built === drag.built) applyPose(drag.it.id, drag.orig); drag = null; dom.style.cursor = ''; } }

  // ---------- keyboard: nudge / rotate ----------
  let lastNudge = 0;
  addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = selectedTarget(); if (!t || drag) return;
    const walking = state.view === 'walk';
    const step = e.shiftKey ? 10 : 1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    let pose = null;
    if (mv && !walking) pose = { ...poseOf(t.it), x: t.it.x + mv[0], y: t.it.y + mv[1] };
    else if (e.code === 'KeyR') pose = { ...poseOf(t.it), rot: norm((t.it.rotation || 0) + (e.shiftKey ? -90 : 90)) };
    else if (e.key === 'Escape' && !walking) { api.select(null); return; }
    if (!pose) return;
    e.preventDefault();
    if (performance.now() - lastNudge > 800) api.pushUndo();
    lastNudge = performance.now();
    commitPose(t.it, pose);
  });

  // ---------- per-frame: helpers + HUD ----------
  let lastKey = '';
  const v3 = new THREE.Vector3();
  function placeLabel(el, x, y, yM, text) {
    v3.set(x / 100, yM, y / 100).project(camera);
    if (v3.z > 1 || Math.abs(v3.x) > 1.2 || Math.abs(v3.y) > 1.2) { el.style.display = 'none'; return; }
    const r = dom.getBoundingClientRect(); const vr = viewport.getBoundingClientRect();
    el.style.display = ''; el.textContent = text;
    el.style.transform = `translate(${(v3.x + 1) / 2 * r.width + r.left - vr.left}px, ${(1 - v3.y) / 2 * r.height + r.top - vr.top}px) translate(-50%, -50%)`;
  }
  function update() {
    const t = selectedTarget();
    const walking = state.view === 'walk';
    const active = drag && drag.moved && t && drag.it.id === t.it.id;
    if (!t || (walking && !active)) { group.visible = false; hud.style.display = 'none'; lastKey = ''; return; }
    const pose = active ? drag.pose : poseOf(t.it);
    const size = active ? drag.size : dims(t.it);
    const yM = (t.it.elevation || 0) / 100 + 0.015;
    const key = [t.it.id, pose.x, pose.y, pose.rot, size.w, size.d, yM, state.built.wallInfo.length].join('|');
    if (key !== lastKey) {
      lastKey = key;
      const { lx, lz } = axes(pose.rot); const hw = size.w / 2, hd = size.d / 2;
      const P = footprint.geometry.attributes.position;
      [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sz], i) => P.setXYZ(i, (pose.x + lx[0] * hw * sx + lz[0] * hd * sz) / 100, yM, (pose.y + lx[1] * hw * sx + lz[1] * hd * sz) / 100));
      P.needsUpdate = true;
      const hit = conflicts(t.it, pose, size);
      footprint.material.color.setHex(hit.length ? COL.warn : COL.normal);
      group.userData.dist = distances(pose, size);
      const D = distLines.geometry.attributes.position;
      group.userData.dist.forEach((d, i) => {
        const a = d ? d.from : [0, 0], b = d ? d.to : [0, 0];
        D.setXYZ(i * 2, a[0] / 100, yM, a[1] / 100); D.setXYZ(i * 2 + 1, b[0] / 100, yM, b[1] / 100);
      });
      D.needsUpdate = true; distLines.computeLineDistances(); distLines.geometry.computeBoundingSphere();
      const R = Math.hypot(hw, hd) / 100 + 0.18;
      ringGroup.position.set(pose.x / 100, yM, pose.y / 100); ringGroup.rotation.y = -pose.rot * D2R;
      ring.scale.setScalar(R); ringHit.scale.setScalar(R); knob.position.set(0, 0, R + 0.02);
      group.userData.info = `${TYPE_LABELS[t.it.type] || t.it.type} ${Math.round(size.w)}×${Math.round(size.d)} cm · ${Math.round(pose.rot)}°` + (hit.length ? ` · ⚠ 與${[...new Set(hit)].join('、')}重疊` : '');
      info.classList.toggle('warn', !!hit.length);
    }
    group.visible = true; ringGroup.visible = !walking;
    hud.style.display = '';
    group.userData.dist.forEach((d, i) => { if (d) placeLabel(distLabels[i], (d.from[0] + d.to[0]) / 2, (d.from[1] + d.to[1]) / 2, yM, `${d.cm} cm`); else distLabels[i].style.display = 'none'; });
    const { lz } = axes(pose.rot);
    placeLabel(info, pose.x - lz[0] * (size.d / 2 + 30), pose.y - lz[1] * (size.d / 2 + 30), yM, group.userData.info);
  }
  /** draw the helpers on top of the finished frame (call right after the main render) */
  function render() {
    update();
    if (!group.visible) return;
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.render(overlay, camera);
    renderer.autoClear = ac;
  }
  return { render, cancel, get dragging() { return !!drag; } };
}
