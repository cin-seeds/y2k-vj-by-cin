// Saved audio wiring for the Still, Push, and Hit buttons.
// A pack recalls a scene and assigns clips once, then writes the mix
// through the same path a Starts stack uses.

import { LAYERS, LAYER_DEFS, MODE_LABELS, MODES, BLEND_LABELS, layerParam } from '../params.js';
import { KICK_DRIVEN, KICK_MODES, controlShown } from './recipes.js';
import { diagnoseReadable } from '../mod/diagnose.js';

export const PACK_SLOTS = [
  { id: 'still', label: 'Still' },
  { id: 'push', label: 'Push' },
  { id: 'hit', label: 'Hit' },
];

export const BAND_LABELS = ['All bands', 'Bass', 'Mids', 'High-Hats', 'Off'];

const GRADE_IDS = ['gradeSat', 'gradeContrast', 'crtScan', 'crtBleed', 'chroma', 'strobe', 'strobeSrc', 'strobePol', 'master'];

const SEED = [
  {
    id: 'still',
    name: 'Still',
    assign: 'still',
    scene: '',
    speed: 0.8,
    grade: { gradeSat: 0.95, gradeContrast: 1.05, crtScan: 0.06, chroma: 0.03, strobe: 0, master: 0.9 },
    // Clean has no shader listen; punch ducks the plate a little so the bed still breathes on bass.
    A: {
      mode: 'clean', opacity: 1, band: 4, reactivity: 0,
      opacityRoute: { route: 'punch', depth: -0.14, gate: 0.28 },
    },
    B: {
      mode: 'cloud', opacity: 0.58, blend: 2, band: 1, reactivity: 0.82, beat: 0.18,
      sliders: { cloudCover: 0.48, cloudDrift: 0.42, cloudBand: 0.68 },
      opacityRoute: { route: 'peak', depth: 0.28, gate: 0.32 },
    },
    C: { mode: 'glitch', opacity: 0, band: 1, beat: 0 },
  },
  {
    id: 'push',
    name: 'Push',
    assign: 'push',
    scene: '',
    speed: 1.25,
    grade: {
      gradeSat: 0.7, gradeContrast: 1.35, crtScan: 0.15, crtBleed: 0.1, chroma: 0.1,
      strobe: 0.1, strobeSrc: 1, strobePol: 0, master: 1,
    },
    A: {
      mode: 'clean', opacity: 1, band: 4, reactivity: 0,
      opacityRoute: { route: 'punch', depth: -0.18, gate: 0.25 },
    },
    B: {
      mode: 'starfield', opacity: 0.48, blend: 2, band: 1, reactivity: 1.0, beat: 0.22,
      sliders: { warp: 0.55, porthole: 0.5, grid: 0.22, flash: 0.55 },
      opacityRoute: { route: 'punch', depth: 0.32, gate: 0.28 },
    },
    C: {
      mode: 'jpeg', opacity: 0.52, blend: 2, band: 3, reactivity: 0.95, beat: 0.15,
      sliders: { jpegBlock: 0.45, jpegSmear: 0.52, jpegCrush: 0.42 },
      opacityRoute: { route: 'peak', depth: 0.3, gate: 0.3 },
    },
  },
  {
    id: 'hit',
    name: 'Hit',
    assign: 'hit',
    scene: '',
    speed: 1.8,
    grade: {
      gradeSat: 1.15, gradeContrast: 1.45, crtBleed: 0.22, crtScan: 0.18, chroma: 0.28,
      strobe: 0.22, strobeSrc: 2, strobePol: 1, master: 1,
    },
    A: {
      mode: 'bend', opacity: 1, blend: 0, band: 1, reactivity: 1.2, beat: 0.22,
      sliders: { bendAmt: 0.72, bendCurve: 0.52, bendLean: 0.32 },
    },
    B: {
      mode: 'vhs', opacity: 0.55, blend: 2, band: 3, reactivity: 1.05, beat: 0.12,
      sliders: { tracking: 0.48, tapeJitter: 0.62, smear: 0.55, scanlines: 0.5 },
      opacityRoute: { route: 'peak', depth: 0.65, gate: 0.32 },
    },
    C: {
      mode: 'thermal', opacity: 0.42, blend: 1, band: 2, reactivity: 0.7, beat: 0,
      sliders: { heat: 1.45 },
      opacityRoute: { route: 'punch', depth: 0.35, gate: 0.3 },
    },
  },
];

