// Three global one-shot videos. They composite above the finished picture
// and are not part of the layer stack or the timeline.

import * as THREE from 'three';
import { blankTexture } from '../layers/Layer.js';

const FADE_SEC = 0.45;
const SLOTS = 3;

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
  constructor(root) {
    this.slots = [];
    this.root = root;
    const list = document.createElement('div');
    list.className = 'sting-slots';
    root.append(list);
    for (let i = 0; i < SLOTS; i++) this.slots.push(this.#slot(list, i));
  }

  get live() {
    return this.slots.some((slot) => this.#active(slot));
  }

  update(renderer) {
    for (const slot of this.slots) {
      if (renderer && slot.ready && !slot.texture) this.#ensureTexture(slot, renderer);
      if (!slot.playing) continue;
      if (slot.opacity <= 0.001) {
        this.#finish(slot);
        continue;
      }
      if (slot.texture) uploadFrame(slot.gl, slot.texture.sourceTexture, slot.video);
      if (slot.hold) continue;
      const video = slot.video;
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) {
        if (video.ended) this.#finish(slot);
        continue;
      }
      const remain = dur - video.currentTime;
      const fade = Math.min(FADE_SEC, dur);
      slot.fade = remain <= fade ? Math.max(0, remain / fade) : 1;
      if (video.ended || remain <= 0.02 || slot.fade <= 0.001) this.#finish(slot);
    }
  }

  bind(uniforms) {
    this.slots.forEach((slot, i) => {
      const live = this.#active(slot);
      uniforms[`uSting${i}`].value = live ? slot.texture : blankTexture;
      uniforms[`uMix${i}`].value = live ? slot.opacity * slot.fade : 0;
      uniforms[`uMode${i}`].value = slot.mode;
      uniforms[`uPlace${i}`].value.set(slot.scale, slot.x, slot.y);
      uniforms[`uVid${i}`].value = slot.aspect > 0 ? slot.aspect : 1;
    });
  }

  #active(slot) {
    return slot.playing && slot.fade > 0.001 && slot.opacity > 0.001 && slot.texture;
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
    slot.hold = false;
    slot.fade = 0;
    slot.video.pause();
    try { slot.video.currentTime = 0; } catch { /* not seekable yet */ }
    this.#paint(slot);
  }

  #paint(slot) {
    const on = slot.playing;
    slot.card.classList.toggle('playing', on);
    slot.fire.classList.toggle('on', on);
    slot.arm.classList.toggle('on', on);
    slot.arm.textContent = on ? 'On' : 'Off';
    slot.arm.setAttribute('aria-pressed', on ? 'true' : 'false');
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
      hold: false,
      fade: 0,
      opacity: 1,
      scale: 1,
      x: 0,
      y: 0,
      mode: 1,
      fire: null,
      arm: null,
      card: null,
      nameEl: null,
    };
    const card = document.createElement('article');
    card.className = 'sting-slot';
    card.innerHTML = `
      <header>
        <b>Sting ${index + 1}</b>
        <button type="button" class="sting-arm" aria-pressed="false" disabled>Off</button>
        <button type="button" class="sting-load">Load</button>
        <button type="button" class="sting-fire" disabled>Trigger</button>
      </header>
      <span class="sting-name">Empty</span>
      <label>Opacity <input type="range" min="0" max="1" step="0.01" value="1" data-key="opacity" /><output>1.00</output></label>
      <label>Scale <input type="range" min="0.25" max="2.5" step="0.01" value="1" data-key="scale" /><output>1.00</output></label>
      <label>Position X <input type="range" min="-0.5" max="0.5" step="0.01" value="0" data-key="x" /><output>0.00</output></label>
      <label>Position Y <input type="range" min="-0.5" max="0.5" step="0.01" value="0" data-key="y" /><output>0.00</output></label>
      <label class="sting-blend">Blend
        <select>
          <option value="0">Additive</option>
          <option value="1" selected>Alpha</option>
          <option value="2">Invert/Key</option>
        </select>
      </label>
    `;
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';
    file.hidden = true;
    card.append(file);
    slot.card = card;
    slot.nameEl = card.querySelector('.sting-name');
    slot.fire = card.querySelector('.sting-fire');
    slot.arm = card.querySelector('.sting-arm');
    card.querySelector('.sting-load').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const next = file.files?.[0];
      file.value = '';
      if (next) this.#load(slot, next);
    });
    slot.fire.addEventListener('click', () => this.#trigger(slot));
    slot.arm.addEventListener('click', () => {
      if (slot.playing) this.#finish(slot);
      else this.#trigger(slot);
    });
    card.querySelectorAll('input[type="range"]').forEach((input) => {
      const out = input.nextElementSibling;
      input.addEventListener('input', () => {
        slot[input.dataset.key] = Number(input.value);
        if (out) out.textContent = Number(input.value).toFixed(2);
        if (input.dataset.key === 'opacity' && slot.opacity <= 0.001 && slot.playing) this.#finish(slot);
      });
    });
    card.querySelector('select').addEventListener('change', (e) => {
      slot.mode = Number(e.target.value) || 0;
    });
    list.append(card);
    return slot;
  }

  #load(slot, file) {
    this.#finish(slot);
    if (slot.url) URL.revokeObjectURL(slot.url);
    releaseTexture(slot);
    slot.ready = false;
    slot.aspect = 1;
    slot.token += 1;
    const token = slot.token;
    slot.url = URL.createObjectURL(file);
    slot.name = file.name;
    const video = slot.video;
    video.crossOrigin = 'anonymous';
    video.src = slot.url;
    video.load();
    slot.fire.disabled = true;
    slot.arm.disabled = true;
    slot.nameEl.textContent = 'Loading…';
    slot.nameEl.title = file.name;
    const ready = () => {
      if (slot.token !== token) return;
      const w = video.videoWidth | 0;
      const h = video.videoHeight | 0;
      if (w >= 2 && h >= 2) slot.aspect = w / h;
      slot.ready = true;
      slot.fire.disabled = false;
      slot.arm.disabled = false;
      slot.nameEl.textContent = slot.name;
    };
    video.addEventListener('canplaythrough', ready, { once: true });
    if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) ready();
    video.addEventListener('error', () => {
      if (slot.token !== token) return;
      slot.ready = false;
      slot.nameEl.textContent = 'Could not load';
    }, { once: true });
  }

  #trigger(slot) {
    if (!slot.ready || !slot.url || slot.opacity <= 0.001) return;
    slot.fade = 1;
    slot.playing = true;
    slot.hold = true;
    this.#paint(slot);
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
