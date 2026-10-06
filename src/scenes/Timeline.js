// Beat-clocked cue sequencer. Cues sit on whole beats and point at a scene; when the
// playhead crosses a cue, onTrigger(cue) fires (main crossfades to that scene).

import { normalizeMarker } from '../project/ProjectState.js';

const STORAGE_KEY = 'vj.timeline';
const BARS_MAX = 2048;
const uid = () => Math.random().toString(36).slice(2, 10);

export class Timeline {
  #batching = false;

  constructor(project = null) {
    this.project = project;
    this.bpm = 120;
    this.bars = 16;
    this.loop = true;
    this.fadeBeats = 4;
    this.fadeSec = 1;
    this.fadeStyle = 0; // 0 alpha, 1 additive, 2 wipe
    this.cues = [];
    this.playing = false;
    this.beat = 0;
    this.onTrigger = () => {};
    this.onEdit = null;
    this.historyCommit = null;
    this.listeners = new Set();
    if (project) this.#fromProject(project);
    else this.#load();
  }

  get lengthBeats() {
    return this.bars * 4;
  }

  get fadeSeconds() {
    return this.fadeSec;
  }

  toJSON() {
    return {
      bpm: this.bpm, bars: this.bars, loop: this.loop,
      fadeBeats: this.fadeBeats, fadeSec: this.fadeSec, fadeStyle: this.fadeStyle,
      cues: this.cues,
    };
  }

  load(data = {}) {
    this.bpm = clamp(Number(data.bpm) || 120, 20, 300);
    this.bars = clamp(Math.round(Number(data.bars) || 16), 1, BARS_MAX);
    this.loop = data.loop ?? true;
    this.fadeBeats = clamp(Number(data.fadeBeats ?? 4), 0, 32);
    this.fadeSec = clamp(Number(data.fadeSec ?? (this.fadeBeats * 60) / this.bpm), 0, 10);
    this.fadeStyle = clamp(Math.round(Number(data.fadeStyle) || 0), 0, 2);
    this.cues = Array.isArray(data.cues)
      ? data.cues.map((c) => this.#fitCue(c)).filter(Boolean)
      : [];
    this.beat = Math.min(this.beat, this.lengthBeats);
    this.#changed();
  }

  /** Several cue edits become one undo step. */
  batch(fn) {
    if (this.#batching) return fn();
    const before = this.#snap();
    this.#batching = true;
    try {
      return fn();
    } finally {
      this.#batching = false;
      this.#note(before, 'batch', 'commit');
    }
  }

  set(field, value, opts = {}) {
    const before = this.#snap();
    if (field === 'bpm') this.bpm = clamp(Number(value) || this.bpm, 20, 300);
    else if (field === 'bars') {
      this.bars = clamp(Math.round(Number(value)) || this.bars, 1, BARS_MAX);
      this.cues = this.cues.filter((c) => c.beat < this.lengthBeats);
      this.beat = Math.min(this.beat, this.lengthBeats);
    } else if (field === 'loop') this.loop = !!value;
    else if (field === 'fadeBeats') this.fadeBeats = clamp(Number(value), 0, 32);
    else if (field === 'fadeSec') this.fadeSec = clamp(Number(value), 0, 10);
    else if (field === 'fadeStyle') this.fadeStyle = clamp(Math.round(Number(value) || 0), 0, 2);
    this.#changed();
    this.#note(before, field, opts.history);
  }

  addCue(beat, sceneId, opts = {}) {
    const before = this.#snap();
    const b = clamp(Math.round(beat), 0, this.lengthBeats - 1);
    // One cue per beat: dropping onto an occupied beat replaces it.
    this.cues = this.cues.filter((c) => c.beat !== b);
    const cue = {
      id: uid(),
      sceneId,
      beat: b,
      bar: Math.floor(b / 4),
    };
    this.cues.push(cue);
    this.#changed();
    this.#note(before, 'cues', opts.history);
    return cue;
  }

  /** A library clip on a layer track, starting at a beat. */
  addClip(beat, { mediaId, mediaName, layerId } = {}, opts = {}) {
    const name = String(mediaName || mediaId || '').trim();
    if (!name) return null;
    const before = this.#snap();
    const b = clamp(Math.round(beat), 0, this.lengthBeats - 1);
    this.cues = this.cues.filter((c) => c.beat !== b);
    const cue = {
      id: uid(),
      kind: 'clip',
      mediaId: String(mediaId || name),
      mediaName: name,
      layerId: layerId === 'B' || layerId === 'C' ? layerId : 'A',
      beat: b,
      bar: Math.floor(b / 4),
    };
    this.cues.push(cue);
    this.#changed();
    this.#note(before, 'cues', opts.history);
    return cue;
  }

  #fitCue(cue) {
    const norm = normalizeMarker(cue);
    if (!norm) return null;
    const beat = clamp(norm.beat, 0, this.lengthBeats - 1);
    return { ...norm, beat, bar: Math.floor(beat / 4) };
  }

  moveCue(id, beat, opts = {}) {
    const cue = this.cues.find((c) => c.id === id);
    if (!cue) return;
    const before = this.#snap();
    const b = clamp(Math.round(beat), 0, this.lengthBeats - 1);
    if (b === cue.beat) return;
    this.cues = this.cues.filter((c) => c.id === id || c.beat !== b);
    cue.beat = b;
    cue.bar = Math.floor(b / 4);
    this.#changed();
    this.#note(before, `cue:${id}`, opts.history);
  }

  removeCue(id, opts = {}) {
    const before = this.#snap();
    this.cues = this.cues.filter((c) => c.id !== id);
    this.#changed();
    this.#note(before, 'cues', opts.history);
  }

  removeScene(sceneId, opts = {}) {
    const before = this.#snap();
    const count = this.cues.length;
    this.cues = this.cues.filter((c) => c.sceneId !== sceneId);
    if (this.cues.length !== count) this.#changed();
    this.#note(before, 'cues', opts.history);
  }

  play() {
    if (this.playing) return;
    if (this.beat >= this.lengthBeats) this.beat = 0;
    this.playing = true;
    // Starting mid-timeline: bring up whichever cue is in effect at the playhead.
    const current = this.#cueAtOrBefore(this.beat);
    if (current) this.onTrigger(current, { immediate: true });
    this.#emit();
  }

  pause() {
    this.playing = false;
    this.#emit();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  stop() {
    this.playing = false;
    this.beat = 0;
    this.#emit();
  }

  seek(beat) {
    this.beat = clamp(beat, 0, this.lengthBeats);
    this.#emit();
  }

  update(dt) {
    if (!this.playing) return;
    const len = this.lengthBeats;
    const prev = this.beat;
    let next = prev + (dt * this.bpm) / 60;

    if (next >= len) {
      this.#fire(prev, len, false);
      if (this.loop) {
        next -= len;
        this.#fire(0, next, true);
      } else {
        next = len;
        this.playing = false;
        this.#emit();
      }
    } else {
      this.#fire(prev, next, false);
    }
    this.beat = next;
  }

  /** Fires cues in (from, to], or [from, to] when includeStart (after a loop wrap). */
  #fire(from, to, includeStart) {
    for (const cue of [...this.cues].sort((a, b) => a.beat - b.beat)) {
      if ((cue.beat > from || (includeStart && cue.beat === from)) && cue.beat <= to) this.onTrigger(cue, {});
    }
  }

