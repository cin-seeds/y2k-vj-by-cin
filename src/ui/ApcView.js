// On-screen copy of the Akai APC Mini MK2. Clicks take the same path as the hardware.
// Nine faders use soft takeover. Shift (note 122, the on-screen key, or Shift+click)
// shows the second function on the track and scene buttons.

import { layerParam } from '../params.js';
import {
  FADERS,
  LED,
  SHIFT_NOTE,
  MOMENT_IDS,
  clampBank,
  describePad,
  describeScene,
  describeTrack,
  faderByCc,
} from '../midi/ApcMiniMk2.js';

export class ApcView {
  constructor(opts) {
    this.root = opts.root;
    this.params = opts.params;
    this.scenes = opts.scenes;
    this.bus = opts.bus;
    this.panel = opts.panel;
    this.launch = opts.launch;
    this.setHud = opts.setHud;
    this.getHud = opts.getHud;
    this.getClips = opts.getClips;
    this.setClip = opts.setClip;
    this.getMedia = opts.getMedia;
    this.momentary = opts.momentary;
    this.actions = opts.actions;
    this.getPulse = opts.getPulse || (() => 0);
    this.page = 0;
    this.bank = 0;
    this.follow = true;
    this.cueMode = false;
    this.cuedId = null;
    this.followedId = opts.scenes.activeId;
    this.clipLayer = opts.panel.selected || 'A';
    this.hwShift = false;
    this.uiShift = false;
    this.keyShift = false;
    this.pads = Array.from({ length: 8 }, () => Array(8));
    this.trackBtns = [];
    this.sceneBtns = [];
    this.hw = {};
    this.prevHw = {};
    this.picked = {};
    this.seen = {};
    this.writing = false;
    this.lastNote = '';
    for (const fader of FADERS) {
      this.hw[fader.id] = null;
      this.prevHw[fader.id] = null;
      this.picked[fader.id] = false;
    }
    this.#build();
    opts.params.onChange(() => {
      if (!this.root.hidden) this.#paint();
    });
    opts.scenes.onChange(() => {
      this.#followScene();
      this.#paint();
    });
    opts.bus.onChange(() => this.#paint());
    this.#bindShiftKeys();
    this.#paint();
  }

  get shiftHeld() {
    return this.hwShift || this.uiShift || this.keyShift;
  }

  /** APC / Akai on channel 1. Any other port returns false so MIDI Learn can take it. */
  handleMidi(msg) {
    if (!/apc|akai/i.test(msg.port || '')) return false;
    if (msg.ch !== 1) return false;
    const { type, d1, value } = msg;
    if (type === 0x90 || type === 0x80) {
      const down = type === 0x90 && value > 0;
      if (d1 === SHIFT_NOTE) {
        this.hwShift = down;
        this.#flash(this.shiftBtn);
        this.#note(`NOTE ${d1}  ${down ? 'ON' : 'OFF'}`);
        this.#paint();
        return true;
      }
      if (d1 <= 63) {
        this.#pressPad(d1, down);
        if (down) this.#cell(d1)?.apply?.();
        return true;
      }
      if (d1 >= 100 && d1 <= 107) {
        this.#track(d1 - 100, down, this.shiftHeld);
        return true;
      }
      if (d1 >= 112 && d1 <= 119) {
        if (down) this.#scene(d1 - 112, this.shiftHeld);
        else this.#note(`NOTE ${d1}  OFF`);
        return true;
      }
      return false;
    }
    if (type === 0xb0) {
      const spec = faderByCc(d1);
      if (!spec) return false;
      this.#faderMidi(spec, value);
      return true;
    }
    return false;
  }

  followLayer(id) {
    if (this.follow && id && id !== 'master') this.clipLayer = id;
    this.#paint();
  }

  refresh() {
    this.#paint();
  }

  ledContext() {
    const layer = this.panel.selected || 'A';
    return {
      scenes: this.scenes.scenes,
      sceneAt: (index) => this.scenes.at(index),
      activeId: this.scenes.activeId,
      cuedId: this.cuedId,
      cueMode: this.cueMode,
      bank: this.bank,
      page: this.page,
      follow: this.follow,
      shift: this.shiftHeld,
      blink: Math.floor(performance.now() / 280) % 2 === 0,
      pulse: this.getPulse() > 0.5,
      clips: this.getClips(),
      media: this.getMedia(),
      clipLayer: this.clipLayer,
      layer,
      held: this.momentary.held,
      mute: this.bus.mute,
      solo: this.bus.solo,
      hud: this.getHud(),
      categories: this.actions.categories(),
      categoryMuted: this.actions.categoryMuted,
      get: (id, key) => this.params.get(layerParam(id, key)),
      launch: this.launch,
      cue: (id) => this.#cue(id),
      setClip: this.setClip,
      setMode: this.actions.setMode,
      toggleCategory: this.actions.toggleCategory,
      shuffleCategory: this.actions.shuffleCategory,
      setPage: (page) => this.setPage(page),
      stepBank: (dir) => this.#stepBank(dir),
      toggleFollow: () => this.#toggleFollow(),
      toggleCue: () => this.toggleCue(),
      tap: this.actions.tap,
      autoBpm: this.actions.autoBpm,
      masterStop: this.actions.masterStop,
      go: () => this.#go(),
      toggleMute: (id) => this.bus.toggleMute(id),
      toggleSolo: (id) => this.bus.toggleSolo(id),
      shuffleLayer: this.actions.shuffleLayer,
      recallComp: this.actions.recallComp,
      clearComposition: this.actions.clearComposition,
      launchPack: this.actions.launchPack,
      applyStack: this.actions.applyStack,
      stacks: this.actions.stacks?.() || [],
      toggleHud: () => this.setHud(!this.getHud().on),
      moment: (id, down) => this.momentary.set(id, down),
      sting: this.actions.sting,
      stingOn: this.actions.stingOn,
      logoName: this.actions.logoName,
    };
  }

  setPage(page) {
    this.page = page === 1 || page === 2 ? page : 0;
    this.#paint();
  }

  tick() {
    if (this.root.hidden) return;
    for (const spec of FADERS) {
      const input = this.faders[spec.id];
      const cur = this.#norm(spec);
      if (!this.writing && this.seen[spec.id] != null && Math.abs(cur - this.seen[spec.id]) > 0.002) {
        this.picked[spec.id] = false;
      }
      this.seen[spec.id] = cur;
      if (document.activeElement !== input) input.value = String(cur);
      const ghost = this.ghosts[spec.id];
      const hw = this.hw[spec.id];
      ghost.hidden = hw == null;
      if (hw != null) ghost.style.bottom = `${hw * 100}%`;
      input.closest('.apc-fader').classList.toggle('waiting', hw != null && !this.picked[spec.id]);
    }
    this.#paintLeds();
  }

  #build() {
    this.root.className = 'apc';
    this.root.replaceChildren();
    const head = document.createElement('header');
    head.className = 'apc-head';
    this.bankEl = document.createElement('span');
    this.bankEl.className = 'apc-bank';
    this.noteEl = document.createElement('span');
    this.noteEl.className = 'apc-note';
    this.noteEl.textContent = 'MIDI NOTE —';
    head.append(this.bankEl, this.noteEl);

    const face = document.createElement('div');
    face.className = 'apc-face';
    const grid = document.createElement('div');
    grid.className = 'apc-grid';
    for (let y = 7; y >= 0; y--) {
      for (let x = 0; x < 8; x++) {
        const note = x + y * 8;
        const pad = document.createElement('button');
        pad.type = 'button';
        pad.className = 'apc-pad';
        pad.innerHTML = '<i></i><b></b><em></em>';
        pad.addEventListener('click', () => {
          this.#pressPad(note, true);
          setTimeout(() => this.pads[y][x].classList.remove('held'), 140);
          this.#cell(note)?.apply?.();
        });
        grid.append(pad);
        this.pads[y][x] = pad;
      }
    }

    const scenes = document.createElement('div');
    scenes.className = 'apc-scenes';
    for (let i = 0; i < 8; i++) {
      const btn = this.#key('apc-key apc-scene', (e) => this.#scene(i, e.shiftKey || this.hwShift || this.uiShift));
      scenes.append(btn);
      this.sceneBtns.push(btn);
    }

    const tracks = document.createElement('div');
    tracks.className = 'apc-tracks';
    for (let i = 0; i < 8; i++) {
      const btn = this.#key('apc-key apc-track');
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.#track(i, true, e.shiftKey || this.hwShift || this.uiShift);
        try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic press */ }
      });
      const release = () => this.#track(i, false, this.shiftHeld);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      tracks.append(btn);
      this.trackBtns.push(btn);
    }

    this.shiftBtn = this.#key('apc-key apc-shift');
    this.shiftBtn.innerHTML = '<i>SHIFT</i><b>Shift</b>';
    this.shiftBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.uiShift = true;
      this.#flash(this.shiftBtn);
      this.#note(`NOTE ${SHIFT_NOTE}  ON`);
      this.#paint();
      try { this.shiftBtn.setPointerCapture(e.pointerId); } catch { /* synthetic press */ }
    });
    const shiftUp = () => {
      if (!this.uiShift) return;
      this.uiShift = false;
      this.#note(`NOTE ${SHIFT_NOTE}  OFF`);
      this.#paint();
    };
    this.shiftBtn.addEventListener('pointerup', shiftUp);
    this.shiftBtn.addEventListener('pointercancel', shiftUp);

    face.append(grid, scenes, tracks, this.shiftBtn);

    const faderRow = document.createElement('div');
    faderRow.className = 'apc-faders';
    this.faders = {};
    this.ghosts = {};
    for (const spec of FADERS) {
      const wrap = document.createElement('label');
      wrap.className = `apc-fader fader-${spec.id}`;
      const name = document.createElement('span');
      name.textContent = `${spec.tag} ${spec.label}`;
      const track = document.createElement('div');
      track.className = 'apc-track';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '1';
      input.step = '0.001';
      input.title = `${spec.label}. The mark is the hardware fader; it takes over when it crosses this value.`;
      input.addEventListener('input', () => {
        this.picked[spec.id] = false;
        this.writing = true;
        this.#write(spec, Number(input.value));
        this.writing = false;
      });
      const ghost = document.createElement('i');
      ghost.className = 'apc-ghost';
      ghost.hidden = true;
      ghost.title = 'Physical fader';
      track.append(input, ghost);
      wrap.append(name, track);
      faderRow.append(wrap);
      this.faders[spec.id] = input;
      this.ghosts[spec.id] = ghost;
    }

    this.root.append(head, face, faderRow);
  }

  #key(className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.innerHTML = '<i></i><b></b>';
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  #bindShiftKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Shift' || e.repeat) return;
      this.keyShift = true;
      this.#paint();
    });
    window.addEventListener('keyup', (e) => {
      if (e.key !== 'Shift') return;
      this.keyShift = false;
      this.#paint();
    });
    window.addEventListener('blur', () => {
      if (!this.keyShift && !this.uiShift) return;
      this.keyShift = false;
      this.uiShift = false;
      this.#paint();
    });
  }

  #context(shift) {
    const ctx = this.ledContext();
    if (shift != null) ctx.shift = shift;
    return ctx;
  }

  #cell(note) {
    return describePad(note, this.page, this.ledContext());
  }

  #followScene() {
    const id = this.scenes.activeId;
    if (!id || id === this.followedId) {
      this.followedId = id;
      return;
    }
    this.followedId = id;
    if (!this.follow) return;
    const idx = this.scenes.scenes.findIndex((s) => s.id === id);
    if (idx < 0) return;
    this.page = 0;
    this.bank = Math.floor(idx / 64);
  }

  #toggleFollow() {
    this.follow = !this.follow;
    if (this.follow) this.clipLayer = this.panel.selected || this.clipLayer;
    this.#paint();
  }

  #stepBank(dir) {
    this.bank = clampBank(this.bank + dir);
    this.#paint();
  }

  toggleCue() {
    this.cueMode = !this.cueMode;
    this.#paint();
  }

  #cue(id) {
    if (!this.cueMode) {
      this.launch(id);
      return;
    }
    if (this.cuedId === id) {
      this.#go();
      return;
    }
    this.cuedId = id;
    this.#paint();
  }

  #go() {
    if (!this.cuedId) return;
    const id = this.cuedId;
    this.cuedId = null;
    this.launch(id);
    if (!this.scenes.get(id)) this.#paint();
  }

  #track(index, down, shifted) {
    this.#flash(this.trackBtns[index]);
    this.#note(`NOTE ${100 + index}  ${down ? 'ON' : 'OFF'}`);
    if (!down) {
      const id = MOMENT_IDS[index];
      if (id) this.momentary.set(id, false);
      return;
    }
    const cell = describeTrack(index, this.#context(shifted));
    if (cell.hold) cell.apply(true);
    else cell.apply();
    this.#paint();
  }

  #scene(index, shifted) {
    this.#flash(this.sceneBtns[index]);
    this.#note(`NOTE ${112 + index}  ON`);
    describeScene(index, this.#context(shifted)).apply?.();
  }

  #norm(spec) {
    if (spec.id === 'speed') return this.actions.getSpeed() / spec.max;
    if (spec.id === 'fade') return this.actions.getFade() / spec.max;
    if (spec.macro != null) return this.actions.getMacro(spec.macro);
    if (spec.id === 'gain') return this.params.get('audioGain') / spec.max;
    if (spec.id === 'master') return this.params.get('master');
    return this.params.get(layerParam(spec.id, 'opacity'));
  }

  #write(spec, unit) {
    const value = Math.min(spec.max, Math.max(0, unit * spec.max));
    if (spec.id === 'speed') this.actions.setSpeed(value);
    else if (spec.id === 'fade') this.actions.setFade(value);
    else if (spec.macro != null) this.actions.setMacro(spec.macro, unit);
    else if (spec.id === 'gain') this.params.set('audioGain', value);
    else if (spec.id === 'master') this.params.set('master', unit);
    else this.params.set(layerParam(spec.id, 'opacity'), unit);
    this.seen[spec.id] = Math.min(1, Math.max(0, unit));
  }

  #faderMidi(spec, hw) {
    const prev = this.prevHw[spec.id];
    const soft = this.#norm(spec);
    if (prev == null) this.picked[spec.id] = Math.abs(hw - soft) < 0.035;
    else if (!this.picked[spec.id]) this.picked[spec.id] = (prev - soft) * (hw - soft) <= 0;
    this.prevHw[spec.id] = hw;
    this.hw[spec.id] = hw;
    if (this.picked[spec.id]) {
      this.writing = true;
      this.#write(spec, hw);
      this.writing = false;
      this.picked[spec.id] = true;
    }
    this.tick();
  }

  #pressPad(note, down) {
    const pad = this.pads[Math.floor(note / 8)][note % 8];
    this.#note(`NOTE ${String(note).padStart(2, '0')}  ${down ? 'ON' : 'OFF'}`);
    pad.classList.toggle('held', down);
    this.#flash(pad);
  }

  #flash(el) {
    if (!el) return;
    el.classList.add('hit');
    clearTimeout(el._hit);
    el._hit = setTimeout(() => el.classList.remove('hit'), 140);
  }

  #note(text) {
    this.lastNote = text;
    if (this.noteEl) this.noteEl.textContent = text;
  }

  #paint() {
    const start = this.bank * 64;
    this.bankEl.textContent = `Bank ${this.bank + 1} · ${start + 1}–${start + 64}`;
    this.shiftBtn.classList.toggle('held', this.shiftHeld);
    const ctx = this.ledContext();
    for (let i = 0; i < 8; i++) this.#paintKey(this.trackBtns[i], describeTrack(i, ctx));
    for (let i = 0; i < 8; i++) this.#paintKey(this.sceneBtns[i], describeScene(i, ctx));
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) this.#paintPad(x, y);
    }
    this.#note(this.lastNote || 'MIDI NOTE —');
    const cueBtn = document.getElementById('cue-mode-toggle');
    if (cueBtn) {
      cueBtn.classList.toggle('on', this.cueMode);
      cueBtn.setAttribute('aria-pressed', String(this.cueMode));
      cueBtn.textContent = this.cueMode ? 'Cue On' : 'Cue';
    }
  }

  #paintKey(el, cell) {
    el.querySelector('i').textContent = cell.tag;
    el.querySelector('b').textContent = cell.name;
    el.title = cell.name;
    el.classList.toggle('lit', !!cell.led);
  }

  #paintLeds() {
    const ctx = this.ledContext();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const cell = describePad(x + y * 8, this.page, ctx);
        this.#setLed(this.pads[y][x], cell.led);
      }
    }
    for (let i = 0; i < 8; i++) {
      this.trackBtns[i].classList.toggle('lit', !!describeTrack(i, ctx).led);
      this.sceneBtns[i].classList.toggle('lit', !!describeScene(i, ctx).led);
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
    if (cell.thumb) {
      pad.style.setProperty('--thumb', `url("${cell.thumb}")`);
      pad.classList.add('has-thumb');
    } else {
      pad.style.removeProperty('--thumb');
      pad.classList.remove('has-thumb');
    }
    this.#setLed(pad, cell.led);
  }

  #setLed(el, led) {
    el.classList.toggle('led-green', led === LED.green);
    el.classList.toggle('led-amber', led === LED.amber);
    el.classList.toggle('led-red', led === LED.red);
    el.classList.toggle('led-off', !led);
  }
}
