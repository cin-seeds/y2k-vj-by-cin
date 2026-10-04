// Fixed reactivity recipes. They write reactivity, audio band, beat sync, and
// at most one mod-matrix lane. Mode, opacity, blend, and the shaders stay put.

import { ENGINE_FX, ENGINE_HYDRA, ENGINE_PARTICLES } from '../engines/constants.js';
import { layerParam } from '../params.js';

export const BAND = { all: 0, bass: 1, mids: 2, treble: 3, off: 4 };

/** Natural audio band per look. Particles and Hydra engines also use bass. */
export const NATURAL_BANDS = {
  bass: ['glitch', 'y2k', 'dither', 'eater', 'starfield', 'flash', 'ps1', 'win98', 'ascii', 'points', 'mesh'],
  treble: ['vhs', 'retro'],
  off: ['clean', 'minidv'],
};

const BASS_MODES = new Set(NATURAL_BANDS.bass);
const TREBLE_MODES = new Set(NATURAL_BANDS.treble);

export const KICK_MODES = new Set(NATURAL_BANDS.bass);

/** Sliders the shader already moves from bass or kick. A matrix route on these is a second listen. */
export const KICK_DRIVEN = ['glitch', 'feedback', 'bite', 'warp', 'pixelSize', 'pSpeed'];

/** Accent targets for recipe matrix routes. Never glitch / feedback / bite / warp / pixelSize / pSpeed. */
export const ACCENT_SLIDERS = [
  'hueShift', 'clouds', 'edgeGlow', 'chew', 'grid', 'porthole', 'flash',
  'hHue', 'hZoom', 'pointSize', 'tapeJitter', 'smear', 'asciiSize', 'winTrail',
];

const ACCENTS = ACCENT_SLIDERS;
const AUDIO_KEYS = ['reactivity', 'audioBind', 'beatSync'];
const ACCENT_DEPTH_MAX = 0.5;
const ACCENT_GATE_MIN = 0.2;

/** Natural band index for an engine + mode. Hydra accents stay on hHue / hZoom only. */
export function naturalBandFor(engine, mode) {
  if (engine === ENGINE_PARTICLES || engine === ENGINE_HYDRA) return BAND.bass;
  if (engine === ENGINE_FX && NATURAL_BANDS.off.includes(mode)) return BAND.off;
  if (TREBLE_MODES.has(mode)) return BAND.treble;
  if (BASS_MODES.has(mode)) return BAND.bass;
  return BAND.bass;
}

/** True when this look shows the control. Hydra accents are only Trail Hue and Zoom Bleed. */
export function controlShown(engine, mode, def) {
  if (!def) return false;
  const key = def.key;
  if (key === 'reactivity' || key === 'audioBind' || key === 'beatSync') {
    const fx = engine === ENGINE_FX && mode !== 'clean' && mode !== 'minidv';
    const swarm = engine === ENGINE_PARTICLES;
    const hydra = engine === ENGINE_HYDRA;
    return key === 'reactivity' ? (fx || swarm) : (fx || swarm || hydra);
  }
  if (engine === ENGINE_HYDRA && def.group === 'hydra') return key === 'hHue' || key === 'hZoom';
  if (def.modes) return engine === ENGINE_FX && def.modes.includes(mode);
  if (engine === ENGINE_FX && def.group === mode) return true;
  if (engine === ENGINE_PARTICLES && def.group === 'particles') return true;
  return false;
}

export function describeLayer(layer, params) {
  const engine = layer.engine;
  const mode = layer.mode;
  const shown = {};
  for (const key of [...AUDIO_KEYS, ...ACCENTS, ...KICK_DRIVEN]) {
    shown[key] = controlShown(engine, mode, params.defs.get(layerParam(layer.id, key)));
  }
  return {
    id: layer.id,
    opacity: layer.get('opacity'),
    engine,
    mode,
    shown,
  };
}

function silent(layer) {
  return layer.engine === ENGINE_FX && (layer.mode === 'clean' || layer.mode === 'minidv');
}

function naturalBand(layer) {
  return naturalBandFor(layer.engine, layer.mode);
}

