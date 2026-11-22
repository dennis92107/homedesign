import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WebGLPathTracer, PathTracingSceneGenerator, GradientEquirectTexture, DenoiseMaterial } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createAccumulator, stableShadowFit } from './quality.js';
import { buildScene, applyModels, resolveCollision, polygonArea } from './builder.js';
import { hdri, assetStats, setLocalCatalog } from './assets.js';
import { settings } from './materials.js';
import { emptyDesign, designPathFor, effective, merge3 } from './design.js';
import { createEditor } from './editor.js';
import { createPlanEditor } from './planEditor.js';
import { createFurnitureDrag } from './furnitureDrag.js';
import { store, detectMode, readText, writeJSON, pendingChanges, clearLocal, exportBundle, previewImport, applyImport } from './store.js';

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'label-layer';
viewport.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = roomEnv;

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 300);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true; orbit.maxPolarAngle = Math.PI * 0.49;

const hemi = new THREE.HemisphereLight(0xdfe9f3, 0x8a7f72, 0.6); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 3); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
scene.add(sun); scene.add(sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xcfd2cb, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground);

// post-processing (realtime): render → GTAO ambient occlusion → tone mapping / colour space
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, 1, 1);
gtao.blendIntensity = 1;
gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.5, thickness: 1.5, scale: 1.1, samples: 16 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
composer.addPass(gtao);
composer.addPass(new OutputPass());
// still camera → accumulate jittered frames (anti-aliasing + smoother AO), see quality.js
const accum = createAccumulator({ renderer, composer, camera, gtao, index: 2 });

// path tracer (photoreal mode)
let pathTracer = null;
const pt = { on: false, lastMatrix: new THREE.Matrix4(), dirty: false, maxSamples: 400, denoise: true };

// ---------- state ----------
const state = {
  library: { plans: [], styles: [] },
  planUrl: null, styleUrl: null, planText: '', styleText: '',
  plan: null, style: null, built: null,
  view: 'orbit', cutaway: true, showFurniture: true, showLabels: true, showUnderlay: false, showCeiling: 'auto',
  hour: 15, live: true, ao: true, envTex: null,
  // customization layer (designs/<plan>.json) + local model catalog
  design: emptyDesign(), designUrl: null, designCanon: '', catalog: { models: [] }, catalogCanon: '',
  selection: null, // { kind: 'furniture'|'floor'|'wall'|'ceiling'|'door'|'window', id?, room?, wall?, side? }
};
const canon = (o) => JSON.stringify(o);
let editor = null;
let planEditor = null;
let pollTick = 0;
const params = new URLSearchParams(location.search);

// ---------- loading ----------
// all data reads/writes go through store.js (server.py files, or this browser's local copy on a static host)
const fetchText = (url) => readText(url);

async function loadLibrary() {
  try {
    const lib = JSON.parse(await fetchText('library.json'));
    const changed = JSON.stringify(lib) !== JSON.stringify(state.library);
    state.library = lib;
    if (changed) fillSelects();
  } catch (e) { setStatus('library.json 讀取失敗：' + e.message, true); }
}
function fillSelects() {
  const fill = (sel, items, cur) => {
    sel.innerHTML = items.map((i) => `<option value="${i.file}">${i.name}</option>`).join('');
    if (cur) sel.value = cur;
  };
  fill($('#planSelect'), state.library.plans, state.planUrl);
  fill($('#styleSelect'), state.library.styles, state.styleUrl);
}

async function fetchJSONOr(url, fallback) {
  try { return JSON.parse(await fetchText(url)); } catch { return fallback; }
}
async function loadDesign(planUrl) {
  const url = designPathFor(planUrl);
  let d = await fetchJSONOr(url, null);
  state.designExists = !!d;
  if (!d) { try { d = JSON.parse(localStorage.getItem('design:' + url) || 'null'); } catch { d = null; } }
  state.designUrl = url;
  state.design = { ...emptyDesign(), ...(d || {}) };
  state.designCanon = canon(state.design);
  state.designBase = state.designExists ? clone(state.design) : null;
}
async function loadCatalog() {
  const c = await fetchJSONOr('models/catalog.json', { models: [] });
  if (canon(c) === state.catalogCanon) return false;
  state.catalog = c; state.catalogCanon = canon(c);
  setLocalCatalog(c.models || []);
  return true;
}

/**
 * styleUrl: explicit choice from the dropdown (also stored as the shared design.baseStyle);
 * when switching plans, the template saved in that plan's design layer wins so everyone sees the same one.
 */
async function load({ planUrl = state.planUrl, styleUrl, resetCamera = false, userPickedStyle = false } = {}) {
  try {
    const planChanged = planUrl !== state.planUrl;
    if (planChanged || !state.designUrl) { await loadDesign(planUrl); state.selection = null; planEditor?.resetView(); }
    styleUrl = (userPickedStyle && styleUrl) || state.design.baseStyle || styleUrl || state.styleUrl || state.library.styles[0]?.file;
    const [pt_, st] = await Promise.all([fetchText(planUrl), fetchText(styleUrl)]);
    state.planUrl = planUrl; state.styleUrl = styleUrl; state.planText = pt_; state.styleText = st;
    const planObj = JSON.parse(pt_); state.planBase = clone(planObj);
    applyData(planObj, JSON.parse(st), { resetCamera: resetCamera || planChanged });
    if (userPickedStyle && state.design.baseStyle !== styleUrl) commit((d) => { d.baseStyle = styleUrl; }, { rebuild: false });
    $('#planSelect').value = planUrl; $('#styleSelect').value = styleUrl;
    try { localStorage.setItem('hd:lastPlan', planUrl); } catch {}
    const u = new URL(location); u.searchParams.set('plan', planUrl); u.searchParams.set('style', styleUrl); history.replaceState(null, '', u);
  } catch (e) { setStatus('載入失敗：' + e.message, true); console.error(e); }
}

function cutHeight() { return state.view !== 'walk' && state.cutaway ? (state.plan?.cutawayHeight || 120) : null; }

function applyData(plan, style, { resetCamera = false } = {}) {
  accum.markDirty();
  const prevBounds = state.built?.bounds;
  const styleChanged = state.style !== style;
  state.plan = plan; state.style = style;
  rebuild();
  if (styleChanged) loadEnvironment();
  updatePanel();
  if (resetCamera || !prevBounds) frame(state.view);
  setStatus(`已更新 ${new Date().toLocaleTimeString()}`);
}

