// 側欄編輯器：「客製材質」與「家具」兩個分頁。
// 所有修改都寫進設計層 state.design（designs/<plan>.json），樣板 styles/*.json 永遠不被改動。
import {
  getPath, setPath, deletePath, isObj, TYPE_LABELS, CATEGORIES, categoryOf, ROLE_LABELS, SURFACE_TYPES, removedItems,
} from './design.js';
import { pointInPoly, centroid } from './builder.js';
import { modelsForType, modelEntry, modelDetails, pickDefault, pickSpec } from './assets.js';
import { DEFAULT_SIZES } from './furniture.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toHex = (c, fb = '#cccccc') => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? (c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c.slice(0, 7)) : fb);
const normSpec = (v, fb = 'paint') => (typeof v === 'string' ? { material: fb, color: v } : isObj(v) ? { ...v } : { material: fb, color: '#cccccc' });
const EDITABLE_ROLES = ['fabric', 'fabricAlt', 'leather', 'wood', 'woodDark', 'metal', 'accent', 'white', 'stone', 'cabinet', 'countertop', 'ceramic', 'mattress', 'bedding', 'pot', 'plant', 'lampshade', 'mirror'];
const VARIANTS = {
  legs: { label: '椅腳/底座', options: [['tapered', '錐形木腳'], ['metal', '細金屬腳'], ['hairpin', '髮夾腳'], ['block', '方木腳'], ['plinth', '落地底座'], ['none', '無']] },
  sofa: { label: '沙發造型', options: [['boxy', '方正'], ['rounded', '圓潤']] },
  sofaMaterial: { label: '沙發面料', options: [['fabric', '布'], ['leather', '皮革']] },
  chair: { label: '椅子造型', options: [['spindle', '溫莎直條'], ['solid', '實木板'], ['upholstered', '軟包']] },
  bed: { label: '床型', options: [['legs', '有腳床架'], ['platform', '低台式'], ['upholstered', '軟包床']] },
  tableTop: { label: '桌面', options: [['wood', '木'], ['stone', '石材'], ['glass', '玻璃']] },
  handles: { label: '把手', options: [['metal', '金屬把手'], ['none', '無把手']] },
};
const VARIANTS_BY_TYPE = {
  sofa: ['sofa', 'sofaMaterial', 'legs'], armchair: ['legs'], coffee_table: ['tableTop', 'legs'], side_table: ['tableTop'],
  dining_table: ['tableTop', 'legs', 'chair'], chair: ['chair', 'legs'], desk: ['legs'], bed: ['bed', 'legs'], nightstand: ['legs'],
  tv_cabinet: ['legs'], sideboard: ['legs'], wardrobe: ['handles'],
};

