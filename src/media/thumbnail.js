// One still for a library card. The probe element is destroyed before this returns,
// so a clip in the library never keeps a decoder or a WebGL texture.

const THUMB_W = 160;
const THUMB_H = 90;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv)$/i;

export function isImageFile(file) {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

export function isVideoFile(file) {
  return file.type.startsWith('video/') || VIDEO_EXT.test(file.name);
}

export async function captureThumbnail(file) {
  if (isImageFile(file)) return captureImage(file);
  if (isVideoFile(file)) return captureVideo(file);
  return null;
}

function fallbackThumb() {
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#141820';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  ctx.strokeStyle = '#8b97b5';
  ctx.lineWidth = 2;
  ctx.strokeRect(46, 22, 68, 46);
  ctx.fillStyle = '#d7e3ff';
  ctx.beginPath();
  ctx.moveTo(74, 34);
  ctx.lineTo(74, 56);
  ctx.lineTo(96, 45);
  ctx.closePath();
  ctx.fill();
  return canvas.toDataURL('image/png');
}

function paintFrame(source, sw, sh) {
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  if (sw > 0 && sh > 0) {
    const scale = Math.max(THUMB_W / sw, THUMB_H / sh);
    const w = sw * scale;
    const h = sh * scale;
    ctx.drawImage(source, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  }
  return canvas.toDataURL('image/jpeg', 0.6);
}

function captureImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  return new Promise((resolve) => {
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    img.onload = () => {
      try { done(paintFrame(img, img.naturalWidth, img.naturalHeight)); }
      catch { done(null); }
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

function waitFor(el, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, ms);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('media error')); };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(event, onOk);
    el.addEventListener('error', onErr);
  });
}

function releaseProbe(video, url) {
  video.pause();
  video.srcObject = null;
  video.src = '';
  video.removeAttribute('src');
  video.load();
  video.remove();
  if (url) URL.revokeObjectURL(url);
}

async function captureVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;opacity:0;pointer-events:none';
  document.body.append(video);
  video.src = url;
  const mp4mov = /\.(mp4|mov)$/i.test(file.name) || file.type === 'video/mp4' || file.type === 'video/quicktime';
  try {
    await waitFor(video, 'loadedmetadata', 8000);
    const dur = video.duration;
    let target = mp4mov ? 0.5 : 1;
    if (!Number.isFinite(dur) || dur <= 0) target = 0;
    else if (dur <= target) target = Math.max(0, dur * 0.5);
    else target = Math.min(target, Math.max(0, dur - 0.04));
    if (target > 0.001) {
      const seeked = waitFor(video, 'seeked', 8000);
      video.currentTime = target;
      await seeked;
    }
    const sw = video.videoWidth | 0;
    const sh = video.videoHeight | 0;
    if (sw < 2 || sh < 2) return fallbackThumb();
    return paintFrame(video, sw, sh);
  } catch {
    return fallbackThumb();
  } finally {
    releaseProbe(video, url);
  }
}