/** (re)build the house with the current plan/style/view; keeps the camera */
function rebuild() {
  accum.markDirty();
  if (!state.plan) return;
  if (state.built) { disposeTree(state.built.root); scene.remove(state.built.root); }
  const eff = effective(state.plan, state.style, state.design);
  state.eff = eff;
  const built = buildScene(eff.plan, eff.style, { cut: cutHeight() });
  state.built = built; built.cut = cutHeight(); scene.add(built.root);
  applyLighting(); applyVisibility();
  if (settings.pbr) applyModels(built, () => state.built === built).then(() => { if (state.built === built) { ptScene(); updateHighlight(); } });
  ptScene();
  updateHighlight();
  editor?.refresh();
}

// ---------- customization: commit / save ----------
let saveTimer = null;
/** mutate the design layer, then rebuild (or just refresh visibility) and save to designs/<plan>.json */
function commit(mutator, { rebuild: doRebuild = true } = {}) {
  mutator(state.design); accum.markDirty();
  state.designCanon = canon(state.design);
  if (doRebuild) rebuildSoon(); else { applyFurnitureVisibility(); editor?.refresh(); }
  state.savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await saveDesign(); state.savePending = false; }, 400);
}
// undo / redo for design-layer edits made in the 3D view (furniture drag, nudge, rotate).
// The 2D layout editor keeps its own history while it is open.
const designHistory = { undo: [], redo: [] };
function pushDesignUndo() {
  designHistory.undo.push(canon(state.design));
  if (designHistory.undo.length > 100) designHistory.undo.shift();
  designHistory.redo.length = 0;
}
function designUndo(redo = false) {
  const from = redo ? designHistory.redo : designHistory.undo, to = redo ? designHistory.undo : designHistory.redo;
  if (!from.length) { setStatus(redo ? '沒有可重做的步驟' : '沒有可復原的步驟'); return; }
  to.push(canon(state.design));
  const s = JSON.parse(from.pop());
  commit((d) => replaceContents(d, s));
  setStatus(redo ? '已重做' : '已復原');
}
addEventListener('keydown', (e) => {
  if (planEditor?.visible || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || !(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'y') { e.preventDefault(); designUndo(k === 'y' || e.shiftKey); }
});
let rebuildTimer = null;
function rebuildSoon() { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 60); }
const saveJSON = (path, content) => writeJSON(path, content);
const savedWhere = () => (store.local ? '已存在這台電腦（記得匯出變更帶回家）' : '已儲存');
const clone = (o) => JSON.parse(JSON.stringify(o));
function replaceContents(target, src) { Object.keys(target).forEach((k) => delete target[k]); Object.assign(target, src); }
/** before saving, fold in anything another person saved since our last sync */
async function mergeRemote(url, local, base) {
  const theirs = await fetchJSONOr(url, null);
  if (!theirs || !base || canon(theirs) === canon(base)) return false;
  const merged = merge3(base, local, theirs);
  if (canon(merged) === canon(local)) return false;
  replaceContents(local, merged);
  return true;
}
async function saveDesign() {
  try {
    if (state.designExists && await mergeRemote(state.designUrl, state.design, state.designBase)) {
      state.design = { ...emptyDesign(), ...state.design }; state.designCanon = canon(state.design);
      rebuildSoon(); setStatus('已合併另一位的修改');
    }
    await saveJSON(state.designUrl, state.design); state.designBase = clone(state.design); state.designExists = true;
    if (state.design.baseStyle && state.design.baseStyle !== state.styleUrl) load({ styleUrl: state.design.baseStyle }); // the other person switched template
    setStatus(`客製${savedWhere()} ${new Date().toLocaleTimeString()}`); }
  catch (e) {
    try { localStorage.setItem('design:' + state.designUrl, JSON.stringify(state.design)); } catch {}
    setStatus('無法寫入伺服器（請用 python server.py 啟動），已暫存在瀏覽器：' + e.message, true);
  }
}
// ---------- layout editor: plan structure changes ----------
let planSaveTimer = null;
function planChanged({ rebuild: doRebuild = true } = {}) {
  state.planSavePending = true;
  if (doRebuild) rebuildSoon();
  clearTimeout(planSaveTimer);
  planSaveTimer = setTimeout(async () => {
    try {
      if (await mergeRemote(state.planUrl, state.plan, state.planBase)) { rebuildSoon(); planEditor?.refresh(); setStatus('已合併另一位的平面圖修改'); }
      await saveJSON(state.planUrl, state.plan); state.planBase = clone(state.plan);
      setStatus(`平面圖${savedWhere()} ${new Date().toLocaleTimeString()}`);
    }
    catch (e) { setStatus('平面圖無法儲存（請用 python server.py 啟動）：' + e.message, true); }
    state.planSavePending = false;
  }, 500);
}
/** save the current (edited) plan under a new file and register it in library.json */
async function savePlanAs(name) {
  const file = `plans/plan-${Date.now().toString(36)}.json`;
  const plan = { ...JSON.parse(JSON.stringify(state.plan)), name };
  await saveJSON(file, plan);
  // carry the customization layer over to the copy
  await saveJSON(designPathFor(file), state.design);
  const lib = JSON.parse(await fetchText('library.json'));
  lib.plans.push({ name, file });
  await saveJSON('library.json', lib);
  await loadLibrary();
  await load({ planUrl: file, resetCamera: false });
  return file;
}

function applyFurnitureVisibility() {
  if (!state.built) return;
  const eff = effective(state.plan, state.style, state.design); state.eff = eff;
  const hidden = new Map(eff.plan.furniture.map((it) => [it.id, it.hidden]));
  state.built.groups.furniture.children.forEach((o) => { const id = o.userData.id; if (id && hidden.has(id)) o.visible = !hidden.get(id); });
  updateHighlight();
  ptScene();
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isCSS2DObject) o.element.remove();
  });
}

// live reload: re-read the JSON files Claude edits
async function poll() {
  if (store.local) return; // static host: nobody else writes these files, edits live in this browser
  if (state.live && state.planUrl) {
    try {
      const [pt_, st] = await Promise.all([fetchText(state.planUrl), fetchText(state.styleUrl)]);
      // the design layer may be edited by Claude on disk
      // no design file yet → only probe occasionally (avoids a 404 every 1.5 s)
      pollTick++;
      const probe = !state.savePending && (state.designExists || pollTick % 8 === 0);
      const d = probe ? await fetchJSONOr(state.designUrl, null) : null;
      if (d) state.designExists = true;
      let designChanged = false;
      if (d && !state.savePending && canon({ ...emptyDesign(), ...d }) !== state.designCanon) {
        state.design = { ...emptyDesign(), ...d }; state.designCanon = canon(state.design); state.designBase = clone(state.design); designChanged = true;
        // someone switched the shared template
        if (state.design.baseStyle && state.design.baseStyle !== state.styleUrl) { await load({ styleUrl: state.design.baseStyle }); flash(); setTimeout(poll, 1500); return; }
      }
      const catalogChanged = await loadCatalog();
      // compare canonically: the layout editor saves plans itself (server re-formats the JSON)
      const planNew = pt_ !== state.planText && !state.planSavePending && canon(JSON.parse(pt_)) !== canon(state.plan);
      if (pt_ !== state.planText && !state.planSavePending) { state.planText = pt_; state.planBase = JSON.parse(pt_); }
      if (planNew || st !== state.styleText) {
        const plan = planNew ? JSON.parse(pt_) : state.plan, style = JSON.parse(st);
        const styleSame = st === state.styleText;
        state.styleText = st;
        applyData(plan, styleSame ? state.style : style);
        planEditor?.refresh();
        flash();
      } else if (designChanged || catalogChanged) { rebuild(); flash(); }
      await loadLibrary();
    } catch (e) { setStatus('同步錯誤：' + e.message, true); }
  }
  setTimeout(poll, 1500);
}

