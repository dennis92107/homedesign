// 儲存層：同一套網頁兩種模式
//
// - server：用 python server.py 開的（家裡）。讀網站檔案、存檔走 POST /api/save，跟以前一樣。
// - local ：放在 Cloudflare Pages 這類靜態網站上（公司）。沒有 server.py 可以存檔，
//           所以修改存在「這台電腦這個瀏覽器」的 localStorage（關掉再開還在），讀檔時本機修改優先。
//
// 兩邊靠「變更包」交換（一個 .json 檔，Email / 雲端硬碟 / 隨身碟帶著走）：
//   家裡 匯出 → 完整快照（kind: snapshot，所有平面圖/樣板/客製層/目錄）
//   公司 匯出 → 只有改過的檔案（kind: changes），每個檔案附「改之前的版本」base
//   匯入時用三方合併（design.js 的 merge3）：共同祖先 = 變更包的 base（沒有就用接收端的 base），
//   兩邊都改到同一個值時以「匯入的」為準。所以女友在家同時改的東西不會被整包蓋掉。
import { merge3 } from './design.js';

const PREFIX = 'hd:file:';
const canon = (o) => JSON.stringify(o);
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const listeners = new Set();

export const store = {
  mode: 'server',
  readonly: false,
  get local() { return this.mode === 'local'; },
  onChange(fn) { listeners.add(fn); },
};

/** is there a server.py behind this site? It answers POST /api/save with JSON even for a bad request;
 *  a static host (Cloudflare Pages, python -m http.server) answers with an HTML error page. */
export async function detectMode() {
  try {
    const r = await fetch('api/info', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (j?.server === 'homedesign') { store.mode = 'server'; store.readonly = !!j.readonly; return store.mode; }
  } catch { /* static host, or an older server.py without /api/info → probe below */ }
  try {
    const r = await fetch('api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"probe":true}' });
    const j = await r.json();
    if (j && typeof j.ok === 'boolean') { store.mode = 'server'; store.readonly = r.status === 403 && /唯讀/.test(j.error || ''); return store.mode; }
  } catch { /* not JSON → no server */ }
  store.mode = 'local';
  return store.mode;
}

// ---------- local overlay (localStorage) ----------
function entry(path) { try { return JSON.parse(localStorage.getItem(PREFIX + path) || 'null'); } catch { return null; } }
function putEntry(path, e) {
  try { localStorage.setItem(PREFIX + path, JSON.stringify(e)); }
  catch (err) { throw new Error('瀏覽器儲存空間已滿：' + err.message); }
  listeners.forEach((fn) => fn());
}
function localPaths() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length)); }
  return out.sort();
}
const fmt = (o) => JSON.stringify(o, null, 2);

async function fetchRaw(path) {
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}
async function fetchJSONRaw(path) { try { return JSON.parse(await fetchRaw(path)); } catch { return null; } }

/** read a site file as text (local edits first in local mode) */
export async function readText(path) {
  if (store.local) { const e = entry(path); if (e) { if (e.content == null) throw new Error(`${path}: 已在本機刪除`); return fmt(e.content); } }
  return fetchRaw(path);
}
async function readJSON(path) { try { return JSON.parse(await readText(path)); } catch { return null; } }

/** write a JSON file (server: /api/save · local: localStorage, remembering the version it started from) */
export async function writeJSON(path, content) {
  if (!store.local) {
    const r = await fetch('api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return;
  }
  const e = entry(path);
  const base = e ? e.base : await fetchJSONRaw(path); // first local edit: the site's version is the base
  putEntry(path, { base, content: clone(content), at: Date.now() });
}

/** files changed locally and not yet exported back (content differs from its base) */
export function pendingChanges() {
  if (!store.local) return [];
  return localPaths().filter((p) => { const e = entry(p); return e && canon(e.content) !== canon(e.base); });
}
/** throw away every local edit (back to the published site's version) */
export function clearLocal() {
  for (const p of localPaths()) localStorage.removeItem(PREFIX + p);
  listeners.forEach((fn) => fn());
}

// ---------- bundles ----------
async function dataFiles() {
  const lib = (await readJSON('library.json')) || { plans: [], styles: [] };
  const designFor = (f) => 'designs/' + f.split('/').pop();
  const paths = ['library.json', 'models/catalog.json', ...lib.plans.map((p) => p.file), ...lib.plans.map((p) => designFor(p.file)), ...lib.styles.map((s) => s.file)];
  return [...new Set(paths)];
}

/** server mode → full snapshot (take everything to the office) · local mode → only what changed here */
export async function exportBundle() {
  const files = {};
  if (store.local) {
    for (const p of pendingChanges()) { const e = entry(p); files[p] = { base: e.base, content: e.content }; }
  } else {
    for (const p of await dataFiles()) { const c = await readJSON(p); if (c != null) files[p] = { content: c }; }
  }
  return { format: 'homedesign-bundle', version: 1, kind: store.local ? 'changes' : 'snapshot', createdAt: new Date().toISOString(), files };
}

/** what importing would do, per file: 'new' | 'same' | 'update' (only the bundle changed it) | 'merge' (both sides changed) */
export async function previewImport(bundle) {
  if (bundle?.format !== 'homedesign-bundle' || !bundle.files) throw new Error('不是 HomeDesign 變更包');
  const out = [];
  for (const [path, f] of Object.entries(bundle.files)) {
    if (!/^(designs|plans|styles)\/[\w\-.]+\.json$|^library\.json$|^models\/catalog\.json$/.test(path)) { out.push({ path, status: 'skip' }); continue; }
    const e = store.local ? entry(path) : null;
    const cur = e ? e.content : await readJSON(path);
    const rbase = e ? e.base : cur; // the receiver's own ancestor (server: its current file)
    const anc = 'base' in f ? f.base : rbase;
    let status;
    if (cur == null) status = 'new';
    else if (canon(cur) === canon(f.content)) status = 'same';
    else if (canon(cur) === canon(anc)) status = 'update';
    else status = 'merge';
    out.push({ path, status, merged: cur == null ? f.content : merge3(anc, f.content, cur), incoming: f.content });
  }
  return out;
}

/** apply a bundle (after previewImport). Local mode: the imported version becomes the new base. */
export async function applyImport(plan) {
  let n = 0;
  for (const it of plan) {
    if (it.status === 'skip' || it.status === 'same') continue;
    if (store.local) putEntry(it.path, { base: clone(it.incoming), content: clone(it.merged), at: Date.now() });
    else await writeJSON(it.path, it.merged);
    n++;
  }
  // local mode: a snapshot that matches what we have still resets the base (nothing left to export)
  if (store.local) for (const it of plan) { const e = it.status === 'same' && entry(it.path); if (e) putEntry(it.path, { ...e, base: clone(it.incoming) }); }
  return n;
}
