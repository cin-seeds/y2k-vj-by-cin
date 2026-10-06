// Scene presets: snapshots of every layer's parameters, media, and mirror state.
// Launching a scene can crossfade:
//   - layers whose shader / media / dropdown settings are unchanged glide every
//     continuous value (opacity, scale, glitch...) to the new scene;
//   - layers that need a hard switch dip to black, switch at the midpoint, and fade
//     back up, so the cut is never visible.

import { LAYERS } from '../params.js';

const STORAGE_KEY = 'vj.scenes';
const PAD_COLORS = ['#00f0ff', '#ff2bd6', '#7dffb0', '#ffd23f', '#9b7bff', '#ff7a3d', '#3df5c5', '#ff4f7b'];

export { PAD_COLORS };

const smooth = (k) => k * k * (3 - 2 * k);
const uid = () => Math.random().toString(36).slice(2, 10);

export class SceneManager {
  /**
   * params: ParamStore
   * getMedia(): { A: {key, mirror}, ... }    current per-layer media
   * applyMedia(layerId, {key, mirror})       switch a layer's media
   */
  constructor({ params, getMedia, applyMedia, getRouting, applyRouting, project, onSaveError }) {
    this.params = params;
    this.onSaveError = onSaveError || null;
    this.getMedia = getMedia;
    this.applyMedia = applyMedia;
    this.getRouting = getRouting || (() => ({}));
    this.applyRouting = applyRouting || (() => {});
    this.project = project || null;
    this.scenes = [];
    this.activeId = null;
    this.transition = null;
    this.listeners = new Set();
    if (project) this.scenes = project.scenes.map((s) => ({ ...s }));
    else this.#load();
  }

  get progress() {
    return this.transition ? Math.min(1, this.transition.t / this.transition.dur) : 1;
  }

  /** Layer-level state only: the master fader and input gain stay with the performer. */
  capture() {
    const params = {};
    for (const [id, v] of Object.entries(this.params.snapshot())) {
      if (this.params.defs.get(id).layer) params[id] = v;
    }
    return {
      params,
      media: structuredClone(this.getMedia()),
      routing: structuredClone(this.getRouting()),
    };
  }

  save(name) {
    const before = this.#clone();
    const n = this.scenes.length + 1;
    const scene = {
      id: uid(),
      name: name?.trim() || `Scene ${n}`,
      color: PAD_COLORS[(n - 1) % PAD_COLORS.length],
      createdAt: new Date().toISOString(),
      ...this.capture(),
    };
    this.scenes.push(scene);
    this.activeId = scene.id;
    this.#changed();
    this.#record(before);
    return scene;
  }

  overwrite(id) {
    const s = this.get(id);
    if (!s) return;
    const before = this.#clone();
    Object.assign(s, this.capture());
    this.#changed();
    this.#record(before);
  }

  rename(id, name) {
    const s = this.get(id);
    if (s && name?.trim()) {
      const before = this.#clone();
      s.name = name.trim();
      this.#changed();
      this.#record(before);
    }
  }

  setColor(id, color) {
    const s = this.get(id);
    if (!s || !PAD_COLORS.includes(color) || s.color === color) return;
    const before = this.#clone();
    s.color = color;
    this.#changed();
    this.#record(before);
  }

  remove(id) {
    const before = this.#clone();
    this.scenes = this.scenes.filter((s) => s.id !== id);
    if (this.activeId === id) this.activeId = null;
    this.#changed();
    this.#record(before);
  }

  get(id) {
    return this.scenes.find((s) => s.id === id);
  }

  /** Still of the program output, taken after a launch. Omitted on older scenes. */
  setThumb(id, url) {
    const scene = this.get(id);
    if (!scene || typeof url !== 'string') return;
    scene.thumb = url;
    this.#changed();
  }