// ---------- environment (HDRI sky) ----------
async function loadEnvironment() {
  const id = state.style?.lighting?.hdri ?? 'kloofendal_overcast_puresky';
  if (!id || !settings.pbr) { state.envTex = null; ptEnvSource(); applyVisibility(); ptEnv(); return; }
  try {
    const tex = await hdri(id);
    state.envTex = tex;
    scene.environment = tex;
    applyLighting(); applyVisibility(); ptEnv();
  } catch { scene.environment = roomEnv; }
}

// ---------- lighting ----------
const TONE = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, filmic: THREE.CineonToneMapping };
function applyLighting() {
  accum.markDirty();
  const L = state.style?.lighting || {};
  renderer.toneMapping = TONE[L.toneMapping || 'aces'] ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = L.exposure ?? 1.0;
  const h = state.hour; const night = h < 6 || h > 18.5;
  const a = (Math.PI * (h - 6)) / 12; const e = Math.max(0.06, Math.sin(Math.max(0, Math.min(Math.PI, a)))) * ((L.sunMaxElevation ?? 50) * Math.PI / 180);
  const b = state.built?.bounds || { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2; const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const r = 30;
  sun.position.set(cx + Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, cz + Math.sin(a) * Math.cos(e) * r);
  sun.target.position.set(cx, 0, cz);
  const sc = sun.shadow.camera; const ext = size * 0.75 + 1;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 80; sc.updateProjectionMatrix();
  sun.shadow.normalBias = 0.02; // walk view overrides box + bias every frame (walkShadow)
  const golden = Math.max(0, 1 - Math.sin(Math.max(0, Math.min(Math.PI, a))) * 2.2);
  sun.color.copy(new THREE.Color(L.sunColor || '#fff1dc').lerp(new THREE.Color('#ffb070'), golden * 0.6));
  sun.intensity = night ? 0 : (L.sunIntensity ?? 3) * (0.35 + 0.65 * Math.sin(Math.max(0.1, Math.min(Math.PI - 0.1, a))));
  hemi.color.set(L.skyColor || '#dfe9f3'); hemi.groundColor.set(L.groundColor || '#8a7f72');
  // with a real HDRI sky the hemisphere fill is mostly redundant
  hemi.intensity = (L.ambient ?? 0.6) * (night ? 0.15 : 1) * (state.envTex ? 0.35 : 1);
  ground.material.color.set(night ? '#2a2d2a' : (L.groundPlane || '#cfd2cb'));
  if (state.built) state.built.groups.lights.children.forEach((pl) => { pl.intensity = (L.room?.intensity ?? pl.userData.base ?? 4) * (night ? 1.8 : 1); });
  // realtime IBL is not occluded by walls/ceiling, so keep it low indoors to avoid a flat, washed-out look
  const walkView = state.view === 'walk';
  const envI = (state.envTex ? (walkView ? (L.hdriIntensityIndoor ?? 0.3) : (L.hdriIntensity ?? 0.6)) : (L.environment ?? 0.35)) * (night ? 0.08 : 1);
  scene.environmentIntensity = envI;
  scene.backgroundIntensity = walkView ? 1 : envI;
  state.night = night;
  applyBackground();
  if (pt.on) ptEnvSource();
  ptLights();
}

function applyBackground() {
  const L = state.style?.lighting || {};
  const walk = state.view === 'walk';
  if (walk && state.envTex && !state.night) { scene.background = state.envTex; scene.backgroundBlurriness = 0.02; }
  else scene.background = new THREE.Color(state.night ? (L.nightBackground || '#151a24') : (L.background || '#e8ecee'));
}

function applyVisibility() {
  const g = state.built?.groups; if (!g) return;
  const walk = state.view === 'walk';
  g.ceilings.visible = state.showCeiling === 'auto' ? walk : state.showCeiling;
  g.labels.visible = state.showLabels && !walk && !pt.on;
  g.underlay.visible = state.showUnderlay && !pt.on;
  labelRenderer.domElement.style.display = g.labels.visible ? '' : 'none';
  applyBackground();
}

// ---------- camera / views ----------
const walk = { yaw: 0, pitch: 0, keys: new Set(), eye: 1.6, dragging: false };
function frame(view) {
  const prevCut = state.built?.cut ?? null;
  state.view = view;
  if (state.built && (cutHeight() ?? null) !== prevCut) rebuild();
  const b = state.built.bounds; const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  document.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  document.body.classList.toggle('walking', view === 'walk');
  if (view === 'walk') {
    orbit.enabled = false;
    const sp = state.plan.spawn || {};
    const x = sp.x != null ? sp.x / 100 : cx, z = sp.y != null ? sp.y / 100 : cz;
    camera.position.set(x, walk.eye, z);
    // facing uses the furniture convention: 0 = looking toward +y (down on the drawing), 90 = toward -x
    walk.yaw = Math.PI - ((sp.facing ?? 0) * Math.PI) / 180; walk.pitch = -0.05;
    camera.fov = 70;
    camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
  } else {
    orbit.enabled = true; camera.fov = view === 'top' ? 40 : 45;
    orbit.target.set(cx, 0, cz);
    if (view === 'top') camera.position.set(cx, size * 1.55 + 2, cz + 0.01);
    else camera.position.set(cx + size * 0.55, size * 0.95, cz + size * 0.95);
    orbit.update();
  }
  camera.updateProjectionMatrix();
  applyVisibility();
  applyLighting();
  ptCamera();
}
function enterWalkAt(x, z) {
  frame('walk');
  camera.position.set(x, walk.eye, z);
}

// walk input
addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; walk.keys.add(e.code); if (e.code === 'Escape' && state.view === 'walk') frame('orbit'); });
addEventListener('keyup', (e) => walk.keys.delete(e.code));
// ---------- click to select a part (furniture / floor / wall face / ceiling / door / window) ----------
const clickStart = { x: 0, y: 0, t: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => { clickStart.x = e.clientX; clickStart.y = e.clientY; clickStart.t = performance.now(); });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y) > 5 || performance.now() - clickStart.t > 400) return;
  pickAt(e.clientX, e.clientY);
});
function pickAt(cx, cy) {
  if (!state.built) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  const g = state.built.groups;
  const targets = [g.furniture, g.walls, g.floors, ...(g.ceilings.visible ? [g.ceilings] : [])];
  const hits = ray.intersectObjects(targets, true).filter((h) => isVisibleChain(h.object) && !(h.object.material?.transparent && h.object.material.opacity < 0.6));
  const hit = hits[0];
  if (!hit) { select(null); return; }
  let o = hit.object;
  while (o && !o.userData?.kind) o = o.parent;
  if (!o) { select(null); return; }
  const u = o.userData;
  if (u.kind === 'furniture' || u.kind === 'pendant') select({ kind: 'furniture', id: u.id });
  else if (u.kind === 'wall') {
    const n = hit.face.normal.z; // wall boxes: local +Z = 'P' side, -Z = 'N' side
    const side = n > 0.5 ? 'P' : n < -0.5 ? 'N' : (u.P ? 'P' : 'N');
    const room = u[side];
    select(room ? { kind: 'wall', wall: u.wall, side, room } : { kind: 'exterior' });
  } else if (u.kind === 'door' || u.kind === 'window') select({ kind: u.kind });
  else select({ kind: u.kind, room: u.room });
}
function isVisibleChain(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }
function select(sel) {
  state.selection = sel;
  updateHighlight();
  editor?.showSelection(sel);
}
// selection outline
const highlight = new THREE.Box3Helper(new THREE.Box3(), 0xff7a2f);
highlight.visible = false; highlight.renderOrder = 999; highlight.material.depthTest = false; highlight.material.transparent = true;
scene.add(highlight);
function selectionObjects(sel) {
  if (!sel || !state.built) return [];
  const g = state.built.groups; const out = [];
  if (sel.kind === 'furniture') { const o = state.built.byId.get(sel.id); if (o?.visible) out.push(o); }
  else if (sel.kind === 'floor') g.floors.children.forEach((m) => m.userData.room === sel.room && out.push(m));
  else if (sel.kind === 'ceiling') g.floors.children.forEach((m) => m.userData.room === sel.room && out.push(m));
  else if (sel.kind === 'wall') g.walls.traverse((m) => m.userData?.kind === 'wall' && m.userData.wall === sel.wall && m.userData[sel.side] === sel.room && out.push(m));
  return out;
}
function updateHighlight() {
  accum.markDirty();
  const objs = selectionObjects(state.selection);
  if (!objs.length) { highlight.visible = false; return; }
  const box = highlight.box.makeEmpty();
  objs.forEach((o) => box.expandByObject(o));
  if (state.selection.kind === 'ceiling') { box.min.y = box.max.y = state.built.bounds.H; }
  box.expandByScalar(0.02);
  highlight.visible = !pt.on;
}
function focusOn(sel) {
  const objs = selectionObjects(sel); if (!objs.length) return;
  const box = new THREE.Box3(); objs.forEach((o) => box.expandByObject(o));
  const c = box.getCenter(new THREE.Vector3());
  if (state.view === 'walk') { const yaw = Math.atan2(camera.position.x - c.x, camera.position.z - c.z); walk.yaw = yaw; walk.pitch = Math.atan2(c.y - camera.position.y, Math.hypot(camera.position.x - c.x, camera.position.z - c.z)); }
  else { const d = camera.position.clone().sub(orbit.target); orbit.target.copy(c); camera.position.copy(c).add(d.multiplyScalar(0.6)); orbit.update(); }
  ptCamera();
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (state.view !== 'walk') return;
  walk.dragging = true; walk.lx = e.clientX; walk.ly = e.clientY; renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!walk.dragging) return;
  walk.yaw -= (e.clientX - walk.lx) * 0.004; walk.pitch -= (e.clientY - walk.ly) * 0.004;
  walk.pitch = Math.max(-1.3, Math.min(1.3, walk.pitch)); walk.lx = e.clientX; walk.ly = e.clientY;
});
renderer.domElement.addEventListener('pointerup', () => (walk.dragging = false));
renderer.domElement.addEventListener('wheel', (e) => { if (state.view === 'walk') { camera.fov = Math.max(35, Math.min(90, camera.fov + e.deltaY * 0.03)); camera.updateProjectionMatrix(); ptCamera(); } });
const ray = new THREE.Raycaster();
// drag / rotate furniture directly in 3D (see furnitureDrag.js); listens in the capture phase on #viewport,
// so it gets the pointer before OrbitControls / walk-look when the selected piece is grabbed
const furnDrag = createFurnitureDrag({
  renderer, camera, viewport, state, commit, select, setStatus, pushUndo: pushDesignUndo,
  onMoved: () => { updateHighlight(); },
  ptOn: () => pt.on,
  planEditorVisible: () => !!planEditor?.visible,
});
renderer.domElement.addEventListener('dblclick', (e) => {
  if (state.view === 'walk' || !state.built) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(state.built.groups.floors.children)[0];
  if (hit) { const yaw = Math.atan2(camera.position.x - hit.point.x, camera.position.z - hit.point.z); enterWalkAt(hit.point.x, hit.point.z); walk.yaw = yaw; walk.pitch = -0.05; }
});

