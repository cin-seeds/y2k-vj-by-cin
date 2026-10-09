// Files the user has added, keyed by file name. Browsers never expose real paths,
// so scenes refer to media by name and this library resolves them — first from
// memory, then from the IndexedDB cache across sessions.
//
// A library item is a file plus a still thumbnail. It does not own a <video>
// element or a WebGL texture. Those are created only when a layer is assigned the clip.

import { kindOf, MediaCache } from './MediaCache.js';
import {
  captureThumbnail,
  captureThumbnailFromSrc,
  isImageFile,
  isVideoFile,
  thumbnailIsBlank,
} from './thumbnail.js';

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|ogv|png|jpe?g|gif|webp|bmp|avif)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

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
      for (const row of stored) {
        const item = this.#remember(row.file, row.thumbnail);
        item.thumbRev = row.thumbRev || 0;
      }
      this.#loadRemote();
      for (const item of this.items.values()) this.#queueThumb(item);
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
      if (same) item.thumbRev = prev.thumbRev || 0;
      added.push(f.name);
      this.cache.put(f, { thumbnail: item.thumbnail, thumbRev: item.thumbRev || 0 }).catch((err) => console.warn('Could not cache', f.name, err));
      this.#queueThumb(item);
    }
    if (added.length) this.#emit();
    return added;
  }

  cacheAudio(file) {
    if (kindOf(file) !== 'audio') return Promise.resolve();
    return this.cache.put(file).catch((err) => console.warn('Could not cache audio', file.name, err));
  }

  async getAudio(name) {
    return this.cache.get(name);
  }

  cacheBlob(name, file, kind) {
    if (!name || !file) return Promise.resolve();
    return this.cache.put(file, { name, kind, fileName: file.name }).catch((err) => console.warn('Could not cache', name, err));
  }

  getBlob(name) {
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
      const item = this.#remember(entry.file, entry.thumbnail);
      item.thumbRev = entry.thumbRev || 0;
      this.#queueThumb(item);
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
      kind: IMAGE_EXT.test(name) ? 'image' : 'video',
      thumbnail: thumbnail || prev?.thumbnail || null,
      thumbRev: prev?.thumbRev || 0,
      alts: Array.isArray(alts) ? alts.filter((item) => item && item !== url) : (prev?.alts || []),
    };
    this.items.set(name, item);
    this.#saveRemote();
    this.#queueThumb(item);
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
      thumbRev: 0,
    };
    this.items.set(file.name, item);
    return item;
  }

  #isImage(item) {
    if (!item) return false;
    if (item.kind === 'image') return true;
    if (item.file && isImageFile(item.file)) return true;
    return IMAGE_EXT.test(item.name || '');
  }

  #canThumb(item) {
    return !!(item && (item.file || item.url) && item.kind !== 'audio');
  }

  #persistThumb(item) {
    if (item.file) {
      this.cache.put(item.file, { thumbnail: item.thumbnail, thumbRev: item.thumbRev || 0 }).catch(() => {});
    }
    if (item.url) this.#saveRemote();
  }

  #queueThumb(item) {
    if (!this.#canThumb(item)) return;
    if (!item.thumbnail) {
      this.#enqueueThumb(item.name);
      return;
    }
    if (this.#isImage(item)) {
      item.thumbRev = 2;
      return;
    }
    // Re-check stored stills: a black frame used to be locked after two tries.
    thumbnailIsBlank(item.thumbnail).then((blank) => {
      const current = this.items.get(item.name);
      if (!current || current.thumbnail !== item.thumbnail) return;
      if (!blank) {
        current.thumbRev = 2;
        this.#persistThumb(current);
        return;
      }
      current.thumbnail = null;
      current.thumbRev = 0;
      this.#enqueueThumb(current.name);
      this.#emit();
    }).catch(() => {});
  }

  #enqueueThumb(name) {
    if (!name || this.#thumbQueue.includes(name)) return;
    this.#thumbQueue.push(name);
    this.#drainThumbs();
  }

  async #captureFor(item) {
    if (item.file) return captureThumbnail(item.file);
    if (!item.url) return null;
    return captureThumbnailFromSrc(item.url, item.name);
  }

  async #drainThumbs() {
    if (this.#thumbBusy) return;
    this.#thumbBusy = true;
    try {
      while (this.#thumbQueue.length) {
        const name = this.#thumbQueue.shift();
        const item = this.items.get(name);
        if (!item || item.thumbnail || !this.#canThumb(item)) continue;
        try {
          let thumbnail = await this.#captureFor(item);
          const current = this.items.get(name);
          if (!current || (item.file && current.file !== item.file) || (!item.file && current.url !== item.url)) continue;
          if (!thumbnail) continue;
          if (!this.#isImage(current)) {
            const blank = await thumbnailIsBlank(thumbnail);
            if (blank) {
              // One more pass — decoder sometimes needs a second open.
              thumbnail = await this.#captureFor(current);
              if (!thumbnail || await thumbnailIsBlank(thumbnail)) continue;
            }
          }
          current.thumbnail = thumbnail;
          current.thumbRev = 2;
          this.#persistThumb(current);
          this.#emit();
        } catch (err) {
          console.warn('Could not thumbnail', name, err);
        }
      }
    } finally {
      this.#thumbBusy = false;
      if (this.#thumbQueue.length) this.#drainThumbs();
    }
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
        kind: IMAGE_EXT.test(row.name) ? 'image' : 'video',
        thumbnail: row.thumbnail || null,
        thumbRev: row.thumbnail ? 2 : 0,
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
