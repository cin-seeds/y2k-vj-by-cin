// Per-slider audio routing. The stored slider stays put; each frame adds
// depth * gated(signal) * (max - min), then clamps.

import { bindRangeReadout } from '../ui/NumericSlider.js';

const STORAGE_KEY = 'vj.modMatrix';

export const MOD_ROUTES = [
  { id: 'none', label: 'None' },
  { id: 'sub', label: 'Sub-Bass' },
  { id: 'punch', label: 'Punch' },
  { id: 'mid', label: 'Mids' },
  { id: 'treble', label: 'Treble' },
  { id: 'peak', label: 'Peak Flash' },
  { id: 'beat', label: 'BPM Pulse' },
  { id: 'energy', label: 'Song Energy' },
  { id: 'break', label: 'Breakdown State' },
  { id: 'drop', label: 'Drop Pulse' },
  { id: 'onset', label: 'Beat / Onset' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function gated(signal, gate) {
  const s = clamp(signal || 0, 0, 1);
  const g = clamp(gate || 0, 0, 1);
  if (s < g) return 0;
  if (g >= 0.999) return s >= 0.999 ? 1 : 0;
  return (s - g) / (1 - g);
}

export function signalOf(route, audio, beat) {
  const n = (v) => clamp(v || 0, 0, 1);
  switch (route) {
    case 'sub': return n(audio.sub);
    case 'punch': return n(audio.punch);
    case 'mid': return n(audio.mid);
    case 'treble': return n(audio.treble);
    case 'peak': return n(audio.peakFlash);
    case 'beat': return n(beat);
    case 'energy': return n(audio.songEnergy);
    case 'break': return n(audio.isBreakdown);
    case 'drop': return n(audio.dropPulse);
    case 'onset': return n(audio.beatPulse);
    default: return 0;
  }
}

export class ModMatrix {
  constructor() {
    this.lanes = new Map();
    this.watchers = new Set();
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const [id, lane] of Object.entries(raw)) {
        if (!lane || typeof lane !== 'object') continue;
        this.lanes.set(id, {
          route: MOD_ROUTES.some((r) => r.id === lane.route) ? lane.route : 'none',
          depth: clamp(Number(lane.depth) || 0, -1, 1),
          gate: clamp(Number(lane.gate) || 0, 0, 1),
        });
      }
    } catch { /* ignore a bad save */ }
  }

  toJSON() {
    return Object.fromEntries(this.lanes);
  }

  replace(raw) {
    this.lanes.clear();
    if (raw && typeof raw === 'object') {
      for (const [id, lane] of Object.entries(raw)) {
        if (!lane || typeof lane !== 'object') continue;
        this.lanes.set(id, {
          route: MOD_ROUTES.some((r) => r.id === lane.route) ? lane.route : 'none',
          depth: clamp(Number(lane.depth) || 0, -1, 1),
          gate: clamp(Number(lane.gate) || 0, 0, 1),
        });
      }
    }
    this.#save();
    for (const fn of this.watchers) fn();
  }

  get(id) {
    return this.lanes.get(id) || { route: 'none', depth: 0, gate: 0 };
  }

  set(id, patch) {
    const prev = this.get(id);
    const next = {
      route: patch.route ?? prev.route,
      depth: patch.depth ?? prev.depth,
      gate: patch.gate ?? prev.gate,
    };
    if (prev.route === 'none' && next.route !== 'none' && next.depth === 0) next.depth = 0.5;
    next.depth = clamp(next.depth, -1, 1);
    next.gate = clamp(next.gate, 0, 1);
    if (next.route === 'none' && next.depth === 0 && next.gate === 0) this.lanes.delete(id);
    else this.lanes.set(id, next);
    this.#save();
    this.touch();
    return next;
  }

  touch() {
    for (const fn of this.watchers) fn();
  }

  #save() {
    const out = {};
    for (const [id, lane] of this.lanes) out[id] = lane;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch { /* private mode */ }
  }

  /**
   * Audio added onto whatever is already in `live` (the LFO result, or the slider).
   * Prefer LfoEngine.update, which adds LFO and audio to the slider in one clamp.
   * This path is for a live map that does not already include audio.
   */
  apply(params, live, audio, beat) {
    for (const [id, lane] of this.lanes) {
      if (!lane.route || lane.route === 'none' || !lane.depth) continue;
      const def = params.defs.get(id);
      if (!def || def.options) continue;
      const base = params.get(id);
      const lfoTerm = (live.has(id) ? live.get(id) : base) - base;
      const span = def.max - def.min;
      let out = base + lfoTerm + lane.depth * gated(signalOf(lane.route, audio, beat), lane.gate) * span;
      out = clamp(out, def.min, def.max);
      if (def.step) out = Math.round(out / def.step) * def.step;
      out = clamp(out, def.min, def.max);
      live.set(id, out);
    }
  }

  /** Same math for a control that is not a ParamStore entry (the HUD font scale). */
  modulate(range, base, id, audio, beat) {
    const lane = this.get(id);
    if (!lane.route || lane.route === 'none' || !lane.depth) return base;
    const span = range.max - range.min;
    const out = base + lane.depth * gated(signalOf(lane.route, audio, beat), lane.gate) * span;
    return clamp(out, range.min, range.max);
  }
}

