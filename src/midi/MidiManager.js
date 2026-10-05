// Web MIDI with "MIDI learn": arm a parameter, then move any CC / pad / pitch bend.
// Notes act as momentary controls (velocity on press, 0 on release).
// Targets named "scene:<id>" are triggers: any non-zero value launches that scene.

const STORAGE_KEY = 'vj.midi.mappings';

export class MidiManager {
  constructor(params) {
    this.params = params;
    this.access = null;
    this.learnTarget = null;
    this.learnArmed = false;
    this.mappings = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); // key -> paramId
    this.onChange = () => {};
    this.onActivity = () => {};
    this.onTrigger = () => {};
    this.onMomentary = () => {};
    this.onMacroLearn = () => {};
    this.onControl = () => {};
    this.onHardware = () => false;
    this.onRaw = () => false;
  }

  toggleLearn() {
    this.learnArmed = !this.learnArmed;
    if (!this.learnArmed) this.learnTarget = null;
    this.onChange();
  }

  setMappings(mappings) {
    this.mappings = { ...mappings };
    this.learnTarget = null;
    this.#save();
    this.onChange();
  }

  get supported() {
    if ('requestMIDIAccess' in navigator) return true;
    return this.#inTauri();
  }

  async init() {
    if (!this.supported) throw new Error('Web MIDI is not supported in this browser (use Chrome or Edge).');
    if ('requestMIDIAccess' in navigator) {
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (err) {
        if (!this.#inTauri()) throw err;
        this.access = await this.#nativeAccess();
      }
    } else {
      this.access = await this.#nativeAccess();
    }
    this.#attach();
    this.access.onstatechange = () => {
      this.#attach();
      this.onChange();
    };
  }

  get inputNames() {
    return this.access ? [...this.access.inputs.values()].map((i) => i.name) : [];
  }

  get outputs() {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  learn(paramId) {
    this.learnTarget = this.learnTarget === paramId ? null : paramId;
    this.onChange();
  }

  mappingFor(paramId) {
    return Object.keys(this.mappings).find((k) => this.mappings[k] === paramId) ?? null;
  }

  clear(paramId) {
    for (const k of Object.keys(this.mappings)) {
      if (!paramId || this.mappings[k] === paramId) delete this.mappings[k];
    }
    this.#save();
    this.onChange();
  }

  #inTauri() {
    return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  }

  async #nativeAccess() {
    const { requestNativeMidiAccess } = await import('./nativeMidi.js');
    return requestNativeMidiAccess();
  }

  #attach() {
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this.#handle(e.data, e.port || input.name);
    }
  }

  #handle(data, portName = '') {
    const [status, d1 = 0, d2 = 0] = data;
    const type = status & 0xf0;
    const ch = (status & 0x0f) + 1;
    let key;
    let value;

    if (type === 0xb0) {
      key = `CC ${ch}:${d1}`;
      value = d2 / 127;
    } else if (type === 0x90 || type === 0x80) {
      key = `Note ${ch}:${d1}`;
      value = type === 0x90 ? d2 / 127 : 0;
    } else if (type === 0xe0) {
      key = `PB ${ch}`;
      value = ((d2 << 7) | d1) / 16383;
    } else {
      return;
    }

    this.onControl(key, value, type);

    const msg = { key, value, type, ch, d1, d2, port: portName || '' };
    if (this.onHardware(msg) === true) {
      this.onActivity(key, value);
      return;
    }

    if (this.learnTarget && value > 0) {
      if (this.learnTarget.startsWith('macro:')) {
        if (type === 0xb0) {
          this.onMacroLearn(Number(this.learnTarget.slice(6)), key);
          this.learnTarget = null;
          this.onChange();
        }
      } else {
        this.clear(this.learnTarget);
        this.mappings[key] = this.learnTarget;
        this.learnTarget = null;
        this.#save();
        this.onChange();
      }
    }

    const target = this.mappings[key];
    const consumed = this.onRaw({ key, value, type, ch, d1, d2 }) === true;
    if (!consumed && target) {
      if (target.startsWith('scene:')) {
        if (value > 0) this.onTrigger(target.slice(6));
      } else if (target.startsWith('moment:')) {
        this.onMomentary(target.slice(7), value > 0);
      } else {
        this.params.setNormalized(target, value);
      }
    }
    this.onActivity(key, value);
  }

  #save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.mappings));
  }
}
