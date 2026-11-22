// 設計層（客製）= 疊在「樣板」(styles/*.json) 與「平面圖」(plans/*.json) 上面的覆寫層。
// 每張平面圖一份：designs/<plan 檔名>.json。換樣板時客製層保留；可逐項重設回樣板值。
//
// {
//   "version": 1,
//   "style":  { ...與 Style JSON 同結構的覆寫：wall / floor / ceiling / rooms.<房間名稱> / wallFaces / materials / decor / doors / windows ... },
//   "furniture": { "<家具 id>": { hidden, removed, colors, model, tint, variant, x, y, rotation, w, d, h, elevation, shape } },
//   "added": [ { id, type, x, y, ... } ],        // 新增的家具（UI 或 Claude 依參考圖加入）
//   "hiddenCategories": [ "decor", ... ]         // 整類隱藏
// }

export const emptyDesign = () => ({ version: 1, style: {}, furniture: {}, added: [], hiddenCategories: [] });
export const designPathFor = (planUrl) => 'designs/' + (planUrl || 'plan.json').split('/').pop();

export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : (isObj(v) ? deepMerge({}, v) : v);
  return out;
}
/**
 * Three-way merge for collaborative editing: `base` = last version both sides agreed on (from the server),
 * `mine` = local edits, `theirs` = what someone else saved meanwhile. Objects merge key by key; arrays and
 * scalars are atomic (if both sides changed the same value, mine wins).
 */
export function merge3(base, mine, theirs) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(mine, theirs)) return mine;
  if (same(base, mine)) return theirs;
  if (same(base, theirs)) return mine;
  if (isObj(mine) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(b)])) {
      const inM = k in mine, inT = k in theirs, inB = k in b;
      if (!inM && !inT) continue;
      if (!inM) { if (inB && same(b[k], theirs[k])) continue; out[k] = theirs[k]; continue; } // I deleted it (or never had it)
      if (!inT) { if (inB && same(b[k], mine[k])) continue; out[k] = mine[k]; continue; } // they deleted it
      out[k] = merge3(b[k], mine[k], theirs[k]);
    }
    return out;
  }
  return mine;
}

export function getPath(obj, path) { return path.reduce((o, k) => (o == null ? undefined : o[k]), obj); }
export function setPath(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) { if (!isObj(o[path[i]])) o[path[i]] = {}; o = o[path[i]]; }
  o[path[path.length - 1]] = value;
}
/** delete a path and prune empty parent objects */
export function deletePath(obj, path) {
  const stack = [obj]; let o = obj;
  for (let i = 0; i < path.length - 1; i++) { o = o?.[path[i]]; if (!isObj(o)) return; stack.push(o); }
  delete o[path[path.length - 1]];
  for (let i = path.length - 2; i >= 0; i--) { if (isObj(stack[i + 1]) && !Object.keys(stack[i + 1]).length) delete stack[i][path[i]]; else break; }
}

