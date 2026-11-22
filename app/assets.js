// Poly Haven (CC0) asset loader: PBR textures, glTF furniture models, HDRIs.
// Everything streams from the Poly Haven CDN at runtime; if offline, callers keep procedural fallbacks.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const API = 'https://api.polyhaven.com';
const filesCache = new Map();
const infoCache = new Map();
const texCache = new Map();
const modelCache = new Map();
const hdriCache = new Map();
const texLoader = new THREE.TextureLoader();
export const assetStats = { pending: 0, loaded: 0, failed: 0, listeners: new Set() };
function track(p) {
  assetStats.pending++; emit();
  return p.then((v) => { assetStats.pending--; assetStats.loaded++; emit(); return v; },
    (e) => { assetStats.pending--; assetStats.failed++; emit(); console.warn('[assets]', e.message || e); throw e; });
}
function emit() { assetStats.listeners.forEach((f) => f(assetStats)); }

async function json(url, cache) {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url} HTTP ${r.status}`); return r.json(); }));
  return cache.get(url);
}
const files = (id) => json(`${API}/files/${id}`, filesCache);
const info = (id) => json(`${API}/info/${id}`, infoCache);

function loadTex(url, srgb) {
  return new Promise((res, rej) => texLoader.load(url, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    res(t);
  }, undefined, () => rej(new Error('texture ' + url))));
}

/** average colour of a texture in linear space (used to re-tint photo textures to a style colour) */
function averageLinear(tex) {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const ctx = c.getContext('2d'); ctx.drawImage(tex.image, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let r = 0, g = 0, b = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

/** PBR texture set { map, normalMap, armMap, worldSize(m), avg } */
export function pbrSet(id, res = '1k') {
  const key = id + res;
  if (!texCache.has(key)) {
    texCache.set(key, track((async () => {
      const [f, i] = await Promise.all([files(id), info(id).catch(() => ({}))]);
      const pick = (k) => f[k]?.[res]?.jpg?.url;
      const [map, normalMap, armMap] = await Promise.all([
        pick('Diffuse') ? loadTex(pick('Diffuse'), true) : null,
        pick('nor_gl') ? loadTex(pick('nor_gl'), false) : null,
        pick('arm') ? loadTex(pick('arm'), false) : (pick('Rough') ? loadTex(pick('Rough'), false) : null),
      ]);
      const dims = i.dimensions || [1000, 1000];
      return { map, normalMap, armMap, isArm: !!pick('arm'), worldSize: (dims[0] || 1000) / 1000, avg: map ? averageLinear(map) : null };
    })()));
  }
  return texCache.get(key);
}

/**
 * Upgrade a MeshStandardMaterial in place with a Poly Haven texture set.
 * mode: 'retint' (photo texture shifted to target colour), 'detail' (normal/roughness only, flat colour), 'original'
 */
export async function upgradeMaterial(mat, id, { color, mode = 'retint', scale = 1, rotation = 0, roughness, normalScale = 1 } = {}) {
  const set = await pbrSet(id);
  const prep = (t) => {
    if (!t) return null;
    const c = t.clone(); c.needsUpdate = true;
    const s = 1 / (set.worldSize * scale);
    c.repeat.set(s, s);
    if (rotation) { c.center.set(0.5, 0.5); c.rotation = (rotation * Math.PI) / 180; }
    return c;
  };
  if (mode !== 'detail' && set.map) {
    mat.map = prep(set.map);
    if (mode === 'retint' && color && set.avg) {
      const tgt = new THREE.Color(color);
      mat.color.setRGB(Math.min(6, tgt.r / Math.max(0.01, set.avg.r)), Math.min(6, tgt.g / Math.max(0.01, set.avg.g)), Math.min(6, tgt.b / Math.max(0.01, set.avg.b)));
    } else mat.color.set(0xffffff);
  } else if (color) { mat.map = null; mat.color.set(color); }
  if (set.normalMap) { mat.normalMap = prep(set.normalMap); mat.normalScale.set(normalScale, normalScale); }
  if (set.armMap) {
    mat.roughnessMap = prep(set.armMap);
    if (set.isArm) { mat.aoMap = mat.roughnessMap; mat.aoMapIntensity = 0.6; }
    mat.roughness = roughness ?? 1;
  }
  mat.needsUpdate = true;
  return mat;
}

// ---------- models ----------
// Local catalog (models/catalog.json): GLBs uploaded by the user or generated (Tripo / Magnific / …).
const localModels = new Map();
export function setLocalCatalog(list = []) { localModels.clear(); for (const m of list) localModels.set(m.id, m); }
export function localCatalog() { return [...localModels.values()]; }
export function modelEntry(id) {
  if (localModels.has(id)) return { ...localModels.get(id), source: localModels.get(id).source || 'local' };
  const info = MODEL_INFO[id];
  return info ? { id, ...info, source: 'polyhaven' } : (id ? { id, name: id, types: [], source: 'polyhaven' } : null);
}
/** all models usable for a furniture type: [{id,name,source,match}] (matching types first) */
export function modelsForType(type) {
  const all = [
    ...localCatalog().map((m) => ({ id: m.id, name: m.name || m.id, source: m.source || 'local', types: m.types || [m.type] })),
    ...Object.entries(MODEL_INFO).map(([id, m]) => ({ id, name: m.name, source: 'polyhaven', types: m.types })),
  ];
  return all.map((m) => ({ ...m, match: m.types.includes(type) })).sort((a, b) => (b.match - a.match));
}

function loadGLTF(id, res = '1k') {
  const key = id + res;
  if (!modelCache.has(key) && localModels.has(id)) {
    const entry = localModels.get(id);
    modelCache.set(key, track(new GLTFLoader().loadAsync(entry.file).then(prepGLTF).then(simplifyModel)));
  }
  if (!modelCache.has(key)) {
    modelCache.set(key, track((async () => {
      const f = await files(id);
      const g = f.gltf?.[res]?.gltf || f.gltf?.['2k']?.gltf;
      if (!g) throw new Error('no gltf for ' + id);
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        for (const [k, v] of Object.entries(g.include || {})) if (url.endsWith(k)) return v.url;
        return url;
      });
      const gltf = await new GLTFLoader(manager).loadAsync(g.url);
      return simplifyModel(prepGLTF(gltf));
    })()));
  }
  return modelCache.get(key);
}

/** normalise a loaded glTF: shadows on, embedded lights removed, material list + colour variants extracted */
function prepGLTF(gltf) {
  const root = gltf.scene;
  const lights = [];
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } if (o.isLight) lights.push(o); });
  lights.forEach((l) => l.parent?.remove(l)); // models may embed KHR_lights_punctual; the room has its own lighting
  const variants = (gltf.userData?.gltfExtensions?.KHR_materials_variants?.variants || []).map((v) => v.name);
  return { root, parser: gltf.parser, variants, materials: listMaterials(root) };
}

// ---------- triangle budget ----------
// Some product scans are far heavier than a room needs (an ABO desk set: 267k triangles, a dining set: 250k — together
// 60 % of the whole flat). Every pass (shadow, AO, reflections, main) draws them again, so heavy models are reduced
// on load with meshoptimizer's simplifier (same algorithm as gltfpack / glTF-Transform simplify,
// https://gltf-transform.dev/modules/functions/functions/simplify). It only rewrites the index buffer, so UVs,
// normals and materials stay. Quality was checked on close-ups (round table rim, dining chairs): normals are weighted
// in and every model keeps ≥25 % of its triangles.
export const TRI_BUDGET = { model: 15000, keep: 0.25, normalWeight: 0.5, minTris: 400 };
try { const ov = JSON.parse(localStorage.getItem('hd:triBudget') || 'null'); if (ov) Object.assign(TRI_BUDGET, ov); } catch (e) { /* debug override only */ }
let simplifierP = null;
const simplifier = () => (simplifierP ||= import('meshoptimizer/meshopt_simplifier.module.js')
  .then(async (m) => { await m.MeshoptSimplifier.ready; m.MeshoptSimplifier.useExperimentalFeatures = true; return m.MeshoptSimplifier; }).catch((e) => { console.warn('simplifier unavailable', e); return null; }));
const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
async function simplifyModel(model) {
  const geos = new Set(); model.root.traverse((o) => { if (o.isMesh && o.geometry?.index && o.geometry.attributes.position) geos.add(o.geometry); });
  let before = 0; geos.forEach((g) => { before += triCount(g); });
  model.tris = { before, after: before };
  if (before <= TRI_BUDGET.model) return model;
  const S = await simplifier(); if (!S) return model;
  // keep at least `keep` of the original: tested on the ABO round table — 20 % already made the rim wavy
  const ratio = Math.max(TRI_BUDGET.keep, TRI_BUDGET.model / before); let after = 0;
  for (const g of geos) {
    const P = g.attributes.position, n = P.count, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = P.getX(i); pos[i * 3 + 1] = P.getY(i); pos[i * 3 + 2] = P.getZ(i); }
    // normals count as attributes: position-only simplification flattened the shading of rounded edges (table rims)
    const N = g.attributes.normal; let nor = null;
    if (N) { nor = new Float32Array(n * 3); for (let i = 0; i < n; i++) { nor[i * 3] = N.getX(i); nor[i * 3 + 1] = N.getY(i); nor[i * 3 + 2] = N.getZ(i); } }
    const w = TRI_BUDGET.normalWeight;
    const src = g.index.array, groups = g.groups.length ? g.groups : [{ start: 0, count: g.index.count, materialIndex: 0 }];
    const parts = []; const newGroups = [];
    for (const gr of groups) {
      const idx = Uint32Array.from(src.subarray(gr.start, gr.start + gr.count));
      const want = Math.max(TRI_BUDGET.minTris * 3, Math.floor((idx.length / 3) * ratio) * 3);
      let out = idx;
      if (want < idx.length) { try { [out] = nor ? S.simplifyWithAttributes(idx, pos, 3, nor, 3, [w, w, w], null, want, 1, ['LockBorder']) : S.simplify(idx, pos, 3, want, 1, ['LockBorder']); } catch (e) { out = idx; } } // LockBorder: open edges (table rims, cushion seams) keep their outline
      if (!out.length) out = idx; // never drop a part completely
      newGroups.push({ start: parts.reduce((s, p) => s + p.length, 0), count: out.length, materialIndex: gr.materialIndex ?? 0 }); parts.push(out);
    }
    const total = parts.reduce((s, p) => s + p.length, 0), merged = new Uint32Array(total);
    let o = 0; for (const p of parts) { merged.set(p, o); o += p.length; }
    g.setIndex(new THREE.BufferAttribute(merged, 1));
    if (g.groups.length) { g.clearGroups(); newGroups.forEach((gr) => g.addGroup(gr.start, gr.count, gr.materialIndex)); }
    after += total / 3;
  }
  model.tris.after = after;
  return model;
}

const matKey = (m, i) => (m.name && m.name.trim()) || `材質 ${i + 1}`;

// ---------- colour regions inside one texture (for single-material models) ----------
// Most scanned / product models bake every part into one texture atlas. We cluster the texture's colours
// (k-means) into a few regions — e.g. fabric, wood legs, metal — so each can be recoloured on its own.
const paletteCache = new WeakMap();
function imageData(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, w, h);
  return { canvas: c, ctx, data: ctx.getImageData(0, 0, w, h) };
}
// cluster in an opponent-colour space with lightness down-weighted, so the lit and shaded parts of one
// fabric stay in the same region while differently-coloured parts (wood legs, metal) separate
const feat = (p) => [0.3 * (p[0] + p[1] + p[2]) / 3, p[0] - p[1], (p[0] + p[1]) / 2 - p[2]];
export function texturePalette(tex, k = 6) {
  const img = tex?.image; if (!img) return [];
  if (paletteCache.has(img)) return paletteCache.get(img);
  const { data } = imageData(img, 96);
  const px = [];
  for (let i = 0; i < data.data.length; i += 4) if (data.data[i + 3] > 128) px.push([data.data[i], data.data[i + 1], data.data[i + 2]]);
  if (!px.length) return [];
  const fx = px.map(feat);
  // deterministic farthest-point init, then k-means
  const mean = [0, 1, 2].map((j) => fx.reduce((s, p) => s + p[j], 0) / fx.length);
  const cs = [fx.reduce((b, p) => (d2(p, mean) < d2(b, mean) ? p : b), fx[0]).slice()];
  while (cs.length < k) cs.push(fx.reduce((b, p) => (Math.min(...cs.map((c) => d2(p, c))) > Math.min(...cs.map((c) => d2(b, c))) ? p : b), fx[0]).slice());
  let assign = [];
  for (let it = 0; it < 12; it++) {
    assign = fx.map((p) => nearest(p, cs));
    for (let j = 0; j < cs.length; j++) {
      const mem = fx.filter((_, i) => assign[i] === j);
      if (mem.length) cs[j] = [0, 1, 2].map((q) => mem.reduce((s, p) => s + p[q], 0) / mem.length);
    }
  }
  // merge clusters that are basically the same colour
  let groups = cs.map((c, j) => ({ f: c, members: [j] }));
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
      if (d2(groups[a].f, groups[b].f) < 18 * 18) { groups[a].members.push(...groups[b].members); groups.splice(b, 1); merged = true; break outer; }
    }
  }
  const out = groups.map((g) => {
    const idx = px.map((_, i) => i).filter((i) => g.members.includes(assign[i]));
    const rgb = [0, 1, 2].map((q) => idx.reduce((s, i) => s + px[i][q], 0) / Math.max(1, idx.length));
    const f = [0, 1, 2].map((q) => idx.reduce((s, i) => s + fx[i][q], 0) / Math.max(1, idx.length));
    return { rgb, f, pct: idx.length / px.length };
  }).filter((r) => r.pct >= 0.015).sort((a, b) => b.pct - a.pct);
  paletteCache.set(img, out);
  return out;
}
function d2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function nearest(p, cs) { let bi = 0, bd = Infinity; for (let j = 0; j < cs.length; j++) { const d = d2(p, cs[j]); if (d < bd) { bd = d; bi = j; } } return bi; }
const rgbHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** new texture where pixels belonging to overridden regions are shifted to the target colours (shading kept) */
const recolorCache = new Map();
function recolorTexture(tex, palette, overrides /* Map<regionIndex, '#hex'> */) {
  const key = tex.uuid + JSON.stringify([...overrides]);
  if (recolorCache.has(key)) return recolorCache.get(key);
  const { canvas, ctx, data } = imageData(tex.image, 2048);
  const d = data.data; const cs = palette.map((r) => r.rgb); const cf = palette.map((r) => r.f);
  const hex255 = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((o) => parseInt(s.slice(o, o + 2), 16)); };
  // shading-preserving recolour: new = target × (pixel luminance / region luminance). Hue comes only from the
  // target, so dark saturated sources (navy velvet …) don't turn noisy when shifted to a very different colour.
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const tgt = new Map([...overrides].filter(([i]) => cs[i]).map(([i, hex]) => [i, { t: hex255(hex), l: Math.max(6, lum(cs[i])) }]));
  // operate in sRGB 8-bit: ratio per channel, soft edge between regions
  for (let i = 0; i < d.length; i += 4) {
    const p = [d[i], d[i + 1], d[i + 2]]; const fp = feat(p);
    let b1 = -1, e1 = Infinity, e2 = Infinity;
    for (let j = 0; j < cf.length; j++) { const e = d2(fp, cf[j]); if (e < e1) { e2 = e1; e1 = e; b1 = j; } else if (e < e2) e2 = e; }
    if (cf.length === 1) e2 = e1 * 4 + 1;
    const g = tgt.get(b1); if (!g) continue;
    const a = Math.sqrt(e2) / (Math.sqrt(e1) + Math.sqrt(e2) + 1e-6); // 0.5 at the border … 1 at the centre
    const w = Math.min(1, Math.max(0, (a - 0.5) / 0.15));
    const k = Math.min(2.5, lum(p) / g.l);
    for (let q = 0; q < 3; q++) d[i + q] = Math.min(255, p[q] * (1 - w) + g.t[q] * k * w);
  }
  ctx.putImageData(data, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  for (const k of ['wrapS', 'wrapT', 'flipY', 'colorSpace', 'anisotropy', 'channel', 'magFilter', 'minFilter']) t[k] = tex[k];
  t.repeat.copy(tex.repeat); t.offset.copy(tex.offset); t.center.copy(tex.center); t.rotation = tex.rotation;
  t.needsUpdate = true;
  recolorCache.set(key, t);
  return t;
}
/** unique materials of a model in traversal order: [{ key, color: '#hex' (visible average), textured }] */
function listMaterials(root) {
  const seen = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (seen.has(m)) continue;
      seen.set(m, null);
    }
  });
  const out = []; const keys = new Set();
  [...seen.keys()].forEach((m, i) => {
    let key = matKey(m, i); while (keys.has(key)) key += '′'; keys.add(key);
    m.userData.matKey = key;
    const c = m.color ? m.color.clone() : new THREE.Color(1, 1, 1);
    if (m.map?.image) { const a = averageLinear(m.map); c.multiply(a); }
    const regions = m.map?.image ? texturePalette(m.map).map((r, j) => ({ key: `${key}#${j}`, color: rgbHex(r.rgb), pct: r.pct })) : [];
    out.push({ key, color: '#' + c.getHexString(), textured: !!m.map, regions: regions.length > 1 ? regions : [] });
  });
  return out;
}

