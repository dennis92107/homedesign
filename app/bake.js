// 烘焙光照（只烘間接光）
//
// 做法（業界的「混合光照」：Godot LightmapGI 預設的 bake mode = Dynamic、Unity 的 Baked Indirect）：
//   直射光（太陽、即時燈光池、房間補光）維持即時計算＋即時陰影；只有「反彈光」與「從窗戶進來的天光」
//   預先算好存進 lightmap 貼圖。家具（2026-11-22 擬真度 ⑥）只當「遮光物」：射線會被沙發、床、櫃子擋住，
//   所以家具底下、高櫃旁的牆與地板會有柔和的陰影（環境光遮蔽＋反彈光被擋）；家具自己不收光（仍是即時計算）。
//   texel 在家具裡面（第一條射線打到背面）照舊當無效、由鄰居補。搬動家具後烘焙會「過期」（furnitureSig 比對），提示重烘。
//
// 1. UV2（lightmap 座標）：建築幾何全是平面多邊形（牆段 prism、樓板/天花 shape、降板 extrude），
//    所以逐「平面」投影：同一平面、相鄰的三角形併成一張 chart（整片地板一張、一面牆的所有分段一張 → 沒有接縫），
//    投影成公尺座標後用 shelf packing 排進一張圖集。chart 之間留 PAD 像素的間隙給擴張（dilation）。
//    （沒用 xatlas-three：它用 new Worker(<jsdelivr 網址>, {type:"module"}) 載入 WASM，跨網域 Worker 會被瀏覽器擋；
//     而且平面投影對這種幾何是零變形的。）
// 2. G-buffer：用 UV2 當螢幕座標把每個三角形「畫」到圖集上，每個 texel 記下世界座標與法向量。
// 3. 追光：three-mesh-bvh 的 GLSL BVH 查詢，在片段著色器裡逐 texel 做 cosine 取樣的路徑追蹤，2 次反彈；
//    每次打到表面做「下一事件估計」：太陽（陰影射線）＋ 燈具（嵌燈 SpotLight / 燈槽 RectAreaLight，
//    依未遮蔽貢獻挑一盞再測陰影）。射線飛出窗外 = 天空（HDRI）。表面顏色用材質的平均反照率。
//    天空 / 太陽 / 燈具分成三層（MRT）分開累積，之後改時間只要重新「組合」不用重烘。
//    第一條射線打到背面（texel 在牆裡面）→ 該 texel 無效（Unity 的 backface tolerance 做法），之後由鄰居填補。
// 4. 後處理：保留邊緣的 à-trous 模糊（用 G-buffer 的位置/法向量當權重）→ 擴張填補無效與間隙 texel → 組合成 HalfFloat 貼圖。
// 5. Windows TDR：圖集切成 256×256 的塊，每塊送出後讀回 1 個像素等 GPU 做完（Chrome 的 gl.finish 不會真的等）。
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { MeshBVH, MeshBVHUniformStruct, FloatVertexAttributeTexture, BVHShaderGLSL, SAH } from 'three-mesh-bvh';

const PAD = 2; // texels of gutter around every chart (per side)
const TILE = 256;
const EPS = 0.002; // ray origin offset (m)
let BAKED_ENV = 0.1; // envMapIntensity kept on baked surfaces (the lightmap already holds the occluded sky)

// ---------------------------------------------------------------- mesh selection
/** the architecture that gets a lightmap: wall pieces + baseboards, floors, ceilings / soffits (not doors, windows, fixtures) */
export function bakeTargets(groups) {
  const out = [];
  const skip = new Set(['door', 'window', 'railing']);
  groups.walls.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== groups.walls; p = p.parent) if (skip.has(p.userData?.kind)) return;
    out.push(o);
  });
  groups.floors.traverse((o) => { if (o.isMesh) out.push(o); });
  groups.ceilings.traverse((o) => { if (o.isMesh && o.userData?.kind === 'ceiling') out.push(o); });
  return out;
}
/** furniture that blocks light in the bake: the pieces themselves (+ duvet / pillows), not small decor, rugs, art,
 *  plants, lamps or see-through parts. Returns meshes (world matrices must be up to date). */
const NON_OCCLUDER = new Set(['rug', 'art', 'mirror', 'plant', 'ring_light', 'floor_lamp']);
export function occluderMeshes(groups) {
  const out = [];
  const visit = (o, inDecor) => {
    if (!o.visible) return;
    const u = o.userData || {};
    if (u.kind === 'pendant') return;
    if (u.kind === 'furniture' && NON_OCCLUDER.has(u.item?.type)) return;
    if (u.decorPiece && !['duvet', 'sleepPillow'].includes(u.decorPiece)) return;
    if (o.isMesh && o.geometry?.attributes?.position) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      if (!ms.some((m) => m && (m.transmission > 0.5 || (m.transparent && m.opacity < 0.6)))) out.push(o);
    }
    for (const c of o.children) visit(c, inDecor || !!u.decorPiece);
  };
  for (const c of groups.furniture.children) visit(c, false);
  return out;
}
/** where the furniture stands (id + position + rotation + size, to the cm): a moved piece makes the bake stale */
export function furnitureSig(groups) {
  let h = 2166136261 >>> 0;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
  for (const o of groups.furniture.children) {
    const u = o.userData || {}; if (u.kind !== 'furniture' || !o.visible || NON_OCCLUDER.has(u.item?.type)) continue;
    for (const ch of String(u.id)) mix(ch.charCodeAt(0));
    mix(Math.round(o.position.x * 100)); mix(Math.round(o.position.z * 100)); mix(Math.round(o.rotation.y * 100));
    const it = u.item || {}; mix(it.w || 0); mix(it.d || 0); mix(typeof it.h === 'number' ? it.h : 0);
  }
  return h.toString(36);
}
/** structure fingerprint (vertex counts + world positions to the cm): decides whether a bake fits a rebuilt scene */
function fingerprint(meshes) {
  let h = 2166136261 >>> 0;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
  const v = new THREE.Vector3();
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const P = m.geometry.attributes.position; mix(P.count); mix(m.geometry.index ? m.geometry.index.count : 0);
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld); mix(Math.round(v.x * 100)); mix(Math.round(v.y * 100)); mix(Math.round(v.z * 100)); }
  }
  return meshes.length + ':' + h.toString(36);
}

