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
    if (bw > 0 && bh > 0) {
      const scale = Math.min(canvas.width / bw, canvas.height / bh);
      const dw = Math.round(bw * scale);
      const dh = Math.round(bh * scale);
      const dx = Math.round((canvas.width - dw) / 2);
      const dy = Math.round((canvas.height - dh) / 2);
      ctx.drawImage(bitmap, dx, dy, dw, dh);
    }
    try { bitmap.close(); } catch { /* already released */ }
  };

  window.addEventListener('resize', fit);
  fit();
}
