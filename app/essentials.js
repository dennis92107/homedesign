// 必備物品（essentials）：一個案子不論格局怎麼改都一定要有的東西（例：兩組電腦＋27 吋螢幕、客廳 75 吋電視）。
// 寫在客製層 design.essentials，不寫座標：每次重建場景時依「目前的格局」自動找最合理的位置——
// 格局改了（拆牆、房間改類型、換成另一版平面圖）就自動重新擺。使用者手動拖過的（design.furniture[id] 有 x/y）以手動為準。
//
// "essentials": [
//   { "id": "ess_tv", "kind": "tv", "inch": 75 },                                   // 客廳電視櫃上的電視尺寸
//   { "id": "ess_pc1", "kind": "workstation", "label": "電腦 1", "monitorInch": 27, "pc": true },
//   { "id": "ess_pc2", "kind": "workstation", "label": "電腦 2", "monitorInch": 27, "pc": true }
// ]
// 產生的家具 id：<id>_monitor、<id>_pc、（需要新桌子時）<id>_desk。
//
// 依據（2026-11-23 查證）：每人桌寬最少約 90 cm、舒適 120 cm，桌深至少 60 cm（雙人桌選購指南，例 desky.ca、bestier.net）；
// 螢幕距眼 50–100 cm、上緣約與眼同高（OSHA Computer Workstations eTool）；75" 電視寬 166 cm，觀看距離 THX 約 228 cm、
// SMPTE 約 310 cm（Wikipedia Optimum HDTV viewing distance、RTINGS）。

const SEAT_OK = 120;       // comfortable width per person
const SEAT_MIN = 90;       // minimum width per person (one 27" screen ≈ 61 cm + elbow room)
const NEW_DESK = { w: 120, d: 60 };
const CHAIR_ROOM = 80;     // free floor in front of a desk for the chair
const DESK_H = 75;
const ROOM_PREF = { study: 0, bedroom: 2, living: 4, dining: 5 }; // lower = better for a computer; others never (corridor, entry …)
const NO_COMPUTER = new Set(['bathroom', 'kitchen', 'balcony', 'storage']);

const rad = (deg) => ((deg || 0) * Math.PI) / 180;
/** plan offset of a point given in a piece's local frame (lx right, lz toward its front) */
export function localToPlan(it, lx, lz) {
  const r = rad(it.rotation), c = Math.cos(r), s = Math.sin(r);
  return [it.x + lx * c - lz * s, it.y + lx * s + lz * c];
}
function inPoly(poly, [x, y]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const roomAt = (plan, p) => (plan.rooms || []).find((r) => inPoly(r.polygon, p));
/** axis-aligned box of a rotated w×d footprint */
function box(x, y, w, d, rotation) {
  const r = rad(rotation), c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const hw = (w * c + d * s) / 2, hd = (w * s + d * c) / 2;
  return { x0: x - hw, x1: x + hw, y0: y - hd, y1: y + hd };
}
const overlap = (a, b, tol = 1) => a.x0 < b.x1 - tol && a.x1 > b.x0 + tol && a.y0 < b.y1 - tol && a.y1 > b.y0 + tol;
const SIZES = { desk: [120, 60], sofa: [220, 92], bed: [180, 210], wardrobe: [200, 60], tv_cabinet: [180, 42], chair: [46, 48] };
const FLOAT = new Set(['rug', 'art', 'mirror', 'ring_light', 'monitor']); // nothing stands on the floor there
function footprint(it) {
  const [dw, dd] = SIZES[it.type] || [60, 60];
  return box(it.x, it.y, it.w ?? dw, it.d ?? dd, it.rotation);
}
/** door openings → keep-out boxes (opening width × 100 cm on both sides of the wall) */
function doorBoxes(plan) {
  const out = [];
  for (const o of plan.openings || []) {
    if (o.type !== 'door' && !o.walkable) continue;
    const w = plan.walls?.[o.wall]; if (!w) continue;
    const [ax, ay] = w.a, [bx, by] = w.b, L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    const cx = ax + ux * o.at, cy = ay + uy * o.at;
    out.push(box(cx, cy, o.width + 10, 200, Math.atan2(uy, ux) * 180 / Math.PI));
  }
  return out;
}
function windowSpans(plan) {
  return (plan.openings || []).filter((o) => o.type === 'window' && !o.walkable).map((o) => {
    const w = plan.walls?.[o.wall]; if (!w) return null;
    const [ax, ay] = w.a, [bx, by] = w.b, L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    return box(ax + ux * o.at, ay + uy * o.at, o.width, 30, Math.atan2(uy, ux) * 180 / Math.PI);
  }).filter(Boolean);
}
const wallHalf = (plan, p) => { // half thickness of the wall under a room edge point
  let best = null, bd = 4;
  for (const w of plan.walls || []) {
    const [ax, ay] = w.a, [bx, by] = w.b, L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / L2));
    const dd = Math.hypot(p[0] - ax - t * (bx - ax), p[1] - ay - t * (by - ay));
    if (dd < bd) { bd = dd; best = w; }
  }
  if (!best) return null; // open edge (no wall): not a place for a desk
  return (best.thickness || (best.exterior ? plan.exteriorThickness || 20 : plan.wallThickness || 12)) / 2;
};
const rotationFacing = (nx, ny) => ((Math.round((Math.atan2(-nx, ny) * 180) / Math.PI) % 360) + 360) % 360;

