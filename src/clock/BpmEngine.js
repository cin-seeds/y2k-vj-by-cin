// One-shot tempo. Auto: Read Live collects kicks for 4–8 seconds, locks the
// dominant tempo, then returns to manual. A loaded file is also scanned
// offline, so a quiet master, a snare/clap pulse, or a beat that is not in
// the next few seconds can still lock. Tap, double/half, and nudge edit
// that locked number until the next listen.

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
const ANALYZE_MIN_SEC = 4;
const ANALYZE_MAX_SEC = 8;

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
 * Rank inter-onset intervals inside `windowSec` (default 4 s).
 * One-beat gaps, and two-beat gaps split in half, are folded into 70–180.
 * The median is the dominant period. It is snapped to a whole or half BPM.
 * Confidence is the share of gaps that sit on that snapped tempo.
 * `anchor` breaks a tie between two equally common tempos.
 */
export function dominantTempo(peakTimes, now, anchor = 120, windowSec = WINDOW_SEC) {
  const limit = windowSec > 0 ? windowSec : WINDOW_SEC;
  const peaks = peakTimes.filter((t) => t <= now && now - t <= limit);
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

const FILE_HOP = 512;
const FILE_WINDOW_SEC = 20;
const FILE_MIN_GAP_SEC = 0.28;

/**
 * Tempo of a decoded file. Scans a few 20 s slices for kick energy and for
 * broadband hits (snare, clap), then reuses the same interval median as the
 * live listener. Quiet files are normalised by the slice itself.
 * Returns the same shape as `dominantTempo`, or null when no pulse repeats.
 */
export function estimateBufferTempo(buffer, anchor = 120) {
  if (!buffer?.getChannelData || !(buffer.sampleRate > 0) || !(buffer.length > 0)) return null;
  const duration = buffer.duration || buffer.length / buffer.sampleRate;
  if (!(duration >= 2)) return null;
  const channels = [];
  const count = Math.max(1, buffer.numberOfChannels || 1);
  for (let c = 0; c < count; c++) channels.push(buffer.getChannelData(c));
  const win = Math.min(FILE_WINDOW_SEC, duration);
  const starts = [0];
  const slack = duration - win;
  if (slack > 6) {
    starts.push(slack * 0.25, slack * 0.5, slack * 0.75);
  }
  let best = null;
  for (const start of starts) {
    const times = onsetTimes(channels, buffer.sampleRate, start, win);
    if (times.length < 8) continue;
    const read = dominantTempo(times, times[times.length - 1] + 0.001, anchor, win + 1);
    if (!read || read.matches < 6) continue;
    const pulse = pulseConfidence(times, read.bpm);
    if (pulse < 0.55) continue;
    const scored = { ...read, confidence: pulse };
    if (!best || scored.confidence > best.confidence || (scored.confidence === best.confidence && scored.matches > best.matches)) {
      best = scored;
    }
    if (best.confidence >= 0.75) break;
  }
  return best;
}

function onsetTimes(channels, rate, startSec, durSec) {
  const start = Math.max(0, Math.floor(startSec * rate));
  const end = Math.min(channels[0].length, start + Math.floor(durSec * rate));
  const hops = Math.floor((end - start) / FILE_HOP);
  if (hops < 16) return [];
  const env = new Float32Array(hops);
  const alpha = 1 - Math.exp((-2 * Math.PI * 140) / rate);
  let low = 0;
  let prevFull = 0;
  let prevLow = 0;
  const nch = channels.length;
  for (let i = 0; i < hops; i++) {
    let full = 0;
    let bass = 0;
    const base = start + i * FILE_HOP;
    for (let j = 0; j < FILE_HOP; j++) {
      let mono = 0;
      let power = 0;
      for (let c = 0; c < nch; c++) {
        const x = channels[c][base + j] || 0;
        mono += x;
        power += x * x;
      }
      mono /= nch;
      low += alpha * (mono - low);
      full += power;
      bass += low * low;
    }
    full = Math.sqrt(full / (FILE_HOP * nch));
    bass = Math.sqrt(bass / FILE_HOP);
    env[i] = Math.max(0, bass - prevLow) * 1.6 + Math.max(0, full - prevFull);
    prevFull = full;
    prevLow = bass;
  }
  const smooth = new Float32Array(hops);
  for (let i = 0; i < hops; i++) {
    const a = env[Math.max(0, i - 1)];
    const c = env[Math.min(hops - 1, i + 1)];
    smooth[i] = (a + env[i] * 2 + c) * 0.25;
  }
  const ranked = Array.from(smooth).sort((a, b) => a - b);
  const mid = ranked[Math.floor(ranked.length / 2)] || 0;
  let peak = 0;
  for (let i = 0; i < hops; i++) if (smooth[i] > peak) peak = smooth[i];
  const thresh = Math.max(mid * 2.4, peak * 0.2);
  const hopSec = FILE_HOP / rate;
  const minGap = Math.max(1, Math.round(FILE_MIN_GAP_SEC / hopSec));
  const times = [];
  let last = -minGap;
  for (let i = 1; i < hops - 1; i++) {
    if (smooth[i] < thresh || smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1]) continue;
    if (i - last < minGap) {
      if (times.length && smooth[i] > smooth[last]) {
        times[times.length - 1] = peakTime(smooth, i, hopSec);
        last = i;
      }
      continue;
    }
    times.push(peakTime(smooth, i, hopSec));
    last = i;
  }
  return times;
}

