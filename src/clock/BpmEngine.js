// Hybrid tempo. Auto listens through a 130 Hz lowpass, ranks repeating
// bass intervals, and only then snaps the printed number. Manual tap,
// double/half, and nudge hold that number until the next deliberate edit.

const SEARCH_MIN = 70;
const SEARCH_MAX = 180;
const TEMPO_MIN = 20;
const TEMPO_MAX = 300;
const WINDOW_SEC = 4;
const HOLD_SEC = 3.5;
const MIN_CONFIDENCE = 0.75;
const TAP_GAP_MS = 2500;
const TAP_OUTLIER = 0.2;
const TAP_MIN_MS = 200;
const PEAK_GAP_SEC = 0.24;
const FRESH_SEC = 1.25;

export function clampTempo(bpm) {
  const n = Number(bpm);
  if (!Number.isFinite(n)) return 120;
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(n * 10) / 10));
}

/** Nearest whole or half BPM: 124.12 -> 124.0, 124.26 -> 124.5. */
export function snapHalf(bpm) {
  return Math.round(clampTempo(bpm) * 2) / 2;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (!sorted.length) return 0;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One-octave fold into 70–180. Anything further away is not a beat period. */
function foldOnce(bpm) {
  if (bpm >= SEARCH_MIN && bpm <= SEARCH_MAX) return bpm;
  if (bpm * 2 >= SEARCH_MIN && bpm * 2 <= SEARCH_MAX) return bpm * 2;
  if (bpm / 2 >= SEARCH_MIN && bpm / 2 <= SEARCH_MAX) return bpm / 2;
  return null;
}

/**
 * Rank inter-onset intervals from the last few seconds.
 * One-beat gaps, and two-beat gaps split in half, are folded into 70–180.
 * The median is the dominant period. It is snapped to a whole or half BPM.
 * Confidence is the share of gaps that sit on that snapped tempo.
 * `anchor` breaks a tie between two equally common tempos.
 */
export function dominantTempo(peakTimes, now, anchor = 120) {
  const peaks = peakTimes.filter((t) => t <= now && now - t <= WINDOW_SEC);
  if (peaks.length < 4) return null;
  const samples = [];
  for (let i = 1; i < peaks.length; i++) {
    const bpm = foldOnce(60 / (peaks[i] - peaks[i - 1]));
    if (bpm != null) samples.push(bpm);
  }
  for (let i = 2; i < peaks.length; i++) {
    const bpm = 60 / ((peaks[i] - peaks[i - 2]) / 2);
    if (bpm >= SEARCH_MIN && bpm <= SEARCH_MAX) samples.push(bpm);
  }
  if (samples.length < 4) return null;
  const ranked = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(ranked.length / 2);
  let center = ranked.length % 2 ? ranked[mid] : (ranked[mid - 1] + ranked[mid]) / 2;
  const around = ranked.filter((bpm) => Math.abs(bpm - center) <= 2);
  const other = ranked.filter((bpm) => Math.abs(bpm - center) > 2 && Math.abs(bpm - anchor) <= 2);
  if (other.length === around.length && Math.abs(anchor - center) > 2) center = anchor;
  const snapped = Math.round(center * 2) / 2;
  const span = Math.max(2, snapped * 0.035);
  const matches = samples.filter((bpm) => Math.abs(bpm - snapped) <= span).length;
  return {
    bpm: snapped,
    confidence: matches / samples.length,
    matches,
    possible: samples.length,
  };
}

export class BpmEngine {
  constructor(bpm = 120) {
    this.bpm = clampTempo(bpm);
    this.mode = 'manual';
    this.locked = true;
    this.beats = 0;
    this.phaseOffset = 0;
    this.now = 0;
    this.changed = false;
    this.candidate = null;
    this.stableTime = 0;
    this.lastRead = null;
    this.peaks = [];
    this.intervals = [];
    this.taps = [];
    this.tapCommitted = false;
    this.filter = null;
    this.analyser = null;
    this.playerNode = null;
    this.time = null;
    this.attached = false;
    this.prevEnergy = 0;
    this.lastPeak = -10;
    this.env = [];
  }

  /** 0 on the beat, rising to 1 just before the next one. */
  get pulse() {
    let p = this.beats - Math.floor(this.beats);
    if (p < 0) p += 1;
    return p;
  }

  /**
   * Sidechain tap. The filter is not in the monitor path: the caller connects
   * the analysed source into the returned node.
   */
  attach(ctx) {
    if (this.attached) return this.filter;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 130;
    filter.Q.value = Math.SQRT1_2;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    filter.connect(analyser);
    this.filter = filter;
    this.analyser = analyser;
    this.time = new Float32Array(analyser.fftSize);
    this.attached = true;
    return filter;
  }

  /**
   * Tap the playing source straight into the lowpass. The previous player is
   * disconnected from this filter only, so the analyser chain stays up.
   */
  bindPlayer(node) {
    const next = node || null;
    if (next === this.playerNode) return;
    if (this.playerNode && this.filter) {
      try { this.playerNode.disconnect(this.filter); } catch { /* already gone */ }
    }
    this.playerNode = next;
    if (this.playerNode && this.filter) {
      try { this.playerNode.connect(this.filter); } catch { /* already joined */ }
    }
  }

  setMode(mode) {
    const next = mode === 'auto' ? 'auto' : 'manual';
    if (next === this.mode) return;
    this.mode = next;
    this.stableTime = 0;
    this.candidate = null;
    this.locked = next === 'manual';
  }

  /** Manual edit. Keeps the current beat phase and drops a half-finished tap. */
  setBpm(bpm) {
    this.bpm = clampTempo(bpm);
    this.taps = [];
    this.tapCommitted = false;
    this.locked = true;
    return this.bpm;
  }

  nudge(direction) {
    return this.setBpm(this.bpm + (direction < 0 ? -0.1 : 0.1));
  }

  double() {
    return this.setBpm(this.bpm * 2);
  }

  halve() {
    return this.setBpm(this.bpm / 2);
  }

  /**
   * Tap tempo, or a phase align once the tempo is already committed.
   * A gap longer than 2.5 s starts a fresh measurement. A tap more than 20%
   * away from the median gap is dropped.
   */
  tap(nowMs = performance.now()) {
    const nowSec = nowMs / 1000;
    this.now = nowSec;
    const last = this.taps[this.taps.length - 1];
    if (this.taps.length && nowMs - last > TAP_GAP_MS) {
      this.taps = [];
      this.tapCommitted = false;
    }
    if (this.taps.length) {
      const interval = nowMs - this.taps[this.taps.length - 1];
      if (interval < TAP_MIN_MS) return { accepted: false, bpmChanged: false };
      const gaps = [];
      for (let i = 1; i < this.taps.length; i++) gaps.push(this.taps[i] - this.taps[i - 1]);
      if (gaps.length) {
        const mid = median(gaps);
        if (mid > 0 && Math.abs(interval - mid) / mid > TAP_OUTLIER) {
          return { accepted: false, bpmChanged: false };
        }
      }
    }
    this.taps.push(nowMs);
    if (this.taps.length > 8) this.taps.shift();
    this.phaseOffset = nowSec;
    this.beats = Math.round(this.beats);
    let bpmChanged = false;
    if (!this.tapCommitted && this.taps.length >= 4) {
      const gaps = [];
      for (let i = 1; i < this.taps.length; i++) gaps.push(this.taps[i] - this.taps[i - 1]);
      const next = snapHalf(60000 / median(gaps));
      bpmChanged = Math.abs(next - this.bpm) >= 0.05;
      this.bpm = next;
      this.locked = true;
      this.tapCommitted = true;
    }
    return { accepted: true, bpmChanged };
  }

  consumeChange() {
    const hit = this.changed;
    this.changed = false;
    return hit;
  }

  update(dt, nowSec) {
    const step = Math.min(Math.max(dt || 0, 0), 0.1);
    this.now = nowSec;
    if (this.mode === 'auto' && this.#listen(nowSec)) this.lastRead = dominantTempo(this.peaks, nowSec, this.bpm);
    const fresh = this.peaks.length > 0 && nowSec - this.peaks[this.peaks.length - 1] < FRESH_SEC;
    const read = fresh ? this.lastRead : null;
    if (read && read.confidence >= MIN_CONFIDENCE) {
      if (read.bpm === this.candidate) this.stableTime += step;
      else {
        this.candidate = read.bpm;
        this.stableTime = step;
      }
      if (this.stableTime >= HOLD_SEC) {
        this.locked = true;
        if (this.mode === 'auto' && Math.abs(read.bpm - this.bpm) >= 0.25) {
          this.bpm = read.bpm;
          this.changed = true;
          this.tapCommitted = false;
          this.taps = [];
        }
      }
    } else {
      this.stableTime = Math.max(0, this.stableTime - step);
    }
    this.beats += (step * this.bpm) / 60;
  }

  #listen(nowSec) {
    if (!this.analyser || !this.time) return false;
    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const energy = Math.sqrt(sum / this.time.length);
    this.env.push(energy);
    if (this.env.length > 24) this.env.shift();
    const floor = median(this.env);
    const loud = energy > 0.02 && energy > floor * 1.85 && energy > this.prevEnergy * 1.2;
    this.prevEnergy = energy;
    if (!loud || nowSec - this.lastPeak < PEAK_GAP_SEC) return false;
    if (this.lastPeak > 0) {
      const interval = nowSec - this.lastPeak;
      this.intervals.push({ at: nowSec, dt: interval });
      const cutoff = nowSec - WINDOW_SEC;
      while (this.intervals.length && this.intervals[0].at < cutoff) this.intervals.shift();
    }
    this.lastPeak = nowSec;
    this.peaks.push(nowSec);
    const cutoff = nowSec - WINDOW_SEC;
    while (this.peaks.length && this.peaks[0] < cutoff) this.peaks.shift();
    return true;
  }
}
