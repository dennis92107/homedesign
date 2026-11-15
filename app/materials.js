// Style JSON -> THREE materials.
// Each material is created immediately with a procedural texture, then (if PBR assets are enabled)
// upgraded in place with a real Poly Haven photo texture + normal + roughness map.
import * as THREE from 'three';
import * as TX from './textures.js';
import { upgradeMaterial, SURFACE_PBR, ROLE_PBR } from './assets.js';

const loader = new THREE.TextureLoader();
export const settings = { pbr: true };

function applyWorld(tex, rotationDeg = 0) {
  if (!tex) return tex;
  if (!tex.userData.stretch) {
    const s = tex.userData.worldSize || 1;
    tex.repeat.set(1 / s, 1 / s);
  }
  if (rotationDeg) { tex.center.set(0.5, 0.5); tex.rotation = (rotationDeg * Math.PI) / 180; }
  return tex;
}

function imageTexture(url, worldSize = 1) {
  const t = loader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData.worldSize = worldSize;
  return t;
}

function schedule(mat, pbrSpec, color, extra = {}) {
  if (!settings.pbr || !pbrSpec) return;
  upgradeMaterial(mat, pbrSpec.id, { color, mode: pbrSpec.mode, scale: pbrSpec.scale || 1, roughness: pbrSpec.roughness, normalScale: pbrSpec.normalScale ?? 1, ...extra }).catch(() => {});
}

/** Surface spec (floor / wall finish) -> material.
 *  spec: { material, color, color2, plankWidth, plankLength, tileSize, grout, direction, roughness, image, imageSize,
 *          pbr: '<polyhaven texture id>' | false, pbrMode: 'retint'|'detail'|'original', pbrScale } */
export function surfaceMaterial(spec = {}, fallback = '#cccccc', { surface = 'floor' } = {}) {
  if (typeof spec === 'string') spec = { material: 'paint', color: spec };
  const color = spec.color || fallback;
  let map = null; let rough = spec.roughness;
  switch (spec.material) {
    case 'wood': map = TX.planks({ color, plankWidth: spec.plankWidth || 18, variation: spec.variation ?? 0.12 }); rough ??= 0.55; break;
    case 'herringbone': map = TX.herringbone({ color, plankWidth: spec.plankWidth || 10, plankLength: spec.plankLength || 50, variation: spec.variation ?? 0.14 }); rough ??= 0.5; break;
    case 'tile': map = TX.tiles({ color, grout: spec.grout || TX.shade(color, -0.25), tileSize: spec.tileSize || 60 }); rough ??= 0.3; break;
    case 'marble': map = TX.marble({ color, tileSize: spec.tileSize || 80, grout: spec.grout || TX.shade(color, -0.12) }); rough ??= 0.15; break;
    case 'concrete': map = TX.concrete({ color }); rough ??= 0.8; break;
    case 'terrazzo': map = TX.terrazzo({ color, chips: spec.chips || undefined }); rough ??= 0.35; break;
    case 'carpet': map = TX.carpet({ color }); rough ??= 1; break;
    case 'limewash': map = TX.limewash({ color }); rough ??= 0.95; break;
    case 'brick': map = TX.brick({ color, mortar: spec.color2 || '#d8d0c4' }); rough ??= 0.9; break;
    case 'woodPanel': map = TX.woodPanel({ color, slat: spec.slat || 4, gap: spec.gap || 1.2 }); rough ??= 0.6; break;
    default: rough ??= 0.92; // paint
  }
  if (spec.image) map = imageTexture(spec.image, spec.imageSize || 1);
  if (map) map = applyWorld(map, spec.direction || 0);
  const mat = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : color, map, roughness: rough, metalness: spec.metalness || 0 });
  if (surface === 'ceiling') mat.side = THREE.BackSide;
  mat.userData.baseColor = color;

  if (!spec.image && spec.pbr !== false) {
    let key = spec.material || 'paint';
    if (key === 'concrete' && surface === 'wall') key = 'wallConcrete';
    const def = SURFACE_PBR[key];
    const pbrSpec = typeof spec.pbr === 'string' ? { id: spec.pbr, mode: spec.pbrMode || 'retint', scale: spec.pbrScale } : def;
    // marble/wood keep their real roughness feel; paint keeps exact colour
    schedule(mat, pbrSpec, color, { rotation: spec.direction || 0, roughness: spec.roughness });
  }
  return mat;
}

