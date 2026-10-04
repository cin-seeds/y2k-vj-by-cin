// Hardcoded Akai APC Mini MK2 map. Channel 1 (status nibble 0).
// Grid notes 0–63, y = 0 along the faders. LEDs are note-on velocities:
// 0 off, 1 green, 3 red, 5 amber — the MK2 basic color table.

import { layerParam } from '../params.js';

export const LED = { off: 0, green: 1, red: 3, amber: 5 };

export const PAGE_NOTES = { 112: 0, 113: 1 };
export const MOMENT_NOTES = { 64: 'strobe', 65: 'y2k', 66: 'shatter', 67: 'invert' };
export const FADER_CC = { 48: 'A', 49: 'B', 50: 'C', 56: 'master' };

const SCALES = [0.5, 1, 2];
const LAYER_COLOR = { A: '#00f0ff', B: '#ff2bd6', C: '#ffd23f' };

export function nextScale(current) {
  const i = SCALES.findIndex((s) => Math.abs(s - current) < 0.05);
  return SCALES[(i + 1) % SCALES.length];
}

export function nextHudSize(current) {
  const steps = [12, 16, 20, 24, 28, 32, 36];
  const i = steps.findIndex((s) => s > current + 0.5);
  return i < 0 ? steps[0] : steps[i];
}

const blank = () => ({ tag: '', name: '—', empty: true, on: false, color: '', led: LED.off, apply: null });

function scalePad(layer, ctx) {
  const cur = ctx.get(layer, 'scale');
  const shown = SCALES.reduce((best, s) => (Math.abs(s - cur) < Math.abs(best - cur) ? s : best), SCALES[1]);
  return {
    tag: layer,
    name: `${shown.toFixed(1)}x`,
    empty: false,
    on: true,
    color: LAYER_COLOR[layer],
    led: LED.green,
    apply: () => ctx.setScale(layer, nextScale(cur)),
  };
}

/** What one grid pad does on the current page, plus the LED it should show. */
export function describePad(note, page, ctx) {
  if (page === 0) {
    const scene = ctx.scenes[note];
    const on = !!scene && scene.id === ctx.activeId;
    return {
      tag: String(note + 1).padStart(2, '0'),
      name: scene?.name || 'Empty',
      empty: !scene,
      on,
      color: scene?.color || '',
      led: !scene ? LED.off : on ? LED.green : LED.amber,
      apply: scene ? () => ctx.launch(scene.id) : null,
    };
  }
  if (note <= 47) {
    const layer = note < 16 ? 'A' : note < 32 ? 'B' : 'C';
    const file = ctx.clips[note % 16];
    const on = !!file && ctx.media[layer]?.key === `file:${file}`;
    return {
      tag: layer,
      name: file || 'Empty',
      empty: !file,
      on,
      color: file ? LAYER_COLOR[layer] : '',
      led: !file ? LED.off : on ? LED.green : LED.amber,
      apply: file ? () => ctx.setClip(layer, file) : null,
    };
  }
  if (note === 48) return { tag: 'AB', name: 'Swap AB', empty: false, on: false, color: '#d7e3ff', led: LED.amber, apply: () => ctx.swap('A', 'B') };
  if (note === 49) return { tag: 'BC', name: 'Swap BC', empty: false, on: false, color: '#d7e3ff', led: LED.amber, apply: () => ctx.swap('B', 'C') };
  if (note === 50) return scalePad('A', ctx);
  if (note === 51) return scalePad('B', ctx);
  if (note === 52) return scalePad('C', ctx);
  if (note === 56) {
    const on = !!ctx.hud.on;
    return { tag: 'SYS', name: on ? 'HUD On' : 'HUD Off', empty: false, on, color: '#d7e3ff', led: on ? LED.green : LED.amber, apply: () => ctx.toggleHud() };
  }
  if (note === 57) return { tag: 'SYS', name: 'Size', empty: false, on: false, color: '#d7e3ff', led: LED.amber, apply: () => ctx.stepSize() };
  if (note === 58) return { tag: 'SYS', name: 'Theme', empty: false, on: false, color: '#d7e3ff', led: LED.amber, apply: () => ctx.stepTheme() };
  return blank();
}

/** Notes the controller should light for this page, including page and track buttons. */
export function ledMap(page, ctx) {
  const out = new Map();
  for (let note = 0; note < 64; note++) out.set(note, describePad(note, page, ctx).led);
  for (const [note, id] of Object.entries(MOMENT_NOTES)) {
    out.set(Number(note), ctx.held.has(id) ? LED.red : LED.amber);
  }
  out.set(112, page === 0 ? LED.green : LED.amber);
  out.set(113, page === 1 ? LED.green : LED.amber);
  return out;
}

export function paramIdForFader(id) {
  return id === 'master' ? 'master' : layerParam(id, 'opacity');
}

/** Sends only the LEDs that changed, and only to an APC / Akai output. */
export class ApcLeds {
  constructor(getOutputs) {
    this.getOutputs = getOutputs;
    this.sent = new Map();
    this.portKey = '';
  }

  reset() {
    this.sent.clear();
  }

  /** Call when the port list changes so a newly connected MK2 gets a full picture. */
  syncPorts() {
    const key = this.#ports().map((p) => p.id || p.name).join('|');
    if (key !== this.portKey) {
      this.portKey = key;
      this.reset();
    }
  }

  flush(desired) {
    this.syncPorts();
    const ports = this.#ports();
    if (!ports.length) return;
    for (const [note, vel] of desired) {
      if (this.sent.get(note) === vel) continue;
      this.sent.set(note, vel);
      const bytes = [0x90, note & 0x7f, vel & 0x7f];
      for (const port of ports) {
        try { port.send(bytes); } catch { /* port dropped */ }
      }
    }
  }

  #ports() {
    return this.getOutputs().filter((p) => p.state !== 'disconnected' && /apc|akai/i.test(p.name || ''));
  }
}