// ---------------------------------------------------------------- albedo
const _albedo = new WeakMap();
function texAverage(tex) {
  const img = tex?.image;
  if (!img || !(img.width > 0)) return [1, 1, 1];
  try {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data; const s = [0, 0, 0];
    const lin = tex.colorSpace === THREE.SRGBColorSpace ? (u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4) : (u) => u;
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += lin(d[i + k] / 255);
    return s.map((v) => v / 64);
  } catch { return [1, 1, 1]; }
}
function albedoOf(mat) {
  if (!mat) return [0.6, 0.6, 0.6];
  if (_albedo.has(mat)) return _albedo.get(mat);
  const c = mat.color || new THREE.Color(1, 1, 1); const t = mat.map ? texAverage(mat.map) : [1, 1, 1];
  const a = [c.r * t[0], c.g * t[1], c.b * t[2]].map((v) => Math.min(0.92, Math.max(0.02, v)));
  _albedo.set(mat, a);
  return a;
}

// ---------------------------------------------------------------- UV2: planar charts + shelf packing
function unwrap(meshes, tpm) {
  const tris = []; // { mesh, k (triangle), mat, p: [3 Vector3], n, plane }
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  meshes.forEach((mesh, mi) => {
    const g = mesh.geometry; const P = g.attributes.position; const I = g.index;
    const n = I ? I.count : P.count; const mats = Array.isArray(mesh.material) ? mesh.material : null;
    const groups = mats && g.groups.length ? g.groups : null;
    mesh.updateWorldMatrix(true, false);
    for (let k = 0; k < n / 3; k++) {
      const ia = I ? I.getX(k * 3) : k * 3, ib = I ? I.getX(k * 3 + 1) : k * 3 + 1, ic = I ? I.getX(k * 3 + 2) : k * 3 + 2;
      let mat = mesh.material;
      if (groups) { const gr = groups.find((q) => k * 3 >= q.start && k * 3 < q.start + q.count); mat = gr ? mats[gr.materialIndex] : mats[0]; }
      A.fromBufferAttribute(P, ia).applyMatrix4(mesh.matrixWorld); B.fromBufferAttribute(P, ib).applyMatrix4(mesh.matrixWorld); C.fromBufferAttribute(P, ic).applyMatrix4(mesh.matrixWorld);
      const nn = e1.subVectors(B, A).cross(e2.subVectors(C, A));
      const area = nn.length() / 2;
      const nv = area > 1e-9 ? nn.clone().normalize() : new THREE.Vector3(0, 1, 0);
      if (mat?.side === THREE.BackSide) nv.negate(); // e.g. ceilings: seen from below
      tris.push({ mi, k, idx: [ia, ib, ic], mat, p: [A.clone(), B.clone(), C.clone()], n: nv, area });
    }
  });
  // group by plane, then split each plane into clusters of touching triangles (2D bbox overlap, 1 cm tolerance)
  const planes = new Map();
  for (const t of tris) {
    const d = t.n.dot(t.p[0]);
    const key = `${Math.round(t.n.x * 500)},${Math.round(t.n.y * 500)},${Math.round(t.n.z * 500)},${Math.round(d * 500)}`;
    let pl = planes.get(key); if (!pl) planes.set(key, (pl = { n: t.n, tris: [] }));
    pl.tris.push(t);
  }
  const charts = [];
  for (const pl of planes.values()) {
    const n = pl.n;
    const tAx = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0).cross(n).normalize(); // walls: along the wall
    const bAx = new THREE.Vector3().crossVectors(n, tAx).normalize();
    const box = pl.tris.map((t) => {
      const s = t.p.map((p) => p.dot(tAx)), r = t.p.map((p) => p.dot(bAx));
      return [Math.min(...s), Math.min(...r), Math.max(...s), Math.max(...r)];
    });
    // union-find on overlapping boxes
    const par = pl.tris.map((_, i) => i); const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    const tol = 0.01;
    for (let i = 0; i < box.length; i++) for (let j = i + 1; j < box.length; j++) {
      const a = box[i], b = box[j];
      if (a[0] - tol <= b[2] && b[0] - tol <= a[2] && a[1] - tol <= b[3] && b[1] - tol <= a[3]) par[find(i)] = find(j);
    }
    const cl = new Map();
    pl.tris.forEach((t, i) => { const r = find(i); let c = cl.get(r); if (!c) cl.set(r, (c = { n, tAx, bAx, tris: [], bb: [Infinity, Infinity, -Infinity, -Infinity] })); c.tris.push(t); const b = box[i]; c.bb[0] = Math.min(c.bb[0], b[0]); c.bb[1] = Math.min(c.bb[1], b[1]); c.bb[2] = Math.max(c.bb[2], b[2]); c.bb[3] = Math.max(c.bb[3], b[3]); });
    charts.push(...cl.values());
  }
  // pack (shrink the texel density until it fits 2048 wide × ≤ 2048 high)
  let W = 0, H = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    let area = 0;
    for (const c of charts) {
      c.w = Math.max(1, Math.ceil((c.bb[2] - c.bb[0]) * tpm)); c.h = Math.max(1, Math.ceil((c.bb[3] - c.bb[1]) * tpm));
      area += (c.w + 2 * PAD) * (c.h + 2 * PAD);
    }
    W = Math.min(2048, Math.max(256, 2 ** Math.ceil(Math.log2(Math.sqrt(area * 1.2)))));
    const order = [...charts].sort((a, b) => b.h - a.h || b.w - a.w);
    let x = 0, y = 0, shelf = 0, ok = true;
    for (const c of order) {
      const cw = c.w + 2 * PAD, ch = c.h + 2 * PAD;
      if (cw > W) { ok = false; break; }
      if (x + cw > W) { x = 0; y += shelf; shelf = 0; }
      c.x = x; c.y = y; x += cw; shelf = Math.max(shelf, ch);
    }
    H = Math.ceil((y + shelf) / 16) * 16;
    if (ok && H <= 2048) break;
    tpm *= 0.85;
  }
  // per-triangle-corner lightmap UVs
  const perMesh = meshes.map((m) => ({ corners: new Float32Array((m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) * 2) }));
  for (const c of charts) {
    const sx = (c.bb[2] - c.bb[0]) > 1e-6 ? c.w / (c.bb[2] - c.bb[0]) : 0, sy = (c.bb[3] - c.bb[1]) > 1e-6 ? c.h / (c.bb[3] - c.bb[1]) : 0;
    for (const t of c.tris) {
      t.uv = t.p.map((p) => [
        (c.x + PAD + (sx ? (p.dot(c.tAx) - c.bb[0]) * sx : c.w / 2)) / W,
        (c.y + PAD + (sy ? (p.dot(c.bAx) - c.bb[1]) * sy : c.h / 2)) / H,
      ]);
      const arr = perMesh[t.mi].corners;
      for (let j = 0; j < 3; j++) { arr[(t.k * 3 + j) * 2] = t.uv[j][0]; arr[(t.k * 3 + j) * 2 + 1] = t.uv[j][1]; }
    }
  }
  // indexed geometry: keep the index if every vertex got one consistent UV, otherwise the mesh goes non-indexed
  meshes.forEach((m, mi) => {
    const g = m.geometry, I = g.index, pm = perMesh[mi];
    if (!I) { pm.nonIndexed = false; pm.uv1 = pm.corners; return; }
    const uv = new Float32Array(g.attributes.position.count * 2).fill(NaN); let ok = true;
    for (let k = 0; k < I.count && ok; k++) {
      const v = I.getX(k), u0 = pm.corners[k * 2], u1 = pm.corners[k * 2 + 1];
      if (Number.isNaN(uv[v * 2])) { uv[v * 2] = u0; uv[v * 2 + 1] = u1; }
      else if (Math.abs(uv[v * 2] - u0) > 1e-7 || Math.abs(uv[v * 2 + 1] - u1) > 1e-7) ok = false;
    }
    for (let i = 0; i < uv.length; i++) if (Number.isNaN(uv[i])) uv[i] = 0;
    pm.nonIndexed = !ok; pm.uv1 = ok ? uv : pm.corners;
    delete pm.corners;
  });
  return { W, H, tpm, charts, tris, perMesh };
}

