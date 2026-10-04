// Corner pins and output mask for the final warp pass. Coordinates are
// top-left origin, 0..1 across the output frame. Persisted locally and in setlists.

const STORAGE_KEY = 'vj.outputMap';

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

export class OutputMap {
  constructor({ stage, svg, maskSelect, resetBtn, bezelInput, bezelOut, ledNote, getAspect, onChange }) {
    this.stage = stage;
    this.svg = svg;
    this.maskSelect = maskSelect;
    this.bezelInput = bezelInput;
    this.bezelOut = bezelOut;
    this.ledNote = ledNote;
    this.getAspect = getAspect;
    this.onChange = onChange;
    this.pins = copyPins(DEFAULT_PINS);
    this.gl = { tl: [0, 1], tr: [1, 1], bl: [0, 0], br: [1, 0] };
    this.mask = 'none';
    this.bezel = 0;
    this.handles = {};
    this.#buildHandles();
    this.#load();
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
    return { pins: copyPins(this.pins), mask: this.mask, bezel: this.bezel };
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
    this.#save();
    this.#draw();
    if (notify) this.onChange?.();
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
