// 調色＋光暈（即時預覽與光線追蹤共用）
//
// 順序（依 three.js 官方做法與 Don McCurdy〈Emission and bloom〉https://www.donmccurdy.com/2024/04/27/emission-and-bloom/ ）：
//   場景（線性 HDR）→ GTAO → 靜止累積 → 光暈 UnrealBloomPass（還在線性 HDR，只有亮度超過門檻的燈罩/燈帶/窗才會暈開）
//   → OutputPass（曝光＋色調映射＋sRGB）→ 調色 GradePass（顯示空間：白平衡、對比 S 曲線、飽和度、黑位、暗角）。
// 調色刻意輕微（D5 Render 調色指南 https://www.d5render.com/posts/color-grading-d5-effect-panel-guide 、
// ArchiCGI 後製 https://archicgi.com/5-post-production-tricks-3d-visualizations/ ：先做整體、少量；暗角只輕壓邊緣）。
//
// 樣板可寫 lighting.grade = { saturation, contrast, warmth, tint, blacks, vignette }、
//          lighting.bloom = { strength, radius, threshold } 或 false。沒寫就用 DEFAULTS。
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export const GRADE_DEFAULTS = { saturation: 1, contrast: 1.06, warmth: 0, tint: 0, blacks: 0, vignette: 0.2 };
// threshold is in exposed linear units (scene radiance × exposure): 5 ≈ only light sources (lamp shades, LED strips); objects right under a lamp stay below
export const BLOOM_DEFAULTS = { strength: 0.33, radius: 0.45, threshold: 5 };

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1 }, contrast: { value: 1 }, warmth: { value: 0 }, tint: { value: 0 },
    blacks: { value: 0 }, vignette: { value: 0 }, aspect: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float saturation, contrast, warmth, tint, blacks, vignette, aspect;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    // display (sRGB-encoded) ↔ linear, for the white balance and vignette (they are multiplications of light)
    vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
    vec3 toDisp(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 lin = toLin(tex.rgb);
      // white balance: warmth (+ = amber, − = blue), tint (+ = magenta, − = green); keep luminance
      vec3 wb = vec3(1.0 + 0.12 * warmth, 1.0 - 0.10 * tint, 1.0 - 0.12 * warmth);
      float l0 = luma(lin); lin *= wb; lin *= l0 / max(luma(lin), 1e-5);
      // natural lens falloff (cos⁴-like), aspect-corrected, applied to light
      vec2 d = (vUv - 0.5) * vec2(aspect, 1.0); float r = length(d) / length(vec2(aspect, 1.0) * 0.5);
      lin *= 1.0 - vignette * smoothstep(0.25, 1.15, r) * 0.85;
      vec3 c = toDisp(lin);
      // contrast as a soft S curve that keeps black and white fixed (no clipping)
      float k = contrast - 1.0;
      vec3 s = c * c * (3.0 - 2.0 * c);
      c = k >= 0.0 ? mix(c, s, clamp(k * 2.0, 0.0, 1.0)) : mix(c, vec3(0.5) + (c - 0.5) * (1.0 + k), 1.0);
      // blacks: + = lift (matte), − = crush
      c = blacks >= 0.0 ? blacks + c * (1.0 - blacks) : max((c + blacks) / (1.0 + blacks), 0.0);
      // saturation around luminance
      c = mix(vec3(luma(c)), c, saturation);
      // dither (±0.5 / 255) so gentle gradients and the vignette don't band in 8-bit output
      float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      gl_FragColor = vec4(clamp(c + n / 255.0, 0.0, 1.0), tex.a);
    }`,
};

export function createPostFX(renderer) {
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), BLOOM_DEFAULTS.strength, BLOOM_DEFAULTS.radius, BLOOM_DEFAULTS.threshold);
  const grade = new ShaderPass(GradeShader);
  // realtime: same highlight clamp before the bloom (window-view street lights / sun glints are 100× brighter than
  // anything tone mapping can show; unclamped they bloom into a haze over the whole window)
  const clamp = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, maxLum: { value: 12 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; uniform float maxLum; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); gl_FragColor = vec4(c.rgb * min(1.0, maxLum / max(l, 1e-4)), c.a); }',
  });
  const fx = { enabled: true, bloomT: BLOOM_DEFAULTS.threshold, bloomOn: true, maxLum: 12, ptMaxLum: 12 };

  // path tracer: its (denoised) linear image → own HDR target → bloom → OutputPass → grade → canvas
  const hdr = { type: THREE.HalfFloatType, depthBuffer: false };
  const ptLin = new THREE.WebGLRenderTarget(1, 1, hdr), ptOut = new THREE.WebGLRenderTarget(1, 1, hdr), ptClamp = new THREE.WebGLRenderTarget(1, 1, hdr);
  // firefly clamp before the bloom: a few extremely bright noise pixels (small lamps at low sample counts) would
  // otherwise bloom into stars. Far above what tone mapping can show, so converged highlights look the same.
  const clampQuad = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, maxLum: { value: 20 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; uniform float maxLum; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); gl_FragColor = vec4(c.rgb * min(1.0, maxLum / max(l, 1e-4)), c.a); }',
    depthTest: false, depthWrite: false,
  }));
  const ptOutput = new OutputPass();
  const ptBloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0, 1);
  const ptGrade = new FullScreenQuad(new THREE.ShaderMaterial({ ...GradeShader, uniforms: grade.material.uniforms, depthTest: false, depthWrite: false }));
  let ptSize = new THREE.Vector2();

  // exposure meter (光追自動曝光): the frame is reduced to a 64×36 grid of cells, each the log2 of the mean luminance
  // of 4×4 taps; the CPU keeps the cells between two percentiles (like Unreal's histogram metering, so bright windows
  // and lamp shades don't pull the exposure down) and returns their average as a luminance.
  const MW = 64, MH = 36;
  const meterRT = new THREE.WebGLRenderTarget(MW, MH, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const meterQuad = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      void main(){ vec2 cell = vec2(1.0 / ${MW}.0, 1.0 / ${MH}.0); vec2 o = vUv - cell * 0.5; float s = 0.0;
        for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) {
          vec3 c = texture2D(tDiffuse, o + cell * (vec2(float(i), float(j)) + 0.5) / 4.0).rgb;
          s += dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        gl_FragColor = vec4(log2(max(s / 16.0, 1e-4)), 0.0, 0.0, 1.0); }`, // log of the cell mean: path-tracing noise would bias a mean of logs low
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  }));
  const meterBuf = new Float32Array(MW * MH * 4);
  function meterDraw(r, texture) {
    const prevRT = r.getRenderTarget();
    meterQuad.material.uniforms.tDiffuse.value = texture;
    r.setRenderTarget(meterRT); meterQuad.render(r);
    r.setRenderTarget(prevRT);
  }
  /** scene-referred (pre-exposure) average luminance of a linear HDR texture, outliers trimmed */
  function meter(r, texture, opts) {
    meterDraw(r, texture);
    r.readRenderTargetPixels(meterRT, 0, 0, MW, MH, meterBuf);
    return meterReduce(meterBuf, opts);
  }
  /** same, read back asynchronously (no pipeline stall: used every few frames by the realtime auto exposure) */
  let asyncBusy = false;
  async function meterAsync(r, texture, opts) {
    if (asyncBusy) return null;
    asyncBusy = true;
    try {
      meterDraw(r, texture);
      const buf = new Float32Array(MW * MH * 4);
      await r.readRenderTargetPixelsAsync(meterRT, 0, 0, MW, MH, buf);
      return meterReduce(buf, opts);
    } finally { asyncBusy = false; }
  }
  function meterReduce(buf, { low = 0.1, high = 0.85 } = {}) {
    const v = []; for (let i = 0; i < MW * MH; i++) if (Number.isFinite(buf[i * 4])) v.push(buf[i * 4]);
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    const a = Math.floor(v.length * low), b = Math.max(a + 1, Math.ceil(v.length * high));
    let s = 0; for (let i = a; i < b; i++) s += v[i];
    return Math.pow(2, s / (b - a));
  }

  function apply(style) {
    const L = style?.lighting || {};
    const g = { ...GRADE_DEFAULTS, ...(L.grade || {}) };
    const u = grade.material.uniforms;
    for (const k of Object.keys(GRADE_DEFAULTS)) u[k].value = +g[k];
    const b = L.bloom === false ? null : { ...BLOOM_DEFAULTS, ...(L.bloom || {}) };
    fx.bloomOn = !!b && b.strength > 0;
    if (b) { bloom.strength = ptBloom.strength = +b.strength; bloom.radius = ptBloom.radius = +b.radius; fx.bloomT = +b.threshold; }
    sync();
  }
  function sync() {
    grade.enabled = fx.enabled;
    bloom.enabled = fx.enabled && fx.bloomOn; clamp.enabled = bloom.enabled;
    clamp.uniforms.maxLum.value = fx.maxLum / Math.max(1e-3, renderer.toneMappingExposure);
    // the threshold is compared before exposure (OutputPass applies it later): convert from exposed units
    bloom.threshold = ptBloom.threshold = fx.bloomT / Math.max(1e-3, renderer.toneMappingExposure);
  }
  /** call before every composer.render(): keeps the threshold in step with the exposure, aspect for the vignette */
  function before(w, h) { sync(); grade.material.uniforms.aspect.value = w / Math.max(1, h); }

  /**
   * path tracer canvas output with the same look. `draw(target)` renders the (denoised) path-traced image into the
   * bound render target (linear: no tone mapping because it is not the canvas). Returns false when post is off.
   */
  function ptFinish(r, w, h, draw) {
    if (!fx.enabled) return false;
    if (ptSize.x !== w || ptSize.y !== h) { ptSize.set(w, h); ptLin.setSize(w, h); ptOut.setSize(w, h); ptClamp.setSize(w, h); ptBloom.setSize(w, h); }
    sync(); grade.material.uniforms.aspect.value = w / Math.max(1, h);
    const auto = r.autoClear; r.autoClear = true;
    r.setRenderTarget(ptLin); r.clear(); draw();
    clampQuad.material.uniforms.tDiffuse.value = ptLin.texture; clampQuad.material.uniforms.maxLum.value = fx.ptMaxLum / Math.max(1e-3, r.toneMappingExposure);
    r.setRenderTarget(ptClamp); clampQuad.render(r);
    if (fx.bloomOn) ptBloom.render(r, null, ptClamp);
    ptOutput.render(r, ptOut, ptClamp);
    ptGrade.material.uniforms.tDiffuse.value = ptOut.texture;
    r.setRenderTarget(null); ptGrade.render(r);
    grade.material.uniforms.tDiffuse.value = null;
    r.autoClear = auto;
    return true;
  }

  return {
    clamp, bloom, grade, apply, before, ptFinish, meter, meterAsync,
    fx, // debug: maxLum / ptMaxLum (highlight clamp before the bloom, exposed units)
    get enabled() { return fx.enabled; },
    set enabled(v) { fx.enabled = !!v; sync(); },
    get params() { const u = grade.material.uniforms; return { grade: Object.fromEntries(Object.keys(GRADE_DEFAULTS).map((k) => [k, u[k].value])), bloom: { on: fx.bloomOn, strength: bloom.strength, radius: bloom.radius, threshold: fx.bloomT } }; },
  };
}
