// Web MIDI with "MIDI learn": arm a parameter, then move any CC / pad / pitch bend.
// Notes act as momentary controls (velocity on press, 0 on release).
// Targets named "scene:<id>" are triggers: any non-zero value launches that scene.
// Those bindings stay on that scene id when the pad order changes; slot maps do not rewrite them.

import { IS_TAURI } from '../ipc.js';

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
    /** @type {Promise<void> | null} */
    this._starting = null;
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
    if (typeof navigator.requestMIDIAccess === 'function') return true;
    return this.#inTauri();
  }

  /**
   * Open MIDI. Call this from a click or other user gesture so the OS/browser
   * can show a permission prompt. On desktop, empty or failed Web MIDI falls
   * through to the native midir path (Windows, macOS, and Linux).
   */
  async init() {
    if (!this.supported) throw new Error('MIDI access failed — try again');
    if (this.access) {
      // Already authorised: re-list native ports on a later Enable MIDI click.
      if (this.#inTauri() && typeof this.access.applyPorts === 'function') {
        try {
          await this.#nativeAccess();
          this.#attach();
        } catch { /* keep the open access */ }
      }
      return;
    }
    if (this._starting) return this._starting;
    this._starting = this.#open().finally(() => { this._starting = null; });
    return this._starting;
  }

  async #open() {
    let webAccess = null;
    let webErr = null;
    if (typeof navigator.requestMIDIAccess === 'function') {
      try {
        // Must start from a user gesture. WebView2 on Windows often never shows
        // a prompt and can hang — time out so midir can take over.
        webAccess = await raceTimeout(
          navigator.requestMIDIAccess({ sysex: false }),
          3000,
          'MIDI access timed out',
        );
      } catch (err) {
        webErr = err;
      }
    }

    const webInputs = webAccess ? webAccess.inputs.size : 0;
    if (webAccess && webInputs > 0) {
      this.#useAccess(webAccess);
      return;
    }

    if (this.#inTauri()) {
      try {
        // Prefer native whenever Web MIDI failed or listed no inputs, so the
        // midir poller (not an empty Web MIDI map) owns hot-plug on Windows.
        const native = await this.#nativeAccess();
        this.#useAccess(native);
        return;
      } catch (nativeErr) {
        if (!webAccess) throw webErr || nativeErr;
      }
    }

    if (webAccess) {
      this.#useAccess(webAccess);
      return;
    }
    throw webErr || new Error('MIDI access failed — try again');
  }

  #useAccess(access) {
    this.access = access;
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
    return IS_TAURI;
  }

  async #nativeAccess() {
    const { requestNativeMidiAccess } = await import('./nativeMidi.js');
    return requestNativeMidiAccess();
  }

  #attach() {
    if (!this.access) return;
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

function raceTimeout(promise, ms, message) {
  let timer = 0;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
