// One full-band analyser. Band energy, onsets, and envelopes are computed here
// so the AnalyserNode stays lightly smoothed and the musical response stays tight.

import { attachAudioContext } from './outputSink.js';

const FFT_SIZE = 4096;
const HISTORY = 60;
const FLUX_RATIO = 1.5;
const CURVE = 128;

export const MEL_BANDS = [
  { id: 'sub', label: 'Sub', lo: 20, hi: 80, color: '#7af7ff' },
  { id: 'lowMid', label: 'Low-Mid', lo: 80, hi: 500, color: '#ffd23f' },
  { id: 'highMid', label: 'High-Mid', lo: 500, hi: 2000, color: '#ff4ad8' },
  { id: 'air', label: 'Air', lo: 2000, hi: 20000, color: '#7dffb0' },
];

const clamp01 = (v) => Math.min(1, Math.max(0, v || 0));

/** 0..1 magnitude from an analyser dB bin. */
export function magFromDb(db, minDb, maxDb) {
  if (!Number.isFinite(db)) return 0;
  const n = (db - minDb) / (maxDb - minDb || 1);
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** RMS of normalized bin magnitudes between two frequencies. */
export function bandRms(freq, binHz, minDb, maxDb, lo, hi) {
  const a = Math.max(1, Math.floor(lo / binHz));
  const b = Math.min(freq.length - 1, Math.ceil(hi / binHz));
  if (b < a) return 0;
  let sum = 0;
  const count = b - a + 1;
  for (let i = a; i <= b; i++) {
    const m = magFromDb(freq[i], minDb, maxDb);
    sum += m * m;
  }
  return Math.sqrt(sum / count);
}

/** True when this frame's energy jumps above the recent average. Sustained level does not. */
export function fluxSpike(energy, history, count, ratio = FLUX_RATIO) {
  if (count < 12) return false;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += history[i];
  const avg = sum / count;
  return energy > avg * ratio && energy > avg + 0.02;
}

/** Fast when the target rises, slow when it falls. Times are in seconds. */
export function adsrFollow(current, target, dt, attack, release) {
  const tau = Math.max(target > current ? attack : release, 1e-4);
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.buffer = null;
    this.bufferSource = null;
    this.fileGain = null;
    this.inputGain = null;
    this.speaker = null;
    this.recordDest = null;
    this.compressor = null;
    this.agcMakeup = null;
    this.freq = null;
    this.time = null;
    this.curve = new Float32Array(CURVE);
    this.fluxSub = new Float32Array(HISTORY);
    this.fluxLow = new Float32Array(HISTORY);
    this.fluxCount = 0;
    this.fluxIndex = 0;
    this.beatHold = 0;
    this.attack = 0.01;
    this.release = 0.15;
    this.kind = 'none'; // 'none' | 'device' | 'file'
    this.playing = false;
    this.playOffset = 0;
    this.startedAt = 0;
    this.duration = 0;
    this.loop = true;
    this._volume = 0.8;
    this._muted = false;
    this._fadeRaf = 0;
    this._fading = false;
    this._analysisHold = 0;
    this.onLevel = null;
    this.onDeviceLost = null;
    this.analysisGain = null;
    this._agc = true;
    this.gain = 1;
    this.fileName = '';
    this.values = {
      sub: 0, punch: 0, bass: 0, mid: 0, treble: 0, high: 0, level: 0,
      kick: 0, snare: 0, transient: 0, peakFlash: 0, beatPulse: 0,
      songEnergy: 0, isBreakdown: 0, dropPulse: 0,
    };
    this.kickAvg = 0;
    this.snareAvg = 0;
    this.lastKick = 0;
    this.lastSnare = 0;
    this.kickOnset = false;
    this.snareOnset = false;
    this.bands = { sub: 0, lowMid: 0, highMid: 0, air: 0, rms: 0 };
    this.rmsCap = 240;
    this.rmsT = new Float32Array(this.rmsCap);
    this.rmsV = new Float32Array(this.rmsCap);
    this.rmsHead = 0;
    this.rmsCount = 0;
    this.curveSilent = true;
    this.quietHold = 0;
    this.lastDrop = -10;
    this.graph = false;
    this.bpmInput = null;
  }

  /** Holds the tempo filter. The peak tap itself is the playing source, not this bus. */
  connectBpm(node) {
    this.bpmInput = node || null;
  }

  /** The node actually playing: the file buffer, or the live input. */
  get playerNode() {
    if (this.playing && this.bufferSource) return this.bufferSource;
    if (this.kind === 'device' && this.source) return this.source;
    return null;
  }

  /**
   * Auto listens to the player node. Manual disconnects that tap.
   * The AudioContext graph created in #ensureContext is left as it is.
   */
  syncPeak(engine) {
    if (!engine?.attached || !engine.bindPlayer) return;
    engine.bindPlayer(engine.mode === 'auto' ? this.playerNode : null);
  }

  get active() {
    if (this._muted) return false;
    if (this.kind === 'device') return !!this.stream;
    if (this.kind === 'file') return this.playing;
    return false;
  }

  get currentTime() {
    if (!this.playing || !this.ctx) return this.playOffset || 0;
    let t = this.playOffset + (this.ctx.currentTime - this.startedAt);
    if (this.loop && this.duration > 0) t %= this.duration;
    else t = Math.min(t, this.duration || 0);
    return t;
  }

  get transport() {
    return {
      ready: !!this.buffer,
      paused: !this.playing,
      currentTime: this.currentTime,
      duration: this.duration || 0,
    };
  }

  /** Stream to mux into a recording: the live input, or the file's monitor tap. */
  get recordStream() {
    if (this.kind === 'device') return this.stream;
    if (this.kind === 'file') return this.recordDest?.stream || null;
    return null;
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this.#stopFade();
    this._volume = clamp01(v);
    this._analysisHold = this._volume;
    if (this.fileGain) this.fileGain.gain.value = this._volume;
    if (this.analysisGain) this.analysisGain.gain.value = this._volume;
  }

  get muted() {
    return this._muted;
  }

  set muted(on) {
    this._muted = !!on;
    if (this.speaker) this.speaker.gain.value = this._muted ? 0 : 1;
  }

  get agc() {
    return this._agc;
  }

  set agc(on) {
    this._agc = !!on;
    if (this.graph) this.#wireAnalysis();
  }

  async listDevices() {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = devices.filter((d) => d.kind === 'audioinput');
    if (inputs.length && inputs.every((d) => !d.label)) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter((d) => d.kind === 'audioinput');
    }
    return inputs;
  }

  async start(deviceId) {
    if (this.playing) this.playOffset = this.currentTime;
    this.#stopBuffer(true);
    this.#stopMic();
    await this.#ensureContext();

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0,
        channelCount: { ideal: 2 },
      },
    });

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.inputGain);
    this.kind = 'device';

    const stream = this.stream;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.#stopMic();
        this.kind = 'none';
        this.onDeviceLost?.();
      }, { once: true });
    }
  }

  /** Decode a local file with decodeAudioData and play it through the analysis chain. */
  async loadFile(file, { autoplay = true } = {}) {
    await this.#ensureContext();
    const raw = await file.arrayBuffer();
    let audioBuffer;
    try {
      audioBuffer = await this.ctx.decodeAudioData(raw.slice(0));
    } catch {
      throw new Error(`Cannot decode "${file.name}". Use an .mp3, .wav, or .aiff the browser can read.`);
    }

    this.#stopMic();
    this.#stopBuffer(true);
    this.buffer = audioBuffer;
    this.duration = audioBuffer.duration || 0;
    this.playOffset = 0;
    this.fileName = file.name || '';
    this.kind = 'file';
    if (autoplay) this.play(0);
    else this.playing = false;
  }

  /** Start or resume the graph from a click, before a preview or a file load. */
  async wake() {
    await this.#ensureContext();
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  play(offset = this.playOffset) {
    if (!this.buffer || !this.ctx) return;
    if (!(this._analysisHold > 0)) this._analysisHold = this._volume > 0 ? this._volume : 0.5;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.#stopBuffer(false);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.connect(this.fileGain);
    if (this.analysisGain) {
      this.analysisGain.gain.value = this._analysisHold;
      src.connect(this.analysisGain);
    }
    const off = this.duration > 0
      ? Math.min(Math.max(0, offset), Math.max(0, this.duration - 0.001))
      : 0;
    this.bufferSource = src;
    this.startedAt = this.ctx.currentTime;
    this.playOffset = off;
    this.playing = true;
    this.kind = 'file';
    this.#fadeIn();
    src.start(0, off);
    src.onended = () => {
      if (this.bufferSource !== src || this.loop) return;
      this.playing = false;
      this.playOffset = this.duration > 0 ? Math.max(0, this.duration - 0.001) : 0;
      this.bufferSource = null;
    };
  }

  pause() {
    if (!this.playing) return;
    this.playOffset = this.currentTime;
    this.#stopBuffer(false);
    this.playing = false;
  }

  togglePlayback() {
    if (!this.buffer) return;
    if (this.playing) this.pause();
    else this.play(this.playOffset);
  }

  /** Seek to a 0..1 position. */
  seek(fraction) {
    if (!this.buffer || !this.duration) return;
    const t = Math.min(this.duration, Math.max(0, fraction * this.duration));
    this.seekTime(t, this.playing);
  }

  /**
   * Move the file to an exact time in seconds.
   * `shouldPlay` restarts the buffer there; otherwise the track stays paused at that time.
   */
  seekTime(seconds, shouldPlay = this.playing) {
    if (!this.buffer || this.kind === 'device') return;
    const dur = this.duration || 0;
    let t = Math.max(0, Number(seconds) || 0);
    if (dur > 0) {
      if (this.loop) t %= dur;
      else t = Math.min(t, Math.max(0, dur - 0.001));
    }
    if (shouldPlay) this.play(t);
    else {
      this.#stopBuffer(false);
      this.playing = false;
      this.playOffset = t;
    }
  }

  setLoop(on) {
    this.loop = !!on;
    if (this.bufferSource) this.bufferSource.loop = this.loop;
  }

  /** Drop a loaded track. The file stays in the media library. */
  clearFile() {
    this.#stopBuffer(true);
    this.buffer = null;
    this.duration = 0;
    this.playOffset = 0;
    this.fileName = '';
    if (this.kind === 'file') this.kind = 'none';
  }

  /** Drop the live device and leave a loaded file paused in memory. */
  releaseDevice() {
    this.#stopMic();
    if (this.kind === 'device') this.kind = this.buffer ? 'file' : 'none';
  }

  stop() {
    this.pause();
    this.#stopMic();
    this.kind = this.buffer ? 'file' : 'none';
  }

  async #ensureContext() {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.resume();
    await attachAudioContext(this.ctx);
    if (this.graph) return;
    const ctx = this.ctx;

    this.inputGain = ctx.createGain();
    this.fileGain = ctx.createGain();
    this.fileGain.gain.value = this._volume;
    this.analysisGain = ctx.createGain();
    this.analysisGain.gain.value = this._volume;
    this.speaker = ctx.createGain();
    this.speaker.gain.value = this._muted ? 0 : 1;
    this.recordDest = ctx.createMediaStreamDestination();
    this.analysisGain.connect(this.inputGain);
    this.fileGain.connect(this.speaker);
    this.fileGain.connect(this.recordDest);
    this.speaker.connect(ctx.destination);

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -28;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;
    this.agcMakeup = ctx.createGain();
    this.agcMakeup.gain.value = 1.8;

    const node = ctx.createAnalyser();
    node.fftSize = FFT_SIZE;
    node.smoothingTimeConstant = 0.1;
    node.minDecibels = -90;
    node.maxDecibels = -20;
    this.analyser = node;
    this.freq = new Float32Array(node.frequencyBinCount);
    this.time = new Float32Array(node.fftSize);
    this.graph = true;
    this.#wireAnalysis();
  }

  #wireAnalysis() {
    this.#safeDisconnect(this.inputGain);
    this.#safeDisconnect(this.compressor);
    this.#safeDisconnect(this.agcMakeup);
    if (this._agc) {
      this.inputGain.connect(this.compressor);
      this.compressor.connect(this.agcMakeup);
      this.agcMakeup.connect(this.analyser);
    } else {
      this.inputGain.connect(this.analyser);
    }
  }

  #safeDisconnect(node) {
    try { node?.disconnect(); } catch { /* already disconnected */ }
  }

  #stopMic() {
    this.#safeDisconnect(this.source);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.stream = null;
  }

  #stopFade() {
    this._fading = false;
    if (!this._fadeRaf) return;
    cancelAnimationFrame(this._fadeRaf);
    this._fadeRaf = 0;
  }

  /** Speakers rise 0 → 0.5 over 2s. Playback has already started; analysis stays at the pre-fade level. */
  #fadeIn() {
    this.#stopFade();
    this._fading = true;
    const target = 0.5;
    const t0 = performance.now();
    const write = (v) => {
      this._volume = v;
      if (this.fileGain) this.fileGain.gain.value = v;
      this.onLevel?.(v);
    };
    write(0);
    const tick = (now) => {
      if (!this._fading || !this.playing) {
        this._fadeRaf = 0;
        this._fading = false;
        return;
      }
      const u = Math.min(1, (now - t0) / 2000);
      write(target * u);
      if (u < 1) this._fadeRaf = requestAnimationFrame(tick);
      else {
        this._fadeRaf = 0;
        this._fading = false;
      }
    };
    this._fadeRaf = requestAnimationFrame(tick);
  }

  #stopBuffer(clearKind) {
    this.#stopFade();
    const src = this.bufferSource;
    this.bufferSource = null;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch { /* already stopped */ }
      this.#safeDisconnect(src);
    }
    if (clearKind) this.playing = false;
  }

  #pushFlux(subEnergy, lowEnergy) {
    this.fluxSub[this.fluxIndex] = subEnergy;
    this.fluxLow[this.fluxIndex] = lowEnergy;
    this.fluxIndex = (this.fluxIndex + 1) % HISTORY;
    if (this.fluxCount < HISTORY) this.fluxCount += 1;
  }

  /** Log-spaced raw magnitudes for the monitor curve. */
  #fillCurve(minDb, maxDb) {
    const n = this.freq.length;
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const logLo = Math.log(20);
    const logHi = Math.log(20000);
    for (let i = 0; i < CURVE; i++) {
      const f = Math.exp(logLo + (logHi - logLo) * (i / (CURVE - 1)));
      const bin = Math.min(n - 1, Math.max(1, Math.round(f / hz)));
      this.curve[i] = magFromDb(this.freq[bin], minDb, maxDb);
    }
  }

  /**
   * Raw FFT behind four mel-band bars. `bands` is sub, low-mid, high-mid, air.
   */
  drawMonitor(canvas) {
    if (!canvas) return;
    if (this.active && this.analyser && this.freq) {
      this.#fillCurve(this.analyser.minDecibels, this.analyser.maxDecibels);
      this.curveSilent = false;
    }
    const dpr = 1;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, w, h);

    const logLo = Math.log(20);
    const logHi = Math.log(20000);
    const xOf = (hz) => ((Math.log(hz) - logLo) / (logHi - logLo)) * w;
    const v = this.values;
    const levels = [v.sub, v.punch, v.mid, v.treble];
    MEL_BANDS.forEach((band, i) => {
      const x0 = xOf(band.lo);
      const x1 = xOf(Math.min(band.hi, 20000));
      const bh = levels[i] * (h - 8);
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = band.color;
      ctx.fillRect(x0, h - bh, Math.max(1, x1 - x0), bh);
    });
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(215, 227, 255, 0.85)';
    ctx.lineWidth = Math.max(1, dpr);
    for (let i = 0; i < CURVE; i++) {
      const x = (i / (CURVE - 1)) * w;
      const y = h - this.curve[i] * (h - 6) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (v.beatPulse > 0.08) {
      ctx.globalAlpha = v.beatPulse;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, Math.max(2, dpr * 2));
      ctx.globalAlpha = 1;
    }
  }

  #band(lo, hi) {
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    return bandRms(this.freq, binHz, this.analyser.minDecibels, this.analyser.maxDecibels, lo, hi);
  }

  /** Call once per frame. dt and now are in seconds. */
  update(dt, now) {
    const v = this.values;
    const live = this.active && this.analyser;
    const g = this._muted ? 0 : this.gain;
    const raw = this.bands;
    if (live) {
      this.analyser.getFloatFrequencyData(this.freq);
      this.analyser.getFloatTimeDomainData(this.time);
      let sum = 0;
      for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
      raw.sub = this.#band(20, 80);
      raw.lowMid = this.#band(80, 500);
      raw.highMid = this.#band(500, 2000);
      raw.air = this.#band(2000, 20000);
      raw.rms = Math.sqrt(sum / this.time.length);
      this.curveSilent = false;
    } else {
      raw.sub = raw.lowMid = raw.highMid = raw.air = raw.rms = 0;
      if (!this.curveSilent) {
        this.curve.fill(0);
        this.curveSilent = true;
      }
    }

    const subE = raw.sub * g;
    const lowE = raw.lowMid * g;
    const subHit = live && fluxSpike(subE, this.fluxSub, this.fluxCount);
    const lowHit = live && fluxSpike(lowE, this.fluxLow, this.fluxCount);
    if (live) this.#pushFlux(subE, lowE);
    this.kickOnset = false;
    this.snareOnset = false;
    let onset = false;
    if (subHit && now - this.lastKick > 0.09) {
      v.kick = 1;
      this.kickOnset = true;
      this.lastKick = now;
      onset = true;
    }
    if (lowHit && now - this.lastSnare > 0.09) {
      v.snare = 1;
      this.snareOnset = true;
      this.lastSnare = now;
      onset = true;
    }
    if (onset) this.beatHold = Math.max(this.beatHold, this.attack);
    const beatTarget = this.beatHold > 0 ? 1 : 0;
    this.beatHold = Math.max(0, this.beatHold - dt);

    const attack = this.attack;
    const release = this.release;
    v.sub = adsrFollow(v.sub, clamp01(subE), dt, attack, release);
    v.punch = adsrFollow(v.punch, clamp01(lowE), dt, attack, release);
    v.mid = adsrFollow(v.mid, clamp01(raw.highMid * g), dt, attack, release);
    v.treble = adsrFollow(v.treble, clamp01(raw.air * g), dt, attack, release);
    v.high = v.treble;
    v.beatPulse = adsrFollow(v.beatPulse, beatTarget, dt, attack, release);
    v.bass = Math.max(v.sub, v.punch);
    v.level = (v.sub + v.punch + v.mid + v.treble) / 4;

    v.kick *= Math.exp(-dt * 9);
    v.snare *= Math.exp(-dt * 14);
    v.transient = v.snare;
    v.peakFlash = Math.max(v.kick, v.snare);

    const instant = clamp01(raw.rms * g * 5);
    const cap = this.rmsCap;
    this.rmsT[this.rmsHead] = now;
    this.rmsV[this.rmsHead] = instant;
    this.rmsHead = (this.rmsHead + 1) % cap;
    if (this.rmsCount < cap) this.rmsCount += 1;
    const horizon = now - 3;
    while (this.rmsCount > 0) {
      const oldest = (this.rmsHead - this.rmsCount + cap) % cap;
      if (this.rmsT[oldest] >= horizon) break;
      this.rmsCount -= 1;
    }
    let roll = 0;
    for (let i = 0; i < this.rmsCount; i++) {
      roll += this.rmsV[(this.rmsHead - this.rmsCount + i + cap) % cap];
    }
    roll = this.rmsCount ? roll / this.rmsCount : 0;
    const energyTarget = clamp01(roll);
    v.songEnergy += (energyTarget - v.songEnergy) * (1 - Math.exp(-dt * 1.6));

    const ratio = instant / Math.max(roll, 0.04);
    const breakTarget = clamp01((0.85 - ratio) / 0.45);
    v.isBreakdown += (breakTarget - v.isBreakdown) * (1 - Math.exp(-dt * (breakTarget > v.isBreakdown ? 1.4 : 2.8)));

    if (instant < roll * 0.75) this.quietHold += dt;
    else this.quietHold *= Math.exp(-dt * 1.5);
    const span = this.rmsCount
      ? now - this.rmsT[(this.rmsHead - this.rmsCount + cap) % cap]
      : 0;
    const surge = instant > roll * 1.6 + 0.06 && roll > 0.03;
    const armed = v.isBreakdown > 0.35 || this.quietHold > 0.35;
    if (live && span > 0.6 && surge && armed && now - this.lastDrop > 1) {
      v.dropPulse = 1;
      this.lastDrop = now;
      this.quietHold = 0;
    } else {
      v.dropPulse *= Math.exp(-dt * 5);
    }
    v.sub = clamp01(v.sub);
    v.punch = clamp01(v.punch);
    v.mid = clamp01(v.mid);
    v.treble = clamp01(v.treble);
    v.high = clamp01(v.high);
    v.bass = clamp01(v.bass);
    v.level = clamp01(v.level);
    v.kick = clamp01(v.kick);
    v.snare = clamp01(v.snare);
    v.transient = clamp01(v.transient);
    v.peakFlash = clamp01(v.peakFlash);
    v.beatPulse = clamp01(v.beatPulse);
    v.songEnergy = clamp01(v.songEnergy);
    v.isBreakdown = clamp01(v.isBreakdown);
    v.dropPulse = clamp01(v.dropPulse);
    return v;
  }
}