function updateWalk(dt) {
  const k = walk.keys; const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 3.2 : 1.6) * dt;
  let f = 0, s = 0;
  if (k.has('KeyW') || k.has('ArrowUp')) f += 1; if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
  if (k.has('KeyA')) s -= 1; if (k.has('KeyD')) s += 1;
  if (k.has('ArrowLeft') || k.has('KeyQ')) walk.yaw += 1.8 * dt; if (k.has('ArrowRight') || k.has('KeyE')) walk.yaw -= 1.8 * dt;
  const dir = new THREE.Vector3(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw));
  const right = new THREE.Vector3(-dir.z, 0, dir.x);
  let x = camera.position.x + (dir.x * f + right.x * s) * speed;
  let z = camera.position.z + (dir.z * f + right.z * s) * speed;
  if (f || s) [x, z] = resolveCollision(state.built, x, z, 0.22);
  camera.position.set(x, walk.eye, z);
  camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
}

// ---------- path tracing ----------
function ensurePathTracer() {
  if (pathTracer) return pathTracer;
  pathTracer = new WebGLPathTracer(renderer);
  pathTracer.bounces = 6;
  pathTracer.transmissiveBounces = 6;
  pathTracer.filterGlossyFactor = 0.5;
  pathTracer.minSamples = 1;
  pathTracer.renderDelay = 0;
  pathTracer.fadeDuration = 300;
  pathTracer.dynamicLowRes = true;
  pathTracer.lowResScale = 0.25;
  pathTracer.tiles.set(1, 1);
  // edge-aware denoise as the final pass (the library's DenoiseMaterial, set up like its official example);
  // it fades out as samples accumulate, so the converged image keeps all its detail
  const denoiseQuad = new FullScreenQuad(new DenoiseMaterial({ map: null, blending: THREE.CustomBlending, premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha }));
  pathTracer.renderToCanvasCallback = (target, r, quad) => {
    const n = pathTracer.samples, on = pt.denoise && n < pt.maxSamples * 0.9;
    const auto = r.autoClear; r.autoClear = false;
    if (on) {
      const m = denoiseQuad.material, k = Math.min(1, n / 200); // strong at first, gentle once converged
      m.sigma = 5 - 3 * k; m.threshold = 0.1 - 0.07 * k; m.kSigma = 1; m.opacity = quad.material.opacity;
      m.map = target.texture; denoiseQuad.render(r);
    } else { quad.material.map = target.texture; quad.render(r); }
    r.autoClear = auto;
  };
  return pathTracer;
}
let ptSceneTimer = null;
function ptScene() {
  if (!pt.on) return;
  clearTimeout(ptSceneTimer);
  ptSceneTimer = setTimeout(() => {
    if (!pt.on) return;
    setStatus('真實渲染：建立光線加速結構…');
    try {
      camera.updateMatrixWorld();
      const p = ensurePathTracer();
      // a fresh generator each time: the incremental one can mis-assign material indices after meshes are swapped
      p._generator = new PathTracingSceneGenerator();
      ptEnvSource();
      const nMats = bakeProxy();
      p.setScene(ptProxy, camera);
      setStatus(`真實渲染中（${nMats} 種材質）`);
    }
    catch (e) { console.error(e); setStatus('真實渲染失敗：' + e.message, true); }
  }, 150);
}
// The path tracer stores per-vertex material ids and caps out at 255 material slots; our scene has hundreds of
// small meshes (multi-material wall boxes etc.), so bake a proxy scene with ONE merged mesh per material.
const ptProxy = new THREE.Scene();
function bakeProxy() {
  for (const c of [...ptProxy.children]) { ptProxy.remove(c); c.geometry?.dispose(); }
  scene.updateMatrixWorld(true);
  const buckets = new Map(); // material -> { pos:[], nor:[], uv:[] }
  const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  scene.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry?.attributes.position) return;
    const g = o.geometry; const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv; const I = g.index;
    const total = I ? I.count : P.count;
    const multi = Array.isArray(o.material);
    const groups = multi && g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
    nm.getNormalMatrix(o.matrixWorld);
    for (const gr of groups) {
      const mat = multi ? o.material[gr.materialIndex] : o.material;
      if (!mat || mat.visible === false) continue;
      let b = buckets.get(mat); if (!b) buckets.set(mat, (b = { pos: [], nor: [], uv: [] }));
      const end = Math.min(total, gr.start + gr.count);
      for (let k = gr.start; k < end; k++) {
        const i = I ? I.getX(k) : k;
        v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); b.pos.push(v.x, v.y, v.z);
        if (N) { n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); b.nor.push(n.x, n.y, n.z); } else b.nor.push(0, 1, 0);
        if (U) b.uv.push(U.getX(i), U.getY(i)); else b.uv.push(0, 0);
      }
    }
  });
  for (const [mat, b] of buckets) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    ptProxy.add(new THREE.Mesh(geo, mat));
  }
  const lightsOn = state.night || state.style?.lighting?.room?.dayOn;
  scene.traverseVisible((o) => {
    if (!o.isLight || o.isHemisphereLight || o.isAmbientLight) return;
    if (o.isPointLight && !lightsOn) return; // daytime photo: artificial lights off, daylight only
    const l = o.clone(); l.position.setFromMatrixPosition(o.matrixWorld);
    if (o.isDirectionalLight || o.isSpotLight) { l.target = new THREE.Object3D(); l.target.position.setFromMatrixPosition(o.target.matrixWorld); ptProxy.add(l.target); }
    ptProxy.add(l);
  });
  syncProxyEnv();
  return buckets.size;
}
function syncProxyEnv() {
  for (const k of ['environment', 'environmentIntensity', 'environmentRotation', 'background', 'backgroundIntensity', 'backgroundBlurriness', 'backgroundRotation']) ptProxy[k] = scene[k];
}

