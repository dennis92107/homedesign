// 格局編輯器：2D 平面圖編輯（牆、門窗、房間、家具位置），覆蓋在 3D 畫面上。
// 牆/門窗/房間 → 直接改 plans/<檔>.json（模板本身）；家具拖曳 → 寫進客製層（與「家具」分頁一致）。
import { polygonArea, centroid } from './builder.js';
import { TYPE_LABELS, setFurniturePatch } from './design.js';
import { DEFAULT_SIZES } from './furniture.js';

const NS = 'http://www.w3.org/2000/svg';
const ROOM_TYPES = [['living', '客廳'], ['dining', '餐廳'], ['kitchen', '廚房'], ['bedroom', '臥室'], ['bathroom', '衛浴'], ['study', '書房'], ['entry', '玄關'], ['corridor', '走道'], ['balcony', '陽台'], ['storage', '儲藏室']];
const ROOM_FILL = { living: '#f4dcc0', dining: '#f6e6c8', kitchen: '#e5ecd2', bedroom: '#dfe6f2', bathroom: '#d6ecef', study: '#e9e0f2', entry: '#efe7dc', corridor: '#eeeeea', balcony: '#e3eee3', storage: '#ececec' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r5 = (v) => Math.round(v / 5) * 5;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function createPlanEditor(api) {
  const { state } = api;
  const host = document.querySelector('#planEditor');
  const root = document.querySelector('#planRoot');
  host.innerHTML = `<svg id="peSvg" xmlns="${NS}"></svg>
    <div class="pe-tools">
      <button data-tool="select" title="選取 / 拖曳（V）">↖ 選取</button>
      <button data-tool="wall" title="畫牆：點起點、點終點，可連續畫；Esc 結束（W）">▭ 畫牆</button>
      <button data-tool="door" title="在牆上點一下加門（D）">🚪 門</button>
      <button data-tool="window" title="在牆上點一下加窗（N）">🪟 窗</button>
      <button data-tool="room" title="依序點房間角點，點回第一點完成（R）">⬠ 房間</button>
      <span class="sep"></span>
      <button data-act="undo" title="復原（Ctrl+Z）">↶</button><button data-act="redo" title="重做（Ctrl+Y）">↷</button>
      <button data-act="fit" title="縮放到全圖">⤢</button>
      <label class="pe-chk"><input type="checkbox" data-act="underlay" checked> 原圖</label>
      <label class="pe-chk"><input type="checkbox" data-act="furn" checked> 家具</label>
      <button data-act="close" class="pe-close" title="回到 3D">看 3D ▸</button>
    </div>
    <div class="pe-hint"></div>`;
  const svg = host.querySelector('#peSvg');
  let tool = 'select', sel = null, drag = null, draft = null, hover = null;
  let view = null; // {x,y,w,h} viewBox in cm
  let showUnderlay = true, showFurn = true, visible = false;
  const undoStack = [], redoStack = [];

  // ---------- helpers ----------
  const plan = () => state.plan;
  const tOf = (w) => w.thickness || (w.exterior ? plan().exteriorThickness || 20 : plan().wallThickness || 12);
  const wallLen = (w) => dist(w.a, w.b);
  const items = () => state.eff?.plan.furniture || [];
  function toPlan(ev) {
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [pt.x, pt.y];
  }
  const pxToCm = () => (view ? view.w / Math.max(1, svg.clientWidth) : 1);
  function allPoints(except) {
    const pts = [];
    plan().walls.forEach((w, i) => { if (except?.wall !== i) pts.push(w.a, w.b); });
    plan().rooms.forEach((r, i) => r.polygon.forEach((p, j) => { if (!(except?.room === i && except?.v === j)) pts.push(p); }));
    return pts;
  }
  /** snap to nearby corners, else to a 5 cm grid; optionally keep orthogonal to an anchor point */
  function snap(p, { anchor, except, ortho = true } = {}) {
    const tol = 12 * pxToCm();
    let best = null, bd = tol;
    for (const q of allPoints(except)) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
    if (best) return [best[0], best[1]];
    let out = [r5(p[0]), r5(p[1])];
    if (anchor && ortho) {
      const dx = Math.abs(out[0] - anchor[0]), dy = Math.abs(out[1] - anchor[1]);
      if (dx < dy * 0.2) out[0] = anchor[0]; else if (dy < dx * 0.2) out[1] = anchor[1];
    }
    // align with any existing corner on one axis
    const atol = 8 * pxToCm();
    for (const q of allPoints(except)) { if (Math.abs(q[0] - out[0]) < atol) out[0] = q[0]; if (Math.abs(q[1] - out[1]) < atol) out[1] = q[1]; }
    return out;
  }
  function projectOnWall(w, p) {
    const [ax, ay] = w.a, [bx, by] = w.b; const L = wallLen(w) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const s = (p[0] - ax) * ux + (p[1] - ay) * uy;
    const d = Math.abs(-(p[0] - ax) * uy + (p[1] - ay) * ux);
    return { s, d, L, ux, uy };
  }
  function nearestWall(p, maxD = 25 * pxToCm()) {
    let best = null;
    plan().walls.forEach((w, i) => {
      if (w.railing) return;
      const pr = projectOnWall(w, p);
      if (pr.s < 0 || pr.s > pr.L) return;
      if (pr.d <= Math.max(maxD, tOf(w) / 2 + 5) && (!best || pr.d < best.d)) best = { i, ...pr };
    });
    return best;
  }

  // ---------- history ----------
  function snapshot() {
    undoStack.push(JSON.stringify({ plan: state.plan, design: state.design }));
    if (undoStack.length > 120) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(json, into) {
    into.push(JSON.stringify({ plan: state.plan, design: state.design }));
    const s = JSON.parse(json);
    Object.keys(state.plan).forEach((k) => delete state.plan[k]); Object.assign(state.plan, s.plan);
    const designChanged = JSON.stringify(state.design) !== JSON.stringify(s.design);
    if (designChanged) api.commit((d) => { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, s.design); }, { rebuild: false });
    sel = null; api.planChanged(); render(); renderProps();
  }
  const undo = () => { if (undoStack.length) restore(undoStack.pop(), redoStack); };
  const redo = () => { if (redoStack.length) restore(redoStack.pop(), undoStack); };
  /** mutate plan structure */
  function edit(fn, { history = true } = {}) { if (history) snapshot(); fn(plan()); api.planChanged(); render(); renderProps(); }

  // structural operations that keep opening → wall indices consistent
  function deleteWall(i) {
    const p = plan();
    p.walls.splice(i, 1);
    p.openings = (p.openings || []).filter((o) => o.wall !== i).map((o) => (o.wall > i ? { ...o, wall: o.wall - 1 } : o));
  }
  function splitWall(i, s) {
    const p = plan(); const w = p.walls[i]; const L = wallLen(w);
    const m = [r5(w.a[0] + (w.b[0] - w.a[0]) * (s / L)), r5(w.a[1] + (w.b[1] - w.a[1]) * (s / L))];
    const nw = { ...JSON.parse(JSON.stringify(w)), a: m, b: [...w.b] };
    w.b = [...m];
    p.walls.push(nw); const ni = p.walls.length - 1;
    for (const o of p.openings || []) if (o.wall === i && o.at > s) { o.wall = ni; o.at = Math.round(o.at - s); }
  }
  /** every wall endpoint / room vertex sitting on `pt` (captured once at drag start, so junctions stay connected
   *  without grabbing corners we snap onto later) */
  function refsAt(pt) {
    const p = plan(); const refs = [];
    for (const w of p.walls) for (const k of ['a', 'b']) if (dist(w[k], pt) < 1.5) refs.push((q) => { w[k] = [q[0], q[1]]; });
    for (const r of p.rooms) r.polygon.forEach((q0, j) => { if (dist(q0, pt) < 1.5) refs.push((q) => { r.polygon[j] = [q[0], q[1]]; }); });
    return refs;
  }
  const applyRefs = (refs, q) => refs.forEach((f) => f(q));
  function movePoint(from, to, only) {
    const p = plan();
    for (const w of p.walls) for (const k of ['a', 'b']) if (dist(w[k], from) < 1.5 && (!only || only.has(w))) { w[k] = [to[0], to[1]]; }
    if (!only) for (const r of p.rooms) r.polygon.forEach((q, j) => { if (dist(q, from) < 1.5) r.polygon[j] = [to[0], to[1]]; });
  }
  function clampOpenings(i) {
    const w = plan().walls[i]; const L = wallLen(w);
    for (const o of plan().openings || []) if (o.wall === i) o.at = Math.round(Math.max(o.width / 2, Math.min(L - o.width / 2, o.at)));
  }

  // ---------- rendering ----------
  function fit() {
    const p = plan(); if (!p) return;
    const xs = [], ys = [];
    p.walls.forEach((w) => { xs.push(w.a[0], w.b[0]); ys.push(w.a[1], w.b[1]); });
    p.rooms.forEach((r) => r.polygon.forEach(([x, y]) => { xs.push(x); ys.push(y); }));
    if (!xs.length) { view = { x: -100, y: -100, w: 1200, h: 900 }; return; }
    const pad = 120;
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - Math.min(...xs) + pad * 2, h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    const ar = (svg.clientWidth || 800) / (svg.clientHeight || 600);
    view = w / h > ar ? { x: x0, y: y0 - (w / ar - h) / 2, w, h: w / ar } : { x: x0 - (h * ar - w) / 2, y: y0, w: h * ar, h };
  }
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); parent?.appendChild(e); return e; };

  function render() {
    if (!visible || !plan()) return;
    if (!view) fit();
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    svg.innerHTML = '';
    const k = pxToCm();
    const p = plan();
    // grid
    const g0 = el('g', { class: 'pe-grid' }, svg);
    const step = view.w > 3000 ? 100 : 50;
    for (let x = Math.floor(view.x / step) * step; x < view.x + view.w; x += step) el('line', { x1: x, y1: view.y, x2: x, y2: view.y + view.h, 'stroke-width': x % 100 ? 0.4 * k : 0.9 * k }, g0);
    for (let y = Math.floor(view.y / step) * step; y < view.y + view.h; y += step) el('line', { x1: view.x, y1: y, x2: view.x + view.w, y2: y, 'stroke-width': y % 100 ? 0.4 * k : 0.9 * k }, g0);
    if (showUnderlay && p.underlay?.image) el('image', { href: p.underlay.image, x: p.underlay.x || 0, y: p.underlay.y || 0, width: p.underlay.width, height: p.underlay.height, opacity: 0.45, preserveAspectRatio: 'none' }, svg);
    // rooms
    const gr = el('g', {}, svg);
    p.rooms.forEach((r, i) => {
      const isSel = sel?.kind === 'room' && sel.i === i;
      el('polygon', { points: r.polygon.map((q) => q.join(',')).join(' '), fill: ROOM_FILL[r.type] || '#eee', 'fill-opacity': showUnderlay ? 0.45 : 0.85, stroke: isSel ? '#e8692e' : 'none', 'stroke-width': 3 * k, 'data-room': i, class: 'pe-room' }, gr);
    });
    // walls
    const gw = el('g', {}, svg);
    p.walls.forEach((w, i) => {
      const isSel = sel?.kind === 'wall' && sel.i === i;
      el('line', { x1: w.a[0], y1: w.a[1], x2: w.b[0], y2: w.b[1], stroke: isSel ? '#e8692e' : w.railing ? '#6aa0b8' : w.exterior ? '#2b2b2b' : '#555', 'stroke-width': w.railing ? Math.max(4, tOf(w)) : tOf(w), 'stroke-linecap': 'square', 'stroke-dasharray': w.railing ? `${10} ${6}` : null, 'data-wall': i, class: 'pe-wall' }, gw);
    });
    // openings
    const go = el('g', {}, svg);
    (p.openings || []).forEach((o, i) => {
      const w = p.walls[o.wall]; if (!w) return;
      const L = wallLen(w) || 1; const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L; const nx = -uy, ny = ux;
      const s = o.at - o.width / 2, e = o.at + o.width / 2;
      const A = [w.a[0] + ux * s, w.a[1] + uy * s], B = [w.a[0] + ux * e, w.a[1] + uy * e];
      const isSel = sel?.kind === 'opening' && sel.i === i;
      const g = el('g', { 'data-opening': i, class: 'pe-opening' }, go);
      el('line', { x1: A[0], y1: A[1], x2: B[0], y2: B[1], stroke: '#fff', 'stroke-width': tOf(w) + 1 }, g);
      if (o.type === 'door') {
        const hinge = o.hinge === 'end' ? B : A, other = o.hinge === 'end' ? A : B;
        const sw = o.swing === 'out' ? -1 : 1;
        const tip = [hinge[0] + nx * sw * o.width, hinge[1] + ny * sw * o.width];
        el('line', { x1: hinge[0], y1: hinge[1], x2: tip[0], y2: tip[1], stroke: isSel ? '#e8692e' : '#4a7', 'stroke-width': 3 * k }, g);
        const sweep = ((o.hinge === 'end') !== (sw > 0)) ? 1 : 0;
        el('path', { d: `M ${tip[0]} ${tip[1]} A ${o.width} ${o.width} 0 0 ${sweep} ${other[0]} ${other[1]}`, fill: 'none', stroke: isSel ? '#e8692e' : '#4a7', 'stroke-width': 1.5 * k, 'stroke-dasharray': `${4 * k} ${3 * k}` }, g);
      } else {
        for (const off of [-tOf(w) / 4, tOf(w) / 4]) el('line', { x1: A[0] + nx * off, y1: A[1] + ny * off, x2: B[0] + nx * off, y2: B[1] + ny * off, stroke: isSel ? '#e8692e' : '#3b82c4', 'stroke-width': 2 * k }, g);
      }
      el('line', { x1: A[0], y1: A[1], x2: B[0], y2: B[1], stroke: 'transparent', 'stroke-width': Math.max(tOf(w), 14 * k) }, g); // hit area
    });
    // furniture
    if (showFurn) {
      const gf = el('g', {}, svg);
      for (const it of items()) {
        const [dw, dd] = DEFAULT_SIZES[it.type] || [60, 60];
        const w = it.w ?? dw, d = it.d ?? dd;
        const isSel = sel?.kind === 'furn' && sel.id === it.id;
        const g = el('g', { transform: `translate(${it.x} ${it.y}) rotate(${it.rotation || 0})`, 'data-furn': it.id, class: 'pe-furn' + (it.hidden ? ' hidden' : '') }, gf);
        el('rect', { x: -w / 2, y: -d / 2, width: w, height: d, rx: 3, fill: isSel ? '#ffe2cf' : '#ffffffcc', stroke: isSel ? '#e8692e' : '#8a8178', 'stroke-width': (isSel ? 2.5 : 1.2) * k }, g);
        el('line', { x1: -w / 2 + 4, y1: d / 2 - 3 * k, x2: w / 2 - 4, y2: d / 2 - 3 * k, stroke: '#c96f4a', 'stroke-width': 2 * k }, g); // front edge
        if (Math.min(w, d) > 30) { const t = el('text', { x: 0, y: 4 * k, 'font-size': 11 * k, 'text-anchor': 'middle', transform: `rotate(${-(it.rotation || 0)})`, class: 'pe-ftext' }, g); t.textContent = TYPE_LABELS[it.type] || it.type; }
      }
    }
    // room labels
    p.rooms.forEach((r, i) => {
      const [cx, cy] = centroid(r.polygon); const a = polygonArea(r.polygon) / 1e4;
      const t = el('text', { x: cx, y: cy, 'font-size': 14 * k, 'text-anchor': 'middle', class: 'pe-rtext', 'data-room': i }, svg);
      t.textContent = `${r.name} ${(a / 3.3058).toFixed(1)}坪`;
    });
    // handles
    const gh = el('g', {}, svg);
    if (sel?.kind === 'wall' && p.walls[sel.i]) for (const end of ['a', 'b']) { const q = p.walls[sel.i][end]; el('circle', { cx: q[0], cy: q[1], r: 6 * k, class: 'pe-handle', 'data-handle': end }, gh); }
    if (sel?.kind === 'room' && p.rooms[sel.i]) p.rooms[sel.i].polygon.forEach((q, j) => el('circle', { cx: q[0], cy: q[1], r: 5.5 * k, class: 'pe-handle' + (sel.v === j ? ' on' : ''), 'data-vertex': j }, gh));
    if (sel?.kind === 'furn') {
      const it = items().find((x) => x.id === sel.id);
      if (it) { const [dw, dd] = DEFAULT_SIZES[it.type] || [60, 60]; const d = it.d ?? dd; const a = ((it.rotation || 0) * Math.PI) / 180; const hx = it.x - Math.sin(a) * (d / 2 + 18 * k) * -1, hy = it.y + Math.cos(a) * (d / 2 + 18 * k) * -1; el('circle', { cx: hx, cy: hy, r: 6 * k, class: 'pe-handle rot', 'data-rot': 1 }, gh); void dw; }
    }
    // drafts
    if (draft?.kind === 'wall' && draft.a && draft.cur) el('line', { x1: draft.a[0], y1: draft.a[1], x2: draft.cur[0], y2: draft.cur[1], stroke: '#e8692e', 'stroke-width': plan().wallThickness || 12, 'stroke-opacity': 0.6 }, svg);
    if (draft?.kind === 'room' && draft.pts.length) el('polyline', { points: [...draft.pts, draft.cur || draft.pts.at(-1)].map((q) => q.join(',')).join(' '), fill: '#e8692e22', stroke: '#e8692e', 'stroke-width': 2 * k }, svg);
    if (draft?.cur && tool !== 'select') el('circle', { cx: draft.cur[0], cy: draft.cur[1], r: 4 * k, fill: '#e8692e' }, svg);
    if (hover && (tool === 'door' || tool === 'window')) {
      const w = p.walls[hover.i]; const s = Math.max(45, Math.min(hover.L - 45, hover.s));
      el('circle', { cx: w.a[0] + hover.ux * s, cy: w.a[1] + hover.uy * s, r: 7 * k, fill: tool === 'door' ? '#4a7' : '#3b82c4' }, svg);
    }
    host.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    host.querySelector('.pe-hint').textContent = {
      select: '點選牆、門窗、房間或家具；拖曳移動。牆端點/房間角點可拖；雙擊房間邊加角點。Delete 刪除，R 旋轉家具。滾輪縮放，拖曳空白處平移。',
      wall: '點起點 → 點終點畫牆（會吸附角點與水平/垂直），可連續畫；Esc 或右鍵結束。',
      door: '在牆上點一下加門。', window: '在牆上點一下加窗。',
      room: '依序點房間角點，點回第一點（或雙擊）完成。Esc 取消。',
    }[tool];
  }

  // ---------- properties (sidebar) ----------
  function field(label, inner) { return `<div class="field"><span>${label}</span><div>${inner}</div></div>`; }
  function renderProps() {
    if (!root || !plan()) return;
    const p = plan();
    let html = `<p class="hint">這裡修改的是<b>平面圖模板本身</b>（<code>${esc(state.planUrl)}</code>），會自動存檔；畫面右上「看 3D」可切回立體檢視。需要保留原版時先按「另存為新平面圖」。</p>
      <div class="row-actions"><button data-p="saveas">另存為新平面圖</button><button data-p="toggle">${visible ? '看 3D' : '開啟 2D 編輯'}</button></div>
      <div class="row-actions small"><button data-p="undo" ${undoStack.length ? '' : 'disabled'}>↶ 復原（${undoStack.length}）</button><button data-p="redo" ${redoStack.length ? '' : 'disabled'}>↷ 重做</button></div>`;
    html += '<div class="card">';
    if (sel?.kind === 'wall' && p.walls[sel.i]) {
      const w = p.walls[sel.i];
      html += `<div class="row"><b>牆 #${sel.i}</b><span class="sub">${w.note ? esc(w.note) : ''}</span></div>
        ${field('長度', `<input type="number" data-w="len" value="${Math.round(wallLen(w))}"> cm`)}
        ${field('厚度', `<input type="number" data-w="thickness" value="${tOf(w)}"> cm`)}
        ${field('高度', `<input type="number" data-w="height" value="${w.height ?? ''}" placeholder="全高"> cm`)}
        ${field('類型', `<label class="inline"><input type="checkbox" data-w="exterior" ${w.exterior ? 'checked' : ''}> 外牆</label> <label class="inline"><input type="checkbox" data-w="railing" ${w.railing ? 'checked' : ''}> 陽台欄杆</label>`)}
        <div class="row-actions small"><button data-p="split">從中間拆成兩段</button><button data-p="del">刪除牆</button></div>
        <div class="sub">拖曳牆身＝平移整面牆（相連的牆與房間跟著調整）；拖曳端點＝改長度/角度。</div>`;
    } else if (sel?.kind === 'opening' && p.openings[sel.i]) {
      const o = p.openings[sel.i];
      html += `<div class="row"><b>${o.type === 'door' ? '門' : '窗'} #${sel.i}</b><span class="sub">在牆 #${o.wall}</span></div>
        ${field('類型', `<select data-o="type"><option value="door" ${o.type === 'door' ? 'selected' : ''}>門</option><option value="window" ${o.type === 'window' ? 'selected' : ''}>窗</option></select>`)}
        ${field('寬', `<input type="number" data-o="width" value="${o.width}"> cm`)}
        ${field('高', `<input type="number" data-o="height" value="${o.height ?? (o.type === 'door' ? 210 : 130)}"> cm`)}
        ${o.type === 'window' ? field('窗台高', `<input type="number" data-o="sill" value="${o.sill ?? 90}"> cm`) + field('落地門窗', `<label class="inline"><input type="checkbox" data-o="walkable" ${o.walkable ? 'checked' : ''}> 可走過（漫遊）</label>`) : ''}
        ${o.type === 'door' ? field('鉸鏈', `<select data-o="hinge"><option value="start">起點側</option><option value="end" ${o.hinge === 'end' ? 'selected' : ''}>終點側</option></select>`) + field('開門方向', `<button data-p="flip">翻轉開向</button>`) + field('開啟角度', `<input type="number" data-o="open" value="${o.open ?? 80}">°`) : ''}
        <div class="row-actions small"><button data-p="del">刪除</button></div><div class="sub">沿著牆拖曳可移動位置。</div>`;
    } else if (sel?.kind === 'room' && p.rooms[sel.i]) {
      const r = p.rooms[sel.i]; const a = polygonArea(r.polygon) / 1e4;
      html += `<div class="row"><b>房間</b><span class="sub">${a.toFixed(1)} m² · ${(a / 3.3058).toFixed(2)} 坪</span></div>
        ${field('名稱', `<input type="text" data-r="name" value="${esc(r.name)}">`)}
        ${field('類型', `<select data-r="type">${ROOM_TYPES.map(([k, l]) => `<option value="${k}" ${r.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
        <div class="sub">類型決定套用哪組樣板材質（例如衛浴用磁磚）。拖曳角點改形狀，雙擊邊加角點${sel.v != null ? '，Delete 刪除選取的角點' : ''}。</div>
        <div class="row-actions small"><button data-p="del">刪除房間</button></div>`;
    } else if (sel?.kind === 'furn') {
      const it = items().find((x) => x.id === sel.id);
      html += it ? `<div class="row"><b>${esc(TYPE_LABELS[it.type] || it.type)}</b><span class="sub">${esc(it.id)}</span></div>
        <div class="sub">拖曳移動、拖橘色圓點旋轉（按 Shift 不吸附 15°），或按 R 轉 90°。位置存在客製層，與「家具」分頁同步。</div>
        <div class="row-actions small"><button data-p="rot">轉 90°</button><button data-p="furnTab">到家具分頁編輯</button></div>` : '';
    } else {
      html += `<b>平面圖設定</b>
        ${field('名稱', `<input type="text" data-pl="name" value="${esc(p.name)}">`)}
        ${field('樓高', `<input type="number" data-pl="wallHeight" value="${p.wallHeight || 280}"> cm`)}
        ${field('內牆厚', `<input type="number" data-pl="wallThickness" value="${p.wallThickness || 12}"> cm`)}
        ${field('外牆厚', `<input type="number" data-pl="exteriorThickness" value="${p.exteriorThickness || 20}"> cm`)}
        <div class="sub">牆 ${p.walls.length} · 門窗 ${(p.openings || []).length} · 房間 ${p.rooms.length}。選工具列「畫牆 / 門 / 窗 / 房間」新增，或點選既有物件修改。</div>`;
    }
    html += '</div>';
    root.innerHTML = html;
    bindProps();
  }
  function bindProps() {
    const p = plan();
    const on = (sel_, ev, fn) => root.querySelectorAll(sel_).forEach((e) => e.addEventListener(ev, () => fn(e)));
    on('[data-p=saveas]', 'click', async () => { const name = prompt('新平面圖名稱', `${p.name}（修改版）`); if (name) { try { await api.savePlanAs(name); undoStack.length = redoStack.length = 0; sel = null; fit(); render(); renderProps(); } catch (e) { alert('儲存失敗：' + e.message); } } });
    on('[data-p=toggle]', 'click', () => (visible ? hide() : show()));
    on('[data-p=undo]', 'click', undo); on('[data-p=redo]', 'click', redo);
    on('[data-p=del]', 'click', () => deleteSelection());
    on('[data-p=split]', 'click', () => edit(() => splitWall(sel.i, wallLen(p.walls[sel.i]) / 2)));
    on('[data-p=flip]', 'click', () => edit(() => { const o = p.openings[sel.i]; o.swing = o.swing === 'out' ? 'in' : 'out'; }));
    on('[data-p=rot]', 'click', () => rotateFurn(90));
    on('[data-p=furnTab]', 'click', () => { const id = sel.id; hide(); api.selectFurniture(id); });
    on('[data-w]', 'change', (e) => edit(() => {
      const w = p.walls[sel.i]; const k = e.dataset.w;
      if (k === 'len') { const L = wallLen(w), nl = Math.max(10, +e.value); const nb = [r5(w.a[0] + (w.b[0] - w.a[0]) * nl / L), r5(w.a[1] + (w.b[1] - w.a[1]) * nl / L)]; movePoint(w.b, nb, new Set([w])); w.b = nb; clampOpenings(sel.i); }
      else if (e.type === 'checkbox') { if (e.checked) w[k] = true; else delete w[k]; if (k === 'railing' && e.checked) { w.height ??= 110; w.thickness ??= 8; } }
      else if (e.value === '') delete w[k]; else w[k] = +e.value;
    }));
    on('[data-o]', 'change', (e) => edit(() => {
      const o = p.openings[sel.i]; const k = e.dataset.o;
      if (e.type === 'checkbox') { if (e.checked) o[k] = true; else delete o[k]; }
      else if (k === 'type' || k === 'hinge') { o[k] = e.value; if (k === 'type' && e.value === 'window') { o.sill ??= 90; o.height = o.height === 210 ? 130 : o.height; } if (k === 'type' && e.value === 'door') { o.sill = 0; o.height = 210; } }
      else o[k] = +e.value;
      clampOpenings(o.wall);
    }));
    on('[data-r]', 'change', (e) => edit(() => { p.rooms[sel.i][e.dataset.r] = e.value; }));
    on('[data-pl]', 'change', (e) => edit(() => { const k = e.dataset.pl; p[k] = k === 'name' ? e.value : +e.value; }));
  }

  // ---------- operations ----------
  function deleteSelection() {
    if (!sel) return;
    const p = plan();
    if (sel.kind === 'wall') edit(() => deleteWall(sel.i));
    else if (sel.kind === 'opening') edit(() => p.openings.splice(sel.i, 1));
    else if (sel.kind === 'room') {
      if (sel.v != null && p.rooms[sel.i].polygon.length > 3) { edit(() => p.rooms[sel.i].polygon.splice(sel.v, 1)); sel.v = null; return render(); }
      edit(() => p.rooms.splice(sel.i, 1));
    } else if (sel.kind === 'furn') { snapshot(); const id = sel.id; const it = items().find((x) => x.id === id); api.commit((d) => { if (it?.origin === 'added') d.added = d.added.filter((x) => x.id !== id); else (d.furniture[id] ||= {}).removed = true; }); }
    sel = null; render(); renderProps();
  }
  function setFurn(id, patch, { history = true } = {}) {
    if (history) snapshot();
    const it = items().find((x) => x.id === id);
    api.commit((d) => setFurniturePatch(d, id, patch));
    if (it) Object.assign(it, patch);
  }
  function rotateFurn(deg) {
    const it = items().find((x) => x.id === sel?.id); if (!it) return;
    setFurn(it.id, { rotation: (((it.rotation || 0) + deg) % 360 + 360) % 360 }); render();
  }

  // ---------- pointer interaction ----------
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = toPlan(e); const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    view = { x: px - (px - view.x) * f, y: py - (py - view.y) * f, w: view.w * f, h: view.h * f };
    render();
  }, { passive: false });

  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) { finishDraft(); return; }
    const p = plan(); const pt = toPlan(e); const t = e.target;
    svg.setPointerCapture(e.pointerId);
    if (tool === 'wall') {
      const q = snap(pt, { anchor: draft?.a });
      if (!draft?.a) draft = { kind: 'wall', a: q, cur: q };
      else if (dist(draft.a, q) > 5) {
        snapshot();
        p.walls.push({ a: draft.a, b: q });
        // split existing walls where the new wall's ends land on them (T-junctions)
        api.planChanged(); draft = { kind: 'wall', a: q, cur: q }; renderProps();
      }
      return render();
    }
    if (tool === 'door' || tool === 'window') {
      const nw = nearestWall(pt);
      if (nw) {
        const width = tool === 'door' ? 90 : 120;
        edit((pl) => { (pl.openings ||= []).push(tool === 'door' ? { type: 'door', wall: nw.i, at: Math.round(Math.max(width / 2, Math.min(nw.L - width / 2, nw.s))), width, height: 210 } : { type: 'window', wall: nw.i, at: Math.round(Math.max(width / 2, Math.min(nw.L - width / 2, nw.s))), width, sill: 90, height: 130 }); });
        sel = { kind: 'opening', i: p.openings.length - 1 }; tool = 'select'; render(); renderProps();
      }
      return;
    }
    if (tool === 'room') {
      const q = snap(pt, { anchor: draft?.pts?.at(-1) });
      if (!draft) draft = { kind: 'room', pts: [q], cur: q };
      else if (draft.pts.length >= 3 && dist(q, draft.pts[0]) < 15 * pxToCm()) finishDraft();
      else draft.pts.push(q);
      return render();
    }
    // select tool
    const d = t.dataset || {}; const pd = t.parentNode?.dataset || {};
    if (d.handle && sel?.kind === 'wall') { snapshot(); drag = { kind: 'wallEnd', end: d.handle, refs: refsAt(p.walls[sel.i][d.handle]) }; return; }
    if (d.vertex != null && sel?.kind === 'room') { snapshot(); sel.v = +d.vertex; drag = { kind: 'vertex', v: +d.vertex }; render(); renderProps(); return; }
    if (d.rot) { snapshot(); drag = { kind: 'rotate' }; return; }
    const fEl = t.closest?.('[data-furn]');
    if (fEl && showFurn) { const it = items().find((x) => x.id === fEl.dataset.furn); sel = { kind: 'furn', id: it.id }; drag = { kind: 'furn', start: pt, orig: [it.x, it.y], moved: false }; render(); renderProps(); return; }
    const oEl = t.closest?.('[data-opening]');
    if (oEl) { sel = { kind: 'opening', i: +oEl.dataset.opening }; drag = { kind: 'opening', moved: false }; render(); renderProps(); return; }
    if (d.wall != null) { sel = { kind: 'wall', i: +d.wall }; const w = p.walls[sel.i]; drag = { kind: 'wall', start: pt, a: [...w.a], b: [...w.b], refsA: refsAt(w.a), refsB: refsAt(w.b), moved: false }; render(); renderProps(); return; }
    if (d.room != null || pd.room != null) { sel = { kind: 'room', i: +(d.room ?? pd.room), v: null }; drag = { kind: 'room', start: pt, orig: JSON.parse(JSON.stringify(p.rooms[sel.i].polygon)), moved: false }; render(); renderProps(); return; }
    sel = null; drag = { kind: 'pan', start: [e.clientX, e.clientY], view: { ...view } }; render(); renderProps();
  });

  svg.addEventListener('pointermove', (e) => {
    const p = plan(); const pt = toPlan(e);
    if (tool === 'wall' || tool === 'room') { if (draft) { draft.cur = snap(pt, { anchor: draft.a || draft.pts?.at(-1) }); render(); } else { draft = null; } return; }
    if (tool === 'door' || tool === 'window') { hover = nearestWall(pt); render(); return; }
    if (!drag) return;
    const k = pxToCm();
    if (drag.kind === 'pan') {
      const dx = (e.clientX - drag.start[0]) * k, dy = (e.clientY - drag.start[1]) * k;
      view = { ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy }; render(); return;
    }
    if (drag.kind === 'wallEnd') {
      const w = p.walls[sel.i]; const other = drag.end === 'a' ? w.b : w.a;
      const q = snap(pt, { anchor: other, except: { wall: sel.i } });
      applyRefs(drag.refs, q); render(); return;
    }
    if (drag.kind === 'wall') {
      // move the whole wall along its normal; connected walls/rooms follow
      const w = p.walls[sel.i]; const L = dist(drag.a, drag.b) || 1;
      const nx = -(drag.b[1] - drag.a[1]) / L, ny = (drag.b[0] - drag.a[0]) / L;
      const off = r5((pt[0] - drag.start[0]) * nx + (pt[1] - drag.start[1]) * ny);
      const na = [drag.a[0] + nx * off, drag.a[1] + ny * off].map((v) => Math.round(v)), nb = [drag.b[0] + nx * off, drag.b[1] + ny * off].map((v) => Math.round(v));
      if (!drag.moved && off) { snapshot(); drag.moved = true; }
      applyRefs(drag.refsA, na); applyRefs(drag.refsB, nb); void w; render(); return;
    }
    if (drag.kind === 'vertex') { const r = p.rooms[sel.i]; r.polygon[drag.v] = snap(pt, { except: { room: sel.i, v: drag.v } }); render(); return; }
    if (drag.kind === 'room') {
      const dx = r5(pt[0] - drag.start[0]), dy = r5(pt[1] - drag.start[1]);
      if (!drag.moved && (dx || dy)) { snapshot(); drag.moved = true; }
      p.rooms[sel.i].polygon = drag.orig.map(([x, y]) => [x + dx, y + dy]); render(); return;
    }
    if (drag.kind === 'opening') {
      const o = p.openings[sel.i]; const w = p.walls[o.wall]; const pr = projectOnWall(w, pt);
      if (!drag.moved) { snapshot(); drag.moved = true; }
      o.at = Math.round(Math.max(o.width / 2, Math.min(pr.L - o.width / 2, r5(pr.s)))); render(); return;
    }
    if (drag.kind === 'furn') {
      const it = items().find((x) => x.id === sel.id);
      const nx = r5(drag.orig[0] + pt[0] - drag.start[0]), ny = r5(drag.orig[1] + pt[1] - drag.start[1]);
      if (Math.abs(nx - drag.orig[0]) + Math.abs(ny - drag.orig[1]) > 0) drag.moved = true;
      it.x = nx; it.y = ny; render(); return;
    }
    if (drag.kind === 'rotate') {
      const it = items().find((x) => x.id === sel.id);
      // rotation convention: 0 = front faces +y; angle measured clockwise in the drawing
      let deg = (Math.atan2(-(pt[0] - it.x), pt[1] - it.y) * 180) / Math.PI; // direction the front should face
      deg = ((deg + 180) % 360 + 360) % 360; // handle sits behind the front edge
      if (!e.shiftKey) deg = Math.round(deg / 15) * 15;
      it.rotation = deg % 360; drag.moved = true; render();
    }
  });

  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    const p = plan(); const d = drag; drag = null;
    if (d.kind === 'wallEnd' || (d.kind === 'wall' && d.moved) || d.kind === 'vertex' || (d.kind === 'room' && d.moved)) {
      if (sel?.kind === 'wall') clampOpenings(sel.i);
      api.planChanged(); renderProps();
    }
    if (d.kind === 'opening' && d.moved) api.planChanged();
    if ((d.kind === 'furn' || d.kind === 'rotate') && d.moved) {
      const it = items().find((x) => x.id === sel.id);
      if (d.kind === 'furn') setFurn(it.id, { x: it.x, y: it.y }, { history: true }); else setFurn(it.id, { rotation: it.rotation }, { history: false });
    }
    void p;
  });
  svg.addEventListener('dblclick', (e) => {
    if (tool === 'room' && draft?.pts?.length >= 3) { finishDraft(); return; }
    if (tool !== 'select' || sel?.kind !== 'room') return;
    // insert a vertex on the nearest edge of the selected room
    const p = plan(); const r = p.rooms[sel.i]; const pt = snap(toPlan(e));
    let best = 0, bd = Infinity;
    r.polygon.forEach((a, j) => { const b = r.polygon[(j + 1) % r.polygon.length]; const L = dist(a, b) || 1; const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * (b[0] - a[0]) + (pt[1] - a[1]) * (b[1] - a[1])) / (L * L))); const dd = dist(pt, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); if (dd < bd) { bd = dd; best = j; } });
    edit(() => r.polygon.splice(best + 1, 0, pt)); sel.v = best + 1; render();
  });
  svg.addEventListener('contextmenu', (e) => e.preventDefault());

  function finishDraft() {
    if (draft?.kind === 'room' && draft.pts.length >= 3) {
      edit((pl) => pl.rooms.push({ name: `房間 ${pl.rooms.length + 1}`, type: 'bedroom', polygon: draft.pts }));
      sel = { kind: 'room', i: plan().rooms.length - 1, v: null };
      tool = 'select';
    }
    if (draft?.kind === 'wall') { api.planChanged(); }
    draft = null; render(); renderProps();
  }

  addEventListener('keydown', (e) => {
    if (!visible || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 'escape') { if (draft) finishDraft(); else { tool = 'select'; sel = null; render(); renderProps(); } }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); }
    else if (k === 'r' && sel?.kind === 'furn') rotateFurn(90);
    else if (k === 'v') setTool('select'); else if (k === 'w') setTool('wall'); else if (k === 'd') setTool('door'); else if (k === 'n') setTool('window'); else if (k === 'r') setTool('room');
    e.stopPropagation();
  }, true);

  function setTool(t) { if (draft) finishDraft(); tool = t; hover = null; render(); }
  host.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  host.querySelector('[data-act=undo]').onclick = undo;
  host.querySelector('[data-act=redo]').onclick = redo;
  host.querySelector('[data-act=fit]').onclick = () => { fit(); render(); };
  host.querySelector('[data-act=close]').onclick = () => hide();
  host.querySelector('[data-act=underlay]').onchange = (e) => { showUnderlay = e.target.checked; render(); };
  host.querySelector('[data-act=furn]').onchange = (e) => { showFurn = e.target.checked; render(); };
  new ResizeObserver(() => { if (visible) { const old = view; fit(); if (old) view = { ...view, x: old.x, y: old.y, w: old.w, h: old.w * (view.h / view.w) }; render(); } }).observe(host);

  function show() { visible = true; host.hidden = false; document.body.classList.add('plan-editing'); if (!view) requestAnimationFrame(() => { fit(); render(); }); render(); renderProps(); }
  function hide() { visible = false; host.hidden = true; document.body.classList.remove('plan-editing'); if (draft) finishDraft(); renderProps(); }
  function refresh() { if (!visible) { renderProps(); return; } if (drag) return; render(); renderProps(); }
  function resetView() { view = null; undoStack.length = redoStack.length = 0; sel = null; }
  return { show, hide, refresh, resetView, get visible() { return visible; } };
}