  replaceAll(scenes) {
    this.scenes = scenes.map((s, i) => ({
      id: s.id || uid(),
      name: s.name || `Scene ${i + 1}`,
      color: s.color || PAD_COLORS[i % PAD_COLORS.length],
      createdAt: s.createdAt || new Date().toISOString(),
      params: s.params || {},
      media: s.media || {},
      routing: s.routing && typeof s.routing === 'object' ? s.routing : undefined,
      thumb: typeof s.thumb === 'string' ? s.thumb : undefined,
    }));
    this.activeId = null;
    this.transition = null;
    this.#changed();
  }

  /** Apply a scene (or any {params, media} state) over `fade` seconds. */
  launch(idOrState, fade = 0) {
    const scene = typeof idOrState === 'string' ? this.get(idOrState) : idOrState;
    if (!scene) return;
    if (scene.id) this.activeId = scene.id;

    if (scene.routing) this.applyRouting(scene.routing);

    const from = this.params.snapshot();
    const currentMedia = this.getMedia();
    const mediaChange = new Set();
    for (const L of LAYERS) {
      const target = scene.media?.[L];
      const cur = currentMedia[L];
      if (target && (target.key !== cur.key || !!target.mirror !== !!cur.mirror)) mediaChange.add(L);
    }
    // Start loading the new clips immediately. The outgoing decoder stays up until
    // the incoming one is ready, so the compositor never drops to a test pattern.
    for (const L of mediaChange) this.applyMedia(L, scene.media[L]);

    const dip = new Set();
    for (const [id, v] of Object.entries(scene.params || {})) {
      const def = this.params.defs.get(id);
      if (def?.layer && this.params.isDiscrete(id) && from[id] !== v) dip.add(def.layer);
    }

    if (!(fade > 0)) {
      this.transition = null;
      for (const [id, v] of Object.entries(scene.params || {})) this.params.set(id, v);
      this.#emit();
      return;
    }

    this.transition = { t: 0, dur: fade, from, scene, dip, mediaChange, switched: false };
    this.#emit();
  }

  update(dt) {
    const tr = this.transition;
    if (!tr) return;
    tr.t += dt;
    const k = Math.min(1, tr.t / tr.dur);
    const { from, scene, dip } = tr;

    if (k >= 0.5 && !tr.switched) {
      tr.switched = true;
    }

    for (const [id, to] of Object.entries(scene.params || {})) {
      const def = this.params.defs.get(id);
      if (!def?.layer || from[id] === undefined) continue;
      const fromV = from[id];

      if (dip.has(def.layer)) {
        if (def.key === 'opacity') {
          const v = k < 0.5 ? fromV * (1 - smooth(k * 2)) : to * smooth((k - 0.5) * 2);
          this.params.set(id, v);
        } else if (tr.switched) {
          this.params.set(id, to);
        }
      } else if (!this.params.isDiscrete(id)) {
        this.params.set(id, fromV + (to - fromV) * smooth(k));
      }
    }

    if (k >= 1) {
      for (const [id, v] of Object.entries(scene.params || {})) this.params.set(id, v);
      this.transition = null;
      this.#emit();
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  #clone() {
    return { scenes: structuredClone(this.scenes), activeId: this.activeId };
  }

  #record(before) {
    if (typeof this.onHistory !== 'function') return;
    const after = this.#clone();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.onHistory(before, after);
  }

  restoreHistory(snap) {
    if (!snap) return;
    this.replaceAll(snap.scenes || []);
    this.activeId = snap.activeId || null;
    this.#emit();
  }

  #changed() {
    this.#persist();
    this.#emit();
  }

  #emit() {
    for (const fn of this.listeners) fn();
  }

  #persist() {
    if (this.project) {
      if (this.project.adoptScenes(this.scenes) === false) {
        this.onSaveError?.('Scenes could not be saved - storage is full');
      }
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.scenes));
    } catch (err) {
      console.warn('Could not save scenes', err);
      this.onSaveError?.('Scenes could not be saved - storage is full');
    }
  }

  #load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(raw)) this.scenes = raw;
    } catch {
      this.scenes = [];
    }
  }
}