// the path tracer needs an equirect environment: use the HDRI, or a simple sky gradient as fallback
let skyGradient = null;
function ptEnvSource() {
  if (pt.on && !state.envTex) {
    if (!skyGradient) { skyGradient = new GradientEquirectTexture(64); skyGradient.topColor.set('#dfe9f3'); skyGradient.bottomColor.set('#8a7f72'); skyGradient.update(); }
    scene.environment = skyGradient;
  } else scene.environment = state.envTex || roomEnv;
  if (pt.on) {
    // path tracing handles occlusion physically, so the sky can be used at full strength
    const L = state.style?.lighting || {};
    scene.environmentIntensity = scene.backgroundIntensity = state.night ? 0.03 : (L.ptEnvironment ?? 1);
    // interior photography exposes for the room (windows may blow out)
    renderer.toneMappingExposure = (L.exposure ?? 1) * (state.view === 'walk' ? (L.ptExposure ?? 1.6) : 1);
  }
}
function ptCamera() { if (pt.on && pathTracer) { camera.updateMatrixWorld(); pathTracer.updateCamera(); } }
function ptLights() { if (pt.on && pathTracer) ptScene(); }
function ptEnv() { if (pt.on && pathTracer) { ptEnvSource(); syncProxyEnv(); pathTracer.updateEnvironment(); } }
function setPT(on) {
  pt.on = on;
  if (!on) { ptEnvSource(); applyLighting(); }
  $('#ptBtn').classList.toggle('active', on);
  document.body.classList.toggle('pt', on);
  applyVisibility();
  if (on) ptScene(); else setStatus('即時預覽');
}
// re-sync the path tracer when streamed textures/models finish
assetStats.listeners.add((s) => {
  accum.markDirty(); // a texture / model just streamed in
  $('#assetStatus').textContent = s.pending ? `下載真實素材中… (${s.pending})` : (s.failed ? `素材 ${s.loaded} 個（${s.failed} 個失敗，已用程序材質代替）` : (s.loaded ? `真實素材 ${s.loaded} 個已載入` : ''));
  if (!s.pending) ptScene();
});