/** retint a material so its visible average becomes `target` (keeps texture detail) */
function retint(mat, target) {
  if (mat.map?.image) {
    const avg = averageLinear(mat.map);
    mat.color.setRGB(Math.min(6, target.r / Math.max(0.02, avg.r)), Math.min(6, target.g / Math.max(0.02, avg.g)), Math.min(6, target.b / Math.max(0.02, avg.b)));
  } else mat.color.copy(target);
  if (mat.sheen > 0 && mat.sheenColor) mat.sheenColor.copy(target).lerp(new THREE.Color(1, 1, 1), 0.25); // velvet highlights follow the fabric
}

/** model info for the editor (materials, colour variants) — loads the model if needed */
export async function modelDetails(id) {
  const m = await loadGLTF(id);
  return { materials: m.materials, variants: m.variants };
}

/**
 * Get a model instance fitted into a footprint (metres). Origin = footprint centre at floor, front = +Z.
 * fit: { w, d, h, by: 'footprint'|'height', rotate: degrees,
 *        tint: THREE.Color|null (whole model), colors: { <material key>: '#hex' }, variant: '<KHR_materials_variants name>' }
 */
export async function modelInstance(id, fit) {
  const src = await loadGLTF(id);
  const inst = src.root.clone(true);
  // 1) built-in colour variant (e.g. Wayfair fabric options)
  const vi = fit.variant ? src.variants.indexOf(fit.variant) : -1;
  if (vi >= 0) {
    const jobs = [];
    inst.traverse((o) => {
      const def = o.isMesh && o.userData.gltfExtensions?.KHR_materials_variants;
      const mapping = def?.mappings?.find((mp) => mp.variants.includes(vi));
      if (mapping) jobs.push(src.parser.getDependency('material', mapping.material).then((mat) => {
        if (!mat.userData.matKey) { const orig = Array.isArray(o.material) ? o.material[0] : o.material; mat.userData.matKey = orig?.userData.matKey; }
        o.material = mat;
      }));
    });
    await Promise.all(jobs);
  }
  // 2) recolour: per material key, or one tint for everything
  const colors = fit.colors || {};
  if (fit.tint || Object.keys(colors).length) {
    const clones = new Map();
    inst.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = mats.map((m) => {
        const key = m.userData.matKey;
        const target = colors[key] ? new THREE.Color(colors[key]) : (fit.tint && (!fit.tintFilter || fit.tintFilter.test(m.name || '')) ? fit.tint : null);
        // colour regions inside this material's texture: keys "<material key>#<region index>"
        const regionOv = new Map(Object.entries(colors).filter(([k]) => k.startsWith(key + '#')).map(([k, v]) => [+k.slice(key.length + 1), v]));
        if (!target && !regionOv.size) return m;
        if (!clones.has(m)) {
          const c = m.clone(); c.userData = { ...m.userData };
          if (regionOv.size && m.map?.image) c.map = recolorTexture(m.map, texturePalette(m.map), regionOv);
          if (target) retint(c, target);
          clones.set(m, c);
        }
        return clones.get(m);
      });
      o.material = Array.isArray(o.material) ? out : out[0];
    });
  }
  // holder (world-aligned, carries the scale) → rot (model orientation fix) → model, so a non-uniform
  // scale always stretches along the footprint's width/depth, never along a rotated model axis
  const wrap = new THREE.Group();
  const holder = new THREE.Group(); const rot = new THREE.Group();
  rot.add(fit.mirror ? mirrored(inst) : inst); holder.add(rot); wrap.add(holder);
  if (fit.rotate) rot.rotation.y = (fit.rotate * Math.PI) / 180;
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  let s, sx, sz;
  if (fit.by === 'height' && fit.h) { s = sx = sz = fit.h / size.y; }
  else if (fit.byWidth) { // e.g. an L-shaped sofa: the plan's w×d is the main seat, the chaise sticks out in front
    s = sx = sz = fit.w / size.x;
    if (fit.h) s = sx = sz = Math.min(s, (fit.h * 1.15) / size.y);
  } else {
    s = Math.min(fit.w / size.x, fit.d / size.z);
    if (fit.h) s = Math.min(s, (fit.h * 1.15) / size.y);
    // let width / depth follow the plan a little more closely than one uniform scale allows: up to `stretch`
    // (default 12 %) more along one axis — product models are made at catalogue proportions, a bigger stretch
    // visibly distorts them (Sweet Home 3D's "keep proportions" off), so beyond that the piece stays smaller
    const k = fit.stretch ?? 1.12;
    sx = Math.min(fit.w / size.x, s * k); sz = Math.min(fit.d / size.z, s * k);
  }
  holder.scale.set(sx, s, sz);
  const box2 = new THREE.Box3().setFromObject(holder);
  const c = box2.getCenter(new THREE.Vector3());
  // align: 'back' = the model's back sits on the footprint's back edge (−d/2) instead of being centred
  holder.position.set(-c.x, -box2.min.y, fit.align === 'back' && fit.d ? -fit.d / 2 - box2.min.z : -c.z);
  wrap.userData.isModel = id;
  wrap.userData.fitBox = new THREE.Box3().setFromObject(holder); // footprint actually used, in the piece's frame
  return wrap;
}