/** Route, depth, and gate for one slider. Depth is signed; gate is 0..1. */
export function createModRow(mods, id, history) {
  const box = document.createElement('div');
  box.className = 'mod-row';

  const route = document.createElement('select');
  route.className = 'mod-route';
  route.title = 'Audio routing. The slider stays put; this signal moves the live value.';
  MOD_ROUTES.forEach((r) => route.add(new Option(r.label, r.id)));

  const depthWrap = document.createElement('div');
  depthWrap.className = 'mod-depth';
  const depthLabel = document.createElement('span');
  depthLabel.textContent = 'Depth';
  const depth = document.createElement('input');
  depth.type = 'range';
  depth.min = '-1';
  depth.max = '1';
  depth.step = '0.01';
  depth.title = 'Mod depth. Negative inverts the audio signal.';
  const depthOut = document.createElement('output');

  const gateWrap = document.createElement('div');
  gateWrap.className = 'mod-gate';
  const gateLabel = document.createElement('span');
  gateLabel.textContent = 'Gate';
  const gate = document.createElement('input');
  gate.type = 'range';
  gate.min = '0';
  gate.max = '1';
  gate.step = '0.01';
  gate.title = 'Gate threshold. Modulation stays off until the signal passes this level.';
  const gateOut = document.createElement('output');

  const paint = (lane) => {
    route.value = lane.route;
    if (document.activeElement !== depth) depth.value = String(lane.depth);
    if (document.activeElement !== gate) gate.value = String(lane.gate);
    depthOut.textContent = `${lane.depth >= 0 ? '+' : ''}${lane.depth.toFixed(2)}`;
    gateOut.textContent = `${Math.round(lane.gate * 100)}%`;
    box.classList.toggle('on', lane.route !== 'none');
  };

  const note = (prev, kind) => {
    history?.edit(`mod:${id}`, prev, structuredClone(mods.get(id)), (lane) => {
      mods.set(id, lane);
    }, kind);
  };
  route.addEventListener('change', () => {
    const prev = structuredClone(mods.get(id));
    paint(mods.set(id, { route: route.value }));
    note(prev, 'commit');
  });
  depth.addEventListener('input', () => {
    const prev = structuredClone(mods.get(id));
    paint(mods.set(id, { depth: Number(depth.value) }));
    note(prev, 'drag');
  });
  gate.addEventListener('input', () => {
    const prev = structuredClone(mods.get(id));
    paint(mods.set(id, { gate: Number(gate.value) }));
    note(prev, 'drag');
  });
  depth.addEventListener('change', () => history?.commit());
  gate.addEventListener('change', () => history?.commit());
  bindRangeReadout(depthOut, depth);
  bindRangeReadout(gateOut, gate);

  depthWrap.append(depthLabel, depth, depthOut);
  gateWrap.append(gateLabel, gate, gateOut);
  box.dataset.mod = id;
  box.append(route, depthWrap, gateWrap);
  paint(mods.get(id));
  mods.watchers?.add(() => paint(mods.get(id)));
  return box;
}
