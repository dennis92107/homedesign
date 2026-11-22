// 截圖對照工具（除錯用，HANDOFF §7）。用法（瀏覽器主控台 / javascript_tool）：
//   const S = await app.shots();
//   await S.setStyle('wabi-yu');           // 只換記憶體裡的樣板（不寫客製層 baseStyle），並等真實模型載完
//   const c = { title: '…', living: S.view('living'), bedroom: S.view('bedroom'), dining: S.view('dining') };
//   await S.save('name', c);                // → designs/_shots-name.json，再用 python -X utf8 tools/decode_shots.py name out.jpg
// 視角（勝旺家 A3【格局異動】，公尺）：攝影模式 24 mm、相機 125 cm、水平＋鏡頭位移。
const VIEWS = {
  living: [9.0, 4.7, 60, -0.1],
  bedroom: [2.95, 3.55, 62, -0.13],
  dining: [9.15, 6.3, 75, -0.1],
  livingWindow: [9.0, 4.7, 30, -0.02], // facing the balcony door (window view)
  bedroomWindow: [2.95, 3.55, 20, -0.04],
};
const VIEW_OVERRIDE = { 'dark-industrial-gong': { living: [8.75, 4.8, 56, -0.1] } }; // 避開格柵板
let current = '';
const app = () => window.app;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setStyle(slug, { wait = 25000 } = {}) {
  const a = app();
  a.state.live = false; // stop polling from swapping the style back
  const s = await (await fetch(`styles/${slug}.json?t=${Date.now()}`)).json();
  a.state.style = s; current = slug; a.rebuild();
  if (a.state.view !== 'walk') a.enterWalkAt(9.0, 4.7);
  const r = await waitModels(wait);
  // photo textures (Poly Haven PBR) stream separately from the models: wait for them too, or walls come out flat
  for (const t0 = performance.now(); a.assetStats.pending > 0 && performance.now() - t0 < wait;) await sleep(500);
  await sleep(2500); // decor models / textures settle
  view('living', { n: 2 }); // warm-up: the first frame after a rebuild can still carry the old projection
  return [s.name, ...r];
}
export function modelsReady() {
  const jobs = app().state.built.modelJobs || []; let done = 0;
  jobs.forEach((j) => { let ok = false; j.target?.traverse?.((o) => { if (o.userData?.isModel) ok = true; }); if (ok) done++; });
  return [done, jobs.length];
}
export async function waitModels(max = 25000) {
  const t0 = performance.now();
  while (performance.now() - t0 < max) { const [d, n] = modelsReady(); if (d >= n) return [d, n, 'ok']; await sleep(800); }
  return [...modelsReady(), 'timeout'];
}
/** photo-mode shot from a named view (or [x, z, yawDeg, shift]); n = accumulated frames */
export function view(v, { n = 32, mm = 24, hour } = {}) {
  const a = app();
  const [x, z, yaw, shift] = Array.isArray(v) ? v : (VIEW_OVERRIDE[current]?.[v] || VIEWS[v]);
  if (hour != null && a.state.hour !== hour) { a.state.hour = hour; a.applyLighting(); }
  a.enterWalkAt(x, z); a.photo.set({ on: true, shift, mm });
  a.walk.yaw = (yaw * Math.PI) / 180; a.camera.rotation.set(0, a.walk.yaw, 0, 'YXZ');
  a.settleLights?.(); // the realtime light pool fades lights in over 0.4 s: settle before shooting
  a.accum.markDirty(); for (let i = 0; i < n; i++) a.snap();
  return a.renderer.domElement.toDataURL('image/jpeg', 0.9);
}
export async function save(name, content) {
  const r = await fetch('api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `designs/_shots-${name}.json`, content }) });
  return r.status;
}
export const STYLES = ['wabi-yu', 'modern-grey-yin', 'modern-brown-xu', 'dark-industrial-gong', 'ink-modern-mo'];
