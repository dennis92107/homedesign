// 地板反射（擬真度 ⑦ 2026-11-22）：即時預覽的螢幕空間反射（SSR）
//
// three.js 的 SSRPass（examples/jsm/postprocessing/SSRPass.js）：自己畫一次畫面＋法線＋「哪些表面會反射」的遮罩，
// 沿反射方向在深度圖上步進找交點，把找到的顏色疊回去（菲涅耳：斜看越亮；距離越遠越淡；結果再模糊一次）。
// 只有畫面裡看得到的東西會被反射（SSR 的本質限制），所以只用在地板這種大平面，強度保守。
// 改造：遮罩不是 0/1，而是「反射強度」（拋光石材 > 磁磚 > 塗裝木地板 > 清水模），SSR 的不透明度乘上它。
// 路徑追蹤本來就有真反射，不經過這裡。
//
// 樣板可在地板 spec 寫 "reflect": 0–0.6（0 = 不反射）；沒寫就依材質給預設（REFLECT_DEFAULT）。
import * as THREE from 'three';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';

export const REFLECT_DEFAULT = { marble: 0.42, tile: 0.28, hex: 0.22, terrazzo: 0.3, wood: 0.16, herringbone: 0.16, concrete: 0.12, carpet: 0 };

/** reflection strength of a floor spec (0–1) */
export function floorReflect(spec) {
  if (!spec || typeof spec !== 'object') return 0;
  if (typeof spec.reflect === 'number') return Math.max(0, Math.min(1, spec.reflect));
  let s = REFLECT_DEFAULT[spec.material] ?? 0.12;
  if (typeof spec.roughness === 'number') s *= Math.max(0.3, Math.min(1.6, (0.65 - spec.roughness) / 0.35)); // glossier spec → stronger
  return s;
}

export function createReflections({ renderer, scene, camera }) {
  const ssr = new SSRPass({ renderer, scene, camera, width: 2, height: 2, selects: [] });
  ssr.opacity = 1; ssr.maxDistance = 4; ssr.thickness = 0.03;
  ssr.blur = true; ssr.fresnel = true; ssr.distanceAttenuation = true; ssr.infiniteThick = false;
  // per-surface strength from the mask (red channel) instead of on/off
  const m = ssr.ssrMaterial;
  m.fragmentShader = m.fragmentShader.replace('float op=opacity;', 'float op=opacity*texture2D(tMetalness,vUv).r;')
    .replace('op=opacity*attenuation;', 'op*=attenuation;'); // (distance attenuation would otherwise reset op to the global opacity)
  m.needsUpdate = true;
  const masks = new Map(); // strength → MeshBasicMaterial
  const maskMat = (k) => { const q = Math.round(k * 100) / 100; if (!masks.has(q)) masks.set(q, new THREE.MeshBasicMaterial({ color: new THREE.Color(q, q, q) })); return masks.get(q); };
  let strength = new Map(); // mesh → 0..1
  // replaces SSRPass's on/off metalness pass
  ssr._renderMetalness = function (r, _on, target) {
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha(), prevAuto = r.autoClear, bg = scene.background, fog = scene.fog;
    r.setRenderTarget(target); r.autoClear = false; scene.background = null; scene.fog = null;
    r.setClearColor(0x000000, 0); r.clear();
    const swapped = [];
    scene.traverseVisible((o) => { if (!o.isMesh && !o.isLine && !o.isPoints) return; swapped.push([o, o.material]); o.material = strength.has(o) ? maskMat(strength.get(o)) : this.metalnessOffMaterial; });
    r.render(scene, camera);
    for (const [o, mt] of swapped) o.material = mt;
    r.autoClear = prevAuto; r.setClearColor(prevClear, prevAlpha); scene.background = bg; scene.fog = fog;
  };
  const render0 = ssr.render.bind(ssr);
  ssr.render = (r, w, rb, dt, mask) => {
    const u = m.uniforms; // camera changes every frame (walk, lens shift, AA jitter)
    u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    u.cameraProjectionMatrix.value.copy(camera.projectionMatrix); u.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
    for (const dm of [ssr.depthRenderMaterial]) if (dm) { dm.uniforms.cameraNear.value = camera.near; dm.uniforms.cameraFar.value = camera.far; }
    render0(r, w, rb, dt, mask);
  };
  return {
    pass: ssr,
    /** pick the reflective floors of a new build; returns how many */
    setTargets(groups, { enabled = true, scale = 1 } = {}) {
      strength = new Map(); const sel = [];
      if (enabled && groups) groups.floors.traverse((o) => {
        if (!o.isMesh || o.userData.kind !== 'floor') return;
        const k = floorReflect(o.userData.floorSpec) * scale;
        if (k > 0.01) { strength.set(o, Math.min(1, k)); sel.push(o); }
      });
      ssr.selects = sel; // selective mode (the pass needs a non-empty array to render the mask)
      return sel.length;
    },
    get count() { return strength.size; },
  };
}
