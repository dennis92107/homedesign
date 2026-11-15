// 畫質強化（即時預覽）
//
// 1. 靜止累積（AccumulatePass + 子像素抖動）
//    跟 three.js 官方 TAARenderPass 同一個原理：鏡頭不動時，每一張畫面把投影矩陣偏移不到一個像素（Halton 2,3 序列），
//    再把結果平均起來 → 邊緣反鋸齒、細線不再閃。差別是我們抖動的是「整條後製」（場景 + GTAO 環境光遮蔽），
//    而且每張換一組旋轉過的 GTAO 取樣方向，所以 AO 的顆粒雜訊也一起被平均掉。
//    鏡頭一動或場景有變化就立刻重來（markDirty），超過 MAX 張後改成指數移動平均，漏掉的變化也會在半秒內淡入。
// 2. 漫遊時的太陽陰影（stableShadowFit）
//    陰影貼圖只涵蓋鏡頭附近的範圍（解析度更高），而且中心點對齊陰影貼圖的像素格，鏡頭移動時陰影邊緣不會游動
//    （"stable shadow maps"：texel snapping）。
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const MAX = 32;

function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }
const JITTER = Array.from({ length: MAX }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

class AccumulatePass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;
    this.count = 0;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.targets = [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)];
    this.mix = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tPrev: { value: null }, tCur: { value: null }, w: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tPrev, tCur; uniform float w; varying vec2 vUv; void main(){ gl_FragColor = mix(texture2D(tPrev, vUv), texture2D(tCur, vUv), w); }',
      depthTest: false, depthWrite: false,
    }));
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
      depthTest: false, depthWrite: false,
    }));
  }
  reset() { this.count = 0; }
  setSize(w, h) { this.targets.forEach((t) => t.setSize(w, h)); this.reset(); }
  render(renderer, writeBuffer, readBuffer) {
    const [prev, next] = this.targets;
    this.mix.material.uniforms.tPrev.value = prev.texture;
    this.mix.material.uniforms.tCur.value = readBuffer.texture;
    this.mix.material.uniforms.w.value = 1 / Math.min(this.count + 1, MAX); // plain average, then a moving average
    renderer.setRenderTarget(next); this.mix.render(renderer);
    this.targets.reverse();
    this.count++;
    this.copy.material.uniforms.tDiffuse.value = next.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.copy.render(renderer);
  }
  dispose() { this.targets.forEach((t) => t.dispose()); this.mix.dispose(); this.copy.dispose(); }
}

/** GTAO's 5×5 direction noise, rotated k/K of a turn (so successive frames sample different directions) */
function rotatedNoise(base, k, K) {
  const src = base.image.data, out = new Uint8Array(src.length), a = (2 * Math.PI * k) / K, c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < src.length; i += 4) {
    const x = src[i] / 255 * 2 - 1, y = src[i + 1] / 255 * 2 - 1;
    out[i] = ((x * c - y * s) * 0.5 + 0.5) * 255; out[i + 1] = ((x * s + y * c) * 0.5 + 0.5) * 255; out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3];
  }
  const t = new THREE.DataTexture(out, base.image.width, base.image.height);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  return t;
}

export function createAccumulator({ renderer, composer, camera, gtao, index }) {
  const pass = new AccumulatePass();
  composer.insertPass(pass, index);
  const baseNoise = gtao.gtaoMaterial.uniforms.tNoise.value;
  const noises = Array.from({ length: 8 }, (_, k) => (k ? rotatedNoise(baseNoise, k, 8) : baseNoise));
  const lastM = new THREE.Matrix4(), lastP = new THREE.Matrix4();
  let dirty = true, enabled = true;
  const size = new THREE.Vector2();
  return {
    pass,
    get samples() { return pass.count; },
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; dirty = true; },
    markDirty() { dirty = true; },
    /** call right before composer.render(): resets on change, applies this frame's sub-pixel jitter */
    before() {
      camera.updateMatrixWorld();
      if (dirty || !lastM.equals(camera.matrixWorld) || !lastP.equals(camera.projectionMatrix)) {
        lastM.copy(camera.matrixWorld); lastP.copy(camera.projectionMatrix); dirty = false; pass.reset();
      }
      const n = pass.count;
      if (!enabled || n === 0) { gtao.gtaoMaterial.uniforms.tNoise.value = baseNoise; return; }
      renderer.getDrawingBufferSize(size);
      const [jx, jy] = JITTER[n % MAX];
      camera.setViewOffset(size.x, size.y, jx, jy, size.x, size.y);
      gtao.gtaoMaterial.uniforms.tNoise.value = noises[n % noises.length];
    },
    /** call right after composer.render(): removes the jitter again (keeps the un-jittered matrix for change detection) */
    after() {
      if (camera.view?.enabled) { camera.clearViewOffset(); lastP.copy(camera.projectionMatrix); }
      if (!enabled) pass.reset();
    },
  };
}

/**
 * Directional-light shadow box. Whole house (orbit / top views) or a box around the walker (walk view), with the
 * box centre snapped to whole shadow-map texels in light space so the shadow edges don't swim while walking.
 */
export function stableShadowFit(sun, { center, radius, mapSize }) {
  const sc = sun.shadow.camera;
  const dir = new THREE.Vector3().subVectors(sun.position, sun.target.position).normalize();
  // light-space basis
  const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  const up2 = new THREE.Vector3().crossVectors(dir, right).normalize();
  const texel = (radius * 2) / mapSize;
  const u = Math.round(center.dot(right) / texel) * texel, v = Math.round(center.dot(up2) / texel) * texel, d = center.dot(dir);
  const snapped = new THREE.Vector3().addScaledVector(right, u).addScaledVector(up2, v).addScaledVector(dir, d);
  const dist = 30;
  sun.target.position.copy(snapped);
  sun.position.copy(snapped).addScaledVector(dir, dist);
  sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
  sc.near = 1; sc.far = dist + 40; sc.updateProjectionMatrix();
  // keep the bias proportional to the texel size (bigger texels need more normal bias)
  sun.shadow.normalBias = Math.max(0.01, texel * 3);
}
