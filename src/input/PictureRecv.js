// Lists NDI and Spout or Syphon senders and pulls the newest frame of one.
// The layer copies that frame into the texture it already uses for a camera.

import { IS_TAURI, invoke } from '../ipc.js';

export const pictureSources = {
  ndi: [],
  local: [],
  localKind: '',
  ready: false,
};

const HEADER = 17;
let stamp = '';
let notify = () => {};

function desktop() {
  return IS_TAURI;
}

function asBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(0);
}

/** `shouldPoll` decides each second whether the sender list is worth asking for. */
export function bindPictureSources(onChange, shouldPoll = () => true) {
  notify = onChange || (() => {});
  if (!desktop()) return;
  const pull = () => {
    if (!shouldPoll()) return;
    refreshPictureSources().catch(() => {});
  };
  pull();
  setInterval(pull, 1000);
}

export async function refreshPictureSources() {
  if (!desktop()) return pictureSources;
  const list = await invoke('picture_recv_sources');
  const next = JSON.stringify(list);
  const changed = next !== stamp;
  stamp = next;
  pictureSources.ndi = Array.isArray(list?.ndi) ? list.ndi : [];
  pictureSources.local = Array.isArray(list?.spout) ? list.spout : [];
  pictureSources.localKind = list?.local || pictureSources.localKind;
  pictureSources.ready = true;
  if (changed) notify();
  return pictureSources;
}

export async function watchPicture(source) {
  if (!desktop()) {
    console.warn('picture_recv_watch needs the desktop app.');
    return { ok: false, reason: 'Picture receive needs the desktop app.' };
  }
  try {
    const report = await invoke('picture_recv_watch', { source });
    if (!report?.ok) return { ok: false, reason: report?.reason || 'The picture source did not open.' };
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err || 'The picture source did not open.') };
  }
}

export function unwatchPicture(source) {
  if (!desktop() || !source) return;
  invoke('picture_recv_unwatch', { source }).catch(() => {});
}

export async function pullPicture(source, seen) {
  if (!IS_TAURI) {
    return { same: true, gone: false, fault: '', width: 0, height: 0, pixels: null, seen };
  }
  const bytes = asBytes(await invoke('picture_recv_frame', { source, seen }));
  if (bytes.length < HEADER) {
    return { same: true, gone: false, fault: '', width: 0, height: 0, pixels: null, seen };
  }
  const flags = bytes[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const generation = Number(view.getBigUint64(1, true));
  const width = view.getUint32(9, true);
  const height = view.getUint32(13, true);
  if (flags & 4) {
    const reason = new TextDecoder().decode(bytes.subarray(HEADER));
    return {
      same: false,
      gone: false,
      fault: reason || 'The picture source did not open.',
      width,
      height,
      pixels: null,
      seen: generation,
    };
  }
  if (flags & 1) {
    return { same: true, gone: true, fault: '', width, height, pixels: null, seen: generation };
  }
  const pixels = bytes.subarray(HEADER, HEADER + width * height * 4);
  if (flags & 2 || pixels.length !== width * height * 4) {
    return { same: true, gone: false, fault: '', width, height, pixels: null, seen: generation };
  }
  return { same: false, gone: false, fault: '', width, height, pixels, seen: generation };
}
