// Records a fixed-size composite: the WebGL frame, then the code HUD drawn in 2D.
// The preview canvas can be any shape the panels leave it; the file is not.

import { paintHudText } from '../ui/Hud.js';
import { paintLogos } from '../overlay/StingRack.js';
import { paintScreensaver } from '../overlay/paintScreensaver.js';

const CANDIDATES = [
  { mime: 'video/mp4;codecs=avc1.640033,mp4a.40.2', label: 'MP4 (H.264)', ext: 'mp4' },
  { mime: 'video/mp4', label: 'MP4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', label: 'WebM (VP9)', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', label: 'WebM (VP8)', ext: 'webm' },
  { mime: 'video/webm', label: 'WebM', ext: 'webm' },
];

export class Recorder {
  static supportedFormats() {
    if (typeof MediaRecorder === 'undefined') return [];
    return CANDIDATES.filter((c) => MediaRecorder.isTypeSupported(c.mime));
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.track = null;
    this.stream = null;
  }

  get recording() {
    return this.rec?.state === 'recording';
  }

  get elapsed() {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  start({ format, audioStream = null, width = 1920, height = 1080, videoBitsPerSecond = 20_000_000, onFile = null }) {
    if (this.recording) return;
    this.canvas.width = Math.max(2, width);
    this.canvas.height = Math.max(2, height);
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const stream = this.canvas.captureStream(0);
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    audioStream?.getAudioTracks().forEach((t) => stream.addTrack(t.clone()));

    this.chunks = [];
    this.format = format;
    this.onFile = typeof onFile === 'function' ? onFile : null;
    this.rec = new MediaRecorder(stream, {
      mimeType: format.mime,
      videoBitsPerSecond,
      audioBitsPerSecond: 256_000,
    });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.track = null;
      this.#deliver();
    };
    this.rec.start(1000);
    this.startedAt = performance.now();
    this.track?.requestFrame?.();
  }

  /**
   * Copy the WebGL frame into the record canvas and, when the HUD is up,
   * paint its current lines on top. Call once per displayed frame.
   */
  paint(source, overlay, logos = null, screensaver = null) {
    if (!this.recording || !source) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const sw = source.width || source.videoWidth || 0;
    const sh = source.height || source.videoHeight || 0;
    let box = null;
    if (sw > 0 && sh > 0) {
      const scale = Math.min(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      const dx = (w - dw) / 2;
      const dy = (h - dh) / 2;
      ctx.drawImage(source, dx, dy, dw, dh);
      box = { dx, dy, dw, dh };
    }
    if (box && logos?.length) paintLogos(ctx, box, logos);
    if (overlay?.lines?.length) this.#drawHud(ctx, w, h, overlay);
    if (screensaver) paintScreensaver(ctx, w, h, box, screensaver);
    this.track?.requestFrame?.();
  }

  stop() {
    if (this.recording) this.rec.stop();
  }

  #drawHud(ctx, w, h, overlay) {
    const chrome = overlay.chrome || {};
    const fontSize = Math.max(14, Math.round(Number(chrome.size) || Math.round(h / 48)));
    const leading = Number(chrome.leading) || 1.45;
    paintHudText(ctx, w, h, overlay, {
      fontSize,
      lineH: Math.round(fontSize * leading),
      fontFamily: 'Consolas, "Courier New", monospace',
    });
  }

  #deliver() {
    const blob = new Blob(this.chunks, { type: this.format.mime.split(';')[0] });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `vj-${stamp}.${this.format.ext}`;
    this.chunks = [];
    const deliver = this.onFile;
    this.onFile = null;
    if (deliver) {
      Promise.resolve(deliver(blob, filename)).then((saved) => {
        if (saved === false) this.#download(blob, filename);
      }).catch(() => this.#download(blob, filename));
      return;
    }
    this.#download(blob, filename);
  }

  #download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