export function createEditor(api) {
  const { state } = api;
  let tab = 'template';
  let partKey = 'g:wall';
  let addOpen = false;

  // ---------- tabs ----------
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  function setTab(t) {
    tab = t;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== t));
    api.onTab?.(t);
    render();
  }

  const effStyle = () => state.eff?.style || state.style || {};
  const tplStyle = () => state.style || {};
  const rooms = () => state.plan?.rooms || [];
  const roomByName = (n) => rooms().find((r) => r.name === n);
  const items = () => state.eff?.plan.furniture || [];
  const roomOfItem = (it) => rooms().find((r) => pointInPoly([it.x, it.y], r.polygon))?.name || '其他';

  // ---------- parts (what can be customised) ----------
  function parts() {
    const P = [];
    const g = (key, label, path, kind, extra = {}) => P.push({ key, label, path, kind, group: '全屋預設', ...extra });
    g('g:wall', '牆面（全屋預設）', ['wall'], 'surface', { surface: 'wall' });
    g('g:floor', '地板（全屋預設）', ['floor'], 'surface', { surface: 'floor' });
    g('g:ceiling', '天花板（全屋預設）', ['ceiling'], 'surface', { surface: 'wall', fallback: () => effStyle().ceiling ?? '#f7f6f3' });
    g('g:exterior', '外牆', ['exteriorWall'], 'surface', { surface: 'wall', fallback: () => effStyle().exteriorWall ?? '#d9d6d0' });
    g('g:door', '門片顏色', ['doors', 'color'], 'color', { fallback: () => '#efebe4' });
    g('g:frame', '窗框/門框顏色', ['windows', 'frameColor'], 'color', { fallback: () => '#ffffff' });
    g('g:baseboard', '踢腳板顏色', ['baseboard'], 'color', { fallback: () => '#f4f2ee' });
    g('g:curtain', '窗簾', ['decor', 'curtains'], 'curtain');
    g('g:rug', '地毯花色', ['decor', 'rug'], 'rug');
    g('g:pendant', '餐桌吊燈', ['decor', 'pendant'], 'enum', { options: [['globe', '球形'], ['saucer', '飛碟'], ['cone', '錐形'], ['linear', '長條'], ['rattan', '藤編'], ['none', '不要吊燈']], fallback: () => 'none' });
    for (const r of rooms()) {
      const grp = `房間・${r.name}`;
      const tW = () => effStyle().rooms?.[r.type]?.wall ?? effStyle().wall;
      P.push({ key: `r:${r.name}:lock`, label: `${r.name}・🔒 鎖定（換樣板不變）`, path: ['rooms', r.name, 'locked'], kind: 'lock', group: grp, room: r });
      P.push({ key: `r:${r.name}:floor`, label: `${r.name}・地板`, path: ['rooms', r.name, 'floor'], kind: 'surface', surface: 'floor', group: grp, fallback: () => effStyle().rooms?.[r.type]?.floor ?? effStyle().floor });
      P.push({ key: `r:${r.name}:wall`, label: `${r.name}・牆面（整間）`, path: ['rooms', r.name, 'wall'], kind: 'surface', surface: 'wall', group: grp, fallback: tW });
      P.push({ key: `r:${r.name}:ceiling`, label: `${r.name}・天花板`, path: ['rooms', r.name, 'ceiling'], kind: 'surface', surface: 'wall', group: grp, fallback: () => effStyle().rooms?.[r.type]?.ceiling ?? effStyle().ceiling ?? '#f7f6f3' });
    }
    const sel = state.selection;
    if (sel?.kind === 'wall') {
      const fk = `${sel.room}|${sel.wall}|${sel.side}`;
      const r = roomByName(sel.room);
      P.push({ key: `f:${fk}`, label: `${sel.room}・選取的這一面牆`, path: ['wallFaces', fk], kind: 'surface', surface: 'wall', group: '選取中', fallback: () => effStyle().rooms?.[sel.room]?.wall ?? effStyle().rooms?.[r?.type]?.wall ?? effStyle().wall });
    }
    for (const role of EDITABLE_ROLES) P.push({ key: `m:${role}`, label: `${ROLE_LABELS[role]}（所有家具）`, path: ['materials', role], kind: 'role', group: '家具共用材質' });
    return P;
  }
  const partValue = (p) => getPath(effStyle(), p.path) ?? p.fallback?.();
  const isCustom = (p) => getPath(state.design.style, p.path) !== undefined;
  const set = (p, v) => api.commit((d) => setPath(d.style, p.path, v));
  const reset = (p) => api.commit((d) => deletePath(d.style, p.path));

  // ---------- render ----------
  function render() {
    if (!state.plan) return;
    if (tab === 'custom') renderCustom();
    if (tab === 'furniture') renderFurniture();
  }

  function renderCustom() {
    const root = $('#customRoot');
    const P = parts();
    if (!P.find((p) => p.key === partKey)) partKey = P[0].key;
    const groups = [...new Set(P.map((p) => p.group))];
    const nCustom = P.filter(isCustom).length + Object.keys(state.design.style?.wallFaces || {}).filter((k) => !P.some((p) => p.key === 'f:' + k)).length;
    root.innerHTML = `
      <p class="hint">樣板（${esc(tplStyle().name)}）是底層；這裡的修改存在 <code>${esc(state.designUrl)}</code>，換樣板也會保留。<br>在 3D 畫面上<b>點一下</b>地板、牆面、天花板或家具即可直接選取。</p>
      <div class="row-actions">
        <button id="saveTpl">另存為新樣板</button>
        <button id="clearCustom" ${nCustom ? '' : 'disabled'}>清除全部材質客製（${nCustom}）</button>
      </div>
      <label class="lbl">部件</label>
      <select id="partSelect">${groups.map((g) => `<optgroup label="${esc(g)}">${P.filter((p) => p.group === g).map((p) => `<option value="${esc(p.key)}" ${p.key === partKey ? 'selected' : ''}>${isCustom(p) ? '● ' : ''}${esc(p.label)}</option>`).join('')}</optgroup>`).join('')}</select>
      <div id="partForm" class="card"></div>`;
    $('#partSelect').onchange = (e) => { partKey = e.target.value; renderCustom(); };
    $('#clearCustom').onclick = () => { if (confirm('清除所有材質客製，回到樣板值？（家具的設定不受影響）')) api.commit((d) => { d.style = {}; }); };
    $('#saveTpl').onclick = async () => {
      const name = prompt('新樣板名稱', `${tplStyle().name || '樣板'}（客製）`);
      if (!name) return;
      try { const f = await api.saveAsTemplate(name); alert(`已存成 ${f}，並切換到新樣板。`); } catch (e) { alert('儲存失敗：' + e.message); }
    };
    renderPartForm(P.find((p) => p.key === partKey));
  }

  function badge(p) {
    return isCustom(p) ? `<span class="badge custom">已客製</span> <button class="link" data-reset>重設為樣板</button>` : `<span class="badge">樣板值</span>`;
  }

  function renderPartForm(p) {
    const box = $('#partForm');
    const v = partValue(p);
    let html = `<div class="row"><b>${esc(p.label)}</b><span>${badge(p)}</span></div>`;
    if (p.kind === 'surface') {
      const s = normSpec(v, p.surface === 'floor' ? 'wood' : 'paint');
      const types = SURFACE_TYPES[p.surface === 'floor' ? 'floor' : 'wall'];
      const m = s.material || (p.surface === 'floor' ? 'wood' : 'paint');
      html += field('材質', `<select data-k="material">${types.map(([k, l]) => `<option value="${k}" ${k === m ? 'selected' : ''}>${l}</option>`).join('')}${types.some(([k]) => k === m) ? '' : `<option value="${m}" selected>${m}</option>`}</select>`);
      html += field('顏色', colorInput('color', s.color));
      if (['wood', 'herringbone'].includes(m)) html += field('板寬 cm', num('plankWidth', s.plankWidth ?? (m === 'wood' ? 18 : 10), 5, 40));
      if (m === 'herringbone') html += field('板長 cm', num('plankLength', s.plankLength ?? 50, 20, 120));
      if (['wood', 'herringbone'].includes(m)) html += field('鋪設方向', `<select data-k="direction" data-num>${[[0, '0°'], [90, '90°'], [45, '45°']].map(([k, l]) => `<option value="${k}" ${+(s.direction || 0) === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
      if (['tile', 'marble'].includes(m)) html += field(p.surface === 'floor' ? '磚寬 cm' : '磚寬 cm（橫）', num('tileSize', s.tileSize ?? 60, 10, 160));
      if (['tile', 'marble'].includes(m)) html += field(p.surface === 'floor' ? '磚長 cm' : '磚高 cm', num('tileHeight', s.tileHeight ?? s.tileSize ?? 60, 10, 160));
      if (m === 'tile') html += field('填縫色', colorInput('grout', s.grout || '#9c968d'));
      if (m === 'brick') html += field('磚縫色', colorInput('color2', s.color2 || '#d8d0c4'));
      if (m === 'woodPanel') html += field('格柵寬 cm', num('slat', s.slat ?? 4, 1, 15));
      html += field('光澤', `<input type="range" data-k="roughness" data-num min="0.05" max="1" step="0.05" value="${s.roughness ?? ''}" title="左＝亮面，右＝霧面"><small>${s.roughness == null ? '自動' : (1 - s.roughness).toFixed(2)}</small>`);
      html += field('照片材質', `<label class="inline"><input type="checkbox" data-k="pbr" ${s.pbr === false ? '' : 'checked'}> 使用 Poly Haven 真實紋理</label>`);
      box.innerHTML = html;
      bindSpec(box, p, s);
    } else if (p.kind === 'color') {
      html += field('顏色', colorInput('color', v));
      box.innerHTML = html;
      box.querySelector('[data-k=color]').oninput = debounce((e) => set(p, e.target.value), 120);
    } else if (p.kind === 'lock') {
      html += field('鎖定', `<label class="inline"><input type="checkbox" data-k="lock" ${v ? 'checked' : ''}> 這間不跟樣板變</label>`);
      html += `<div class="sub">鎖定後這間的地板、牆面、天花、家具顏色與模型、燈光都只用客製層的設定，換任何樣板都一樣（例：建商交屋、不重新裝修的衛浴）。勾選時會把目前看到的地板／牆面／天花先寫進客製層。</div>`;
      box.innerHTML = html;
      box.querySelector('[data-k=lock]').onchange = (e) => {
        const r = p.room, on = e.target.checked, es = effStyle();
        api.commit((d) => {
          if (!on) return deletePath(d.style, ['rooms', r.name, 'locked']);
          const cur = { ...(es.rooms?.[r.type] || {}), ...(es.rooms?.[r.name] || {}) };
          for (const k of ['floor', 'wall', 'ceiling']) if (getPath(d.style, ['rooms', r.name, k]) === undefined) {
            const val = cur[k] ?? (k === 'ceiling' ? es.ceiling?.color ?? es.ceiling : es[k]);
            if (val !== undefined) setPath(d.style, ['rooms', r.name, k], JSON.parse(JSON.stringify(val)));
          }
          setPath(d.style, ['rooms', r.name, 'locked'], true);
        });
      };
    } else if (p.kind === 'enum') {
      html += field('樣式', `<select data-k="v">${p.options.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
      box.innerHTML = html;
      box.querySelector('[data-k=v]').onchange = (e) => set(p, e.target.value);
    } else if (p.kind === 'curtain') {
      const c = isObj(v) ? v : {};
      html += field('顯示', `<label class="inline"><input type="checkbox" data-k="enabled" ${c.enabled === false ? '' : 'checked'}> 窗簾</label>`);
      html += field('顏色', colorInput('color', c.color || '#ece6da'));
      html += field('紗簾', `<label class="inline"><input type="checkbox" data-k="sheer" ${c.sheer ? 'checked' : ''}> 半透明</label>`);
      html += field('長度', `<select data-k="length">${[['floor', '落地'], ['sill', '到窗台']].map(([k, l]) => `<option value="${k}" ${(c.length || 'floor') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
      box.innerHTML = html;
      bindSpec(box, p, c);
    } else if (p.kind === 'rug') {
      const r = isObj(v) ? v : {};
      html += field('底色', colorInput('color', r.color || '#d8d0c3'));
      html += field('花紋色', colorInput('accent', r.accent || '#8b7d6b'));
      html += field('花紋', `<select data-k="pattern">${[['border', '邊框'], ['stripe', '條紋'], ['diamond', '菱格'], ['abstract', '抽象'], ['solid', '素色']].map(([k, l]) => `<option value="${k}" ${(r.pattern || 'border') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
      box.innerHTML = html;
      bindSpec(box, p, r);
    } else if (p.kind === 'role') {
      const s = typeof v === 'string' ? { color: v } : isObj(v) ? v : {};
      const base = state.built?.materials?.[p.path[1]]?.userData?.baseColor;
      html += field('顏色', colorInput('color', s.color || base || '#cccccc'));
      html += `<p class="hint">影響所有使用此材質、且沒有個別客製顏色的程序家具。個別家具請到「家具」分頁調整。</p>`;
      box.innerHTML = html;
      bindSpec(box, p, s);
    }
    box.querySelector('[data-reset]')?.addEventListener('click', () => reset(p));
  }

  function bindSpec(box, p, spec) {
    const update = () => {
      const out = { ...spec };
      box.querySelectorAll('[data-k]').forEach((el) => {
        const k = el.dataset.k;
        if (el.type === 'checkbox') { if (k === 'pbr') { if (el.checked) delete out.pbr; else out.pbr = false; } else out[k] = el.checked; }
        else if (el.type === 'range' && !el.dataset.touched && spec[k] == null) delete out[k];
        else out[k] = el.dataset.num !== undefined || el.type === 'number' || el.type === 'range' ? +el.value : el.value;
      });
      set(p, out);
    };
    const deb = debounce(update, 150);
    box.querySelectorAll('input[type=range]').forEach((el) => el.addEventListener('input', () => { el.dataset.touched = '1'; }));
    box.querySelectorAll('[data-k]').forEach((el) => {
      el.addEventListener(el.type === 'color' || el.type === 'range' || el.type === 'number' ? 'input' : 'change', el.type === 'color' || el.type === 'range' || el.type === 'number' ? deb : update);
    });
  }

  // ---------- furniture tab ----------
  // 必備物品（design.essentials）：清單＋自動擺放的說明／提醒
  function essentialsHTML(list) {
    const ess = state.design.essentials || [];
    if (!ess.length) return '';
    const name = (e) => e.label || (e.kind === 'tv' ? `電視 ${e.inch || ''}"` : e.kind === 'workstation' ? `電腦＋${e.monitorInch || 27}" 螢幕` : e.id);
    const manual = list.some((i) => i.origin === 'essential' && i.customized);
    const notes = state.eff?.essentialNotes || [];
    return `<details class="essentials" open><summary>必備物品 ${ess.length} 項（依格局自動擺放）</summary>
      <div class="sub">${ess.map((e) => esc(name(e))).join('、')}。改格局後會自動重新找位置；手動拖過的以手動為準。</div>
      ${notes.length ? `<ul class="sub">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${manual ? '<div class="row-actions small"><button data-ess-reset>全部改回自動擺放</button></div>' : ''}
    </details>`;
  }
  function renderFurniture() {
    const root = $('#furnRoot');
    const list = items();
    const hiddenCats = new Set(state.design.hiddenCategories || []);
    const curtainsOn = effStyle().decor?.curtains?.enabled !== false && !!effStyle().decor?.curtains;
    const pendantOn = (effStyle().decor?.pendant || 'none') !== 'none';
    const accOn = effStyle().decor?.accessories !== false;
    const byRoom = new Map();
    for (const it of list) { const r = roomOfItem(it); if (!byRoom.has(r)) byRoom.set(r, []); byRoom.get(r).push(it); }
    const sel = state.selection?.kind === 'furniture' ? list.find((i) => i.id === state.selection.id) : null;
    const removed = removedItems(state.plan, state.design);
    const visibleCount = list.filter((i) => !i.hidden).length;

    root.innerHTML = `
      <div class="row-actions">
        <button id="allOn">全部顯示</button><button id="allOff">全部隱藏</button><button id="addBtn" class="${addOpen ? 'active' : ''}">＋ 新增家具</button>
      </div>
      <div class="sub">顯示 ${visibleCount} / ${list.length} 件 · 點類別可整類開關</div>
      <div class="chips">
        ${Object.entries(CATEGORIES).map(([k, c]) => { const n = list.filter((i) => categoryOf(i.type) === k).length; return n ? `<button class="chip ${hiddenCats.has(k) ? '' : 'on'}" data-cat="${k}">${c.label} ${n}</button>` : ''; }).join('')}
        <button class="chip ${curtainsOn ? 'on' : ''}" data-gen="curtains">窗簾</button>
        <button class="chip ${pendantOn ? 'on' : ''}" data-gen="pendant">吊燈</button>
        <button class="chip ${accOn ? 'on' : ''}" data-gen="accessories" title="抱枕、毯子、書、托盤、花瓶、檯燈、掛畫（依樣板配色自動擺放）">擺飾</button>
      </div>
      ${essentialsHTML(list)}
      ${addOpen ? addFormHTML() : ''}
      ${sel ? itemEditorHTML(sel) : '<p class="hint">在清單或 3D 畫面點選家具，即可換模型、改顏色、調整位置與尺寸。</p>'}
      <div class="flist">
        ${[...byRoom.entries()].map(([room, its]) => `
          <div class="fgroup"><div class="fgroup-h"><span>${esc(room)}</span>
            <span><button class="link" data-room-on="${esc(room)}">全開</button> · <button class="link" data-room-off="${esc(room)}">全關</button></span></div>
            ${its.map((it) => `<div class="frow ${sel?.id === it.id ? 'sel' : ''}" data-id="${esc(it.id)}">
              <input type="checkbox" data-vis="${esc(it.id)}" ${it.hidden ? '' : 'checked'}>
              <span class="fname">${esc(TYPE_LABELS[it.type] || it.type)}${itemModelName(it) ? ` <em>${esc(itemModelName(it))}</em>` : ''}${it.origin === 'essential' ? ` <span class="badge custom" title="必備物品：依格局自動擺放">必備${it.customized ? '・手動' : ''}</span>` : it.origin === 'added' ? ' <span class="badge custom">新增</span>' : it.customized ? ' <span class="badge custom">●</span>' : ''}</span>
            </div>`).join('')}
          </div>`).join('')}
      </div>
      ${removed.length ? `<details class="removed"><summary>已刪除 ${removed.length} 件</summary>${removed.map((it) => `<div class="frow"><span class="fname">${esc(TYPE_LABELS[it.type] || it.type)}</span><button class="link" data-restore="${esc(it.id)}">還原</button></div>`).join('')}</details>` : ''}`;

    $('#allOn').onclick = () => api.commit((d) => {
      d.hiddenCategories = [];
      for (const k of Object.keys(d.furniture)) { delete d.furniture[k].hidden; if (!Object.keys(d.furniture[k]).length) delete d.furniture[k]; }
      deletePath(d.style, ['decor', 'curtains', 'enabled']); deletePath(d.style, ['decor', 'pendant']);
    });
    $('#allOff').onclick = () => api.commit((d) => {
      d.hiddenCategories = Object.keys(CATEGORIES);
      setPath(d.style, ['decor', 'curtains', 'enabled'], false); setPath(d.style, ['decor', 'pendant'], 'none');
    });
    $('#addBtn').onclick = () => { addOpen = !addOpen; renderFurniture(); };
    root.querySelector('[data-ess-reset]')?.addEventListener('click', () => api.commit((d) => { // essentials back to automatic placement
      for (const it of list.filter((i) => i.origin === 'essential')) {
        const o = d.furniture?.[it.id]; if (!o) continue;
        for (const k of ['x', 'y', 'rotation', 'elevation']) delete o[k];
        if (!Object.keys(o).length) delete d.furniture[it.id];
      }
    }));
    root.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => api.commit((d) => {
      const k = b.dataset.cat; const s = new Set(d.hiddenCategories || []);
      if (s.has(k)) { s.delete(k); for (const it of list) if (categoryOf(it.type) === k && d.furniture[it.id]) delete d.furniture[it.id].hidden; } else s.add(k);
      d.hiddenCategories = [...s];
    }, { rebuild: false })));
    root.querySelector('[data-gen=curtains]').onclick = () => api.commit((d) => {
      if (curtainsOn) setPath(d.style, ['decor', 'curtains', 'enabled'], false);
      else { deletePath(d.style, ['decor', 'curtains', 'enabled']); if (!effStyle().decor?.curtains || tplStyle().decor?.curtains?.enabled === false) setPath(d.style, ['decor', 'curtains', 'enabled'], true); if (!effStyle().decor?.curtains?.color) setPath(d.style, ['decor', 'curtains', 'color'], '#ece6da'); }
    });
    root.querySelector('[data-gen=pendant]').onclick = () => api.commit((d) => {
      if (pendantOn) setPath(d.style, ['decor', 'pendant'], 'none');
      else { deletePath(d.style, ['decor', 'pendant']); if ((tplStyle().decor?.pendant || 'none') === 'none') setPath(d.style, ['decor', 'pendant'], 'globe'); }
    });
    root.querySelector('[data-gen=accessories]').onclick = () => api.commit((d) => {
      if (accOn) setPath(d.style, ['decor', 'accessories'], false);
      else { deletePath(d.style, ['decor', 'accessories']); if (tplStyle().decor?.accessories === false) setPath(d.style, ['decor', 'accessories'], true); }
    });
    root.querySelectorAll('[data-vis]').forEach((cb) => (cb.onclick = (e) => { e.stopPropagation(); setHidden(cb.dataset.vis, !cb.checked); }));
    root.querySelectorAll('.frow[data-id]').forEach((row) => (row.onclick = (e) => { if (e.target.matches('input')) return; api.select({ kind: 'furniture', id: row.dataset.id }); api.focusOn({ kind: 'furniture', id: row.dataset.id }); }));
    root.querySelectorAll('[data-room-on],[data-room-off]').forEach((b) => (b.onclick = () => {
      const room = b.dataset.roomOn ?? b.dataset.roomOff; const hide = b.dataset.roomOff !== undefined;
      api.commit((d) => { for (const it of byRoom.get(room) || []) setItemHidden(d, it, hide); }, { rebuild: false });
    }));
    root.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = () => api.commit((d) => { delete d.furniture[b.dataset.restore].removed; if (!Object.keys(d.furniture[b.dataset.restore]).length) delete d.furniture[b.dataset.restore]; })));
    if (addOpen) bindAddForm();
    if (sel) bindItemEditor(sel);
  }

  function itemModelName(it) {
    const id = state.built?.byId.get(it.id)?.userData.modelId;
    return id ? (modelEntry(id)?.name || id) : '';
  }
  function setItemHidden(d, it, hide) {
    const cat = categoryOf(it.type);
    const hc = new Set(d.hiddenCategories || []);
    if (!hide && hc.has(cat)) { // un-hiding one item of a hidden category: lift the category, keep the others hidden
      hc.delete(cat); d.hiddenCategories = [...hc];
      for (const o of items()) if (categoryOf(o.type) === cat && o.id !== it.id) (d.furniture[o.id] ||= {}).hidden = true;
    }
    if (hide) (d.furniture[it.id] ||= {}).hidden = true;
    else if (d.furniture[it.id]) { delete d.furniture[it.id].hidden; if (!Object.keys(d.furniture[it.id]).length) delete d.furniture[it.id]; }
  }
  function setHidden(id, hide) { const it = items().find((i) => i.id === id); if (it) api.commit((d) => setItemHidden(d, it, hide), { rebuild: false }); }

  // ----- item editor -----
  /** the model a piece gets when nothing is chosen: template models.<type>, else the built-in default for this piece */
  const defaultModelId = (type, it = {}) => {
    const variant = { ...(effStyle().furniture || {}), ...(it.variant || {}) };
    if (type === 'chair' && it.type && it.type !== 'chair') variant.chair = it.chairStyle || (it.type === 'desk' ? 'upholstered' : variant.chair);
    const sm = effStyle().models?.[type];
    if (sm !== undefined && sm !== null) return sm === false ? null : (pickSpec(sm, type === it.type ? it : {}, variant) || pickDefault(type, type === it.type ? it : {}, variant))?.id || null;
    return pickDefault(type, type === it.type ? it : {}, variant)?.id || null;
  };
  function modelOptions(type, current, { allowDefault = true, it } = {}) {
    const list = modelsForType(type);
    const styleDefault = defaultModelId(type, it);
    const opt = (v, l, s) => `<option value="${esc(v)}" ${s ? 'selected' : ''}>${esc(l)}</option>`;
    const src = (m) => ({ polyhaven: 'Poly Haven', upload: '上傳', tripo: 'Tripo AI', magnific: 'AI 生成', khronos: 'Khronos 範例', sketchfab: 'Sketchfab', local: '本機' }[m.source] || m.source);
    return [
      allowDefault ? opt('__default', `樣板預設（${styleDefault ? (modelEntry(styleDefault)?.name || styleDefault) : '程序模型'}）`, current === undefined) : '',
      opt('__proc', '程序模型（可調各部位顏色）', current === false),
      `<optgroup label="適合「${esc(TYPE_LABELS[type] || type)}」">${list.filter((m) => m.match).map((m) => opt(m.id, `${m.name}・${src(m)}`, current === m.id)).join('')}</optgroup>`,
      `<optgroup label="其他模型">${list.filter((m) => !m.match).map((m) => opt(m.id, `${m.name}・${src(m)}`, current === m.id)).join('')}</optgroup>`,
    ].join('');
  }

  function itemEditorHTML(it) {
    const o = state.design.furniture?.[it.id] || {};
    const obj = state.built?.byId.get(it.id);
    const usesModel = !!obj?.userData.modelId;
    const roles = [...(obj?.userData.roles || [])].filter((r) => EDITABLE_ROLES.includes(r));
    const vars = VARIANTS_BY_TYPE[it.type] || [];
    const [dw, dd] = DEFAULT_SIZES[it.type] || [60, 60];
    return `<div class="card item-ed">
      <div class="row"><b>${esc(TYPE_LABELS[it.type] || it.type)}</b><span class="sub">${esc(roomOfItem(it))} · ${esc(it.id)}</span></div>
      <div class="row-actions small">
        <button data-act="hide">${it.hidden ? '顯示' : '隱藏'}</button><button data-act="dup">複製</button><button data-act="del">刪除</button>
        ${Object.keys(o).filter((k) => k !== 'hidden').length ? '<button data-act="reset">重設此件</button>' : ''}
      </div>
      ${field('模型', `<select data-f="model">${modelOptions(it.type, o.model, { it })}</select>`)}
      <button class="wide lib-toggle" data-lib-for="item">🔍 從免費模型庫挑選（Amazon 真實商品）</button><div class="lib" hidden></div>
      ${usesModel && modelEntry(obj.userData.modelId)?.note ? `<div class="sub">${esc(modelEntry(obj.userData.modelId).note)}</div>` : ''}
      ${usesModel ? `<div class="model-colors" data-mc="model" data-model="${esc(obj.userData.modelId)}"><div class="sub">載入模型材質…</div></div>` + field('模型朝向', `<button data-act="mrot-">⟲ 90°</button> <button data-act="mrot+">⟳ 90°</button>`) : ''}
      ${it.type === 'dining_table' ? field('椅子模型', `<select data-f="slotModel">${modelOptions('chair', o.slotModel, { it })}</select>`) : ''}
      ${it.type === 'dining_table' && chairModelId(it) ? `<div class="model-colors" data-mc="slot" data-model="${esc(chairModelId(it))}"><div class="sub">載入椅子材質…</div></div>` : ''}
      ${!usesModel && roles.length ? `<div class="lbl">各部位顏色</div>${roles.map((r) => field(ROLE_LABELS[r] || r, `${colorInput(r, toHex(it.colors?.[r]?.color ?? it.colors?.[r] ?? state.built?.materials?.[r]?.userData?.baseColor), 'data-role')}${it.colors?.[r] ? ` <button class="link" data-unrole="${r}">樣板色</button>` : ''}`)).join('')}` : ''}
      ${!usesModel && vars.length ? `<div class="lbl">造型</div>${vars.map((k) => field(VARIANTS[k].label, `<select data-var="${k}"><option value="">樣板預設</option>${VARIANTS[k].options.map(([v, l]) => `<option value="${v}" ${it.variant?.[k] === v && o.variant?.[k] ? 'selected' : ''}>${l}</option>`).join('')}</select>`)).join('')}` : ''}
      ${['coffee_table', 'dining_table'].includes(it.type) && !usesModel ? field('桌形', `<select data-f="shape"><option value="">方形</option><option value="round" ${it.shape === 'round' ? 'selected' : ''}>圓形</option></select>`) : ''}
      <div class="lbl">位置與尺寸（cm）</div>
      <div class="grid4">
        <label>X<input type="number" data-n="x" value="${Math.round(it.x)}"></label>
        <label>Y<input type="number" data-n="y" value="${Math.round(it.y)}"></label>
        <label>寬<input type="number" data-n="w" value="${Math.round(it.w ?? dw)}"></label>
        <label>深<input type="number" data-n="d" value="${Math.round(it.d ?? dd)}"></label>
        <label>高<input type="number" data-n="h" value="${it.h != null ? Math.round(it.h) : ''}" placeholder="自動"></label>
        <label>離地<input type="number" data-n="elevation" value="${Math.round(it.elevation || 0)}"></label>
        <label>朝向°<input type="number" data-n="rotation" value="${Math.round(it.rotation || 0)}"></label>
        <span class="rotbtns"><button data-act="rot-">⟲</button><button data-act="rot+">⟳</button></span>
      </div>
    </div>`;
  }

  function chairModelId(it) {
    const v = it.slotModel !== undefined ? it.slotModel : defaultModelId('chair', it);
    return typeof v === 'string' ? v : null;
  }

  /** colour controls for a real 3D model: built-in variants, one picker per material, whole-model tint */
  function bindModelColors(box, it, patch, slot) {
    const id = box.dataset.model;
    const kColors = slot ? 'slotModelColors' : 'modelColors', kVar = slot ? 'slotModelVariant' : 'modelVariant', kTint = slot ? 'slotTint' : 'tint';
    modelDetails(id).then(({ materials, variants }) => {
      if (!box.isConnected) return;
      const cur = it[kColors] || {};
      const lab = slot ? '椅子' : '模型';
      let html = '';
      if (variants.length) html += field(`${lab}原廠配色`, `<select data-mv><option value="">預設</option>${variants.map((v) => `<option ${it[kVar] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`);
      const hasRegions = materials.some((m) => m.regions?.length);
      html += `<div class="lbl">${lab}各材質顏色</div>`;
      if (hasRegions) html += '<div class="sub">「色區」是自動從貼圖分析出的顏色區塊（例如布料、木腳），可各自換色並保留紋理。</div>';
      const picker = (key, color) => `<input type="color" data-mk="${esc(key)}" value="${toHex(cur[key] || color)}">${cur[key] ? ` <button class="link" data-mk-reset="${esc(key)}">原色</button>` : ''}`;
      html += materials.map((m) => {
        const name = m.key.length > 12 ? m.key.slice(0, 11) + '…' : m.key;
        let s = field(esc(m.regions?.length ? `${name}（整體）` : name), picker(m.key, m.color));
        for (const [j, r] of (m.regions || []).entries()) {
          s += field(`<span class="region-dot" style="background:${r.color}"></span>色區 ${j + 1} · ${Math.round(r.pct * 100)}%`, picker(r.key, r.color));
        }
        return s;
      }).join('');
      html += field('整體色調', `<input type="color" data-mt value="${toHex(it[kTint], '#ffffff')}">${it[kTint] ? ' <button class="link" data-mt-reset>清除</button>' : ''}`);
      box.innerHTML = html;
      box.querySelector('[data-mv]')?.addEventListener('change', (e) => patch((o) => { if (e.target.value) o[kVar] = e.target.value; else delete o[kVar]; delete o[kColors]; }));
      box.querySelectorAll('[data-mk]').forEach((el) => el.addEventListener('input', debounce(() => patch((o) => { (o[kColors] ||= {})[el.dataset.mk] = el.value; }), 150)));
      box.querySelectorAll('[data-mk-reset]').forEach((b) => (b.onclick = () => patch((o) => { delete o[kColors]?.[b.dataset.mkReset]; if (o[kColors] && !Object.keys(o[kColors]).length) delete o[kColors]; })));
      box.querySelector('[data-mt]').addEventListener('input', debounce((e) => patch((o) => { o[kTint] = e.target.value; }), 150));
      box.querySelector('[data-mt-reset]')?.addEventListener('click', () => patch((o) => { delete o[kTint]; }));
    }).catch(() => { box.innerHTML = '<div class="sub">模型載入失敗</div>'; });
  }

  function bindItemEditor(it) {
    const root = $('#furnRoot .item-ed');
    const id = it.id;
    const patch = (fn, opts) => api.commit((d) => { const o = (d.furniture[id] ||= {}); fn(o, d); if (!Object.keys(o).length) delete d.furniture[id]; }, opts);
    root.querySelectorAll('.model-colors').forEach((box) => bindModelColors(box, it, patch, box.dataset.mc === 'slot'));
    bindLibrary(root, it.type, async (modelId) => patch((o) => { o.model = modelId; delete o.tint; delete o.modelColors; delete o.modelVariant; }));
    const addedItem = (d) => d.added.find((a) => a.id === id);
    // switching model drops colour settings that belonged to the old model's materials
    root.querySelector('[data-f=model]').onchange = (e) => patch((o) => { const v = e.target.value; if (v === '__default') delete o.model; else o.model = v === '__proc' ? false : v; delete o.tint; delete o.modelColors; delete o.modelVariant; });
    root.querySelector('[data-f=slotModel]')?.addEventListener('change', (e) => patch((o) => { const v = e.target.value; if (v === '__default') delete o.slotModel; else o.slotModel = v === '__proc' ? false : v; delete o.slotModelColors; delete o.slotModelVariant; delete o.slotTint; }));
    root.querySelector('[data-f=shape]')?.addEventListener('change', (e) => patch((o) => { if (e.target.value) o.shape = e.target.value; else delete o.shape; }));
    root.querySelectorAll('[data-role]').forEach((el) => el.addEventListener('input', debounce(() => patch((o) => { (o.colors ||= {})[el.dataset.k] = el.value; }), 150)));
    root.querySelectorAll('[data-unrole]').forEach((b) => (b.onclick = () => patch((o) => { delete o.colors?.[b.dataset.unrole]; if (o.colors && !Object.keys(o.colors).length) delete o.colors; })));
    root.querySelectorAll('[data-var]').forEach((el) => (el.onchange = () => patch((o) => { o.variant ||= {}; if (el.value) o.variant[el.dataset.var] = el.value; else delete o.variant[el.dataset.var]; if (!Object.keys(o.variant).length) delete o.variant; })));
    root.querySelectorAll('[data-n]').forEach((el) => (el.onchange = () => patch((o) => { const k = el.dataset.n; if (el.value === '') delete o[k]; else o[k] = +el.value; })));
    root.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'hide') setHidden(id, !it.hidden);
      else if (a === 'rot+' || a === 'rot-') patch((o) => { o.rotation = (((it.rotation || 0) + (a === 'rot+' ? 90 : -90)) % 360 + 360) % 360; });
      else if (a === 'mrot+' || a === 'mrot-') patch((o) => { o.modelRotate = (((it.modelRotate || 0) + (a === 'mrot+' ? 90 : -90)) % 360 + 360) % 360; });
      else if (a === 'untint') patch((o) => { delete o.tint; });
      else if (a === 'reset') api.commit((d) => { const h = d.furniture[id]?.hidden; delete d.furniture[id]; if (h) d.furniture[id] = { hidden: true }; });
      else if (a === 'del') { api.commit((d) => { if (it.origin === 'added') { d.added = d.added.filter((x) => x.id !== id); delete d.furniture[id]; } else (d.furniture[id] ||= {}).removed = true; }); api.select(null); }
      else if (a === 'dup') {
        const nid = 'add_' + Date.now().toString(36);
        const { origin, customized, hidden, ...copy } = it;
        api.commit((d) => { d.added.push({ ...copy, id: nid, x: it.x + 40, y: it.y + 40 }); });
        setTimeout(() => api.select({ kind: 'furniture', id: nid }), 120);
      }
    }));
    void addedItem;
  }

  // ----- add furniture -----
  function addFormHTML() {
    const types = Object.keys(TYPE_LABELS);
    const selRoom = state.selection?.room || (state.selection?.kind === 'furniture' ? roomOfItem(items().find((i) => i.id === state.selection.id) || {}) : null) || rooms()[0]?.name;
    const t = addFormHTML.type || 'armchair';
    return `<div class="card add-form">
      <div class="row"><b>新增家具</b><button class="link" data-close>關閉</button></div>
      ${field('類型', `<select data-a="type">${Object.entries(CATEGORIES).map(([k, c]) => `<optgroup label="${c.label}">${c.types.filter((x) => types.includes(x)).map((x) => `<option value="${x}" ${x === t ? 'selected' : ''}>${TYPE_LABELS[x]}</option>`).join('')}</optgroup>`).join('')}</select>`)}
      ${field('模型', `<select data-a="model">${modelOptions(t, undefined)}</select>`)}
      ${field('放在', `<select data-a="room">${rooms().map((r) => `<option ${r.name === selRoom ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`)}
      <div class="row-actions"><button data-a="go" class="primary">加入</button></div>
      <button class="wide lib-toggle" data-lib-for="add">🔍 或從免費模型庫挑一件加入</button><div class="lib" hidden></div>
      <div class="glb-import"><div class="lbl">匯入自己的 3D 模型（.glb）</div>
      <div class="sub">從 Tripo / Meshy / Sketchfab 等下載的 GLB 都可以，匯入後出現在「模型」清單。</div>
      <div class="row-actions"><input type="text" data-a="gname" placeholder="模型名稱"><input type="file" data-a="file" accept=".glb,.gltf"></div></div>
    </div>`;
  }
  function bindAddForm() {
    const root = $('#furnRoot .add-form');
    const typeSel = root.querySelector('[data-a=type]');
    typeSel.onchange = () => { addFormHTML.type = typeSel.value; root.querySelector('[data-a=model]').innerHTML = modelOptions(typeSel.value, undefined); };
    root.querySelector('[data-close]').onclick = () => { addOpen = false; renderFurniture(); };
    bindLibrary(root, () => typeSel.value, async (modelId) => {
      root.querySelector('[data-a=model]').innerHTML = modelOptions(typeSel.value, modelId);
      root.querySelector('[data-a=model]').value = modelId;
      root.querySelector('[data-a=go]').click();
    });
    root.querySelector('[data-a=go]').onclick = () => {
      const type = typeSel.value; const mv = root.querySelector('[data-a=model]').value;
      const room = roomByName(root.querySelector('[data-a=room]').value) || rooms()[0];
      const [cx, cy] = room ? freeSpot(room, type) : [0, 0];
      const id = 'add_' + Date.now().toString(36);
      const it = { id, type, x: Math.round(cx), y: Math.round(cy), rotation: 0 };
      if (mv === '__proc') it.model = false; else if (mv !== '__default') it.model = mv;
      api.commit((d) => { d.added.push(it); });
      addOpen = false;
      setTimeout(() => { api.select({ kind: 'furniture', id }); api.focusOn({ kind: 'furniture', id }); }, 150);
    };
    root.querySelector('[data-a=file]').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const name = root.querySelector('[data-a=gname]').value || f.name.replace(/\.[^.]+$/, '');
      try {
        const id = await api.uploadModel(f, { name, type: typeSel.value });
        root.querySelector('[data-a=model]').innerHTML = modelOptions(typeSel.value, id);
        root.querySelector('[data-a=model]').value = id;
      } catch (err) { alert('匯入失敗（需用 python server.py 啟動）：' + err.message); }
    };
  }

  // ----- free model library (Amazon Berkeley Objects index, models/abo_index.json) -----
  let libIndex = null;
  async function loadLibIndex() {
    if (!libIndex) libIndex = fetch('models/abo_index.json').then((r) => r.json());
    return libIndex;
  }
  /** wires a ".lib-toggle" button + ".lib" container inside root; onPick(catalogModelId) after import */
  function bindLibrary(root, typeOrFn, onPick) {
    const btn = root.querySelector('.lib-toggle'); const box = root.querySelector('.lib');
    if (!btn || !box) return;
    const typeNow = () => (typeof typeOrFn === 'function' ? typeOrFn() : typeOrFn);
    let shown = 24;
    btn.onclick = async () => {
      box.hidden = !box.hidden; if (box.hidden) return;
      box.innerHTML = '<div class="sub">載入模型庫索引…</div>';
      const idx = await loadLibIndex();
      const types = [...new Set(idx.items.flatMap((x) => x.t))];
      box.innerHTML = `<div class="sub">來源：${esc(idx.source)} · ${esc(idx.license)}（非商業使用）· 共 ${idx.items.length.toLocaleString()} 件。點一下即下載（貼圖自動壓到 1K）。</div>
        <div class="row-actions"><select data-l="type">${types.map((t) => `<option value="${t}" ${t === typeNow() ? 'selected' : ''}>${TYPE_LABELS[t] || ({ decor: '擺飾', pendant: '吊燈' })[t] || t}</option>`).join('')}</select>
        <input type="text" data-l="q" placeholder="關鍵字（英文）：velvet, oak, round…"></div>
        <div class="lib-grid"></div><button class="wide" data-l="more" hidden>顯示更多</button>`;
      const grid = box.querySelector('.lib-grid');
      const draw = () => {
        const t = box.querySelector('[data-l=type]').value;
        const words = box.querySelector('[data-l=q]').value.toLowerCase().split(/\s+/).filter(Boolean);
        const res = idx.items.filter((x) => x.t.includes(t) && words.every((w) => (x.n + ' ' + x.c).toLowerCase().includes(w)));
        grid.innerHTML = res.slice(0, shown).map((x) => `<button class="lib-card" data-abo="${esc(x.i)}" title="${esc(x.n)}">
          <img loading="lazy" src="${idx.base}/images/small/${esc(x.th)}" alt="">
          <span>${esc(x.n)}</span><em class="sub">${esc(x.c || '')} · ${Math.round(x.e[0] * 100)}×${Math.round(x.e[2] * 100)}×${Math.round(x.e[1] * 100)}</em></button>`).join('') || '<div class="sub">沒有符合的模型</div>';
        box.querySelector('[data-l=more]').hidden = res.length <= shown;
        grid.querySelectorAll('[data-abo]').forEach((card) => (card.onclick = async () => {
          card.classList.add('busy'); card.querySelector('span').textContent = '下載、壓縮中…';
          try { const id = await api.importLibraryModel(card.dataset.abo, t); await onPick(id); }
          catch (e) { alert('匯入失敗（需用 python server.py 啟動）：' + e.message); card.classList.remove('busy'); }
        }));
      };
      box.querySelector('[data-l=type]').onchange = () => { shown = 24; draw(); };
      box.querySelector('[data-l=q]').oninput = debounce(() => { shown = 24; draw(); }, 200);
      box.querySelector('[data-l=more]').onclick = () => { shown += 24; draw(); };
      draw();
    };
  }

  /** find the emptiest spot in a room for a new piece (cm) */
  function freeSpot(room, type) {
    const [w, d] = DEFAULT_SIZES[type] || [60, 60];
    const r = Math.max(w, d) / 2;
    const poly = room.polygon;
    const [cx, cy] = centroid(poly);
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const edgeDist = (x, y) => {
      let m = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
        const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy));
      }
      return m;
    };
    const others = items().filter((i) => !i.hidden && !['rug', 'art', 'mirror'].includes(i.type)).map((i) => {
      const [iw, id] = DEFAULT_SIZES[i.type] || [60, 60];
      return { x: i.x, y: i.y, r: Math.max(i.w ?? iw, i.d ?? id) / 2 * 0.85 };
    });
    let best = [cx, cy], bestScore = -Infinity;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 15) {
      for (let y = Math.min(...ys); y <= Math.max(...ys); y += 15) {
        if (!pointInPoly([x, y], poly)) continue;
        const edge = edgeDist(x, y) - r - 8;
        if (edge < 0) continue;
        let near = 200;
        for (const o of others) near = Math.min(near, Math.hypot(o.x - x, o.y - y) - o.r - r);
        const score = Math.min(near, 60) + Math.min(edge, 30) * 0.2 - Math.hypot(x - cx, y - cy) * 0.03;
        if (score > bestScore) { bestScore = score; best = [x, y]; }
      }
    }
    return best;
  }

  // ---------- helpers ----------
  function field(label, inner) { return `<div class="field"><span>${label}</span><div>${inner}</div></div>`; }
  function colorInput(k, v, attr = 'data-k') { return `<input type="color" ${attr}="${k}" ${attr !== 'data-k' ? `data-k="${k}"` : ''} value="${toHex(v)}">`; }
  function num(k, v, min, max) { return `<input type="number" data-k="${k}" min="${min}" max="${max}" value="${v}">`; }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------- public ----------
  function showSelection(sel) {
    if (!sel) { render(); return; }
    if (sel.kind === 'furniture') { if (tab !== 'furniture') setTab('furniture'); else render(); return; }
    if (sel.kind === 'floor') partKey = `r:${sel.room}:floor`;
    else if (sel.kind === 'ceiling') partKey = `r:${sel.room}:ceiling`;
    else if (sel.kind === 'wall') partKey = `f:${sel.room}|${sel.wall}|${sel.side}`;
    else if (sel.kind === 'door') partKey = 'g:door';
    else if (sel.kind === 'window') partKey = 'g:frame';
    else if (sel.kind === 'exterior') partKey = 'g:exterior';
    if (tab !== 'custom') setTab('custom'); else render();
  }
  let deferred = false;
  function refresh() {
    // don't clobber an input the user is dragging/typing in (a colour picker would close); re-render on blur
    const a = document.activeElement;
    if (a && a.closest?.('#customRoot,#furnRoot') && ['number', 'text', 'color', 'range'].includes(a.type)) { deferred = true; return; }
    render();
  }
  for (const id of ['#customRoot', '#furnRoot']) $(id).addEventListener('focusout', () => { if (deferred) { deferred = false; setTimeout(render, 0); } });
  setTab('template');
  return { refresh, showSelection, setTab };
}
