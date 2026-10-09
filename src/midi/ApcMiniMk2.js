// Hardcoded Akai APC Mini MK2 map. Channel 1 (status nibble 0).
// Grid notes 0–63, y = 0 along the faders. Scene notes 112–119 run top to bottom.
// Track notes 100–107 sit under the grid, left to right. Shift is note 122.
// Grid LEDs are RGB on channel 7 (status 0x96, full brightness). Palette
// velocity: 21 green, 5 red, 9 amber, 0 off.
// Track buttons 100–107 and scene buttons 112–119 are single-colour on
// 0x90: velocity 1 when lit, otherwise 0.

import { LAYERS, MODE_LABELS, layerParam } from '../params.js';

export const LED = { off: 0, green: 21, red: 5, amber: 9 };

export const SHIFT_NOTE = 122;
export const MOMENT_IDS = ['strobe', 'y2k', 'shatter', 'invert', 'glitch'];

const LAYER_COLOR = { A: '#00f0ff', B: '#ff2bd6', C: '#ffd23f' };
const BANK_MAX = 256;

export const FADERS = [
  { cc: 48, id: 'A', tag: 'F1', label: 'Layer A', max: 1 },
  { cc: 49, id: 'B', tag: 'F2', label: 'Layer B', max: 1 },
  { cc: 50, id: 'C', tag: 'F3', label: 'Layer C', max: 1 },
  { cc: 51, id: 'speed', tag: 'F4', label: 'Master Speed', max: 4 },
  { cc: 52, id: 'fade', tag: 'F5', label: 'Fade', max: 10 },
  { cc: 53, id: 'gain', tag: 'F6', label: 'Audio Gain', max: 4 },
  { cc: 54, id: 'macro1', tag: 'F7', label: 'Macro 1', max: 1, macro: 0 },
  { cc: 55, id: 'macro2', tag: 'F8', label: 'Macro 2', max: 1, macro: 1 },
  { cc: 56, id: 'master', tag: 'F9', label: 'Master', max: 1 },
];

const FADER_BY_CC = Object.fromEntries(FADERS.map((f) => [f.cc, f]));

export function faderByCc(cc) {
  return FADER_BY_CC[cc] || null;
}

export function nextHudSize(current) {
  const steps = [12, 16, 20, 24, 28, 32, 36];
  const i = steps.findIndex((s) => s > current + 0.5);
  return i < 0 ? steps[0] : steps[i];
}

const blank = () => ({ tag: '', name: '—', empty: true, on: false, color: '', led: LED.off, hold: false, apply: null });

function modePad(layer, mode, ctx) {
  if (mode < 0 || mode >= MODE_LABELS.length) return blank();
  const on = ctx.get(layer, 'mode') === mode;
  return {
    tag: `${layer}${mode + 1}`,
    name: MODE_LABELS[mode],
    empty: false,
    on,
    color: LAYER_COLOR[layer],
    led: on ? LED.green : LED.amber,
    hold: false,
    apply: () => ctx.setMode(layer, mode),
  };
}

function categoryPad(kind, x, ctx) {
  const name = ctx.categories[x];
  if (!name) return blank();
  const layer = ctx.layer;
  if (kind === 'mute') {
    const on = ctx.categoryMuted(layer, name);
    return {
      tag: 'MUTE',
      name,
      empty: false,
      on,
      color: LAYER_COLOR[layer] || '#d7e3ff',
      led: on ? LED.red : LED.amber,
      hold: false,
      apply: () => ctx.toggleCategory(layer, name),
    };
  }
  return {
    tag: 'SHUF',
    name,
    empty: false,
    on: false,
    color: '#d7e3ff',
    led: LED.amber,
    hold: false,
    apply: () => ctx.shuffleCategory(layer, name),
  };
}

