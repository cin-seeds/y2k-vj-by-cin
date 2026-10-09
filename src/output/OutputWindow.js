// The output window is a 2D canvas. The main frame copies the WebGL picture
// into it, so the popup never runs its own renderer.
// In the desktop app the projector is a separate native window, so the same
// picture is handed across as an ImageBitmap. The output page only blits it.

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { HUD_COLORS, HUD_FONT, paintHudText } from '../ui/Hud.js';
import { paintLogos } from '../overlay/StingRack.js';
import { paintScreensaver } from '../overlay/paintScreensaver.js';
import { dpiState } from '../ui/dpiScale.js';
import { IS_TAURI } from '../ipc.js';
import { applyMediaSink } from '../audio/outputSink.js';
import { fittedBox } from './frameFit.js';

const OVERLAY_KEY = 'vj.hudOutput';
const MASTER_OUTPUT = 'master-output';
const PROJECTION_SCREEN = 'projection-screen';
const MIRROR_CHANNEL = 'vj-output-mirror';
const OUTPUT_URL_TYPE = 'vj-output-url';
const OUTPUT_CLOSE_TYPE = 'vj-output-close';
// Same string as windows[0].additionalBrowserArgs in src-tauri/tauri.conf.json.
const DESK_BROWSER_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows';

export const POPUP_BLOCKED = 'Please allow pop-ups in your browser address bar to send output to Screen 2.';

export function isTauri() {
  return IS_TAURI;
}

function outputErrorText(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string' && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object') {
    if (typeof err.message === 'string' && err.message) return err.message;
    try {
      const text = JSON.stringify(err);
      if (text && text !== '{}') return text;
    } catch { /* fall through */ }
  }
  const text = String(err);
  return text && text !== '[object Object]' ? text : 'Unknown error';
}

function isMac() {
  return /Mac/i.test(navigator.userAgent || '') || /Mac/i.test(navigator.platform || '');
}

function screenTitle(screen, index, monitor) {
  const n = index + 1;
  const size = `${Math.round(screen.width)}x${Math.round(screen.height)}`;
  let title;
  if (screen.isInternal) title = `Screen ${n} (Internal)`;
  else {
    const label = (screen.label || '').trim();
    title = /hdmi/i.test(label) || !label
      ? `Screen ${n} (HDMI - ${size})`
      : `Screen ${n} (${label} - ${size})`;
  }
  if (!monitor?.position) return title;
  const x = Math.round(Number(monitor.position.x) || 0);
  const y = Math.round(Number(monitor.position.y) || 0);
  return `${title} @ ${x},${y}`;
}

function monitorLabel(name) {
  return String(name || '').replace(/^\\\\\.\\/, '').trim();
}

/** Detected displays. Falls back to the current screen when the Window Management API is unavailable. */
export async function listScreens() {
  if (isTauri()) {
    try {
      const { availableMonitors } = await import('@tauri-apps/api/window');
      const monitors = await availableMonitors();
      if (monitors?.length) {
        return monitors.map((monitor, i) => {
          const logical = monitor.size.toLogical(monitor.scaleFactor || 1);
          const screen = {
            width: logical.width,
            height: logical.height,
            physicalWidth: monitor.size.width,
            physicalHeight: monitor.size.height,
            label: monitorLabel(monitor.name),
            isInternal: /internal|built-?in|laptop/i.test(monitor.name || ''),
          };
          return {
            screen,
            monitor,
            detailed: true,
            title: screenTitle(screen, i, monitor),
          };
        });
      }
    } catch { /* permission denied or not inside the desktop shell */ }
  }
  if (typeof window.getScreenDetails === 'function') {
    try {
      const details = await window.getScreenDetails();
      const screens = details?.screens || [];
      if (screens.length) {
        return screens.map((screen, i) => ({
          screen,
          detailed: true,
          title: screenTitle(screen, i),
        }));
      }
    } catch { /* permission denied or unsupported */ }
  }
  const s = window.screen;
  return [{
    screen: null,
    detailed: false,
    title: `Screen 1 (This display - ${s?.width || 0}x${s?.height || 0})`,
  }];
}

function placement(screen) {
  const chrome = 'popup=yes,menubar=no,toolbar=no,location=no,status=no,scrollbars=no';
  if (!screen) return `${chrome},width=1280,height=720`;
  const left = Math.round(screen.availLeft ?? screen.left ?? 0);
  const top = Math.round(screen.availTop ?? screen.top ?? 0);
  const width = Math.max(320, Math.round(screen.availWidth ?? screen.width ?? 1280));
  const height = Math.max(240, Math.round(screen.availHeight ?? screen.height ?? 720));
  return `${chrome},left=${left},top=${top},width=${width},height=${height}`;
}

