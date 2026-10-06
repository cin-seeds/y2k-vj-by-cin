// Corner pins and output mask for the final warp pass. Coordinates are
// top-left origin, 0..1 across the output frame. Persisted locally and in setlists.

const STORAGE_KEY = 'vj.outputMap';
const PRESET_KEY = 'vj.outputMapPresets';
const GUIDE_KEY = 'vj.outputMapGuide';

export const OUTPUT_MASKS = [
  { id: 'none', label: 'None (Full Screen)' },
  { id: 'ellipse', label: 'Circle/Ellipse' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'letterbox', label: '16:9 Letterbox' },
  { id: 'led25', label: 'Stepped Diamond (7x7 / 25-Panel LED)' },
];

// Row 0 is the top. 1 + 3 + 5 + 7 + 5 + 3 + 1 = 25 panels.
const LED_ROWS = [
  [3],
  [2, 3, 4],
  [1, 2, 3, 4, 5],
  [0, 1, 2, 3, 4, 5, 6],
  [1, 2, 3, 4, 5],
  [2, 3, 4],
  [3],
];

const PIN_KEYS = ['tl', 'tr', 'bl', 'br'];
const PIN_LABEL = { tl: 'Top-Left', tr: 'Top-Right', bl: 'Bottom-Left', br: 'Bottom-Right' };

export const DEFAULT_PINS = {
  tl: [0, 0],
  tr: [1, 0],
  bl: [0, 1],
  br: [1, 1],
};

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function copyPins(src) {
  return {
    tl: src.tl.slice(),
    tr: src.tr.slice(),
    bl: src.bl.slice(),
    br: src.br.slice(),
  };
}

function readPin(value, fallback) {
  if (!Array.isArray(value) || value.length < 2) return fallback.slice();
  return [clamp01(value[0]), clamp01(value[1])];
}

export function maskIndex(id) {
  const i = OUTPUT_MASKS.findIndex((m) => m.id === id);
  return i < 0 ? 0 : i;
}

function bilerp(pins, u, v) {
  const topX = pins.tl[0] + (pins.tr[0] - pins.tl[0]) * u;
  const topY = pins.tl[1] + (pins.tr[1] - pins.tl[1]) * u;
  const botX = pins.bl[0] + (pins.br[0] - pins.bl[0]) * u;
  const botY = pins.bl[1] + (pins.br[1] - pins.bl[1]) * u;
  return [topX + (botX - topX) * v, topY + (botY - topY) * v];
}

function ledCells(bezel) {
  const inset = Math.min(0.05, Math.max(0, bezel));
  const cells = [];
  LED_ROWS.forEach((cols, row) => {
    for (const col of cols) {
      cells.push([
        [(col + inset) / 7, (row + inset) / 7],
        [(col + 1 - inset) / 7, (row + inset) / 7],
        [(col + 1 - inset) / 7, (row + 1 - inset) / 7],
        [(col + inset) / 7, (row + 1 - inset) / 7],
      ]);
    }
  });
  return cells;
}

function maskOutline(mask, aspect) {
  if (mask === 'ellipse') {
    const pts = [];
    for (let i = 0; i < 48; i += 1) {
      const a = (i / 48) * Math.PI * 2;
      pts.push([0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5]);
    }
    return pts;
  }
  if (mask === 'triangle') return [[0.5, 0], [0, 1], [1, 1]];
  if (mask === 'diamond') return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  if (mask === 'letterbox') {
    const half = Math.min(1, aspect * (9 / 16)) * 0.5;
    return [[0, 0.5 - half], [1, 0.5 - half], [1, 0.5 + half], [0, 0.5 + half]];
  }
  return null;
}

