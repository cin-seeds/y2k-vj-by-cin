// Virtual Akai APC Mini MK2. Page 1 launches scenes on notes 0–63.
// Page 2 is the modular layer map: media clips, swaps, scale, and HUD.
// Hardware faders CC 48–50 and CC 56 use soft takeover.

import { LAYERS, layerParam } from '../params.js';
import { FADER_CC, MOMENT_NOTES, PAGE_NOTES, describePad, paramIdForFader } from '../midi/ApcMiniMk2.js';

const PAGE_NAME = ['PAGE 1: SCENE LAUNCHER', 'PAGE 2: MODULAR LAYER MIXER'];

export class ApcView {
  constructor({ root, params, scenes, bus, panel, launch, swapLayers, setHud, getHud, getClips, setClip, getMedia, momentary, stepHudSize, stepHudTheme }) {
    this.root = root;
    this.params = params;
    this.scenes = scenes;
    this.bus = bus;
    this.panel = panel;
    this.launch = launch;
    this.swapLayers = swapLayers;
    this.setHud = setHud;
    this.getHud = getHud;
    this.getClips = getClips;
    this.setClip = setClip;
    this.getMedia = getMedia;
    this.momentary = momentary;
    this.stepHudSize = stepHudSize;
    this.stepHudTheme = stepHudTheme;
    this.page = 0;
    this.pads = Array.from({ length: 8 }, () => Array(8));
    this.hw = { A: null, B: null, C: null, master: null };
    this.prevHw = { A: null, B: null, C: null, master: null };
    this.picked = { A: false, B: false, C: false, master: false };
    this.writing = false;
    this.lastNote = '';
    this.#build();
    params.onChange((id) => {
      if (!this.writing && id === 'master') this.picked.master = false;
      if (!this.writing && typeof id === 'string' && id.endsWith('.opacity')) this.picked[id[0]] = false;
      if (!this.root.hidden) {
        if (typeof id === 'string' && id.endsWith('.scale')) this.#paint();
        else this.#paintLive();
      }
    });
    scenes.onChange(() => this.#paint());
    bus.onChange(() => this.#paint());
    this.#paint();
  }

  /** Channel 1 hardware. Returns true when the MK2 preset owns the control. */
  handleMidi(msg) {
    if (msg.ch !== 1) return false;
    const { type, d1, value } = msg;
    if (type === 0x90 || type === 0x80) {
      const down = type === 0x90 && value > 0;
      if (d1 <= 63) {
        this.#pressPad(d1, down);
        if (down) this.#cell(d1)?.apply?.();
        return true;
      }
      if (MOMENT_NOTES[d1]) {
        this.lastNote = `NOTE ${d1}  ${down ? 'ON' : 'OFF'}`;
        this.#noteReadout();
        this.momentary.set(MOMENT_NOTES[d1], down);
        return true;
      }
      if (PAGE_NOTES[d1] != null) {
        if (down) this.setPage(PAGE_NOTES[d1]);
        this.lastNote = `NOTE ${d1}  ${down ? 'ON' : 'OFF'}`;
        this.#noteReadout();
        return true;
      }
      return false;
    }
    if (type === 0xb0 && FADER_CC[d1]) {
      this.#faderMidi(FADER_CC[d1], value);
      return true;
    }
    return false;
  }

  setPage(page) {
    this.page = page === 1 ? 1 : 0;
    this.#paint();
  }

  ledContext() {
    return {
      scenes: this.scenes.scenes,
      activeId: this.scenes.activeId,
      clips: this.getClips(),
      media: this.getMedia(),
      hud: this.getHud(),
      held: this.momentary.held,
      get: (layer, key) => this.params.get(layerParam(layer, key)),
      launch: this.launch,
      setClip: this.setClip,
      swap: this.swapLayers,
      setScale: (layer, value) => this.params.set(layerParam(layer, 'scale'), value),
      toggleHud: () => this.setHud(!this.getHud().on),
      stepSize: this.stepHudSize,
      stepTheme: this.stepHudTheme,
    };
  }

  refresh() {
    this.#paint();
    this.tick();
  }

  tick() {
    if (this.root.hidden) return;
    for (const id of Object.keys(this.faders)) {
      const input = this.faders[id];
      if (document.activeElement !== input) input.value = String(this.#level(id));
      const ghost = this.ghosts[id];
      const hw = this.hw[id];
      ghost.hidden = hw == null;
      if (hw != null) ghost.style.bottom = `${hw * 100}%`;
      input.closest('.apc-track').classList.toggle('waiting', hw != null && !this.picked[id]);
    }
    const hud = this.getHud();
    if (document.activeElement !== this.hudSize) {
      this.hudSize.value = String(Math.min(36, Math.max(12, hud.size)));
    }
    this.hudBtn.classList.toggle('on', hud.on);
    this.hudBtn.textContent = hud.on ? 'HUD On' : 'HUD Off';
    const selected = this.panel.selected;
    for (const L of LAYERS) this.layerBtns[L].classList.toggle('on', L === selected);
    for (const b of this.root.querySelectorAll('[data-scale]')) {
      b.classList.toggle('on', Math.abs(this.params.get(layerParam(selected, 'scale')) - Number(b.dataset.scale)) < 0.05);
    }
    this.#paintLive();
  }

  #build() {
    this.root.className = 'apc';
    const head = document.createElement('header');
    head.className = 'apc-head';
    this.pageBtns = [0, 1].map((i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'apc-page';
      b.textContent = `[ ${PAGE_NAME[i]} ]`;
      b.addEventListener('click', () => this.setPage(i));
      head.append(b);
      return b;
    });
    this.noteEl = document.createElement('span');
    this.noteEl.className = 'apc-note';
    this.noteEl.textContent = 'MIDI NOTE —';
    head.append(this.noteEl);

    const grid = document.createElement('div');
    grid.className = 'apc-grid';
    for (let y = 7; y >= 0; y--) {
      for (let x = 0; x < 8; x++) {
        const pad = document.createElement('button');
        pad.type = 'button';
        pad.className = 'apc-pad';
        pad.innerHTML = '<i></i><b></b><em></em>';
        pad.addEventListener('click', () => {
          const note = x + y * 8;
          this.#pressPad(note, true);
          setTimeout(() => this.pads[y][x].classList.remove('held'), 140);
          this.#cell(note)?.apply?.();
        });
        grid.append(pad);
        this.pads[y][x] = pad;
      }
    }

    const side = document.createElement('aside');
    side.className = 'apc-side';
    const sideTitle = document.createElement('h2');
    sideTitle.textContent = 'Opacity';
    side.append(sideTitle);
    this.faders = {};
    this.ghosts = {};
    const faderDefs = [
      { id: 'A', label: 'Layer A', cls: 'layer-a' },
      { id: 'B', label: 'Layer B', cls: 'layer-b' },
      { id: 'C', label: 'Layer C', cls: 'layer-c' },
      { id: 'master', label: 'Master', cls: 'layer-master' },
    ];
    for (const { id, label, cls } of faderDefs) {
      const wrap = document.createElement('label');
      wrap.className = `apc-fader ${cls}`;
      const name = document.createElement('span');
      name.textContent = label;
      const track = document.createElement('div');
      track.className = 'apc-track';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '1';
      input.step = '0.001';
      input.title = `${label}. The mark is the hardware fader; it takes over when it crosses this value.`;
      input.addEventListener('input', () => {
        this.picked[id] = false;
        this.params.set(paramIdForFader(id), Number(input.value));
      });
      const ghost = document.createElement('i');
      ghost.className = 'apc-ghost';
      ghost.hidden = true;
      ghost.title = 'Physical fader';
      track.append(input, ghost);
      wrap.append(name, track);
      side.append(wrap);
      this.faders[id] = input;
      this.ghosts[id] = ghost;
    }
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'CC 48–50 and CC 56 ghost the hardware fader and pick up when it crosses.';
    side.append(hint);

    const bar = document.createElement('div');
    bar.className = 'apc-actions';
    const swapAB = this.#action('Swap Layer A↔B', () => this.swapLayers('A', 'B'));
    const swapBC = this.#action('Swap Layer B↔C', () => this.swapLayers('B', 'C'));
    this.layerBtns = {};
    const layers = document.createElement('div');
    layers.className = 'apc-scales';
    for (const L of LAYERS) {
      const b = this.#action(L, () => this.panel.selectLayer(L));
      b.dataset.layer = L;
      this.layerBtns[L] = b;
      layers.append(b);
    }
    for (const s of [0.5, 1, 2]) {
      const b = this.#action(`${s.toFixed(1)}x`, () => {
        this.params.set(layerParam(this.panel.selected, 'scale'), s);
      });
      b.dataset.scale = String(s);
      layers.append(b);
    }
    this.hudBtn = this.#action('HUD Off', () => {
      const on = !this.getHud().on;
      this.setHud(on);
      this.hudBtn.classList.toggle('on', on);
      this.hudBtn.textContent = on ? 'HUD On' : 'HUD Off';
    });
    this.hudSize = document.createElement('input');
    this.hudSize.type = 'range';
    this.hudSize.min = '12';
    this.hudSize.max = '36';
    this.hudSize.step = '1';
    this.hudSize.title = 'Code HUD size';
    this.hudOut = document.createElement('output');
    this.hudSize.addEventListener('input', () => {
      this.setHud(this.getHud().on, Number(this.hudSize.value));
      this.hudOut.textContent = `${this.hudSize.value}px`;
    });
    const hudLabel = document.createElement('span');
    hudLabel.textContent = 'HUD';
    bar.append(swapAB, swapBC, layers, this.hudBtn, hudLabel, this.hudSize, this.hudOut);

    this.root.append(head, grid, side, bar);
  }

  #action(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  #level(id) {
    return this.params.get(paramIdForFader(id));
  }

  #pressPad(note, down) {
    const pad = this.pads[Math.floor(note / 8)][note % 8];
    this.lastNote = `NOTE ${String(note).padStart(2, '0')}  ${down ? 'ON' : 'OFF'}`;
    pad.classList.toggle('held', down);
    if (down) {
      pad.classList.add('hit');
      clearTimeout(pad._hit);
      pad._hit = setTimeout(() => pad.classList.remove('hit'), 140);
    }
    this.#noteReadout();
  }

  #cell(note) {
    return describePad(note, this.page, this.ledContext());
  }

  #faderMidi(id, hw) {
    const prev = this.prevHw[id];
    const soft = this.#level(id);
    if (prev == null) this.picked[id] = Math.abs(hw - soft) < 0.035;
    else if (!this.picked[id]) this.picked[id] = (prev - soft) * (hw - soft) <= 0;
    this.prevHw[id] = hw;
    this.hw[id] = hw;
    if (this.picked[id]) {
      this.writing = true;
      this.params.set(paramIdForFader(id), hw);
      this.writing = false;
      this.picked[id] = true;
    }
    this.tick();
  }

  #noteReadout() {
    this.noteEl.textContent = this.lastNote || 'MIDI NOTE —';
  }

  #paint() {
    this.pageBtns.forEach((b, i) => b.classList.toggle('on', i === this.page));
    const selected = this.panel.selected;
    for (const L of LAYERS) this.layerBtns[L].classList.toggle('on', L === selected);
    for (const b of this.root.querySelectorAll('[data-scale]')) {
      const scale = Number(b.dataset.scale);
      b.classList.toggle('on', Math.abs(this.params.get(layerParam(selected, 'scale')) - scale) < 0.05);
    }
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) this.#paintPad(x, y);
    }
    const hud = this.getHud();
    this.hudOut.textContent = `${Math.round(hud.size)}px`;
    this.#noteReadout();
  }

  #paintLive() {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const cell = this.#cell(x + y * 8);
        const pad = this.pads[y][x];
        pad.classList.toggle('active', !!cell.on);
        pad.classList.toggle('empty', !!cell.empty);
      }
    }
  }

  #paintPad(x, y) {
    const pad = this.pads[y][x];
    const note = x + y * 8;
    const cell = this.#cell(note);
    pad.querySelector('em').textContent = String(note);
    pad.classList.toggle('empty', !!cell.empty);
    pad.style.setProperty('--c', cell.color || 'transparent');
    pad.querySelector('i').textContent = cell.tag;
    pad.querySelector('b').textContent = cell.name;
    pad.title = cell.empty ? `Empty · note ${note}` : `${cell.name} · note ${note}`;
    pad.classList.toggle('active', !!cell.on);
  }
}
