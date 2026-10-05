// One document for the show: the media pool, scene snapshots, and the
// timeline markers. Clips stay in the pool. The timeline only stores which
// scene starts on which bar.

const STORAGE_KEY = 'vj.project';

const emptyTransport = () => ({
  bpm: 120,
  bars: 16,
  loop: true,
  fadeBeats: 4,
  fadeSec: 1,
  fadeStyle: 0,
});

function markerBar(beat) {
  return Math.floor(Math.max(0, Number(beat) || 0) / 4);
}

export function normalizeMarker(cue) {
  if (!cue) return null;
  const beat = Math.max(0, Math.round(Number(cue.beat) || 0));
  const id = cue.id || Math.random().toString(36).slice(2, 10);
  const bar = Number.isFinite(Number(cue.bar)) ? Number(cue.bar) : markerBar(beat);
  if (cue.kind === 'clip' && (cue.mediaName || cue.mediaId || cue.name)) {
    const mediaName = String(cue.mediaName || cue.name || cue.mediaId);
    const layerId = cue.layerId === 'B' || cue.layerId === 'C' ? cue.layerId : 'A';
    return {
      id,
      kind: 'clip',
      mediaId: String(cue.mediaId || mediaName),
      mediaName,
      layerId,
      beat,
      bar,
    };
  }
  if (cue.sceneId == null || cue.sceneId === '') return null;
  return { id, sceneId: cue.sceneId, beat, bar };
}

/** Keep only the sections that are actually locked. Missing or empty means unlocked. */
export function normalizeLocks(locks) {
  const out = {};
  if (!locks || typeof locks !== 'object' || Array.isArray(locks)) return out;
  for (const [key, value] of Object.entries(locks)) {
    if (typeof key === 'string' && key && value === true) out[key] = true;
  }
  return out;
}

export class ProjectState {
  constructor() {
    this.mediaPool = [];
    this.scenes = [];
    this.timeline = [];
    this.transport = emptyTransport();
    this.locks = {};
    this.recordOutput = { code: null, screen: null };
    this.#load();
  }

  /** The file the browser downloads. Timeline is the marker array, not the clips. */
  toJSON() {
    return {
      app: 'live-vj-tool',
      kind: 'project',
      version: 4,
      mediaPool: this.mediaPool,
      scenes: this.scenes,
      timeline: this.timeline,
      transport: this.transport,
      locks: { ...this.locks },
      recordOutput: {
        code: this.recordOutput.code,
        screen: this.recordOutput.screen,
      },
    };
  }

  setLocks(locks) {
    this.locks = normalizeLocks(locks);
    this.#write();
  }

  setRecordOutput(next) {
    this.recordOutput = normalizeRecordOutput(next);
    this.#write();
  }

  setMediaPool(pool) {
    this.mediaPool = Array.isArray(pool) ? pool : [];
    this.#write();
  }

  /** Returns false when localStorage refused the write. */
  adoptScenes(scenes) {
    this.scenes = Array.isArray(scenes) ? scenes : [];
    return this.#write();
  }

  /** Write the current document to localStorage now. Returns false if storage refused it. */
  save() {
    return this.#write();
  }

  adoptTimeline(markers, transport = {}) {
    this.timeline = (Array.isArray(markers) ? markers : []).map(normalizeMarker).filter(Boolean);
    this.transport = { ...emptyTransport(), ...transport };
    this.#write();
  }

  /** Replace the three arrays from a project file or an older setlist. */
  replaceDocument(data) {
    const doc = coerceDocument(data);
    this.mediaPool = doc.mediaPool;
    this.scenes = doc.scenes;
    this.timeline = doc.timeline;
    this.transport = doc.transport;
    this.locks = doc.locks;
    this.recordOutput = doc.recordOutput;
    this.#write();
    return doc;
  }

  clearShow() {
    this.scenes = [];
    this.timeline = [];
    this.transport = emptyTransport();
    this.locks = {};
    this.recordOutput = { code: null, screen: null };
    this.#write();
  }

  #write() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch {
      /* storage full: the session still runs */
      return false;
    }
  }

  #load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && (Array.isArray(raw.scenes) || Array.isArray(raw.timeline) || Array.isArray(raw.mediaPool))) {
        const doc = coerceDocument(raw);
        this.mediaPool = doc.mediaPool;
        this.scenes = doc.scenes;
        this.timeline = doc.timeline;
        this.transport = doc.transport;
        this.locks = doc.locks;
        this.recordOutput = doc.recordOutput;
        return;
      }
    } catch { /* fall through to the older keys */ }

    let scenes = [];
    let timeline = null;
    try { scenes = JSON.parse(localStorage.getItem('vj.scenes') || '[]'); } catch { scenes = []; }
    try { timeline = JSON.parse(localStorage.getItem('vj.timeline') || 'null'); } catch { timeline = null; }
    const doc = coerceDocument({
      scenes: Array.isArray(scenes) ? scenes : [],
      timeline,
    });
    this.mediaPool = doc.mediaPool;
    this.scenes = doc.scenes;
    this.timeline = doc.timeline;
    this.transport = doc.transport;
    this.locks = doc.locks;
    this.recordOutput = doc.recordOutput;
    this.#write();
  }
}

function normalizeRecordOutput(raw) {
  const out = { code: null, screen: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.code === 'boolean') out.code = raw.code;
  if (typeof raw.screen === 'boolean') out.screen = raw.screen;
  return out;
}

/** Accept a vjproj or an older setlist (timeline object with a cues array). */
export function coerceDocument(data = {}) {
  const transportIn = Array.isArray(data.timeline) ? (data.transport || {}) : (data.timeline || {});
  const markers = Array.isArray(data.timeline)
    ? data.timeline
    : (Array.isArray(data.timeline?.cues) ? data.timeline.cues : []);
  const transport = { ...emptyTransport(), ...transportIn };
  const mediaPool = Array.isArray(data.mediaPool)
    ? data.mediaPool.filter((item) => item && (item.name || item.id)).map((item) => ({
      id: String(item.id || item.name),
      name: String(item.name || item.id),
      kind: item.kind === 'image' ? 'image' : 'video',
    }))
    : (Array.isArray(data.mediaFiles) ? data.mediaFiles.filter(Boolean).map((name) => ({
      id: String(name),
      name: String(name),
      kind: 'video',
    })) : []);
  return {
    mediaPool,
    scenes: Array.isArray(data.scenes) ? data.scenes : [],
    timeline: markers.map(normalizeMarker).filter(Boolean),
    transport,
    locks: normalizeLocks(data.locks),
    recordOutput: normalizeRecordOutput(data.recordOutput),
    legacy: data,
  };
}
