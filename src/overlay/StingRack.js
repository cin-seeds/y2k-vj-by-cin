// Three global one-shot videos. They composite above the finished picture
// and are not part of the layer stack or the timeline.

import * as THREE from 'three';
import { blankTexture } from '../layers/Layer.js';

const SLOTS = 3;
const STORE = 'vj.logoSlots';
const MOTIONS = ['cut', 'fade', 'zoom', 'slide'];

/** React off sends the slider. React on scales it by the current kick. */
export function logoFxAmount(fxAmt, react, kick) {
  const amt = Math.min(1, Math.max(0, Number(fxAmt) || 0));
  if (!react) return amt;
  return amt * Math.min(1, Math.max(0, Number(kick) || 0));
}

/** True while the live button and the MIDI pad should stay lit. */
export function logoShown(playing, dismissing) {
  return !!playing && !dismissing;
}

/**
 * Pose for one logo. Scale, x, and y are the resting geometry.
 * Cut is fully on or fully off. Fade changes opacity.
 * Zoom scales from 0.1 to the resting size. Slide glides in from the left.
 */
export function logoPose(motion, reveal, scale, x, y) {
  const t = Math.min(1, Math.max(0, Number(reveal) || 0));
  const ease = t * t * (3 - 2 * t);
  const baseScale = Number.isFinite(Number(scale)) ? Number(scale) : 1;
  const baseX = Number.isFinite(Number(x)) ? Number(x) : 0;
  const baseY = Number.isFinite(Number(y)) ? Number(y) : 0;
  if (motion === 'cut') {
    return { mix: t >= 1 ? 1 : 0, scale: baseScale, x: baseX, y: baseY };
  }
  if (motion === 'zoom') {
    return { mix: t <= 0.001 ? 0 : 1, scale: baseScale * (0.1 + 0.9 * ease), x: baseX, y: baseY };
  }
  if (motion === 'slide') {
    const from = -2.5;
    return { mix: t <= 0.001 ? 0 : 1, scale: baseScale, x: from + (baseX - from) * ease, y: baseY };
  }
  return { mix: ease, scale: baseScale, x: baseX, y: baseY };
}

/**
 * Draw active logos into the letterboxed picture on a recording or output canvas.
 * UV matches the live sting pass: y is up, and the logo center sits at (0.5 + x, 0.5 + y).
 */
export function paintLogos(ctx, box, slots) {
  if (!ctx || !box || !slots?.length || box.dw < 2 || box.dh < 2) return;
  const ca = box.dw / box.dh;
  for (const slot of slots) paintOneLogo(ctx, box, ca, slot);
}

function paintOneLogo(ctx, box, ca, slot) {
  try {
    paintOneLogoInner(ctx, box, ca, slot);
  } catch { /* a tainted logo stays off this frame */ }
}

function paintOneLogoInner(ctx, box, ca, slot) {
  const source = slot?.video;
  const vw = source?.videoWidth || source?.width || 0;
  const vh = source?.videoHeight || source?.height || 0;
  const mix = Math.min(1, Math.max(0, Number(slot?.mix) || 0));
  if (vw < 2 || vh < 2 || mix < 0.001) return;
  const va = vw / vh;
  const s = Math.max(0.001, Number(slot.scale) || 1);
  const sizeX = Math.min(1, va / ca) * s;
  const sizeY = Math.min(1, ca / va) * s;
  const left = 0.5 + (Number(slot.x) || 0) - sizeX / 2;
  const top = 0.5 + (Number(slot.y) || 0) + sizeY / 2;
  const x = box.dx + left * box.dw;
  const y = box.dy + (1 - top) * box.dh;
  const w = sizeX * box.dw;
  const h = sizeY * box.dh;
  const image = slot.autoMask ? maskLogo(source, w, h) : source;
  if ((slot.mode | 0) === 2) {
    invertLogo(ctx, x, y, w, h, image, mix);
    return;
  }
  ctx.save();
  ctx.globalAlpha = mix;
  if ((slot.mode | 0) === 0) ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(image, x, y, w, h);
  ctx.restore();
}