function shiftCompositionPad(note, ctx) {
  const bottom = [
    ['C1', () => ctx.recallComp?.(0)],
    ['C2', () => ctx.recallComp?.(1)],
    ['C3', () => ctx.recallComp?.(2)],
    ['Shuffle', () => ctx.shuffleLayer?.()],
    ['Clear', () => ctx.clearComposition?.()],
    ['Still', () => ctx.launchPack?.('still')],
    ['Push', () => ctx.launchPack?.('push')],
    ['Hit', () => ctx.launchPack?.('hit')],
  ];
  if (note < 8) return amberPad(bottom[note][0], bottom[note][1]);
  const stack = (ctx.stacks || [])[note - 8];
  if (!stack) return amberPad('—', null);
  return amberPad(stack.name, () => ctx.applyStack?.(stack.id));
}

function amberPad(name, apply) {
  return {
    tag: '⇧',
    name,
    empty: false,
    on: false,
    color: '',
    led: LED.amber,
    hold: false,
    apply,
  };
}

/** What one grid pad does on the current page and bank, plus the LED it should show. */
export function describePad(note, page, ctx) {
  const x = note % 8;
  const y = Math.floor(note / 8);
  if (ctx.shift && note < 15) return shiftCompositionPad(note, ctx);
  if (page === 0) {
    // Slot index into the live saved-scene order (reorder moves which scene sits here).
    const index = ctx.bank * 64 + note;
    const scene = typeof ctx.sceneAt === 'function' ? ctx.sceneAt(index) : ctx.scenes?.[index];
    const active = !!scene && scene.id === ctx.activeId;
    const cued = !!scene && scene.id === ctx.cuedId;
    let led = LED.off;
    if (scene) led = LED.amber;
    if (active) led = ctx.pulse ? LED.green : LED.off;
    if (cued) led = ctx.blink ? LED.amber : LED.off;
    return {
      tag: String(index + 1).padStart(2, '0'),
      name: scene?.name || 'Empty',
      empty: !scene,
      on: active,
      color: scene?.color || '',
      led,
      thumb: scene?.thumb || '',
      hold: false,
      apply: scene ? () => ctx.cue(scene.id) : null,
    };
  }
  if (page === 1) {
    const layer = ctx.clipLayer || 'A';
    const file = ctx.clips[note];
    const on = !!file && ctx.media[layer]?.key === `file:${file}`;
    return {
      tag: layer,
      name: file || 'Empty',
      empty: !file,
      on,
      color: file ? LAYER_COLOR[layer] : '',
      led: !file ? LED.off : on ? LED.green : LED.amber,
      hold: false,
      apply: file ? () => ctx.setClip(layer, file) : null,
    };
  }
  if (y >= 5) return modePad(['A', 'B', 'C'][7 - y], x, ctx);
  if (y >= 2) return modePad(['A', 'B', 'C'][4 - y], 8 + x, ctx);
  if (y === 1) return categoryPad('mute', x, ctx);
  return categoryPad('shuffle', x, ctx);
}

export function trackLed(index, ctx) {
  const id = MOMENT_IDS[index];
  const held = !!(id && ctx.held.has(id));
  const layer = LAYERS[index];
  const muted = index < 3 && !!ctx.mute[layer];
  if (index >= 5 && ctx.stingOn?.(index - 5)) return 1;
  return held || muted ? 1 : 0;
}