const uid = () => Math.random().toString(36).slice(2, 10);

export function lookDefs(mode) {
  return LAYER_DEFS.filter((def) => {
    if (def.group === mode) return true;
    return def.group === 'look' && Array.isArray(def.modes) && def.modes.includes(mode);
  });
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function slidersFor(mode, raw) {
  const allowed = new Set(lookDefs(mode).map((def) => def.id));
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) continue;
    const n = finite(value);
    if (n == null) continue;
    out[key] = n;
  }
  return out;
}

function opacityRouteFor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = raw.key || 'opacity';
  if (key !== 'opacity' || KICK_DRIVEN.includes(key)) return null;
  const route = typeof raw.route === 'string' ? raw.route : 'none';
  if (!route || route === 'none') return null;
  const depth = finite(raw.depth);
  const gate = finite(raw.gate);
  return {
    key: 'opacity',
    route,
    depth: clamp(depth == null ? 0.5 : depth, -1, 1),
    gate: clamp(gate == null ? 0 : gate, 0, 1),
  };
}

function layerFor(raw, fallbackMode) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(src.mode) ? src.mode : fallbackMode;
  const layer = { mode, clip: typeof src.clip === 'string' ? src.clip : '' };
  const opacity = finite(src.opacity);
  const blend = finite(src.blend);
  const band = finite(src.band);
  const reactivity = finite(src.reactivity);
  const beat = finite(src.beat);
  if (opacity != null) layer.opacity = clamp(opacity, 0, 1);
  if (blend != null) layer.blend = clamp(Math.round(blend), 0, BLEND_LABELS.length - 1);
  if (band != null) layer.band = clamp(Math.round(band), 0, 4);
  if (reactivity != null) layer.reactivity = clamp(reactivity, 0, 2);
  if (beat != null) layer.beat = clamp(beat, 0, 1);
  const sliders = slidersFor(mode, src.sliders);
  if (Object.keys(sliders).length) layer.sliders = sliders;
  const route = opacityRouteFor(src.opacityRoute);
  if (route) layer.opacityRoute = route;
  return layer;
}

export function normalizePack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const assign = PACK_SLOTS.some((slot) => slot.id === raw.assign) ? raw.assign : '';
  const grade = {};
  const srcGrade = raw.grade && typeof raw.grade === 'object' ? raw.grade : {};
  for (const id of GRADE_IDS) {
    const n = finite(srcGrade[id]);
    if (n == null) continue;
    grade[id] = n;
  }
  const speed = finite(raw.speed);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    name: String(raw.name || 'Pack').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Pack',
    assign,
    scene: typeof raw.scene === 'string' ? raw.scene : '',
    speed: speed == null ? null : clamp(speed, 0, 4),
    grade,
    A: layerFor(raw.A, 'clean'),
    B: layerFor(raw.B, 'clean'),
    C: layerFor(raw.C, 'clean'),
  };
}

/** Missing packs become the three seeds. An explicit empty list stays empty. */
export function coercePacks(raw) {
  if (!Array.isArray(raw)) return seedPacks();
  return raw.map(normalizePack).filter(Boolean);
}

export function seedPacks() {
  return SEED.map((pack) => normalizePack(structuredClone(pack)));
}

const QUIET = { mode: 'clean', opacity: 0, band: 4, reactivity: 0, beat: 0 };

