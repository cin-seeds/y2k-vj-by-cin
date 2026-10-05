// Builds the parameter controls (slider or dropdown + MIDI learn button) and keeps
// them in sync with the ParamStore, whatever changed the value (UI, MIDI, scenes).
//
//   master params  -> masterEl, pinned in the bottom-right Master bus
//   layer 'mix'    -> one mixer strip per layer (opacity, always visible)
//   other layer    -> layerEl, showing only the selected layer and its shader's params

import { MOD_ROUTES, createModRow } from '../audio/ModMatrix.js';
import { ENGINE_FX, ENGINE_HYDRA, ENGINE_PARTICLES, ENGINES } from '../engines/constants.js';
import { BLEND_MENU, CATEGORY_ORDER, LAYERS, MODE_LABELS, MODES, layerParam, neutralOf } from '../params.js';
import { bindRangeReadout } from './NumericSlider.js';

const FOLD_KEY = 'vj.fxFold';
const FOLD_VER = '2';
const FOLD_VER_KEY = 'vj.fxFoldVer';
const MUTE_KEY = 'vj.catMute';
const LAYER_SOURCES = [
  { id: 'none', label: 'None' },
  { id: 'sub', label: 'Sub-Bass' },
  { id: 'mid', label: 'Mid-Energy' },
  { id: 'treble', label: 'High-Hats' },
  { id: 'lfo1', label: 'LFO 1' },
  { id: 'lfo2', label: 'LFO 2' },
];
const LFO_PRESETS = {
  lfo1: { shape: 0, rate: 2 },
  lfo2: { shape: 1, rate: 10 },
};
import { isAutomatable, LFO_RATES, LFO_SHAPES } from '../lfo/LfoEngine.js';
import { createNumericSlider } from './NumericSlider.js';
import { flashControl } from './Diagnostics.js';

/** Two thumbs on one track. Values stay in 0..1 and cannot cross. */
function createBoundControl(onInput) {
  let lo = 0;
  let hi = 1;
  let drag = '';
  const root = document.createElement('div');
  root.className = 'lfo-bounds';
  const label = document.createElement('span');
  label.textContent = 'Range';
  const track = document.createElement('div');
  track.className = 'lfo-bound-track';
  const pocket = document.createElement('div');
  pocket.className = 'lfo-bound-pocket';
  const minThumb = document.createElement('i');
  minThumb.className = 'lfo-bound-thumb min';
  const maxThumb = document.createElement('i');
  maxThumb.className = 'lfo-bound-thumb max';
  const out = document.createElement('output');
  track.append(pocket, minThumb, maxThumb);
  root.append(label, track, out);

  const paint = (a = lo, b = hi) => {
    lo = Math.min(1, Math.max(0, Math.min(a, b)));
    hi = Math.min(1, Math.max(0, Math.max(a, b)));
    if (hi - lo < 0.01) {
      if (drag === 'min') lo = Math.max(0, hi - 0.01);
      else hi = Math.min(1, lo + 0.01);
    }
    pocket.style.left = `${lo * 100}%`;
    pocket.style.width = `${(hi - lo) * 100}%`;
    minThumb.style.left = `${lo * 100}%`;
    maxThumb.style.left = `${hi * 100}%`;
    out.textContent = `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`;
  };
  const at = (e) => {
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  const move = (e) => {
    if (!drag) return;
    const t = at(e);
    if (drag === 'min') lo = Math.min(t, hi - 0.01);
    else hi = Math.max(t, lo + 0.01);
    paint(lo, hi);
    onInput(lo, hi);
  };
  const start = (which) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = which;
    track.setPointerCapture(e.pointerId);
    move(e);
  };
  minThumb.addEventListener('pointerdown', start('min'));
  maxThumb.addEventListener('pointerdown', start('max'));
  track.addEventListener('pointerdown', (e) => {
    if (e.target !== track && e.target !== pocket) return;
    const t = at(e);
    start(Math.abs(t - lo) <= Math.abs(t - hi) ? 'min' : 'max')(e);
  });
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', () => { drag = ''; });
  track.addEventListener('pointercancel', () => { drag = ''; });
  paint(0, 1);
  return {
    el: root,
    paint,
    get dragging() { return !!drag; },
  };
}

export class Panel {
  constructor({ masterEl, mixerEl, layerEl, layerEditor, params, midi, bus, lfo, mods }) {
    this.params = params;
    this.midi = midi;
    this.bus = bus;
    this.lfo = lfo;
    this.mods = mods;
    this.masterEl = masterEl;
    this.mixerEl = mixerEl;
    this.layerEl = layerEl;
    this.layerEditor = layerEditor;
    this.rows = new Map();
    this.strips = new Map();
    this.blocks = new Map();
    this.folds = this.#loadFolds();
    this.muted = new Set();
    this.bypassed = [];
    try {
      const saved = JSON.parse(localStorage.getItem(MUTE_KEY) || '[]');
      if (Array.isArray(saved)) this.muted = new Set(saved);
    } catch { /* ignore a bad mute list */ }
    this.selected = LAYERS[0];
    this.focus = LAYERS[0];
    this.held = new Set();
    this.onSelect = () => {};
    this.isVideo = () => false;
    this.isImage = () => false;
    this.#build();
    params.onChange((id, v) => {
      this.#sync(id, v);
      const def = params.defs.get(id);
      if (!def?.layer) return;
      if (def.key === 'engine') {
        const sel = this.strips.get(def.layer).engine;
        if (document.activeElement !== sel) sel.value = String(v);
      }
      if ((def.key === 'mode' || def.key === 'engine' || def.key === 'palette') && def.layer === this.selected) this.updateVisibility();
      if (def.key === 'mode' || def.key === 'opacity' || def.key === 'engine' || def.key === 'pCount') {
        this.#syncStrip(def.layer);
      }
      if (def.key === 'opacity' || def.key === 'blend' || def.key === 'blendInvert') {
        this.#syncComp(def.layer);
      }
    });
    bus.onChange(() => this.refreshBus());
  }