// ---------------------------------------------------------------- shaders
const FSQ_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const GBUF = {
  vertexShader: /* glsl */`
    attribute vec2 lmuv;
    varying vec3 vPos; varying vec3 vNor;
    void main(){ vPos = position; vNor = normal; gl_Position = vec4(lmuv * 2.0 - 1.0, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    layout(location = 0) out vec4 oPos;
    layout(location = 1) out vec4 oNor;
    varying vec3 vPos; varying vec3 vNor;
    void main(){ oPos = vec4(vPos, 1.0); oNor = vec4(normalize(vNor), 1.0); }`,
};

const TRACE_FRAG = /* glsl */`
precision highp isampler2D;
precision highp usampler2D;
${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_ray_functions}
#define PI 3.141592653589793
#define INV_PI 0.3183098861837907
#define EPS ${EPS.toFixed(4)}
uniform BVH bvh;
uniform sampler2D normalAttr;
uniform sampler2D albedoAttr;
uniform sampler2D gPos;
uniform sampler2D gNor;
uniform sampler2D envMap;
uniform bool hasEnv;
uniform vec3 skyTop;
uniform vec3 skyBottom;
uniform float envClamp;
uniform vec3 sunDir;
uniform sampler2D lightTex;
uniform bool rectDirect;
uniform int lightCount;
uniform float seed;
uniform int spp;
uniform int bounces;
layout(location = 0) out vec4 oSky;
layout(location = 1) out vec4 oSun;
layout(location = 2) out vec4 oArt;

uint rng;
uint hash(uint v) { uint st = v * 747796405u + 2891336453u; uint w = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u; return (w >> 22u) ^ w; }
float rand() {
  rng = rng * 747796405u + 2891336453u;
  uint w = ((rng >> ((rng >> 28u) + 4u)) ^ rng) * 277803737u;
  return float((w >> 22u) ^ w) / 4294967296.0;
}
vec3 cosDir(vec3 n) {
  float r1 = rand(), r2 = rand(); float r = sqrt(r1), phi = 6.283185307 * r2;
  float s = n.z >= 0.0 ? 1.0 : -1.0; float a = -1.0 / (s + n.z); float b = n.x * n.y * a;
  vec3 t = vec3(1.0 + s * n.x * n.x * a, s * b, -s * n.x), bt = vec3(b, s + n.y * n.y * a, -n.y);
  return normalize(t * r * cos(phi) + bt * r * sin(phi) + n * sqrt(max(0.0, 1.0 - r1)));
}
vec3 sky(vec3 d) {
  if (hasEnv) {
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494309 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * INV_PI + 0.5);
    return min(textureLod(envMap, uv, 0.0).rgb, vec3(envClamp));
  }
  return mix(skyBottom, skyTop, clamp(d.y * 0.5 + 0.5, 0.0, 1.0));
}
bool occ;
bool trace(vec3 o, vec3 d, out vec3 hp, out vec3 hn, out vec3 alb, out float dist) {
  uvec4 fi = uvec4(0u); vec3 fn = vec3(0.0); vec3 bc = vec3(0.0); float side = 1.0; dist = 0.0;
  if (!bvhIntersectFirstHit(bvh, o, d, fi, fn, bc, side, dist)) return false;
  hp = o + d * dist;
  hn = normalize(textureSampleBarycoord(normalAttr, bc, fi.xyz).xyz);
  alb = textureSampleBarycoord(albedoAttr, bc, fi.xyz).rgb;
  occ = alb.r < -0.5; // furniture occluder: albedo stored as (-(r + 1), g, b)
  if (occ) alb.r = -alb.r - 1.0;
  return true;
}
bool occluded(vec3 o, vec3 d, float maxDist) {
  uvec4 fi = uvec4(0u); vec3 fn = vec3(0.0); vec3 bc = vec3(0.0); float side = 1.0; float dist = 0.0;
  return bvhIntersectFirstHit(bvh, o, d, fi, fn, bc, side, dist) && dist < maxDist;
}
vec4 L(int i, int k) { return texelFetch(lightTex, ivec2(i * 5 + k, 0), 0); }
// unshadowed irradiance from light i at P (normal N) towards sample point Q; returns direction + distance
// rect lights: the sample point on the light comes from (u0, u1) shifted per light (R2 sequence), so the selection
// pass and the shading pass see exactly the same candidate (resampled importance sampling, no mismatch)
vec3 lightE(int i, vec3 P, vec3 N, vec2 u, out vec3 dir, out float dist) {
  vec4 l0 = L(i, 0), l1 = L(i, 1), l2 = L(i, 2), l3 = L(i, 3), l4 = L(i, 4);
  vec3 Q = l0.xyz;
  if (l0.w > 1.5) { vec2 r = fract(u + float(i) * vec2(0.7548776662, 0.5698402910)); Q += l1.xyz * (r.x * 2.0 - 1.0) + l3.xyz * (r.y * 2.0 - 1.0); }
  vec3 v = Q - P; float d2 = max(dot(v, v), 1e-4); dist = sqrt(d2); dir = v / dist;
  float c = dot(N, dir); if (c <= 0.0) return vec3(0.0);
  if (l0.w < 1.5) { // spot (three.js units: candela, smoothstep cone, 1/d^decay)
    float att = smoothstep(l1.w, l2.w, dot(-dir, l1.xyz));
    float fall = l3.w > 0.0 ? 1.0 / max(pow(dist, l3.w), 0.01) : 1.0;
    return l2.rgb * c * att * fall;
  }
  float cl = dot(-dir, l4.xyz); if (cl <= 0.0) return vec3(0.0); // rect: one-sided, luminance × area
  return l2.rgb * l4.w * c * cl / max(d2, 0.02);
}
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// firefly clamp: a ray that happens to hit the hot spot right under a wall-wash / cove strip carries 100× the
// typical radiance and turns into blotches after filtering; cap each path contribution (slight energy loss there)
uniform float maxRadiance;
vec3 clampL(vec3 c) { float l = lum(c); return l > maxRadiance ? c * (maxRadiance / l) : c; }

void main() {
  oSky = vec4(0.0); oSun = vec4(0.0); oArt = vec4(0.0);
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 gp = texelFetch(gPos, px, 0);
  if (gp.w < 0.5) return;
  vec3 N0 = normalize(texelFetch(gNor, px, 0).xyz);
  rng = hash(uint(px.x) + hash(uint(px.y) + hash(uint(seed))));
  vec3 aSky = vec3(0.0), aSun = vec3(0.0), aArt = vec3(0.0); float back = 0.0;
  for (int s = 0; s < spp; s++) {
    // OPTIONAL (opts.rectDirect, off by default): direct light of the strip lights (coves, wall-wash) baked on this
    // texel — Unity's "Baked" light mode. Tried 2026-11-22: at ~5 cm/texel the sharp glow line next to a cove strip
    // turns into cloudy blotches, worse than the realtime RectAreaLights (LTC), so the default keeps them realtime.
    // When a bake has it, the light pool leaves rect lights out (no double counting).
    if (rectDirect && lightCount > 0) {
      vec3 P0 = gp.xyz + N0 * EPS, dd; float dl; vec2 lu = vec2(rand(), rand()); float total = 0.0;
      for (int i = 0; i < lightCount; i++) if (L(i, 0).w > 1.5) total += lum(lightE(i, P0, N0, lu, dd, dl));
      if (total > 0.0) {
        float r = rand() * total, acc = 0.0; int pick = -1;
        for (int i = 0; i < lightCount; i++) if (L(i, 0).w > 1.5) { acc += lum(lightE(i, P0, N0, lu, dd, dl)); if (r <= acc) { pick = i; break; } }
        if (pick >= 0) {
          vec3 E = lightE(pick, P0, N0, lu, dd, dl); float w = lum(E);
          if (w > 0.0 && !occluded(P0, dd, dl - 2.0 * EPS)) aArt += E * (total / w) * INV_PI; // irradiance / π, like the bounce terms
        }
      }
    }
    vec3 o = gp.xyz + N0 * EPS, n = N0, T = vec3(1.0);
    for (int b = 0; b < bounces; b++) {
      vec3 d = cosDir(n), hp, hn, alb; float dist;
      if (!trace(o, d, hp, hn, alb, dist)) { aSky += T * sky(d); break; }
      if (dot(d, hn) > 0.0) {
        // furniture is two-sided after the first hop (procedural / model meshes are not always closed or outward-facing;
        // ending the path there adds random black samples that the filter turns into blotches)
        if (occ && b > 0) hn = -hn;
        else { if (b == 0) back += 1.0; break; } // texel inside geometry (wall, under / behind a cabinet) → invalid, filled from neighbours
      }
      T *= alb;
      vec3 po = hp + hn * EPS;
      float ns = dot(hn, sunDir);
      if (ns > 0.0 && !occluded(po, sunDir, 1e4)) aSun += clampL(T * ns * INV_PI);
      if (lightCount > 0) {
        // pick one light proportional to its unshadowed contribution, then test its shadow
        float total = 0.0; vec3 dd; float dl; vec2 lu = vec2(rand(), rand());
        for (int i = 0; i < lightCount; i++) total += lum(lightE(i, hp, hn, lu, dd, dl));
        if (total > 0.0) {
          float r = rand() * total, acc = 0.0; int pick = lightCount - 1;
          for (int i = 0; i < lightCount; i++) { acc += lum(lightE(i, hp, hn, lu, dd, dl)); if (r <= acc) { pick = i; break; } }
          vec3 E = lightE(pick, hp, hn, lu, dd, dl); float w = lum(E);
          if (w > 0.0 && !occluded(po, dd, dl - 2.0 * EPS)) aArt += clampL(T * E * (total / w) * INV_PI);
        }
      }
      o = po; n = hn;
    }
  }
  oSky = vec4(aSky, float(spp)); oSun = vec4(aSun, back); oArt = vec4(aArt, 0.0);
}`;

