import * as THREE from 'three';

import vertexShader from '../shaders/fullscreen.vert?raw';
import commonGlsl from '../shaders/common.glsl?raw';
import glitchFrag from '../shaders/glitch.frag?raw';
import ditherFrag from '../shaders/dither.frag?raw';
import y2kFrag from '../shaders/y2k.frag?raw';
import metalFrag from '../shaders/metal.frag?raw';
import vhsFrag from '../shaders/vhs.frag?raw';
import retroFrag from '../shaders/retro.frag?raw';
import cleanFrag from '../shaders/clean.frag?raw';
import win98Frag from '../shaders/win98.frag?raw';
import ps1Frag from '../shaders/ps1.frag?raw';
import asciiFrag from '../shaders/ascii.frag?raw';
import eaterFrag from '../shaders/eater.frag?raw';
import minidvFrag from '../shaders/minidv.frag?raw';
import flashFrag from '../shaders/flash.frag?raw';
import starfieldFrag from '../shaders/starfield.frag?raw';
import hydraFrag from '../shaders/hydra.frag?raw';
import copyFrag from '../shaders/copy.frag?raw';
import transformFrag from '../shaders/transform.frag?raw';
import depthVert from '../shaders/depth.vert?raw';
import pointsFrag from '../shaders/points.frag?raw';
import meshFrag from '../shaders/mesh.frag?raw';

import { InputManager, PLAY_MODES } from '../input/InputManager.js';
import { ParticleFlow, PARTICLE_SOURCE } from '../engines/ParticleFlow.js';
import { hydraDrive } from '../engines/drive.js';
import { ENGINE_FX, ENGINE_HYDRA, ENGINE_PARTICLES, ENGINES } from '../engines/constants.js';
import { GRID_SIZES, LAYER_DEFS, MODE_3D, MODES, layerParam, uniformName } from '../params.js';

/** Color runs before post. A mode occupies one stage; the other stage copies the picture through. */
const COLOR_MODES = new Set(['dither', 'y2k', 'win98', 'ascii', 'metal']);
const POST_MODES = new Set(['glitch', 'vhs', 'ps1', 'retro', 'eater', 'minidv', 'flash', 'starfield']);

const FX_SOURCES = {
  glitch: glitchFrag,
  dither: ditherFrag,
  y2k: y2kFrag,
  metal: metalFrag,
  vhs: vhsFrag,
  retro: retroFrag,
  clean: cleanFrag,
  win98: win98Frag,
  ps1: ps1Frag,
  ascii: asciiFrag,
  eater: eaterFrag,
  minidv: minidvFrag,
  flash: flashFrag,
  starfield: starfieldFrag,
};

export const SHADER_SOURCES = {
  ...FX_SOURCES,
  points: `${depthVert}\n${pointsFrag}`,
  mesh: `${depthVert}\n${meshFrag}`,
};

export function activeShaderSource(layer) {
  if (layer.engine === ENGINE_HYDRA) return `${commonGlsl}\n${hydraFrag}`;
  if (layer.engine === ENGINE_PARTICLES) return PARTICLE_SOURCE;
  return SHADER_SOURCES[layer.mode];
}

/** The file the code overlay shows: the layer's own shader, without the shared prelude. */
export function overlayShaderSource(layer) {
  const id = String(layer.id).toLowerCase();
  if (layer.engine === ENGINE_HYDRA) return { name: `layer_${id}_hydra.frag`, source: hydraFrag };
  if (layer.engine === ENGINE_PARTICLES) return { name: `layer_${id}_particles.glsl`, source: PARTICLE_SOURCE };
  return { name: `layer_${id}_${layer.mode}.frag`, source: SHADER_SOURCES[layer.mode] };
}

// The depth vertex shader samples uTex even with no media, so it needs a real texture.
export const blankTexture = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
})();

// Fullscreen passes only sample color. Depth stays on the ping-pong pair,
// which is the target 3D modes actually draw into.
const COLOR_RT = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
  type: THREE.HalfFloatType,
};
const RT_OPTIONS = {
  ...COLOR_RT,
  depthBuffer: true,
};