const IMPROVISED = {
  still: [
    {
      speed: 0.7,
      grade: { gradeSat: 0.92, gradeContrast: 1.02, crtScan: 0.04, chroma: 0.02, strobe: 0, master: 0.88 },
      A: { mode: 'clean', opacity: 1, band: 4, reactivity: 0, beat: 0 },
      B: { mode: 'cloud', opacity: 0.32, blend: 2, band: 1, reactivity: 0.4, beat: 0, sliders: { cloudCover: 0.3, cloudDrift: 0.22, cloudBand: 0.5 } },
      C: QUIET,
    },
    {
      speed: 0.62,
      grade: { gradeSat: 0.88, gradeContrast: 1, crtScan: 0.05, chroma: 0.02, strobe: 0, master: 0.9 },
      A: { mode: 'clean', opacity: 1, band: 4, reactivity: 0, beat: 0 },
      B: { mode: 'ink', opacity: 0.28, blend: 2, band: 1, reactivity: 0.36, beat: 0, sliders: { inkLife: 0.5, inkStir: 0.22, inkCurl: 0.28 } },
      C: QUIET,
    },
    {
      speed: 0.75,
      grade: { gradeSat: 0.96, gradeContrast: 1.04, crtScan: 0.03, strobe: 0, master: 0.86 },
      A: { mode: 'fold', opacity: 0.8, blend: 0, band: 1, reactivity: 0.32, beat: 0, sliders: { foldDepth: 0.2, foldScale: 0.32, foldSheets: 0.4 } },
      B: { mode: 'clean', opacity: 0.16, band: 4, reactivity: 0, beat: 0 },
      C: QUIET,
    },
  ],
  push: [
    {
      speed: 1.2,
      grade: { gradeSat: 0.75, gradeContrast: 1.28, crtScan: 0.12, chroma: 0.08, strobe: 0.1, strobeSrc: 1, strobePol: 0, master: 1 },
      A: { mode: 'clean', opacity: 1, band: 4, reactivity: 0, beat: 0 },
      B: { mode: 'starfield', opacity: 0.22, blend: 2, band: 1, reactivity: 0.72, beat: 0, sliders: { warp: 0.35, porthole: 0.5, grid: 0.12, flash: 0.25 } },
      C: { mode: 'jpeg', opacity: 0.28, blend: 2, band: 3, reactivity: 0.68, beat: 0, sliders: { jpegBlock: 0.32, jpegSmear: 0.35, jpegCrush: 0.28 } },
    },
    {
      speed: 1.15,
      grade: { gradeSat: 0.8, gradeContrast: 1.22, crtScan: 0.1, crtBleed: 0.08, chroma: 0.1, strobe: 0.12, strobeSrc: 2, master: 1 },
      A: { mode: 'y2k', opacity: 0.92, blend: 0, band: 1, reactivity: 0.78, beat: 0, sliders: { glitch: 0.22, feedback: 0.3, edgeGlow: 1.2, clouds: 0.4 } },
      B: { mode: 'vhs', opacity: 0.3, blend: 2, band: 3, reactivity: 0.7, beat: 0, sliders: { tracking: 0.3, tapeJitter: 0.4, smear: 0.35, scanlines: 0.35 } },
      C: QUIET,
    },
    {
      speed: 1.3,
      grade: { gradeSat: 0.7, gradeContrast: 1.32, crtScan: 0.14, chroma: 0.12, strobe: 0.08, strobeSrc: 2, master: 1 },
      A: { mode: 'home', opacity: 1, blend: 0, band: 1, reactivity: 0.82, beat: 0, sliders: { homeTile: 0.3, homeMix: 0.65, homeBevel: 0.55 } },
      B: {
        mode: 'retro', opacity: 0.3, blend: 5, band: 3, reactivity: 0.64, beat: 0,
        sliders: { snapSize: 6, retroDither: 0.7, affine: 0.3, wobble: 0.2 },
        opacityRoute: { key: 'opacity', route: 'peak', depth: 0.5, gate: 0.4 },
      },
      C: QUIET,
    },
  ],
  hit: [
    {
      speed: 1.7,
      grade: { gradeSat: 1.1, gradeContrast: 1.4, crtBleed: 0.18, crtScan: 0.16, chroma: 0.24, strobe: 0.2, strobeSrc: 2, strobePol: 1, master: 1 },
      A: { mode: 'bend', opacity: 1, blend: 0, band: 1, reactivity: 0.95, beat: 0, sliders: { bendAmt: 0.48, bendCurve: 0.38, bendLean: 0.2 } },
      B: {
        mode: 'vhs', opacity: 0.36, blend: 2, band: 3, reactivity: 0.86, beat: 0,
        sliders: { tracking: 0.38, tapeJitter: 0.48, smear: 0.42, scanlines: 0.4 },
        opacityRoute: { key: 'opacity', route: 'punch', depth: 0.55, gate: 0.4 },
      },
      C: QUIET,
    },
    {
      speed: 1.65,
      grade: { gradeSat: 1.12, gradeContrast: 1.42, crtScan: 0.16, chroma: 0.22, strobe: 0.18, strobeSrc: 2, strobePol: 0, master: 1 },
      A: { mode: 'chomp', opacity: 0.9, blend: 0, band: 1, reactivity: 1, beat: 0, sliders: { chompSize: 0.3, chompSpeed: 0.42, chompMouth: 0.7 } },
      B: { mode: 'jpeg', opacity: 0.32, blend: 2, band: 3, reactivity: 0.8, beat: 0, sliders: { jpegBlock: 0.4, jpegSmear: 0.45, jpegCrush: 0.32 } },
      C: QUIET,
    },
    {
      speed: 1.85,
      grade: { gradeSat: 1.18, gradeContrast: 1.48, crtBleed: 0.2, chroma: 0.26, strobe: 0.22, strobeSrc: 2, strobePol: 1, master: 1 },
      A: { mode: 'glitch', opacity: 1, blend: 0, band: 1, reactivity: 0.9, beat: 0, sliders: { glitch: 0.4, feedback: 0.32, edgeGlow: 1.3 } },
      B: { mode: 'retro', opacity: 0.38, blend: 4, band: 3, reactivity: 0.82, beat: 0, sliders: { snapSize: 8, retroDither: 0.8, affine: 0.35, wobble: 0.25 } },
      C: QUIET,
    },
  ],
};