// sums → irradiance (×π / N), mark invalid texels (no coverage or mostly back-face hits)
const RESOLVE_FRAG = /* glsl */`
uniform sampler2D a0; uniform sampler2D a1; uniform sampler2D a2; uniform sampler2D gPos;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s0 = texelFetch(a0, p, 0), s1 = texelFetch(a1, p, 0), s2 = texelFetch(a2, p, 0);
  float n = s0.a; bool ok = texelFetch(gPos, p, 0).w > 0.5 && n > 0.0 && s1.a / max(n, 1.0) < 0.25;
  float k = ok ? 3.141592653589793 / n : 0.0, v = ok ? 1.0 : 0.0;
  o0 = vec4(s0.rgb * k, v); o1 = vec4(s1.rgb * k, v); o2 = vec4(s2.rgb * k, v);
}`;
// edge-aware à-trous blur in lightmap space (weights: world distance + normal, from the G-buffer)
const ATROUS_FRAG = /* glsl */`
uniform sampler2D l0; uniform sampler2D l1; uniform sampler2D l2; uniform sampler2D gPos; uniform sampler2D gNor;
uniform int stepPx; uniform float sigmaP;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), sz = textureSize(l0, 0);
  vec4 c0 = texelFetch(l0, p, 0);
  if (c0.a < 0.5) { o0 = c0; o1 = texelFetch(l1, p, 0); o2 = texelFetch(l2, p, 0); return; }
  vec3 P = texelFetch(gPos, p, 0).xyz, N = texelFetch(gNor, p, 0).xyz;
  float kw[3] = float[3](0.375, 0.25, 0.0625);
  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0); float ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    ivec2 q = clamp(p + ivec2(i, j) * stepPx, ivec2(0), sz - 1);
    vec4 v0 = texelFetch(l0, q, 0); if (v0.a < 0.5) continue;
    vec3 Pq = texelFetch(gPos, q, 0).xyz, Nq = texelFetch(gNor, q, 0).xyz;
    vec3 dp = Pq - P;
    float w = kw[abs(i)] * kw[abs(j)] * exp(-dot(dp, dp) / (sigmaP * sigmaP)) * pow(max(0.0, dot(N, Nq)), 16.0) * exp(-abs(dot(dp, N)) * 200.0);
    s0 += v0.rgb * w; s1 += texelFetch(l1, q, 0).rgb * w; s2 += texelFetch(l2, q, 0).rgb * w; ws += w;
  }
  o0 = vec4(s0 / ws, 1.0); o1 = vec4(s1 / ws, 1.0); o2 = vec4(s2 / ws, 1.0);
}`;
// fill invalid / gutter texels from valid neighbours (one ring per pass)
const DILATE_FRAG = /* glsl */`
uniform sampler2D l0; uniform sampler2D l1; uniform sampler2D l2;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), sz = textureSize(l0, 0);
  vec4 c0 = texelFetch(l0, p, 0);
  if (c0.a > 0.5) { o0 = c0; o1 = texelFetch(l1, p, 0); o2 = texelFetch(l2, p, 0); return; }
  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0); float n = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 q = clamp(p + ivec2(i, j), ivec2(0), sz - 1);
    vec4 v0 = texelFetch(l0, q, 0); if (v0.a < 0.5) continue;
    float w = (i == 0 || j == 0) ? 2.0 : 1.0;
    s0 += v0.rgb * w; s1 += texelFetch(l1, q, 0).rgb * w; s2 += texelFetch(l2, q, 0).rgb * w; n += w;
  }
  if (n > 0.0) { o0 = vec4(s0 / n, 1.0); o1 = vec4(s1 / n, 1.0); o2 = vec4(s2 / n, 1.0); }
  else { o0 = c0; o1 = texelFetch(l1, p, 0); o2 = texelFetch(l2, p, 0); }
}`;
const COMBINE_FRAG = /* glsl */`
uniform sampler2D l0; uniform sampler2D l1; uniform sampler2D l2; uniform vec3 k0; uniform vec3 k1; uniform vec3 k2;
layout(location = 0) out vec4 o;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = vec4(texelFetch(l0, p, 0).rgb * k0 + texelFetch(l1, p, 0).rgb * k1 + texelFetch(l2, p, 0).rgb * k2, 1.0); }`;
const PROBE_FRAG = /* glsl */`
uniform sampler2D src; uniform ivec2 at; layout(location = 0) out vec4 o;
void main() { o = vec4(clamp(texelFetch(src, at, 0).a, 0.0, 1.0)); }`;

