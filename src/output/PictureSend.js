// Copies the finished desk canvas at the NDI / Syphon / SPOUT size and
// hands it to the desktop senders. Off until the Send button is pressed.
// A frame is skipped when the previous send is still running.

import { invoke } from '../ipc.js';

const MIN_GAP_MS = 1000 / 60;

function outputFrameSize() {
  const raw = document.getElementById('output-size')?.value || '';
  const [w, h] = raw.split('x').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return null;
  return { w: Math.round(w), h: Math.round(h) };
}

function statusLine(report) {
  const started = Array.isArray(report?.started) ? report.started.filter(Boolean) : [];
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const problems = errors
    .map((fault) => `${fault?.name || 'Sender'} did not start: ${fault?.reason || 'unknown reason'}`)
    .filter(Boolean);
  if (started.length && problems.length) return `${started.join(', ')}. ${problems.join(' ')}`;
  if (started.length) return started.join(', ');
  return problems.join(' ') || 'No sender started.';
}

export function bindPictureSend({ isTauri }) {
  const button = document.getElementById('output-send');
  const status = document.getElementById('output-send-status');
  const send = {
    on: false,
    live: false,
    ready: false,
    busy: false,
    starting: false,
    last: 0,
    width: 0,
    height: 0,
    canvas: null,
    ctx: null,
    note: '',
  };

  const paint = (text, failed) => {
    if (!status) return;
    const next = text || '';
    send.note = next;
    status.textContent = next;
    status.hidden = !next;
    status.classList.toggle('error', !!failed);
  };

  const paintButton = () => {
    if (!button) return;
    button.classList.toggle('on', send.on);
    button.setAttribute('aria-pressed', send.on ? 'true' : 'false');
  };

  const stop = () => {
    send.on = false;
    send.live = false;
    send.ready = false;
    send.starting = false;
    paintButton();
    paint('');
    if (isTauri()) invoke('picture_send_stop').catch(() => {});
  };

  const ensureSize = async (w, h) => {
    send.starting = true;
    try {
      const report = await invoke('picture_send_start', { width: w, height: h });
      if (!send.on) return;
      send.width = w;
      send.height = h;
      send.ready = true;
      send.live = Array.isArray(report?.started) && report.started.length > 0;
      send.line = statusLine(report);
      paint(send.line, !send.live);
    } catch (err) {
      if (!send.on) return;
      send.ready = true;
      send.live = false;
      paint(String(err?.message || err || 'Send did not start.'), true);
    } finally {
      send.starting = false;
    }
  };

  const copyFrame = (source, w, h) => {
    if (!send.canvas) {
      send.canvas = document.createElement('canvas');
      send.ctx = send.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    if (send.canvas.width !== w) send.canvas.width = w;
    if (send.canvas.height !== h) send.canvas.height = h;
    send.ctx.drawImage(source, 0, 0, w, h);
    return send.ctx;
  };

  const tick = (nowMs, source) => {
    if (!send.on || !source) return;
    if (send.busy || send.starting) return;
    if (nowMs - send.last < MIN_GAP_MS) return;
    const size = outputFrameSize();
    if (!size) return;
    if (!isTauri()) return;
    if (!send.ready || send.width !== size.w || send.height !== size.h) {
      send.last = nowMs;
      ensureSize(size.w, size.h);
      return;
    }
    if (!send.live) return;
    send.last = nowMs;
    send.busy = true;
    const ctx = copyFrame(source, size.w, size.h);
    const w = size.w;
    const h = size.h;
    setTimeout(() => {
      if (!send.on) {
        send.busy = false;
        return;
      }
      let bytes;
      try {
        const image = ctx.getImageData(0, 0, w, h);
        bytes = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      } catch (err) {
        send.busy = false;
        paint(String(err?.message || err || 'The frame could not be copied.'), true);
        return;
      }
      invoke('picture_send_frame', bytes, {
        headers: { 'x-width': String(w), 'x-height': String(h) },
      }).then(() => {
        if (send.on && send.line) paint(send.line, false);
      }).catch((err) => {
        paint(String(err?.message || err || 'The frame was not sent.'), true);
      }).finally(() => {
        send.busy = false;
      });
    }, 0);
  };

  button?.addEventListener('click', () => {
    if (send.on) {
      stop();
      return;
    }
    send.on = true;
    send.ready = false;
    send.live = false;
    send.last = 0;
    paintButton();
    if (!isTauri()) {
      console.warn('picture_send_start needs the desktop app.');
      send.ready = true;
      paint('Send needs the desktop app.', true);
      return;
    }
    const size = outputFrameSize();
    if (!size) {
      paint('Choose a send size first.', true);
      return;
    }
    ensureSize(size.w, size.h);
  });

  return { tick, stop };
}
