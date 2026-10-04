// Per-parameter LFOs. The ParamStore keeps the performer's base value (slider,
// MIDI, scene); this engine writes a modulated live value onto uniforms only.

import { finalValue, lfoWave } from '../mod/route.js';
import { gated, signalOf } from '../audio/ModMatrix.js';

const STORAGE_KEY = 'vj.lfos';

export const LFO_SHAPES = ['Sine', 'Triangle', 'Sawtooth', 'Square', 'Random / Noise'];

export const LFO_RATES = [
  { id: '1/16', label: '1/16', beats: 0.25 },
  { id: '1/8', label: '1/8', beats: 0.5 },
  { id: '1/4', label: '1/4', beats: 1 },
  { id: '1/2', label: '1/2', beats: 2 },
  { id: '1bar', label: '1 bar', beats: 4 },
  { id: '2bar', label: '2 bars', beats: 8 },
  { id: '4bar', label: '4 bars', beats: 16 },
  { id: '0.25hz', label: '0.25 Hz', hz: 0.25 },
  { id: '0.5hz', label: '0.5 Hz', hz: 0.5 },
  { id: '1hz', label: '1 Hz', hz: 1 },
  { id: '2hz', label: '2 Hz', hz: 2 },
];

export const isAutomatable = (def) => !!def && !def.options && def.min < def.max;

/** Map a -1..1 wave into the 0..1 automation pocket. Full 0..1 bounds keep a full sweep. */
export function pocketUnit(signal, minBound = 0, maxBound = 1, amount = 1) {
  const norm = (Number(signal) + 1) * 0.5;
  let lo = Number(minBound);
  let hi = Number(maxBound);
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = 1;
  lo = Math.min(1, Math.max(0, lo));
  hi = Math.min(1, Math.max(0, hi));
  if (hi < lo) [lo, hi] = [hi, lo];
  const depth = Math.min(1, Math.max(0, Number.isFinite(Number(amount)) ? Number(amount) : 0));
  const center = (lo + hi) * 0.5;
  return center + (Math.min(1, Math.max(0, norm)) - 0.5) * (hi - lo) * depth;
}

function unitBound(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

export class LfoEngine {
  constructor() {
    this.lanes = new Map();
    this.live = new Map();
    this.scratch = new Set();
    this.phase = 0;
    this.drivenBeats = 0;
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const [id, lane] of Object.entries(raw)) {
        if (lane && typeof lane === 'object') this.lanes.set(id, this.#normalize(lane));
      }
    } catch {
      /* ignore a corrupt save */
    }
  }

  get(id) {
    return this.lanes.get(id) ?? null;
  }

  isOn(id) {
    return !!this.lanes.get(id)?.on;
  }

  set(id, patch) {
    const lane = this.#normalize({ ...(this.lanes.get(id) || {}), ...patch });
    this.lanes.set(id, lane);
    this.#save();
    return lane;
  }

  toJSON() {
    return Object.fromEntries(this.lanes);
  }

  replace(raw) {
    this.lanes.clear();
    if (raw && typeof raw === 'object') {
      for (const [id, lane] of Object.entries(raw)) {
        if (lane && typeof lane === 'object') this.lanes.set(id, this.#normalize(lane));
      }
    }
    this.#save();
  }

  toggle(id) {
    const existing = this.lanes.get(id);
    const on = !existing?.on;
    this.set(id, existing ? { on } : { on, amount: 1 });
    return on;
  }

  /**
   * `now` and `dt` are the composition clock: an integral of scaled frame steps,
   * not wall time. Hz rates read `now`. Musical rates advance from `dt` so a
   * speed change does not multiply the phase already elapsed.
   * Returns the map of paramId -> live value for this frame.
   */
  update({ now = 0, dt = 0, beats, bpm = 120, params, audio = null, beat = 0, mods = null }) {
    const step = Math.min(Math.max(Number(dt) || 0, 0), 0.5);
    this.drivenBeats += (step * (Number(bpm) || 0)) / 60;
    this.live.clear();
    const ids = this.scratch;
    ids.clear();
    for (const id of this.lanes.keys()) ids.add(id);
    if (mods) for (const id of mods.lanes.keys()) ids.add(id);
    for (const id of ids) {
      const def = params.defs.get(id);
      if (!isAutomatable(def)) continue;
      const lane = this.lanes.get(id);
      let lfoSignal = 0;
      let lfoAmount = 0;
      if (lane?.on) {
        const rate = LFO_RATES[lane.rate] || LFO_RATES[2];
        const phase = rate.hz
          ? now * rate.hz
          : this.drivenBeats / Math.max(rate.beats, 1e-4);
        lfoSignal = lfoWave(lane.shape, phase, Math.floor(phase));
        lfoAmount = lane.amount;
      }
      let audioSignal = 0;
      let audioDepth = 0;
      if (mods && audio) {
        const mod = mods.get(id);
        if (mod.route !== 'none' && mod.depth) {
          audioSignal = gated(signalOf(mod.route, audio, beat), mod.gate);
          audioDepth = mod.depth;
        }
      }
      if (!lfoAmount && !audioDepth) continue;
      const base = params.get(id);
      if (lane?.on && lfoAmount) {
        const span = def.max - def.min || 1;
        const unit = pocketUnit(lfoSignal, lane.minBound, lane.maxBound, lfoAmount);
        const pocketValue = def.min + unit * span;
        const equiv = (pocketValue - base) / (span * 0.5);
        this.live.set(id, finalValue(def, base, equiv, 1, audioSignal, audioDepth));
      } else {
        this.live.set(id, finalValue(def, base, lfoSignal, lfoAmount, audioSignal, audioDepth));
      }
    }
    return this.live;
  }

  #normalize(lane) {
    const raw = Number(lane.amount);
    let minBound = unitBound(lane.minBound, 0);
    let maxBound = unitBound(lane.maxBound, 1);
    if (maxBound < minBound) [minBound, maxBound] = [maxBound, minBound];
    return {
      on: !!lane.on,
      shape: Math.min(4, Math.max(0, Math.round(Number(lane.shape) || 0))),
      rate: Math.min(LFO_RATES.length - 1, Math.max(0, Math.round(Number(lane.rate) || 2))),
      amount: Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 1)),
      minBound,
      maxBound,
    };
  }

  #save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.lanes)));
    } catch {
      /* storage full */
    }
  }
}
