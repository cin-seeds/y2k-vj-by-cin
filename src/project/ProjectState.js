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
    this.recordOutput = emptyRecordOutput();
    this.recordings = emptyRoute();
    this.outputs = emptyRoute();
    this.compositions = emptyCompositions();
    this.desk = null;
    this.view = null;
    this.name = '';
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
      recordOutput: { ...this.recordOutput },
      recordings: { ...this.recordings },
      outputs: { ...this.outputs },
      compositions: this.compositions.map((slot) => (slot ? { ...slot } : null)),
      desk: this.desk,
      view: this.view,
      name: this.name,
    };
  }

  setName(name) {
    this.name = normalizeProjectName(name);
    this.#write();
  }

  setView(view) {
    this.view = normalizeView(view);
    this.#write();
  }

  setDesk(desk) {
    this.desk = normalizeDesk(desk);
    this.#write();
  }

  setLocks(locks) {
    this.locks = normalizeLocks(locks);
    this.#write();
  }

  setRecordOutput(next) {
    this.recordOutput = normalizeRecordOutput(next);
    this.#write();
  }

  setRoutes({ recordings, outputs } = {}) {
    if (recordings) this.recordings = normalizeRoute(recordings, this.recordings);
    if (outputs) this.outputs = normalizeRoute(outputs, this.outputs);
    this.#write();
  }

  setCompositions(next) {
    this.compositions = normalizeCompositions(next);
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
    this.recordings = doc.recordings;
    this.outputs = doc.outputs;
    this.compositions = doc.compositions;
    this.desk = doc.desk;
    this.view = doc.view;
    this.name = doc.name;
    this.#write();
    return doc;
  }

  clearShow() {
    this.scenes = [];
    this.timeline = [];
    this.transport = emptyTransport();
    this.locks = {};
    this.recordOutput = emptyRecordOutput();
    this.recordings = emptyRoute();
    this.outputs = emptyRoute();
    this.compositions = emptyCompositions();
    this.desk = null;
    this.view = null;
    this.name = '';
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
        this.recordings = doc.recordings;
        this.outputs = doc.outputs;
        this.compositions = doc.compositions;
        this.desk = doc.desk;
        this.view = doc.view;
        this.name = doc.name;
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
    this.recordings = doc.recordings;
    this.outputs = doc.outputs;
    this.compositions = doc.compositions;
    this.desk = doc.desk;
    this.view = doc.view;
    this.name = doc.name;
    this.#write();
  }
}

function normalizeProjectName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 48);
}

function emptyRecordOutput() {
  return {
    codeRecord: null,
    codeOutput: null,
    screenRecord: null,
    screenOutput: null,
    logoRecord: null,
    logoOutput: null,
  };
}

function emptyRoute() {
  return { audio: null, screensaver: null, codeOverlay: null };
}

function normalizeRoute(raw, fallback = emptyRoute()) {
  const base = fallback && typeof fallback === 'object' ? fallback : emptyRoute();
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const flag = (key) => (typeof src[key] === 'boolean' ? src[key] : (typeof base[key] === 'boolean' ? base[key] : null));
  return {
    audio: flag('audio'),
    screensaver: flag('screensaver'),
    codeOverlay: flag('codeOverlay'),
  };
}

function readRecordPair(raw, legacy, recordKey, outputKey) {
  let record = null;
  let output = null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { record, output };
  const legacyValue = raw[legacy];
  if (typeof legacyValue === 'boolean') {
    record = legacyValue;
    output = legacyValue;
  } else if (legacyValue && typeof legacyValue === 'object' && !Array.isArray(legacyValue)) {
    if (typeof legacyValue.record === 'boolean') record = legacyValue.record;
    if (typeof legacyValue.output === 'boolean') output = legacyValue.output;
  }
  if (typeof raw[recordKey] === 'boolean') record = raw[recordKey];
  if (typeof raw[outputKey] === 'boolean') output = raw[outputKey];
  return { record, output };
}

const COMP_RANGES = [
  ['gradeHue', 0, 1],
  ['gradeSat', 0, 2],
  ['gradeContrast', 0, 2],
  ['crtBleed', 0, 1],
  ['crtScan', 0, 1],
  ['chroma', 0, 1],
  ['strobe', 0, 1],
  ['strobeSrc', 0, 2],
  ['strobePol', 0, 1],
  ['master', 0, 1],
  ['speed', 0, 4],
  ['bpm', 20, 300],
];

function emptyCompositions() {
  return [null, null, null];
}