let maskCanvas = null;
let maskCtx = null;

function maskLogo(source, w, h) {
  const width = Math.max(2, Math.round(Math.abs(w)));
  const height = Math.max(2, Math.round(Math.abs(h)));
  if (!maskCanvas) {
    maskCanvas = document.createElement('canvas');
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (maskCanvas.width !== width || maskCanvas.height !== height) {
    maskCanvas.width = width;
    maskCanvas.height = height;
  }
  maskCtx.clearRect(0, 0, width, height);
  maskCtx.drawImage(source, 0, 0, width, height);
  const img = maskCtx.getImageData(0, 0, width, height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
    const gate = lum <= 0.02 ? 0 : lum >= 0.12 ? 1 : (lum - 0.02) / 0.1;
    data[i + 3] = Math.round(data[i + 3] * gate);
  }
  maskCtx.putImageData(img, 0, 0);
  return maskCanvas;
}

let invertCanvas = null;
let invertCtx = null;

function invertLogo(ctx, x, y, w, h, image, mix) {
  const width = Math.max(2, Math.round(Math.abs(w)));
  const height = Math.max(2, Math.round(Math.abs(h)));
  if (!invertCanvas) {
    invertCanvas = document.createElement('canvas');
    invertCtx = invertCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (invertCanvas.width !== width || invertCanvas.height !== height) {
    invertCanvas.width = width;
    invertCanvas.height = height;
  }
  invertCtx.clearRect(0, 0, width, height);
  invertCtx.drawImage(image, 0, 0, width, height);
  const cover = invertCtx.getImageData(0, 0, width, height);
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const dest = ctx.getImageData(left, top, width, height);
  const src = cover.data;
  const out = dest.data;
  for (let i = 0; i < out.length; i += 4) {
    const key = (Math.max(src[i], src[i + 1], src[i + 2]) / 255) * (src[i + 3] / 255) * mix;
    if (key < 0.04) continue;
    const t = key >= 0.22 ? 1 : (key - 0.04) / 0.18;
    out[i] = Math.round(out[i] + (255 - 2 * out[i]) * t);
    out[i + 1] = Math.round(out[i + 1] + (255 - 2 * out[i + 1]) * t);
    out[i + 2] = Math.round(out[i + 2] + (255 - 2 * out[i + 2]) * t);
  }
  ctx.putImageData(dest, left, top);
}

function pool() {
  let host = document.getElementById('sting-pool');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'sting-pool';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;';
  document.body.append(host);
  return host;
}

function makeVideo() {
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.loop = false;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.crossOrigin = 'anonymous';
  video.style.cssText = 'position:absolute;width:320px;height:180px;';
  pool().append(video);
  return video;
}

function uploadFrame(gl, tex, video) {
  const w = video.videoWidth | 0;
  const h = video.videoHeight | 0;
  if (w < 2 || h < 2) return;
  const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  if (tex._vw !== w || tex._vh !== h) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    tex._vw = w;
    tex._vh = h;
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
  gl.bindTexture(gl.TEXTURE_2D, prev);
}

function releaseTexture(slot) {
  const tex = slot.texture;
  if (!tex) return;
  const raw = tex.sourceTexture;
  tex.sourceTexture = null;
  tex.dispose();
  if (slot.gl && raw) slot.gl.deleteTexture(raw);
  slot.texture = null;
}

export class StingRack {
  constructor(root, { onChange } = {}) {
    this.slots = [];
    this.root = root;
    this.onChange = onChange || (() => {});
    const list = document.createElement('div');
    list.className = 'sting-slots';
    root.append(list);
    for (let i = 0; i < SLOTS; i++) this.slots.push(this.#slot(list, i));
    this.#syncDefine();
  }

  #syncDefine() {
    const tag = document.getElementById('brand-define');
    if (tag) tag.hidden = this.slots.some((slot) => slot.ready);
  }

  get live() {
    return this.slots.some((slot) => this.#active(slot));
  }

  buttonName(index) {
    const slot = this.slots[index | 0];
    if (!slot) return `Logo ${index + 1}`;
    const custom = slot.label.trim();
    return custom || `Logo ${slot.index + 1}`;
  }

  trigger(index) {
    const slot = this.slots[index | 0];
    if (slot) this.#trigger(slot);
  }

  shown(index) {
    const slot = this.slots[index | 0];
    return logoShown(slot?.playing, slot?.dismissing);
  }

  update(renderer, dt = 0) {
    const step = Math.min(0.1, Math.max(0, Number(dt) || 0));
    for (const slot of this.slots) {
      if (renderer && slot.ready && !slot.texture) this.#ensureTexture(slot, renderer);
      if (!slot.playing) continue;
      if (slot.opacity <= 0.001) {
        this.#finish(slot);
        continue;
      }
      if (slot.motion === 'cut') {
        if (slot.dismissing) {
          this.#finish(slot);
          continue;
        }
        slot.reveal = 1;
      } else {
        const span = Math.min(2, Math.max(0.1, Number(slot.motionSec) || 0.5));
        const dir = slot.dismissing ? -1 : 1;
        slot.reveal = Math.min(1, Math.max(0, slot.reveal + dir * (step / span)));
      }
      if (slot.dismissing && slot.reveal <= 0.001) {
        this.#finish(slot);
        continue;
      }
      if (slot.texture) uploadFrame(slot.gl, slot.texture.sourceTexture, slot.video);
      const video = slot.video;
      if (!slot.hold && video.ended) {
        try { video.currentTime = 0; } catch { /* not seekable yet */ }
        video.play().catch(() => {});
      }
    }
  }

  bind(uniforms, kick = 0) {
    this.slots.forEach((slot, i) => {
      const live = this.#active(slot);
      const pose = logoPose(slot.motion, slot.reveal, slot.scale, slot.x, slot.y);
      uniforms[`uSting${i}`].value = live ? slot.texture : blankTexture;
      uniforms[`uMix${i}`].value = live ? slot.opacity * pose.mix : 0;
      uniforms[`uMode${i}`].value = slot.mode;
      uniforms[`uPlace${i}`].value.set(pose.scale, pose.x, pose.y);
      uniforms[`uVid${i}`].value = slot.aspect > 0 ? slot.aspect : 1;
      uniforms[`uMask${i}`].value = slot.autoMask ? 1 : 0;
      uniforms[`uFx${i}`].value = slot.fx;
      uniforms[`uFxAmt${i}`].value = logoFxAmount(slot.fxAmt, slot.fxReact, kick);
    });
  }

  /** Active logos, in the same pose the preview just drew. */
  outputPose() {
    const slots = [];
    for (const slot of this.slots) {
      if (!this.#active(slot)) continue;
      const pose = logoPose(slot.motion, slot.reveal, slot.scale, slot.x, slot.y);
      const mix = slot.opacity * pose.mix;
      if (mix <= 0.001) continue;
      slots.push({
        video: slot.video,
        mix,
        mode: slot.mode | 0,
        scale: pose.scale,
        x: pose.x,
        y: pose.y,
        autoMask: !!slot.autoMask,
      });
    }
    return slots;
  }

  #active(slot) {
    return slot.playing && slot.reveal > 0.001 && slot.opacity > 0.001 && slot.texture;
  }

  #ensureTexture(slot, renderer) {
    const video = slot.video;
    if (video.readyState < video.HAVE_CURRENT_DATA) return;
    const w = video.videoWidth | 0;
    const h = video.videoHeight | 0;
    if (w < 2 || h < 2) return;
    const gl = renderer.getContext();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    uploadFrame(gl, tex, video);
    const texture = new THREE.Texture(video);
    texture.isExternalTexture = true;
    texture.sourceTexture = tex;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    texture.needsUpdate = true;
    slot.gl = gl;
    slot.texture = texture;
    slot.aspect = w / h;
  }

  #finish(slot) {
    slot.playing = false;
    slot.dismissing = false;
    slot.hold = false;
    slot.reveal = 0;
    slot.fade = 0;
    slot.video.loop = false;
    slot.video.pause();
    try { slot.video.currentTime = 0; } catch { /* not seekable yet */ }
    this.#paint(slot);
    this.onChange();
  }

  #paint(slot) {
    const on = logoShown(slot.playing, slot.dismissing);
    slot.card.classList.toggle('playing', on);
    slot.liveBtn?.classList.toggle('on', on);
  }

  #slot(list, index) {
    const slot = {
      video: makeVideo(),
      texture: null,
      gl: null,
      url: '',
      name: '',
      token: 0,
      ready: false,
      aspect: 1,
      playing: false,
      dismissing: false,
      hold: false,
      fade: 0,
      reveal: 0,
      motion: 'fade',
      motionSec: 0.5,
      opacity: 1,
      scale: 1,
      x: 0,
      y: 0,
      mode: 1,
      label: '',
      autoMask: false,
      fx: 0,
      fxAmt: 0.5,
      fxReact: false,
      index,
      liveBtn: document.querySelector(`#live-tools .sting-fire[data-sting="${index}"]`),
      card: null,
      nameEl: null,
    };
    const card = document.createElement('article');
    card.className = 'sting-slot';
    card.innerHTML = `
      <header>
        <b>Logo ${index + 1}</b>
        <button type="button" class="sting-load">Load</button>
        <button type="button" class="sting-clear" hidden>Remove</button>
      </header>
      <span class="sting-name">Empty</span>
      <label class="sting-blend">Name
        <input type="text" class="sting-label-input" maxlength="16" placeholder="Logo ${index + 1}" title="Name on the live button and the Perform track button." />
      </label>
      <label>Opacity <input type="range" min="0" max="1" step="0.01" value="1" data-key="opacity" /><output>1.00</output></label>
      <label class="sting-blend">Motion
        <select data-key="motion" title="How the logo enters and leaves. Duration is both the entrance and the exit.">
          <option value="cut">Cut</option>
          <option value="fade" selected>Fade</option>
          <option value="zoom">Zoom</option>
          <option value="slide">Slide</option>
        </select>
      </label>
      <label>Duration <input type="range" min="0.1" max="2" step="0.05" value="0.5" data-key="motionSec" title="Seconds to show the logo, and seconds to dismiss it." /><output>0.50</output></label>
      <label class="sting-check" title="Drop near-black pixels so a logo filmed on black composites cleanly.">
        <input type="checkbox" data-key="autoMask" /> Auto mask
      </label>
      <label>Scale <input type="range" min="0.25" max="2.5" step="0.01" value="1" data-key="scale" /><output>1.00</output></label>
      <label>Position X <input type="range" min="-0.5" max="0.5" step="0.01" value="0" data-key="x" /><output>0.00</output></label>
      <label>Position Y <input type="range" min="-0.5" max="0.5" step="0.01" value="0" data-key="y" /><output>0.00</output></label>
      <label class="sting-blend">Blend
        <select data-key="mode">
          <option value="0">Additive</option>
          <option value="1" selected>Alpha</option>
          <option value="2">Invert/Key</option>
        </select>
      </label>
      <label class="sting-blend">Effect
        <select data-key="fx">
          <option value="0" selected>None</option>
          <option value="1">Glitch</option>
          <option value="2">Hue</option>
          <option value="3">Pixelate</option>
          <option value="4">Flash</option>
        </select>
      </label>
      <label>Amount <input type="range" min="0" max="1" step="0.01" value="0.5" data-key="fxAmt" /><output>0.50</output></label>
      <label class="sting-check" title="Drive this effect from the kick. Amount is the maximum.">
        <input type="checkbox" data-key="fxReact" /> React
      </label>
    `;
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';
    file.hidden = true;
    card.append(file);
    slot.card = card;
    slot.nameEl = card.querySelector('.sting-name');
    slot.clearBtn = card.querySelector('.sting-clear');
    card.querySelector('.sting-load').addEventListener('click', () => file.click());
    slot.clearBtn.addEventListener('click', () => this.#clear(slot));
    file.addEventListener('change', () => {
      const next = file.files?.[0];
      file.value = '';
      if (next) this.#load(slot, next);
    });
    card.querySelector('.sting-label-input').addEventListener('input', (e) => {
      slot.label = e.target.value;
      this.#applyButton(slot);
      this.#save();
      this.onChange();
    });
    card.querySelector('input[data-key="autoMask"]').addEventListener('change', (e) => {
      slot.autoMask = e.target.checked;
      this.#save();
    });
    card.querySelector('input[data-key="fxReact"]').addEventListener('change', (e) => {
      slot.fxReact = e.target.checked;
      this.#save();
    });
    card.querySelectorAll('input[type="range"]').forEach((input) => {
      const out = input.nextElementSibling;
      input.addEventListener('input', () => {
        slot[input.dataset.key] = Number(input.value);
        if (out) out.textContent = Number(input.value).toFixed(2);
        if (input.dataset.key === 'opacity' && slot.opacity <= 0.001 && slot.playing) this.#finish(slot);
        this.#save();
      });
    });
    card.querySelectorAll('select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const key = sel.dataset.key;
        slot[key] = key === 'motion' ? sel.value : (Number(sel.value) || 0);
        this.#save();
      });
    });
    list.append(card);
    this.#restore(slot);
    return slot;
  }

  #applyButton(slot) {
    const el = slot.liveBtn?.querySelector('.sting-label');
    const custom = slot.label.trim();
    if (el) el.textContent = custom || `Logo ${slot.index + 1}`;
  }

  #save() {
    const data = this.slots.map((slot) => ({
      label: slot.label,
      opacity: slot.opacity,
      scale: slot.scale,
      x: slot.x,
      y: slot.y,
      mode: slot.mode,
      motion: slot.motion,
      motionSec: slot.motionSec,
      autoMask: slot.autoMask,
      fx: slot.fx,
      fxAmt: slot.fxAmt,
      fxReact: slot.fxReact,
    }));
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch { /* ignore a full store */ }
  }

  #restore(slot) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { saved = []; }
    const row = Array.isArray(saved) ? saved[slot.index] : null;
    if (!row || typeof row !== 'object') {
      this.#applyButton(slot);
      return;
    }
    const num = (key, fallback) => {
      const value = Number(row[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    slot.label = typeof row.label === 'string' ? row.label.slice(0, 16) : '';
    slot.opacity = num('opacity', slot.opacity);
    slot.scale = num('scale', slot.scale);
    slot.x = num('x', slot.x);
    slot.y = num('y', slot.y);
    slot.mode = num('mode', slot.mode);
    slot.motion = row.entrance === 'quick'
      ? 'cut'
      : (MOTIONS.includes(row.motion) ? row.motion : 'fade');
    slot.motionSec = Math.min(2, Math.max(0.1, num('motionSec', slot.motionSec)));
    slot.autoMask = !!row.autoMask;
    slot.fx = Math.min(4, Math.max(0, num('fx', 0) | 0));
    slot.fxAmt = Math.min(1, Math.max(0, num('fxAmt', slot.fxAmt)));
    slot.fxReact = !!row.fxReact;
    const card = slot.card;
    const nameInput = card.querySelector('.sting-label-input');
    nameInput.value = slot.label;
    card.querySelector('input[data-key="autoMask"]').checked = slot.autoMask;
    card.querySelector('input[data-key="fxReact"]').checked = slot.fxReact;
    card.querySelectorAll('input[type="range"]').forEach((input) => {
      if (slot[input.dataset.key] == null) return;
      input.value = String(slot[input.dataset.key]);
      const out = input.nextElementSibling;
      if (out) out.textContent = Number(input.value).toFixed(2);
    });
    card.querySelectorAll('select').forEach((sel) => {
      if (slot[sel.dataset.key] == null) return;
      sel.value = String(slot[sel.dataset.key]);
    });
    this.#applyButton(slot);
  }

  #load(slot, file) {
    this.#finish(slot);
    if (slot.url) URL.revokeObjectURL(slot.url);
    releaseTexture(slot);
    slot.ready = false;
    slot.aspect = 1;
    slot.token += 1;
    this.#syncDefine();
    const token = slot.token;
    slot.url = URL.createObjectURL(file);
    slot.name = file.name;
    const video = slot.video;
    video.crossOrigin = 'anonymous';
    video.src = slot.url;
    video.load();
    if (slot.liveBtn) slot.liveBtn.hidden = true;
    if (slot.clearBtn) slot.clearBtn.hidden = false;
    slot.nameEl.textContent = 'Loading…';
    slot.nameEl.title = file.name;
    const ready = () => {
      if (slot.token !== token) return;
      const w = video.videoWidth | 0;
      const h = video.videoHeight | 0;
      if (w >= 2 && h >= 2) slot.aspect = w / h;
      slot.ready = true;
      if (slot.liveBtn) slot.liveBtn.hidden = false;
      if (slot.clearBtn) slot.clearBtn.hidden = false;
      slot.nameEl.textContent = slot.name;
      this.#applyButton(slot);
      this.#syncDefine();
      this.onChange();
    };
    video.addEventListener('canplaythrough', ready, { once: true });
    if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) ready();
    video.addEventListener('error', () => {
      if (slot.token !== token) return;
      slot.ready = false;
      if (slot.clearBtn) slot.clearBtn.hidden = false;
      slot.nameEl.textContent = 'Could not load';
      this.#syncDefine();
    }, { once: true });
  }

  #clear(slot) {
    this.#finish(slot);
    slot.token += 1;
    if (slot.url) URL.revokeObjectURL(slot.url);
    releaseTexture(slot);
    slot.url = '';
    slot.name = '';
    slot.ready = false;
    slot.aspect = 1;
    const video = slot.video;
    video.removeAttribute('src');
    video.load();
    slot.nameEl.textContent = 'Empty';
    slot.nameEl.title = '';
    if (slot.liveBtn) slot.liveBtn.hidden = true;
    if (slot.clearBtn) slot.clearBtn.hidden = true;
    this.#syncDefine();
    this.onChange();
  }

  #trigger(slot) {
    if (!slot.ready || !slot.url || slot.opacity <= 0.001) return;
    if (logoShown(slot.playing, slot.dismissing)) {
      slot.dismissing = true;
      if (slot.motion === 'cut') {
        this.#finish(slot);
        return;
      }
      this.#paint(slot);
      this.onChange();
      return;
    }
    const fresh = !slot.playing;
    slot.dismissing = false;
    slot.playing = true;
    if (slot.motion === 'cut') slot.reveal = 1;
    slot.video.loop = true;
    this.#paint(slot);
    this.onChange();
    if (!fresh) {
      if (slot.video.paused) slot.video.play().catch(() => {});
      return;
    }
    slot.hold = true;
    const video = slot.video;
    const go = () => {
      if (!slot.playing) return;
      slot.hold = false;
      video.play().catch(() => this.#finish(slot));
    };
    try {
      video.pause();
      if (video.currentTime > 0.02) {
        video.addEventListener('seeked', go, { once: true });
        video.currentTime = 0;
      } else {
        video.currentTime = 0;
        go();
      }
    } catch {
      go();
    }
  }
}