/** Share of onset gaps that land on the tempo, or on two beats when one hit was missed. */
function pulseConfidence(times, bpm) {
  const period = 60 / bpm;
  if (!(period > 0) || times.length < 4) return 0;
  const tol = period * 0.08;
  let matches = 0;
  const gaps = times.length - 1;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (Math.abs(gap - period) <= tol || Math.abs(gap - period * 2) <= tol * 2) matches++;
  }
  return matches / gaps;
}

function peakTime(smooth, i, hopSec) {
  const denom = smooth[i - 1] - 2 * smooth[i] + smooth[i + 1];
  let delta = denom === 0 ? 0 : (0.5 * (smooth[i - 1] - smooth[i + 1])) / denom;
  if (delta > 0.5) delta = 0.5;
  else if (delta < -0.5) delta = -0.5;
  return (i + delta) * hopSec;
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
    this.analysisPeaks = [];
    this.previewBpm = null;
    this.analyzing = false;
    this.analyzeStarted = 0;
    this.analysisEvent = null;
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
    if (next === 'manual') this.analyzing = false;
  }

  /**
   * Lock a tempo found in a decoded file and stop the live listen.
   * The next `consumeAnalysis()` reports `locked`, same as a live hit.
   */
  acceptTempo(bpm) {
    const next = snapHalf(bpm);
    if (!Number.isFinite(next)) return false;
    this.bpm = next;
    this.changed = true;
    this.tapCommitted = false;
    this.taps = [];
    this.beats = Math.round(this.beats);
    this.#finishAnalysis('locked');
    return true;
  }

  /** Start a fresh listen. `nowSec` is the frame clock, in seconds. */
  beginAnalysis(nowSec = this.now) {
    this.mode = 'auto';
    this.locked = false;
    this.analyzing = true;
    this.analysisPeaks = [];
    this.previewBpm = null;
    this.analyzeStarted = nowSec;
    this.stableTime = 0;
    this.candidate = null;
    this.analysisEvent = null;
  }

  analyzeLabel() {
    const left = ANALYZE_MAX_SEC - (this.now - this.analyzeStarted);
    const shown = Math.min(ANALYZE_MAX_SEC, Math.max(0, Math.ceil(left)));
    return `Analyzing... ${shown}s`;
  }

  consumeAnalysis() {
    const event = this.analysisEvent;
    this.analysisEvent = null;
    return event;
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
    if (this.mode === 'auto' && this.#listen(nowSec)) {
      this.lastRead = dominantTempo(this.peaks, nowSec, this.bpm);
      if (this.analyzing) this.analysisPeaks.push(nowSec);
      this.#alignPhase();
    }
    if (this.analyzing) {
      const elapsed = nowSec - this.analyzeStarted;
      const read = dominantTempo(this.analysisPeaks, nowSec, this.bpm, Math.max(elapsed, 1e-3));
      this.previewBpm = read ? read.bpm : null;
      const ready = elapsed >= ANALYZE_MIN_SEC && this.analysisPeaks.length >= 10 && read && read.confidence >= 0.8;
      const stop = elapsed >= ANALYZE_MAX_SEC;
      if (ready || (stop && read && read.confidence >= 0.6)) this.#lockRead(read);
      else if (stop) this.#finishAnalysis('timeout');
    }
    const fresh = this.peaks.length > 0 && nowSec - this.peaks[this.peaks.length - 1] < FRESH_SEC;
    const read = fresh ? this.lastRead : null;
    if (read && read.confidence >= MIN_CONFIDENCE) {
      if (read.bpm === this.candidate) this.stableTime += step;
      else {
        this.candidate = read.bpm;
        this.stableTime = step;
      }
      if (this.stableTime >= HOLD_SEC && !this.analyzing) {
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

  #lockRead(read) {
    this.bpm = snapHalf(read.bpm);
    this.changed = true;
    this.tapCommitted = false;
    this.taps = [];
    this.beats = Math.round(this.beats);
    this.previewBpm = null;
    this.#finishAnalysis('locked');
  }

  #finishAnalysis(kind) {
    this.analyzing = false;
    this.previewBpm = null;
    this.mode = 'manual';
    this.locked = true;
    this.stableTime = 0;
    this.candidate = null;
    this.analysisEvent = kind;
  }

  /** Put an on-tempo kick on the beat. The peak detector itself is unchanged. */
  #alignPhase() {
    if (this.peaks.length < 2) return;
    const gap = this.peaks[this.peaks.length - 1] - this.peaks[this.peaks.length - 2];
    const period = 60 / Math.max(1, this.bpm);
    const near = (target) => Math.abs(gap - target) <= Math.max(0.05, target * 0.12);
    if (near(period) || near(period * 2)) this.beats = Math.round(this.beats);
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
    this.lastPeak = nowSec;
    this.peaks.push(nowSec);
    const cutoff = nowSec - WINDOW_SEC;
    while (this.peaks.length && this.peaks[0] < cutoff) this.peaks.shift();
    return true;
  }
}
