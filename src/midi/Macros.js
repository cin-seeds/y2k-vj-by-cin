// One MIDI CC drives several sliders. Depth is how far the knob pulls each
// slider from its current value; invert flips that direction.

const STORAGE_KEY = 'vj.macros';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const uid = () => Math.random().toString(36).slice(2, 8);

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.map(normalize) : [];
  } catch {
    return [];
  }
}

function normalize(macro) {
  return {
    id: macro.id || uid(),
    cc: typeof macro.cc === 'string' ? macro.cc : null,
    value: null,
    lanes: Array.isArray(macro.lanes) ? macro.lanes.map((lane) => ({
      param: String(lane.param || ''),
      depth: clamp(Number(lane.depth) || 0, 0, 1),
      invert: !!lane.invert,
    })).filter((lane) => lane.param) : [],
  };
}

export class MacroRouter {
  constructor(params) {
    this.params = params;
    this.macros = load();
    this.onChange = () => {};
  }

  toJSON() {
    return this.macros.map(({ id, cc, lanes }) => ({ id, cc, lanes }));
  }

  replace(list) {
    this.macros = Array.isArray(list) ? list.map(normalize) : [];
    this.#save();
    this.onChange();
  }

  add() {
    this.macros.push({ id: uid(), cc: null, value: null, lanes: [] });
    this.#save();
    this.onChange();
  }

  remove(index) {
    this.macros.splice(index, 1);
    this.#save();
    this.onChange();
  }

  bind(index, cc) {
    const macro = this.macros[index];
    if (!macro || !cc?.startsWith('CC ')) return;
    macro.cc = cc;
    this.#save();
    this.onChange();
  }

  setValue(key, value) {
    let hit = false;
    for (const macro of this.macros) {
      if (macro.cc === key) {
        macro.value = value;
        hit = true;
      }
    }
    return hit;
  }

  addLane(index, param) {
    const macro = this.macros[index];
    if (!macro || !param) return;
    macro.lanes.push({ param, depth: 1, invert: false });
    this.#save();
    this.onChange();
  }

  updateLane(index, laneIndex, patch) {
    const lane = this.macros[index]?.lanes[laneIndex];
    if (!lane) return;
    if (patch.param != null) lane.param = patch.param;
    if (patch.depth != null) lane.depth = clamp(patch.depth, 0, 1);
    if (patch.invert != null) lane.invert = !!patch.invert;
    this.#save();
  }

  removeLane(index, laneIndex) {
    this.macros[index]?.lanes.splice(laneIndex, 1);
    this.#save();
    this.onChange();
  }

  /** Bend live values toward the knob. The stored slider is the base. */
  apply(live) {
    for (const macro of this.macros) {
      if (!macro.cc || macro.value == null) continue;
      for (const lane of macro.lanes) {
        const def = this.params.defs.get(lane.param);
        if (!def || def.options || !(def.max > def.min) || !lane.depth) continue;
        const base = live.has(lane.param) ? live.get(lane.param) : this.params.get(lane.param);
        const n = lane.invert ? 1 - macro.value : macro.value;
        const aimed = def.min + n * (def.max - def.min);
        let out = base + (aimed - base) * lane.depth;
        out = clamp(out, def.min, def.max);
        if (def.step) out = Math.round(out / def.step) * def.step;
        live.set(lane.param, out);
      }
    }
  }

  #save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON())); } catch { /* ignore */ }
  }
}

export function sliderOptions(params) {
  const options = [];
  for (const def of params.defs.values()) {
    if (def.options || !(def.max > def.min)) continue;
    const prefix = def.layer ? `${def.layer} · ` : '';
    options.push({ id: def.id, label: `${prefix}${def.label}` });
  }
  return options;
}