function presetId() {
  return `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function snapshotMapping(pins, mask, bezel) {
  return { pins: copyPins(pins), mask, bezel };
}

function shrinkGuide(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

export class OutputMap {
  constructor({
    stage, svg, maskSelect, resetBtn, bezelInput, bezelOut, ledNote, getAspect, onChange,
    guideImg, guideFile, guidePick, guideClear, guideOpacity, guideOpacityOut,
    presetName, presetSave, presetList, presetEmpty,
  }) {
    this.stage = stage;
    this.svg = svg;
    this.maskSelect = maskSelect;
    this.bezelInput = bezelInput;
    this.bezelOut = bezelOut;
    this.ledNote = ledNote;
    this.getAspect = getAspect;
    this.onChange = onChange;
    this.guideImg = guideImg;
    this.guideOpacityInput = guideOpacity;
    this.guideOpacityOut = guideOpacityOut;
    this.presetName = presetName;
    this.presetList = presetList;
    this.presetEmpty = presetEmpty;
    this.pins = copyPins(DEFAULT_PINS);
    this.gl = { tl: [0, 1], tr: [1, 1], bl: [0, 0], br: [1, 0] };
    this.mask = 'none';
    this.bezel = 0;
    this.presets = [];
    this.activePresetId = '';
    this.guideUrl = '';
    this.guideOpacity = 0.45;
    this.handles = {};
    this.#buildHandles();
    this.#load();
    this.#loadPresets();
    this.#loadGuide();
    guidePick?.addEventListener('click', () => guideFile?.click());
    guideFile?.addEventListener('change', () => {
      const file = guideFile.files?.[0];
      guideFile.value = '';
      if (file) this.setGuide(file);
    });
    guideClear?.addEventListener('click', () => this.clearGuide());
    guideOpacity?.addEventListener('input', () => {
      this.guideOpacity = Math.min(1, Math.max(0, Number(guideOpacity.value) / 100));
      this.#saveGuide();
      this.#paintGuide();
    });
    presetSave?.addEventListener('click', () => this.savePreset(presetName?.value || ''));
    presetName?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.savePreset(presetName.value);
    });
    maskSelect.addEventListener('change', () => {
      this.mask = OUTPUT_MASKS.some((m) => m.id === maskSelect.value) ? maskSelect.value : 'none';
      this.#commit();
    });
    bezelInput.addEventListener('input', () => {
      this.bezel = Math.min(0.05, Math.max(0, Number(bezelInput.value) / 100));
      this.#commit();
    });
    resetBtn.addEventListener('click', () => this.resetPins());
    this.#draw();
    this.#paintPresets();
    this.#paintGuide();
  }

  get identity() {
    return PIN_KEYS.every((key) => {
      const p = this.pins[key];
      const d = DEFAULT_PINS[key];
      return Math.abs(p[0] - d[0]) < 0.0001 && Math.abs(p[1] - d[1]) < 0.0001;
    });
  }

  maskIndex() {
    return maskIndex(this.mask);
  }

  /** Pins in GL UV, y up, for the warp shader. */
  glPins() {
    const g = this.gl;
    const p = this.pins;
    g.tl[0] = p.tl[0]; g.tl[1] = 1 - p.tl[1];
    g.tr[0] = p.tr[0]; g.tr[1] = 1 - p.tr[1];
    g.bl[0] = p.bl[0]; g.bl[1] = 1 - p.bl[1];
    g.br[0] = p.br[0]; g.br[1] = 1 - p.br[1];
    return g;
  }

  toJSON() {
    return {
      pins: copyPins(this.pins),
      mask: this.mask,
      bezel: this.bezel,
      presets: this.presets.map((row) => ({
        id: row.id,
        name: row.name,
        pins: copyPins(row.pins),
        mask: row.mask,
        bezel: row.bezel,
      })),
    };
  }

  apply(data, { notify = true } = {}) {
    const pins = data?.pins || {};
    this.pins = {
      tl: readPin(pins.tl, DEFAULT_PINS.tl),
      tr: readPin(pins.tr, DEFAULT_PINS.tr),
      bl: readPin(pins.bl, DEFAULT_PINS.bl),
      br: readPin(pins.br, DEFAULT_PINS.br),
    };
    this.mask = OUTPUT_MASKS.some((m) => m.id === data?.mask) ? data.mask : 'none';
    const bezel = Number(data?.bezel);
    this.bezel = Number.isFinite(bezel) ? Math.min(0.05, Math.max(0, bezel)) : 0;
    if (Array.isArray(data?.presets)) {
      this.presets = data.presets.map((row) => this.#readPreset(row)).filter(Boolean);
      this.#savePresets();
      this.#paintPresets();
    }
    this.#save();
    this.#draw();
    if (notify) this.onChange?.();
  }

  savePreset(name) {
    const label = cleanName(name) || `Preset ${this.presets.length + 1}`;
    const row = { id: presetId(), name: label, ...snapshotMapping(this.pins, this.mask, this.bezel) };
    this.presets.push(row);
    this.activePresetId = row.id;
    if (this.presetName) this.presetName.value = '';
    this.#savePresets();
    this.#paintPresets();
  }

  renamePreset(id, name) {
    const row = this.presets.find((item) => item.id === id);
    if (!row) return;
    const label = cleanName(name);
    if (!label || label === row.name) {
      this.#paintPresets();
      return;
    }
    row.name = label;
    this.#savePresets();
    this.#paintPresets();
  }

  updatePreset(id) {
    const row = this.presets.find((item) => item.id === id);
    if (!row) return;
    const next = snapshotMapping(this.pins, this.mask, this.bezel);
    row.pins = next.pins;
    row.mask = next.mask;
    row.bezel = next.bezel;
    this.activePresetId = id;
    this.#savePresets();
    this.#paintPresets();
  }

  deletePreset(id) {
    this.presets = this.presets.filter((item) => item.id !== id);
    if (this.activePresetId === id) this.activePresetId = '';
    this.#savePresets();
    this.#paintPresets();
  }

  usePreset(id) {
    const row = this.presets.find((item) => item.id === id);
    if (!row) return;
    this.activePresetId = id;
    this.apply({ pins: row.pins, mask: row.mask, bezel: row.bezel }, { notify: true });
    this.#paintPresets();
  }

  async setGuide(file) {
    if (!file || !String(file.type || '').startsWith('image/')) return;
    try {
      this.guideUrl = await shrinkGuide(file);
    } catch {
      return;
    }
    this.#saveGuide();
    this.#paintGuide();
  }

  clearGuide() {
    this.guideUrl = '';
    this.#saveGuide();
    this.#paintGuide();
  }

  resetPins() {
    this.pins = copyPins(DEFAULT_PINS);
    this.#commit();
  }

  syncAspect() {
    const aspect = this.mask === 'led25' ? 1 : (this.getAspect?.() || 16 / 9);
    this.stage.style.aspectRatio = String(aspect);
    this.stage.style.width = `min(100%, calc(46vh * ${aspect}))`;
    this.#draw();
  }

  #commit() {
    this.#save();
    this.#draw();
    this.onChange?.();
  }

  #load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      this.apply(JSON.parse(raw), { notify: false });
    } catch { /* ignore a bad save */ }
  }

  #save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON())); } catch { /* ignore */ }
  }

  #readPreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : presetId();
    const name = cleanName(raw.name) || 'Preset';
    const pins = raw.pins || {};
    const mask = OUTPUT_MASKS.some((item) => item.id === raw.mask) ? raw.mask : 'none';
    const bezel = Number(raw.bezel);
    return {
      id,
      name,
      pins: {
        tl: readPin(pins.tl, DEFAULT_PINS.tl),
        tr: readPin(pins.tr, DEFAULT_PINS.tr),
        bl: readPin(pins.bl, DEFAULT_PINS.bl),
        br: readPin(pins.br, DEFAULT_PINS.br),
      },
      mask,
      bezel: Number.isFinite(bezel) ? Math.min(0.05, Math.max(0, bezel)) : 0,
    };
  }

  #loadPresets() {
    try {
      const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
      if (!Array.isArray(raw)) return;
      this.presets = raw.map((row) => this.#readPreset(row)).filter(Boolean);
    } catch { /* ignore a bad save */ }
  }

  #savePresets() {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(this.presets)); } catch { /* ignore */ }
    this.#save();
  }

  #paintPresets() {
    const list = this.presetList;
    if (!list) return;
    list.replaceChildren();
    if (this.presetEmpty) this.presetEmpty.hidden = this.presets.length > 0;
    for (const row of this.presets) {
      const item = document.createElement('li');
      item.classList.toggle('is-active', row.id === this.activePresetId);
      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 40;
      name.value = row.name;
      name.title = 'Preset name';
      name.setAttribute('aria-label', `Name for ${row.name}`);
      name.addEventListener('change', () => this.renamePreset(row.id, name.value));
      const use = document.createElement('button');
      use.type = 'button';
      use.textContent = 'Use';
      use.title = `Apply ${row.name}`;
      use.addEventListener('click', () => this.usePreset(row.id));
      const update = document.createElement('button');
      update.type = 'button';
      update.textContent = 'Update';
      update.title = `Overwrite ${row.name} with the current corners`;
      update.addEventListener('click', () => this.updatePreset(row.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.title = `Delete ${row.name}`;
      remove.addEventListener('click', () => this.deletePreset(row.id));
      item.append(name, use, update, remove);
      list.append(item);
    }
  }

  #loadGuide() {
    try {
      const raw = JSON.parse(localStorage.getItem(GUIDE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
      if (typeof raw.url === 'string' && raw.url.startsWith('data:image/')) this.guideUrl = raw.url;
      const opacity = Number(raw.opacity);
      if (Number.isFinite(opacity)) this.guideOpacity = Math.min(1, Math.max(0, opacity));
    } catch { /* ignore a bad save */ }
  }

  #saveGuide() {
    try {
      if (!this.guideUrl && this.guideOpacity === 0.45) {
        localStorage.removeItem(GUIDE_KEY);
        return;
      }
      localStorage.setItem(GUIDE_KEY, JSON.stringify({ url: this.guideUrl, opacity: this.guideOpacity }));
    } catch { /* a large photo stays for this session */ }
  }

  #paintGuide() {
    const img = this.guideImg;
    if (!img) return;
    if (this.guideUrl) {
      img.src = this.guideUrl;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    img.style.opacity = String(this.guideOpacity);
    if (this.guideOpacityInput) this.guideOpacityInput.value = String(Math.round(this.guideOpacity * 100));
    if (this.guideOpacityOut) this.guideOpacityOut.textContent = `${Math.round(this.guideOpacity * 100)}%`;
  }

  #buildHandles() {
    for (const key of PIN_KEYS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'map-pin';
      el.dataset.pin = key;
      el.title = PIN_LABEL[key];
      el.textContent = key.toUpperCase();
      el.addEventListener('pointerdown', (e) => this.#grab(key, e));
      this.stage.append(el);
      this.handles[key] = el;
    }
  }

  #grab(key, e) {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev) => {
      const rect = this.stage.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / Math.max(1, rect.width);
      const y = (ev.clientY - rect.top) / Math.max(1, rect.height);
      this.pins[key] = [clamp01(x), clamp01(y)];
      this.#save();
      this.#draw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  #draw() {
    const n = 1000;
    const pt = (p) => `${(p[0] * n).toFixed(1)},${(p[1] * n).toFixed(1)}`;
    const line = (a, b) => `<line x1="${(a[0] * n).toFixed(1)}" y1="${(a[1] * n).toFixed(1)}" x2="${(b[0] * n).toFixed(1)}" y2="${(b[1] * n).toFixed(1)}" />`;
    const parts = ['<rect class="map-frame" x="1" y="1" width="998" height="998" />'];
    for (let i = 0; i <= 4; i += 1) {
      const t = i / 4;
      parts.push(line(bilerp(this.pins, t, 0), bilerp(this.pins, t, 1)));
      parts.push(line(bilerp(this.pins, 0, t), bilerp(this.pins, 1, t)));
    }
    const shapes = this.mask === 'led25'
      ? ledCells(this.bezel)
      : [maskOutline(this.mask, this.getAspect?.() || 16 / 9)].filter(Boolean);
    for (const shape of shapes) {
      const mapped = shape.map((p) => bilerp(this.pins, p[0], p[1]));
      parts.push(`<polygon class="map-mask" points="${mapped.map(pt).join(' ')}" />`);
    }
    const quad = [this.pins.tl, this.pins.tr, this.pins.br, this.pins.bl];
    parts.push(`<polygon class="map-quad" points="${quad.map(pt).join(' ')}" />`);
    this.svg.innerHTML = parts.join('');
    for (const key of PIN_KEYS) {
      const el = this.handles[key];
      el.style.left = `${this.pins[key][0] * 100}%`;
      el.style.top = `${this.pins[key][1] * 100}%`;
    }
    this.maskSelect.value = this.mask;
    const pct = this.bezel * 100;
    this.bezelInput.value = String(pct);
    this.bezelOut.textContent = `${pct.toFixed(1)}%`;
    this.bezelInput.disabled = this.mask !== 'led25';
    if (this.ledNote) this.ledNote.hidden = this.mask !== 'led25';
  }
}
