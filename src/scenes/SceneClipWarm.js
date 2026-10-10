// Keeps file/url decoders warm for clips used by saved scenes so a pad launch
// can adopt a ready InputManager instead of opening the file on press.
// Standby entries are not bound to any layer. take() transfers ownership once.
//
// Budgets matter on macOS WKWebView: too many parked <video> elements stutter
// Live even while paused. Call setBudget() from the desk mode sync.

import { InputManager } from '../input/InputManager.js';
import { LAYERS } from '../params.js';

const DEFAULT_MAX_KEYS = 18;
const DEFAULT_MAX_ACTIVE = 2;
const DEFAULT_MAX_PARKED = 6;

function warmable(key) {
  return typeof key === 'string' && (key.startsWith('file:') || key.startsWith('url:'));
}

export function sceneClipKeys(scenes, limit = DEFAULT_MAX_KEYS) {
  const keys = [];
  const seen = new Set();
  for (const scene of scenes || []) {
    for (const L of LAYERS) {
      const key = scene?.media?.[L]?.key;
      if (!warmable(key) || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length >= limit) return keys;
    }
  }
  return keys;
}

export class SceneClipWarm {
  /**
   * getFile(name) -> File | null
   * getRemote(name) -> { url, alts } | null
   */
  constructor({ getFile, getRemote, maxKeys, maxActive, maxParked } = {}) {
    this.getFile = getFile;
    this.getRemote = getRemote;
    this.entries = new Map();
    this.wanted = new Set();
    this.active = 0;
    this.maxKeys = maxKeys ?? DEFAULT_MAX_KEYS;
    this.maxActive = maxActive ?? DEFAULT_MAX_ACTIVE;
    this.maxParked = maxParked ?? DEFAULT_MAX_PARKED;
  }

  /** Tighten or relax the warm pool (macOS Live uses a small parked set). */
  setBudget({ maxKeys, maxActive, maxParked } = {}) {
    if (maxKeys != null) this.maxKeys = Math.max(0, maxKeys | 0);
    if (maxActive != null) this.maxActive = Math.max(0, maxActive | 0);
    if (maxParked != null) this.maxParked = Math.max(0, maxParked | 0);
    this.#trimToBudget();
  }

  /** Drop anything not needed; start loads for missing keys. Skip keys already live on a layer. */
  sync(keys, liveKeys = []) {
    const live = new Set((liveKeys || []).filter(warmable));
    const next = (keys || []).filter((k) => warmable(k) && !live.has(k)).slice(0, this.maxKeys);
    this.wanted = new Set(next);

    for (const [key, entry] of [...this.entries]) {
      if (this.wanted.has(key)) continue;
      this.#drop(key, entry);
    }

    for (const key of this.wanted) {
      if (!this.entries.has(key)) this.#enqueue(key);
    }
    this.#trimParked();
    this.#pump();
  }

  syncFromScenes(scenes, liveKeys) {
    this.sync(sceneClipKeys(scenes, this.maxKeys), liveKeys);
  }

  /** Remove a ready InputManager for this key, or null if still loading / missing. */
  take(key) {
    if (!warmable(key)) return null;
    const entry = this.entries.get(key);
    if (!entry?.ready || !entry.input) return null;
    this.entries.delete(key);
    const input = entry.input;
    entry.input = null;
    entry.dropped = true;
    // Refill for the next scene that still lists this clip (within budget).
    if (this.wanted.has(key) && this.#readyCount() < this.maxParked) this.#enqueue(key);
    this.#pump();
    return input;
  }

  dispose() {
    this.wanted.clear();
    for (const [key, entry] of [...this.entries]) this.#drop(key, entry);
  }

  #readyCount() {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.ready) n += 1;
    }
    return n;
  }

  #trimToBudget() {
    if (this.wanted.size > this.maxKeys) {
      const keep = new Set([...this.wanted].slice(0, this.maxKeys));
      for (const key of [...this.wanted]) {
        if (keep.has(key)) continue;
        this.wanted.delete(key);
        const entry = this.entries.get(key);
        if (entry) this.#drop(key, entry);
      }
    }
    this.#trimParked();
    this.#pump();
  }

  /** Prefer earlier scene clips; drop surplus ready decoders. */
  #trimParked() {
    const readyKeys = [];
    for (const key of this.wanted) {
      if (this.entries.get(key)?.ready) readyKeys.push(key);
    }
    for (const [key, entry] of this.entries) {
      if (entry.ready && !this.wanted.has(key)) readyKeys.push(key);
    }
    if (readyKeys.length <= this.maxParked) return;
    const keep = new Set(readyKeys.slice(0, this.maxParked));
    for (const key of readyKeys) {
      if (keep.has(key)) continue;
      const entry = this.entries.get(key);
      if (entry) this.#drop(key, entry);
    }
  }

  #enqueue(key) {
    if (this.entries.has(key)) return;
    this.entries.set(key, {
      key,
      input: null,
      ready: false,
      promise: null,
      dropped: false,
    });
  }

  #pump() {
    if (this.maxActive <= 0 || this.maxKeys <= 0) return;
    for (const entry of this.entries.values()) {
      if (this.active >= this.maxActive) return;
      if (this.#readyCount() >= this.maxParked && !entry.ready && !entry.promise) continue;
      if (entry.ready || entry.promise || entry.dropped) continue;
      this.#start(entry);
    }
  }

  #start(entry) {
    this.active += 1;
    entry.promise = this.#load(entry.key)
      .then((input) => {
        if (entry.dropped || !this.entries.has(entry.key) || !this.wanted.has(entry.key)) {
          input?.dispose();
          if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
          return;
        }
        if (!input?.isDrawable()) {
          input?.dispose();
          this.entries.delete(entry.key);
          return;
        }
        if (this.#readyCount() >= this.maxParked) {
          input.dispose();
          this.entries.delete(entry.key);
          return;
        }
        entry.input = input;
        entry.ready = true;
        // Park the decoder; the layer plays it after take().
        input.pause();
      })
      .catch(() => {
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      })
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        entry.promise = null;
        this.#trimParked();
        this.#pump();
      });
  }

  async #load(key) {
    const input = new InputManager();
    if (key.startsWith('file:')) {
      const file = this.getFile?.(key.slice(5));
      if (!file) {
        input.dispose();
        return null;
      }
      await input.useFile(file, { standby: true });
    } else if (key.startsWith('url:')) {
      const item = this.getRemote?.(key.slice(4));
      if (!item?.url) {
        input.dispose();
        return null;
      }
      const ok = await input.useUrl(item.url, item.alts || [], { standby: true });
      if (!ok) {
        input.dispose();
        return null;
      }
    } else {
      input.dispose();
      return null;
    }
    const ready = await input.whenDrawable();
    if (!ready) {
      input.dispose();
      return null;
    }
    return input;
  }

  #drop(key, entry) {
    this.entries.delete(key);
    if (!entry) return;
    entry.dropped = true;
    if (entry.input) {
      entry.input.dispose();
      entry.input = null;
    }
  }
}
