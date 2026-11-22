// Loading 動畫（index.html #loader）：開站時蓋住 3D 預覽，場景建好且第一批模型/貼圖下載完才淡出；
// 之後換平面圖/樣板若素材下載超過 0.7 秒，縮成畫面上方的小膠囊（不擋操作）。
import { assetStats } from './assets.js';
const el = document.getElementById('loader');
const stageEl = el?.querySelector('.ld-stage');
const MAX_WAIT = 25000; // 素材再慢也最多擋 25 秒，之後邊看邊載
let built = false, done = false, builtAt = 0, miniTimer = 0;

export function loaderStage(text, err = false) {
  if (!stageEl || done) return;
  stageEl.textContent = text; stageEl.classList.toggle('err', err);
}
/** 第一次場景建好 */
export function loaderBuilt() {
  if (built || !el) return;
  built = true; builtAt = performance.now();
  loaderStage('Streaming furniture & materials');
  setTimeout(check, 500); // 讓 builder 先把要下載的素材排進佇列
}
export function loaderError(msg) { if (!done) loaderStage(msg, true); }
/** assetStats 變動時呼叫 */
export function loaderAssets(s) {
  if (!el) return;
  if (!done) {
    if (built && s.pending) loaderStage(`Streaming furniture & materials · ${s.pending} left`);
    return;
  }
  if (s.pending) {
    if (stageEl) stageEl.textContent = `Streaming assets · ${s.pending}`;
    if (!miniTimer && el.classList.contains('gone')) miniTimer = setTimeout(() => { miniTimer = 0; if (assetStats.pending) el.classList.remove('gone'); }, 700);
  } else {
    clearTimeout(miniTimer); miniTimer = 0; el.classList.add('gone');
  }
}
function check() {
  if (done) return;
  if (!assetStats.pending || performance.now() - builtAt > MAX_WAIT) finish();
  else setTimeout(check, 400);
}
function finish() {
  done = true;
  el.classList.add('gone');
  setTimeout(() => { el.classList.add('mini'); if (stageEl) stageEl.classList.remove('err'); }, 650);
}
