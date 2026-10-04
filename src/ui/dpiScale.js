// Overlay type scale. 1.0 matches a 1080p frame. The preview card uses a
// smaller factor so the same overlay occupies the same fraction of the picture.

export const REF_HEIGHT = 1080;

function readAuto() {
  try { return localStorage.getItem('vj.hudDpi') !== '0'; } catch { return true; }
}

export const dpiState = {
  dpiScaleFactor: 1,
  previewScale: 0.33,
  outputWidth: 1920,
  outputHeight: REF_HEIGHT,
  auto: readAuto(),
};

globalThis.dpiScaleFactor = dpiState.dpiScaleFactor;

export function ratio1080(width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  return Math.min(w, h) / REF_HEIGHT;
}

/** Physical pixels for a screen from the output menu, or this display. */
export function pixelsOf(screen) {
  if (screen?.physicalWidth && screen?.physicalHeight) {
    return {
      w: Math.round(screen.physicalWidth),
      h: Math.round(screen.physicalHeight),
    };
  }
  if (screen?.width && screen?.height) {
    const dpr = screen.devicePixelRatio || window.devicePixelRatio || 1;
    return {
      w: Math.round(screen.width * dpr),
      h: Math.round(screen.height * dpr),
    };
  }
  const dpr = window.devicePixelRatio || 1;
  return {
    w: Math.round((window.screen?.width || 1920) * dpr),
    h: Math.round((window.screen?.height || REF_HEIGHT) * dpr),
  };
}

export function formatFactor(n) {
  const v = Number.isFinite(n) ? n : 1;
  return v.toFixed(1);
}

export function setOutputPixels(width, height) {
  dpiState.outputWidth = Math.max(1, Math.round(width));
  dpiState.outputHeight = Math.max(1, Math.round(height));
  dpiState.dpiScaleFactor = ratio1080(dpiState.outputWidth, dpiState.outputHeight);
  globalThis.dpiScaleFactor = dpiState.dpiScaleFactor;
}

export function setPreviewScale(domWidth, frameWidth) {
  const frame = Math.max(1, Number(frameWidth) || 1920);
  const dom = Number(domWidth) || 0;
  dpiState.previewScale = dom > 8 ? dom / frame : 0.33;
}

export function setDpiAuto(on) {
  dpiState.auto = !!on;
  try { localStorage.setItem('vj.hudDpi', dpiState.auto ? '1' : '0'); } catch { /* ignore */ }
}