  #build() {
    for (const L of LAYERS) {
      const strip = document.createElement('div');
      strip.className = 'strip';
      strip.dataset.layer = L;
      const head = document.createElement('div');
      head.className = 'strip-head';
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'strip-tab';
      tab.textContent = 'Select';
      tab.title = `Edit layer ${L} (${['Q', 'W', 'E'][LAYERS.indexOf(L)]})`;
      tab.addEventListener('click', () => this.selectLayer(L));
      const letter = document.createElement('span');
      letter.className = 'strip-letter';
      letter.textContent = L;
      const thumb = document.createElement('img');
      thumb.className = 'strip-thumb';
      thumb.alt = '';
      thumb.hidden = true;
      thumb.draggable = false;
      const info = document.createElement('span');
      info.className = 'strip-info';
      const solo = document.createElement('button');
      solo.type = 'button';
      solo.className = 'ms solo';
      solo.textContent = 'Solo';
      solo.title = `Solo layer ${L}`;
      solo.addEventListener('click', (e) => {
        e.stopPropagation();
        this.bus.toggleSolo(L);
      });
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'ms mute';
      mute.textContent = 'Mute';
      mute.title = `Mute layer ${L} (live override — scenes cannot unmute this)`;
      mute.addEventListener('click', (e) => {
        e.stopPropagation();
        this.bus.toggleMute(L);
      });
      const engineDef = this.params.defs.get(layerParam(L, 'engine'));
      const engine = document.createElement('select');
      engine.className = 'strip-engine';
      engine.title = 'Engine for this layer. Opacity and blend still composite it with the others.';
      engineDef.options.forEach((name, i) => engine.add(new Option(name, String(i))));
      engine.value = String(this.params.get(engineDef.id));
      engine.addEventListener('change', () => this.params.set(engineDef.id, parseFloat(engine.value)));
      engine.addEventListener('pointerdown', (e) => e.stopPropagation());
      engine.hidden = L !== this.selected;
      this.#engineSlot().append(engine);

      const invert = document.createElement('button');
      invert.type = 'button';
      invert.className = 'ms invert';
      invert.textContent = 'Invert';
      invert.title = 'Invert this layer’s blend';
      invert.dataset.midi = layerParam(L, 'blendInvert');
      invert.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = layerParam(L, 'blendInvert');
        this.params.set(id, this.params.get(id) > 0.5 ? 0 : 1);
      });
      const flags = document.createElement('div');
      flags.className = 'strip-flags';
      const sync = document.createElement('button');
      sync.type = 'button';
      sync.className = 'ms sync on';
      sync.textContent = 'Sync';
      sync.title = 'Sync to Master. On: header Play, Pause, and Stop drive this layer. Off: it keeps playing through those commands.';
      sync.setAttribute('aria-pressed', 'true');
      sync.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSyncToggle?.(L);
      });
      flags.append(mute, solo, invert, sync);
      head.append(letter, thumb, info, tab, flags);

      const comp = document.createElement('div');
      comp.className = 'strip-comp';
      const blendDef = this.params.defs.get(layerParam(L, 'blend'));
      const blend = document.createElement('select');
      blend.className = 'strip-blend';
      blend.title = 'Blend mode';
      blend.dataset.midi = blendDef.id;
      for (const i of BLEND_MENU) blend.add(new Option(blendDef.options[i], String(i)));
      blend.value = String(this.params.get(blendDef.id));
      blend.addEventListener('change', () => this.params.set(blendDef.id, Number(blend.value)));
      blend.addEventListener('pointerdown', (e) => e.stopPropagation());

      const opacityId = layerParam(L, 'opacity');
      const mixWrap = document.createElement('label');
      mixWrap.className = 'strip-mix-wrap';
      mixWrap.dataset.midi = opacityId;
      const mix = document.createElement('input');
      mix.type = 'range';
      mix.className = 'strip-mix';
      mix.min = '0';
      mix.max = '1';
      mix.step = '0.01';
      mix.value = String(this.params.get(opacityId));
      mix.title = 'Layer opacity';
      const mixOut = document.createElement('output');
      mixOut.className = 'strip-mix-out';
      const mixDrag = this.#bindFader(mix, (v) => {
        mixOut.textContent = `${Math.round(v * 100)}%`;
        this.params.set(opacityId, v);
      }, {
        onDrag: (down) => {
          if (down) this.held.add(opacityId);
          else this.held.delete(opacityId);
        },
      });
      mixWrap.append(mix, mixOut);
      comp.append(blend, mixWrap);

      const mod = document.createElement('div');
      mod.className = 'strip-mod';
      const pick = document.createElement('div');
      pick.className = 'strip-mod-pick';
      const source = document.createElement('select');
      source.className = 'strip-source';
      source.title = 'Modulation source for this layer’s opacity';
      LAYER_SOURCES.forEach((item) => source.add(new Option(item.label, item.id)));
      source.addEventListener('change', () => this.#applyLayerSource(L, source.value));
      source.addEventListener('pointerdown', (e) => e.stopPropagation());
      const lfoBtn = document.createElement('button');
      lfoBtn.type = 'button';
      lfoBtn.className = 'ms lfo';
      lfoBtn.textContent = 'M';
      lfoBtn.title = 'Enable LFO on this layer’s opacity';
      lfoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#toggleLayerLfo(L);
      });
      const audioBtn = document.createElement('button');
      audioBtn.type = 'button';
      audioBtn.className = 'ms audio';
      audioBtn.textContent = 'A';
      audioBtn.title = 'Enable audio on this layer’s opacity';
      audioBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#toggleLayerAudio(L);
      });
      pick.append(source, lfoBtn, audioBtn);

      const tune = document.createElement('div');
      tune.className = 'strip-tune';
      const depth = document.createElement('input');
      depth.type = 'range';
      depth.min = '-1';
      depth.max = '1';
      depth.step = '0.01';
      depth.title = 'How strongly the assigned modulation moves this layer’s opacity. Negative inverts audio.';
      const depthOut = document.createElement('output');
      const depthDrag = this.#bindFader(depth, (v) => {
        depthOut.textContent = this.#depthText(v);
        this.#setLayerDepth(L, v);
      }, { onDrag: (down) => { if (!down) this.#syncCardMod(L); } });
      tune.append(this.#tuneRow('Depth', depth, depthOut));
      const gate = document.createElement('input');
      gate.type = 'range';
      gate.min = '0';
      gate.max = '1';
      gate.step = '0.01';
      gate.title = 'Audio gate. Modulation stays off until the signal passes this level.';
      const gateOut = document.createElement('output');
      const gateDrag = this.#bindFader(gate, (v) => {
        gateOut.textContent = `${Math.round(v * 100)}%`;
        this.mods.set(opacityId, { gate: v });
      });
      tune.append(this.#tuneRow('Gate', gate, gateOut));
      mod.append(pick, tune);

      strip.append(head, comp, mod);
      this.mixerEl.append(strip);
      this.strips.set(L, {
        strip, tab, thumb, info, solo, mute, invert, sync, blend, mix, mixOut, mixDrag, engine,
        source, lfoBtn, audioBtn, depth, depthOut, depthDrag, gate, gateOut, gateDrag,
      });
    }

    for (const d of this.params.defs.values()) {
      if (d.group === 'head') continue;
      if (d.layer && d.group === 'mix') continue;
      if (!d.layer && d.id === 'audioGain') continue;
      const bare = !d.layer && (d.id === 'master' || d.id === 'crtBarrel');
      const row = this.#makeRow(d, bare ? { bare: true, label: d.id === 'crtBarrel' ? 'Barrel' : undefined } : {});
      const bucket = d.category || d.group;
      if (!d.layer && d.id === 'master') {
        document.getElementById('brightness-slot')?.append(row.row);
      } else if (!d.layer && d.id === 'crtBarrel') {
        document.getElementById('project-barrel')?.append(row.row);
      } else if (d.layer && d.key === 'mode') {
        const slot = document.createElement('div');
        slot.className = 'shader-slot';
        slot.dataset.midi = d.id;
        const title = document.createElement('h2');
        title.textContent = 'Layer Shader';
        row.input.classList.add('strip-engine');
        slot.append(title, row.input);
        this.strips.get(d.layer).engine.insertAdjacentElement('afterend', slot);
        row.row = slot;
      } else if (!d.layer) this.#block('master', bucket).body.append(row.row);
      else this.#block(d.layer, bucket).body.append(row.row);
      this.rows.set(d.id, row);
      this.#sync(d.id, this.params.get(d.id));
    }
    this.#orderHost(this.layerEl);
    this.#orderHost(this.masterEl);
    this.applyFoldDefaults();
    this.#paintMute();
    this.refreshMidi();
    this.refreshBus();
    this.mods.watchers.add(() => {
      for (const layer of LAYERS) this.#syncCardMod(layer);
    });
    for (const id of this.rows.keys()) this.#syncLfo(id);
    this.selectLayer(this.selected);
    for (const L of LAYERS) {
      this.#syncStrip(L);
      this.#syncComp(L);
      this.#syncCardMod(L);
    }
  }

  #engineSlot() {
    if (this.engineHost) return this.engineHost;
    const host = document.createElement('div');
    host.className = 'inspector-engine';
    const title = document.createElement('h2');
    title.textContent = 'Engine';
    host.append(title);
    this.layerEl.prepend(host);
    this.engineHost = host;
    return host;
  }

  #makeRow(d, { bare = false, label: labelText } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'param-wrap';
    wrap.dataset.midi = d.id;

    const row = document.createElement('div');
    row.className = 'param';
    if (isAutomatable(d) && !bare) row.classList.add('has-auto');

    const label = document.createElement('label');
    label.textContent = labelText || d.friendlyLabel || d.label;
    label.title = 'Double-click to snap back to the zero-effect value';
    label.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.params.set(d.id, neutralOf(d), { exact: true });
    });
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'param-info';
    info.textContent = '?';
    info.title = d.description || d.friendlyLabel || d.label;
    info.addEventListener('pointerdown', (e) => e.stopPropagation());
    info.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showHelp(d);
    });
    const labelWrap = document.createElement('div');
    labelWrap.className = 'param-label';
    labelWrap.append(label, info);

    let input;
    let slider = null;
    let out = null;
    if (d.options) {
      input = document.createElement('select');
      d.options.forEach((name, i) => input.add(new Option(name, String(i))));
      input.value = this.params.get(d.id);
      input.addEventListener('input', () => this.params.set(d.id, parseFloat(input.value)));
    } else {
      slider = createNumericSlider(d, {
        get: () => this.params.get(d.id),
        set: (v, opts) => this.params.set(d.id, v, opts),
        onHold: (down) => {
          if (down) this.held.add(d.id);
          else this.held.delete(d.id);
        },
        onReset: () => this.params.set(d.id, neutralOf(d), { exact: true }),
      });
      input = slider.input;
    }

    const learn = document.createElement('button');
    learn.type = 'button';
    learn.className = 'learn';
    learn.textContent = 'M';
    learn.addEventListener('click', () => this.midi.learn(d.id));
    learn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.midi.clear(d.id);
    });

    row.append(labelWrap, slider ? slider.el : input, learn);
    wrap.addEventListener('pointerenter', () => this.showHelp(d));

    let auto = null;
    let lfoRow = null;
    let shape = null;
    let rate = null;
    let amt = null;
    let amtOut = null;
    let bounds = null;
    if (isAutomatable(d) && !bare) {
      auto = document.createElement('button');
      auto.type = 'button';
      auto.className = 'auto';
      auto.textContent = 'A';
      auto.title = 'Automate (LFO)';
      auto.addEventListener('click', () => {
        this.lfo.toggle(d.id);
        this.#syncLfo(d.id);
        if (d.layer && d.key === 'opacity') this.#syncCardMod(d.layer);
      });
      row.append(auto);

      lfoRow = document.createElement('div');
      lfoRow.className = 'lfo-row';
      lfoRow.hidden = true;
      shape = document.createElement('select');
      shape.title = 'LFO shape';
      LFO_SHAPES.forEach((name, i) => shape.add(new Option(name, String(i))));
      rate = document.createElement('select');
      rate.title = 'LFO rate';
      LFO_RATES.forEach((r, i) => rate.add(new Option(r.label, String(i))));
      const depth = document.createElement('div');
      depth.className = 'lfo-depth';
      const depthLabel = document.createElement('span');
      depthLabel.textContent = 'Depth';
      amt = document.createElement('input');
      amt.type = 'range';
      amt.min = 0;
      amt.max = 1;
      amt.step = 0.01;
      amt.value = '1';
      amt.title = 'Automation depth. 100% sweeps this slider across its full range.';
      amtOut = document.createElement('output');
      amtOut.textContent = '100%';
      const apply = () => {
        this.lfo.set(d.id, {
          on: true,
          shape: Number(shape.value),
          rate: Number(rate.value),
          amount: Number(amt.value),
        });
        amtOut.textContent = `${Math.round(Number(amt.value) * 100)}%`;
        if (d.layer && d.key === 'opacity') this.#syncCardMod(d.layer);
      };
      shape.addEventListener('change', apply);
      rate.addEventListener('change', apply);
      amt.addEventListener('input', apply);
      bindRangeReadout(amtOut, amt);
      depth.append(depthLabel, amt, amtOut);
      bounds = createBoundControl((minBound, maxBound) => {
        this.lfo.set(d.id, {
          on: true,
          shape: Number(shape.value),
          rate: Number(rate.value),
          amount: Number(amt.value),
          minBound,
          maxBound,
        });
        this.#syncLfo(d.id);
      });
      lfoRow.append(shape, rate, depth, bounds.el);
      wrap.append(row, lfoRow);
    } else {
      wrap.append(row);
    }

    if (!bare && isAutomatable(d) && d.key !== 'audioGain' && d.id !== 'audioGain') {
      wrap.append(createModRow(this.mods, d.id));
    }

    return { row: wrap, param: row, input, out, slider, learn, auto, lfoRow, lfoShape: shape, lfoRate: rate, lfoAmt: amt, lfoAmtOut: amtOut, lfoBounds: bounds, labelEl: label, infoEl: info, def: d };
  }

  /** One titled stack of sliders, with a button that randomizes just that stack. */
  #block(layer, group) {
    const key = `${layer}:${group}`;
    const existing = this.blocks.get(key);
    if (existing) return existing;
    const el = document.createElement('div');
    el.className = 'fx-block';
    el.dataset.layer = layer;
    el.dataset.group = group;
    const head = document.createElement('div');
    head.className = 'fx-head';
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'fx-toggle';
    title.textContent = group;
    title.title = 'Show or hide this group';
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'cat-mute';
    mute.textContent = 'Mute';
    mute.title = 'Bypass this group. The sliders stay put; the picture uses each control’s zero-effect value.';
    mute.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#toggleMute(layer, group);
    });
    const shuffle = document.createElement('button');
    shuffle.type = 'button';
    shuffle.className = 'shuffle';
    shuffle.textContent = '🎲 Shuffle';
    shuffle.title = 'Randomize every slider in this block';
    shuffle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.shuffleGroup(layer, group);
    });
    head.addEventListener('click', (e) => {
      if (e.target.closest('.cat-mute, .shuffle, .section-lock')) return;
      this.#setFold(el, !el.classList.contains('collapsed'));
    });
    head.append(title, mute, shuffle);
    const body = document.createElement('div');
    body.className = 'fx-body';
    let note = null;
    if (layer !== 'master' && group === 'Audio Reactivity') {
      note = document.createElement('p');
      note.className = 'audio-listen-note';
      note.textContent = 'This look already listens. Give each layer a different band. Beat Sync or a matrix route is a second listen on top.';
      body.append(note);
    }
    el.append(head, body);
    const host = layer === 'master' ? this.masterEl : this.layerEl;
    host.append(el);
    const block = { el, body, mute, note };
    this.blocks.set(key, block);
    return block;
  }

  /** Layer column order. The composition bus ranks Color, Distortion, then Motion. */
  #layerRank(group) {
    if (group === 'Source & Playback') return 0;
    if (group === 'Audio Reactivity') return 2;
    if (group === 'Geometry & Scale') return 3;
    if (group === 'Motion & Timing') return 4;
    if (group === 'Mix & Composite') return 5;
    return 1;
  }

  #orderHost(host) {
    const masterRank = {
      'Color & Texture': 0,
      'Distortion & Glitch': 1,
      'Motion & Timing': 2,
    };
    const rank = (el) => {
      if (host === this.layerEl) return this.#layerRank(el.dataset.group);
      const named = masterRank[el.dataset.group];
      if (named != null) return named;
      const i = CATEGORY_ORDER.indexOf(el.dataset.group);
      return i < 0 ? 99 : i + 10;
    };
    const kids = [...host.children].filter((el) => el.classList?.contains('fx-block'));
    kids.sort((a, b) => rank(a) - rank(b));
    for (const el of kids) host.append(el);
  }

  #toggleMute(layer, category) {
    const key = `${layer}:${category}`;
    if (this.muted.has(key)) this.muted.delete(key);
    else this.muted.add(key);
    try { localStorage.setItem(MUTE_KEY, JSON.stringify([...this.muted])); } catch { /* ignore */ }
    this.#paintMute();
  }

  #rebuildBypass() {
    const list = [];
    for (const def of this.params.defs.values()) {
      if (!def.layer || def.options) continue;
      if (this.muted.has(`${def.layer}:${def.category}`)) list.push(def);
    }
    this.bypassed = list;
  }

  #paintMute() {
    this.#rebuildBypass();
    for (const [key, block] of this.blocks) {
      const on = this.muted.has(key);
      block.el.classList.toggle('bypassed', on);
      block.mute.classList.toggle('on', on);
      block.mute.textContent = on ? 'Muted' : 'Mute';
      block.mute.title = on
        ? 'This group is bypassed. Click to bring the effects back.'
        : 'Bypass this group. The sliders stay put; the picture uses each control’s zero-effect value.';
    }
  }

  /** Live override: continuous params in a muted category render at their neutral value. */
  isBypassed(def) {
    if (!def || def.options) return false;
    if (!def.layer && (def.id === 'master' || def.id === 'crtBarrel' || def.id === 'audioGain')) return false;
    const scope = def.layer || 'master';
    return this.muted.has(`${scope}:${def.category}`);
  }

  showHelp(d) {
    if (!d) return;
    const prefix = d.layer ? 'param-help' : 'master-help';
    const title = document.getElementById(`${prefix}-title`);
    const body = document.getElementById(`${prefix}-body`);
    if (!title || !body) return;
    title.textContent = d.friendlyLabel || d.label;
    const unit = d.unit === 'turn' ? '°' : (d.unit || '');
    body.textContent = `${d.description || 'Changes this control on the picture.'}${unit ? ` Unit: ${unit}.` : ''}`;
  }

  /** Pick a new value inside each slider's min/max. Dropdowns stay put. */
  isSectionLocked() {
    return false;
  }

  shuffleGroup(layer, group) {
    if (this.isSectionLocked(layer, group)) return;
    for (const def of this.params.defs.values()) {
      const mine = layer === 'master' ? !def.layer : def.layer === layer;
      if (!mine || def.category !== group || def.options) continue;
      this.#shuffleOne(def);
    }
  }

  /**
   * Randomize every visible effect slider on the selected layer.
   * Mode, mix, geometry, and dropdowns stay put. Matrix routes are not touched.
   */
  shuffleSelectedLayer() {
    const layer = this.selected;
    const skipGroups = new Set(['Geometry & Scale', 'Mix & Composite', 'Source & Playback']);
    const skipKeys = new Set(['mode', 'opacity', 'blend', 'blendInvert', 'scale', 'posX', 'posY', 'engine']);
    const visible = [];
    for (const { row, def } of this.rows.values()) {
      if (def.layer !== layer || row.hidden || def.options || skipKeys.has(def.key)) continue;
      const group = def.category || def.group;
      if (skipGroups.has(group)) continue;
      visible.push(def);
    }
    const groups = new Set(visible.map((def) => def.category || def.group));
    for (const group of groups) {
      if (this.isSectionLocked(layer, group)) continue;
      const inGroup = [...this.params.defs.values()].filter((def) => {
        if (def.layer !== layer || def.options || skipKeys.has(def.key)) return false;
        return (def.category || def.group) === group;
      });
      const allShown = inGroup.every((def) => visible.some((item) => item.id === def.id));
      if (allShown) this.shuffleGroup(layer, group);
      else {
        for (const def of visible) {
          if ((def.category || def.group) === group) this.#shuffleOne(def);
        }
      }
    }
  }

  #shuffleOne(def) {
    const current = this.params.get(def.id);
    let v = current;
    for (let n = 0; n < 8 && v === current; n++) {
      v = def.min + Math.random() * (def.max - def.min);
      if (def.step) v = Math.round(v / def.step) * def.step;
      v = Math.min(def.max, Math.max(def.min, v));
    }
    this.params.set(def.id, v);
  }

  #sync(id, v) {
    const r = this.rows.get(id);
    if (!r) return;
    if (r.slider) {
      if (!r.slider.editing) r.slider.paint(v, this.held.has(id) ? v : v);
      return;
    }
    if (document.activeElement !== r.input) {
      const next = String(v);
      if (r.input.value !== next) r.input.value = next;
    }
  }

  #syncLfo(id) {
    const r = this.rows.get(id);
    if (!r?.auto) return;
    const lane = this.lfo.get(id);
    const on = !!lane?.on;
    r.auto.classList.toggle('on', on);
    r.param?.classList.toggle('automating', on);
    if (r.lfoRow) {
      r.lfoRow.hidden = !on;
      if (on && lane) {
        if (document.activeElement !== r.lfoShape) r.lfoShape.value = String(lane.shape);
        if (document.activeElement !== r.lfoRate) r.lfoRate.value = String(lane.rate);
        if (document.activeElement !== r.lfoAmt) r.lfoAmt.value = String(lane.amount);
        r.lfoAmtOut.textContent = `${Math.round(lane.amount * 100)}%`;
        if (r.lfoBounds && !r.lfoBounds.dragging) r.lfoBounds.paint(lane.minBound, lane.maxBound);
      }
    }
    r.slider?.setPocket?.(lane?.minBound ?? 0, lane?.maxBound ?? 1, on);
  }

  #tuneRow(name, input, output) {
    const row = document.createElement('label');
    row.className = 'strip-tune-row';
    const title = document.createElement('span');
    title.textContent = name;
    row.append(title, input, output);
    return row;
  }

  #depthText(v) {
    const n = Math.round(v * 100) / 100;
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
  }

  /**
   * Track the pointer for the whole drag, including when it leaves the card.
   * Returns a function that is true while the finger or mouse is down.
   */
  #bindFader(input, onValue, { onDrag } = {}) {
    let dragging = false;
    const valueFromX = (clientX) => {
      const rect = input.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      const min = Number(input.min);
      const max = Number(input.max);
      const step = Number(input.step) || 0.01;
      let v = min + t * (max - min);
      v = Math.round(v / step) * step;
      return Math.min(max, Math.max(min, Number(v.toFixed(4))));
    };
    const apply = (clientX) => {
      const v = valueFromX(clientX);
      input.value = String(v);
      onValue(v);
    };
    const move = (e) => apply(e.clientX);
    const up = () => {
      if (!dragging) return;
      dragging = false;
      onDrag?.(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    input.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      onDrag?.(true);
      try { input.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      apply(e.clientX);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    input.addEventListener('input', () => onValue(Number(input.value)));
    return () => dragging;
  }

  #applyLayerSource(L, source) {
    const id = layerParam(L, 'opacity');
    const s = this.strips.get(L);
    const depth = Number(s.depth.value);
    if (source === 'none') {
      s.lastAudio = '';
      this.lfo.set(id, { on: false });
      this.mods.set(id, { route: 'none', depth: 0 });
    } else if (source === 'lfo1' || source === 'lfo2') {
      const amount = Math.min(1, Math.max(0.5, Math.abs(depth) || 0.5));
      this.lfo.set(id, { on: true, ...LFO_PRESETS[source], amount });
      this.mods.set(id, { route: 'none' });
    } else {
      s.lastAudio = source;
      this.lfo.set(id, { on: false });
      this.mods.set(id, { route: source, depth: depth || undefined });
    }
    this.#syncLfo(id);
    this.#syncCardMod(L);
  }

  #toggleLayerLfo(L) {
    const id = layerParam(L, 'opacity');
    const s = this.strips.get(L);
    if (this.lfo.isOn(id)) {
      this.lfo.set(id, { on: false });
      this.#syncLfo(id);
      this.#syncCardMod(L);
      return;
    }
    const source = s.source.value === 'lfo2' ? 'lfo2' : 'lfo1';
    s.source.value = source;
    this.#applyLayerSource(L, source);
  }

  #toggleLayerAudio(L) {
    const id = layerParam(L, 'opacity');
    const s = this.strips.get(L);
    if (this.mods.get(id).route !== 'none') {
      s.lastAudio = this.mods.get(id).route;
      this.mods.set(id, { route: 'none' });
      this.#syncCardMod(L);
      return;
    }
    const remembered = ['sub', 'mid', 'treble'].includes(s.lastAudio) ? s.lastAudio : 'sub';
    const source = ['sub', 'mid', 'treble'].includes(s.source.value) ? s.source.value : remembered;
    s.source.value = source;
    this.#applyLayerSource(L, source);
  }

  #setLayerDepth(L, v) {
    const id = layerParam(L, 'opacity');
    if (this.lfo.isOn(id)) this.lfo.set(id, { amount: Math.min(1, Math.abs(v)) });
    this.mods.set(id, { depth: v });
  }

  #cardSource(lane, mod) {
    if (lane?.on && mod.route === 'none') return lane.shape === 1 && lane.rate === 10 ? 'lfo2' : 'lfo1';
    if (mod.route && mod.route !== 'none') return mod.route;
    return 'none';
  }

  #ensureSourceOption(select, id) {
    if ([...select.options].some((o) => o.value === id)) return;
    const known = MOD_ROUTES.find((r) => r.id === id);
    select.add(new Option(known?.label || id, id));
  }

  #syncCardMod(L) {
    const s = this.strips.get(L);
    if (!s?.source) return;
    const id = layerParam(L, 'opacity');
    const lane = this.lfo.get(id);
    const mod = this.mods.get(id);
    s.lfoBtn.classList.toggle('on', !!lane?.on);
    s.audioBtn.classList.toggle('on', mod.route !== 'none');
    if (document.activeElement !== s.source) {
      let next = this.#cardSource(lane, mod);
      if (next === 'none' && s.lastAudio) next = s.lastAudio;
      this.#ensureSourceOption(s.source, next);
      s.source.value = next;
    }
    const shown = lane?.on && mod.route === 'none' ? (lane.amount ?? 0) : mod.depth;
    if (!s.depthDrag?.()) s.depth.value = String(shown);
    s.depthOut.textContent = this.#depthText(Number(s.depth.value));
    if (!s.gateDrag?.()) s.gate.value = String(mod.gate);
    s.gateOut.textContent = `${Math.round(Number(s.gate.value) * 100)}%`;
  }

  #syncComp(L) {
    const s = this.strips.get(L);
    if (!s) return;
    const opacity = this.params.get(layerParam(L, 'opacity'));
    const blend = this.params.get(layerParam(L, 'blend'));
    if (!s.mixDrag?.()) s.mix.value = String(Math.min(1, Math.max(0, opacity)));
    s.mixOut.textContent = `${Math.round(opacity * 100)}%`;
    if (document.activeElement !== s.blend) s.blend.value = String(blend);
    s.invert.classList.toggle('on', this.params.get(layerParam(L, 'blendInvert')) > 0.5);
  }

  #syncStrip(L) {
    const s = this.strips.get(L);
    if (!s) return;
    const engine = ENGINES[this.params.get(layerParam(L, 'engine'))] || ENGINE_FX;
    const shader = this.params.defs.get(layerParam(L, 'mode')).options[this.params.get(layerParam(L, 'mode'))];
    const mode = engine === ENGINE_FX
      ? shader
      : engine === ENGINE_PARTICLES
        ? `${Math.round(this.params.get(layerParam(L, 'pCount')))} pts`
        : 'feedback';
    s.strip.classList.toggle('off', this.params.get(layerParam(L, 'opacity')) <= 0.001 || !this.bus.audible(L));
    const engineName = this.params.defs.get(layerParam(L, 'engine')).options[this.params.get(layerParam(L, 'engine'))];
    const short = engine === ENGINE_PARTICLES ? 'Swarm' : engine === ENGINE_HYDRA ? 'Hydra' : 'FX';
    const media = s.mediaText ? ` · ${s.mediaText}` : '';
    s.info.dataset.mode = mode;
    s.info.title = `${engineName}${media}`;
    s.info.textContent = `${short} · ${mode}${media}`;
  }

  refreshLabels() {
    for (const L of LAYERS) this.#syncStrip(L);
  }

  setStripMedia(L, text, thumb = '') {
    const s = this.strips.get(L);
    s.mediaText = text;
    const src = typeof thumb === 'string' ? thumb : '';
    if (src) {
      if (s.thumb.dataset.src !== src) {
        s.thumb.dataset.src = src;
        s.thumb.src = src;
      }
      s.thumb.hidden = false;
    } else {
      s.thumb.hidden = true;
      s.thumb.removeAttribute('src');
      delete s.thumb.dataset.src;
    }
    this.#syncStrip(L);
  }

  selectLayer(L) {
    this.focus = L;
    this.selected = L;
    for (const [id, s] of this.strips) s.strip.classList.toggle('selected', id === L);
    this.updateVisibility();
    this.onSelect(L);
  }

  /** Select the layer, open the category, and flash the control for two seconds. */
  focusParam(id, level = 'warn') {
    if (id === 'hud.size') {
      const el = document.getElementById('hud-size');
      const fold = document.getElementById('code-overlay');
      if (fold) fold.open = true;
      fold?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashControl(el, level);
      return;
    }
    const def = this.params.defs.get(id);
    if (!def) return;
    if (def.layer) {
      this.selectLayer(def.layer);
      this.strips.get(def.layer)?.strip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (def.key === 'engine' && def.layer) {
      const block = this.blocks.get(`${def.layer}:Source & Playback`);
      if (block) this.#openBlock(block.el);
      const el = this.strips.get(def.layer)?.engine;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashControl(el, level);
      return;
    }
    if (def.layer && def.group === 'mix') {
      const card = this.strips.get(def.layer);
      const el = def.key === 'opacity' ? card?.mix : def.key === 'blend' ? card?.blend : card?.invert;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (el) flashControl(el, level);
      return;
    }
    if (id === 'audioGain') {
      const fold = document.getElementById('acc-audio');
      if (fold) fold.open = true;
      const el = document.getElementById('audio-master');
      fold?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (el) flashControl(el, level);
      return;
    }
    const row = this.rows.get(id);
    if (!row) return;
    const block = row.row.closest('.fx-block');
    if (block) this.#openBlock(block);
    row.row.hidden = false;
    const control = row.slider?.el || row.input || row.param;
    control.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashControl(control, level);
    const card = def.layer ? this.strips.get(def.layer) : null;
    if (card && def.key === 'opacity') flashControl(card.mix, level);
    if (card && def.key === 'blend') flashControl(card.blend, level);
    if (card && def.key === 'blendInvert') flashControl(card.invert, level);
  }

  #loadFolds() {
    try {
      if (localStorage.getItem(FOLD_VER_KEY) !== FOLD_VER) return {};
      const saved = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  #saveFolds() {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(this.folds));
      localStorage.setItem(FOLD_VER_KEY, FOLD_VER);
    } catch { /* ignore a full or private store */ }
  }

  #setFold(el, collapsed, remember = true) {
    el.classList.toggle('collapsed', collapsed);
    const title = el.querySelector('.fx-toggle');
    if (title) title.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (!remember) return;
    const key = `${el.dataset.layer}:${el.dataset.group}`;
    this.folds[key] = collapsed;
    this.#saveFolds();
  }

  /** A composition module is in use when one of its controls has left the zero-effect value. */
  #groupHot(layer, group) {
    for (const def of this.params.defs.values()) {
      const scope = def.layer || 'master';
      if (scope !== layer || (def.category || def.group) !== group) continue;
      const value = this.params.get(def.id);
      if (!Number.isFinite(value)) continue;
      if (Math.abs(value - neutralOf(def)) > 0.001) return true;
    }
    return false;
  }

  /**
   * Open the sections a set starts on, and leave the rest closed.
   * A header the operator has already toggled stays where they left it.
   * Closing a section only hides its sliders.
   */
  applyFoldDefaults() {
    const master = [...this.blocks.values()]
      .filter((block) => block.el.dataset.layer === 'master')
      .sort((a, b) => {
        const rank = (el) => {
          const i = CATEGORY_ORDER.indexOf(el.dataset.group);
          return i < 0 ? 99 : i;
        };
        return rank(a.el) - rank(b.el);
      });
    const hot = master.find((block) => this.#groupHot('master', block.el.dataset.group));
    const masterOpen = (hot || master[0])?.el.dataset.group;
    for (const block of this.blocks.values()) {
      const { layer, group } = block.el.dataset;
      const key = `${layer}:${group}`;
      if (Object.prototype.hasOwnProperty.call(this.folds, key)) {
        this.#setFold(block.el, !!this.folds[key], false);
        continue;
      }
      const collapsed = layer === 'master' ? group !== masterOpen : group !== 'Source & Playback';
      this.#setFold(block.el, collapsed, false);
    }
  }

  #openBlock(el) {
    el.hidden = false;
    this.#setFold(el, false);
  }

  /**
   * Shared knobs follow the selected look: Glitch Intensity and Datamosh live in
   * that shader's section, and Pixel Art renames Glitch Intensity to Row Tear.
   */
  #placeLookKnob(def, mode, labelEl, infoEl) {
    if (!def.modes?.includes(mode)) return;
    const section = MODE_LABELS[MODES.indexOf(mode)];
    if (!section) return;
    if (def.category !== section) {
      def.category = section;
      this.#block(def.layer, section).body.append(this.rows.get(def.id).row);
    }
    if (def.key !== 'glitch') return;
    const tear = mode === 'dither';
    const text = tear ? 'Row Tear' : 'Glitch Intensity';
    const desc = tear
      ? 'Shifts whole rows of the pixel grid. Zero holds every row still.'
      : 'Tears scanlines, splits RGB, and drops blocks. Zero is a clean frame.';
    def.friendlyLabel = text;
    def.description = desc;
    if (labelEl) labelEl.textContent = text;
    if (infoEl) infoEl.title = desc;
  }

  /** Show the selected layer's params in the inspector. The Master bus stays put. */
  updateVisibility() {
    if (this.layerEditor) this.layerEditor.hidden = false;
    const video = this.isVideo(this.selected);
    const image = this.isImage(this.selected);
    for (const [id, s] of this.strips) s.engine.hidden = id !== this.selected;
    for (const { row, def, labelEl, infoEl } of this.rows.values()) {
      if (!def.layer || def.group === 'head') continue;
      if (def.group === 'mix') {
        row.hidden = def.layer !== this.selected;
        continue;
      }
      const mode = MODES[this.params.get(layerParam(def.layer, 'mode'))];
      const engine = ENGINES[this.params.get(layerParam(def.layer, 'engine'))] || ENGINE_FX;
      const selected = def.layer === this.selected;
      let shown = def.group === 'layer'
        || (def.modes
          ? engine === ENGINE_FX && def.modes.includes(mode)
          : (engine === ENGINE_FX && (def.group === 'fx' || def.group === mode))
            || (engine === ENGINE_PARTICLES && def.group === 'particles')
            || (engine === ENGINE_HYDRA && def.group === 'hydra')
            || (def.group === 'video' && video)
            || (def.group === 'image' && image));
      if (def.key === 'colorDepth' && this.params.get(layerParam(def.layer, 'palette')) !== 0) shown = false;
      if (def.key === 'reactivity' || def.key === 'audioBind' || def.key === 'beatSync') {
        const fx = engine === ENGINE_FX && mode !== 'clean' && mode !== 'minidv';
        const swarm = engine === ENGINE_PARTICLES;
        const hydra = engine === ENGINE_HYDRA;
        shown = def.key === 'reactivity' ? (fx || swarm) : (fx || swarm || hydra);
      }
      if (def.key === 'glitch' || def.key === 'feedback') this.#placeLookKnob(def, mode, labelEl, infoEl);
      row.hidden = !(selected && shown);
      if (!row.hidden) this.#syncLfo(def.id);
    }
    for (const block of this.blocks.values()) {
      if (block.el.dataset.layer === 'master') {
        block.el.hidden = false;
        continue;
      }
      if (block.el.dataset.layer !== this.selected) {
        block.el.hidden = true;
        continue;
      }
      if (block.note) {
        const anyAudio = [...block.body.children].some((row) => row !== block.note && !row.hidden);
        block.note.hidden = !anyAudio;
      }
      const any = [...block.body.children].some((row) => !row.hidden);
      block.el.hidden = !any;
    }
  }

  refreshMidi() {
    for (const [id, r] of this.rows) {
      const map = this.midi.mappingFor(id);
      r.learn.classList.toggle('armed', this.midi.learnTarget === id);
      r.learn.classList.toggle('mapped', !!map);
      r.learn.title = map ? `MIDI: ${map} (right-click to clear)` : 'MIDI learn';
      r.row.classList.toggle('midi-hot', this.midi.learnTarget === id);
    }
  }

  refreshAutomation() {
    for (const id of this.rows.keys()) this.#syncLfo(id);
    for (const L of LAYERS) this.#syncCardMod(L);
  }

  setSyncState(id, on) {
    const btn = this.strips.get(id)?.sync;
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.textContent = on ? 'Sync' : 'Lock';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  refreshBus() {
    for (const L of LAYERS) {
      const s = this.strips.get(L);
      s.mute.classList.toggle('on', this.bus.mute[L]);
      s.solo.classList.toggle('on', this.bus.solo[L]);
      s.strip.classList.toggle('muted', this.bus.mute[L]);
      s.strip.classList.toggle('soloed', this.bus.solo[L]);
      this.#syncStrip(L);
    }
  }

  /** Solid bar is the base. Green bar is the live modulation. Dragging hides the ghost. */
  tickLive(live) {
    for (const [id, r] of this.rows) {
      if (!r.slider || r.slider.editing) continue;
      const base = this.params.get(id);
      let v = this.held.has(id) || !live.has(id) ? base : live.get(id);
      if (!this.held.has(id) && this.isBypassed(r.def)) v = neutralOf(r.def);
      r.slider.paint(base, v);
    }
  }
}