function otherBand(band) {
  if (band === BAND.bass) return BAND.treble;
  if (band === BAND.treble) return BAND.bass;
  return BAND.bass;
}

function loudest(layers) {
  return layers.reduce((best, layer) => (layer.opacity > best.opacity ? layer : best));
}

function accentChoices(layer) {
  if (silent(layer)) return [];
  return ACCENTS.filter((key) => {
    if (layer.engine === ENGINE_HYDRA && key !== 'hHue' && key !== 'hZoom') return false;
    return !!layer.shown[key];
  });
}

function accentKey(layer) {
  const choices = accentChoices(layer);
  if (!choices.length) return null;
  return choices[Math.floor(Math.random() * choices.length)];
}

function audioOpen(layer) {
  return layer.shown.reactivity && layer.shown.audioBind && layer.shown.beatSync;
}

function kickTear(layers) {
  if (!layers.every(audioOpen)) return null;
  const lead = loudest(layers);
  return {
    name: 'Kick tear',
    writes: layers.map((layer) => ({
      id: layer.id,
      reactivity: layer === lead ? 1 : 0.45,
      audioBind: layer === lead ? BAND.bass : BAND.treble,
      beatSync: 0,
      lane: null,
    })),
  };
}

function splitBands(layers) {
  if (!layers.every(audioOpen)) return null;
  const binds = [BAND.bass, BAND.mids, BAND.treble];
  const levels = [0.85, 0.55, 0.45];
  return {
    name: 'Split bands',
    writes: layers.map((layer, i) => ({
      id: layer.id,
      reactivity: levels[Math.min(i, levels.length - 1)],
      audioBind: binds[Math.min(i, binds.length - 1)],
      beatSync: 0,
      lane: null,
    })),
  };
}

function accentPlan(layers, { name, reactivity, route, depth, gate, others }) {
  const lead = loudest(layers);
  if (silent(lead) || !lead.shown.reactivity || !lead.shown.audioBind) return null;
  const key = accentKey(lead);
  if (!key) return null;
  const band = naturalBand(lead);
  const writes = [{
    id: lead.id,
    reactivity,
    audioBind: band,
    beatSync: null,
    lane: { key, route, depth, gate },
  }];
  if (!others) return { name, writes };
  for (const layer of layers) {
    if (layer === lead) continue;
    if (!layer.shown.reactivity || !layer.shown.audioBind) return null;
    writes.push({
      id: layer.id,
      reactivity: 0.4,
      audioBind: others === 'natural' ? naturalBand(layer) : otherBand(band),
      beatSync: null,
      lane: null,
    });
  }
  return { name, writes };
}

function oneDrop(layers) {
  return accentPlan(layers, {
    name: 'One drop',
    reactivity: 0.7,
    route: 'drop',
    depth: 0.5,
    gate: 0.3,
    others: 'alt',
  });
}

function peakAccent(layers) {
  return accentPlan(layers, {
    name: 'Peak accent',
    reactivity: 0.8,
    route: 'peak',
    depth: 0.5,
    gate: 0.4,
    others: 'natural',
  });
}

function quietListen(layers) {
  const writes = [];
  for (const layer of layers) {
    if (silent(layer)) {
      writes.push({
        id: layer.id,
        reactivity: 0,
        audioBind: BAND.off,
        beatSync: 0,
        lane: null,
      });
      continue;
    }
    if (!audioOpen(layer)) return null;
    writes.push({
      id: layer.id,
      reactivity: 0.45,
      audioBind: naturalBand(layer),
      beatSync: 0,
      lane: null,
    });
  }
  return { name: 'Quiet listen', writes };
}

function clockHold(layers) {
  if (!layers.every((layer) => layer.shown.beatSync)) return null;
  const lead = loudest(layers);
  if (!lead.shown.reactivity) return null;
  return {
    name: 'Clock hold',
    writes: layers.map((layer) => ({
      id: layer.id,
      reactivity: layer === lead ? 0.5 : null,
      audioBind: null,
      beatSync: layer === lead ? 0.5 : 0,
      lane: null,
    })),
  };
}