// ---------- panel ----------
function updatePanel() {
  const { plan, style } = state;
  $('#styleName').textContent = style.name || '';
  $('#styleDesc').textContent = style.description || '';
  $('#palette').innerHTML = (style.palette || []).map((c) => `<span title="${c}" style="background:${c}"></span>`).join('');
  const refs = style.references || [];
  $('#refs').innerHTML = refs.map((r) => {
    const img = typeof r === 'string' ? r : r.image;
    const note = typeof r === 'string' ? '' : r.note || '';
    return `<a href="${img}" target="_blank" title="${note}"><img src="${img}" alt="${note}" loading="lazy" onerror="this.parentNode.classList.add('broken')"><em>${note}</em></a>`;
  }).join('');
  $('#refsBox').hidden = !refs.length;
  let total = 0;
  $('#rooms').innerHTML = (plan.rooms || []).map((r) => {
    const a = polygonArea(r.polygon) / 10000; total += a;
    return `<tr><td>${r.name}</td><td>${a.toFixed(1)} m²</td><td>${(a / 3.3058).toFixed(1)} 坪</td></tr>`;
  }).join('') + `<tr class="total"><td>合計</td><td>${total.toFixed(1)} m²</td><td>${(total / 3.3058).toFixed(1)} 坪</td></tr>`;
  $('#planName').textContent = plan.name || '';
  $('#underlayToggle').disabled = !plan.underlay?.image;
}

let flashTimer;
function setStatus(msg, err = false) { const el = $('#status'); el.textContent = msg; el.classList.toggle('err', err); }
function flash() { viewport.classList.add('flash'); clearTimeout(flashTimer); flashTimer = setTimeout(() => viewport.classList.remove('flash'), 600); }

$('#planSelect').onchange = (e) => load({ planUrl: e.target.value, resetCamera: true });
$('#styleSelect').onchange = (e) => load({ styleUrl: e.target.value, userPickedStyle: true });
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => frame(b.dataset.view)));
const bindToggle = (id, key, fn = applyVisibility) => { const el = $(id); el.checked = state[key]; el.onchange = () => { state[key] = el.checked; fn(); }; };
bindToggle('#cutToggle', 'cutaway', () => rebuild());
bindToggle('#labelToggle', 'showLabels'); bindToggle('#underlayToggle', 'showUnderlay');
bindToggle('#aoToggle', 'ao', () => {});
$('#accumToggle').onchange = (e) => { accum.enabled = e.target.checked; };
$('#ptDenoise').onchange = (e) => { pt.denoise = e.target.checked; };
$('#pbrToggle').checked = settings.pbr;
$('#pbrToggle').onchange = (e) => { settings.pbr = e.target.checked; loadEnvironment(); rebuild(); };
$('#liveToggle').checked = true; $('#liveToggle').onchange = (e) => (state.live = e.target.checked);
$('#ceilToggle').onchange = (e) => { state.showCeiling = e.target.checked ? true : 'auto'; applyVisibility(); ptScene(); };
$('#hour').oninput = (e) => { state.hour = +e.target.value; $('#hourLabel').textContent = fmtHour(state.hour); applyLighting(); };
const fmtHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'}`;
$('#ptBtn').onclick = () => setPT(!pt.on);
$('#shot').onclick = () => {
  if (!pt.on) renderFrame();
  const a = document.createElement('a'); a.download = `${state.plan.name || 'home'}-${state.style.name || 'style'}${pt.on ? '-render' : ''}.png`;
  a.href = renderer.domElement.toDataURL('image/png'); a.click();
};
$('#togglePanel').onclick = () => document.body.classList.toggle('panel-hidden');

addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) {
    if (!f.name.endsWith('.json')) continue;
    const data = JSON.parse(await f.text());
    state.live = false; $('#liveToggle').checked = false;
    if (data.walls) applyData(data, state.style, { resetCamera: true }); else applyData(state.plan, data);
    setStatus(`已載入拖放的 ${f.name}（已暫停即時同步）`);
  }
});

// ---------- loop ----------
function resize() {
  accum.markDirty();
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h); labelRenderer.setSize(w, h); composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  ptCamera();
}
new ResizeObserver(resize).observe(viewport);

function renderFrame() {
  if (pt.on && pathTracer) {
    camera.updateMatrixWorld();
    if (!pt.lastMatrix.equals(camera.matrixWorld)) { pt.lastMatrix.copy(camera.matrixWorld); pathTracer.updateCamera(); }
    if (pathTracer.samples < pt.maxSamples) pathTracer.renderSample();
    $('#ptSamples').textContent = `取樣 ${Math.floor(pathTracer.samples)} / ${pt.maxSamples}`;
    return;
  }
  if (state.view === 'walk') walkShadow();
  gtao.enabled = !!state.ao;
  accum.before(); composer.render(); accum.after();
  furnDrag.render(); // drag helpers (footprint, rotate ring, wall distances) on top
}
/**
 * Depth precision: the depth buffer spends most of its precision right after the near plane, so a tiny near plane
 * (needed when walking up to furniture) leaves almost none for a bird's-eye view 20 m away → coplanar-ish faces
 * flicker. Outside walk mode the near plane is pushed out to half the distance to the house (and to the ground),
 * which raises precision at the house roughly in proportion (×10–100). Far stays fixed.
 */
const _houseBox = new THREE.Box3();
function updateNearFar() {
  let near = 0.05;
  if (state.view !== 'walk' && state.built?.bounds) {
    const b = state.built.bounds, top = (state.plan?.wallHeight || 280) / 100 + 1;
    _houseBox.min.set(b.minX - 1.5, -0.1, b.minZ - 1.5); _houseBox.max.set(b.maxX + 1.5, top, b.maxZ + 1.5);
    near = Math.max(0.05, Math.min(_houseBox.distanceToPoint(camera.position), camera.position.y) * 0.5);
  }
  if (Math.abs(camera.near - near) > 1e-3 * near) { camera.near = near; camera.updateProjectionMatrix(); }
}
/** walk view: sun shadow box follows the walker (centred a few metres ahead), snapped to shadow texels */
const _ahead = new THREE.Vector3();
function walkShadow() {
  camera.getWorldDirection(_ahead); _ahead.y = 0; if (_ahead.lengthSq() < 1e-6) _ahead.set(0, 0, -1);
  _ahead.normalize().multiplyScalar(3).add(camera.position); _ahead.y = 1.2;
  stableShadowFit(sun, { center: _ahead, radius: 6.5, mapSize: sun.shadow.mapSize.x });
}
// anything the user does may change the picture (drag, sliders, keys…): restart the still-frame accumulation
for (const ev of ['pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change']) addEventListener(ev, () => accum.markDirty(), { capture: true, passive: true });
addEventListener('pointermove', (e) => { if (e.buttons) accum.markDirty(); }, { capture: true, passive: true });
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  if (!state.built) return;
  if (state.view === 'walk') updateWalk(dt); else orbit.update();
  updateNearFar();
  renderFrame();
  if (!pt.on) labelRenderer.render(scene, camera);
});

