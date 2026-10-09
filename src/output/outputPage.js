// The output page does not start a renderer. A browser popup is painted by
// the desk. The desktop projector has no shared document, so it blits frames
// the desk posts on this channel.

import { IS_TAURI as native } from '../ipc.js';

function sameOutput(url) {
  try {
    const next = new URL(url, window.location.href);
    const here = new URL(window.location.href);
    return here.origin === next.origin && here.pathname === next.pathname;
  } catch {
    return false;
  }
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    const note = new BroadcastChannel('vj-output-mirror');
    note.postMessage({ type: 'vj-output-close' });
  } catch { /* the window still closes */ }
  if (native) {
    import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      getCurrentWebviewWindow().close().catch(() => {});
    });
  } else {
    window.close();
  }
}, true);

if (!native) {
  // The desk draws straight into #mirror.
} else {
  document.getElementById('start-output')?.remove();
  const canvas = document.getElementById('mirror');
  const ctx = canvas?.getContext('2d', { alpha: false });
  const channel = new BroadcastChannel('vj-output-mirror');

  function fit() {
    if (!canvas) return;
    // CSS pixels only. Do not multiply by devicePixelRatio a second time.
    const w = Math.max(2, Math.round(window.innerWidth));
    const h = Math.max(2, Math.round(window.innerHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  channel.onmessage = (event) => {
    const data = event.data;
    if (data && data.type === 'vj-output-url' && typeof data.url === 'string') {
      if (!sameOutput(data.url)) window.location.replace(data.url);
      return;
    }
    const bitmap = data;
    if (!ctx || !bitmap || typeof bitmap.close !== 'function') return;
    fit();
    const bw = bitmap.width || 0;
    const bh = bitmap.height || 0;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Desk already applied Fill / Fit / Original into this bitmap at window size.
    if (bw > 0 && bh > 0) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    try { bitmap.close(); } catch { /* already released */ }
  };

  window.addEventListener('resize', fit);
  fit();
}