const DEFAULT_ROLES = {
  wood: { color: '#b98d63', grain: true, roughness: 0.6 },
  woodDark: { color: '#5b4030', grain: true, roughness: 0.55 },
  fabric: { color: '#c9c3b8', texture: 'fabric', roughness: 0.95 },
  fabricAlt: { color: '#8c9a8a', texture: 'fabric', roughness: 0.95 },
  leather: { color: '#8a5a3c', roughness: 0.5 },
  metal: { color: '#2b2b2b', metalness: 0.8, roughness: 0.35 },
  accent: { color: '#c4744f', roughness: 0.8 },
  white: { color: '#f3f1ec', roughness: 0.5 },
  stone: { color: '#e5e2dc', roughness: 0.25, texture: 'marble' },
  ceramic: { color: '#fbfbf9', roughness: 0.12 },
  mattress: { color: '#f4f2ee', texture: 'fabric', roughness: 1 },
  bedding: { color: '#e9e4da', texture: 'fabric', roughness: 1 },
  plant: { color: '#4f6b3a', roughness: 0.8 },
  pot: { color: '#d8cfc2', roughness: 0.7 },
  lampshade: { color: '#f7efe0', emissive: '#ffd9a0', emissiveIntensity: 0.9, roughness: 0.9 },
  screen: { color: '#0b0b0c', roughness: 0.15, metalness: 0.2 },
  mirror: { color: '#dfe6ea', roughness: 0.03, metalness: 1 },
  cabinet: { color: '#efebe4', roughness: 0.55 },
  countertop: { color: '#e9e6e0', roughness: 0.25, texture: 'marble' },
  curtain: { color: '#ece6da', roughness: 1, opacity: 0.92 },
  doorLeaf: { color: '#efebe4', roughness: 0.6 },
  frame: { color: '#ffffff', roughness: 0.5 },
  baseboard: { color: '#f4f2ee', roughness: 0.5 },
  book: { color: '#9a8f80', roughness: 0.8 },
};

/** Build all furniture-role materials. style.materials entries may be "#hex" or objects. */
export function buildRoleMaterials(style) {
  const src = { ...(style.materials || {}) };
  if (style.doors?.color) src.doorLeaf = { ...(typeof src.doorLeaf === 'object' ? src.doorLeaf : {}), color: style.doors.color };
  if (style.windows?.frameColor) src.frame = { color: style.windows.frameColor, roughness: 0.4, metalness: style.windows.metalFrame ? 0.6 : 0 };
  if (style.decor?.curtains?.color) src.curtain = { color: style.decor.curtains.color, roughness: 1, opacity: style.decor.curtains.sheer ? 0.55 : 0.97 };
  if (style.baseboard) src.baseboard = typeof style.baseboard === 'string' ? { color: style.baseboard } : style.baseboard;
  const out = {};
  for (const [role, def] of Object.entries(DEFAULT_ROLES)) {
    let s = src[role];
    if (typeof s === 'string') s = { color: s };
    out[role] = makeRole({ ...def, ...(s || {}) }, role);
  }
  for (const [role, s] of Object.entries(src)) if (!out[role]) out[role] = makeRole(typeof s === 'string' ? { color: s } : s, role);
  out.glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, metalness: 0, transmission: 1, ior: 1.5, thickness: 0.006, transparent: true, opacity: 1, side: THREE.DoubleSide });
  out.dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
  out.cap = new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.9 });
  return out;
}

export function makeRole(s, role) {
  let map = null;
  const grainOn = s.grain ?? false;
  if (s.image) map = applyWorld(imageTexture(s.image, s.imageSize || 1));
  else if (grainOn || s.texture === 'wood') map = applyWorld(TX.woodGrain({ color: s.color }));
  else if (s.texture === 'fabric') map = applyWorld(TX.fabric({ color: s.color }));
  else if (s.texture === 'marble') map = applyWorld(TX.marble({ color: s.color, tileSize: 240, grout: s.color }));
  else if (s.texture === 'terrazzo') map = applyWorld(TX.terrazzo({ color: s.color }));
  else if (s.texture === 'concrete') map = applyWorld(TX.concrete({ color: s.color }));
  const m = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : s.color, map, roughness: s.roughness ?? 0.7, metalness: s.metalness ?? 0 });
  if (s.emissive) { m.emissive = new THREE.Color(s.emissive); m.emissiveIntensity = s.emissiveIntensity ?? 1; }
  if (s.opacity != null && s.opacity < 1) { m.transparent = true; m.opacity = s.opacity; m.side = THREE.DoubleSide; }
  if (role === 'curtain') m.side = THREE.DoubleSide;
  m.userData.baseColor = s.color;
  if (!s.image && s.pbr !== false) {
    let spec = typeof s.pbr === 'string' ? { id: s.pbr, mode: s.pbrMode || 'retint' } : ROLE_PBR[role];
    if (!spec && (s.texture === 'marble')) spec = { id: 'marble_01', mode: 'retint', roughness: s.roughness };
    if (!spec && (s.texture === 'wood' || grainOn)) spec = ROLE_PBR.wood;
    if (spec) schedule(m, spec, s.color, { roughness: spec.roughness ?? (spec.mode === 'detail' ? s.roughness : undefined) });
  }
  return m;
}

/** Clone a role set with per-item colour overrides: item.colors = { fabric: '#..', wood: '#..' } */
export function withOverrides(M, colors) {
  if (!colors) return M;
  const out = Object.create(M);
  for (const [role, c] of Object.entries(colors)) {
    const base = M[role];
    const spec = typeof c === 'string' ? { color: c } : c;
    const tex = role.startsWith('wood') ? 'wood' : ['fabric', 'fabricAlt', 'bedding', 'mattress'].includes(role) ? 'fabric' : ['stone', 'countertop'].includes(role) ? 'marble' : undefined;
    out[role] = makeRole({ roughness: base?.roughness, metalness: base?.metalness, emissive: base?.emissive?.getHexString ? '#' + base.emissive.getHexString() : undefined, texture: tex, ...spec }, role);
  }
  return out;
}