function normalizeComposition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const slot = {};
  for (const [key, min, max] of COMP_RANGES) {
    const n = Number(raw[key]);
    if (!Number.isFinite(n)) return null;
    slot[key] = Math.min(max, Math.max(min, n));
  }
  slot.strobeSrc = Math.round(slot.strobeSrc);
  slot.strobePol = Math.round(slot.strobePol);
  if (typeof raw.code !== 'boolean' || typeof raw.screen !== 'boolean') return null;
  slot.code = raw.code;
  slot.screen = raw.screen;
  return slot;
}

function normalizeCompositions(raw) {
  const out = emptyCompositions();
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < 3; i += 1) out[i] = normalizeComposition(raw[i]);
  return out;
}

function normalizeRecordOutput(raw) {
  const out = emptyRecordOutput();
  const code = readRecordPair(raw, 'code', 'codeRecord', 'codeOutput');
  const screen = readRecordPair(raw, 'screen', 'screenRecord', 'screenOutput');
  const logo = readRecordPair(raw, 'logo', 'logoRecord', 'logoOutput');
  out.codeRecord = code.record;
  out.codeOutput = code.output;
  out.screenRecord = screen.record;
  out.screenOutput = screen.output;
  out.logoRecord = logo.record;
  out.logoOutput = logo.output;
  return out;
}

function routesFromDocument(data) {
  const legacy = data?.recordOutput;
  const code = readRecordPair(legacy, 'code', 'codeRecord', 'codeOutput');
  const screen = readRecordPair(legacy, 'screen', 'screenRecord', 'screenOutput');
  const deskAudio = data?.desk && typeof data.desk.recAudio === 'boolean' ? data.desk.recAudio : null;
  const recordings = normalizeRoute(data?.recordings, {
    audio: deskAudio,
    screensaver: screen.record,
    codeOverlay: code.record,
  });
  const outputs = normalizeRoute(data?.outputs, {
    audio: null,
    screensaver: screen.output,
    codeOverlay: code.output,
  });
  return { recordings, outputs };
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
      kind: item.kind === 'image' ? 'image' : item.kind === 'audio' ? 'audio' : 'video',
      path: typeof item.path === 'string' ? item.path : '',
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
    compositions: normalizeCompositions(data.compositions),
    desk: normalizeDesk(data.desk),
    view: normalizeView(data.view),
    name: normalizeProjectName(data.name),
    legacy: data,
    ...routesFromDocument(data),
  };
}

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeLogo(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const motion = ['cut', 'fade', 'zoom', 'slide'].includes(row.motion) ? row.motion : 'fade';
  return {
    label: typeof row.label === 'string' ? row.label.slice(0, 16) : '',
    name: typeof row.name === 'string' ? row.name.slice(0, 180) : '',
    cacheKey: typeof row.cacheKey === 'string' ? row.cacheKey.slice(0, 220) : '',
    opacity: clampNum(row.opacity, 1, 0, 1),
    scale: clampNum(row.scale, 1, 0.25, 2.5),
    x: clampNum(row.x, 0, -0.5, 0.5),
    y: clampNum(row.y, 0, -0.5, 0.5),
    mode: clampNum(row.mode, 1, 0, 2) | 0,
    motion,
    motionSec: clampNum(row.motionSec, 0.5, 0.1, 2),
    autoMask: !!row.autoMask,
    path: typeof row.path === 'string' ? row.path.slice(0, 300) : '',
    fx: clampNum(row.fx, 0, 0, 4) | 0,
    fxAmt: clampNum(row.fxAmt, 0.5, 0, 1),
    fxReact: !!row.fxReact,
  };
}

function normalizeFlagMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key || key.length > 80) continue;
    if (Object.keys(out).length >= 80) break;
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function viewNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Layout and show preferences that travel with the project. Null means an older file with none saved. */
export function normalizeView(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const on = (key) => raw[key] !== false;
  const panes = raw.panes && typeof raw.panes === 'object' ? raw.panes : {};
  const bus = raw.bus && typeof raw.bus === 'object' ? raw.bus : {};
  const mute = bus.mute && typeof bus.mute === 'object' ? bus.mute : {};
  const solo = bus.solo && typeof bus.solo === 'object' ? bus.solo : {};
  const maps = ['apc-mini-mk2', 'apc40-mk2', 'custom', 'xdj-700'];
  return {
    timeline: on('timeline'),
    library: on('library'),
    inspector: on('inspector'),
    layerA: on('layerA'),
    layerB: on('layerB'),
    layerC: on('layerC'),
    composition: on('composition'),
    panes: {
      library: viewNumber(panes.library, 160, 560),
      inspector: viewNumber(panes.inspector, 220, 640),
      dock: viewNumber(panes.dock, 200, 900),
    },
    previewSplit: viewNumber(raw.previewSplit, 15, 80),
    timelineH: viewNumber(raw.timelineH, 44, 420),
    timelinePx: viewNumber(raw.timelinePx, 4, 160),
    folds: normalizeFlagMap(raw.folds),
    fxFolds: normalizeFlagMap(raw.fxFolds),
    catMute: Array.isArray(raw.catMute) ? raw.catMute.filter((key) => typeof key === 'string').slice(0, 80) : [],
    workspace: raw.workspace === 'prep' || raw.workspace === 'midi' ? raw.workspace : 'live',
    midiMap: maps.includes(raw.midiMap) ? raw.midiMap : 'apc-mini-mk2',
    midiLabels: !!raw.midiLabels,
    uiScale: viewNumber(raw.uiScale, 75, 125),
    bus: {
      mute: { A: !!mute.A, B: !!mute.B, C: !!mute.C },
      solo: { A: !!solo.A, B: !!solo.B, C: !!solo.C },
    },
    masterSpeed: viewNumber(raw.masterSpeed, 0, 4) ?? 1,
  };
}