export const TYPE_LABELS = {
  sofa: '沙發', armchair: '單椅', chair: '椅子', ottoman: '腳凳', stool: '吧檯椅', coffee_table: '茶几', side_table: '邊几',
  dining_table: '餐桌', desk: '書桌', island: '中島', tv_cabinet: '電視櫃', sideboard: '矮櫃', wardrobe: '衣櫃', bookshelf: '書櫃',
  shoe_cabinet: '鞋櫃', nightstand: '床頭櫃', bed: '床', kitchen_counter: '廚具', fridge: '冰箱', toilet: '馬桶', vanity: '浴櫃',
  bathtub: '浴缸', shower: '淋浴間', floor_lamp: '立燈', rug: '地毯', art: '掛畫', mirror: '鏡子', plant: '植栽', box: '方塊', cylinder: '圓柱', display_shelf: '展示層架', slat_panel: '格柵板', ring_light: '圓形燈帶',
};
export const CATEGORIES = {
  seating: { label: '沙發座椅', types: ['sofa', 'armchair', 'chair', 'ottoman', 'stool'] },
  tables: { label: '桌几', types: ['coffee_table', 'side_table', 'dining_table', 'desk', 'island'] },
  storage: { label: '收納櫃體', types: ['tv_cabinet', 'sideboard', 'wardrobe', 'bookshelf', 'shoe_cabinet', 'nightstand', 'display_shelf'] },
  beds: { label: '床具', types: ['bed'] },
  kitchen: { label: '廚房', types: ['kitchen_counter', 'fridge'] },
  bath: { label: '衛浴', types: ['toilet', 'vanity', 'bathtub', 'shower'] },
  lighting: { label: '燈具', types: ['floor_lamp', 'ring_light'] },
  decor: { label: '軟裝植栽', types: ['rug', 'art', 'mirror', 'plant', 'box', 'cylinder'] },
};
export function categoryOf(type) {
  for (const [k, c] of Object.entries(CATEGORIES)) if (c.types.includes(type)) return k;
  return 'decor';
}
export const ROLE_LABELS = {
  wood: '木料', woodDark: '深木/底座', fabric: '主布料', fabricAlt: '輔布料/抱枕', leather: '皮革', metal: '金屬', accent: '點綴色',
  white: '白色件', stone: '石材', ceramic: '陶瓷', mattress: '床墊', bedding: '寢具', plant: '葉子', pot: '花盆', lampshade: '燈罩',
  screen: '螢幕', mirror: '鏡面', cabinet: '櫃體', countertop: '檯面', curtain: '窗簾', doorLeaf: '門片', frame: '窗框/門框', baseboard: '踢腳板',
};

export const itemId = (it, i) => it.id ?? `${it.type}_${i}`;

/**
 * Write a position/size patch for one piece into the design layer. Added pieces keep their values in `added[]`;
 * any same keys left in `furniture[id]` (they would override `added`) are dropped so the new value sticks.
 */
export function setFurniturePatch(d, id, patch) {
  const added = (d.added || []).find((x) => x.id === id);
  if (!added) { Object.assign((d.furniture[id] ||= {}), patch); return; }
  Object.assign(added, patch);
  const o = d.furniture?.[id];
  if (o) { for (const k of Object.keys(patch)) delete o[k]; if (!Object.keys(o).length) delete d.furniture[id]; }
}

/** Merge template + design → the plan & style the builder actually renders. */
export function effective(plan, style, design) {
  const d = design || emptyDesign();
  const s = deepMerge(style || {}, d.style || {});
  const hiddenCats = new Set(d.hiddenCategories || []);
  const items = [
    ...(plan.furniture || []).map((it, i) => ({ ...it, id: itemId(it, i), origin: 'plan' })),
    ...(s.added || []).map((it) => ({ ...it, origin: 'style' })), // style-specific pieces (e.g. lit shelving of a reference design)
    ...(d.added || []).map((it) => ({ ...it, origin: 'added' })),
  ];
  const out = [];
  for (const it of items) {
    const o = d.furniture?.[it.id];
    if (o?.removed) continue;
    const { hidden, removed, ...rest } = o || {};
    const m = o ? deepMerge(it, rest) : { ...it };
    m.hidden = !!hidden || hiddenCats.has(categoryOf(it.type));
    m.customized = !!o && Object.keys(rest).length > 0;
    out.push(m);
  }
  return { plan: { ...plan, furniture: out }, style: s };
}

/** list of removed items (so the UI can offer restore) */
export function removedItems(plan, design) {
  const all = [...(plan.furniture || []).map((it, i) => ({ ...it, id: itemId(it, i) })), ...(design.added || [])];
  return all.filter((it) => design.furniture?.[it.id]?.removed);
}

export const SURFACE_TYPES = {
  floor: [['wood', '木地板'], ['herringbone', '人字拼'], ['tile', '磁磚'], ['hex', '六角磚'], ['marble', '大理石'], ['concrete', '水泥/磐多魔'], ['terrazzo', '水磨石'], ['carpet', '地毯']],
  wall: [['paint', '油漆'], ['limewash', '灰泥/礦物漆'], ['concrete', '清水模'], ['brick', '紅磚'], ['woodPanel', '木格柵'], ['tile', '磁磚'], ['marble', '大理石']],
};