const shader = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FSQ_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
const rt = (w, h, count, type, filter = THREE.NearestFilter) => new THREE.WebGLRenderTarget(w, h, { count, type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: filter, magFilter: filter, generateMipmaps: false });
const yieldUI = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); }); // not throttled in background tabs

// ---------------------------------------------------------------- baker
/** world-space, non-indexed triangles of the occluder meshes; albedo.r encoded as −(r + 1) to tag them */
function occluderGeometry(meshes) {
  const P = [], N = [], A = []; let count = 0;
  const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (const m of meshes) {
    if (count > 400000) break; // safety: dense models
    m.updateWorldMatrix(true, false); nm.getNormalMatrix(m.matrixWorld);
    const g = m.geometry, pos = g.attributes.position, nor = g.attributes.normal, idx = g.index;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material; const a = albedoOf(mat);
    const tri = idx ? idx.count : pos.count;
    for (let i = 0; i < tri; i++) {
      const k = idx ? idx.getX(i) : i;
      v.fromBufferAttribute(pos, k).applyMatrix4(m.matrixWorld); P.push(v.x, v.y, v.z);
      if (nor) n.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize(); else n.set(0, 1, 0);
      N.push(n.x, n.y, n.z); A.push(-(a[0] + 1), a[1], a[2]);
    }
    count += tri / 3;
  }
  return { position: new Float32Array(P), normal: new Float32Array(N), albedo: new Float32Array(A), count: Math.round(count) };
}