/** Left-column show settings: logos, code overlay, screensaver, audio, and the Lock/Sync buttons. */
export function normalizeDesk(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const logos = [0, 1, 2].map((i) => normalizeLogo(Array.isArray(raw.logos) ? raw.logos[i] : null));
  const code = raw.code && typeof raw.code === 'object' ? raw.code : {};
  const screen = raw.screen && typeof raw.screen === 'object' ? raw.screen : {};
  const audio = raw.audio && typeof raw.audio === 'object' ? raw.audio : {};
  const sync = raw.syncMaster && typeof raw.syncMaster === 'object' ? raw.syncMaster : {};
  const box = code.box && typeof code.box === 'object' ? code.box : null;
  return {
    logos,
    code: {
      enabled: !!code.enabled,
      motion: ['cut', 'fade', 'zoom', 'slide'].includes(code.motion) ? code.motion : 'cut',
      sec: clampNum(code.sec, 0.4, 0.1, 2),
      glyph: typeof code.glyph === 'string' ? code.glyph : 'ascii',
      color: typeof code.color === 'string' ? code.color : 'green',
      size: clampNum(code.size, 16, 10, 48),
      mix: clampNum(code.mix, 0.92, 0, 1),
      bg: clampNum(code.bg, 0.62, 0, 1),
      automask: !!code.automask,
      leading: clampNum(code.leading, 1.45, 1, 2),
      mode: typeof code.mode === 'string' ? code.mode : 'scan',
      perform: !!code.perform,
      dpi: code.dpi !== false,
      logoOutput: code.logoOutput !== false,
      box,
    },
    screen: {
      on: typeof screen.on === 'boolean' ? screen.on : true,
      text: typeof screen.text === 'string' ? screen.text.slice(0, 400) : 'Y2K VJ//BY CÍN\nCUSTOM CODED FOR LATE FUTURE',
      credit: screen.credit !== false,
      font: typeof screen.font === 'string' ? screen.font : 'fixedsys',
      shade: clampNum(screen.shade, 0, 0, 8),
      bg: clampNum(screen.bg, 0.65, 0, 1),
      color: typeof screen.color === 'string' ? screen.color : 'white',
      size: clampNum(screen.size, 40, 40, 220),
      boxW: clampNum(screen.boxW, 0, 0, 100),
      boxH: clampNum(screen.boxH, 0, 0, 100),
      pad: clampNum(screen.pad, 12, 0, 64),
      radius: clampNum(screen.radius, 0, 0, 100),
      border: clampNum(screen.border, 2, 0, 12),
    },
    audio: {
      mode: audio.mode === 'file' ? 'file' : 'device',
      volume: clampNum(audio.volume, 0.8, 0, 1),
      muted: !!audio.muted,
      agc: audio.agc !== false,
      loop: audio.loop !== false,
      overrideStop: !!audio.overrideStop,
      attack: clampNum(audio.attack, 0.01, 0.001, 0.08),
      release: clampNum(audio.release, 0.15, 0.02, 0.6),
      file: typeof audio.file === 'string' ? audio.file.slice(0, 180) : '',
      path: typeof audio.path === 'string' ? audio.path.slice(0, 300) : '',
    },
    outputSize: typeof raw.outputSize === 'string' ? raw.outputSize : '',
    recAspect: typeof raw.recAspect === 'string' ? raw.recAspect : '',
    recFormat: typeof raw.recFormat === 'string' ? raw.recFormat : '',
    recAudio: raw.recAudio !== false,
    syncMaster: {
      audio: sync.audio !== false,
      A: sync.A !== false,
      B: sync.B !== false,
      C: sync.C !== false,
    },
  };
}
