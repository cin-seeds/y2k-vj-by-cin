// IndexedDB blob store. Scenes only remember a file name; this keeps the actual
// File around so a refresh or a scene launch can rebuild an object URL.

const DB_NAME = 'live-vj-media';
const DB_VERSION = 1;
const STORE = 'blobs';

const AUDIO_EXT = /\.(mp3|wav|wave|ogg|m4a|aac|flac)$/i;
const VISUAL_EXT = /\.(mp4|mov|m4v|webm|ogv|png|jpe?g|gif|webp|bmp|avif)$/i;

export const kindOf = (file) => {
  if (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  if (file.type.startsWith('image/') || file.type.startsWith('video/') || VISUAL_EXT.test(file.name)) return 'visual';
  return '';
};

const fingerprint = (file) => `${file.size}:${file.lastModified}:${file.name}`;

const toFile = (rec) => {
  if (!rec?.blob) return null;
  return new File([rec.blob], rec.fileName || rec.name, { type: rec.type || '', lastModified: rec.lastModified || 0 });
};

export class MediaCache {
  constructor() {
    this.db = null;
    this.ready = this.#open();
  }

  async #open() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'name' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this;
  }

  async put(file, extra = {}) {
    await this.ready;
    const kind = extra.kind || kindOf(file);
    if (!kind) return;
    const rec = {
      name: extra.name || file.name,
      fileName: extra.fileName || file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      hash: fingerprint(file),
      kind,
      blob: file,
      thumbnail: typeof extra.thumbnail === 'string' ? extra.thumbnail : null,
    };
    await this.#req((store) => store.put(rec));
  }

  async get(name) {
    const entry = await this.getEntry(name);
    return entry?.file ?? null;
  }

  async getEntry(name) {
    await this.ready;
    const rec = await this.#req((store) => store.get(name));
    if (!rec?.blob) return null;
    return {
      file: toFile(rec),
      thumbnail: typeof rec.thumbnail === 'string' ? rec.thumbnail : null,
    };
  }

  async delete(name) {
    await this.ready;
    await this.#req((store) => store.delete(name));
  }

  async list(kind) {
    const rows = await this.entries(kind);
    return rows.map((row) => row.file);
  }

  async entries(kind) {
    await this.ready;
    const rows = await this.#req((store) => store.getAll());
    return (rows || [])
      .filter((r) => !kind || r.kind === kind)
      .map((r) => ({
        file: toFile(r),
        thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : null,
      }))
      .filter((r) => r.file);
  }

  #req(fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