export function createBaker(renderer, { onReset = () => {} } = {}) {
  const S = {
    result: null,  // { W, H, perMesh, fingerprint, sig, layers (MRT, 3 × HalfFloat), final (lightmap RT) }
    running: false, cancel: false, enabled: true,
    clones: [], cloneOf: new WeakMap(), sourceOf: new WeakMap(), applied: false,
  };
  const gl = renderer.getContext();
  // GPU reset (context lost): render-target contents are gone, so the bake is invalid → drop it, tell the app
  renderer.domElement.addEventListener('webglcontextlost', () => { S.cancel = true; if (S.result) { S.result = null; S.applied = false; onReset(); } });
  const floatBlend = !!renderer.extensions.get('EXT_float_blend');
  renderer.extensions.get('EXT_color_buffer_float');
  const probeRT = rt(1, 1, 1, THREE.UnsignedByteType);
  const probe = new FullScreenQuad(shader(PROBE_FRAG, { src: { value: null }, at: { value: new THREE.Vector2() } }));
  const probeBuf = new Uint8Array(4);
  /** wait for the GPU: a 1-pixel pass that reads the target, then read that pixel back */
  function sync(tex, x = 0, y = 0) {
    probe.material.uniforms.src.value = tex; probe.material.uniforms.at.value.set(x, y);
    renderer.setRenderTarget(probeRT); probe.render(renderer);
    renderer.readRenderTargetPixels(probeRT, 0, 0, 1, 1, probeBuf);
  }

  function lightsTexture(groups) {
    const list = [];
    const p = new THREE.Vector3(), q = new THREE.Vector3(), ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
    groups.fixtureLights.updateMatrixWorld(true);
    for (const o of groups.fixtureLights.children) {
      if (!o.isLight) continue;
      const I = o.userData.base ?? o.intensity; if (!(I > 0)) continue;
      const col = o.color.clone().multiplyScalar(I);
      p.setFromMatrixPosition(o.matrixWorld);
      if (o.isSpotLight) {
        q.setFromMatrixPosition(o.target.matrixWorld); const dir = q.clone().sub(p).normalize();
        list.push([p.x, p.y, p.z, 1, dir.x, dir.y, dir.z, Math.cos(o.angle), col.r, col.g, col.b, Math.cos(o.angle * (1 - o.penumbra)), 0, 0, 0, o.decay, 0, 0, 0, 0]);
      } else if (o.isRectAreaLight) {
        o.matrixWorld.extractBasis(ax, ay, az); ax.normalize(); ay.normalize(); az.normalize();
        const hw = ax.clone().multiplyScalar(o.width / 2), hh = ay.clone().multiplyScalar(o.height / 2);
        list.push([p.x, p.y, p.z, 2, hw.x, hw.y, hw.z, 0, col.r, col.g, col.b, 0, hh.x, hh.y, hh.z, 0, -az.x, -az.y, -az.z, o.width * o.height]);
      }
    }
    const n = Math.max(1, list.length);
    const data = new Float32Array(n * 5 * 4); list.forEach((l, i) => data.set(l, i * 20));
    const tex = new THREE.DataTexture(data, n * 5, 1, THREE.RGBAFormat, THREE.FloatType); tex.needsUpdate = true;
    return { tex, count: list.length };
  }

  /**
   * Bake. src = a freshly built full-height scene (buildScene(..., {cut:null})), not shown.
   * opts: { samples, sunDir (Vector3 towards the sun), env (equirect DataTexture | null), skyTop, skyBottom, sig, onProgress(p, msg) }
   */
  async function bake(src, opts) {
    if (S.running) return false;
    S.running = true; S.cancel = false;
    const onProgress = opts.onProgress || (() => {});
    const disposables = [];
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    try {
      const t0 = performance.now();
      onProgress(0, '展開 lightmap 座標…');
      await yieldUI();
      const meshes = bakeTargets(src.groups);
      const fp = fingerprint(meshes);
      const U = unwrap(meshes, opts.tpm || 30); // ≈ 3.3 cm texels
      const { W, H } = U;
      // merged world-space geometry (non-indexed): G-buffer + BVH
      const nT = U.tris.length;
      const pos = new Float32Array(nT * 9), nor = new Float32Array(nT * 9), lm = new Float32Array(nT * 6), alb = new Float32Array(nT * 9);
      U.tris.forEach((t, i) => {
        const a = albedoOf(t.mat);
        for (let j = 0; j < 3; j++) {
          const o = i * 9 + j * 3;
          pos[o] = t.p[j].x; pos[o + 1] = t.p[j].y; pos[o + 2] = t.p[j].z;
          nor[o] = t.n.x; nor[o + 1] = t.n.y; nor[o + 2] = t.n.z;
          alb[o] = a[0]; alb[o + 1] = a[1]; alb[o + 2] = a[2];
          lm[i * 6 + j * 2] = t.uv[j][0]; lm[i * 6 + j * 2 + 1] = t.uv[j][1];
        }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('lmuv', new THREE.BufferAttribute(lm, 2));
      geo.setAttribute('albedo', new THREE.BufferAttribute(alb, 3));
      disposables.push(geo);
      onProgress(0, `建立光線加速結構（${nT} 個三角形）…`);
      await yieldUI();
      // G-buffer
      const gbuf = rt(W, H, 2, THREE.FloatType); disposables.push(gbuf);
      const gScene = new THREE.Scene(); const gMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, ...GBUF, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
      disposables.push(gMat);
      const gMesh = new THREE.Mesh(geo, gMat); gMesh.frustumCulled = false; gScene.add(gMesh);
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(gbuf); renderer.clear(); renderer.render(gScene, new THREE.Camera());
      // BVH over the same triangles + the furniture as occluders (MeshBVH adds/reorders an index on its own copy)
      const occ = occluderGeometry(opts.occluders === false ? [] : occluderMeshes(src.groups)); // opts.occluders = false: old behaviour (comparison)
      const bgeo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'albedo']) {
        const a = geo.attributes[k].array, b = occ[k];
        const m = new Float32Array(a.length + b.length); m.set(a); m.set(b, a.length);
        bgeo.setAttribute(k, new THREE.BufferAttribute(m, 3));
      }
      disposables.push(bgeo);
      const bvh = new MeshBVH(bgeo, { strategy: SAH, targetLeafSize: 4 });
      const bvhU = new MeshBVHUniformStruct(); bvhU.updateFrom(bvh);
      const nTex = new FloatVertexAttributeTexture(); nTex.updateFrom(bgeo.attributes.normal);
      const aTex = new FloatVertexAttributeTexture(); aTex.updateFrom(bgeo.attributes.albedo);
      disposables.push(bvhU, nTex, aTex);
      const lights = lightsTexture(src.groups); disposables.push(lights.tex);
      // accumulation (3 layers: sky, sun, fixtures; alpha = sample count / back-face count)
      const acc = rt(W, H, 3, floatBlend ? THREE.FloatType : THREE.HalfFloatType); disposables.push(acc);
      renderer.setRenderTarget(acc); renderer.clear();
      const trace = new FullScreenQuad(shader(TRACE_FRAG, {
        bvh: { value: bvhU }, normalAttr: { value: nTex }, albedoAttr: { value: aTex },
        gPos: { value: gbuf.textures[0] }, gNor: { value: gbuf.textures[1] },
        envMap: { value: opts.env || null }, hasEnv: { value: !!opts.env }, envClamp: { value: 30 },
        skyTop: { value: new THREE.Color(opts.skyTop || '#dfe9f3') }, skyBottom: { value: new THREE.Color(opts.skyBottom || '#8a7f72') },
        sunDir: { value: opts.sunDir.clone().normalize() },
        lightTex: { value: lights.tex }, lightCount: { value: lights.count }, rectDirect: { value: !!opts.rectDirect },
        seed: { value: 0 }, spp: { value: 1 }, bounces: { value: opts.bounces || 2 }, maxRadiance: { value: opts.maxRadiance ?? 3 },
      }, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor }));
      disposables.push(trace);
      // tiles that contain any chart
      const tiles = [];
      for (let ty = 0; ty < H; ty += TILE) for (let tx = 0; tx < W; tx += TILE) {
        const w = Math.min(TILE, W - tx), h = Math.min(TILE, H - ty);
        if (U.charts.some((c) => c.x < tx + w && c.x + c.w + 2 * PAD > tx && c.y < ty + h && c.y + c.h + 2 * PAD > ty)) tiles.push([tx, ty, w, h]);
      }
      const target = opts.samples || 256;
      let done = 0, spp = 2, round = 0;
      // first draw compiles the shader (can take a while): one tiny tile, synced
      onProgress(0, '編譯烘焙著色器…');
      await yieldUI();
      const u = trace.material.uniforms;
      const drawTile = ([x, y, w, h], n) => {
        u.spp.value = n; acc.scissor.set(x, y, w, h); acc.scissorTest = true;
        renderer.setRenderTarget(acc); trace.render(renderer);
        acc.scissorTest = false;
        sync(acc.textures[0], x, y);
      };
      const tStart = performance.now(); let lastYield = tStart;
      while (done < target && !S.cancel) {
        const n = Math.min(spp, target - done);
        let worst = 0;
        for (const tile of tiles) {
          if (S.cancel) break;
          u.seed.value = (round * 7919 + tiles.indexOf(tile) * 104729) % 1e7;
          const tb = performance.now(); drawTile(tile, n); worst = Math.max(worst, performance.now() - tb);
          if (gl.isContextLost()) throw new Error('顯示卡繪圖環境被重設（GPU 逾時）');
          if (performance.now() - lastYield > 40) { await yieldUI(); lastYield = performance.now(); }
        }
        if (S.cancel) break;
        done += n; round++;
        // keep each GPU submission short (Windows TDR ≈ 2 s): aim for ~40 ms per tile
        if (worst < 20 && spp < 64) spp *= 2; else if (worst > 90 && spp > 1) spp = Math.max(1, spp >> 1);
        const el = (performance.now() - tStart) / 1000, eta = done ? Math.round(el / done * (target - done)) : null;
        onProgress(done / target * 0.95, `取樣 ${done} / ${target}` + (eta != null && done < target ? ` · 約剩 ${eta >= 60 ? Math.floor(eta / 60) + ' 分 ' : ''}${eta % 60} 秒` : ''));
        await yieldUI(); lastYield = performance.now();
      }
      if (S.cancel) { onProgress(0, '已取消（保留原本的烘焙結果）'); return false; }
      // resolve → denoise → dilate
      onProgress(0.96, '降噪、填補接縫…');
      await yieldUI();
      const HT = THREE.HalfFloatType;
      let A = rt(W, H, 3, HT), B = rt(W, H, 3, HT);
      const resolve = new FullScreenQuad(shader(RESOLVE_FRAG, { a0: { value: acc.textures[0] }, a1: { value: acc.textures[1] }, a2: { value: acc.textures[2] }, gPos: { value: gbuf.textures[0] } }));
      renderer.setRenderTarget(A); resolve.render(renderer); sync(A.textures[0]); resolve.dispose();
      const swap = () => { const t = A; A = B; B = t; };
      const atrous = new FullScreenQuad(shader(ATROUS_FRAG, { l0: { value: null }, l1: { value: null }, l2: { value: null }, gPos: { value: gbuf.textures[0] }, gNor: { value: gbuf.textures[1] }, stepPx: { value: 1 }, sigmaP: { value: 0.1 } }));
      const texel = 1 / U.tpm;
      const target0 = opts.samples || 256;
      for (const st of opts.denoise ?? (target0 <= 256 ? [1, 2, 4] : target0 <= 1024 ? [1, 2] : [1])) { // fewer samples → wider blur
        Object.assign(atrous.material.uniforms, { l0: { value: A.textures[0] }, l1: { value: A.textures[1] }, l2: { value: A.textures[2] } });
        atrous.material.uniforms.stepPx.value = st; atrous.material.uniforms.sigmaP.value = texel * st * 2.5;
        renderer.setRenderTarget(B); atrous.render(renderer); sync(B.textures[0]); swap();
      }
      atrous.dispose();
      const dilate = new FullScreenQuad(shader(DILATE_FRAG, { l0: { value: null }, l1: { value: null }, l2: { value: null } }));
      for (let i = 0; i < 8; i++) {
        Object.assign(dilate.material.uniforms, { l0: { value: A.textures[0] }, l1: { value: A.textures[1] }, l2: { value: A.textures[2] } });
        renderer.setRenderTarget(B); dilate.render(renderer); sync(B.textures[0]); swap();
      }
      dilate.dispose(); B.dispose();
      // keep the layers (for re-combining when the time of day changes) + a filtered final lightmap
      for (const l of A.textures) { l.minFilter = l.magFilter = THREE.NearestFilter; }
      const final = rt(W, H, 1, HT, THREE.LinearFilter);
      final.texture.channel = 1; // sampled with geometry.attributes.uv1
      if (S.result) { S.result.layers.dispose(); S.result.final.dispose(); }
      S.result = { W, H, tpm: U.tpm, perMesh: U.perMesh, fingerprint: fp, sig: opts.sig, furnSig: furnitureSig(src.groups), occTris: occ.count, rectDirect: !!opts.rectDirect && lights.count > 0, layers: A, final, k: null, texels: tiles.length, tris: nT, lights: lights.count, samples: done, seconds: (performance.now() - t0) / 1000 };
      if (opts.scales) combine(opts.scales, true);
      onProgress(1, `完成：${W}×${H} 圖集、${done} 樣本、${lights.count} 盞燈，${Math.round(S.result.seconds)} 秒`);
      return true;
    } finally {
      renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha);
      for (const d of disposables) d.dispose?.();
      S.running = false;
    }
  }

  const combineQuad = new FullScreenQuad(shader(COMBINE_FRAG, { l0: { value: null }, l1: { value: null }, l2: { value: null }, k0: { value: new THREE.Vector3() }, k1: { value: new THREE.Vector3() }, k2: { value: new THREE.Vector3() } }));
  /** scales: { sky: [r,g,b], sun: [r,g,b], art: [r,g,b] } (current sky / sun / fixture strength) */
  function combine(scales, force = false) {
    const R = S.result; if (!R) return false;
    const key = JSON.stringify(scales);
    if (!force && key === R.k) return false;
    R.k = key;
    const u = combineQuad.material.uniforms;
    u.l0.value = R.layers.textures[0]; u.l1.value = R.layers.textures[1]; u.l2.value = R.layers.textures[2];
    u.k0.value.set(...scales.sky); u.k1.value.set(...scales.sun); u.k2.value.set(...scales.art);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(R.final); combineQuad.render(renderer); renderer.setRenderTarget(prev);
    return true;
  }

  function bakedMaterial(m) {
    if (!m) return m;
    let c = S.cloneOf.get(m);
    if (!c) {
      c = m.clone(); S.cloneOf.set(m, c); S.sourceOf.set(c, m); S.clones.push(c);
      setLM(c);
    }
    return c;
  }
  function setLM(c) {
    c.lightMap = S.result.final.texture; c.lightMapIntensity = 1; c.envMapIntensity = BAKED_ENV; c.needsUpdate = true;
  }
  /**
   * After every rebuild: give the new architecture meshes their lightmap if the bake still fits
   * (same structure). Returns 'applied' | 'mismatch' | 'cut' | 'none' | 'off'.
   */
  function attach(built) {
    S.applied = false; S.clones = []; S.cloneOf = new WeakMap();
    const R = S.result;
    if (!R || !built) return 'none';
    if (!S.enabled) return 'off';
    if (built.cut != null) return 'cut';
    const meshes = bakeTargets(built.groups);
    if (meshes.length !== R.perMesh.length || fingerprint(meshes) !== R.fingerprint) return 'mismatch';
    const seen = new Set();
    meshes.forEach((m, i) => {
      const info = R.perMesh[i];
      let g = m.geometry;
      if (info.nonIndexed) g = g.toNonIndexed();
      else if (seen.has(g)) g = g.clone(); // floor + ceiling share one ShapeGeometry: each needs its own UV2
      seen.add(g);
      g.setAttribute('uv1', new THREE.BufferAttribute(info.uv1, 2));
      m.geometry = g;
      m.material = Array.isArray(m.material) ? m.material.map(bakedMaterial) : bakedMaterial(m.material);
    });
    S.applied = true;
    return 'applied';
  }
  /** PBR photo textures stream in later and upgrade the ORIGINAL materials in place: copy them over to the clones */
  function syncMaterials() {
    if (!S.applied) return false;
    let changed = false;
    for (const c of S.clones) {
      const m = S.sourceOf.get(c); if (!m) continue;
      if (c.map === m.map && c.normalMap === m.normalMap && c.roughnessMap === m.roughnessMap && c.aoMap === m.aoMap && c.roughness === m.roughness && c.color.equals(m.color)) continue;
      c.copy(m); setLM(c); changed = true;
    }
    return changed;
  }
  /** plain-data copy of the bake (for the browser cache, IndexedDB): the 3 HalfFloat layers + lightmap UVs */
  function exportResult() {
    const R = S.result; if (!R) return null;
    const layers = [];
    for (let i = 0; i < 3; i++) { const buf = new Uint16Array(R.W * R.H * 4); renderer.readRenderTargetPixels(R.layers, 0, 0, R.W, R.H, buf, undefined, i); layers.push(buf); }
    const { W, H, tpm, fingerprint, sig, furnSig, occTris, texels, tris, lights, samples, seconds, rectDirect } = R;
    return { v: 1, W, H, tpm, fingerprint, sig, furnSig, occTris, texels, tris, lights, samples, seconds, rectDirect, layers,
      perMesh: R.perMesh.map((p) => ({ nonIndexed: !!p.nonIndexed, uv1: p.uv1 })) };
  }
  /** restore a cached bake; call attach(built) afterwards */
  function importResult(d) {
    if (!d || d.v !== 1 || d.layers?.length !== 3) return false;
    const tex = d.layers.map((buf) => {
      const t = new THREE.DataTexture(buf, d.W, d.H, THREE.RGBAFormat, THREE.HalfFloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
    });
    const final = rt(d.W, d.H, 1, THREE.HalfFloatType, THREE.LinearFilter);
    final.texture.channel = 1;
    if (S.result) { S.result.layers.dispose(); S.result.final.dispose(); }
    const { layers: _l, ...rest } = d;
    S.result = { ...rest, layers: { textures: tex, dispose() { tex.forEach((t) => t.dispose()); } }, final, k: null, restored: true };
    return true;
  }
  function clear() {
    if (S.result) { S.result.layers.dispose(); S.result.final.dispose(); }
    S.result = null; S.applied = false; S.clones = []; S.cloneOf = new WeakMap();
  }
  return {
    bake, attach, combine, syncMaterials, clear, exportResult, importResult,
    cancel() { S.cancel = true; },
    /** a baked clone → the original material (path tracer must not see the lightmap) */
    sourceOf: (m) => S.sourceOf.get(m) || m,
    get running() { return S.running; },
    get result() { return S.result; },
    get applied() { return S.applied; },
    get enabled() { return S.enabled; }, set enabled(v) { S.enabled = !!v; },
    /** envMapIntensity kept on baked surfaces (specular reflections + a little unoccluded fill) */
    get envKeep() { return BAKED_ENV; }, set envKeep(v) { BAKED_ENV = v; for (const c of S.clones) c.envMapIntensity = v; },
  };
}