  #cueAtOrBefore(beat) {
    let best = null;
    for (const c of this.cues) if (c.beat <= beat && (!best || c.beat > best.beat)) best = c;
    return best;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  #snap() {
    return structuredClone(this.toJSON());
  }

  #note(before, field, history = 'commit') {
    if (history === false || this.#batching || typeof this.onEdit !== 'function') return;
    const after = this.#snap();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.onEdit(before, after, field, history === true ? 'commit' : history);
  }

  #changed() {
    if (this.project) {
      this.project.adoptTimeline(this.cues, {
        bpm: this.bpm,
        bars: this.bars,
        loop: this.loop,
        fadeBeats: this.fadeBeats,
        fadeSec: this.fadeSec,
        fadeStyle: this.fadeStyle,
      });
    } else {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      } catch {
        /* storage full or unavailable: the session still works */
      }
    }
    this.#emit();
  }

  #emit() {
    for (const fn of this.listeners) fn();
  }

  #fromProject(project) {
    this.load(project.transport ? { ...project.transport, cues: project.timeline } : { cues: project.timeline });
  }

  #load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw) {
        this.bpm = clamp(Number(raw.bpm) || 120, 20, 300);
        this.bars = clamp(Math.round(Number(raw.bars) || 16), 1, BARS_MAX);
        this.loop = raw.loop ?? true;
        this.fadeBeats = clamp(Number(raw.fadeBeats ?? 4), 0, 32);
        this.fadeSec = clamp(Number(raw.fadeSec ?? (this.fadeBeats * 60) / this.bpm), 0, 10);
        this.fadeStyle = clamp(Math.round(Number(raw.fadeStyle) || 0), 0, 2);
        this.cues = Array.isArray(raw.cues) ? raw.cues : [];
      }
    } catch {
      /* ignore a corrupt save */
    }
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