/** left-right mirror image of a model with real geometry (X flipped, triangle winding reversed). A negative scale
 *  would render fine in WebGL but the path tracer would see every face from the back (black sofa). */
const mirrorCache = new WeakMap();
function mirrored(inst) {
  const out = new THREE.Group();
  inst.updateMatrixWorld(true);
  const flip = new THREE.Matrix4().makeScale(-1, 1, 1);
  inst.traverse((o) => {
    if (!o.isMesh) return;
    let g = mirrorCache.get(o.geometry)?.get(o.matrixWorld.elements.join());
    if (!g) {
      g = o.geometry.clone().applyMatrix4(o.matrixWorld).applyMatrix4(flip);
      if (g.index) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.index.needsUpdate = true; }
      else for (const a of Object.values(g.attributes)) { const n = a.itemSize, arr = a.array; for (let i = 0; i < arr.length; i += 9 * n / 3) for (let k = 0; k < n; k++) { const t = arr[i + n + k]; arr[i + n + k] = arr[i + 2 * n + k]; arr[i + 2 * n + k] = t; } a.needsUpdate = true; }
      if (!mirrorCache.has(o.geometry)) mirrorCache.set(o.geometry, new Map());
      mirrorCache.get(o.geometry).set(o.matrixWorld.elements.join(), g);
    }
    const m = new THREE.Mesh(g, o.material); m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow; m.userData = { ...o.userData };
    out.add(m);
  });
  return out;
}

