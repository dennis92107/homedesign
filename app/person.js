// 170 cm 人形比例尺：「顯示 → 170 cm 人形」開關，可在 3D 畫面直接拖曳（鳥瞰、平面俯視、漫遊都可以）
//
// 比例依 Drillis & Contini 人體節段比例（身高 H 的比例；Winter《Biomechanics and Motor Control of Human Movement》
// 圖 4.1 引用）：肩高 0.818H、下巴 0.870H、肘 0.630H、腕 0.485H、髖 0.530H、膝 0.285H、踝 0.039H、
// 肩寬 0.259H（≈44 cm）、髖寬 0.191H、腳長 0.152H。身高 170 cm → 肩寬 44 cm、眼高約 159 cm。
//
// 互動：
//   按住人形拖曳＝移動（不用先選取；不會被當成點選家具，也不會轉動視角）
//   點一下人形＝選取（地上出現 44 cm 肩寬圈與說明），R 轉 45°（Shift+R 反轉），Esc 取消選取
// 防卡牆／壞掉：
//   位置一律經過漫遊同一套碰撞（builder.js resolveCollision / penetration，半徑 = 半肩寬 22 cm），
//   拖到牆或家具裡會被推到游標那一側的空地；推不出來（縫太窄）或跑到房子外面就停在上一個合法位置。
//   場景重建（改格局、別人存檔）後重新檢查，位置失效就就近找空地，再不行回到漫遊起點／最大房間中央。
// 人形放在主場景（不屬於 built.root），重建不會被刪；不進烘焙；真實渲染（路徑追蹤）會一起算進去（只 1 種材質）。
import * as THREE from 'three';
import { penetration, resolveCollision, pointInPoly, polygonArea, centroid } from './builder.js';

const H = 1.70;
const P = { shoulder: 0.818, chin: 0.870, elbow: 0.630, wrist: 0.485, hip: 0.530, knee: 0.285, ankle: 0.039, shoulderW: 0.259, hipW: 0.191, footL: 0.152, footW: 0.055 };
const RADIUS = (P.shoulderW * H) / 2; // 0.22 m：碰撞半徑 = 半肩寬（漫遊相機也是 0.22）
const D2R = Math.PI / 180;
const KEY = 'hd:person';

/** stylised mannequin, feet at y = 0, facing +z (= rotation 0 of the furniture convention: front toward +y on the drawing) */
function buildFigure(mat) {
  const g = new THREE.Group();
  const add = (geo, x, y, z = 0, s) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (s) m.scale.set(...s); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  const capsule = (r, y0, y1, x, z = 0) => add(new THREE.CapsuleGeometry(r, Math.max(0.01, y1 - y0 - 2 * r), 6, 16), x, (y0 + y1) / 2, z);
  const y = (k) => k * H;
  const legX = (P.hipW * H) / 4 + 0.005; // ≈ 8.6 cm from the centre line
  for (const s of [-1, 1]) {
    capsule(0.05, y(P.ankle) + 0.01, y(P.knee) + 0.05, s * legX);           // shin
    capsule(0.07, y(P.knee) - 0.03, y(P.hip) + 0.06, s * legX);             // thigh
    add(new THREE.BoxGeometry(P.footW * H * 1.05, 0.065, P.footL * H), s * legX, 0.0325, 0.055); // foot (toes forward = facing)
    const ax = (P.shoulderW * H) / 2 - 0.035;
    capsule(0.045, y(P.elbow) - 0.02, y(P.shoulder) + 0.01, s * ax);         // upper arm
    capsule(0.037, y(P.wrist), y(P.elbow) + 0.02, s * (ax + 0.006));         // forearm
    add(new THREE.SphereGeometry(1, 16, 12), s * (ax + 0.008), y(P.wrist) - 0.08, 0.005, [0.03, 0.09, 0.045]); // hand
    add(new THREE.SphereGeometry(0.052, 16, 12), s * (ax - 0.005), y(P.shoulder) - 0.01); // shoulder cap
  }
  add(new THREE.SphereGeometry(1, 24, 16), 0, y(P.hip) + 0.04, 0, [0.165, 0.12, 0.105]);                 // pelvis
  const torso = add(new THREE.CylinderGeometry(0.175, 0.15, y(P.shoulder) - y(P.hip) - 0.02, 28), 0, (y(P.shoulder) + y(P.hip)) / 2 + 0.005, 0);
  torso.scale.z = 0.62;                                                                                    // chest depth ≈ 22 cm
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.12, 16), 0, y(P.chin) - 0.03);                             // neck
  const headH = H - y(P.chin);                                                                             // top of head → chin ≈ 22 cm
  add(new THREE.SphereGeometry(1, 28, 20), 0, H - headH / 2, 0.005, [0.078, headH / 2, 0.098]);           // head
  add(new THREE.SphereGeometry(1, 12, 8), 0, H - headH * 0.55, 0.098, [0.014, 0.025, 0.02]);             // nose: shows which way it faces
  g.traverse((o) => { o.userData.person = true; });
  return g;
}