/** a free wall stretch for a new desk (w × d) in one room, or null */
function findWallSpot(plan, room, obstacles, doors, windows, w, d) {
  const poly = room.polygon; let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < w + 10) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L; let nx = -uy, ny = ux;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!inPoly(poly, [mid[0] + nx * 5, mid[1] + ny * 5])) { nx = -nx; ny = -ny; }
    for (let t = w / 2 + 5; t <= L - w / 2 - 5; t += 10) {
      const e = [a[0] + ux * t, a[1] + uy * t]; const half = wallHalf(plan, e); if (half == null) continue;
      const cx = e[0] + nx * (half + d / 2), cy = e[1] + ny * (half + d / 2);
      const rot = rotationFacing(nx, ny);
      const desk = box(cx, cy, w, d, rot);
      const zone = box(cx + nx * (d / 2 + CHAIR_ROOM / 2), cy + ny * (d / 2 + CHAIR_ROOM / 2), w, CHAIR_ROOM, rot);
      const corners = [[desk.x0 + 1, desk.y0 + 1], [desk.x1 - 1, desk.y0 + 1], [desk.x0 + 1, desk.y1 - 1], [desk.x1 - 1, desk.y1 - 1]];
      if (!corners.every((p) => inPoly(poly, p))) continue;
      if ([...obstacles, ...doors].some((o) => overlap(desk, o) || overlap(zone, o))) continue;
      // prefer a solid wall (a monitor in front of a window = glare + blocked view), then the room's longer walls
      const penalty = (windows.some((o) => overlap(box(e[0], e[1], w, 40, rot), o)) ? 100 : 0) - L / 100;
      if (!best || penalty < best.penalty) best = { x: Math.round(cx), y: Math.round(cy), rotation: rot, penalty };
    }
  }
  return best;
}

/**
 * plan + already-merged pieces → { added: [new pieces], patches: { id: patch for an existing piece }, notes: [...] }
 * Pure: no THREE, no DOM. Called from design.effective().
 */
