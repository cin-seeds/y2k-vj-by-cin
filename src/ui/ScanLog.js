// Scrolling terminal fed by the real frame and the audio bus.
// History stays short so the overlay never grows without bound.

const MAX_LINES = 42;
const TYPE_CPS = 320;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class ScanLog {
  constructor() {
    this.lines = [];
    this.cooldown = {};
    this.luma = 0;
    this.turn = 0;
    this.dropEnv = 0;
    this.dropPulse = 0;
    this.energyHigh = false;
    this.idleFor = 0;
    this.onDownbeat = false;
    this.booted = false;
    this.visualT = 0;
    this.buf = new Uint8Array(8 * 8 * 4);
    this.sampleBusy = false;
  }

  push(text, alert = false) {
    this.lines.push({ text, shown: 0, age: 0, alert });
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  /** Average luminance of an 8×8 downsample. The log line text is unchanged. */
  sample(renderer, target) {
    if (this.sampleBusy || !target || target.width !== 8 || target.height !== 8) return this.luma;
    this.sampleBusy = true;
    renderer.readRenderTargetPixelsAsync(target, 0, 0, 8, 8, this.buf).then(() => {
      let sum = 0;
      const n = this.buf.length / 4;
      for (let i = 0; i < this.buf.length; i += 4) {
        sum += this.buf[i] * 0.299 + this.buf[i + 1] * 0.587 + this.buf[i + 2] * 0.114;
      }
      const next = sum / (n * 255);
      if (Number.isFinite(next)) this.luma = next;
    }).catch(() => {}).finally(() => {
      this.sampleBusy = false;
    });
    return this.luma;
  }

  #ready(key, now, gap) {
    if ((this.cooldown[key] || 0) > now) return false;
    this.cooldown[key] = now + gap;
    return true;
  }

  #audio(dt, now, audio, a, beat) {
    const sub = a.sub || 0;
    const bass = a.bass || 0;
    this.dropPulse = a.dropPulse || 0;

    if (audio.kickOnset && this.#ready('kick', now, 0.22)) {
      const hex = Math.floor(clamp(sub * 0.45 + bass * 0.55, 0, 1) * 255)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
      this.push(`> KICK DETECTED: DATAMOSH TRIGGERED [0x${hex}]`, true);
    }

    if (audio.active && this.dropPulse > 0.65 && this.#ready('drop', now, 1.2)) {
      this.energyHigh = true;
      this.idleFor = 0;
      this.push('!!! KINETIC OVERRIDE : MAX ENERGY REACHED !!!', true);
    }

    const downbeat = beat.beatInBar === 0 && beat.pulse > 0.8;
    if (downbeat && !this.onDownbeat && this.#ready('beat', now, 0.3)) {
      this.push(`[CLOCK] uBeat ${beat.pulse.toFixed(2)}  downbeat`);
    }
    this.onDownbeat = downbeat;

    if (!audio.active) return;
    const level = a.level || 0;
    if (level > 0.2) {
      this.energyHigh = true;
      this.idleFor = 0;
    } else if (this.energyHigh) {
      this.idleFor += dt;
      if (this.idleFor > 0.75 && this.#ready('idle', now, 2.4)) {
        this.energyHigh = false;
        this.push('>> SYSTEM IDLE : ENTERING AMBIENT FEEDBACK LOOP <<', true);
      }
    }

  }

  #visual(layers, a) {
    const audible = layers.filter((l) => l.active);
    const layer = audible[this.turn % Math.max(1, audible.length)] || layers[0];
    const slot = this.turn % 4;
    this.turn += 1;
    if (!layer) return;

    if (slot === 0) {
      this.push(`[SCAN] Layer ${layer.id} Luminance Avg: ${this.luma.toFixed(2)}`);
      return;
    }

    if (layer.engine === 'particles') {
      const count = layer.particles.grid.count;
      const sources = ['CURRENT VIDEO', 'LAYER A', 'LAYER B', 'NOISE GRID'];
      const src = sources[layer.get('pSource')] || 'CURRENT VIDEO';
      if (slot === 1) {
        this.push(`[MEM] Particle Buffer Allocated: ${count.toLocaleString('en-US')} pts`);
      } else {
        this.push(`>>> DECONSTRUCTING ${src} <<<  ${count.toLocaleString('en-US')} pts`);
      }
      return;
    }

    if (layer.engine === 'hydra') {
      const bleed = layer.uniforms.uHydraBleed?.value ?? 0;
      const decay = layer.uniforms.uHDecay?.value ?? 0;
      this.push(`[FEED] Layer ${layer.id} decay ${decay.toFixed(2)}  bleed ${bleed.toFixed(2)}`);
      return;
    }

    if (slot === 1 && layer.mode === 'glitch') {
      const u = layer.uniforms;
      const amt = clamp(
        u.uGlitch.value * (0.25 + u.uReactivity.value * (u.uBass.value * 0.9 + u.uKick.value * 0.9)),
        0,
        1.5,
      );
      const delta = 0.002 + 0.025 * amt * (0.4 + u.uMid.value * u.uReactivity.value);
      this.push(`[V-SYNC] RGB Offset active. Delta: ${delta.toFixed(3)}`);
      return;
    }

    if (slot === 3) {
      this.push(
        `[FFT] uSubBass ${(a.sub || 0).toFixed(2)}  uPunch ${(a.punch || 0).toFixed(2)}  uPeakFlash ${(a.peakFlash || 0).toFixed(2)}  uDropPulse ${this.dropPulse.toFixed(2)}`,
      );
      return;
    }

    this.push(`>>> DECONSTRUCTING TEXTURE_2D <<<  layer ${layer.id} ${layer.mode}`);
  }

  tick(dt, { layers, audio, a, beat, now }) {
    if (!this.booted) {
      this.booted = true;
      this.push('>> SCANNER ONLINE : READING FRAME BUFFER <<');
    }

    const last = this.lines.length - 1;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      line.age += dt;
      line.shown = i === last
        ? Math.min(line.text.length, line.shown + TYPE_CPS * dt)
        : line.text.length;
    }

    this.#audio(dt, now, audio, a, beat);
    this.visualT += dt;
    if (this.visualT >= 0.34) {
      this.visualT = 0;
      this.#visual(layers, a);
    }

    const cursor = Math.floor(now * 2.4) % 2 === 0;
    return {
      cursor,
      lines: this.lines.map((line, i) => ({
        text: line.text.slice(0, Math.floor(line.shown)),
        opacity: i === last ? Math.min(1, 0.4 + line.age * 6) : 1,
        alert: line.alert,
      })),
    };
  }
}