// ---------- boot ----------
/** bake the current template + customization into a new style template */
async function saveAsTemplate(name) {
  const slug = 'custom-' + Date.now().toString(36);
  const file = `styles/${slug}.json`;
  const merged = { ...effective(state.plan, state.style, state.design).style, name, description: `由「${state.style.name || ''}」客製而來` };
  await saveJSON(file, merged);
  const lib = JSON.parse(await fetchText('library.json'));
  lib.styles.push({ name, file });
  await saveJSON('library.json', lib);
  await loadLibrary();
  // the overrides are now part of the template
  commit((d) => { d.style = {}; }, { rebuild: false });
  await load({ styleUrl: file, userPickedStyle: true });
  return file;
}
/** upload a GLB and register it in models/catalog.json */
const LOCAL_ONLY_MSG = '公司版（本機模式）不能匯入模型：請回家用 server.py 開網站再匯入，之後重新上傳網站。';
async function uploadModel(fileObj, meta) {
  if (store.local) throw new Error(LOCAL_ONLY_MSG);
  const r = await fetch('api/upload?name=' + encodeURIComponent(fileObj.name), { method: 'POST', body: fileObj });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  const id = 'local:' + fileObj.name.replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '_');
  const cat = { models: [...(state.catalog.models || []).filter((m) => m.id !== id), { id, name: meta.name || fileObj.name, type: meta.type, types: [meta.type], file: j.path, source: 'upload', rotate: 0, addedAt: new Date().toISOString() }] };
  await saveJSON('models/catalog.json', cat);
  await loadCatalog();
  return id;
}