export function placeEssentials(plan, items, essentials) {
  const res = { added: [], patches: {}, notes: [] };
  if (!Array.isArray(essentials) || !essentials.length) return res;
  const live = items.filter((it) => !it.hidden);
  const doors = doorBoxes(plan), windows = windowSpans(plan);
  const solid = () => live.filter((it) => !FLOAT.has(it.type) && !(it.elevation > 0)).concat(res.added.filter((a) => a.type === 'desk'));

  // ---------- workstations ----------
  const ws = essentials.filter((e) => e.kind === 'workstation');
  if (ws.length) {
    const slots = [];
    for (const desk0 of live.filter((it) => it.type === 'desk')) {
      const desk = { ...desk0 }; // never mutate the caller's pieces: changes go out as patches
      const room = roomAt(plan, [desk.x, desk.y]);
      if (!room || NO_COMPUTER.has(room.type) || ROOM_PREF[room.type] == null) continue;
      let w = desk.w ?? 120, d = desk.d ?? 60;
      // grow a desk in place (back stays on the wall), widest first, sliding up to 30 cm along the wall to clear a
      // bed / wardrobe; the chair keeps 80 cm of floor in front. null = no room for it here.
      const others = solid().filter((o) => o.id !== desk.id && !(o.type === 'chair' && Math.hypot(o.x - desk.x, o.y - desk.y) < 90));
      const grow = (widths, nd) => {
        for (const nw of widths) {
          for (const slide of [0, 2, -2, 4, -4, 6, -6, 10, -10, 15, -15, 20, -20, 30, -30]) {
            const [cx, cy] = localToPlan(desk, slide, (nd - d) / 2);
            const b = box(cx, cy, nw, nd, desk.rotation);
            const [zx, zy] = localToPlan({ ...desk, x: cx, y: cy }, 0, nd / 2 + CHAIR_ROOM / 2);
            const zone = box(zx, zy, Math.min(nw, 70), CHAIR_ROOM, desk.rotation);
            const ok = [[b.x0 + 1, b.y0 + 1], [b.x1 - 1, b.y0 + 1], [b.x0 + 1, b.y1 - 1], [b.x1 - 1, b.y1 - 1]].every((p) => inPoly(room.polygon, p))
              && !others.some((o) => overlap(b, footprint(o)) || overlap(zone, footprint(o))) && !doors.some((o) => overlap(b, o));
            if (ok) return { nw, nd, cx, cy };
          }
        }
        return null;
      };
      const apply = (fit, why) => {
        res.patches[desk.id] = { ...(res.patches[desk.id] || {}), w: fit.nw, d: fit.nd, x: Math.round(fit.cx), y: Math.round(fit.cy) };
        desk.x = Math.round(fit.cx); desk.y = Math.round(fit.cy); w = fit.nw; d = fit.nd;
        res.notes.push(`${room.name} 的書桌${why}，自動改成 ${fit.nw}×${fit.nd} cm`);
      };
      if (w < SEAT_MIN || d < 55) { // too small for a 27" screen + keyboard
        const fit = grow([120, 110, 100, 90].filter((x) => x >= w), Math.max(d, NEW_DESK.d));
        if (!fit) continue;
        apply(fit, '太小');
      } else if (ws.length > 1 && w >= 2 * SEAT_MIN - 30 && w < 2 * SEAT_MIN) { // almost two seats: lengthen it so both fit side by side
        const fit = grow([2 * SEAT_MIN], d);
        if (fit) apply(fit, '加長讓兩人並排（每人 90 cm）');
      }
      const pref = (ROOM_PREF[room.type] ?? 6) + (/主臥/.test(room.name) ? 1 : 0);
      slots.push({ desk: { ...desk, w, d }, room, cap: w >= 2 * SEAT_MIN ? 2 : 1, pref });
    }
    // best rooms first; within a room the bigger desk first (two people side by side)
    slots.sort((a, b) => a.pref - b.pref || b.cap - a.cap);
    const use = []; // { desk, room, seats: [ws...] }
    let left = [...ws];
    for (const s of slots) {
      if (!left.length) break;
      const take = left.splice(0, s.cap); use.push({ ...s, seats: take });
    }
    // still no desk: put a new one on a free wall of the best room
    const rooms = (plan.rooms || []).filter((r) => !NO_COMPUTER.has(r.type) && ROOM_PREF[r.type] != null)
      .sort((a, b) => (ROOM_PREF[a.type] + (/主臥/.test(a.name) ? 1 : 0)) - (ROOM_PREF[b.type] + (/主臥/.test(b.name) ? 1 : 0)));
    while (left.length) {
      const e = left.shift(); let spot = null, room = null;
      for (const r of rooms) { spot = findWallSpot(plan, r, solid().map(footprint), doors, windows, NEW_DESK.w, NEW_DESK.d); if (spot) { room = r; break; } }
      if (!spot) { res.notes.push(`${e.label || e.id}：找不到放書桌的空牆，請手動擺放`); continue; }
      const desk = { id: `${e.id}_desk`, type: 'desk', x: spot.x, y: spot.y, w: NEW_DESK.w, d: NEW_DESK.d, rotation: spot.rotation, essential: e.id };
      res.added.push(desk); use.push({ desk, room, seats: [e], cap: 1, isNew: true });
      res.notes.push(`${e.label || e.id}：${room.name} 沒有合適的書桌，自動加一張 120×60 靠牆`);
    }
    for (const u of use) {
      const { desk, seats } = u; const n = seats.length, slotW = desk.w / n;
      if (n > 1 && !(desk.chairs > 1)) res.patches[desk.id] = { ...(res.patches[desk.id] || {}), chairs: n };
      // decor.js: no lamp / books on it · model: false = the built-in desk at exactly w × d × 75 cm (a real product
      // model is scaled uniformly, so a long desk came out ~135 cm wide and its top higher than the screens' 75 cm)
      if (u.isNew) Object.assign(desk, { computers: n, model: false });
      else res.patches[desk.id] = { ...(res.patches[desk.id] || {}), computers: n, model: false };
      if (n > 1 && slotW < SEAT_OK) res.notes.push(`${u.room.name}：${n} 人共用 ${desk.w} cm 書桌，每人 ${Math.round(slotW)} cm（舒適約 120、最少約 90）`);
      res.notes.push(`${seats.map((e) => e.label || e.id).join('、')} → ${u.room.name}${u.isNew ? '（新書桌）' : ''}`);
      seats.forEach((e, i) => {
        const lx = -desk.w / 2 + slotW * (i + 0.5);
        // screen ~22 cm off the desk's back edge: clear of curtains hanging 12 cm off a window wall, and ≈ 60 cm from the eyes
        const [mx, my] = localToPlan(desk, lx, -desk.d / 2 + 27);
        res.added.push({ id: `${e.id}_monitor`, type: 'monitor', inch: e.monitorInch || 27, x: Math.round(mx), y: Math.round(my), rotation: desk.rotation || 0, elevation: DESK_H, essential: e.id, label: e.label });
        if (e.pc !== false) {
          const [px, py] = localToPlan(desk, lx + slotW / 2 - 20, -desk.d / 2 + 26);
          res.added.push({ id: `${e.id}_pc`, type: 'pc_tower', x: Math.round(px), y: Math.round(py), rotation: desk.rotation || 0, essential: e.id, label: e.label, solid: false });
        }
      });
    }
  }

  // ---------- TV ----------
  for (const e of essentials.filter((x) => x.kind === 'tv')) {
    const inch = e.inch || 65, tvW = Math.round(inch * 2.54 * 0.8716);
    const cabs = live.filter((it) => it.type === 'tv_cabinet').map((it) => ({ it, room: roomAt(plan, [it.x, it.y]) }))
      .sort((a, b) => (a.room?.type === 'living' ? 0 : 1) - (b.room?.type === 'living' ? 0 : 1));
    let cab = cabs[0]?.it;
    if (!cab) { // no TV cabinet: face the biggest sofa of the living room
      const sofa = live.filter((it) => it.type === 'sofa' && roomAt(plan, [it.x, it.y])?.type === 'living').sort((a, b) => (b.w || 0) - (a.w || 0))[0];
      const room = sofa && roomAt(plan, [sofa.x, sofa.y]);
      if (!room) { res.notes.push('電視：客廳沒有電視櫃也沒有沙發，請手動擺放'); continue; }
      const [fx, fy] = localToPlan({ ...sofa, x: 0, y: 0 }, 0, 1); // sofa facing direction
      let hit = null;
      for (let i = 0; i < room.polygon.length; i++) { // first room edge straight ahead of the sofa
        const a = room.polygon[i], b = room.polygon[(i + 1) % room.polygon.length];
        const ex = b[0] - a[0], ey = b[1] - a[1], den = fx * ey - fy * ex; if (Math.abs(den) < 1e-6) continue;
        const t = ((a[0] - sofa.x) * ey - (a[1] - sofa.y) * ex) / den, u = ((a[0] - sofa.x) * fy - (a[1] - sofa.y) * fx) / den;
        if (t > 30 && u >= 0 && u <= 1 && (!hit || t < hit.t)) hit = { t, p: [sofa.x + fx * t, sofa.y + fy * t] };
      }
      if (!hit) { res.notes.push('電視：找不到沙發正對面的牆，請手動擺放'); continue; }
      const half = wallHalf(plan, hit.p) ?? 6, cw = Math.max(180, tvW + 14), cd = 40;
      cab = { id: `${e.id}_cabinet`, type: 'tv_cabinet', x: Math.round(hit.p[0] - fx * (half + cd / 2)), y: Math.round(hit.p[1] - fy * (half + cd / 2)), w: cw, d: cd, rotation: rotationFacing(-fx, -fy), essential: e.id };
      res.added.push(cab);
      res.notes.push(`電視：客廳沒有電視櫃，自動在沙發對面加一座 ${cw} cm`);
    }
    const patch = { tvInch: inch };
    if ((cab.w ?? 180) < tvW + 10) patch.w = tvW + 14;
    if (cab.id.endsWith('_cabinet') && cab.essential) Object.assign(cab, patch); else res.patches[cab.id] = { ...(res.patches[cab.id] || {}), ...patch };
    // viewing distance: TV screen ↔ the nearest sofa's seat (≈ 30 cm behind its front edge)
    const sofa = live.filter((it) => it.type === 'sofa').map((s) => ({ s, dist: Math.hypot(s.x - cab.x, s.y - cab.y) })).sort((a, b) => a.dist - b.dist)[0]?.s;
    if (sofa) {
      const [sx, sy] = localToPlan(sofa, 0, (sofa.d ?? 92) / 2 - 30);
      const [tx, ty] = localToPlan(cab, 0, -(cab.d ?? 42) / 2 + 4);
      const dist = Math.round(Math.hypot(sx - tx, sy - ty)), lo = Math.round(inch * 2.54 / 0.84), hi = Math.round(inch * 2.54 * 1.6264);
      res.notes.push(`電視 ${inch}"：座位到螢幕約 ${dist} cm（建議 ${lo}–${hi} cm${dist < lo ? '，偏近' : dist > hi ? '，偏遠' : '，剛好'}）`);
    }
  }
  return res;
}
