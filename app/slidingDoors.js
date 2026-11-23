// 拉門（連動 / 單片）：plan.slidingDoors 描述軌道與門片，開關只移動門片，不重建場景。
// { id, name, a:[x,y], b:[x,y],   關閉時門片涵蓋的範圍（cm）
//   park:"a|b",                    打開時門片停到哪一端（超出 a–b 範圍）
//   panels:2, overlap:4, thickness:3.6, height:272,
//   layers:[4,0],                  每片門的軌道偏移（cm，+ = a→b 右手邊）；索引 0 = 離停放端最遠（走最遠）的門片
//   fixed:{ length:82, layer:-4 }, 停放端的固定板（門片打開後收在它旁邊）
//   color:"#c2a27c",
//   holes:[{ panel:1, y:215, d:30, at:0 }] }  門片開圓洞：y＝圓心離地高、d＝直徑、at＝離門片中心的水平距離（cm）
import * as THREE from 'three';
import * as TX from './textures.js';

const cm = (v) => v / 100;
const FLOOR_GAP = 0.8; // cm：懸吊門片下緣離地（top-hung，無地軌）

/** panel extents (cm along a→b) for an opening amount t: 0 = closed, 1 = fully parked */
export function panelSpans(d, t = 1) {
  const L = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
  const n = Math.max(1, d.panels || 1), ov = n > 1 ? d.overlap ?? 4 : 0;
  const w = (L + (n - 1) * ov) / n, k = Math.max(0, Math.min(1, t));
  const parkB = d.park !== 'a';
  return Array.from({ length: n }, (_, i) => {
    const closed = i * (w - ov), r = closed + (L - closed) * k; // r: distance from the far end towards the park end
    const s = parkB ? r : L - r - w;
    return { s, e: s + w, w, layer: d.layers?.[i] ?? 0 };
  });
}
/** the fixed board at the park end, or null */
export function fixedSpan(d) {
  if (!d.fixed?.length) return null;
  const L = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
  return d.park === 'a' ? { s: -d.fixed.length, e: 0, layer: d.fixed.layer ?? 0 } : { s: L, e: L + d.fixed.length, layer: d.fixed.layer ?? 0 };
}

function veneer(color) {
  const tex = TX.woodGrain({ color }).clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.1, 1.1); tex.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ color: '#ffffff', map: tex, roughness: 0.52, metalness: 0 });
}
/** flat board with round holes; origin = bottom centre, x along the board, z through it; grain runs vertically */
function boardGeo(w, h, t, holes = []) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.closePath();
  for (const c of holes) {
    if (c.y + c.r >= h - 0.01 || c.y - c.r <= 0.01) continue; // cut-away view: the hole is above the section
    const p = new THREE.Path(); p.absarc(c.x, c.y, c.r, 0, Math.PI * 2, true); s.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 48 });
  g.translate(0, 0, -t / 2); g.clearGroups();
  const uv = g.attributes.uv, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getY(i), pos.getX(i) + pos.getZ(i)); // the grain texture runs along u
  return g;
}

/** build every door of the plan under `walls` (kind "door" keeps them out of the lightmap); colliders move with the panels */
export function buildSlidingDoors(plan, { Hcm, Hc, cut, walls, colliders, M }) {
  const sets = [];
  for (const d of plan.slidingDoors || []) {
    const dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1], L = Math.hypot(dx, dy);
    if (L < 1) continue;
    const ux = dx / L, uy = dy / L;
    const root = new THREE.Group();
    root.position.set(cm(d.a[0]), 0, cm(d.a[1]));
    root.rotation.y = Math.atan2(-dy, dx);
    root.userData = { kind: 'door', sliding: d.id };
    walls.add(root);
    const T = d.thickness ?? 3.6, top = Math.min(d.height ?? Hcm - 8, Hc - 0.2), H = cm(top - FLOOR_GAP);
    const mat = veneer(d.color || '#c2a27c'), metal = M.metal;
    const world = (along, layer) => [cm(d.a[0] + ux * along - uy * layer), cm(d.a[1] + uy * along + ux * layer)];

    const panels = panelSpans(d, 0).map((sp, i) => {
      const holes = (d.holes || []).filter((c) => (c.panel ?? 0) === i).map((c) => ({ x: cm(c.at || 0), y: cm(c.y - FLOOR_GAP), r: cm(c.d / 2) }));
      const mesh = new THREE.Mesh(boardGeo(cm(sp.w), H, cm(T), holes), mat);
      mesh.position.set(cm((sp.s + sp.e) / 2), cm(FLOOR_GAP), cm(sp.layer));
      mesh.castShadow = true; mesh.receiveShadow = true;
      if (i === 0 && H > 1.2) { // flush pull near the leading edge, on both faces
        const dir = d.park === 'a' ? 1 : -1;
        const pull = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.34, cm(T) + 0.004), metal);
        pull.position.set(dir * (cm(sp.w) / 2 - 0.05), 1.05, 0); mesh.add(pull);
      }
      root.add(mesh);
      const collider = { obj: mesh, x: 0, z: 0, hw: cm(sp.w) / 2, hd: cm(T) / 2, rot: root.rotation.y };
      colliders.push(collider);
      return { mesh, collider, layer: sp.layer };
    });

    const fx = fixedSpan(d);
    if (fx) {
      const mesh = new THREE.Mesh(boardGeo(cm(fx.e - fx.s), H + cm(FLOOR_GAP), cm(T)), mat);
      mesh.position.set(cm((fx.s + fx.e) / 2), 0, cm(fx.layer));
      mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
      const [x, z] = world((fx.s + fx.e) / 2, fx.layer);
      colliders.push({ obj: mesh, x, z, hw: cm(fx.e - fx.s) / 2, hd: cm(T) / 2, rot: root.rotation.y });
    }
    if (!cut) { // ceiling track: a dark reveal over the whole travel
      const ls = [...(d.layers || [0]), ...(fx ? [fx.layer] : [])], lo = Math.min(...ls) - T / 2, hi = Math.max(...ls) + T / 2;
      const parked = panelSpans(d, 1), s0 = Math.min(0, fx?.s ?? 0, ...parked.map((p) => p.s)), s1 = Math.max(L, fx?.e ?? L, ...parked.map((p) => p.e));
      const track = new THREE.Mesh(new THREE.BoxGeometry(cm(s1 - s0), cm(Hcm - top) - 0.002, cm(hi - lo)), new THREE.MeshStandardMaterial({ color: '#1d1b19', roughness: 0.6, metalness: 0.3 }));
      track.position.set(cm((s0 + s1) / 2), cm((Hcm + top) / 2), cm((lo + hi) / 2));
      root.add(track);
    }
    sets.push({ spec: d, root, panels, world });
  }
  return sets;
}

/** move the panels to the opening amounts in `open` ({ id: 0..1 }, default fully open) */
export function applySlidingDoors(built, open = {}) {
  for (const set of built?.slidingDoors || []) {
    const spans = panelSpans(set.spec, open[set.spec.id] ?? 1);
    set.panels.forEach((p, i) => {
      const c = (spans[i].s + spans[i].e) / 2;
      p.mesh.position.x = cm(c);
      [p.collider.x, p.collider.z] = set.world(c, p.layer);
    });
    set.root.updateMatrixWorld(true);
  }
}