/** Track button 100–107. Shift replaces the whole row. */
export function describeTrack(index, ctx) {
  const led = trackLed(index, ctx);
  const tag = `${ctx.shift ? '⇧' : ''}TRK${index + 1}`;
  if (ctx.shift) {
    if (index < 3) {
      const layer = LAYERS[index];
      const on = !!ctx.mute[layer];
      return { tag, name: on ? `Mute ${layer} On` : `Mute ${layer}`, led, hold: false, apply: () => ctx.toggleMute(layer) };
    }
    if (index < 6) {
      const layer = LAYERS[index - 3];
      const on = !!ctx.solo[layer];
      return { tag, name: on ? `Solo ${layer} On` : `Solo ${layer}`, led, hold: false, apply: () => ctx.toggleSolo(layer) };
    }
    if (index === 6) return { tag, name: 'Shuffle FX', led, hold: false, apply: () => ctx.shuffleLayer() };
    const on = !!ctx.hud.on;
    return { tag, name: on ? 'HUD On' : 'HUD Off', led, hold: false, apply: () => ctx.toggleHud() };
  }
  const id = MOMENT_IDS[index];
  if (id) {
    const labels = ['Strobe', 'Y2K', 'Shatter', 'Invert', 'Glitch'];
    return { tag, name: labels[index], led, hold: true, apply: (down) => ctx.moment(id, down) };
  }
  const sting = index - 5;
  const name = ctx.logoName?.(sting) || `Logo ${sting + 1}`;
  return { tag, name, led, hold: false, apply: () => ctx.sting(sting) };
}

export function sceneLed(index, ctx) {
  if (index <= 2) return ctx.page === index ? 1 : 0;
  if (index === 5) return ctx.cueMode ? 1 : 0;
  return 0;
}

/** Scene button 112–119, top to bottom. Shift changes bank-up, tap, and GO. */
export function describeScene(index, ctx) {
  const led = sceneLed(index, ctx);
  const shifted = !!ctx.shift && (index === 3 || index === 6 || index === 7);
  const tag = `${shifted ? '⇧' : ''}SCN${index + 1}`;
  if (ctx.shift && index === 3) {
    return { tag, name: ctx.follow ? 'Follow On' : 'Follow Off', led, apply: () => ctx.toggleFollow() };
  }
  if (ctx.shift && index === 6) return { tag, name: 'Auto BPM', led, apply: () => ctx.autoBpm() };
  if (ctx.shift && index === 7) return { tag, name: 'Master Stop', led, apply: () => ctx.masterStop() };
  const base = [
    { name: 'Scenes', apply: () => ctx.setPage(0) },
    { name: 'Clips', apply: () => ctx.setPage(1) },
    { name: 'Looks & FX', apply: () => ctx.setPage(2) },
    { name: 'Bank Up', apply: () => ctx.stepBank(1) },
    { name: 'Bank Down', apply: () => ctx.stepBank(-1) },
    { name: ctx.cueMode ? 'Cue On' : 'Cue Off', apply: () => ctx.toggleCue() },
    { name: 'Tap', apply: () => ctx.tap() },
    { name: 'GO', apply: () => ctx.go() },
  ];
  return { tag, name: base[index].name, led, apply: base[index].apply };
}

export function clampBank(bank) {
  return Math.min(BANK_MAX, Math.max(0, bank | 0));
}

/** Notes the controller should light, including page and track buttons. */
export function ledMap(page, ctx) {
  const view = { ...ctx, page };
  const out = new Map();
  for (let note = 0; note < 64; note++) out.set(note, describePad(note, page, view).led);
  for (let i = 0; i < 8; i++) out.set(100 + i, trackLed(i, view));
  for (let i = 0; i < 8; i++) out.set(112 + i, sceneLed(i, view));
  return out;
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
      const bytes = ledBytes(note, vel);
      const sig = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
      if (this.sent.get(note) === sig) continue;
      this.sent.set(note, sig);
      for (const port of ports) {
        try { port.send(bytes); } catch { /* port dropped */ }
      }
    }
  }

  #ports() {
    return this.getOutputs().filter((p) => p.state !== 'disconnected' && /apc|akai/i.test(p.name || ''));
  }
}

/** Grid pads use the RGB palette. Track and scene buttons are on or off. */
function ledBytes(note, vel) {
  const n = note & 0x7f;
  if ((n >= 100 && n <= 107) || (n >= 112 && n <= 119)) return [0x90, n, vel ? 1 : 0];
  return [0x96, n, vel & 0x7f];
}