/** download a model from the free ABO library via the local server (optimised + registered) */
async function importLibraryModel(aboId, type) {
  if (store.local) throw new Error(LOCAL_ONLY_MSG);
  const r = await fetch('api/import-abo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: aboId, type }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  await loadCatalog();
  return j.entry.id;
}

// ---------- home ↔ office: export / import change bundles (see store.js) ----------
function updateSyncPanel() {
  const n = pendingChanges().length;
  $('#syncMode').innerHTML = store.local
    ? `<b>公司版・本機模式</b>：修改存在這台電腦的瀏覽器。${n ? `<span class="warn-text">有 ${n} 個檔案還沒匯出</span>` : '目前沒有未匯出的修改。'}`
    : `<b>家裡（server.py）</b>：修改直接存成檔案${store.readonly ? '（唯讀）' : ''}。`;
  $('#exportBtn').textContent = store.local ? '⬇ 匯出變更（帶回家）' : '⬇ 匯出完整快照（帶去公司）';
  $('#clearLocalBtn').hidden = !store.local;
}
store.onChange(updateSyncPanel);
async function flushSaves() {
  for (let i = 0; i < 40 && (state.savePending || state.planSavePending); i++) await new Promise((r) => setTimeout(r, 100));
}
async function exportChanges() {
  await flushSaves();
  const b = await exportBundle();
  const n = Object.keys(b.files).length;
  if (!n) { alert('沒有需要匯出的修改。'); return null; }
  const d = new Date(); const pad = (v) => String(v).padStart(2, '0');
  const name = `homedesign-${b.kind === 'snapshot' ? '完整快照' : '公司變更'}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const a = document.createElement('a'); a.download = name;
  a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }));
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus(`已匯出 ${n} 個檔案：${name}`);
  return b;
}
const IMPORT_LABEL = { new: '新增', update: '更新', merge: '合併（兩邊都有改）', same: '沒變', skip: '略過（不支援的路徑）' };
async function importChanges(bundle, { confirmFirst = true } = {}) {
  await flushSaves();
  const plan = await previewImport(bundle);
  const todo = plan.filter((p) => p.status !== 'same' && p.status !== 'skip');
  const lines = plan.map((p) => `・${p.path}：${IMPORT_LABEL[p.status]}`).join('\n');
  if (!todo.length) { if (confirmFirst) alert('變更包的內容和目前一樣，不需要匯入。\n\n' + lines); await applyImport(plan); return 0; }
  if (confirmFirst && !confirm(`匯入${bundle.kind === 'snapshot' ? '完整快照' : '變更'}（${bundle.createdAt?.slice(0, 16).replace('T', ' ') || ''}）\n\n${lines}\n\n「合併」= 兩邊都有修改，會合在一起；同一個設定兩邊都改時以匯入的為準。\n確定匯入？`)) return -1;
  const n = await applyImport(plan);
  setStatus(`已匯入 ${n} 個檔案，重新載入中…`);
  // a plan this site didn't have yet (e.g. the real floor plan, kept off the public site) → open it after reload
  const fresh = plan.find((p) => p.status === 'new' && /^plans\//.test(p.path));
  const u = new URL(location);
  if (fresh) { u.searchParams.set('plan', fresh.path); u.searchParams.delete('style'); }
  setTimeout(() => location.replace(u), 300);
  return n;
}
$('#exportBtn').onclick = () => exportChanges().catch((e) => alert('匯出失敗：' + e.message));
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { await importChanges(JSON.parse(await f.text())); } catch (err) { alert('匯入失敗：' + err.message); }
};
$('#clearLocalBtn').onclick = () => {
  const n = pendingChanges().length;
  if (!confirm(`清除這台電腦上的所有本機修改，回到網站上傳時的版本？${n ? `\n\n⚠ 還有 ${n} 個檔案沒匯出，清除後無法復原。` : ''}`)) return;
  clearLocal(); location.reload();
};

(async () => {
  await detectMode();
  document.body.classList.toggle('local-mode', store.local);
  updateSyncPanel();
  if (store.local) $('#liveToggle').closest('label').style.display = 'none'; // nothing to sync with on a static host
  planEditor = createPlanEditor({
    state, commit, planChanged, savePlanAs,
    selectFurniture: (id) => { editor.setTab('furniture'); select({ kind: 'furniture', id }); },
  });
  editor = createEditor({
    state, commit, select, focusOn, rebuild, saveAsTemplate, uploadModel, importLibraryModel,
    onTab: (t) => { if (!planEditor) return; if (t === 'layout') { if (state.view !== 'top') frame('top'); planEditor.show(); } else planEditor.hide(); },
    applyStyleFile: (file) => load({ styleUrl: file, userPickedStyle: true }),
  });
  await loadCatalog();
  await loadLibrary();
  state.hour = +(params.get('hour') || 15); $('#hour').value = state.hour; $('#hourLabel').textContent = fmtHour(state.hour);
  // ?plan= → last plan viewed in this browser → first in the library (a public site may not have the plan yet)
  const has = (f) => f && state.library.plans.some((p) => p.file === f);
  let lastPlan = null; try { lastPlan = localStorage.getItem('hd:lastPlan'); } catch {}
  const planUrl = [params.get('plan'), lastPlan].find(has) || state.library.plans[0]?.file;
  const styleUrl = params.get('style') || state.library.styles[0]?.file;
  state.view = params.get('view') || 'orbit';
  if (params.get('cut') === '0') { state.cutaway = false; $('#cutToggle').checked = false; }
  if (params.get('pbr') === '0') { settings.pbr = false; $('#pbrToggle').checked = false; }
  await load({ planUrl, styleUrl, resetCamera: true });
  frame(state.view);
  poll();
})();

// ---------- debug helpers (work in background tabs) ----------
function snap() {
  if (state.view === 'walk') camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ'); else orbit.update();
  updateNearFar(); renderFrame();
  let img = document.getElementById('snap');
  if (!img) { img = document.createElement('img'); img.id = 'snap'; img.onclick = () => img.remove(); img.style = 'position:fixed;inset:0;z-index:99;width:100vw;height:100vh;object-fit:contain;background:#000;cursor:pointer'; document.body.appendChild(img); }
  img.src = renderer.domElement.toDataURL();
  return 'ok';
}
/**
 * z-fighting detector: render the same view with slightly different near/far planes; pixels whose colour changes
 * are surfaces fighting over depth (flicker). Returns the culprit mesh pairs. `await app.zfight('walk')`
 */
async function zfight(view, { w = 1000, h = 700, show = true } = {}) {
  const prev = { w: renderer.domElement.clientWidth, h: renderer.domElement.clientHeight };
  setSize(w, h); if (view) frame(view);
  if (state.view === 'walk') camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ'); else orbit.update();
  updateNearFar(); camera.updateMatrixWorld();
  const W = renderer.domElement.width, H = renderer.domElement.height;
  const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const x2 = c2.getContext('2d', { willReadFrequently: true });
  const grab = () => { renderer.render(scene, camera); x2.drawImage(renderer.domElement, 0, 0); return x2.getImageData(0, 0, W, H).data; };
  const n0 = camera.near, f0 = camera.far; const shots = [];
  for (const [n, f] of [[1, 1], [1.03, 1], [1, 1.1], [0.97, 0.9], [1.06, 1.2]]) { camera.near = n0 * n; camera.far = f0 * f; camera.updateProjectionMatrix(); shots.push(grab()); }
  camera.near = n0; camera.far = f0; camera.updateProjectionMatrix();
  const base = shots[0]; const pts = [];
  for (let i = 0; i < W * H; i++) for (const s of shots.slice(1)) {
    if (Math.abs(s[i * 4] - base[i * 4]) + Math.abs(s[i * 4 + 1] - base[i * 4 + 1]) + Math.abs(s[i * 4 + 2] - base[i * 4 + 2]) > 30) { pts.push(i); break; }
  }
  const rc = new THREE.Raycaster(), groups = {};
  const tag = (o) => { for (let p = o; p && p !== scene; p = p.parent) { const u = p.userData || {}; if (u.kind) return u.kind + (u.wall != null ? '#' + u.wall : '') + (u.id ? ':' + u.id : ''); } return o.name || o.geometry?.type; };
  for (let k = 0; k < pts.length; k += Math.max(1, Math.floor(pts.length / 400))) {
    const i = pts[k]; rc.setFromCamera(new THREE.Vector2((i % W) / W * 2 - 1, -(Math.floor(i / W) / H * 2 - 1)), camera);
    const hits = rc.intersectObjects(scene.children, true).filter((q) => q.object.isMesh && isVisibleChain(q.object));
    const a = hits[0], b = a && hits.find((q) => q.object !== a.object);
    if (!b) continue;
    const key = `${tag(a.object)} vs ${tag(b.object)} ${(b.distance - a.distance) * 1000 <= 2 ? '≤2mm' : '>2mm'}`;
    groups[key] = (groups[key] || 0) + 1;
  }
  if (show) {
    const img = x2.createImageData(W, H); const mask = new Uint8Array(W * H); pts.forEach((i) => { mask[i] = 1; });
    for (let i = 0; i < W * H; i++) { const m = mask[i]; img.data[i * 4] = m ? 255 : base[i * 4] * 0.5 + 90; img.data[i * 4 + 1] = m ? 0 : base[i * 4 + 1] * 0.5 + 90; img.data[i * 4 + 2] = m ? 0 : base[i * 4 + 2] * 0.5 + 90; img.data[i * 4 + 3] = 255; }
    x2.putImageData(img, 0, 0); snap(); document.getElementById('snap').src = c2.toDataURL();
  }
  if (prev.w && prev.h && (prev.w !== w || prev.h !== h)) setSize(prev.w, prev.h);
  return { changed: pts.length, pct: +(pts.length / (W * H) * 100).toFixed(3), groups: Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 12) };
}
/** run n path-tracing samples synchronously (for screenshots while the tab is hidden) */
async function ptSamples(n = 64) {
  if (!pt.on) setPT(true);
  await new Promise((r) => setTimeout(r, 400));
  if (!pathTracer) return 'no pt';
  camera.updateMatrixWorld(); pathTracer.updateCamera(); pt.lastMatrix.copy(camera.matrixWorld);
  const t0 = performance.now();
  while ((pathTracer.isCompiling || pathTracer.samples < 1) && performance.now() - t0 < 38000) {
    pathTracer.renderSample();
    await new Promise((r) => setTimeout(r, 50));
  }
  // synchronous burst: background tabs throttle timers, so don't yield between samples
  const fade = pathTracer.fadeDuration, lowRes = pathTracer.dynamicLowRes;
  pathTracer.fadeDuration = 0; pathTracer.dynamicLowRes = false; // low-res preview resets accumulation in a sync burst
  const gl = renderer.getContext();
  for (let i = 0; i < n * 2 && pathTracer.samples < n && performance.now() - t0 < 40000; i++) { pathTracer.renderSample(); if (i % 10 === 9) gl.finish(); }
  pathTracer.fadeDuration = fade; pathTracer.dynamicLowRes = lowRes;
  snap();
  return { samples: Math.floor(pathTracer.samples), compiling: pathTracer.isCompiling, ms: Math.round(performance.now() - t0) };
}
function setSize(w, h) {
  renderer.setSize(w, h); labelRenderer.setSize(w, h); composer.setSize(w, h);
  gtao.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  camera.aspect = w / h; camera.updateProjectionMatrix(); ptCamera();
}
window.app = { accum, zfight, store, exportBundle, importChanges, pendingChanges, setSize, composer, gtao, commit, select, pickAt, editor: () => editor, state, frame, load, rebuild, enterWalkAt, camera, orbit, scene, renderer, walk, snap, ptSamples, setPT, applyLighting, assetStats, get pathTracer() { return pathTracer; } };