function makePointGrid(n) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  let i = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1);
      const v = y / (n - 1);
      positions[i * 3] = u * 2 - 1;
      positions[i * 3 + 1] = v * 2 - 1;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
      i++;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geo;
}

const makePlane = (n) => new THREE.PlaneGeometry(2, 2, n - 1, n - 1);

/**
 * One visual layer: its own media input, shader mode, parameters (read from the shared
 * ParamStore under "<id>.<key>"), feedback buffers, and 3D objects.
 */
export class Layer {
  constructor(id, params, shared) {
    this.id = id;
    this.params = params;
    this.input = new InputManager();
    this.mediaKey = 'none';
    this.mediaLabel = 'Test pattern';
    this.mediaStatus = '';
    this.mediaError = false;
    this.missing = null;
    this.mirror = false;
    this.mediaQueue = Promise.resolve();
    this.entryT = 1;
    this.entrying = false;
    this.liveOverride = new Map();

    this.uniforms = {
      uTex: { value: blankTexture },
      uPrev: { value: null },
      uResolution: shared.uResolution,
      uTime: shared.uTime,
      uTexRes: { value: new THREE.Vector2(1, 1) },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uFit: { value: 0 },
      uHasInput: { value: 0 },
      uMirror: { value: 0 },
      uEntry: { value: 1 },
      uEntryStyle: { value: 0 },
      uHydraRot: { value: 0 },
      uHydraScale: { value: 1 },
      uHydraBleed: { value: 0.8 },
      uHydraWarp: { value: 0 },
      uHydraHue: { value: 0 },
      uLayerBlend: { value: 0 },
      uBass: { value: 0 },
      uSubBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uHigh: { value: 0 },
      uLevel: { value: 0 },
      uKick: { value: 0 },
      uPunch: { value: 0 },
      uMids: { value: 0 },
      uBeatPulse: { value: 0 },
      uPeakFlash: { value: 0 },
      uSongEnergy: { value: 0 },
      uIsBreakdown: { value: 0 },
      uDropPulse: { value: 0 },
      uBeat: shared.uBeat,
      uBeatPhase: shared.uBeatPhase,
      uTransient: { value: 0 },
      uIsPoint: { value: 0 },
      uAspect: { value: 1 },
    };
    for (const d of LAYER_DEFS) {
      const def = params.defs.get(layerParam(id, d.id));
      if (def.uniform) this.uniforms[uniformName(d.id)] = { value: params.get(def.id) };
    }

    this.fxMaterials = {};
    this.rtRead = new THREE.WebGLRenderTarget(1, 1, RT_OPTIONS);
    this.rtWrite = new THREE.WebGLRenderTarget(1, 1, RT_OPTIONS);
    this.sourceRt = new THREE.WebGLRenderTarget(1, 1, COLOR_RT);
    this.xformRt = new THREE.WebGLRenderTarget(1, 1, COLOR_RT);
    this.colorRt = new THREE.WebGLRenderTarget(1, 1, COLOR_RT);
    this.hydraRt = new THREE.WebGLRenderTarget(1, 1, COLOR_RT);
    this.bakedTransform = false;
    this.sigEngine = null;
    this.sigMedia = null;
    this.sigSource = null;

    this.scene3d = new THREE.Scene();
    this.points = new THREE.Points(
      makePointGrid(GRID_SIZES[this.get('cloudGrid')]),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: depthVert, fragmentShader: pointsFrag }),
    );
    this.mesh = new THREE.Mesh(
      makePlane(GRID_SIZES[this.get('meshGrid')]),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: depthVert,
        fragmentShader: meshFrag,
        side: THREE.DoubleSide,
      }),
    );
    this.points.frustumCulled = this.mesh.frustumCulled = false;
    const pointFov = 42 * Math.PI / 180;
    const pointRest = Math.hypot(0.35, 0.95, 2.05);
    this.cloudSpan = Math.tan(pointFov / 2) * pointRest;
    this.scene3d.add(this.points, this.mesh);
    this.particles = new ParticleFlow(this.get('pCount'));
    this.engineMode = this.engine;
    this.engineReset = false;
    this.particleSampling = false;
    this.particleSource = 0;
    this.#syncMode();
    this.#applyTransport();
  }

  setEngine(mode) {
    if (this.engineMode === mode) return;
    this.engineMode = mode;
    this.engineReset = true;
    if (mode === ENGINE_PARTICLES) this.particles.needsSeed = true;
  }

  get(key) {
    if (this.liveOverride.has(key)) return this.liveOverride.get(key);
    return this.params.get(layerParam(this.id, key));
  }

  get engine() {
    return ENGINES[this.get('engine')] || ENGINE_FX;
  }

  get mode() {
    return MODES[this.get('mode')];
  }

  get is3D() {
    return MODE_3D.has(this.mode);
  }

  get active() {
    return this.get('opacity') > 0.001;
  }

  /** The most recently rendered frame of this layer. */
  get texture() {
    return this.rtRead.texture;
  }

  /** Called by main for every ParamStore change belonging to this layer. */
  onParam(key, v) {
    const u = this.uniforms[uniformName(key)];
    if (u && key !== 'mode') u.value = v;
    if (key === 'mode') this.#syncMode();
    if (key === 'engine') this.setEngine(ENGINES[v] || ENGINE_FX);
    if (key === 'pCount') this.particles.setCount(v);
    if (key === 'pSource') this.particles.needsSeed = true;
    if (key === 'playMode' || key === 'loopXfade' || key === 'loopXfadeDur') this.#applyTransport();
    if (key === 'cloudGrid') {
      this.points.geometry.dispose();
      this.points.geometry = makePointGrid(GRID_SIZES[v]);
    }
    if (key === 'meshGrid') {
      this.mesh.geometry.dispose();
      this.mesh.geometry = makePlane(GRID_SIZES[v]);
    }
  }

  /** Write a live value (LFO) onto the uniform without touching the ParamStore. */
  setUniform(key, v) {
    const u = this.uniforms[uniformName(key)];
    if (u) u.value = v;
  }

  #syncMode() {
    this.points.visible = this.mode === 'points';
    this.mesh.visible = this.mode === 'mesh';
    this.uniforms.uIsPoint.value = this.mode === 'points' ? 1 : 0;
  }

  #fxMaterial(mode) {
    this.fxMaterials[mode] ??= new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader: `${commonGlsl}\n${FX_SOURCES[mode]}`,
      depthTest: false,
      depthWrite: false,
    });
    return this.fxMaterials[mode];
  }

  #hydraMaterial() {
    this.hydraMaterial ??= new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader: `${commonGlsl}\n${hydraFrag}`,
      depthTest: false,
      depthWrite: false,
    });
    return this.hydraMaterial;
  }

  #clearTargets(renderer) {
    const prev = renderer.getRenderTarget();
    renderer.setClearColor(0x000000, 0);
    for (const rt of [this.rtRead, this.rtWrite, this.sourceRt, this.xformRt, this.colorRt, this.hydraRt]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
    }
    renderer.setRenderTarget(prev);
  }

  /** Drop leftover feedback so a new project does not show the previous picture. */
  clearBuffers(renderer) {
    if (renderer) this.#clearTargets(renderer);
  }

  #swap() {
    [this.rtRead, this.rtWrite] = [this.rtWrite, this.rtRead];
  }

  /**
   * Bands not bound to this layer read as silence. uKick is the audio kick, raised to the
   * tempo pulse by Beat Sync so effects can lock to BPM even without audio.
   */
  applyAudio(a) {
    const n = (v) => Math.min(1, Math.max(0, v || 0));
    const bind = this.get('audioBind');
    const all = bind === 0;
    const u = this.uniforms;
    u.uBass.value = n(all || bind === 1 ? a.bass : 0);
    u.uSubBass.value = n(all || bind === 1 ? a.sub : 0);
    u.uPunch.value = n(all || bind === 1 ? a.punch : 0);
    u.uMid.value = n(all || bind === 2 ? a.mid : 0);
    u.uMids.value = u.uMid.value;
    u.uTreble.value = n(all || bind === 3 ? a.treble : 0);
    u.uHigh.value = u.uTreble.value;
    u.uKick.value = n(Math.max(all || bind === 1 ? a.kick : 0, u.uBeat.value * this.get('beatSync')));
    u.uBeatPulse.value = n(a.beatPulse);
    u.uPeakFlash.value = n(a.peakFlash);
    u.uSongEnergy.value = n(a.songEnergy);
    u.uIsBreakdown.value = n(a.isBreakdown);
    u.uDropPulse.value = n(a.dropPulse);
    u.uTransient.value = n(all || bind === 3 ? (a.snare || a.transient) : 0);
    u.uLevel.value = n(all ? a.level : [0, a.bass, a.mid, a.treble, 0][bind]);
  }

  setSize(w, h) {
    if (this.rtRead.width === w && this.rtRead.height === h) return;
    this.rtRead.setSize(w, h);
    this.rtWrite.setSize(w, h);
    this.sourceRt.setSize(w, h);
    this.xformRt.setSize(w, h);
    this.colorRt.setSize(w, h);
    this.hydraRt.setSize(w, h);
  }

  /** Fill keeps the UV factor <= 1 (crop); fit keeps it >= 1 (letterbox). */
  updateUvScale(fitMode) {
    const out = this.uniforms.uResolution.value;
    const tex = this.uniforms.uTexRes.value;
    const sa = out.x / Math.max(out.y, 1);
    const ta = Math.max(tex.x, 1) / Math.max(tex.y, 1);
    const pick = fitMode === 'fill' ? Math.min : Math.max;
    this.uniforms.uUvScale.value.set(pick(1, sa / ta), pick(1, ta / sa));
    this.uniforms.uFit.value = fitMode === 'fit' ? 1 : 0;

    const aspect = this.uniforms.uHasInput.value > 0.5 ? ta : 1;
    const sx = aspect >= 1 ? 1 : aspect;
    const sy = aspect >= 1 ? 1 / aspect : 1;
    this.mesh.scale.set(sx, sy, 1);

    const canvasAspect = out.x / Math.max(out.y, 1);
    this.uniforms.uAspect.value = canvasAspect;
    const span = this.cloudSpan;
    this.points.scale.set(span * canvasAspect, span, 1);
  }

  setMirror(on) {
    this.mirror = on;
    this.uniforms.uMirror.value = on ? 1 : 0;
  }

  /**
   * key: 'none' | 'cam:<deviceId>' | 'file:<name>' | 'ndi:<name>' | 'spout:<name>'. Calls are queued so a fast sequence of
   * scene changes never leaves an orphaned camera stream or video element behind.
   */
  setMedia(key, { library, cameraLabel, mirror, fitMode } = {}) {
    this.mediaQueue = this.mediaQueue.then(() => this.#applyMedia(key, library, cameraLabel, mirror, fitMode));
    return this.mediaQueue;
  }

  #applyTransport() {
    this.input.setPlayMode(PLAY_MODES[this.get('playMode')]);
    this.input.setLoopXfade(this.get('loopXfade') > 0.5);
    this.input.setLoopXfadeDur(this.get('loopXfadeDur'));
  }

  beginEntry() {
    if (this.input.kind !== 'image') {
      this.entryT = 1;
      this.entrying = false;
      this.#writeEntry();
      return;
    }
    if (this.get('entryStyle') < 0.5) {
      this.entryT = 1;
      this.entrying = false;
    } else {
      this.entryT = 0;
      this.entrying = true;
    }
    this.#writeEntry();
  }

  get entryAlpha() {
    if (this.input.kind !== 'image') return 1;
    const style = this.get('entryStyle');
    const e = this.entryT;
    if (style < 0.5) return 1;
    if (style < 1.5) return e;
    if (style < 2.5) return e * e * (3 - 2 * e);
    return Math.min(1, e / 0.15);
  }

  get entryZoom() {
    if (this.input.kind !== 'image') return 1;
    const style = this.get('entryStyle');
    const e = this.entryT;
    const settle = e * e * (3 - 2 * e);
    if (style > 1.5 && style < 2.5) return 1 + (1 - settle) * 0.35;
    if (style > 2.5) return 1 + (1 - settle) * 0.08;
    return 1;
  }

  #writeEntry() {
    this.uniforms.uEntry.value = this.input.kind === 'image' ? this.entryT : 1;
    this.uniforms.uEntryStyle.value = this.input.kind === 'image' ? this.get('entryStyle') : 0;
  }

  #tickEntry(dt) {
    if (this.entrying) {
      const dur = Math.max(0.1, this.get('entryDur'));
      this.entryT = Math.min(1, this.entryT + dt / dur);
      if (this.entryT >= 1) this.entrying = false;
    }
    this.#writeEntry();
  }

  /** Capture bounce frames / loop mix, then rebind the texture the shaders actually see. */
  tickMedia(dt, renderer, fitMode) {
    this.input.update(dt, renderer);
    if (this.input.kind === 'picture' && this.input.pictureNote && this.input.pictureNote !== this.mediaStatus) {
      this.mediaStatus = this.input.pictureNote;
      this.mediaError = !!this.input.pictureError;
    }
    this.#tickEntry(dt);
    this.#bindTexture(fitMode);
  }

  #bindTexture(fitMode) {
    const tex = this.input.displayTexture || this.input.texture;
    this.uniforms.uTex.value = tex || blankTexture;
    this.uniforms.uHasInput.value = tex ? 1 : 0;
    this.uniforms.uTexRes.value.set(this.input.width, this.input.height);
    this.updateUvScale(fitMode ?? (this.uniforms.uFit.value > 0.5 ? 'fit' : 'fill'));
  }

  async #applyMedia(key, library, cameraLabel, mirror, fitMode) {
    // Same clip already up: don't tear down the decoder (that would flash).
    if (key === this.mediaKey && !this.missing && key !== 'none') {
      if (mirror != null) this.setMirror(mirror);
      this.mediaError = false;
      if (this.input.kind === 'image') this.beginEntry();
      return;
    }

    const incoming = new InputManager();
    incoming.setPlayMode(PLAY_MODES[this.get('playMode')]);
    incoming.setLoopXfade(this.get('loopXfade') > 0.5);
    incoming.setLoopXfadeDur(this.get('loopXfadeDur'));
    this.mediaKey = key;
    this.missing = null;
    this.mediaError = false;

    const swapIn = () => {
      const old = this.input;
      // Release the outgoing decoder before the new texture is bound, so the
      // GPU drops that stream as the layer takes the incoming one.
      old.dispose();
      this.input = incoming;
      this.#bindTexture(fitMode);
    };

    const showPattern = () => {
      incoming.dispose();
      this.input.dispose();
      this.input = new InputManager();
      this.#applyTransport();
      this.mediaKey = 'none';
      this.mediaLabel = 'Test pattern';
      this.mediaStatus = '';
      this.mediaError = false;
      this.entryT = 1;
      this.entrying = false;
      this.#writeEntry();
      this.#bindTexture(fitMode);
    };

    try {
      if (key === 'none') {
        showPattern();
        return;
      }
      if (key.startsWith('cam:')) {
        this.mediaStatus = 'starting camera...';
        await incoming.useCamera(key.slice(4));
        this.mediaLabel = cameraLabel || 'Camera';
        this.mediaStatus = `camera ${incoming.width}x${incoming.height}`;
        swapIn();
        this.setMirror(mirror ?? true);
        this.entryT = 1;
        this.entrying = false;
        this.#writeEntry();
        return;
      }
      if (key.startsWith('ndi:') || key.startsWith('spout:')) {
        const name = key.slice(key.indexOf(':') + 1);
        this.mediaLabel = name;
        this.mediaStatus = 'waiting for picture...';
        await incoming.usePicture(key);
        if (incoming.pictureNote) this.mediaStatus = incoming.pictureNote;
        this.mediaError = !!incoming.pictureError;
        swapIn();
        this.setMirror(mirror ?? false);
        this.entryT = 1;
        this.entrying = false;
        this.#writeEntry();
        return;
      }
      if (key.startsWith('file:')) {
        const name = key.slice(5);
        const file = library?.get(name);
        this.mediaLabel = name;
        if (!file) {
          incoming.dispose();
          this.missing = name;
          this.mediaError = true;
          this.mediaStatus = `missing: send "${name}" from Media Manager`;
          return;
        }
        this.mediaStatus = 'loading...';
        await incoming.useFile(file);
        if (incoming.kind !== 'video' && incoming.kind !== 'image') {
          showPattern();
          return;
        }
        this.mediaStatus = `${incoming.kind} ${incoming.width}x${incoming.height}`;
        swapIn();
        this.setMirror(mirror ?? false);
        if (incoming.kind === 'image') this.beginEntry();
        else {
          this.entryT = 1;
          this.entrying = false;
          this.#writeEntry();
        }
        return;
      }
      if (key.startsWith('url:')) {
        const name = key.slice(4);
        const item = library?.mediaItem(name);
        this.mediaLabel = name;
        if (!item?.url) {
          incoming.dispose();
          this.missing = name;
          this.mediaError = true;
          this.mediaStatus = `missing: send "${name}" from Media Manager`;
          return;
        }
        this.mediaStatus = 'loading...';
        incoming.onBrokenKey = (src) => {
          this.mediaKey = 'none';
          this.mediaError = false;
          this.mediaStatus = '';
          if (!library || !src) return;
          const current = library.mediaItem(name);
          if (!current) return;
          const rest = [current.url, ...(current.alts || [])].filter((url) => url && url !== src);
          if (!rest.length) return;
          library.addRemote({
            name,
            url: rest[0],
            thumbnail: current.thumbnail,
            alts: rest.slice(1),
          });
        };
        incoming.onExhausted = () => {
          if (this.input !== incoming) return;
          library?.remove(name);
          showPattern();
          window.dispatchEvent(new CustomEvent('vj-media-fallback'));
        };
        const played = await incoming.useUrl(item.url, item.alts || []);
        if (!played || incoming.kind !== 'video') {
          library?.remove(name);
          showPattern();
          return;
        }
        this.mediaKey = key;
        if (library) {
          const rejected = new Set(incoming.rejected || []);
          const saved = library.mediaItem(name);
          const pool = [item.url, ...(item.alts || []), saved?.url, ...(saved?.alts || [])];
          const alts = [...new Set(pool)].filter((url) => url && url !== incoming.playedUrl && !rejected.has(url));
          library.addRemote({
            name,
            url: incoming.playedUrl || item.url,
            thumbnail: saved?.thumbnail || item.thumbnail,
            alts,
          });
        }
        this.mediaStatus = `${incoming.kind} ${incoming.width}x${incoming.height}`;
        swapIn();
        this.setMirror(mirror ?? false);
        this.entryT = 1;
        this.entrying = false;
        this.#writeEntry();
      }
    } catch (err) {
      incoming.dispose();
      this.mediaError = true;
      this.mediaStatus = err.message;
    }
  }

  /**
   * Picture this swarm samples.
   * 0 current video, 1 layer A buffer, 2 layer B buffer, 3 procedural grid.
   * A layer sampling its own buffer reads the previous frame, never the target
   * it is about to draw into.
   */
  #particleSample(layers) {
    const src = this.get('pSource') | 0;
    const colorMode = this.get('pColor') | 0;
    this.particleSource = src;
    if (src === 3) {
      this.particleSampling = false;
      return { tex: blankTexture, hasInput: 0, fitted: false, colorMode };
    }
    if (src === 1 || src === 2) {
      const target = layers[src === 1 ? 'A' : 'B'];
      this.particleSampling = true;
      return { tex: target.texture, hasInput: 1, fitted: false, colorMode };
    }
    const own = this.uniforms.uHasInput.value > 0.5;
    this.particleSampling = own;
    return {
      tex: this.uniforms.uTex.value,
      hasInput: own ? 1 : 0,
      fitted: true,
      colorMode,
    };
  }

  #copyMaterial() {
    this.copyUniforms ??= { uTex: { value: null } };
    this.copyMaterial ??= new THREE.ShaderMaterial({
      uniforms: this.copyUniforms,
      vertexShader,
      fragmentShader: copyFrag,
      depthTest: false,
      depthWrite: false,
    });
    return this.copyMaterial;
  }

  #xformMaterial() {
    this.xformUniforms ??= {
      uTex: { value: null },
      uXform: { value: new THREE.Vector3(1, 0, 0) },
      uMask: { value: new THREE.Vector3(1, 1, 0) },
      uOpaqueBase: { value: 0 },
    };
    this.xformMaterial ??= new THREE.ShaderMaterial({
      uniforms: this.xformUniforms,
      vertexShader,
      fragmentShader: transformFrag,
      depthTest: false,
      depthWrite: false,
    });
    return this.xformMaterial;
  }

  #blit(renderer, ctx, tex, target) {
    const mat = this.#copyMaterial();
    this.copyUniforms.uTex.value = tex;
    renderer.setRenderTarget(target);
    ctx.quad.material = mat;
    renderer.render(ctx.quadScene, ctx.camera2d);
  }

  /** Scale and position a finished source before color / post sample it. */
  #transform(renderer, ctx, tex, target, place) {
    const mat = this.#xformMaterial();
    const u = this.xformUniforms;
    u.uTex.value = tex;
    u.uXform.value.set(place.scale, place.x, place.y);
    u.uMask.value.set(place.maskX, place.maskY, place.maskOn ? 1 : 0);
    u.uOpaqueBase.value = this.opaqueBase ? 1 : 0;
    renderer.setRenderTarget(target);
    ctx.quad.material = mat;
    renderer.render(ctx.quadScene, ctx.camera2d);
  }

  /** Point src() at an already-fitted frame so a later stage does not reapply fit, mirror, or entry. */
  #pushSampling(sourceTex, prevTex) {
    const u = this.uniforms;
    const saved = {
      tex: u.uTex.value,
      prev: u.uPrev.value,
      fit: u.uFit.value,
      mirror: u.uMirror.value,
      entry: u.uEntry.value,
      entryStyle: u.uEntryStyle.value,
      has: u.uHasInput.value,
      uvx: u.uUvScale.value.x,
      uvy: u.uUvScale.value.y,
    };
    u.uTex.value = sourceTex;
    u.uPrev.value = prevTex;
    u.uUvScale.value.set(1, 1);
    u.uFit.value = 0;
    u.uMirror.value = 0;
    u.uEntry.value = 1;
    u.uEntryStyle.value = 0;
    u.uHasInput.value = 1;
    return saved;
  }

  #popSampling(saved) {
    const u = this.uniforms;
    u.uTex.value = saved.tex;
    u.uPrev.value = saved.prev;
    u.uUvScale.value.set(saved.uvx, saved.uvy);
    u.uFit.value = saved.fit;
    u.uMirror.value = saved.mirror;
    u.uEntry.value = saved.entry;
    u.uEntryStyle.value = saved.entryStyle;
    u.uHasInput.value = saved.has;
  }

  #drawFx(renderer, ctx, mode, sourceTex, target) {
    const saved = this.#pushSampling(sourceTex, this.rtRead.texture);
    renderer.setRenderTarget(target);
    ctx.quad.material = this.#fxMaterial(mode);
    renderer.render(ctx.quadScene, ctx.camera2d);
    this.#popSampling(saved);
  }

  /**
   * Source, then transform, then color, then post, then the caller composites
   * opacity and blend. A color mode (Y2K, dither, Windows 98, ASCII) owns the
   * color stage. Metal is a color stage too. A post mode (glitch, VHS, CRT, retro) owns the post stage.
   * The other stage copies the picture through, so the two looks never write
   * the same buffer. 3D modes stay in camera space. Switching engine, media,
   * or the particle source clears feedback and reseeds the swarm.
   */
  render(renderer, ctx, dt = 1 / 60, layers = null, place = null) {
    const engine = this.engineMode;
    const media = this.mediaKey;
    const source = this.get('pSource');
    if (engine !== this.sigEngine || media !== this.sigMedia || source !== this.sigSource) {
      this.sigEngine = engine;
      this.sigMedia = media;
      this.sigSource = source;
      this.engineReset = true;
      this.particles.needsSeed = true;
    }
    if (this.engineReset) {
      this.#clearTargets(renderer);
      this.engineReset = false;
    }

    const clearAlpha = this.opaqueBase ? 1 : 0;
    if (this.is3D) {
      renderer.setRenderTarget(this.rtWrite);
      renderer.setClearColor(0x000000, clearAlpha);
      renderer.clear(true, true, false);
      renderer.render(this.scene3d, ctx.camera3);
      this.#swap();
      this.bakedTransform = false;
      return;
    }

    renderer.setRenderTarget(this.sourceRt);
    if (engine === ENGINE_PARTICLES) {
      renderer.setClearColor(0x000000, clearAlpha);
      renderer.clear(true, true, false);
      this.particles.render(renderer, this.uniforms, dt, this.#particleSample(layers));
    } else if (engine === ENGINE_HYDRA) {
      const d = hydraDrive(this.uniforms, dt, this.get('blend'));
      this.uniforms.uHydraRot.value = d.uHydraRot;
      this.uniforms.uHydraScale.value = d.uHydraScale;
      this.uniforms.uHydraBleed.value = d.uHydraBleed;
      this.uniforms.uHydraWarp.value = d.uHydraWarp;
      this.uniforms.uHydraHue.value = d.uHydraHue;
      this.uniforms.uLayerBlend.value = d.uLayerBlend;
      this.uniforms.uPrev.value = this.hydraRt.texture;
      ctx.quad.material = this.#hydraMaterial();
      renderer.render(ctx.quadScene, ctx.camera2d);
      this.#blit(renderer, ctx, this.sourceRt.texture, this.hydraRt);
    } else {
      ctx.quad.material = this.#fxMaterial('clean');
      renderer.render(ctx.quadScene, ctx.camera2d);
    }

    if (!place) {
      this.#blit(renderer, ctx, this.sourceRt.texture, this.rtWrite);
      this.#swap();
      this.bakedTransform = false;
      return;
    }

    this.#transform(renderer, ctx, this.sourceRt.texture, this.xformRt, place);

    if (engine === ENGINE_FX) {
      const mode = this.mode;
      let colorTex = this.xformRt.texture;
      if (COLOR_MODES.has(mode)) {
        this.#drawFx(renderer, ctx, mode, this.xformRt.texture, this.colorRt);
        colorTex = this.colorRt.texture;
      }
      if (POST_MODES.has(mode)) this.#drawFx(renderer, ctx, mode, colorTex, this.rtWrite);
      else this.#blit(renderer, ctx, colorTex, this.rtWrite);
    } else {
      this.#blit(renderer, ctx, this.xformRt.texture, this.rtWrite);
    }
    this.#swap();
    this.bakedTransform = true;
  }

  /** Numbers the HUD can show for this layer. */
  liveUniforms() {
    const out = {};
    for (const [k, u] of Object.entries(this.uniforms)) if (typeof u.value === 'number') out[k] = u.value;
    return out;
  }
}