/**
 * api: { scene, renderer, camera, viewport, state, select(sel), ptOn(), planEditorVisible(), onChange(), setStatus }
 */
export function createPerson(api) {
  const { scene, renderer, camera, viewport, state } = api;
  const dom = renderer.domElement;
  const mat = new THREE.MeshStandardMaterial({ color: '#d8d2c8', roughness: 0.78, metalness: 0 }); // matte "scale figure" grey
  const fig = buildFigure(mat);
  fig.visible = false; fig.name = 'person170';
  scene.add(fig);

  // overlay (not in the scene: not path traced, not pickable): 44 cm shoulder circle + facing tick
  const overlay = new THREE.Scene();
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x2a7de1, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(RADIUS - 0.012, RADIUS + 0.004, 64), ringMat);
  const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.12).translate(0, RADIUS + 0.06, 0), ringMat);
  const helper = new THREE.Group(); helper.add(ring, tick); overlay.add(helper);
  for (const m of [ring, tick]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 1000; m.frustumCulled = false; }
  // tick points along local +y of the ring = toward -z after the -90° x rotation → flip so it points to the face (+z)
  tick.rotation.z = Math.PI;

  const hud = document.createElement('div'); hud.className = 'fd-hud';
  const label = hud.appendChild(Object.assign(document.createElement('span'), { className: 'fd-info ps-label' }));
  viewport.appendChild(hud);

  // ---------- persisted state (per browser; per plan position) ----------
  let saved = { on: false, at: {} };
  try { saved = { ...saved, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; saved.at ||= {}; } catch {}
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {} };
  let pos = null;          // [x, z] metres
  let rot = 0;             // degrees, furniture convention
  let active = false;      // clicked → R / Esc work, helper ring shows
  let planKey = null;

  const built = () => state.built;
  const rooms = () => state.eff?.plan?.rooms || [];
  const inRoom = (x, z) => rooms().some((r) => r.polygon?.length > 2 && pointInPoly([x * 100, z * 100], r.polygon));
  const free = (x, z) => Number.isFinite(x) && Number.isFinite(z) && inRoom(x, z) && penetration(built(), x, z, RADIUS) < 1e-3;
  /** a legal spot for a wish position, or null (push out of walls/furniture first) */
  function legal(x, z) {
    if (!built() || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (free(x, z)) return [x, z];
    const [rx, rz] = resolveCollision(built(), x, z, RADIUS);
    return free(rx, rz) ? [rx, rz] : null;
  }
  /** nearest legal spot around (x,z) on a small spiral (≤ 1.5 m) */
  function near(x, z) {
    const hit = legal(x, z); if (hit) return hit;
    for (let r = 0.1; r <= 1.5; r += 0.1) for (let a = 0; a < 360; a += 30) {
      const p = legal(x + Math.cos(a * D2R) * r, z + Math.sin(a * D2R) * r); if (p) return p;
    }
    return null;
  }
  function defaultSpot() {
    const sp = state.eff?.plan?.spawn;
    if (sp?.x != null) { const p = near(sp.x / 100, sp.y / 100); if (p) return p; }
    const order = [...rooms()].filter((r) => r.polygon?.length > 2)
      .sort((a, b) => (b.type === 'living') - (a.type === 'living') || polygonArea(b.polygon) - polygonArea(a.polygon));
    for (const r of order) { const [cx, cy] = r.label ? [r.label.x, r.label.y] : centroid(r.polygon); const p = near(cx / 100, cy / 100); if (p) return p; }
    return null;
  }

  function apply() {
    if (!pos) { fig.visible = false; return; }
    fig.position.set(pos[0], 0, pos[1]); fig.rotation.y = -rot * D2R;
    fig.visible = !!saved.on;
    fig.updateMatrixWorld(true); // raycasts (next grab) must see the new spot even before the next frame
    helper.position.set(pos[0], 0.012, pos[1]); helper.rotation.y = -rot * D2R;
  }
  function store() { if (planKey && pos) { saved.at[planKey] = [Math.round(pos[0] * 100) / 100, Math.round(pos[1] * 100) / 100, rot]; persist(); } }

  /** after every (re)build: keep the figure on a legal spot of the current plan */
  function sync() {
    if (!built()) return;
    const key = state.planUrl;
    if (key !== planKey) { planKey = key; const s = saved.at[key]; pos = s ? [s[0], s[1]] : null; rot = s?.[2] || 0; active = false; }
    if (saved.on) {
      const p = pos ? near(pos[0], pos[1]) : null;
      pos = p || defaultSpot();
      if (pos) store();
    }
    apply();
  }
  function setOn(on) {
    saved.on = !!on; persist();
    if (on) sync(); else { active = false; apply(); }
    if (on && !pos) api.setStatus?.('找不到可以站人的空地（平面圖沒有房間？）', true);
    api.onChange();
  }

  // ---------- pointer ----------
  const ray = new THREE.Raycaster();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = (e) => { const r = dom.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const visibleChain = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  const usable = () => fig.visible && !!built() && !api.ptOn() && !api.planEditorVisible();
  /** is the pointer on the figure (and not behind a wall / ceiling)? */
  /** the hit on the figure (null when missed or hidden behind a wall / ceiling) */
  function onFigure(e) {
    ray.setFromCamera(ndc(e), camera);
    const h = ray.intersectObject(fig, true)[0]; if (!h) return null;
    const g = built().groups;
    const block = ray.intersectObjects([g.walls, ...(g.ceilings.visible ? [g.ceilings] : [])], true)
      .find((b) => visibleChain(b.object) && !(b.object.material?.transparent && b.object.material.opacity < 0.6));
    return !block || block.distance > h.distance - 0.01 ? h : null;
  }
  // drag in the horizontal plane through the grabbed point, so that point follows the cursor exactly (a floor plane
  // would magnify the motion in the walk view, where the eye is barely above the grabbed chest); kept ≥ 0.4 m under
  // the eye so the plane never runs parallel to the view ray
  const planeHit = (e, y) => { ray.setFromCamera(ndc(e), camera); floor.constant = -y; return ray.ray.intersectPlane(floor, new THREE.Vector3()); };

  let drag = null;
  const _eye = new THREE.Vector3();
  // window capture phase: runs before furnitureDrag (#viewport capture), OrbitControls and walk-look
  addEventListener('pointerdown', (e) => {
    if (e.target !== dom || e.button !== 0 || !usable()) return;
    const h = onFigure(e);
    if (!h) { if (active) { active = false; api.onChange(); } return; }
    camera.getWorldPosition(_eye);
    let planeY = Math.max(0, Math.min(h.point.y, _eye.y - 0.4));
    let p0 = planeHit(e, planeY);
    if (!p0) { planeY = 0; p0 = planeHit(e, 0); }
    e.stopPropagation(); e.preventDefault();
    try { dom.setPointerCapture(e.pointerId); } catch {}
    drag = { id: e.pointerId, start: [e.clientX, e.clientY], p0, planeY, orig: [...pos], moved: false, built: built() };
    dom.style.cursor = 'grabbing';
  }, true);
  let hoverT = 0;
  addEventListener('pointermove', (e) => {
    if (!drag) {
      if (e.target !== dom || e.buttons || !usable() || performance.now() - hoverT < 60) return;
      hoverT = performance.now();
      if (onFigure(e)) { dom.style.cursor = 'grab'; e.stopPropagation(); } // (furnitureDrag would reset the cursor)
      return;
    }
    e.stopPropagation();
    if (built() !== drag.built) { drag.built = built(); } // scene rebuilt mid-drag: keep going, positions are re-validated anyway
    if (!drag.moved && Math.hypot(e.clientX - drag.start[0], e.clientY - drag.start[1]) < 3) return;
    const p = planeHit(e, drag.planeY); if (!p || !drag.p0) return; // pointer above the horizon: ignore this move
    drag.moved = true;
    const wish = [drag.orig[0] + (p.x - drag.p0.x), drag.orig[1] + (p.z - drag.p0.z)];
    if (Math.hypot(wish[0] - pos[0], wish[1] - pos[1]) > 25) return; // runaway (ray almost parallel to the floor)
    const ok = legal(wish[0], wish[1]);
    if (ok) { pos = ok; apply(); api.onChange(); }
  }, true);
  function end(e) {
    if (!drag) return;
    e.stopPropagation();
    try { dom.releasePointerCapture(e.pointerId); } catch {}
    const d = drag; drag = null; dom.style.cursor = '';
    if (d.moved) { store(); api.setStatus?.('已移動 170 cm 人形'); }
    else { active = !active; if (active) api.select(null); }
    api.onChange();
  }
  addEventListener('pointerup', end, true);
  addEventListener('pointercancel', (e) => { if (drag) { pos = drag.orig; apply(); end(e); } }, true);
  addEventListener('dblclick', (e) => { if (e.target === dom && usable() && onFigure(e)) e.stopPropagation(); }, true);
  addEventListener('keydown', (e) => {
    if (!active || !fig.visible || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyR') {
      e.preventDefault(); e.stopPropagation();
      rot = (((rot + (e.shiftKey ? -45 : 45)) % 360) + 360) % 360; apply(); store(); api.onChange();
    } else if (e.key === 'Escape') { active = false; api.onChange(); }
  }, true);

  // ---------- per-frame: label + helper ring ----------
  const v3 = new THREE.Vector3();
  function render() {
    const show = fig.visible && !api.ptOn();
    if (!show) { hud.style.display = 'none'; return; }
    hud.style.display = '';
    v3.set(pos[0], H + 0.12, pos[1]).project(camera);
    if (v3.z > 1 || Math.abs(v3.x) > 1.2 || Math.abs(v3.y) > 1.2) label.style.display = 'none';
    else {
      const r = dom.getBoundingClientRect(), vr = viewport.getBoundingClientRect();
      label.style.display = '';
      label.textContent = active ? '170 cm · 肩寬 44 cm · 拖曳移動 · R 轉向' : '170 cm';
      label.style.transform = `translate(${(v3.x + 1) / 2 * r.width + r.left - vr.left}px, ${(1 - v3.y) / 2 * r.height + r.top - vr.top}px) translate(-50%, -100%)`;
    }
    if (active || drag) {
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.render(overlay, camera);
      renderer.autoClear = ac;
    }
  }

  return {
    sync, render, setOn,
    get on() { return !!saved.on; },
    get dragging() { return !!drag; },
    get position() { return pos && { x: Math.round(pos[0] * 100), y: Math.round(pos[1] * 100), rotation: rot }; },
    /** debug / scripted placement in plan cm; returns the legal spot actually used (or null) */
    moveTo(x, y) { const p = legal(x / 100, y / 100); if (p) { pos = p; apply(); store(); api.onChange(); } return this.position; },
    figure: fig,
  };
}
