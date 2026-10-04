// Files the user has added, keyed by file name. Browsers never expose real paths,
// so scenes refer to media by name and this library resolves them — first from
// memory, then from the IndexedDB cache across sessions.
//
// A library item is a file plus a still thumbnail. It does not own a <video>
// element or a WebGL texture. Those are created only when a layer is assigned the clip.

import { kindOf, MediaCache } from './MediaCache.js';
import { captureThumbnail, isImageFile } from './thumbnail.js';

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|ogv|png|jpe?g|gif|webp|bmp|avif)$/i;

const REMOTE_KEY = 'vj.remoteLoops';

export class MediaLibrary {
  #thumbQueue = [];
  #thumbBusy = false;

  constructor() {
    this.items = new Map();
    this.cameras = [];
    this.listeners = new Set();
    this.cache = new MediaCache();
    this.ready = this.#hydrate();
  }

  async #hydrate() {
    try {
      const stored = await this.cache.entries('visual');
      for (const row of stored) this.#remember(row.file, row.thumbnail);
      for (const item of this.items.values()) {
        if (!item.thumbnail && item.file) this.#enqueueThumb(item.name);
      }
      this.#loadRemote();
      if (this.items.size) this.#emit();
    } catch (err) {
      console.warn('Media cache unavailable', err);
    }
  }

  add(fileList) {
    const added = [];
    for (const f of fileList) {
      if (!(f.type.startsWith('image/') || f.type.startsWith('video/') || MEDIA_EXT.test(f.name))) continue;
      const prev = this.items.get(f.name);
      const same = prev
        && prev.file.size === f.size
        && prev.file.lastModified === f.lastModified
        && prev.thumbnail;
      const item = this.#remember(f, same ? prev.thumbnail : null);
      added.push(f.name);
      this.cache.put(f, { thumbnail: item.thumbnail }).catch((err) => console.warn('Could not cache', f.name, err));
      if (!item.thumbnail) this.#enqueueThumb(f.name);
    }
    if (added.length) this.#emit();
    return added;
  }

  cacheAudio(file) {
    if (kindOf(file) !== 'audio') return;
    this.cache.put(file).catch((err) => console.warn('Could not cache audio', file.name, err));
  }

  async getAudio(name) {
    return this.cache.get(name);
  }

  /** Pull named files back out of IndexedDB into the live library. */
  async ensureCached(names) {
    await this.ready;
    let added = 0;
    for (const name of names) {
      if (!name || this.items.has(name)) continue;
      const entry = await this.cache.getEntry(name);
      if (!entry?.file) continue;
      this.#remember(entry.file, entry.thumbnail);
      if (!entry.thumbnail) this.#enqueueThumb(entry.file.name);
      added += 1;
    }
    if (added) this.#emit();
    return added;
  }

  remove(name) {
    const had = this.items.delete(name);
    this.cache.delete(name).catch(() => {});
    this.#saveRemote();
    if (had) this.#emit();
  }

  /** A streamed loop. The card keeps the MP4 address; playback uses that URL. */
  addRemote({ name, url, thumbnail, alts }) {
    if (!name || !url) return null;
    const prev = this.items.get(name);
    const item = {
      id: name,
      name,
      file: prev?.file || null,
      url,
      kind: 'video',
      thumbnail: thumbnail || prev?.thumbnail || null,
      alts: Array.isArray(alts) ? alts.filter((item) => item && item !== url) : (prev?.alts || []),
    };
    this.items.set(name, item);
    this.#saveRemote();
    this.#emit();
    return item;
  }

  /** The File itself, for a layer that is about to decode it. */
  get(name) {
    return this.items.get(name)?.file ?? null;
  }

  /** File, kind, and thumbnail. No decoder. */
  mediaItem(name) {
    return this.items.get(name) ?? null;
  }

  has(name) {
    return this.items.has(name);
  }

  get names() {
    return [...this.items.keys()];
  }

  async refreshCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.cameras = devices.filter((d) => d.kind === 'videoinput');
    this.#emit();
    return this.cameras;
  }

  cameraLabel(deviceId) {
    const i = this.cameras.findIndex((c) => c.deviceId === deviceId);
    if (i < 0) return 'Camera';
    return this.cameras[i].label || `Camera ${i + 1}`;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  #remember(file, thumbnail) {
    const item = {
      id: file.name,
      name: file.name,
      file,
      kind: isImageFile(file) ? 'image' : 'video',
      thumbnail: thumbnail || null,
    };
    this.items.set(file.name, item);
    return item;
  }

  #enqueueThumb(name) {
    this.#thumbQueue.push(name);
    this.#drainThumbs();
  }

  async #drainThumbs() {
    if (this.#thumbBusy) return;
    this.#thumbBusy = true;
    while (this.#thumbQueue.length) {
      const name = this.#thumbQueue.shift();
      const item = this.items.get(name);
      if (!item || item.thumbnail) continue;
      try {
        const thumbnail = await captureThumbnail(item.file);
        const current = this.items.get(name);
        if (!current || current.file !== item.file || !thumbnail) continue;
        current.thumbnail = thumbnail;
        this.cache.put(current.file, { thumbnail }).catch(() => {});
        this.#emit();
      } catch (err) {
        console.warn('Could not thumbnail', name, err);
      }
    }
    this.#thumbBusy = false;
  }

  #emit() {
    for (const fn of this.listeners) fn();
  }

  #loadRemote() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(REMOTE_KEY) || '[]'); } catch { rows = []; }
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row?.name || !row?.url || this.items.has(row.name)) continue;
      this.items.set(row.name, {
        id: row.name,
        name: row.name,
        file: null,
        url: row.url,
        kind: 'video',
        thumbnail: row.thumbnail || null,
        alts: Array.isArray(row.alts) ? row.alts.filter((url) => typeof url === 'string') : [],
      });
    }
  }

  #saveRemote() {
    const rows = [];
    for (const item of this.items.values()) {
      if (!item.url) continue;
      rows.push({
        name: item.name,
        url: item.url,
        thumbnail: item.thumbnail || '',
        alts: (item.alts || []).filter((url) => /\.(mp4|webm)(\?|#|$)/i.test(url) && !/\.(ogv|ogg|ogx)(\?|#|$)/i.test(url)),
      });
    }
    try { localStorage.setItem(REMOTE_KEY, JSON.stringify(rows)); } catch { /* private mode */ }
  }
}