/** A wiring for an empty button. It follows that button's vibe and the project's safe listens. */
export function improvisePack(slot, random = Math.random) {
  const label = PACK_SLOTS.find((item) => item.id === slot)?.label || 'Pack';
  const options = IMPROVISED[slot] || IMPROVISED.still;
  const index = Math.min(options.length - 1, Math.floor(random() * options.length));
  const choice = options[index];
  return normalizePack({
    ...structuredClone(choice),
    id: uid(),
    name: label,
    assign: slot,
    scene: '',
  });
}

export function modeLabel(mode) {
  const index = MODES.indexOf(mode);
  return index >= 0 ? MODE_LABELS[index] : mode;
}

function trimNum(value) {
  const n = Math.round(Number(value) * 1000) / 1000;
  return String(n);
}

function percent(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

const STROBE_SRC = ['Manual', 'Beat Pulse', 'Drop Pulse'];
const STROBE_POL = ['white', 'black'];

export function packHover(pack) {
  const lines = [pack.name];
  const slot = PACK_SLOTS.find((item) => item.id === pack.assign);
  lines.push(slot ? `Button ${slot.label}` : 'No composition button');
  if (pack.scene) lines.push(`Scene ${pack.scene}`);
  for (const id of LAYERS) {
    const spec = pack[id];
    const bits = [`${id} ${modeLabel(spec.mode)}`];
    if ('opacity' in spec) bits.push(`opacity ${trimNum(spec.opacity)}`);
    if ('blend' in spec) bits.push(BLEND_LABELS[spec.blend] || 'Blend');
    if ('band' in spec) bits.push(BAND_LABELS[spec.band] || 'Band');
    if ('reactivity' in spec) bits.push(`react ${trimNum(spec.reactivity)}`);
    if ('beat' in spec) bits.push(`beat ${trimNum(spec.beat)}`);
    for (const [key, value] of Object.entries(spec.sliders || {})) {
      const def = LAYER_DEFS.find((item) => item.id === key);
      bits.push(`${def?.label || key} ${trimNum(value)}`);
    }
    if (spec.opacityRoute) {
      bits.push(`opacity ${spec.opacityRoute.route} depth ${trimNum(spec.opacityRoute.depth)} gate ${trimNum(spec.opacityRoute.gate)}`);
    }
    if (spec.clip) bits.push(`clip ${spec.clip}`);
    lines.push(bits.join(', '));
  }
  const mix = [];
  if (pack.speed != null) mix.push(`speed ${trimNum(pack.speed)}x`);
  const grade = pack.grade || {};
  if ('gradeSat' in grade) mix.push(`saturation ${trimNum(grade.gradeSat)}x`);
  if ('gradeContrast' in grade) mix.push(`contrast ${trimNum(grade.gradeContrast)}x`);
  if ('crtScan' in grade) mix.push(`scanlines ${percent(grade.crtScan)}`);
  if ('crtBleed' in grade) mix.push(`phosphor bleed ${percent(grade.crtBleed)}`);
  if ('chroma' in grade) mix.push(`RGB separation ${percent(grade.chroma)}`);
  if ('strobe' in grade) mix.push(`strobe ${percent(grade.strobe)}`);
  if ('strobeSrc' in grade) mix.push(STROBE_SRC[grade.strobeSrc | 0] || 'Strobe');
  if ('strobePol' in grade) mix.push(STROBE_POL[grade.strobePol | 0] || 'white');
  if ('master' in grade) mix.push(`brightness ${percent(grade.master)}`);
  if (mix.length) lines.push(mix.join(', '));
  return lines.join('\n');
}

function layerView(pack, id) {
  const spec = pack[id] || {};
  const opacity = 'opacity' in spec ? spec.opacity : 0;
  return {
    id,
    engine: 'fx',
    mode: spec.mode || 'clean',
    active: opacity > 0.001,
    get(key) {
      if (key === 'audioBind') return 'band' in spec ? spec.band : 4;
      if (key === 'beatSync') return 'beat' in spec ? spec.beat : 0;
      if (key === 'reactivity') return 'reactivity' in spec ? spec.reactivity : 0;
      if (key === 'opacity') return opacity;
      return spec.sliders?.[key] ?? 0;
    },
  };
}

function routeFor(pack, id) {
  const dot = id.indexOf('.');
  if (dot < 0) return { route: 'none', depth: 0, gate: 0 };
  const layer = id.slice(0, dot);
  const key = id.slice(dot + 1);
  const route = pack[layer]?.opacityRoute;
  if (key === 'opacity' && route) return route;
  if (KICK_DRIVEN.includes(key) && route && route.key === key) return route;
  return { route: 'none', depth: 0, gate: 0 };
}

function visible(spec) {
  return !!spec && 'opacity' in spec && spec.opacity > 0.001;
}

/**
 * Signs for the pack being edited. Readable tips come from the existing
 * diagnosis. Clash, Over, Destroy, and Silent are the audio signs.
 */
export function packSigns(pack, params) {
  const grade = pack.grade || {};
  const tips = diagnoseReadable({
    params: {
      defs: params.defs,
      get(id) {
        if (id === 'strobe') return grade.strobe ?? 0;
        if (id === 'strobeSrc') return grade.strobeSrc ?? 0;
        return 0;
      },
    },
    mods: { get: (id) => routeFor(pack, id) },
    layers: LAYERS.map((id) => layerView(pack, id)),
    audible: () => true,
  });
  const signs = [];

  const listening = LAYERS.filter((id) => {
    const spec = pack[id];
    return visible(spec) && 'band' in spec && spec.band !== 4 && (spec.reactivity ?? 0) > 0.6;
  });
  const byBand = new Map();
  for (const id of listening) {
    const band = pack[id].band;
    const group = byBand.get(band) || [];
    group.push(id);
    byBand.set(band, group);
  }
  for (const [band, ids] of byBand) {
    if (ids.length < 2) continue;
    const text = `Clash: layers ${ids.join(' and ')} share ${BAND_LABELS[band]} with reactivity above 0.6.`;
    for (const id of ids) signs.push({ layer: id, kind: 'Clash', text });
  }

  for (const id of LAYERS) {
    const spec = pack[id];
    if (!spec) continue;
    if ((spec.reactivity ?? 0) > 1.3) {
      signs.push({
        layer: id,
        kind: 'Over',
        text: `Over: layer ${id} reactivity is above 1.3.`,
      });
    }
    const route = spec.opacityRoute;
    if (route && route.depth > 0.85 && route.gate < 0.2) {
      signs.push({
        layer: id,
        kind: 'Over',
        text: `Over: layer ${id} opacity depth is above 0.85 with a gate under 0.2.`,
      });
    }
    if (KICK_MODES.has(spec.mode) && (spec.beat ?? 0) > 0.35) {
      signs.push({
        layer: id,
        kind: 'Destroy',
        text: `Destroy: Layer ${id} Beat Sync is overriding the kick on a look that already follows it.`,
      });
    }
    if (spec.opacityRoute && KICK_DRIVEN.includes(spec.opacityRoute.key || 'opacity')) {
      signs.push({
        layer: id,
        kind: 'Destroy',
        text: `Destroy: layer ${id} has a matrix route on a slider the look already moves from the kick.`,
      });
    }
    for (const key of Object.keys(spec.sliders || {})) {
      if (!KICK_DRIVEN.includes(key)) continue;
      const modId = layerParam(id, key);
      const mod = routeFor(pack, modId);
      if (!mod || mod.route === 'none' || Math.abs(mod.depth) <= 0.001) continue;
      signs.push({
        layer: id,
        kind: 'Destroy',
        text: `Destroy: layer ${id} has a matrix route on a slider the look already moves from the kick.`,
      });
    }
    if (KICK_MODES.has(spec.mode) && (spec.band === 2 || spec.band === 3)) {
      signs.push({
        layer: id,
        kind: 'Silent',
        text: `Silent: layer ${id} follows the kick, and ${BAND_LABELS[spec.band]} will not deliver it.`,
      });
    }
  }

  const strobe = grade.strobe ?? 0;
  const strobeSrc = grade.strobeSrc ?? 0;
  if (strobe > 0.15 && strobeSrc === 1) {
    const synced = LAYERS.filter((id) => (pack[id]?.beat ?? 0) > 0);
    if (synced.length) {
      signs.push({
        layer: synced[0],
        kind: 'Destroy',
        text: `Destroy: Strobe on Beat Pulse is overriding Beat Sync on layer ${synced.join(' and ')}.`,
      });
    }
  }

  return mergeTips(signs, tips);
}

function kindForTip(text) {
  if (/Beat Sync is stacked|matrix route|Beat Pulse stacks/.test(text)) return 'Destroy';
  if (/all listen on All bands/.test(text)) return 'Clash';
  return '';
}

function mergeTips(signs, tips) {
  for (const tip of tips) {
    const beat = /Beat Sync is stacked/.test(tip.text);
    const route = /matrix route/.test(tip.text);
    const strobe = /Beat Pulse stacks/.test(tip.text);
    const bands = /all listen on All bands/.test(tip.text);
    if (beat && signs.some((sign) => sign.kind === 'Destroy' && sign.layer === tip.layerId && /Beat Sync/.test(sign.text))) continue;
    if (route && signs.some((sign) => sign.kind === 'Destroy' && sign.layer === tip.layerId && /overriding the kick|matrix route/.test(sign.text))) continue;
    if (strobe && signs.some((sign) => sign.kind === 'Destroy' && /Beat Pulse/.test(sign.text))) continue;
    if (bands && signs.some((sign) => sign.kind === 'Clash')) continue;
    signs.push({ layer: tip.layerId || '', kind: kindForTip(tip.text), text: tip.text });
  }
  return signs;
}

const OTHER_BANDS = [1, 2, 3, 0];

function layerIdsIn(text) {
  const found = String(text || '').match(/\b[ABC]\b/g);
  return found ? [...found] : [];
}

/**
 * One change that would clear the first sign. Apply mutates the draft it is given.
 * A pack with no signs has no suggestion.
 */
export function packSuggestion(pack, signs) {
  const sign = (signs || []).find((item) => item?.text);
  if (!sign || !pack) return null;
  const text = String(sign.text || '');
  const kind = sign.kind || text.split(':')[0];
  const layer = sign.layer || layerIdsIn(text)[0] || '';
  const spec = layer ? pack[layer] : null;

  if (kind === 'Clash') {
    const ids = layerIdsIn(text);
    const first = ids[0];
    const second = ids[1];
    if (!first || !second || !pack[second]) return null;
    const used = pack[first]?.band;
    const next = OTHER_BANDS.find((band) => band !== used);
    if (next == null) return null;
    return {
      text: `Move layer ${second} onto ${BAND_LABELS[next]}. Layer ${first} is on ${BAND_LABELS[used] ?? 'another band'}.`,
      apply(draft) {
        if (draft[second]) draft[second].band = next;
      },
    };
  }

  if (kind === 'Over' && spec) {
    if (/reactivity/i.test(text)) {
      return {
        text: `Bring layer ${layer} reactivity down to 1.`,
        apply(draft) {
          if (draft[layer]) draft[layer].reactivity = 1;
        },
      };
    }
    if (/depth/i.test(text) && spec.opacityRoute && spec.opacityRoute.gate < 0.2) {
      return {
        text: `Bring layer ${layer} opacity depth down to 0.7.`,
        apply(draft) {
          const route = draft[layer]?.opacityRoute;
          if (route) route.depth = 0.7;
        },
      };
    }
  }

  if (kind === 'Destroy') {
    if (/Beat Sync/i.test(text) && !/Beat Pulse/i.test(text) && spec) {
      return {
        text: `Set layer ${layer} Beat Sync to 0.`,
        apply(draft) {
          if (draft[layer]) draft[layer].beat = 0;
        },
      };
    }
    if (/Beat Pulse/i.test(text)) {
      return {
        text: 'Move the Beat Pulse strobe onto Drop Pulse.',
        apply(draft) {
          draft.grade = draft.grade || {};
          draft.grade.strobeSrc = 2;
        },
      };
    }
    if (/route/i.test(text) && spec) {
      return {
        text: `Clear the route on layer ${layer} that the look already moves.`,
        apply(draft) {
          if (draft[layer]) draft[layer].opacityRoute = null;
        },
      };
    }
  }

  if (kind === 'Silent' && spec) {
    return {
      text: `Set layer ${layer} band to Bass.`,
      apply(draft) {
        if (draft[layer]) draft[layer].band = 1;
      },
    };
  }

  return null;
}

/** One line each. An empty sign list says the picture is clear. */
export function signLines(signs) {
  const lines = [];
  const seen = new Set();
  for (const sign of signs || []) {
    const text = sign.kind && !String(sign.text).startsWith(sign.kind)
      ? `${sign.kind}: ${sign.text}`
      : sign.text;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  if (!lines.length) return ['The picture is clear.'];
  return lines;
}

/**
 * The same audio signs, read from the live desk: layers, the mod matrix,
 * and the composition strobe. No second analyser.
 */
export function deskSigns({ params, mods, layers, audible }) {
  const matrix = mods || { get: () => ({ route: 'none', depth: 0, gate: 0 }) };
  const hear = audible || (() => true);
  const views = (layers || []).map((layer) => ({
    id: layer.id,
    engine: layer.engine,
    mode: layer.mode,
    active: layer.get('opacity') > 0.001,
    get: (key) => layer.get(key),
  }));
  const tips = diagnoseReadable({ params, mods: matrix, layers: views, audible: hear });
  const signs = [];
  const listening = views.filter((layer) => (
    layer.active && hear(layer.id) && (layer.get('audioBind') | 0) !== 4 && layer.get('reactivity') > 0.6
  ));
  const byBand = new Map();
  for (const layer of listening) {
    const band = layer.get('audioBind') | 0;
    const group = byBand.get(band) || [];
    group.push(layer.id);
    byBand.set(band, group);
  }
  for (const [band, ids] of byBand) {
    if (ids.length < 2) continue;
    const text = `Clash: layers ${ids.join(' and ')} share ${BAND_LABELS[band]} with reactivity above 0.6.`;
    for (const id of ids) signs.push({ layer: id, kind: 'Clash', text });
  }
  for (const layer of views) {
    if (!layer.active || !hear(layer.id)) continue;
    if (layer.get('reactivity') > 1.3) {
      signs.push({
        layer: layer.id,
        kind: 'Over',
        text: `Over: layer ${layer.id} reactivity is above 1.3.`,
      });
    }
    const opacityRoute = matrix.get(layerParam(layer.id, 'opacity'));
    if (opacityRoute && opacityRoute.route !== 'none' && opacityRoute.depth > 0.85 && opacityRoute.gate < 0.2) {
      signs.push({
        layer: layer.id,
        kind: 'Over',
        text: `Over: layer ${layer.id} opacity depth is above 0.85 with a gate under 0.2.`,
      });
    }
    if (KICK_MODES.has(layer.mode) && layer.get('beatSync') > 0.35) {
      signs.push({
        layer: layer.id,
        kind: 'Destroy',
        text: `Destroy: Layer ${layer.id} Beat Sync is overriding the kick on a look that already follows it.`,
      });
    }
    if (KICK_MODES.has(layer.mode) && ((layer.get('audioBind') | 0) === 2 || (layer.get('audioBind') | 0) === 3)) {
      signs.push({
        layer: layer.id,
        kind: 'Silent',
        text: `Silent: layer ${layer.id} follows the kick, and ${BAND_LABELS[layer.get('audioBind') | 0]} will not deliver it.`,
      });
    }
    for (const key of KICK_DRIVEN) {
      const id = layerParam(layer.id, key);
      const def = params.defs.get(id);
      if (!controlShown(layer.engine, layer.mode, def)) continue;
      const mod = matrix.get(id);
      if (!mod || mod.route === 'none' || Math.abs(mod.depth) <= 0.001) continue;
      const label = def?.friendlyLabel || def?.label || key;
      signs.push({
        layer: layer.id,
        kind: 'Destroy',
        text: `Destroy: Layer ${layer.id} ${label} has a matrix route overriding the kick that already moves it.`,
      });
    }
  }
  const strobe = Number(params.get('strobe')) || 0;
  const strobeSrc = params.get('strobeSrc') | 0;
  if (strobe > 0.15 && strobeSrc === 1) {
    const synced = views.filter((layer) => layer.active && hear(layer.id) && layer.get('beatSync') > 0);
    if (synced.length) {
      signs.push({
        layer: synced[0].id,
        kind: 'Destroy',
        text: `Destroy: Strobe on Beat Pulse is overriding Beat Sync on layer ${synced.map((layer) => layer.id).join(' and ')}.`,
      });
    }
  }
  return mergeTips(signs, tips);
}
