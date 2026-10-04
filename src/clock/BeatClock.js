// Global tempo clock. Counts quarter-note beats; phase ramps 0..1 across each beat and
// pulse is 1.0 on the beat, easing to 0 just before the next one.

export class BeatClock {
  constructor(bpm = 120) {
    this.bpm = bpm;
    this.beats = 0;
    this.taps = [];
  }

  get phase() {
    return this.beats - Math.floor(this.beats);
  }

  get pulse() {
    return (1 - this.phase) ** 3;
  }

  /** 0..3 position inside a 4/4 bar. */
  get beatInBar() {
    return Math.floor(this.beats) % 4;
  }

  setBpm(bpm) {
    if (Number.isFinite(bpm)) this.bpm = Math.min(300, Math.max(20, bpm));
  }

  /** Free-running advance. Integrating dt keeps the phase continuous across tempo changes. */
  update(dt) {
    this.beats += (dt * this.bpm) / 60;
  }

  /** Follow an external beat position (the timeline while it plays). */
  sync(beats) {
    this.beats = beats;
  }

  /** Snap the pulse to this instant (tap or a detected kick). */
  snap() {
    this.beats = Math.round(this.beats);
  }

  /**
   * Tap tempo: averages the last few intervals (a 2 s gap starts over) and puts the
   * beat on the tap. Returns the new BPM once there are two taps, else null.
   */
  tap(nowMs = performance.now()) {
    if (this.taps.length && nowMs - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(nowMs);
    this.taps = this.taps.slice(-8);
    this.beats = Math.round(this.beats);
    if (this.taps.length < 2) return null;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    return Math.round((60000 * (this.taps.length - 1)) / span);
  }
}
