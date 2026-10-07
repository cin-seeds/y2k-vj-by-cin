import * as THREE from 'three';
import vertexShader from '../shaders/fullscreen.vert?raw';
import mixFrag from '../shaders/mix.frag?raw';
import { FrameRing } from './FrameRing.js';
import { pullPicture, unwatchPicture, watchPicture } from './PictureRecv.js';
import { applyMediaSink } from '../audio/outputSink.js';

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv)$/i;

const blackPixel = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blackPixel.magFilter = blackPixel.minFilter = THREE.LinearFilter;
blackPixel.generateMipmaps = false;
blackPixel.wrapS = blackPixel.wrapT = THREE.ClampToEdgeWrapping;
blackPixel.needsUpdate = true;

let cachedPictureColor;
function pictureColorSpace() {
  if (!cachedPictureColor) cachedPictureColor = new THREE.Texture().colorSpace;
  return cachedPictureColor;
}

function webStreamUrl(url) {
  return typeof url === 'string'
    && /\.(mp4|webm)(\?|#|$)/i.test(url)
    && !/\.(ogv|ogg|ogx)(\?|#|$)/i.test(url);
}

// One host for every clip. It is created once and never rebuilt by UI updates.
function videoHost() {
  let host = document.getElementById('video-pool');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'video-pool';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  return host;
}

/**
 * A video frame source that reuses one GPU allocation.
 * Three's VideoTexture calls texImage2D on every frame, which reallocates.
 * A plain texture allocates once (texStorage) and then updates with texSubImage2D.
 * Frames are marked from the app clock, not requestVideoFrameCallback, so a
 * blurred window (the background interval clock) still uploads.
 */
class StableVideoTexture extends THREE.Texture {
  constructor(video) {
    super(video);
    this.isStableVideo = true;
    this.generateMipmaps = false;
    this.minFilter = THREE.LinearFilter;
    this.magFilter = THREE.LinearFilter;
    this.wrapS = this.wrapT = THREE.ClampToEdgeWrapping;
    this.userData.stamp = -1;
  }

  /**
   * @param {boolean} [live=false] camera streams can sit on one currentTime, so they upload with the app clock
   * @returns {boolean} true when a new frame was queued for upload
   */
  present(live = false) {
    const video = this.image;
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return false;
    const w = video.videoWidth | 0;
    const h = video.videoHeight | 0;
    if (w < 2 || h < 2) return false;
    if (video.width !== w) video.width = w;
    if (video.height !== h) video.height = h;
    const stamp = live ? performance.now() : video.currentTime;
    if (!live && this.userData.stamp === stamp && this.userData.w === w && this.userData.h === h) return false;
    this.userData.stamp = stamp;
    this.userData.w = w;
    this.userData.h = h;
    this.needsUpdate = true;
    return true;
  }
}

export const PLAY_MODES = ['loop', 'once', 'bounce'];

export class InputManager {
  constructor() {
    this.texture = null;
    this.displayTexture = null;
    this.width = 1;
    this.height = 1;
    this.kind = 'none';
    this.video = null;
    this.alt = null;
    this.altTex = null;
    this.stream = null;
    this.objectUrl = null;

    this.playMode = 'loop';
    this.loopIn = 0;
    this.loopOut = 0;
    this.scrubHold = false;
    this.playedUrl = '';
    this.onExhausted = null;
    this.onBrokenKey = null;
    this.rejected = [];
    this.direction = 1;
    this.userPaused = false;
    this.visualRate = 1;
    this.pictureKey = '';
    this.pictureSeen = 0;
    this.pictureBusy = false;
    this.pictureLast = 0;
    this.pictureToken = 0;
    this.pictureNote = '';
    this.pictureError = false;
    this.loopXfadeOn = false;
    this.loopXfadeDur = 0.4;
    this.loopMix = 0;
    this.lastCapTime = -1;
    this.ring = new FrameRing();
    this.revTarget = null;
    this.mixRt = null;

    this.mixScene = new THREE.Scene();
    this.mixCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.#makeMixQuad();

    // One idle texture per layer, allocated with the layer and never rebuilt per frame.
    const idle = new Uint8Array(64 * 64 * 4);
    this.slot = new THREE.DataTexture(idle, 64, 64);
    this.slot.colorSpace = THREE.NoColorSpace;
    this.slot.needsUpdate = true;
    this.#configure(this.slot);
  }

  async listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  #makeMixQuad() {
    this.mixQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          uA: { value: null },
          uB: { value: null },
          uMix: { value: 0 },
        },
        vertexShader,
        fragmentShader: mixFrag,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.mixQuad.frustumCulled = false;
    this.mixScene.add(this.mixQuad);
  }

  #restoreGpu() {
    this.ring = new FrameRing();
    this.#makeMixQuad();
  }

  async useCamera(deviceId) {
    this.dispose();
    this.#restoreGpu();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
    });
    const video = this.#makeVideo();
    video.srcObject = this.stream;
    await video.play();
    this.#setLive(video, 'camera');
  }

  /** ndi:<name> or spout:<name>. Frames land in the same texture a camera uses. */
  async usePicture(key) {
    this.dispose();
    this.#restoreGpu();
    this.kind = 'picture';
    this.pictureKey = key;
    this.texture = blackPixel;
    this.displayTexture = blackPixel;
    this.width = 1;
    this.height = 1;
    this.pictureNote = 'waiting for picture...';
    this.pictureError = false;
    const report = await watchPicture(key);
    if (this.pictureKey !== key) return;
    if (!report.ok) {
      this.pictureNote = report.reason || 'The picture source did not open.';
      this.pictureError = true;
    }
  }

  async useFile(file) {
    this.dispose();
    this.#restoreGpu();
    this.objectUrl = URL.createObjectURL(file);

    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.src = this.objectUrl;
      await img.decode();
      const tex = new THREE.Texture(img);
      this.#configure(tex);
      tex.needsUpdate = true;
      this.texture = tex;
      this.displayTexture = tex;
      this.width = img.naturalWidth;
      this.height = img.naturalHeight;
      this.kind = 'image';
      return;
    }

    if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name)) {
      const video = this.#makeVideo();
      video.crossOrigin = 'anonymous';
      video.src = this.objectUrl;
      await this.#playOrFallback(video);
      return;
    }

    this.dispose();
    throw new Error(`Unsupported file type: ${file.type || file.name}`);
  }

  /**
   * Stream a remote MP4 or WebM. The element stays in the offscreen pool: looped,
   * muted, and playsinline. The layer texture's image is this element, so the
   * renderer uploads it with
   * texImage2D(TEXTURE_2D, 0, RGBA, RGBA, UNSIGNED_BYTE, video).
   * @returns {Promise<boolean>} false when every stream failed and the test pattern is up
   */
  async useUrl(url, alts = []) {
    this.dispose();
    this.#restoreGpu();
    this.#remote = true;
    this.rejected = [];
    this.#fallbacks = alts.filter((item) => webStreamUrl(item) && item !== url);
    const video = this.#makeVideo();
    this.#mountRemote(video, url);
    return this.#playOrFallback(video);
  }

  #remote = false;

  /** crossOrigin is set before src so the element does not start a tainted fetch. */
  #mountRemote(video, url) {
    video.crossOrigin = 'anonymous';
    video.src = url;
  }
  get duration() {
    const d = this.video?.duration;
    return this.kind === 'video' && Number.isFinite(d) ? d : 0;
  }

  get currentTime() {
    if (this.kind !== 'video') return 0;
    if (this.direction < 0) return Math.max(0, this.ring.revTime);
    return this.video.currentTime;
  }

  get playing() {
    if (this.kind !== 'video') return false;
    return this.direction < 0 ? !this.userPaused : !this.video.paused;
  }

  get reversing() {
    return this.kind === 'video' && this.direction < 0;
  }

  setPlayMode(mode) {
    this.playMode = PLAY_MODES.includes(mode) ? mode : 'loop';
    if (this.kind !== 'video') return;
    this.#applyLoopFlag(this.video);
    if (this.playMode !== 'bounce' && this.direction < 0) this.#goForward(this.#bounds().inn);
  }

  setLoopXfade(on) {
    this.loopXfadeOn = !!on;
    if (!this.loopXfadeOn) this.loopMix = 0;
    if (this.kind === 'video') this.#applyLoopFlag(this.video);
  }

  setLoopXfadeDur(sec) {
    this.loopXfadeDur = Math.min(2, Math.max(0.1, sec));
  }

  setLoopPoints(inn, out) {
    this.loopIn = Math.max(0, Number(inn) || 0);
    const nextOut = Number(out);
    this.loopOut = Number.isFinite(nextOut) && nextOut > 0 ? nextOut : 0;
    this.#clampLoop();
    this.#applyLoopFlag(this.video);
    if (this.kind !== 'video' || !this.video || this.scrubHold) return;
    const { inn: start, out: end } = this.#bounds();
    if (this.video.currentTime < start || this.video.currentTime > end) this.#goForward(start);
  }

  /** 0 loop-out means the end of the file. In and out stay at least one frame apart. */
  #bounds() {
    const d = this.duration;
    let inn = Math.max(0, this.loopIn || 0);
    let out = this.loopOut > 0 ? this.loopOut : d;
    if (d) {
      inn = Math.min(inn, Math.max(0, d - 0.05));
      out = Math.min(d, Math.max(out, 0));
    }
    if (!(out > inn)) out = inn + 0.05;
    return { inn, out };
  }

  #clampLoop() {
    const d = this.duration;
    if (this.loopIn < 0) this.loopIn = 0;
    if (d && this.loopIn > d) this.loopIn = Math.max(0, d - 0.05);
    if (this.loopOut > 0 && d) this.loopOut = Math.min(d, this.loopOut);
    if (this.loopOut > 0 && this.loopOut <= this.loopIn) {
      this.loopOut = Math.min(d || this.loopIn + 0.1, this.loopIn + 0.1);
    }
  }

  #spanIsFull() {
    const d = this.duration;
    if (!d) return true;
    const { inn, out } = this.#bounds();
    return inn <= 0.001 && out >= d - 0.05;
  }

  play() {
    if (this.kind !== 'video' || !this.video) return;
    this.userPaused = false;
    if (this.direction < 0) return;
    this.video.play().catch(() => {});
  }

  pause() {
    if (this.kind !== 'video') return;
    this.userPaused = true;
    this.#safePause(this.video);
    this.#safePause(this.alt);
  }

  /** Transport stop: hold the clip and park both elements at the first frame. */
  stopToStart() {
    if (this.kind !== 'video' || !this.video) return;
    this.userPaused = true;
    this.scrubHold = false;
    this.direction = 1;
    this.loopMix = 0;
    this.revTarget = null;
    this.ring.clear();
    this.lastCapTime = -1;
    this.#safePause(this.video);
    this.#safePause(this.alt);
    this.#safeSeek(this.video, 0);
    this.#safeSeek(this.alt, 0);
    if (this.texture?.isStableVideo) this.texture.userData.stamp = -1;
  }

  /**
   * Park the clip at a show time in seconds, wrapping a looping clip inside its duration.
   * Play then starts from that frame.
   */
  alignTo(seconds) {
    if (this.kind !== 'video' || !this.video) return;
    const d = this.duration;
    let t = Math.max(0, Number(seconds) || 0);
    if (d > 0) {
      t = this.playMode === 'once' ? Math.min(t, Math.max(0, d - 0.001)) : t % d;
    } else {
      t = 0;
    }
    this.direction = 1;
    this.loopMix = 0;
    this.revTarget = null;
    this.ring.clear();
    this.lastCapTime = -1;
    this.#safePause(this.alt);
    this.#safeSeek(this.video, t);
    this.#safeSeek(this.alt, t);
    if (this.texture?.isStableVideo) this.texture.userData.stamp = -1;
    if (this.altTex?.isStableVideo) this.altTex.userData.stamp = -1;
  }

  #safePause(video) {
    if (!video) return;
    try {
      const pending = video.pause();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* the element has no frames yet */ }
  }

  #safeSeek(video, time) {
    if (!video || !Number.isFinite(time)) return;
    if ((video.readyState || 0) < 1) return;
    try {
      if (Math.abs((video.currentTime || 0) - time) < 0.001) return;
      video.currentTime = time;
    } catch { /* not seekable yet */ }
  }

  restart() {
    if (this.kind !== 'video') return;
    this.ring.clear();
    this.lastCapTime = -1;
    this.#goForward(this.#bounds().inn);
  }

  seekTime(seconds) {
    const d = this.duration;
    if (!d || this.kind !== 'video') return;
    const t = Math.min(d, Math.max(0, seconds));
    this.scrubHold = true;
    this.ring.clear();
    this.lastCapTime = -1;
    this.#goForward(t);
    if (this.texture?.isStableVideo) this.texture.userData.stamp = -1;
  }

  endScrub() {
    this.scrubHold = false;
  }

  /**
   * Capture / reverse / loop-crossfade. Call once per frame with the WebGL renderer
   * so bounce can write the ring and the loop mix can blit.
   */
  update(dt, renderer) {
    if (this.kind === 'picture') {
      this.#pullPicture(renderer);
      return;
    }
    if ((this.kind !== 'video' && this.kind !== 'camera') || !this.video) return;
    this.#syncTexture(this.texture, this.video);
    this.#syncTexture(this.altTex, this.alt);
    this.#keepPlaying();
    if (this.kind !== 'video') return;
    if (!this.scrubHold) this.#enforceLoop();

    if (this.direction > 0 && !this.userPaused && !this.video.paused && renderer) {
      // The ring is only for bounce. Looping clips stay on the native element.
      if (this.playMode === 'bounce') {
        const t = this.video.currentTime;
        const { inn, out } = this.#bounds();
        if (t >= inn && t <= out && t !== this.lastCapTime) {
          this.ring.push(renderer, this.texture, t, this.width, this.height);
          this.lastCapTime = t;
        }
        if (!this.scrubHold) this.#tickBounceEdge();
      }
      this.#tickLoopXfade();
    }

    if (this.direction < 0 && !this.userPaused && (this.visualRate ?? 1) > 0.001) {
      const next = this.ring.stepReverse(dt, 1);
      const { inn } = this.#bounds();
      if (!next || this.ring.revTime <= inn) {
        this.#goForward(inn);
        this.revTarget = null;
      } else {
        this.revTarget = next;
      }
    }

    this.#present(renderer);
  }

  dispose() {
    const watched = this.pictureKey;
    this.pictureToken += 1;
    this.pictureKey = '';
    this.pictureBusy = false;
    this.pictureSeen = 0;
    this.pictureLast = 0;
    this.pictureNote = '';
    this.pictureError = false;
    if (watched) unwatchPicture(watched);
    if (this.texture && this.texture !== this.slot && this.texture !== blackPixel) this.texture.dispose();
    if (this.altTex && this.altTex !== blackPixel) this.altTex.dispose();
    this.mixRt?.dispose();
    if (this.mixQuad) {
      this.mixQuad.geometry.dispose();
      this.mixQuad.material.dispose();
      this.mixScene.remove(this.mixQuad);
      this.mixQuad = null;
    }
    this.ring?.dispose();
    this.ring = null;
    this.texture = this.slot;
    this.displayTexture = null;
    this.altTex = this.mixRt = null;
    this.#killVideo(this.video);
    this.#killVideo(this.alt);
    this.video = this.alt = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.#fallbacks = [];
    this.#remote = false;
    this.kind = 'none';
    this.width = this.height = 1;
    this.direction = 1;
    this.userPaused = false;
    this.loopMix = 0;
    this.lastCapTime = -1;
    this.revTarget = null;
    this.slot?.dispose();
    this.slot = null;
    this.texture = null;
    this.displayTexture = null;
  }

  #makeVideo() {
    const v = document.createElement('video');
    v.autoplay = true;
    v.loop = true;
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.setAttribute('autoplay', '');
    v.setAttribute('loop', '');
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('crossorigin', 'anonymous');
    v.disablePictureInPicture = true;
    try {
      v.preservesPitch = false;
      v.webkitPreservesPitch = false;
    } catch { /* older engines omit pitch preservation */ }
    applyMediaSink(v);
    videoHost().append(v);
    return v;
  }

  #fallbacks = [];

  /**
   * play() stays on this element. A codec or source error warns once, then the
   * next queued loop is opened. With none left, the layer drops back to the test pattern.
   */
  #playOrFallback(video) {
    this.#applyLoopFlag(video);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => fail(), 25000);
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.onerror = null;
        video.removeEventListener('loadeddata', ready);
        if (!reported) report(video.src);
        this.#killVideo(video);
        if (this.video === video) this.video = null;
        const next = this.#fallbacks.shift();
        if (!next) {
          this.dispose();
          resolve(false);
          return;
        }
        const again = this.#makeVideo();
        this.#mountRemote(again, next);
        this.#playOrFallback(again).then(resolve);
      };
      let reported = false;
      const report = (src) => {
        if (reported) return;
        reported = true;
        if (this.#remote) {
          this.rejected.push(src);
          console.warn('CORS or stream error on fetched video, clearing broken key:', src);
          this.onBrokenKey?.(src);
          return;
        }
        console.warn('Codec or source error loading video, falling back to next stream');
      };
      const ready = () => {
        if (settled || video.error || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadeddata', ready);
        this.#setLive(video, 'video');
        this.#watchLive(video);
        this.#prepareAlt();
        resolve(true);
      };
      video.onerror = () => {
        report(video.src);
        fail();
      };
      video.addEventListener('loadeddata', ready);
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.error) ready();
      const started = video.play();
      if (started?.catch) started.catch(() => { if (video.error) fail(); });
    });
  }

  #watchLive(video) {
    video.onerror = () => {
      const src = video.src;
      if (this.#remote) {
        this.rejected.push(src);
        console.warn('CORS or stream error on fetched video, clearing broken key:', src);
        this.onBrokenKey?.(src);
      } else {
        console.warn('Codec or source error loading video, falling back to next stream');
      }
      if (this.video !== video) return;
      video.onerror = null;
      this.#killVideo(video);
      this.video = null;
      const next = this.#fallbacks.shift();
      if (!next) {
        this.dispose();
        this.onExhausted?.();
        return;
      }
      const again = this.#makeVideo();
      this.#mountRemote(again, next);
      this.#playOrFallback(again).then((ok) => {
        if (!ok) this.onExhausted?.();
      });
    };
  }

  #killVideo(v) {
    if (!v) return;
    v.onerror = null;
    try {
      const pending = v.pause();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* already detached */ }
    v.srcObject = null;
    v.src = '';
    v.removeAttribute('src');
    v.load();
    v.remove();
  }

  #syncTexture(tex, video) {
    if (!tex || !video || typeof tex.present !== 'function') return;
    const live = this.kind === 'camera' && video === this.video;
    if (!tex.present(live)) return;
    if (video === this.video) {
      const w = video.videoWidth | 0;
      const h = video.videoHeight | 0;
      if (w > 1 && h > 1) {
        this.width = w;
        this.height = h;
      }
    }
  }

  /**
   * The audio file clock never starts or stops these elements.
   * If the browser pauses a clip on its own, start it again unless the user paused it.
   */
  setVisualRate(rate) {
    if (this.kind !== 'video') return;
    const next = Number.isFinite(rate) ? Math.min(4, Math.max(0, rate)) : 1;
    this.visualRate = next;
    this.#applyVisualRate(this.video);
    this.#applyVisualRate(this.alt);
  }

  #applyVisualRate(video) {
    if (!video) return;
    try {
      video.preservesPitch = false;
      video.webkitPreservesPitch = false;
    } catch { /* optional */ }
    if ((this.visualRate ?? 1) <= 0.001) {
      if (video === this.video && !this.userPaused && !video.paused) {
        try { video.pause(); } catch { /* already paused */ }
      }
      return;
    }
    const applied = Math.min(4, Math.max(0.0625, this.visualRate));
    if (Math.abs((video.playbackRate || 1) - applied) > 0.01) {
      try { video.playbackRate = applied; } catch { /* not ready yet */ }
    }
  }

  #keepPlaying() {
    const v = this.video;
    if (!v || this.userPaused || this.direction < 0 || (this.visualRate ?? 1) <= 0.001) return;
    if (this.kind === 'video' && this.playMode === 'once' && v.ended) return;
    if (!v.paused || v._playPending) return;
    v._playPending = true;
    v.play().catch(() => {}).finally(() => { v._playPending = false; });
  }

  #configure(tex) {
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  }

  #applyLoopFlag(video) {
    if (!video) return;
    video.loop = this.playMode === 'loop' && !this.loopXfadeOn && this.#spanIsFull();
  }

  #enforceLoop() {
    const v = this.video;
    if (!v || this.userPaused || this.kind !== 'video' || this.direction < 0) return;
    const { inn, out } = this.#bounds();
    if (!(out > inn)) return;
    const t = v.currentTime;
    if (this.playMode === 'bounce') {
      if (t >= out - 1 / 90) this.#beginReverse();
      else if (t < inn) this.#jump(v, inn);
      return;
    }
    if (this.playMode === 'once') {
      if (t >= out) {
        this.#jump(v, out);
        if (!v.paused) v.pause();
      } else if (t < inn) this.#jump(v, inn);
      return;
    }
    if (this.loopXfadeOn) return;
    if (t >= out || t < inn) this.#jump(v, inn);
  }

  #jump(video, time) {
    if (Math.abs(video.currentTime - time) < 0.001) return;
    video.currentTime = time;
    if (this.texture?.isStableVideo) this.texture.userData.stamp = -1;
  }

  #setLive(video, kind) {
    this.video = video;
    this.kind = kind;
    this.playedUrl = video.currentSrc || video.src || '';
    this.texture = blackPixel;
    this.displayTexture = blackPixel;
    const arm = () => {
      if (this.video !== video) return;
      if ((video.videoWidth | 0) < 2) {
        video.addEventListener('resize', arm, { once: true });
        return;
      }
      this.#attachVideoTexture(video, kind);
    };
    const framed = video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA && (video.videoWidth | 0) >= 2;
    if (kind === 'camera') {
      if ((video.videoWidth | 0) >= 2) arm();
      else video.addEventListener('resize', arm, { once: true });
    } else if (framed) arm();
    else {
      video.addEventListener('canplaythrough', arm, { once: true });
      video.addEventListener('playing', arm, { once: true });
    }
    if (!this.userPaused && video.paused) video.play().catch(() => {});
    if (kind !== 'video') return;

    this.#bindEnded(video);
    if (video.dataset.bound !== '1') {
      video.dataset.bound = '1';
      video.addEventListener('seeked', () => {
        if (this.video === video && this.texture?.isStableVideo) this.texture.userData.stamp = -1;
      });
    }
  }

  #attachVideoTexture(video, kind) {
    const w = video.videoWidth | 0;
    const h = video.videoHeight | 0;
    const prev = this.texture;
    const reuse = prev?.isStableVideo && prev.image === video && w > 1
      && prev.userData.w === w && prev.userData.h === h;
    if (reuse) prev.userData.stamp = -1;
    else {
      if (prev && prev !== this.slot && prev !== blackPixel) prev.dispose();
      this.texture = new StableVideoTexture(video);
      this.#configure(this.texture);
    }
    this.displayTexture = this.texture;
    this.width = w || video.videoWidth || 1280;
    this.height = h || video.videoHeight || 720;
    this.kind = kind;
  }

  #prepareAlt() {
    if (!this.video || this.alt) return;
    const alt = this.#makeVideo();
    alt.crossOrigin = 'anonymous';
    alt.src = this.video.currentSrc || this.video.src;
    alt.loop = false;
    alt.preload = 'auto';
    alt.pause();
    this.alt = alt;
    this.altTex = blackPixel;
    const arm = () => {
      if (this.alt !== alt) return;
      if ((alt.videoWidth | 0) < 2) {
        alt.addEventListener('resize', arm, { once: true });
        return;
      }
      const prev = this.altTex;
      if (prev && prev !== blackPixel && prev !== this.texture) prev.dispose();
      this.altTex = new StableVideoTexture(alt);
      this.#configure(this.altTex);
    };
    if (alt.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA && (alt.videoWidth | 0) >= 2) arm();
    else alt.addEventListener('canplaythrough', arm, { once: true });
  }

  #goForward(time) {
    this.direction = 1;
    this.loopMix = 0;
    this.revTarget = null;
    if (!this.video) return;
    if (Number.isFinite(time)) this.video.currentTime = time;
    if (!this.userPaused) this.video.play().catch(() => {});
    this.alt?.pause();
  }

  #beginReverse() {
    if (this.direction < 0) return;
    if (this.ring.length < 2) {
      this.#goForward(this.#bounds().inn);
      return;
    }
    this.direction = -1;
    this.loopMix = 0;
    this.video.pause();
    this.alt?.pause();
    this.revTarget = this.ring.startReverse();
  }

  #tickBounceEdge() {
    if (this.playMode !== 'bounce' || this.direction < 0) return;
    const { inn, out } = this.#bounds();
    if (out && (this.video.ended || this.video.currentTime >= out - 1 / 90)) this.#beginReverse();
  }

  #tickLoopXfade() {
    if (!this.loopXfadeOn || this.playMode !== 'loop') {
      this.loopMix = 0;
      return;
    }
    const { inn, out } = this.#bounds();
    const span = Math.max(0, out - inn);
    const fade = Math.min(this.loopXfadeDur, span * 0.45);
    if (!(fade > 0.05) || !span) {
      this.loopMix = 0;
      return;
    }
    this.#prepareAlt();
    const remain = out - this.video.currentTime;
    if (remain > fade) {
      this.loopMix = 0;
      if (this.alt && !this.alt.paused) {
        this.alt.pause();
        this.alt.currentTime = inn;
      }
      return;
    }
    if (this.alt?.paused) {
      this.alt.currentTime = inn;
      this.alt.play().catch(() => {});
    }
    this.loopMix = 1 - remain / fade;
    if (remain <= 0 || this.video.ended) this.#finishLoopXfade();
  }

  #finishLoopXfade() {
    if (this.direction < 0) return;
    if (this.loopMix < 0.05 && this.video && !this.video.ended) return;
    if (!this.alt) {
      this.#goForward(this.#bounds().inn);
      return;
    }
    const old = this.video;
    const oldTex = this.texture;
    this.video = this.alt;
    this.texture = this.altTex;
    this.alt = old;
    this.altTex = oldTex;
    this.loopMix = 0;
    this.#applyLoopFlag(this.video);
    this.#bindEnded(this.video);
    if (!this.userPaused) this.video.play().catch(() => {});
    old.onended = null;
    old.pause();
    old.currentTime = this.#bounds().inn;
  }

  #bindEnded(video) {
    video.onended = () => {
      if (this.video !== video || this.userPaused) return;
      if (this.playMode === 'bounce') this.#beginReverse();
      else if (this.playMode === 'loop' && this.loopXfadeOn) this.#finishLoopXfade();
    };
  }

  #ensureMixRt() {
    const w = Math.max(2, this.width);
    const h = Math.max(2, this.height);
    if (!this.mixRt) {
      this.mixRt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
      return;
    }
    if (this.mixRt.width !== w || this.mixRt.height !== h) this.mixRt.setSize(w, h);
  }

  #pullPicture(renderer) {
    const key = this.pictureKey;
    if (!key || this.pictureBusy) return;
    const now = performance.now();
    if (now - this.pictureLast < 1000 / 60) return;
    this.pictureLast = now;
    this.pictureBusy = true;
    const token = this.pictureToken;
    const seen = this.pictureSeen;
    pullPicture(key, seen).then((frame) => {
      if (token !== this.pictureToken || this.pictureKey !== key || this.kind !== 'picture') return;
      this.pictureSeen = frame.seen;
      const name = key.slice(key.indexOf(':') + 1);
      if (frame.fault) {
        this.pictureNote = frame.fault;
        this.pictureError = true;
        return;
      }
      if (frame.gone) {
        this.pictureError = false;
        if (this.width > 2) this.pictureNote = `gone: ${name}`;
        return;
      }
      if (frame.same || !frame.pixels) return;
      this.pictureError = false;
      this.#presentPicture(renderer, frame.pixels, frame.width, frame.height);
      this.pictureNote = `picture ${frame.width}x${frame.height}`;
    }).catch((err) => {
      if (token !== this.pictureToken || this.kind !== 'picture') return;
      this.pictureNote = String(err?.message || err || 'The picture source did not open.');
      this.pictureError = true;
    }).finally(() => {
      if (token === this.pictureToken) this.pictureBusy = false;
    });
  }

  #presentPicture(renderer, pixels, w, h) {
    let tex = this.texture;
    const same = tex?.isDataTexture && tex.image?.width === w && tex.image?.height === h;
    if (!same || !renderer) {
      if (tex && tex !== blackPixel && tex !== this.slot) tex.dispose();
      const data = new Uint8Array(pixels.length);
      data.set(pixels);
      tex = new THREE.DataTexture(data, w, h);
      tex.flipY = true;
      tex.colorSpace = pictureColorSpace();
      tex.generateMipmaps = false;
      this.#configure(tex);
      tex.needsUpdate = true;
      this.texture = tex;
      this.displayTexture = tex;
      this.width = w;
      this.height = h;
      return;
    }
    const glTex = renderer.properties?.get(tex)?.__webglTexture;
    if (!glTex) {
      if (tex.image?.data?.set) tex.image.data.set(pixels);
      tex.needsUpdate = true;
      this.displayTexture = tex;
      return;
    }
    const gl = renderer.getContext();
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    const align = gl.getParameter(gl.UNPACK_ALIGNMENT);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, align);
    gl.bindTexture(gl.TEXTURE_2D, prev);
    this.displayTexture = tex;
    this.width = w;
    this.height = h;
  }

  #present(renderer) {
    const prev = renderer?.getRenderTarget() ?? null;
    if (this.direction < 0 && this.revTarget) {
      this.displayTexture = this.revTarget.texture;
      if (renderer) renderer.setRenderTarget(prev);
      return;
    }
    if (this.loopMix > 0.001 && this.altTex && renderer) {
      this.#ensureMixRt();
      const u = this.mixQuad.material.uniforms;
      u.uA.value = this.texture;
      u.uB.value = this.altTex;
      u.uMix.value = this.loopMix;
      renderer.setRenderTarget(this.mixRt);
      renderer.render(this.mixScene, this.mixCam);
      renderer.setRenderTarget(prev);
      this.displayTexture = this.mixRt.texture;
      return;
    }
    if (renderer) renderer.setRenderTarget(prev);
    this.displayTexture = this.texture;
  }
}