function outputPageUrl() {
  try {
    const origin = window.location?.origin;
    if (origin && origin !== 'null') return `${origin}/output.html`;
  } catch { /* opaque origin */ }
  return '/output.html';
}

export class OutputWindow {
  constructor(canvas) {
    this.canvas = canvas;
    this.win = null;
    this.outCanvas = null;
    this.outCtx = null;
    this.overlayOn = localStorage.getItem(OVERLAY_KEY) === '1';
    this.lastHud = { visible: false, view: 'params', html: '', htmlSerial: 0, values: null, scroll: 0 };
    this.native = false;
    this.nativeOpen = false;
    this.nativeWin = null;
    this.nativeSize = { w: 1280, h: 720 };
    this.localCanvas = null;
    this.localCtx = null;
    this.frameBusy = false;
    this.fitMode = 'fill';
    this.channel = null;
    this.unlistenResize = null;
    this.lastBlockMessage = '';
    this.#channel().addEventListener('message', (event) => {
      if (event.data?.type !== OUTPUT_CLOSE_TYPE) return;
      this.close();
    });
  }

  /** Close the projector. The desk stays open and the output button turns off. */
  async close() {
    if (this.native) await this.#closeNative();
    else if (this.win && !this.win.closed) {
      try { this.win.close(); } catch { /* already gone */ }
      this.win = null;
      this.outCanvas = null;
      this.outCtx = null;
    }
    window.dispatchEvent(new CustomEvent('vj-output-closed'));
  }

  #closingNative = false;
  #launchChain = Promise.resolve();
  #projectionLabel = '';
  #listenedLabel = '';
  #listenedWin = null;

  get open() {
    if (this.native) return this.nativeOpen;
    return !!(this.win && !this.win.closed);
  }

  setOverlayOn(on) {
    this.overlayOn = !!on;
    try { localStorage.setItem(OVERLAY_KEY, this.overlayOn ? '1' : '0'); } catch { /* ignore */ }
  }

  syncHud(snapshot) {
    if (snapshot) this.lastHud = snapshot;
  }

  /**
   * Open the output on a detected screen.
   * The desktop app creates a borderless native window on that monitor.
   * A normal browser opens a popup; fullscreen there still waits for a click
   * inside that window, which is the gesture browsers require to hide the URL bar.
   * @returns {Promise<boolean>} false when the window could not be opened
   */
  launch(target = {}) {
    this.lastBlockMessage = '';
    if (!isTauri()) return Promise.resolve(this.#launchBrowser(target));
    const job = this.#launchChain.then(() => this.#launchNative(target));
    this.#launchChain = job.then(() => {}, () => {});
    return job;
  }

  focus() {
    if (this.native && this.nativeWin) {
      this.nativeWin.setFocus().catch(() => {});
      return;
    }
    if (this.open) this.win.focus();
  }

  /** Copy the main WebGL frame into the output using the desk Fill / Fit / Original choice. */
  mirror(overlay = null, logos = null, source = null, screensaver = null, audioStream = null, fitMode = 'fill') {
    this.fitMode = fitMode === 'fit' || fitMode === 'original' ? fitMode : 'fill';
    if (!this.open) {
      this.outCanvas = null;
      this.outCtx = null;
      return;
    }
    const picture = source || this.canvas;
    if (this.native) {
      if (this.frameBusy) return;
      const w = this.nativeSize.w;
      const h = this.nativeSize.h;
      const dest = this.#localCanvas(w, h);
      const ctx = this.localCtx;
      if (!dest || !ctx) return;
      this.#paint(ctx, w, h, overlay, logos, picture, screensaver);
      this.#queueNativeFrame(dest);
      this.#syncProgramAudio(audioStream);
      return;
    }
    if (!this.outCtx) this.#attach();
    const ctx = this.outCtx;
    const dest = this.outCanvas;
    if (!ctx || !dest) return;
    const win = this.win;
    const w = Math.max(2, Math.floor(win.innerWidth || dest.clientWidth || 2));
    const h = Math.max(2, Math.floor(win.innerHeight || dest.clientHeight || 2));
    if (dest.width !== w || dest.height !== h) {
      dest.width = w;
      dest.height = h;
    }
    this.#paint(ctx, w, h, overlay, logos, picture, screensaver);
    this.#syncHudStyle(dest, overlay?.chrome);
  }

  #syncProgramAudio(stream) {
    if (this.native || !this.win || this.win.closed) return;
    let doc;
    try { doc = this.win.document; } catch { return; }
    if (!doc?.body) return;
    const next = stream || null;
    let el = doc.getElementById('program-audio');
    if (!next) {
      if (el) {
        el.srcObject = null;
        el.remove();
      }
      return;
    }
    if (!el) {
      el = doc.createElement('audio');
      el.id = 'program-audio';
      el.autoplay = true;
      doc.body.append(el);
    }
    if (el.srcObject !== next) el.srcObject = next;
    applyMediaSink(el);
    el.play?.().catch(() => {});
  }

  #launchBrowser(target) {
    this.native = false;
    if (this.open) {
      try { this.win.close(); } catch { /* already gone */ }
      this.win = null;
    }
    this.outCanvas = null;
    this.outCtx = null;
    const screen = target.screen || null;
    this.win = window.open(outputPageUrl(), 'VJOutputWindow', placement(screen));
    if (!this.win) {
      this.lastBlockMessage = POPUP_BLOCKED;
      return false;
    }
    const attach = () => this.#attach();
    try { this.win.addEventListener('load', attach, { once: true }); } catch { /* still opening */ }
    attach();
    return true;
  }

  async #launchNative(target) {
    this.native = true;
    this.win = null;
    this.outCanvas = null;
    this.outCtx = null;
    let monitor = null;
    try {
      monitor = await this.#monitorFor(target);
      if (!monitor) {
        this.lastBlockMessage = 'Could not open the output window. No display was found.';
        this.nativeOpen = false;
        return false;
      }
      return await this.#openProjection(monitor);
    } catch (err) {
      if (this.nativeOpen) return true;
      try {
        const again = monitor ? await this.#findOutputWindow() : null;
        if (again && monitor) return await this.#placeProjection(again, monitor);
      } catch { /* the existing webview could not take focus */ }
      if (this.nativeOpen) return true;
      this.nativeOpen = false;
      this.lastBlockMessage = `Could not open the output window: ${outputErrorText(err)}`;
      return false;
    }
  }

  async #findOutputWindow() {
    const labels = [MASTER_OUTPUT, PROJECTION_SCREEN, this.#projectionLabel, 'projection-output', 'projection-window'];
    const seen = new Set();
    for (const label of labels) {
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const win = await WebviewWindow.getByLabel(label);
      if (win) return win;
    }
    return null;
  }

  async #openProjection(monitor) {
    const existing = await WebviewWindow.getByLabel(MASTER_OUTPUT);
    if (existing) {
      this.#closingNative = true;
      try { await existing.close(); } catch { /* already gone */ }
      this.#closingNative = false;
      if (this.nativeWin === existing) {
        this.nativeWin = null;
        this.nativeOpen = false;
      }
      if (this.#listenedWin === existing) {
        this.#listenedWin = null;
        this.#listenedLabel = '';
      }
    }

    const win = new WebviewWindow(MASTER_OUTPUT, this.#projectionOptions(outputPageUrl(), monitor));
    await this.#waitForWindow(win);
    return this.#placeProjection(win, monitor);
  }

  #projectionOptions(url, monitor) {
    const scale = monitor?.scaleFactor || 1;
    const pos = monitor?.position?.toLogical?.(scale);
    const size = monitor?.size?.toLogical?.(scale);
    const options = {
      url,
      title: 'Y2K VJ by Cín - MASTER OUTPUT',
      decorations: false,
      alwaysOnTop: true,
      shadow: false,
      resizable: false,
      fullscreen: false,
      focus: false,
      visible: false,
      backgroundThrottling: 'disabled',
      center: false,
    };
    if (pos && size) {
      options.x = Math.round(pos.x);
      options.y = Math.round(pos.y);
      options.width = Math.max(320, Math.round(size.width));
      options.height = Math.max(240, Math.round(size.height));
    }
    // Windows WebViews with different additionalBrowserArgs need different data
    // directories. Match the desk args and keep the projector on its own profile.
    if (/Windows/i.test(navigator.userAgent || '')) {
      options.dataDirectory = 'master-output';
      options.additionalBrowserArgs = DESK_BROWSER_ARGS;
    }
    return options;
  }

  #waitForWindow(win) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The output window did not open.')), 8000);
      win.once('tauri://created', () => {
        clearTimeout(timer);
        resolve();
      });
      win.once('tauri://error', (event) => {
        clearTimeout(timer);
        reject(event?.payload ?? event);
      });
    });
  }

  async #placeProjection(win, monitor) {
    const { PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/dpi');
    const origin = new PhysicalPosition(monitor.position.x, monitor.position.y);
    this.nativeSize = {
      w: Math.max(2, Math.round(monitor.size.width)),
      h: Math.max(2, Math.round(monitor.size.height)),
    };
    this.#publishDpi();
    // Move and size the hidden window onto the chosen display, then show it
    // and fullscreen. The frame already fills that monitor, so fullscreen
    // covers the selected screen. No decorations and always-on-top keep the
    // Mac menu bar off this window and leave the launcher where it is.
    await win.setDecorations(false);
    await win.setPosition(origin);
    await win.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
    await win.setAlwaysOnTop(true);
    await win.show();
    await win.setPosition(origin);
    await win.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
    await win.setFullscreen(true);
    if (!isMac()) {
      try { await win.setFocus(); } catch { /* shown window still counts as open */ }
    }
    try {
      await this.#rememberNative(win);
    } catch {
      this.native = true;
      this.nativeWin = win;
      this.nativeOpen = true;
      this.#projectionLabel = win.label;
    }
    try {
      this.#channel().postMessage({ type: OUTPUT_URL_TYPE, url: outputPageUrl() });
    } catch { /* the page is already on the output url */ }
    return true;
  }

  async #rememberNative(win) {
    this.native = true;
    this.nativeWin = win;
    this.nativeOpen = true;
    this.#projectionLabel = win.label;
    if (this.#listenedWin === win) return;
    this.#listenedWin = win;
    this.#listenedLabel = win.label;
    win.once('tauri://destroyed', () => {
      if (this.#closingNative || this.nativeWin !== win) return;
      this.nativeOpen = false;
      this.nativeWin = null;
      this.#projectionLabel = '';
      this.#listenedLabel = '';
      this.#listenedWin = null;
      window.dispatchEvent(new CustomEvent('vj-output-closed'));
    });
    if (this.unlistenResize) {
      try { this.unlistenResize(); } catch { /* already gone */ }
      this.unlistenResize = null;
    }
    try {
      this.unlistenResize = await win.onResized(({ payload }) => {
        if (!payload) return;
        this.nativeSize = {
          w: Math.max(2, Math.round(payload.width)),
          h: Math.max(2, Math.round(payload.height)),
        };
        this.#publishDpi();
      });
    } catch { /* keep sending frames */ }
  }

  async #monitorFor(target) {
    const { primaryMonitor, availableMonitors } = await import('@tauri-apps/api/window');
    const monitors = await availableMonitors();
    const wanted = target?.monitor;
    if (wanted && monitors?.length) {
      const hit = monitors.find((monitor) => (
        monitor.position?.x === wanted.position?.x && monitor.position?.y === wanted.position?.y
      )) || monitors.find((monitor) => monitor.name && monitor.name === wanted.name);
      if (hit) return hit;
    }
    if (wanted) return wanted;
    return (await primaryMonitor()) || monitors?.[0] || null;
  }

  async #closeNative() {
    const win = this.nativeWin;
    this.#closingNative = true;
    this.nativeOpen = false;
    this.nativeWin = null;
    if (this.unlistenResize) {
      try { this.unlistenResize(); } catch { /* already gone */ }
      this.unlistenResize = null;
    }
    try {
      if (win) await win.close();
      else {
        const existing = await WebviewWindow.getByLabel(this.#projectionLabel || MASTER_OUTPUT)
          || await WebviewWindow.getByLabel(PROJECTION_SCREEN);
        if (existing) await existing.close();
      }
    } catch { /* already closed */ }
    this.#closingNative = false;
  }

  #publishDpi() {
    window.dispatchEvent(new CustomEvent('vj-output-dpi', {
      detail: { width: this.nativeSize.w, height: this.nativeSize.h },
    }));
  }

  #channel() {
    if (!this.channel) this.channel = new BroadcastChannel(MIRROR_CHANNEL);
    return this.channel;
  }

  #localCanvas(w, h) {
    if (!this.localCanvas) {
      this.localCanvas = document.createElement('canvas');
      this.localCtx = this.localCanvas.getContext('2d', { alpha: false });
    }
    if (this.localCanvas.width !== w || this.localCanvas.height !== h) {
      this.localCanvas.width = w;
      this.localCanvas.height = h;
    }
    return this.localCanvas;
  }

  #queueNativeFrame(source) {
    if (this.frameBusy || !this.nativeOpen) return;
    this.frameBusy = true;
    createImageBitmap(source).then((bitmap) => {
      if (!this.nativeOpen) {
        bitmap.close();
        return;
      }
      try {
        // Transfer ownership. The projector closes the bitmap after it draws.
        this.#channel().postMessage(bitmap, { transfer: [bitmap] });
      } catch {
        try { bitmap.close(); } catch { /* already released */ }
      }
    }).catch(() => {}).finally(() => {
      this.frameBusy = false;
    });
  }

  #paint(ctx, w, h, overlay, logos = null, source = null, screensaver = null) {
    const src = source || this.canvas;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const sw = src?.width || 0;
    const sh = src?.height || 0;
    let box = null;
    if (sw > 0 && sh > 0) {
      box = fittedBox(sw, sh, w, h, this.fitMode);
      if (box) {
        ctx.drawImage(src, 0, 0, sw, sh, box.dx, box.dy, box.dw, box.dh);
        if (logos?.length) paintLogos(ctx, box, logos);
      }
    }
    if (overlay?.lines?.length) this.#drawHud(ctx, w, h, overlay);
    if (screensaver) paintScreensaver(ctx, w, h, box, screensaver);
  }

  #attach() {
    if (!this.open || this.native) return;
    let doc;
    try { doc = this.win.document; } catch { return; }
    if (!doc?.body || doc.readyState === 'loading') return;
    doc.documentElement.style.margin = '0';
    doc.documentElement.style.padding = '0';
    doc.body.style.margin = '0';
    doc.body.style.padding = '0';
    doc.body.style.background = '#000';
    doc.body.style.overflow = 'hidden';
    const canvas = doc.getElementById('mirror');
    if (!canvas) return;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.background = '#000';
    this.outCanvas = canvas;
    this.outCtx = canvas.getContext('2d', { alpha: false });
    this.#armStart(doc);
  }

  #armStart(doc) {
    let overlay = doc.getElementById('start-output');
    if (!overlay) {
      overlay = doc.createElement('div');
      overlay.id = 'start-output';
      overlay.textContent = 'CLICK TO START OUTPUT';
      doc.body.append(overlay);
    }
    if (overlay.dataset.armed === '1') return;
    overlay.dataset.armed = '1';
    overlay.addEventListener('click', () => {
      overlay.classList.add('gone');
      setTimeout(() => overlay.remove(), 280);
      try { doc.documentElement.requestFullscreen?.(); } catch { /* the picture stays either way */ }
    });
  }

  #outputType(chrome, canvasHeight) {
    const base = Number(chrome.size) || 16;
    const leading = Number(chrome.leading) || 1.45;
    if (!dpiState.auto) {
      const fontSize = Math.max(14, Math.round(base));
      return { fontSize, lineH: Math.round(fontSize * leading) };
    }
    const outputH = dpiState.outputHeight || canvasHeight || 1080;
    const scale = dpiState.dpiScaleFactor * ((canvasHeight || outputH) / outputH);
    const fontSize = Math.max(1, base * scale);
    return { fontSize, lineH: Math.max(1, fontSize * leading) };
  }

  #syncHudStyle(canvas, chrome = {}) {
    const font = chrome.font || HUD_FONT;
    const typed = this.#outputType(chrome, canvas.height || dpiState.outputHeight);
    const size = Math.round(typed.fontSize);
    const color = (HUD_COLORS[chrome.color] || HUD_COLORS.green)[0];
    const glow = (HUD_COLORS[chrome.color] || HUD_COLORS.green)[1];
    const leadingCss = dpiState.auto ? `${typed.lineH.toFixed(2)}px` : String(chrome.leading ?? 1.45);
    const bg = chrome.automask ? 0 : (chrome.bg ?? 0.72);
    const key = `${font}|${size}|${leadingCss}|${color}|${bg}|${glow}`;
    if (key === this.hudStyleKey) return;
    this.hudStyleKey = key;
    canvas.style.setProperty('--hud-font', font);
    canvas.style.setProperty('--hud-size', `${size}px`);
    canvas.style.setProperty('--hud-fg', color);
    canvas.style.setProperty('--hud-glow', glow);
    canvas.style.setProperty('--hud-bg', String(bg));
    canvas.style.setProperty('--hud-leading', leadingCss);
    canvas.style.fontFamily = font;
  }

  #drawHud(ctx, w, h, overlay) {
    const chrome = overlay.chrome || {};
    const { fontSize, lineH } = this.#outputType(chrome, h);
    paintHudText(ctx, w, h, overlay, {
      fontSize,
      lineH,
      fontFamily: chrome.font || HUD_FONT,
    });
  }
}