export const RECIPES = [kickTear, splitBands, oneDrop, peakAccent, quietListen, clockHold];

function capture(writes, params, mods) {
  const ids = [...new Set(writes.map((w) => w.id))];
  const values = {};
  const lanes = {};
  for (const id of ids) {
    for (const key of AUDIO_KEYS) {
      const pid = layerParam(id, key);
      values[pid] = params.get(pid);
    }
  }
  for (const [pid, lane] of mods.lanes) {
    const def = params.defs.get(pid);
    if (def?.layer && ids.includes(def.layer)) lanes[pid] = { route: lane.route, depth: lane.depth, gate: lane.gate };
  }
  return { ids, values, lanes };
}

function applyPlan(plan, params, mods) {
  const touched = new Set(plan.writes.map((w) => w.id));
  for (const w of plan.writes) {
    if (w.reactivity != null) params.set(layerParam(w.id, 'reactivity'), w.reactivity);
    if (w.audioBind != null) params.set(layerParam(w.id, 'audioBind'), w.audioBind);
    if (w.beatSync != null) params.set(layerParam(w.id, 'beatSync'), w.beatSync);
  }
  for (const pid of [...mods.lanes.keys()]) {
    const def = params.defs.get(pid);
    if (!def?.layer || !touched.has(def.layer)) continue;
    const keep = plan.writes.some((w) => w.lane && layerParam(w.id, w.lane.key) === pid);
    if (keep) continue;
    mods.set(pid, { route: 'none', depth: 0, gate: 0 });
  }
  for (const w of plan.writes) {
    if (!w.lane) continue;
    // Accents stay within the recipe bounds: depth ≤ 0.5, gate ≥ 0.2.
    const depth = Math.min(ACCENT_DEPTH_MAX, Math.max(-ACCENT_DEPTH_MAX, Number(w.lane.depth) || 0));
    const gate = Math.max(ACCENT_GATE_MIN, Math.min(1, Number(w.lane.gate) || 0));
    mods.set(layerParam(w.id, w.lane.key), { route: w.lane.route, depth, gate });
  }
  for (const fn of mods.watchers || []) fn();
}

function restore(snap, params, mods) {
  for (const [pid, value] of Object.entries(snap.values)) params.set(pid, value);
  for (const pid of [...mods.lanes.keys()]) {
    const def = params.defs.get(pid);
    if (def?.layer && snap.ids.includes(def.layer)) mods.set(pid, { route: 'none', depth: 0, gate: 0 });
  }
  for (const [pid, lane] of Object.entries(snap.lanes)) mods.set(pid, lane);
  for (const fn of mods.watchers || []) fn();
}

export class ReactivityRoller {
  constructor(params, mods) {
    this.params = params;
    this.mods = mods;
    this.last = -1;
    this.label = '';
    this.undo = [];
  }

  get canBack() {
    return this.undo.length > 0;
  }

  reset() {
    this.last = -1;
    this.label = '';
    this.undo.length = 0;
  }

  /** Next recipe that fits the visible layers. Skips the one just applied. */
  roll(layers) {
    const visible = layers.map((layer) => describeLayer(layer, this.params)).filter((layer) => layer.opacity > 0.001);
    if (!visible.length) return null;
    for (let step = 1; step <= RECIPES.length; step++) {
      const index = (this.last + step) % RECIPES.length;
      if (this.last >= 0 && index === this.last) continue;
      const plan = RECIPES[index](visible);
      if (!plan) continue;
      this.undo.push({
        snap: capture(plan.writes, this.params, this.mods),
        applied: plan.name,
        index,
      });
      applyPlan(plan, this.params, this.mods);
      this.last = index;
      this.label = plan.name;
      return plan;
    }
    return null;
  }

  back() {
    const entry = this.undo.pop();
    if (!entry) return false;
    restore(entry.snap, this.params, this.mods);
    const prev = this.undo[this.undo.length - 1];
    this.last = prev ? prev.index : -1;
    this.label = prev ? prev.applied : '';
    return true;
  }
}