// ---------- HDRI ----------
export function hdri(id, res = '1k') {
  const key = id + res;
  if (!hdriCache.has(key)) {
    hdriCache.set(key, track((async () => {
      const f = await files(id);
      const url = f.hdri?.[res]?.hdr?.url;
      if (!url) throw new Error('no hdri ' + id);
      const t = await new HDRLoader().loadAsync(url);
      t.mapping = THREE.EquirectangularReflectionMapping;
      return t;
    })()));
  }
  return hdriCache.get(key);
}

// ---------- defaults ----------
// Surface material -> Poly Haven texture. mode: retint | detail
export const SURFACE_PBR = {
  wood: { id: 'laminate_floor_02', mode: 'retint' },
  herringbone: { id: 'herringbone_parquet', mode: 'retint' },
  marble: { id: 'marble_01', mode: 'retint', roughness: 0.6 },
  concrete: { id: 'concrete_floor_worn_001', mode: 'retint' },
  wallConcrete: { id: 'patterned_concrete_wall', mode: 'retint' },
  brick: { id: 'red_brick', mode: 'retint' },
  limewash: { id: 'plastered_wall_04', mode: 'retint' },
  paint: { id: 'painted_plaster_wall', mode: 'detail', normalScale: 0.35, scale: 2 },
};
export const ROLE_PBR = {
  fabric: { id: 'hessian_230', mode: 'detail', normalScale: 0.6, scale: 0.6 },
  fabricAlt: { id: 'poly_wool_herringbone', mode: 'detail', normalScale: 0.6, scale: 0.6 },
  bedding: { id: 'cotton_jersey', mode: 'detail', normalScale: 0.4, scale: 0.5 },
  mattress: { id: 'cotton_jersey', mode: 'detail', normalScale: 0.3, scale: 0.5 },
  curtain: { id: 'crepe_satin', mode: 'detail', normalScale: 0.3, scale: 0.6 },
  leather: { id: 'brown_leather', mode: 'retint' },
  wood: { id: 'oak_veneer_01', mode: 'retint' },
  woodDark: { id: 'black_walnut_veneer_01', mode: 'retint' },
};
// Furniture type -> default real model (「真實版」2026-11-22). Pieces without their own `model` and whose
// style has no `models.<type>` use these, so every template gets real furniture. A list = first match wins;
// `if` keys: chaise (bool), shape ('round'|'rect'), notRoom ([room types]), or a style furniture switch
// (sofa: boxy|rounded, chair: spindle|solid|upholstered, bed: legs|platform|upholstered).
// Colours follow the template: each catalogue entry's `roles` maps a material / colour region to a role
// (upholstery = fabric or leather by the template, wood, lampshade …). ABO models: CC BY-NC 4.0.
const ABO = (i) => 'local:abo_' + i;
export const MODEL_DEFAULTS = {
  plant: { id: 'potted_plant_02', by: 'height' },
  sofa: [
    { id: ABO('B07BW8MJR2'), if: { chaise: true }, byWidth: true, align: 'back' }, // Edgewest L 型（模型的貴妃在左，chaise: right 會鏡像）
    { id: ABO('B07G2XB4ZL'), if: { sofa: 'boxy' } },                                // 方正低背
    { id: ABO('B07K94M78Y') },                                                      // 圓潤
  ],
  armchair: { id: ABO('B07DBH52YB') },
  chair: [{ id: ABO('B08G1YWN8L'), if: { chair: 'upholstered' } }, { id: ABO('B0856G6QWP') }],
  dining_table: [{ id: ABO('B075YV7SKC'), if: { shape: 'round' } }, { id: ABO('B075YQXRJM') }],
  coffee_table: [{ id: ABO('B07GDSF3MR'), if: { shape: 'round' } }, { id: ABO('B07GF51SLB') }],
  side_table: { id: ABO('B07GDZ8HN6') },
  tv_cabinet: { id: ABO('B07BVHKPFS') },
  sideboard: { id: ABO('B07TR659G8'), if: { notRoom: ['storage'] } }, // built-in closet cabinets stay procedural
  bed: [{ id: ABO('B07B4VXZZX'), if: { bed: 'upholstered' } }, { id: ABO('B07K7NXVXR') }],
  nightstand: { id: ABO('B07VB7Q6W7') },
  desk: { id: ABO('B0876PDMJR') },
  floor_lamp: { id: ABO('B0742GG15D'), by: 'height' },
};
/** the default model spec for one piece: type + item (+ its room type) + effective style furniture switches */
export function pickDefault(type, it = {}, variant = {}, roomType) {
  return pickSpec(MODEL_DEFAULTS[type], it, variant, roomType);
}
/** first matching spec of a list like MODEL_DEFAULTS[type] (also used for a template's `models.<type>` list) */
export function pickSpec(d, it = {}, variant = {}, roomType) {
  if (!d) return null;
  if (typeof d === 'string') return { id: d };
  const ok = (cond = {}) => Object.entries(cond).every(([k, v]) => {
    if (k === 'chaise') return !!it.chaise === v;
    if (k === 'shape') return (it.shape || 'rect') === v;
    if (k === 'notRoom') return !v.includes(roomType);
    return Array.isArray(v) ? v.includes(variant[k]) : variant[k] === v;
  });
  const spec = (Array.isArray(d) ? d : [d]).map((s) => (typeof s === 'string' ? { id: s } : s)).find((s) => ok(s.if));
  if (!spec) return null;
  const { if: _, ...rest } = spec;
  return rest;
}
// fit hints per model (by: 'height' scales to item height instead of footprint)
export const MODEL_FIT = {
  potted_plant_01: { by: 'height' }, potted_plant_02: { by: 'height' }, potted_plant_04: { by: 'height' },
};
// Poly Haven models with a Chinese label and the furniture types they can stand in for.
export const MODEL_INFO = {
  modern_arm_chair_01: { name: '現代木框皮革單椅', types: ['armchair'] },
  mid_century_lounge_chair: { name: '中世紀皮革旋轉休閒椅', types: ['armchair'] },
  ArmChair_01: { name: '古典灰布單椅', types: ['armchair'] },
  GreenChair_01: { name: '古典綠絨單椅', types: ['armchair'] },
  Rockingchair_01: { name: '木搖椅', types: ['armchair'] },
  chinese_armchair: { name: '中式木扶手椅', types: ['armchair', 'chair'] },
  sofa_02: { name: '黑皮切斯特菲爾德沙發', types: ['sofa'] },
  sofa_03: { name: '古典花布三人沙發', types: ['sofa'] },
  Sofa_01: { name: '法式灰布雙人沙發', types: ['sofa'] },
  painted_wooden_sofa: { name: '彩繪木沙發', types: ['sofa'] },
  chinese_sofa: { name: '中式木沙發', types: ['sofa'] },
  modern_coffee_table_01: { name: '水泥面木框茶几', types: ['coffee_table', 'side_table'] },
  modern_coffee_table_02: { name: '幾何鏤空方茶几', types: ['coffee_table'] },
  coffee_table_round_01: { name: '白石圓茶几（黑腳）', types: ['coffee_table', 'side_table'] },
  CoffeeTable_01: { name: '復古彩繪茶几', types: ['coffee_table'] },
  chinese_tea_table: { name: '中式茶几', types: ['coffee_table'] },
  side_table_01: { name: '淺木雙層邊几', types: ['side_table', 'nightstand'] },
  side_table_tall_01: { name: '深木高邊几', types: ['side_table'] },
  round_wooden_table_02: { name: '深木圓邊几', types: ['side_table'] },
  WoodenTable_02: { name: '雕刻木凳几', types: ['side_table', 'stool'] },
  dining_chair_02: { name: '黑皮餐椅', types: ['chair'] },
  painted_wooden_chair_01: { name: '白色木餐椅', types: ['chair'] },
  gallinera_chair: { name: '深木扶手椅', types: ['chair'] },
  SchoolChair_01: { name: '學校椅', types: ['chair'] },
  potted_plant_02: { name: '龜背芋盆栽', types: ['plant'] },
  potted_plant_01: { name: '小葉盆栽', types: ['plant'] },
  potted_plant_04: { name: '多肉盆栽', types: ['plant'] },
  modern_wooden_cabinet: { name: '胡桃木格柵矮櫃', types: ['sideboard', 'tv_cabinet'] },
  drawer_cabinet: { name: '鐵框木抽屜櫃', types: ['sideboard', 'bookshelf'] },
  ClassicConsole_01: { name: '古典雕花玄關桌', types: ['sideboard'] },
  wooden_display_shelves_01: { name: '淺木格子書櫃', types: ['bookshelf'] },
  steel_frame_shelves_03: { name: '工業鐵架層架', types: ['bookshelf'] },
  Shelf_01: { name: '刷白木書架', types: ['bookshelf'] },
  ClassicNightstand_01: { name: '古典床頭櫃', types: ['nightstand'] },
  painted_wooden_nightstand: { name: '彩繪木床頭櫃', types: ['nightstand'] },
  Ottoman_01: { name: '皮革腳凳', types: ['ottoman'] },
  bar_chair_round_01: { name: '木吧檯椅', types: ['stool'] },
  metal_stool_02: { name: '金屬凳', types: ['stool'] },
  modern_ceiling_lamp_01: { name: '現代吊燈', types: ['pendant'] },
  ceramic_vase_01: { name: '白瓷花瓶', types: ['decor'] },
  wicker_basket_02: { name: '藤編籃', types: ['decor'] },
};
export const MODEL_LIBRARY = Object.entries(MODEL_INFO).reduce((acc, [id, m]) => {
  for (const t of m.types) (acc[t] ||= []).push(id);
  return acc;
}, {});
