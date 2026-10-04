import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';

import vertexShader from './shaders/fullscreen.vert?raw';
import outputFrag from './shaders/output.frag?raw';
import composeFrag from './shaders/compose.frag?raw';
import warpFrag from './shaders/warp.frag?raw';
import copyFrag from './shaders/copy.frag?raw';
import xfadeFrag from './shaders/xfade.frag?raw';
import stingFrag from './shaders/sting.frag?raw';

import { LAYERS, LAYER_DEFS, MODES, MODE_LABELS, ParamStore, layerParam, neutralOf } from './params.js';
import { ENGINE_FX, ENGINE_PARTICLES } from './engines/constants.js';
import { liveFormulaModel, liveStackModel } from './ui/liveCode.js';
import { ScanLog } from './ui/ScanLog.js';
import { Layer, activeShaderSource, overlayShaderSource, blankTexture } from './layers/Layer.js';
import { MediaLibrary } from './media/MediaLibrary.js';
import { fetchVideoLoop } from './media/onlineFetch.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { ModMatrix, createModRow } from './audio/ModMatrix.js';
import { BeatClock } from './clock/BeatClock.js';
import { BpmEngine } from './clock/BpmEngine.js';
import { LayerBus } from './mixer/LayerBus.js';
import { LfoEngine } from './lfo/LfoEngine.js';
import { MidiManager } from './midi/MidiManager.js';
import { MacroRouter, sliderOptions } from './midi/Macros.js';
import { MOMENTARY, MomentaryPads } from './midi/Momentary.js';
import { Recorder } from './output/Recorder.js';
import { OutputWindow, listScreens, POPUP_BLOCKED, isTauri } from './output/OutputWindow.js';
import { bindRangeReadout } from './ui/NumericSlider.js';
import { beginDrag, endDrag } from './ui/dragPayload.js';
import { dpiState, formatFactor, pixelsOf, setDpiAuto, setOutputPixels, setPreviewScale } from './ui/dpiScale.js';
import { OutputMap } from './output/OutputMap.js';
import { SceneManager } from './scenes/SceneManager.js';
import { Timeline } from './scenes/Timeline.js';
import { ProjectState, coerceDocument } from './project/ProjectState.js';
import { Hud, HUD_PRESETS, HUD_BOX_DEFAULT, clampHudBox } from './ui/Hud.js';
import { Panel } from './ui/Panel.js';
import { Diagnostics, flashControl } from './ui/Diagnostics.js';
import { SceneBar } from './ui/SceneBar.js';
import { StingRack } from './overlay/StingRack.js';
import { ApcView } from './ui/ApcView.js';
import { ApcLeds, ledMap, nextHudSize } from './midi/ApcMiniMk2.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- renderer
// Ask for WebGL2 on the discrete GPU before Three.js creates its own context.
// Three's default context turns alpha on, which can land on the integrated chip.
const glCanvas = document.createElement('canvas');
$('preview-wrap').insertBefore(glCanvas, $('hud-frame'));
const glAttributes = {
  powerPreference: 'high-performance',
  antialias: false,
  alpha: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false,
};
const gl = glCanvas.getContext('webgl2', glAttributes);
const renderer = new THREE.WebGLRenderer({
  canvas: glCanvas,
  context: gl,
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
});
renderer.autoClear = false;

const quadScene = new THREE.Scene();
const camera2d = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
quadScene.add(quad);

// One orbit camera is shared by every 3D layer, so A/B/C 3D layers stay aligned.
const camera3 = new THREE.PerspectiveCamera(42, 1, 0.05, 30);
camera3.position.set(0.35, 0.95, 2.05);
const controls = new OrbitControls(camera3, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enabled = false;
controls.update();

const renderCtx = { quad, quadScene, camera2d, camera3 };

// ---------------------------------------------------------------- state
const params = new ParamStore();
const library = new MediaLibrary();
const audio = new AudioEngine();
const bus = new LayerBus(LAYERS);
const lfo = new LfoEngine();
const midi = new MidiManager(params);
const apcLeds = new ApcLeds(() => midi.outputs);
const macros = new MacroRouter(params);
const momentary = new MomentaryPads();
const recorder = new Recorder();
const outputWin = new OutputWindow(renderer.domElement);
const hud = new Hud($('hud'));

const shared = {
  uTime: { value: 0 },
  uResolution: { value: new THREE.Vector2(1, 1) },
  uBeat: { value: 0 },
  uBeatPhase: { value: 0 },
};
const layers = LAYERS.map((L) => new Layer(L, params, shared));
const layerById = Object.fromEntries(layers.map((l) => [l.id, l]));

// Upload one static texture per layer before the first clip arrives.
{
  const rt = new THREE.WebGLRenderTarget(64, 64, { depthBuffer: false, stencilBuffer: false });
  const mat = new THREE.MeshBasicMaterial({ map: null });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  for (const layer of layers) {
    if (!layer.input.slot) continue;
    mat.map = layer.input.slot;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
  }
  renderer.setRenderTarget(prev);
  mat.map = null;
  rt.dispose();
  mesh.geometry.dispose();
  mat.dispose();
}

const mods = new ModMatrix();
const panel = new Panel({
  masterEl: $('master-params'),
  mixerEl: $('mixer'),
  layerEl: $('layer-params'),
  layerEditor: $('layer-editor'),
  params,
  midi,
  bus,
  lfo,
  mods,
});

$('shuffle-layer-fx')?.addEventListener('click', () => panel.shuffleSelectedLayer());

// ---------------------------------------------------------------- compositor
const comp = {
  uLayer0: { value: blankTexture },
  uLayer1: { value: blankTexture },
  uLayer2: { value: blankTexture },
  uLayerAMix: { value: 0 },
  uLayerBMix: { value: 0 },
  uLayerCMix: { value: 0 },
  uLayerABlendMode: { value: 0 },
  uLayerBBlendMode: { value: 0 },
  uLayerCBlendMode: { value: 0 },
  uLayerAInvert: { value: 0 },
  uLayerBInvert: { value: 0 },
  uLayerCInvert: { value: 0 },
  uXform0: { value: new THREE.Vector3(1, 0, 0) },
  uXform1: { value: new THREE.Vector3(1, 0, 0) },
  uXform2: { value: new THREE.Vector3(1, 0, 0) },
  uMask0: { value: new THREE.Vector3(1, 1, 0) },
  uMask1: { value: new THREE.Vector3(1, 1, 0) },
  uMask2: { value: new THREE.Vector3(1, 1, 0) },
};
const compMaterial = new THREE.ShaderMaterial({
  uniforms: comp,
  vertexShader,
  fragmentShader: outputFrag,
  depthTest: false,
  depthWrite: false,
});

const STACK_RT = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
};
const stackRt = new THREE.WebGLRenderTarget(1, 1, STACK_RT);
const mixRt = new THREE.WebGLRenderTarget(1, 1, STACK_RT);
const holdRt = new THREE.WebGLRenderTarget(1, 1, STACK_RT);
const composeRt = new THREE.WebGLRenderTarget(1, 1, STACK_RT);
const scanRt = new THREE.WebGLRenderTarget(8, 8, STACK_RT);
const copyMaterial = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: blankTexture } },
  vertexShader,
  fragmentShader: copyFrag,
  depthTest: false,
  depthWrite: false,
});
const xfade = {
  uCurrent: { value: blankTexture },
  uHold: { value: blankTexture },
  uXfade: { value: 1 },
  uStyle: { value: 0 },
  uTime: shared.uTime,
};
const xfadeMaterial = new THREE.ShaderMaterial({
  uniforms: xfade,
  vertexShader,
  fragmentShader: xfadeFrag,
  depthTest: false,
  depthWrite: false,
});
const grade = {
  uTex: { value: blankTexture },
  uResolution: shared.uResolution,
  uMaster: { value: 1 },
  uFlash: { value: 0 },
  uInvert: { value: 0 },
  uHue: { value: 0 },
  uSat: { value: 1 },
  uContrast: { value: 1 },
  uScan: { value: 0 },
  uBleed: { value: 0 },
  uBarrel: { value: 0 },
  uStrobe: { value: 0 },
  uStrobeBlack: { value: 0 },
  uChroma: { value: 0 },
};
const gradeMaterial = new THREE.ShaderMaterial({
  uniforms: grade,
  vertexShader,
  fragmentShader: composeFrag,
  depthTest: false,
  depthWrite: false,
});
const warp = {
  uTex: { value: blankTexture },
  uBL: { value: new THREE.Vector2(0, 0) },
  uBR: { value: new THREE.Vector2(1, 0) },
  uTR: { value: new THREE.Vector2(1, 1) },
  uTL: { value: new THREE.Vector2(0, 1) },
  uMask: { value: 0 },
  uIdentity: { value: 1 },
  uAspect: { value: 1 },
  uBezel: { value: 0 },
};
const warpMaterial = new THREE.ShaderMaterial({
  uniforms: warp,
  vertexShader,
  fragmentShader: warpFrag,
  depthTest: false,
  depthWrite: false,
});
const sting = {
  uBase: { value: blankTexture },
  uSting0: { value: blankTexture },
  uSting1: { value: blankTexture },
  uSting2: { value: blankTexture },
  uMix0: { value: 0 },
  uMix1: { value: 0 },
  uMix2: { value: 0 },
  uMode0: { value: 1 },
  uMode1: { value: 1 },
  uMode2: { value: 1 },
  uPlace0: { value: new THREE.Vector3(1, 0, 0) },
  uPlace1: { value: new THREE.Vector3(1, 0, 0) },
  uPlace2: { value: new THREE.Vector3(1, 0, 0) },
  uAspect: { value: 1 },
  uVid0: { value: 1 },
  uVid1: { value: 1 },
  uVid2: { value: 1 },
};
const stingMaterial = new THREE.ShaderMaterial({
  uniforms: sting,
  vertexShader,
  fragmentShader: stingFrag,
  depthTest: false,
  depthWrite: false,
});
const stingRt = new THREE.WebGLRenderTarget(1, 1, STACK_RT);
const stings = new StingRack($('sting-rack'));
const outputMap = new OutputMap({
  stage: $('map-stage'),
  svg: $('map-svg'),
  maskSelect: $('output-mask'),
  resetBtn: $('map-reset'),
  bezelInput: $('output-bezel'),
  bezelOut: $('output-bezel-out'),
  ledNote: $('map-led-note'),
  getAspect: () => {
    const c = renderer.domElement;
    return c.width / Math.max(1, c.height);
  },
});

function snapshotHold() {
  copyMaterial.uniforms.uTex.value = stackRt.texture;
  quad.material = copyMaterial;
  renderer.setRenderTarget(holdRt);
  renderer.render(quadScene, camera2d);
}

// ---------------------------------------------------------------- params
params.onChange((id, v) => {
  const def = params.defs.get(id);
  if (def.layer) {
    layerById[def.layer].onParam(def.key, v);
    if (def.key === 'mode' || def.key === 'engine') onLayerModeChanged(def.layer);
  } else if (id === 'audioGain') {
    audio.gain = v;
    const slider = $('audio-master');
    if (slider && document.activeElement !== slider) {
      slider.value = String(v);
      $('audio-master-out').textContent = Number(v).toFixed(2);
    }
  }
});
audio.gain = params.get('audioGain');

const selectedLayer = () => layerById[panel.selected];

function syncHudShader() {
  const l = selectedLayer();
  const name = l.engine === ENGINE_FX ? l.mode : l.engine;
  hud.setShader(`layer ${l.id} \u00b7 ${name}`, activeShaderSource(l));
}

function onLayerModeChanged(L) {
  controls.enabled = layers.some((l) => l.engine === ENGINE_FX && l.is3D);
  document.body.classList.toggle('orbit', controls.enabled);
  panel.updateVisibility();
  if (L === panel.selected) syncHudShader();
}
onLayerModeChanged(panel.selected);

// ---------------------------------------------------------------- sizing
// The drawing buffer is a fixed frame. The panel around the preview only
// letterboxes that frame; it never changes the buffer's aspect.
let renderScale = 1;
let outputAspect = '16:9';
let fitMode = 'fill';          // 'fill' crops, 'fit' letterboxes

const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };
const PREVIEW_SIZE = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1152, 1152],
};
let aspectBeforeLed = null;

function bufferSize() {
  const [w, h] = PREVIEW_SIZE[outputAspect] || PREVIEW_SIZE['16:9'];
  const scale = Math.min(1, renderScale);
  return {
    w: Math.max(2, Math.round(w * scale)),
    h: Math.max(2, Math.round(h * scale)),
  };
}

function applyPreviewBox() {
  const wrap = $('preview-wrap');
  const [w, h] = PREVIEW_SIZE[outputAspect] || PREVIEW_SIZE['16:9'];
  const ratio = w / h;
  wrap.style.aspectRatio = `${w} / ${h}`;
  wrap.style.setProperty('--preview-aspect', String(ratio));
}

const drawSize = new THREE.Vector2();
let masterPixels = null;

function fitTarget(rt, w, h) {
  if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
}

function resize() {
  const { w, h } = bufferSize();
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  // Shader passes draw into these offscreen buffers at the scaled frame size.
  // The canvas receives only the last warp blit, so a lower render scale
  // shrinks the whole chain instead of leaving a full-resolution pass behind.
  const size = renderer.getDrawingBufferSize(drawSize);
  shared.uResolution.value.copy(size);
  fitTarget(stackRt, size.x, size.y);
  fitTarget(mixRt, size.x, size.y);
  fitTarget(holdRt, size.x, size.y);
  fitTarget(composeRt, size.x, size.y);
  fitTarget(stingRt, size.x, size.y);
  for (const l of layers) {
    l.setSize(size.x, size.y);
    l.updateUvScale(fitMode);
  }
  camera3.aspect = size.x / Math.max(size.y, 1);
  camera3.updateProjectionMatrix();
  applyPreviewBox();
  syncDpi();
}
resize();

function paintDpiReadout() {
  const el = $('dpi-readout');
  if (!el) return;
  el.textContent = `[OUTPUT RATIO: ${formatFactor(dpiState.dpiScaleFactor)} (PREVIEW ${formatFactor(dpiState.previewScale)})]`;
}

function syncDpi() {
  const [fw, fh] = PREVIEW_SIZE[outputAspect] || PREVIEW_SIZE['16:9'];
  setPreviewScale($('preview-wrap')?.clientWidth, fw);
  const advanced = !$('output-map-modal').hidden;
  if (advanced) {
    const rect = $('map-stage').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w > 8 && h > 8) setOutputPixels(w, h);
  } else if (masterPixels) {
    setOutputPixels(masterPixels.w, masterPixels.h);
  } else {
    setOutputPixels(fw, fh);
  }
  const sig = `${dpiState.auto}|${dpiState.previewScale.toFixed(3)}|${dpiState.dpiScaleFactor.toFixed(3)}|${hud.chrome.size}|${hud.chrome.leading}`;
  if (sig !== syncDpi.sig) {
    syncDpi.sig = sig;
    hud.applyChrome({});
  }
  paintDpiReadout();
}

function setMasterOutput(pixels) {
  masterPixels = pixels;
  syncDpi();
}

new ResizeObserver(() => syncDpi()).observe($('preview-wrap'));
window.addEventListener('vj-output-dpi', (e) => {
  const w = Number(e.detail?.width);
  const h = Number(e.detail?.height);
  if (w > 8 && h > 8) setMasterOutput({ w, h });
});

function setAspect(v) {
  const requested = ASPECTS[v] ? v : '16:9';
  if (outputMap.mask === 'led25' && requested !== '1:1') {
    aspectBeforeLed = requested;
    v = '1:1';
  }
  outputAspect = ASPECTS[v] ? v : '16:9';
  const locked = outputMap.mask === 'led25';
  const title = locked
    ? 'Locked to 1:1 while the 25-panel LED mask is on. Reference frame 1152×1152.'
    : 'Target frame. The picture keeps this shape when the panels around it resize.';
  for (const id of ['aspect', 'preview-format']) {
    const el = $(id);
    if (!el) continue;
    el.value = outputAspect;
    el.title = title;
  }
  resize();
}

function syncLedFrame() {
  if (outputMap.mask === 'led25') {
    if (aspectBeforeLed == null && outputAspect !== '1:1') aspectBeforeLed = outputAspect;
    if (outputAspect !== '1:1') setAspect('1:1');
    else {
      const title = 'Locked to 1:1 while the 25-panel LED mask is on. Reference frame 1152×1152.';
      for (const id of ['aspect', 'preview-format']) {
        const el = $(id);
        if (el) el.title = title;
      }
    }
  } else if (aspectBeforeLed != null) {
    const back = aspectBeforeLed;
    aspectBeforeLed = null;
    setAspect(back);
  }
  outputMap.syncAspect();
}
outputMap.onChange = syncLedFrame;
if (outputMap.mask === 'led25') syncLedFrame();

function setFit(mode) {
  fitMode = mode === 'fit' ? 'fit' : 'fill';
  $('scale-fill').classList.toggle('on', fitMode === 'fill');
  $('scale-fit').classList.toggle('on', fitMode === 'fit');
  for (const l of layers) l.updateUvScale(fitMode);
}

function setRenderScale(v) {
  const n = Number(v);
  renderScale = n === 0.5 || n === 0.75 || n === 1 ? n : 1;
  $('render-scale').value = String(renderScale);
  resize();
}

$('aspect').addEventListener('change', (e) => setAspect(e.target.value));
$('preview-format').addEventListener('change', (e) => setAspect(e.target.value));
$('scale-fill').addEventListener('click', () => setFit('fill'));
$('scale-fit').addEventListener('click', () => setFit('fit'));
$('render-scale').addEventListener('change', (e) => setRenderScale(e.target.value));

// ---------------------------------------------------------------- layer media
const setStatus = (el, text, isError = false) => {
  el.textContent = text;
  el.classList.toggle('error', isError);
};

function mediaKeyLabel(key) {
  if (key === 'none') return 'Test pattern';
  if (key.startsWith('cam:')) return library.cameraLabel(key.slice(4));
  const cut = key.indexOf(':');
  return cut >= 0 ? key.slice(cut + 1) : key;
}

function clipKey(name) {
  const item = library.mediaItem(name);
  return item?.url ? `url:${name}` : `file:${name}`;
}

async function setLayerMedia(L, key, { mirror } = {}) {
  const layer = layerById[L];
  const cameraLabel = key.startsWith('cam:') ? library.cameraLabel(key.slice(4)) : undefined;
  const pending = layer.setMedia(key, { library, cameraLabel, mirror, fitMode });
  refreshLayerUi();
  await pending;
  if (masterTransport.state !== 'playing' && syncMaster[L] && layer.input.kind === 'video') layer.input.pause();
  // Camera labels only appear after the first permission grant.
  if (key.startsWith('cam:') && !library.cameras.some((c) => c.label)) {
    await library.refreshCameras().catch(() => {});
  }
  refreshLayerUi();
  apcView?.refresh();
}

window.addEventListener('vj-media-fallback', () => {
  refreshLayerUi();
});

function currentMedia() {
  return Object.fromEntries(layers.map((l) => [l.id, { key: l.mediaKey, mirror: l.mirror, label: l.mediaLabel }]));
}

function refreshMediaSelect() {
  const sel = $('layer-media');
  const layer = selectedLayer();
  sel.innerHTML = '';
  sel.add(new Option('Test pattern', 'none'));
  const camGroup = document.createElement('optgroup');
  camGroup.label = 'Cameras';
  if (library.cameras.length) {
    library.cameras.forEach((c, i) => camGroup.append(new Option(c.label || `Camera ${i + 1}`, `cam:${c.deviceId}`)));
  } else {
    camGroup.append(new Option('Web camera', 'cam:'));
  }
  sel.append(camGroup);
  const fileGroup = document.createElement('optgroup');
  fileGroup.label = 'Media library';
  for (const name of library.names) fileGroup.append(new Option(name, clipKey(name)));
  if (layer.missing) fileGroup.append(new Option(`(missing) ${layer.missing}`, `file:${layer.missing}`));
  fileGroup.append(new Option('+ Add files...', 'add'));
  sel.append(fileGroup);
  if (![...sel.options].some((o) => o.value === layer.mediaKey)) {
    sel.add(new Option(mediaKeyLabel(layer.mediaKey), layer.mediaKey));
  }
  sel.value = layer.mediaKey;
}

function refreshLayerUi() {
  placePlaybackControls();
  const layer = selectedLayer();
  $('layer-name').textContent = layer.id;
  $('layer-name').dataset.layer = layer.id;
  refreshMediaSelect();
  $('layer-mirror').checked = layer.mirror;
  $('layer-sync').checked = syncMaster[layer.id] !== false;
  setStatus($('layer-status'), layer.mediaStatus, layer.mediaError);
  for (const l of layers) panel.setStripMedia(l.id, l.mediaKey === 'none' ? '' : l.mediaLabel);
  panel.updateVisibility();
  syncVideoTransport();
  refreshLibraryUi();
}

// ---------------------------------------------------------------- video transport
panel.isVideo = (L) => layerById[L].input.kind === 'video';
panel.isImage = (L) => layerById[L].input.kind === 'image';
let videoScrubbing = false;

let playbackLayerId = '';

function placePlaybackControls() {
  const layer = selectedLayer();
  const row = $('video-transport');
  if (
    playbackLayerId === layer.id
    && row.parentElement?.parentElement?.dataset.layer === layer.id
  ) return;
  const body = document.querySelector(
    `#layer-params .fx-block[data-layer="${layer.id}"][data-group="Source & Playback"] .fx-body`,
  );
  if (body && row && row.parentElement !== body) body.prepend(row);
  if (row?.parentElement === body) playbackLayerId = layer.id;
}

const fmtPlayhead = (s) => {
  const t = Number.isFinite(s) && s > 0 ? s : 0;
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  const whole = Math.floor(sec);
  const tenth = Math.min(9, Math.floor((sec - whole) * 10 + 1e-6));
  return `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenth}`;
};

const videoUi = {
  hidden: null,
  time: '',
  play: null,
  scrub: '',
  scrubMax: '',
  scrubDisabled: null,
  trackOff: null,
  inn: '',
  out: '',
  spanL: '',
  spanW: '',
};

function syncVideoTransport() {
  const input = selectedLayer().input;
  const isVideo = input.kind === 'video';
  const box = $('video-transport');
  if (videoUi.hidden !== !isVideo) {
    videoUi.hidden = !isVideo;
    box.hidden = videoUi.hidden;
  }
  if (!isVideo) return;
  const d = input.duration;
  const inn = input.loopIn || 0;
  const out = input.loopOut > 0 ? input.loopOut : d;
  const t = videoScrubbing ? Number($('video-scrub').value) : input.currentTime;
  const scrub = $('video-scrub');
  const scrubMax = d ? String(d) : '0';
  if (videoUi.scrubMax !== scrubMax) {
    videoUi.scrubMax = scrubMax;
    scrub.min = '0';
    scrub.max = scrubMax;
    scrub.step = '0.01';
  }
  const scrubDisabled = !d;
  if (videoUi.scrubDisabled !== scrubDisabled) {
    videoUi.scrubDisabled = scrubDisabled;
    scrub.disabled = scrubDisabled;
  }
  if (!videoScrubbing && d) {
    const scrubVal = String(Math.min(d, Math.max(0, t)));
    if (videoUi.scrub !== scrubVal) {
      videoUi.scrub = scrubVal;
      scrub.value = scrubVal;
    }
  }
  const timeText = `${input.reversing ? '\u25C0 ' : ''}${fmtPlayhead(t)} / ${fmtPlayhead(d)}`;
  if (videoUi.time !== timeText) {
    videoUi.time = timeText;
    $('video-time').textContent = timeText;
  }
  if (videoUi.play !== input.playing) {
    videoUi.play = input.playing;
    $('video-play').classList.toggle('on', input.playing);
    $('video-pause').classList.toggle('on', !input.playing);
  }
  const trackOff = !d;
  if (videoUi.trackOff !== trackOff) {
    videoUi.trackOff = trackOff;
    $('loop-track').classList.toggle('disabled', trackOff);
  }
  const innPct = (d ? (inn / d) * 100 : 0).toFixed(2);
  const outPct = (d ? (out / d) * 100 : 100).toFixed(2);
  if (videoUi.inn !== innPct) {
    videoUi.inn = innPct;
    $('loop-in-thumb').style.left = `${innPct}%`;
  }
  if (videoUi.out !== outPct) {
    videoUi.out = outPct;
    $('loop-out-thumb').style.left = `${outPct}%`;
  }
  const spanL = innPct;
  const spanW = Math.max(0, Number(outPct) - Number(innPct)).toFixed(2);
  if (videoUi.spanL !== spanL || videoUi.spanW !== spanW) {
    videoUi.spanL = spanL;
    videoUi.spanW = spanW;
    const span = $('loop-span');
    span.style.left = `${spanL}%`;
    span.style.width = `${spanW}%`;
  }
}

$('video-play').addEventListener('click', () => {
  selectedLayer().input.play();
  syncVideoTransport();
});
$('video-pause').addEventListener('click', () => {
  selectedLayer().input.pause();
  syncVideoTransport();
});
$('video-restart').addEventListener('click', () => {
  selectedLayer().input.restart();
  syncVideoTransport();
});
$('video-scrub').addEventListener('pointerdown', () => {
  videoScrubbing = true;
  selectedLayer().input.scrubHold = true;
});
window.addEventListener('pointerup', () => {
  if (!videoScrubbing) return;
  videoScrubbing = false;
  selectedLayer().input.endScrub();
});
$('video-scrub').addEventListener('input', (e) => {
  selectedLayer().input.seekTime(Number(e.target.value));
  syncVideoTransport();
});
$('video-scrub').addEventListener('change', () => {
  videoScrubbing = false;
  selectedLayer().input.endScrub();
});

let loopDrag = '';

function loopTimeAt(event) {
  const input = selectedLayer().input;
  const d = input.duration;
  const rect = $('loop-track').getBoundingClientRect();
  if (!d || rect.width <= 0) return 0;
  const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
  return (x / rect.width) * d;
}

function moveLoopThumb(event, which) {
  const input = selectedLayer().input;
  const d = input.duration;
  if (!d) return;
  const t = loopTimeAt(event);
  const inn = input.loopIn || 0;
  const out = input.loopOut > 0 ? input.loopOut : d;
  if (which === 'in') input.setLoopPoints(Math.min(t, Math.max(0, out - 0.05)), input.loopOut);
  else input.setLoopPoints(inn, Math.max(t, Math.min(d, inn + 0.05)));
  syncVideoTransport();
}

function bindLoopThumb(id, which) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    loopDrag = which;
    el.style.zIndex = '2';
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic press */ }
    moveLoopThumb(e, which);
  });
  el.addEventListener('pointermove', (e) => {
    if (loopDrag !== which) return;
    moveLoopThumb(e, which);
  });
  const end = () => {
    if (loopDrag !== which) return;
    loopDrag = '';
    el.style.zIndex = '';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
bindLoopThumb('loop-in-thumb', 'in');
bindLoopThumb('loop-out-thumb', 'out');

function assignMediaToLayer(mediaId, layerId) {
  const name = String(mediaId).replace(/^(?:file|url):/, '');
  return setLayerMedia(layerId, clipKey(name));
}

const pendingOnline = [];

function refreshLibraryUi() {
  const list = $('media-list');
  list.innerHTML = '';
  for (const job of pendingOnline) {
    const card = document.createElement('article');
    card.className = 'media-card loading';
    card.draggable = false;
    card.innerHTML = '<div class="media-thumb-wrap"></div><span class="media-name"></span>';
    card.querySelector('.media-name').textContent = job.label;
    card.querySelector('.media-name').title = job.label;
    list.append(card);
  }
  for (const name of library.names) {
    const item = library.mediaItem(name);
    const used = layers.filter((l) => l.mediaKey === `file:${name}` || l.mediaKey === `url:${name}`).map((l) => l.id);
    const card = document.createElement('article');
    card.className = 'media-card';
    card.draggable = true;
    card.classList.toggle('on', used.length > 0);
    card.innerHTML = '<div class="media-thumb-wrap"><img class="media-thumb" alt="" /><div class="media-badges"></div><div class="media-actions"></div></div><span class="media-name"></span>';
    const thumb = card.querySelector('.media-thumb');
    if (item?.thumbnail) thumb.src = item.thumbnail;
    else thumb.hidden = true;
    thumb.alt = '';
    if (item?.kind === 'video') {
      const play = document.createElement('i');
      play.className = 'media-play';
      play.title = 'Video loop';
      card.querySelector('.media-thumb-wrap').append(play);
    }
    card.querySelector('.media-name').textContent = name;
    card.querySelector('.media-name').title = name;
    const badges = card.querySelector('.media-badges');
    for (const id of used) {
      const mark = document.createElement('i');
      mark.className = 'media-badge';
      mark.dataset.layer = id;
      mark.textContent = id;
      mark.title = `Loaded on layer ${id}`;
      badges.append(mark);
    }
    const actions = card.querySelector('.media-actions');
    for (const id of ['A', 'B', 'C']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.layer = id;
      btn.textContent = id;
      btn.title = `Assign to layer ${id}`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        assignMediaToLayer(name, id);
      });
      actions.append(btn);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'media-delete';
    del.textContent = '\u00d7';
    del.title = 'Remove from library';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      library.remove(name);
    });
    actions.append(del);
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('button')) {
        e.preventDefault();
        return;
      }
      beginDrag(e, {
        id: item?.id || name,
        name,
        source: 'clip',
        kind: item?.kind || 'video',
      });
    });
    card.addEventListener('dragend', () => endDrag());
    list.append(card);
  }

  // Files referenced by scenes or layers that aren't loaded this session.
  const wanted = new Set();
  for (const l of layers) if (l.missing) wanted.add(l.missing);
  for (const s of scenes.scenes) {
    for (const m of Object.values(s.media || {})) if (m?.key?.startsWith('file:')) wanted.add(m.key.slice(5));
  }
  const missing = [...wanted].filter((n) => !library.has(n));
  $('media-missing').hidden = !missing.length;
  $('media-missing').textContent = missing.length
    ? `Scenes need these files. Add them to the library: ${missing.join(', ')}`
    : '';
}

function addFiles(fileList, { assign = false } = {}) {
  const added = library.add(fileList);
  if (assign && added.length === 1) assignMediaToLayer(added[0], panel.selected);
  return added;
}

library.onChange(() => {
  // A layer waiting on a missing file picks it up as soon as it's added.
  for (const l of layers) {
    if (l.missing && library.has(l.missing) && l.mediaStatus !== 'loading...') {
      assignMediaToLayer(l.missing, l.id);
    }
  }
  refreshLayerUi();
  apcView?.refresh();
});

let assignNextAdd = false;
$('layer-media').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (v === 'add') {
    assignNextAdd = true;
    $('media-files').click();
    refreshMediaSelect();
    return;
  }
  if (v === 'cam:') {
    // No device list yet: open the default camera, which also unlocks device labels.
    await setLayerMedia(panel.selected, 'cam:');
    await library.refreshCameras().catch(() => {});
    return;
  }
  setLayerMedia(panel.selected, v);
});
$('layer-media').addEventListener('focus', () => library.refreshCameras().catch(() => {}));
$('layer-media-refresh').addEventListener('click', () => library.refreshCameras().catch(() => {}));
$('layer-mirror').addEventListener('change', (e) => selectedLayer().setMirror(e.target.checked));
$('media-add').addEventListener('click', () => {
  assignNextAdd = false;
  $('media-files').click();
});
$('media-files').addEventListener('change', (e) => {
  addFiles(e.target.files, { assign: assignNextAdd });
  assignNextAdd = false;
  e.target.value = '';
});

function setOnlineStatus(text, isError = false) {
  const el = $('online-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

let onlineBusy = false;
async function fetchOnline() {
  const prompt = $('online-prompt').value.trim();
  const source = $('online-mode').value;
  if (!prompt) {
    setOnlineStatus('Type a prompt first.', true);
    return;
  }
  if (onlineBusy) return;
  onlineBusy = true;
  const job = { label: prompt };
  pendingOnline.unshift(job);
  refreshLibraryUi();
  setOnlineStatus('Fetching a video loop…');
  $('online-fetch').disabled = true;
  try {
    const loop = await fetchVideoLoop(source, prompt);
    library.addRemote(loop);
    await assignMediaToLayer(loop.name, panel.selected);
    const layer = layerById[panel.selected];
    if (layer.mediaKey === `url:${loop.name}` && layer.input.kind === 'video') {
      setOnlineStatus(`Loop on layer ${panel.selected}.`);
    } else {
      setOnlineStatus('');
    }
  } catch (err) {
    setOnlineStatus(err?.message || 'Could not fetch a video loop.', true);
  } finally {
    const index = pendingOnline.indexOf(job);
    if (index >= 0) pendingOnline.splice(index, 1);
    onlineBusy = false;
    $('online-fetch').disabled = false;
    refreshLibraryUi();
  }
}

$('online-fetch').addEventListener('click', () => { fetchOnline(); });
$('online-prompt').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  fetchOnline();
});

// Drop files onto the output.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (isPerformMode) {
    e.preventDefault();
    return;
  }
  if (e.target?.closest?.('#tl-track')) return;
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files, { assign: true });
});
document.addEventListener('dragstart', (e) => {
  if (!isPerformMode) return;
  e.preventDefault();
}, true);

let apcView;
panel.onSelect = (id) => {
  if (id === 'master') return;
  refreshLayerUi();
  syncHudShader();
  apcView?.refresh();
};

// ---------------------------------------------------------------- scenes + timeline
const project = new ProjectState();

function layerRouting() {
  const routing = {};
  for (const [id, lane] of Object.entries(mods.toJSON())) {
    if (params.defs.get(id)?.layer) routing[id] = lane;
  }
  return routing;
}

function applySceneRouting(routing) {
  const keep = {};
  for (const [id, lane] of Object.entries(mods.toJSON())) {
    if (!params.defs.get(id)?.layer) keep[id] = lane;
  }
  mods.replace({ ...keep, ...(routing || {}) });
}

function syncMediaPool() {
  project.setMediaPool(library.names.map((name) => ({
    id: name,
    name,
    kind: /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name) ? 'image' : 'video',
  })));
}
library.onChange(syncMediaPool);
library.ready.then(() => syncMediaPool()).catch(() => {});

const scenes = new SceneManager({
  params,
  project,
  getMedia: currentMedia,
  applyMedia: (L, m) => setLayerMedia(L, m.key, { mirror: m.mirror }),
  getRouting: layerRouting,
  applyRouting: applySceneRouting,
});
const timeline = new Timeline(project);

// ---------------------------------------------------------------- tempo clock
// The timeline's BPM is the single stored tempo; the clock follows it and,
// while the timeline plays, locks its beat to the playhead.
const beatClock = new BeatClock(timeline.bpm);
const bpmEngine = new BpmEngine(timeline.bpm);

function formatBpm(bpm) {
  return (Math.round(Number(bpm) * 10) / 10).toFixed(1);
}

function setTempo(bpm) {
  timeline.set('bpm', bpmEngine.setBpm(bpm));
}

function tapTempo() {
  const result = bpmEngine.tap();
  if (!result.accepted) return;
  if (timeline.playing) timeline.seek(Math.round(timeline.beat));
  if (!timeline.playing) {
    beatClock.beats = bpmEngine.beats;
    beatClock.setBpm(bpmEngine.bpm);
  }
  if (result.bpmChanged) {
    setBpmSource('manual');
    timeline.set('bpm', bpmEngine.bpm);
  } else {
    syncTempoUi();
  }
}

function syncTempoUi() {
  beatClock.setBpm(bpmEngine.bpm);
  const readout = $('bpm-value');
  if (readout && readout.dataset.editing !== '1') readout.textContent = formatBpm(bpmEngine.bpm);
  const auto = bpmEngine.mode === 'auto';
  readout?.parentElement.classList.toggle('locked', !auto);
  readout?.parentElement.classList.toggle('sync', auto);
  if (document.activeElement !== $('bpm-slider')) $('bpm-slider').value = String(bpmEngine.bpm);
}
timeline.onChange(() => {
  if (Math.abs(timeline.bpm - bpmEngine.bpm) > 0.001) {
    if (bpmSource !== 'manual') setBpmSource('manual');
    bpmEngine.setBpm(timeline.bpm);
  }
  syncTempoUi();
});
syncTempoUi();

$('bpm-slider').addEventListener('input', (e) => {
  if (bpmSource === 'auto' || e.target.disabled) return;
  setTempo(Number(e.target.value));
});
$('bpm-slider').addEventListener('dblclick', () => {
  if (bpmSource === 'auto') return;
  setTempo(120);
});
$('bpm-tap').addEventListener('click', tapTempo);
$('bpm-double').addEventListener('click', () => {
  setBpmSource('manual');
  setTempo(bpmEngine.double());
});
$('bpm-half').addEventListener('click', () => {
  setBpmSource('manual');
  setTempo(bpmEngine.halve());
});
$('bpm-nudge-up').addEventListener('click', () => {
  setBpmSource('manual');
  setTempo(bpmEngine.nudge(1));
});
$('bpm-nudge-down').addEventListener('click', () => {
  setBpmSource('manual');
  setTempo(bpmEngine.nudge(-1));
});

let bpmSource = 'manual';
function setBpmSource(src) {
  bpmSource = src === 'auto' ? 'auto' : 'manual';
  bpmEngine.setMode(bpmSource);
  const auto = bpmSource === 'auto';
  const btn = $('bpm-mode');
  btn.textContent = auto ? 'Auto Sync' : 'Manual Lock';
  btn.classList.toggle('on', auto);
  btn.setAttribute('aria-pressed', auto ? 'true' : 'false');
  btn.title = auto
    ? 'Auto Sync is listening to the playing audio. The BPM slider is locked.'
    : 'Manual Lock holds the number. The BPM slider edits it.';
  document.body.classList.toggle('bpm-auto', auto);
  $('bpm-slider').disabled = auto;
  const tlBpm = $('tl-bpm');
  if (tlBpm) tlBpm.disabled = auto;
  const readout = $('bpm-value')?.parentElement;
  readout?.classList.toggle('locked', !auto);
  readout?.classList.toggle('sync', auto);
  syncTempoUi();
}
$('bpm-mode').addEventListener('click', () => {
  setBpmSource(bpmSource === 'auto' ? 'manual' : 'auto');
});

function setMasterSpeed(value) {
  const n = Number(value);
  masterSpeed = Math.min(4, Math.max(0, Number.isFinite(n) ? n : 1));
  const out = $('master-speed-out');
  if (out && out.dataset.editing !== '1') out.textContent = `${masterSpeed.toFixed(2)}x`;
  const slider = $('master-speed');
  if (slider && document.activeElement !== slider) slider.value = String(masterSpeed);
}
$('master-speed')?.addEventListener('input', (e) => setMasterSpeed(e.target.value));
$('master-speed')?.addEventListener('dblclick', () => setMasterSpeed(1));

function setUiMode(mode) {
  const live = mode === 'live';
  document.body.classList.toggle('live-mode', live);
  $('ui-mode').textContent = live ? 'Live Performance Mode' : 'Timeline Mode';
  try { localStorage.setItem('vj.uiMode', live ? 'live' : 'timeline'); } catch { /* ignore */ }
}
$('ui-mode').addEventListener('click', () => {
  setUiMode(document.body.classList.contains('live-mode') ? 'timeline' : 'live');
});

let isPerformMode = false;
let performOpenedFullscreen = false;
const PERFORM_HOLD_MS = 700;
let performHolding = false;
let performHoldStart = 0;
let performSuppressClick = false;

function setPerformMode(on) {
  on = !!on;
  if (on === isPerformMode) return;
  isPerformMode = on;
  document.body.classList.toggle('perform-mode', on);
  const btn = $('perform-btn');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on
    ? 'Hold to exit Perform Mode'
    : 'Lock the desk for a live set. Hold the button to exit.';
  btn.style.setProperty('--hold', '0');
  if (on) {
    document.body.classList.remove('panel-hidden');
    $('screen-menu').hidden = true;
    if (!$('output-map-modal').hidden) openOutputMap(false);
    if (!$('prefs-modal').hidden) $('prefs-modal').hidden = true;
    if (midi.learnArmed) midi.toggleLearn();
    controls.enabled = false;
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
        .then(() => { performOpenedFullscreen = true; })
        .catch(() => { performOpenedFullscreen = false; });
    }
  } else {
    onLayerModeChanged(panel.selected);
    if (performOpenedFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    performOpenedFullscreen = false;
  }
}

function paintPerformHold() {
  if (!performHolding) return;
  const t = Math.min(1, (performance.now() - performHoldStart) / PERFORM_HOLD_MS);
  $('perform-btn').style.setProperty('--hold', String(t));
}

$('perform-btn').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !isPerformMode) return;
  performHolding = true;
  performHoldStart = performance.now();
  paintPerformHold();
});
window.addEventListener('pointerup', () => {
  if (!performHolding) return;
  const elapsed = performance.now() - performHoldStart;
  performHolding = false;
  $('perform-btn').style.setProperty('--hold', '0');
  if (isPerformMode && elapsed >= PERFORM_HOLD_MS) {
    performSuppressClick = true;
    setPerformMode(false);
  }
});
window.addEventListener('pointercancel', () => {
  performHolding = false;
  $('perform-btn')?.style.setProperty('--hold', '0');
});
$('perform-btn').addEventListener('click', () => {
  if (performSuppressClick) {
    performSuppressClick = false;
    return;
  }
  if (!isPerformMode) setPerformMode(true);
});
function setLibraryOpen(open) {
  document.body.classList.toggle('sys-collapsed', !open);
  $('sys-toggle').classList.toggle('on', open);
  $('sys-toggle').textContent = open ? 'Hide Library' : 'Show Library';
  try { localStorage.setItem('vj.library', open ? '1' : '0'); } catch { /* ignore */ }
}
$('sys-toggle').addEventListener('click', () => {
  setLibraryOpen(document.body.classList.contains('sys-collapsed'));
});
try {
  if (localStorage.getItem('vj.library') === '0') setLibraryOpen(false);
} catch { /* ignore */ }
const diag = new Diagnostics($('diag-panel'), (item) => {
  document.body.classList.remove('panel-hidden');
  if (item.domId) {
    setLibraryOpen(true);
    const el = document.getElementById(item.domId);
    const fold = el?.closest('details');
    if (fold) fold.open = true;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashControl(el, item.level);
    return;
  }
  if (item.parameterTarget === 'hud.size') setLibraryOpen(true);
  if (item.parameterTarget) panel.focusParam(item.parameterTarget, item.level);
  else if (item.layerId) panel.selectLayer(item.layerId);
});
$('diag-toggle').addEventListener('click', () => {
  const panelEl = $('diag-panel');
  const showing = panelEl.open && !document.body.classList.contains('sys-collapsed');
  if (showing) {
    panelEl.open = false;
    return;
  }
  setLibraryOpen(true);
  panelEl.open = true;
  panelEl.scrollIntoView({ block: 'nearest' });
});

const LIBRARY_FOLD_KEY = 'vj.accLeft';
const LIBRARY_FOLDS = [
  ['diag-panel', false],
  ['acc-media', true],
  ['acc-audio', false],
  ['acc-midi', false],
  ['acc-macros', false],
  ['acc-output', false],
  ['code-overlay', false],
];
function bindLibraryFolds() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LIBRARY_FOLD_KEY) || '{}'); } catch { /* ignore */ }
  if (!saved || typeof saved !== 'object') saved = {};
  const write = () => {
    const next = {};
    for (const [id] of LIBRARY_FOLDS) next[id] = !!$(id)?.open;
    try { localStorage.setItem(LIBRARY_FOLD_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  for (const [id, open] of LIBRARY_FOLDS) {
    const el = $(id);
    if (!el) continue;
    el.open = typeof saved[id] === 'boolean' ? saved[id] : open;
    el.addEventListener('toggle', write);
  }
}
bindLibraryFolds();
try {
  if (localStorage.getItem('vj.uiMode') === 'live') setUiMode('live');
} catch { /* ignore */ }

function triggerScene(id, fade = timeline.fadeSeconds) {
  if (typeof id === 'string' && !scenes.get(id)) return;
  if (fade > 0) snapshotHold();
  scenes.launch(id, fade);
}

timeline.onTrigger = (cue, { immediate } = {}) => {
  if (cue.kind === 'clip') {
    if (library.has(cue.mediaName)) assignMediaToLayer(cue.mediaName, cue.layerId || 'A');
    return;
  }
  triggerScene(cue.sceneId, immediate ? 0 : timeline.fadeSeconds);
};

function saveScene(name) {
  if (!name?.trim()) {
    const top = [...layers].reverse().find((l) => l.active) ?? layers[0];
    name = `Scene ${scenes.scenes.length + 1}: ${MODE_LABELS[top.get('mode')]}`;
  }
  scenes.save(name);
}

function projectFile() {
  syncMediaPool();
  return {
    ...project.toJSON(),
    live: { params: params.snapshot(), media: currentMedia() },
    output: { aspect: outputAspect, fit: fitMode, renderScale, uiMode: document.body.classList.contains('live-mode') ? 'live' : 'timeline' },
    outputMap: outputMap.toJSON(),
    bpmSource,
    midi: midi.mappings,
    macros: macros.toJSON(),
    lfo: lfo.toJSON(),
    modMatrix: mods.toJSON(),
  };
}

function downloadProjectFile(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function saveProject() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadProjectFile(projectFile(), `vj-project-${stamp}.vjproj`);
}

function saveNewProject() {
  const name = prompt('Name the new project', 'Untitled project');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const data = projectFile();
  data.id = crypto.randomUUID?.() || `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  data.name = trimmed;
  const safe = trimmed.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'project';
  downloadProjectFile(data, `${safe}.vjproj`);
}

function clearShowBuffers() {
  for (const layer of layers) layer.clearBuffers(renderer);
}

async function loadProject(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('That file is not valid JSON.');
    return;
  }
  const looksLikeProject = data && (
    Array.isArray(data.scenes)
    || Array.isArray(data.timeline)
    || Array.isArray(data.mediaPool)
    || Array.isArray(data.timeline?.cues)
  );
  if (!looksLikeProject) {
    alert('That file is not a Live VJ project.');
    return;
  }
  const doc = coerceDocument(data);
  const names = new Set(doc.mediaPool.map((item) => item.name));
  const grab = (media) => {
    for (const slot of Object.values(media || {})) {
      if (slot?.key?.startsWith('file:')) names.add(slot.key.slice(5));
    }
  };
  for (const scene of doc.scenes) grab(scene.media);
  grab(data.live?.media);
  await library.ensureCached([...names]);
  syncMediaPool();
  timeline.pause();
  clearShowBuffers();
  scenes.replaceAll(doc.scenes);
  timeline.load({ ...doc.transport, cues: doc.timeline });
  midi.setMappings(data.midi && typeof data.midi === 'object' ? data.midi : {});
  macros.replace(Array.isArray(data.macros) ? data.macros : []);
  lfo.replace(data.lfo && typeof data.lfo === 'object' ? data.lfo : {});
  mods.replace(data.modMatrix && typeof data.modMatrix === 'object' ? data.modMatrix : {});
  panel.refreshAutomation();
  if (data.output) {
    setAspect(data.output.aspect);
    setFit(data.output.fit);
    setRenderScale(data.output.renderScale);
    if (data.output.uiMode) setUiMode(data.output.uiMode);
  }
  if (data.outputMap) outputMap.apply(data.outputMap);
  if (data.bpmSource) setBpmSource(data.bpmSource);
  if (data.live?.params) {
    for (const [id, v] of Object.entries(data.live.params)) {
      if (!params.defs.get(id)?.layer) params.set(id, v);
    }
    scenes.launch({ params: data.live.params, media: data.live.media || {}, routing: layerRouting() }, 0);
  }
  refreshLayerUi();
  sceneBar.setBank(0);
  panel.applyFoldDefaults();
}

function newProject() {
  timeline.stop();
  scenes.replaceAll([]);
  timeline.load({
    bpm: 120, bars: 16, loop: true, fadeBeats: 4, fadeSec: 1, fadeStyle: 0, cues: [],
  });
  mods.replace({});
  panel.refreshAutomation();
  for (const def of params.defs.values()) {
    if (def.layer) params.set(def.id, def.defaultValue, { exact: true });
  }
  for (const L of LAYERS) {
    bus.mute[L] = false;
    bus.solo[L] = false;
    if (layerById[L].mediaKey !== 'none') setLayerMedia(L, 'none');
  }
  panel.refreshBus();
  clearShowBuffers();
  refreshLayerUi();
  sceneBar.setBank(0);
  panel.applyFoldDefaults();
}

const sceneBar = new SceneBar({
  scenes,
  timeline,
  midi,
  onLaunch: (id, fade) => triggerScene(id, fade ?? timeline.fadeSeconds),
  onSave: saveScene,
  onExport: saveProject,
  onSaveNew: saveNewProject,
  onImport: loadProject,
  onNew: newProject,
  onTap: tapTempo,
  clipLayer: () => (panel.selected === 'B' || panel.selected === 'C' ? panel.selected : 'A'),
  hasMedia: (name) => library.has(name),
  onDropFiles: (files) => addFiles(files),
});
scenes.onChange(() => {
  refreshLibraryUi();
  sceneBar.updateActive();
});

// ---------------------------------------------------------------- audio UI
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
let scrubbing = false;
let audioMode = localStorage.getItem('vj.audioMode') === 'file' ? 'file' : 'device';

const numStore = (key, fallback) => {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) ? v : fallback;
};
audio.volume = numStore('vj.audioVolume', 0.8);
audio.onLevel = (v) => {
  const slider = $('audio-volume');
  const out = $('audio-volume-out');
  if (slider && document.activeElement !== slider) slider.value = String(v);
  if (out) out.textContent = Number(v).toFixed(2);
  if (v >= 0.5) {
    try { localStorage.setItem('vj.audioVolume', String(v)); } catch { /* ignore */ }
  }
};
audio.muted = localStorage.getItem('vj.audioMute') === '1';
audio.agc = localStorage.getItem('vj.audioAgc') !== '0';
$('audio-volume').value = String(audio.volume);
$('audio-volume-out').textContent = audio.volume.toFixed(2);
$('audio-agc').checked = audio.agc;
$('audio-mute').classList.toggle('on', audio.muted);
$('audio-mute').textContent = audio.muted ? 'Muted' : 'Mute';
$('audio-master').value = String(params.get('audioGain'));
$('audio-master-out').textContent = Number(params.get('audioGain')).toFixed(2);
$('hud-size-mod').append(createModRow(mods, 'hud.size'));

function showAudioMode(mode) {
  audioMode = mode === 'file' ? 'file' : 'device';
  $('audio-device-row').hidden = audioMode !== 'device';
  $('audio-file-row').hidden = audioMode !== 'file';
  for (const btn of $('audio-kind').querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset.kind === audioMode);
  }
  try { localStorage.setItem('vj.audioMode', audioMode); } catch { /* ignore */ }
}

async function refreshAudioDevices() {
  const sel = $('audio-device');
  const current = sel.value;
  try {
    const devices = await audio.listDevices();
    sel.innerHTML = '';
    sel.add(new Option('Select input…', ''));
    devices.forEach((d, i) => sel.add(new Option(d.label || `Input ${i + 1}`, d.deviceId)));
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  } catch (err) {
    console.warn('Audio device enumeration failed', err);
    setStatus($('audio-status'), err.message, true);
  }
}

function syncTransport() {
  const t = audio.transport;
  $('audio-play').disabled = !t.ready;
  $('audio-scrub').disabled = !t.ready;
  if (!t.ready) return;
  if (!scrubbing) $('audio-scrub').value = String(Math.round((t.currentTime / t.duration) * 1000));
  $('audio-time').textContent = `${fmtTime(t.currentTime)} / ${fmtTime(t.duration)}`;
  $('audio-play').textContent = t.paused ? 'Play' : 'Pause';
}

const masterTransport = { state: 'playing' };
const syncMaster = { audio: true, A: true, B: true, C: true };
try {
  const saved = JSON.parse(localStorage.getItem('vj.syncMaster') || 'null');
  if (saved && typeof saved === 'object') {
    for (const key of ['audio', 'A', 'B', 'C']) {
      if (typeof saved[key] === 'boolean') syncMaster[key] = saved[key];
    }
  }
} catch { /* ignore a bad sync record */ }

function saveSyncMaster() {
  try { localStorage.setItem('vj.syncMaster', JSON.stringify(syncMaster)); } catch { /* ignore */ }
}

function paintMasterTransport() {
  const state = masterTransport.state;
  $('master-play').classList.toggle('on', state === 'playing');
  $('master-pause').classList.toggle('on', state === 'paused');
  $('master-stop').classList.toggle('blackout', state === 'stopped');
  $('master-play').setAttribute('aria-pressed', String(state === 'playing'));
  $('master-pause').setAttribute('aria-pressed', String(state === 'paused'));
  $('master-stop').setAttribute('aria-pressed', String(state === 'stopped'));
  $('audio-sync').checked = syncMaster.audio;
  $('layer-sync').checked = syncMaster[selectedLayer().id] !== false;
  for (const l of layers) panel.setSyncState(l.id, syncMaster[l.id] !== false);
}

function clearMasterCanvas() {
  renderer.setRenderTarget(null);
  const ctx = renderer.getContext();
  ctx.clearColor(0, 0, 0, 1);
  ctx.clear(ctx.COLOR_BUFFER_BIT);
}

function masterPlay() {
  masterTransport.state = 'playing';
  for (const l of layers) {
    if (!syncMaster[l.id] || l.input.kind !== 'video') continue;
    l.input.play();
  }
  if (syncMaster.audio && audio.buffer && !audio.playing) audio.play(audio.currentTime);
  timeline.play();
  paintMasterTransport();
  syncTransport();
  syncVideoTransport();
}

function masterPause() {
  masterTransport.state = 'paused';
  for (const l of layers) {
    if (!syncMaster[l.id] || l.input.kind !== 'video') continue;
    l.input.pause();
  }
  if (syncMaster.audio && audio.buffer) audio.pause();
  timeline.pause();
  paintMasterTransport();
  syncTransport();
  syncVideoTransport();
}

function masterStop() {
  masterTransport.state = 'stopped';
  for (const l of layers) {
    if (!syncMaster[l.id] || l.input.kind !== 'video') continue;
    l.input.pause();
  }
  if (syncMaster.audio && audio.buffer) audio.seekTime(0, false);
  timeline.stop();
  clearMasterCanvas();
  paintMasterTransport();
  syncTransport();
  syncVideoTransport();
}

function setLayerSync(id, on) {
  syncMaster[id] = !!on;
  saveSyncMaster();
  const layer = layerById[id];
  if (on && layer?.input.kind === 'video' && masterTransport.state !== 'playing') layer.input.pause();
  paintMasterTransport();
}

function setAudioSync(on) {
  syncMaster.audio = !!on;
  saveSyncMaster();
  if (on && audio.buffer) {
    if (masterTransport.state === 'stopped') audio.seekTime(0, false);
    else if (masterTransport.state === 'paused') audio.pause();
    else if (!audio.playing) audio.play(audio.currentTime);
  }
  paintMasterTransport();
  syncTransport();
}

panel.onSyncToggle = (id) => setLayerSync(id, !syncMaster[id]);
$('master-play').addEventListener('click', masterPlay);
$('master-pause').addEventListener('click', masterPause);
$('master-stop').addEventListener('click', masterStop);
$('audio-sync').addEventListener('change', () => setAudioSync($('audio-sync').checked));
$('layer-sync').addEventListener('change', () => setLayerSync(selectedLayer().id, $('layer-sync').checked));
paintMasterTransport();

async function useAudioFile(file) {
  setStatus($('audio-status'), 'decoding...');
  showAudioMode('file');
  await audio.loadFile(file, { autoplay: masterTransport.state === 'playing' || !syncMaster.audio });
  audio.setLoop($('audio-loop').checked);
  library.cacheAudio(file);
  try { localStorage.setItem('vj.audioFile', file.name); } catch { /* ignore */ }
  setStatus($('audio-status'), file.name);
  syncTransport();
}

$('audio-kind').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const mode = btn.dataset.kind;
  showAudioMode(mode);
  setStatus($('audio-status'), '');
  try {
    if (mode === 'device') {
      audio.pause();
      await refreshAudioDevices();
      if ($('audio-device').value) await audio.start($('audio-device').value);
      else audio.releaseDevice();
    } else {
      audio.releaseDevice();
    }
  } catch (err) {
    setStatus($('audio-status'), err.message, true);
  }
  syncTransport();
});

$('audio-refresh').addEventListener('click', refreshAudioDevices);
$('audio-device').addEventListener('focus', refreshAudioDevices, { once: true });
$('audio-device').addEventListener('change', async (e) => {
  const id = e.target.value;
  try {
    if (!id) audio.releaseDevice();
    else await audio.start(id);
    setStatus($('audio-status'), '');
  } catch (err) {
    setStatus($('audio-status'), err.message, true);
  }
});
navigator.mediaDevices?.addEventListener('devicechange', () => {
  if (audioMode === 'device') refreshAudioDevices();
  library.refreshCameras().catch(() => {});
});

$('audio-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { await useAudioFile(file); }
  catch (err) { setStatus($('audio-status'), err.message, true); }
});

const drop = $('audio-drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = [...e.dataTransfer.files].find((f) => /\.(mp3|wav|aiff|aif)$/i.test(f.name) || f.type.startsWith('audio/'));
  if (!file) {
    setStatus($('audio-status'), 'Drop an .mp3, .wav, or .aiff.', true);
    return;
  }
  try { await useAudioFile(file); }
  catch (err) { setStatus($('audio-status'), err.message, true); }
});

try {
  if (localStorage.getItem('vj.audioLoop') === '0') $('audio-loop').checked = false;
} catch { /* ignore */ }
audio.setLoop($('audio-loop').checked);
$('audio-play').addEventListener('click', () => {
  if (!audio.buffer) return;
  audio.togglePlayback();
  syncTransport();
});
$('audio-loop').addEventListener('change', (e) => {
  audio.setLoop(e.target.checked);
  try { localStorage.setItem('vj.audioLoop', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
});
$('audio-scrub').addEventListener('pointerdown', () => { scrubbing = true; });
window.addEventListener('pointerup', () => { scrubbing = false; });
$('audio-scrub').addEventListener('input', (e) => {
  if (!audio.buffer || !audio.duration) return;
  const seconds = (Number(e.target.value) / 1000) * audio.duration;
  audio.seekTime(seconds, audio.playing);
  syncTransport();
});
$('audio-volume').addEventListener('input', (e) => {
  audio.volume = Number(e.target.value);
  $('audio-volume-out').textContent = audio.volume.toFixed(2);
  try { localStorage.setItem('vj.audioVolume', String(audio.volume)); } catch { /* ignore */ }
});
for (const [rangeId, outId] of [
  ['audio-volume', 'audio-volume-out'],
  ['audio-master', 'audio-master-out'],
  ['audio-attack', 'audio-attack-out'],
  ['audio-release', 'audio-release-out'],
  ['tl-fade-sec', 'tl-fade-readout'],
  ['bpm-slider', 'bpm-value'],
  ['hud-size', 'hud-size-out'],
  ['hud-leading', 'hud-leading-out'],
  ['hud-mix', 'hud-mix-out'],
  ['hud-bg', 'hud-bg-out'],
  ['ui-scale', 'ui-scale-out'],
  ['output-bezel', 'output-bezel-out'],
  ['master-speed', 'master-speed-out'],
]) bindRangeReadout($(outId), $(rangeId));
$('audio-agc').addEventListener('change', (e) => {
  audio.agc = e.target.checked;
  try { localStorage.setItem('vj.audioAgc', audio.agc ? '1' : '0'); } catch { /* ignore */ }
});
function bindEnvelope(id, outId, key, digits) {
  const el = $(id);
  const raw = localStorage.getItem(key);
  const saved = raw == null || raw === '' ? NaN : Number(raw);
  if (Number.isFinite(saved)) el.value = String(saved);
  audio[id === 'audio-attack' ? 'attack' : 'release'] = Number(el.value);
  const paint = () => {
    const v = Number(el.value);
    audio[id === 'audio-attack' ? 'attack' : 'release'] = v;
    $(outId).textContent = `${v.toFixed(digits)}s`;
    try { localStorage.setItem(key, String(v)); } catch { /* ignore */ }
  };
  el.addEventListener('input', paint);
  paint();
}
bindEnvelope('audio-attack', 'audio-attack-out', 'vj.audioAttack', 3);
bindEnvelope('audio-release', 'audio-release-out', 'vj.audioRelease', 2);
$('audio-mute').addEventListener('click', () => {
  audio.muted = !audio.muted;
  $('audio-mute').classList.toggle('on', audio.muted);
  $('audio-mute').textContent = audio.muted ? 'Muted' : 'Mute';
  try { localStorage.setItem('vj.audioMute', audio.muted ? '1' : '0'); } catch { /* ignore */ }
});
$('audio-master').addEventListener('input', (e) => {
  params.set('audioGain', Number(e.target.value));
  $('audio-master-out').textContent = Number(e.target.value).toFixed(2);
});
showAudioMode(audioMode);

// ---------------------------------------------------------------- MIDI UI
let lastMidi = '';
const paintLearn = () => {
  document.body.classList.toggle('midi-learn', midi.learnArmed);
  const btn = $('midi-learn');
  btn.classList.toggle('on', midi.learnArmed);
  btn.textContent = midi.learnArmed ? 'MIDI Learn On' : 'MIDI Learn';
  for (const el of document.querySelectorAll('[data-midi]')) {
    el.classList.toggle('midi-hot', el.dataset.midi === midi.learnTarget);
  }
};

function renderMomentary() {
  const root = $('momentary-pads');
  root.innerHTML = '';
  for (const pad of MOMENTARY) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'moment-pad';
    b.dataset.midi = `moment:${pad.id}`;
    const map = midi.mappingFor(`moment:${pad.id}`);
    b.innerHTML = '<b></b><i></i>';
    b.querySelector('b').textContent = pad.label;
    b.querySelector('i').textContent = map || 'unmapped';
    b.classList.toggle('held', momentary.held.has(pad.id));
    b.classList.toggle('mapped', !!map);
    b.title = map ? `${pad.label} · ${map}` : `${pad.label}. Turn on MIDI Learn, click this pad, then hit a drum pad.`;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (midi.learnArmed) return;
      e.preventDefault();
      momentary.set(pad.id, true);
      try { b.setPointerCapture(e.pointerId); } catch { /* a synthetic press has no pointer to capture */ }
    });
    const release = (e) => {
      if (e?.type === 'pointerup' && e.button !== 0) return;
      momentary.set(pad.id, false);
    };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    root.append(b);
  }
}

function renderMacros() {
  const root = $('macro-list');
  root.innerHTML = '';
  const options = sliderOptions(params);
  macros.macros.forEach((macro, index) => {
    const card = document.createElement('div');
    card.className = 'macro-card';
    const head = document.createElement('div');
    head.className = 'macro-head';
    const learn = document.createElement('button');
    learn.type = 'button';
    learn.className = 'macro-learn';
    learn.dataset.midi = `macro:${index}`;
    learn.textContent = 'Learn CC';
    const name = document.createElement('span');
    name.textContent = macro.cc || 'No CC yet';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '\u00d7';
    remove.title = 'Remove macro';
    remove.addEventListener('click', () => macros.remove(index));
    head.append(learn, name, remove);
    learn.addEventListener('click', () => {
      if (!midi.learnArmed) midi.learn(`macro:${index}`);
    });
    card.append(head);
    macro.lanes.forEach((lane, laneIndex) => {
      const row = document.createElement('div');
      row.className = 'macro-lane';
      const sel = document.createElement('select');
      for (const opt of options) sel.add(new Option(opt.label, opt.id));
      if ([...sel.options].some((o) => o.value === lane.param)) sel.value = lane.param;
      sel.addEventListener('change', () => macros.updateLane(index, laneIndex, { param: sel.value }));
      const depth = document.createElement('input');
      depth.type = 'range';
      depth.min = '0';
      depth.max = '1';
      depth.step = '0.01';
      depth.value = String(lane.depth);
      depth.title = 'Depth. 100% lets the knob travel the whole slider.';
      depth.addEventListener('input', () => macros.updateLane(index, laneIndex, { depth: Number(depth.value) }));
      const invert = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = lane.invert;
      box.addEventListener('change', () => macros.updateLane(index, laneIndex, { invert: box.checked }));
      invert.append(box, document.createTextNode('Invert'));
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '\u00d7';
      del.title = 'Remove slider';
      del.addEventListener('click', () => macros.removeLane(index, laneIndex));
      row.append(sel, depth, invert, del);
      card.append(row);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add slider';
    add.addEventListener('click', () => {
      if (options[0]) macros.addLane(index, options[0].id);
    });
    card.append(add);
    root.append(card);
  });
}

macros.onChange = () => renderMacros();
momentary.onChange = () => {
  for (const pad of MOMENTARY) {
    const el = document.querySelector(`[data-midi="moment:${pad.id}"]`);
    el?.classList.toggle('held', momentary.held.has(pad.id));
  }
};
midi.onMomentary = (id, down) => momentary.set(id, down);
midi.onMacroLearn = (index, key) => macros.bind(index, key);
midi.onControl = (key, value) => macros.setValue(key, value);
midi.onChange = () => {
  panel.refreshMidi();
  sceneBar.renderPads();
  renderMomentary();
  renderMacros();
  paintLearn();
  const names = midi.inputNames;
  setStatus($('midi-status'), midi.access ? (names.length ? names.join(', ') : 'no devices') : '');
};
midi.onActivity = (key, value) => {
  lastMidi = `${key} = ${value.toFixed(2)}`;
};
midi.onTrigger = (sceneId) => {
  triggerScene(sceneId);
};
$('midi-enable').addEventListener('click', async () => {
  try {
    await midi.init();
    midi.onChange();
  } catch (err) {
    setStatus($('midi-status'), err.message, true);
  }
});
$('midi-learn').addEventListener('click', () => {
  midi.toggleLearn();
  if (midi.learnArmed && !midi.access) {
    midi.init().catch((err) => setStatus($('midi-status'), err.message, true));
  }
});
$('apc-preset').addEventListener('click', () => {
  const arm = async () => {
    if (!midi.access) await midi.init();
    apcLeds.reset();
    const found = midi.outputs.filter((p) => /apc|akai/i.test(p.name || ''));
    setStatus($('midi-status'), found.length
      ? `APC Mini MK2 · ${found.map((p) => p.name).join(', ')}`
      : 'APC Mini MK2 default map armed');
  };
  arm().catch((err) => setStatus($('midi-status'), err.message, true));
});
$('midi-clear').addEventListener('click', () => midi.clear());
$('macro-add').addEventListener('click', () => macros.add());
document.addEventListener('pointerdown', (e) => {
  if (!midi.learnArmed) return;
  const el = e.target.closest('[data-midi]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  midi.learn(el.dataset.midi);
}, true);
document.addEventListener('click', (e) => {
  if (!midi.learnArmed) return;
  if (!e.target.closest('[data-midi]')) return;
  e.preventDefault();
  e.stopPropagation();
}, true);
renderMomentary();
renderMacros();

// ---------------------------------------------------------------- output UI
const formats = Recorder.supportedFormats();
formats.forEach((f, i) => $('rec-format').add(new Option(f.label, String(i))));
if (!formats.length) $('rec-btn').disabled = true;

const RECORD_FRAMES = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
};

function recordFrame() {
  const choice = $('rec-aspect')?.value || '16:9';
  if (RECORD_FRAMES[choice]) return RECORD_FRAMES[choice];
  const size = renderer.getDrawingBufferSize(drawSize);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return [even(size.x), even(size.y)];
}

function toggleRecording() {
  if (recorder.recording) {
    recorder.stop();
  } else {
    const [width, height] = recordFrame();
    const withAudio = $('rec-audio').checked && audio.recordStream;
    recorder.start({
      format: formats[$('rec-format').value],
      audioStream: withAudio ? audio.recordStream : null,
      width,
      height,
    });
  }
  $('rec-btn').classList.toggle('on', recorder.recording);
  $('rec-btn').innerHTML = recorder.recording ? '&#x25A0; STOP' : '&#x25CF; REC';
}

const toggleFullscreen = () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
const togglePanel = () => document.body.classList.toggle('panel-hidden');

$('rec-btn').addEventListener('click', toggleRecording);
const savedRecAspect = localStorage.getItem('vj.recAspect');
if (savedRecAspect && (RECORD_FRAMES[savedRecAspect] || savedRecAspect === 'native')) {
  $('rec-aspect').value = savedRecAspect;
}
$('rec-aspect').addEventListener('change', () => {
  try { localStorage.setItem('vj.recAspect', $('rec-aspect').value); } catch { /* ignore */ }
});
const pushOverlay = (force = true) => outputWin.syncHud(hud.capture(), { force });

const HUD_MODES = ['scan', 'glsl', 'matrix', 'formula', 'diag', 'audio'];
const scanLog = new ScanLog();
let scanTick = 0;
const HUD_STYLE_KEY = {
  glyph: 'vj.hudGlyph',
  color: 'vj.hudColor',
  size: 'vj.hudSize',
  mix: 'vj.hudMix',
  bg: 'vj.hudBg',
  leading: 'vj.hudLeading',
  mode: 'vj.hudMode',
};

function readHudStyle() {
  const num = (key, fallback) => {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    glyph: localStorage.getItem(HUD_STYLE_KEY.glyph) || 'ascii',
    color: localStorage.getItem(HUD_STYLE_KEY.color) || 'green',
    size: num(HUD_STYLE_KEY.size, 16),
    mix: num(HUD_STYLE_KEY.mix, 0.92),
    bg: num(HUD_STYLE_KEY.bg, 0.72),
    leading: num(HUD_STYLE_KEY.leading, 1.45),
    mode: HUD_MODES.includes(localStorage.getItem(HUD_STYLE_KEY.mode))
      ? localStorage.getItem(HUD_STYLE_KEY.mode)
      : 'scan',
  };
}

function bindHudChrome() {
  const style = readHudStyle();
  $('hud-glyph').value = style.glyph;
  $('hud-color').value = style.color;
  $('hud-mode').value = style.mode;
  $('hud-size').value = String(style.size);
  $('hud-leading').value = String(style.leading);
  $('hud-mix').value = String(style.mix);
  $('hud-bg').value = String(style.bg);
  $('hud-size-out').textContent = String(Math.round(style.size));
  $('hud-leading-out').textContent = style.leading.toFixed(2);
  $('hud-mix-out').textContent = style.mix.toFixed(2);
  $('hud-bg-out').textContent = style.bg.toFixed(2);
  hud.setDisplay(style.mode);
  hud.applyChrome(style);
  syncPresetSelect();

  const persist = () => {
    const next = {
      glyph: $('hud-glyph').value,
      color: $('hud-color').value,
      size: Number($('hud-size').value),
      mix: Number($('hud-mix').value),
      bg: Number($('hud-bg').value),
      leading: Number($('hud-leading').value),
    };
    localStorage.setItem(HUD_STYLE_KEY.glyph, next.glyph);
    localStorage.setItem(HUD_STYLE_KEY.color, next.color);
    localStorage.setItem(HUD_STYLE_KEY.size, String(next.size));
    localStorage.setItem(HUD_STYLE_KEY.mix, String(next.mix));
    localStorage.setItem(HUD_STYLE_KEY.bg, String(next.bg));
    localStorage.setItem(HUD_STYLE_KEY.leading, String(next.leading));
    $('hud-size-out').textContent = String(Math.round(next.size));
    $('hud-leading-out').textContent = next.leading.toFixed(2);
    $('hud-mix-out').textContent = next.mix.toFixed(2);
    $('hud-bg-out').textContent = next.bg.toFixed(2);
    hud.applyChrome(next);
    pushOverlay(true);
  };
  for (const id of ['hud-glyph', 'hud-color', 'hud-size', 'hud-leading', 'hud-mix', 'hud-bg']) {
    $(id).addEventListener('input', persist);
  }
  $('hud-mode').addEventListener('change', () => {
    setHudDisplay($('hud-mode').value);
    syncPresetSelect();
  });
  $('hud-glyph').addEventListener('change', syncPresetSelect);
  $('hud-preset').addEventListener('change', () => {
    if ($('hud-preset').value) applyHudPreset($('hud-preset').value);
  });
}

function syncPresetSelect() {
  const mode = $('hud-mode').value;
  const glyph = $('hud-glyph').value;
  const hit = HUD_PRESETS.find((p) => p.mode === mode && p.glyph === glyph);
  $('hud-preset').value = hit ? hit.id : '';
}

function applyHudPreset(id) {
  const preset = HUD_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  $('hud-glyph').value = preset.glyph;
  $('hud-glyph').dispatchEvent(new Event('input', { bubbles: true }));
  setHudDisplay(preset.mode);
  try { localStorage.setItem('vj.hudPreset', id); } catch { /* ignore */ }
}

function setHudDisplay(mode) {
  hud.setDisplay(mode);
  $('hud-mode').value = hud.display;
  localStorage.setItem(HUD_STYLE_KEY.mode, hud.display);
  pushOverlay(true);
}
bindHudChrome();

function setHudEnabled(on) {
  hud.toggle(!!on);
  $('hud-enable').checked = hud.visible;
  const frame = $('hud-frame');
  if (frame) frame.hidden = !hud.visible;
  localStorage.setItem('vj.hud', hud.visible ? '1' : '0');
  pushOverlay(true);
}

let hudBox = { ...HUD_BOX_DEFAULT };
function applyHudBox(next, remember = false) {
  hudBox = clampHudBox(next);
  const frame = $('hud-frame');
  if (frame) {
    frame.style.setProperty('--hud-x', String(hudBox.x));
    frame.style.setProperty('--hud-y', String(hudBox.y));
    frame.style.setProperty('--hud-w', String(hudBox.w));
    frame.style.setProperty('--hud-h', String(hudBox.h));
  }
  hud.applyChrome({ box: hudBox });
  if (remember) {
    try { localStorage.setItem('vj.hudBox', JSON.stringify(hudBox)); } catch { /* ignore */ }
  }
}

function loadHudBox() {
  try {
    const saved = JSON.parse(localStorage.getItem('vj.hudBox') || 'null');
    applyHudBox(saved || HUD_BOX_DEFAULT, false);
  } catch {
    applyHudBox(HUD_BOX_DEFAULT, false);
  }
}

function bindHudBox() {
  const frame = $('hud-frame');
  const wrap = $('preview-wrap');
  if (!frame || !wrap) return;
  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const handle = e.target.closest('[data-handle]')?.dataset.handle || 'move';
    const rect = wrap.getBoundingClientRect();
    drag = {
      handle,
      px: e.clientX,
      py: e.clientY,
      box: { ...hudBox },
      rw: Math.max(1, rect.width),
      rh: Math.max(1, rect.height),
    };
    frame.classList.add('selected');
    try { frame.setPointerCapture(e.pointerId); } catch { /* synthetic presses have no pointer */ }
    e.preventDefault();
    e.stopPropagation();
  });
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.px) / drag.rw;
    const dy = (e.clientY - drag.py) / drag.rh;
    let { x, y, w, h } = drag.box;
    const min = 0.12;
    if (drag.handle === 'move') {
      x += dx;
      y += dy;
    } else {
      const east = drag.handle.includes('e');
      const south = drag.handle.includes('s');
      const west = drag.handle.includes('w');
      const north = drag.handle.includes('n');
      if (east) w += dx;
      if (south) h += dy;
      if (west) {
        const nx = Math.min(x + w - min, Math.max(0, x + dx));
        w += x - nx;
        x = nx;
      }
      if (north) {
        const ny = Math.min(y + h - min, Math.max(0, y + dy));
        h += y - ny;
        y = ny;
      }
      if (e.shiftKey) {
        const aspect = drag.box.w / drag.box.h;
        if (Math.abs(dx) >= Math.abs(dy)) h = w / aspect;
        else w = h * aspect;
      }
    }
    applyHudBox({ x, y, w, h }, false);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    applyHudBox(hudBox, true);
    if (e?.pointerId != null) {
      try { frame.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
  };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);
  frame.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-handle]')) return;
    const column = hudBox.h >= hudBox.w;
    applyHudBox(column
      ? { x: hudBox.x, y: hudBox.y, w: 0.78, h: 0.28 }
      : { x: hudBox.x, y: hudBox.y, w: 0.34, h: 0.78 }, true);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!frame.contains(e.target)) frame.classList.remove('selected');
  });
}

function setHudPerform(on) {
  document.body.classList.toggle('hud-perform', !!on);
  $('hud-perform').checked = !!on;
  try { localStorage.setItem('vj.hudPerform', on ? '1' : '0'); } catch { /* ignore */ }
}
loadHudBox();
bindHudBox();
if (localStorage.getItem('vj.hud') === '1') setHudEnabled(true);
$('hud-enable').addEventListener('change', () => setHudEnabled($('hud-enable').checked));
setHudPerform(localStorage.getItem('vj.hudPerform') === '1');
$('hud-perform').addEventListener('change', () => setHudPerform($('hud-perform').checked));
$('hud-dpi').checked = dpiState.auto;
$('hud-dpi').addEventListener('change', () => {
  setDpiAuto($('hud-dpi').checked);
  syncDpi();
});

function stepHudSize() {
  const el = $('hud-size');
  el.value = String(nextHudSize(Number(el.value)));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  apcView?.refresh();
}

function stepHudTheme() {
  const el = $('hud-color');
  const values = [...el.options].map((o) => o.value);
  const i = Math.max(0, values.indexOf(el.value));
  el.value = values[(i + 1) % values.length];
  el.dispatchEvent(new Event('input', { bubbles: true }));
  apcView?.refresh();
}

function swapLayers(a, b) {
  const keys = LAYER_DEFS.map((d) => d.id);
  const values = {};
  for (const key of keys) values[key] = [params.get(layerParam(a, key)), params.get(layerParam(b, key))];
  for (const key of keys) {
    params.set(layerParam(a, key), values[key][1]);
    params.set(layerParam(b, key), values[key][0]);
  }
  const media = currentMedia();
  setLayerMedia(a, media[b].key, { mirror: media[b].mirror });
  setLayerMedia(b, media[a].key, { mirror: media[a].mirror });
  bus.exchange(a, b);
}

function setPerformanceView(mode) {
  const apc = mode === 'apc';
  document.body.classList.toggle('view-apc', apc);
  $('apc-view').hidden = !apc;
  if ($('view-mode').value !== (apc ? 'apc' : 'studio')) $('view-mode').value = apc ? 'apc' : 'studio';
  try { localStorage.setItem('vj.view', apc ? 'apc' : 'studio'); } catch { /* ignore */ }
  if (apc) apcView?.refresh();
}

apcView = new ApcView({
  root: $('apc-view'),
  params,
  scenes,
  bus,
  panel,
  launch: (id) => triggerScene(id),
  swapLayers,
  setHud: (on, size) => {
    if (size != null) {
      const slider = $('hud-size');
      slider.value = String(size);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setHudEnabled(on);
    apcView?.refresh();
  },
  getHud: () => ({ on: hud.visible, size: Number($('hud-size').value) }),
  getClips: () => library.names,
  setClip: (layer, name) => setLayerMedia(layer, `file:${name}`),
  getMedia: () => currentMedia(),
  momentary,
  stepHudSize,
  stepHudTheme,
});
midi.onHardware = (msg) => apcView.handleMidi(msg);
$('view-mode').addEventListener('change', (e) => setPerformanceView(e.target.value));
if (localStorage.getItem('vj.view') === 'apc') setPerformanceView('apc');
$('hud-output').checked = outputWin.overlayOn;
$('hud-output').addEventListener('change', () => {
  outputWin.setOverlayOn($('hud-output').checked);
  pushOverlay();
});

let outputBtnOn = null;
function syncOutputBtn() {
  const on = !!outputWin.open;
  if (outputBtnOn === on) return;
  outputBtnOn = on;
  $('output-win').classList.toggle('on', on);
  $('output-win').title = on
    ? 'Master output is open. Pick a screen to move it, or click again to close this list.'
    : 'Choose a display and open a borderless master output';
}
window.addEventListener('vj-output-closed', () => syncOutputBtn());
function placeScreenMenu() {
  const menu = $('screen-menu');
  const rect = $('output-win').getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
}
$('output-win').addEventListener('click', async (e) => {
  e.stopPropagation();
  $('file-menu').hidden = true;
  $('file-menu-btn').setAttribute('aria-expanded', 'false');
  const menu = $('screen-menu');
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  menu.replaceChildren();
  const pending = document.createElement('p');
  pending.className = 'hint';
  pending.textContent = 'Looking for displays…';
  menu.append(pending);
  menu.hidden = false;
  placeScreenMenu();
  const screens = await listScreens();
  if (menu.hidden) return;
  menu.replaceChildren();
  for (const item of screens) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.title;
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      setMasterOutput(pixelsOf(item.screen));
      const opened = await outputWin.launch(item);
      if (!opened) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = isTauri()
          ? (outputWin.lastBlockMessage || 'Could not open the output window.')
          : (outputWin.lastBlockMessage || POPUP_BLOCKED);
        menu.append(note);
        return;
      }
      menu.hidden = true;
      syncOutputBtn();
    });
    menu.append(btn);
  }
  placeScreenMenu();
});
$('screen-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  $('screen-menu').hidden = true;
});
function openOutputMap(open) {
  const modal = $('output-map-modal');
  modal.hidden = !open;
  if (open) outputMap.syncAspect();
  syncDpi();
  if (open) requestAnimationFrame(syncDpi);
}
$('output-advanced').addEventListener('click', () => openOutputMap($('output-map-modal').hidden));
$('map-close').addEventListener('click', () => openOutputMap(false));
$('output-map-modal').addEventListener('click', (e) => {
  if (e.target === $('output-map-modal')) openOutputMap(false);
});
function openPrefs(open) {
  $('prefs-modal').hidden = !open;
}
$('prefs-btn').addEventListener('click', () => openPrefs($('prefs-modal').hidden));
$('prefs-close').addEventListener('click', () => openPrefs(false));
$('prefs-modal').addEventListener('click', (e) => {
  if (e.target === $('prefs-modal')) openPrefs(false);
});

function setUiScale(percent) {
  const pct = Math.min(125, Math.max(75, Math.round(Number(percent) || 100)));
  $('app').style.setProperty('--ui-scale', String(pct / 100));
  $('ui-scale').value = String(pct);
  $('ui-scale-out').textContent = `${pct}%`;
  try { localStorage.setItem('vj.uiScale', String(pct)); } catch { /* ignore */ }
}
$('ui-scale').addEventListener('input', (e) => setUiScale(e.target.value));
try {
  const rawScale = localStorage.getItem('vj.uiScale');
  const savedScale = rawScale == null || rawScale === '' ? NaN : Number(rawScale);
  if (Number.isFinite(savedScale)) setUiScale(savedScale);
} catch { /* ignore */ }

function savePanes() {
  const cs = getComputedStyle($('app'));
  const read = (name) => parseFloat(cs.getPropertyValue(name));
  try {
    localStorage.setItem('vj.panes', JSON.stringify({
      library: read('--library-w'),
      inspector: read('--inspector-w'),
      dock: read('--dock-h'),
    }));
  } catch { /* ignore */ }
}
try {
  const panes = JSON.parse(localStorage.getItem('vj.panes') || 'null');
  if (panes && typeof panes === 'object') {
    if (panes.library) $('app').style.setProperty('--library-w', `${panes.library}px`);
    if (panes.inspector) $('app').style.setProperty('--inspector-w', `${panes.inspector}px`);
    if (panes.dock) $('app').style.setProperty('--dock-h', `${panes.dock}px`);
  }
} catch { /* ignore */ }

function uiZoom() {
  const z = parseFloat(getComputedStyle($('app')).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function bindSplit(el) {
  const pane = el.dataset.pane;
  let pointer = 0;
  let start = 0;
  let origin = 0;
  const limits = pane === 'library' ? [160, 560] : pane === 'inspector' ? [220, 640] : [200, 900];
  const prop = pane === 'library' ? '--library-w' : pane === 'inspector' ? '--inspector-w' : '--dock-h';
  const onMove = (e) => {
    if (e.pointerId !== pointer) return;
    const scale = uiZoom();
    const point = pane === 'dock' ? e.clientY : e.clientX;
    const delta = pane === 'library' ? point - start : start - point;
    const cap = pane === 'dock' ? Math.min(limits[1], window.innerHeight * 0.75) : limits[1];
    const next = Math.round(Math.min(cap, Math.max(limits[0], origin + delta / scale)));
    $('app').style.setProperty(prop, `${next}px`);
  };
  const onUp = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = 0;
    el.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    savePanes();
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || isPerformMode) return;
    e.preventDefault();
    pointer = e.pointerId;
    start = pane === 'dock' ? e.clientY : e.clientX;
    origin = parseFloat(getComputedStyle($('app')).getPropertyValue(prop));
    if (!Number.isFinite(origin)) {
      const box = (pane === 'dock' ? document.querySelector('.dock') : document.querySelector(pane === 'library' ? '.library' : '.inspector')).getBoundingClientRect();
      origin = (pane === 'dock' ? box.height : box.width) / uiZoom();
    }
    el.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}
for (const id of ['split-library', 'split-inspector', 'split-dock']) bindSplit($(id));

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('screen-menu').hidden = true;
  if (!$('output-map-modal').hidden) openOutputMap(false);
  if (!$('prefs-modal').hidden) openPrefs(false);
});
$('fs-btn').addEventListener('click', toggleFullscreen);

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target?.matches?.('input[type="text"], input[type="password"], input[type="number"], textarea')) return;
  const k = e.key.toLowerCase();

  if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    const slot = Number(e.code.slice(5)) - 1;
    const scene = slot < sceneBar.bankSize ? scenes.scenes[sceneBar.bank * sceneBar.bankSize + slot] : null;
    if (scene) triggerScene(scene.id);
  } else if (k === ' ') {
    if (e.target?.matches?.('button, select, input')) return;
    e.preventDefault();
    if (masterTransport.state === 'playing') masterPause();
    else masterPlay();
  } else if (/^[1-9]$/.test(k) && Number(k) <= MODES.length) {
    params.set(layerParam(panel.selected, 'mode'), Number(k) - 1);
  } else if (k === 'q' || k === 'w' || k === 'e') {
    panel.selectLayer(LAYERS['qwe'.indexOf(k)]);
  } else if (k === 't') tapTempo();
  else if (isPerformMode && (k === 'l' || k === 'h' || k === 'c' || k === 'p')) return;
  else if (k === 'l') setUiMode(document.body.classList.contains('live-mode') ? 'timeline' : 'live');
  else if (k === 'h') setHudEnabled(!hud.visible);
  else if (k === 'c') {
    setHudDisplay(HUD_MODES[(HUD_MODES.indexOf(hud.display) + 1) % HUD_MODES.length]);
  }
  else if (k === 'p') togglePanel();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'r') toggleRecording();
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- loop
// Display timestamps come from requestAnimationFrame, which is performance.now().
// Uniforms are written straight onto the shader materials. Slider and meter DOM
// updates stay on the 30Hz gate below.
let frameStamp = 0;
let fps = 60;
let masterSpeed = 1;
let shaderTime = 0;
const meters = [
  ['kick', 'm-kick'],
  ['snare', 'm-snare'],
  ['songEnergy', 'm-energy'],
  ['isBreakdown', 'm-break'],
  ['dropPulse', 'm-drop'],
].map(([k, id]) => [k, $(id)]);
let lastPanelUpdate = 0;
const meterWidths = ['', '', '', '', ''];
let fpsLabel = '';
let recLabel = null;
let ledOpacity = '';
let ledDown = false;
const place = { scale: 1, x: 0, y: 0, maskX: 1, maskY: 1, maskOn: false };
const BLEND_SHORT = ['normal', 'multiply', 'screen', 'dodge', 'difference', 'add', 'exclusion', 'overlay'];

function frame(stamp) {
  const nowMs = typeof stamp === 'number' && stamp > 0 ? stamp : performance.now();
  const dt = frameStamp > 0 ? Math.min((nowMs - frameStamp) / 1000, 0.1) : 0;
  frameStamp = nowMs;
  const now = nowMs / 1000;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  timeline.update(dt); // crosses a scene marker -> triggerScene()
  scenes.update(dt);
  if (!bpmEngine.attached && audio.ctx && audio.graph) {
    audio.connectBpm(bpmEngine.attach(audio.ctx));
  }
  audio.syncPeak(bpmEngine);
  bpmEngine.update(dt, now);
  if (timeline.playing) {
    beatClock.sync(timeline.beat);
    bpmEngine.beats = timeline.beat;
  } else {
    beatClock.beats = bpmEngine.beats;
    beatClock.setBpm(bpmEngine.bpm);
  }
  if (bpmEngine.consumeChange()) timeline.set('bpm', bpmEngine.bpm);
  shared.uBeat.value = beatClock.pulse;
  shared.uBeatPhase.value = beatClock.phase;

  const a = audio.update(dt, now);
  const motionDt = dt * masterSpeed;
  shaderTime += motionDt;
  shared.uTime.value = shaderTime;
  if (controls.enabled) controls.update();
  for (const l of layers) l.tickMedia(dt, renderer, fitMode);

  const live = lfo.update({
    now: shaderTime,
    dt: motionDt,
    beats: beatClock.beats,
    bpm: beatClock.bpm,
    params,
    audio: a,
    beat: beatClock.pulse,
    mods,
  });
  macros.apply(live);
  for (const id of panel.held) live.delete(id);
  for (const l of layers) l.liveOverride.clear();
  for (const [id, value] of live) {
    const def = params.defs.get(id);
    if (!def?.layer) continue;
    const layer = layerById[def.layer];
    layer.liveOverride.set(def.key, value);
    layer.setUniform(def.key, value);
  }
  for (const def of panel.bypassed || []) {
    const n = neutralOf(def);
    const layer = layerById[def.layer];
    layer.liveOverride.set(def.key, n);
    layer.setUniform(def.key, n);
  }
  momentary.apply(layers, grade, now);
  const gainDef = params.defs.get('audioGain');
  audio.gain = gainDef && panel.isBypassed(gainDef)
    ? neutralOf(gainDef)
    : (live.has('audioGain') ? live.get('audioGain') : params.get('audioGain'));

  // Pass 1: each layer runs its own engine, bottom to top, then the compositor blends them.
  const particleWants = (id) => layers.some((other) => {
    if (!other.active || other.engine !== ENGINE_PARTICLES || other.id === id) return false;
    const src = other.get('pSource');
    return (src === 1 && id === 'A') || (src === 2 && id === 'B');
  });
  const blackout = masterTransport.state === 'stopped';
  const soloing = bus.anySolo();
  let soloBase = null;
  if (soloing) {
    for (const l of layers) {
      const include = l.active && bus.audible(l.id) && !(blackout && syncMaster[l.id]);
      if (include) {
        soloBase = l.id;
        break;
      }
    }
  }
  let picture = false;
  layers.forEach((l, i) => {
    const audible = bus.audible(l.id);
    l.opaqueBase = soloing && l.id === soloBase;
    const uv = l.uniforms.uUvScale.value;
    const masked = fitMode === 'fit' && l.engine === ENGINE_FX && !l.is3D && l.uniforms.uHasInput.value > 0.5;
    place.scale = l.get('scale') * l.entryZoom;
    place.x = l.get('posX');
    place.y = l.get('posY');
    place.maskX = uv.x;
    place.maskY = uv.y;
    place.maskOn = masked;
    if (l.active || particleWants(l.id)) {
      l.applyAudio(a);
      l.render(renderer, renderCtx, dt, layerById, place);
    }
    const shown = l.active && audible && !(blackout && syncMaster[l.id]);
    if (shown) picture = true;
    const letter = l.id;
    comp[`uLayer${letter}Mix`].value = shown ? l.get('opacity') * l.entryAlpha : 0;
    comp[`uLayer${letter}BlendMode`].value = l.get('blend');
    comp[`uLayer${letter}Invert`].value = l.get('blendInvert') > 0.5 ? 1 : 0;
    comp[`uLayer${i}`].value = shown ? l.texture : blankTexture;
    if (l.bakedTransform) {
      comp[`uXform${i}`].value.set(1, 0, 0);
      comp[`uMask${i}`].value.set(uv.x, uv.y, masked ? 1 : 0);
    } else {
      comp[`uXform${i}`].value.set(place.scale, place.x, place.y);
      comp[`uMask${i}`].value.set(uv.x, uv.y, masked ? 1 : 0);
    }
  });

  // Mix A/B/C into the master frame, crossfade a scene launch, then grade the result.
  quad.material = compMaterial;
  renderer.setRenderTarget(stackRt);
  if (soloing) {
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.setClearColor(0x000000, 0);
  }
  renderer.render(quadScene, camera2d);

  xfade.uCurrent.value = stackRt.texture;
  xfade.uHold.value = holdRt.texture;
  xfade.uXfade.value = scenes.transition ? scenes.progress : 1;
  xfade.uStyle.value = timeline.fadeStyle;
  quad.material = xfadeMaterial;
  renderer.setRenderTarget(mixRt);
  renderer.render(quadScene, camera2d);

  const g = (id) => {
    const def = params.defs.get(id);
    if (def && panel.isBypassed(def)) return neutralOf(def);
    return live.get(id) ?? params.get(id);
  };
  const strobeSrc = params.get('strobeSrc') | 0;
  const strobeSig = strobeSrc === 1 ? beatClock.pulse : strobeSrc === 2 ? (a.dropPulse || 0) : 1;
  grade.uTex.value = mixRt.texture;
  grade.uMaster.value = g('master');
  grade.uHue.value = g('gradeHue');
  grade.uSat.value = g('gradeSat');
  grade.uContrast.value = g('gradeContrast');
  grade.uScan.value = g('crtScan');
  grade.uBleed.value = g('crtBleed');
  grade.uBarrel.value = g('crtBarrel');
  grade.uChroma.value = g('chroma');
  grade.uStrobe.value = Math.min(1, Math.max(0, g('strobe') * strobeSig));
  grade.uStrobeBlack.value = (params.get('strobePol') | 0) === 1 ? 1 : 0;
  quad.material = gradeMaterial;
  renderer.setRenderTarget(composeRt);
  renderer.render(quadScene, camera2d);

  stings.update(renderer);

  const pins = outputMap.glPins();
  warp.uTex.value = composeRt.texture;
  warp.uBL.value.set(pins.bl[0], pins.bl[1]);
  warp.uBR.value.set(pins.br[0], pins.br[1]);
  warp.uTR.value.set(pins.tr[0], pins.tr[1]);
  warp.uTL.value.set(pins.tl[0], pins.tl[1]);
  warp.uMask.value = outputMap.maskIndex();
  warp.uIdentity.value = outputMap.identity && outputMap.mask === 'none' ? 1 : 0;
  warp.uAspect.value = composeRt.width / Math.max(1, composeRt.height);
  warp.uBezel.value = outputMap.bezel;
  quad.material = warpMaterial;

  if (stings.live) {
    renderer.setRenderTarget(stingRt);
    renderer.render(quadScene, camera2d);
    sting.uBase.value = stingRt.texture;
    sting.uAspect.value = stingRt.width / Math.max(1, stingRt.height);
    stings.bind(sting);
    quad.material = stingMaterial;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, camera2d);
  } else {
    renderer.setRenderTarget(null);
    if (blackout && !picture) clearMasterCanvas();
    else renderer.render(quadScene, camera2d);
  }

  sceneBar.updatePlayhead();

  const led = $('beat-led');
  const nextOpacity = (0.15 + 0.85 * beatClock.pulse).toFixed(2);
  if (nextOpacity !== ledOpacity) {
    ledOpacity = nextOpacity;
    led.style.opacity = nextOpacity;
  }
  const nextDown = beatClock.beatInBar === 0;
  if (nextDown !== ledDown) {
    ledDown = nextDown;
    led.classList.toggle('down', nextDown);
  }

  if (now - lastPanelUpdate > 1 / 30) {
    lastPanelUpdate = now;
    if (!isPerformMode) {
      diag.tick({
        params,
        lfo,
        mods,
        layers,
        audible: (id) => bus.audible(id),
        renderScale,
        bypassed: (def) => panel.isBypassed(def),
      }, dt);
    }
    const bpmReadout = $('bpm-value');
    if (bpmReadout && bpmReadout.dataset.editing !== '1') {
      const bpmText = formatBpm(bpmEngine.bpm);
      if (bpmReadout.textContent !== bpmText) bpmReadout.textContent = bpmText;
      bpmReadout.parentElement.classList.toggle('locked', bpmSource !== 'auto');
      bpmReadout.parentElement.classList.toggle('sync', bpmSource === 'auto');
    }
    panel.tickLive(live);
    const hudSize = mods.modulate({ min: 10, max: 48 }, Number($('hud-size').value), 'hud.size', a, beatClock.pulse);
    if (Math.abs((hud.chrome?.size ?? hudSize) - hudSize) > 0.05) hud.applyChrome({ size: hudSize });
    if (!isPerformMode) {
      for (let i = 0; i < meters.length; i++) {
        const [k, el] = meters[i];
        const width = `${(Math.min(1, a[k]) * 100).toFixed(1)}%`;
        if (width === meterWidths[i]) continue;
        meterWidths[i] = width;
        el.style.width = width;
      }
      audio.drawMonitor($('audio-fft'));
    }
    apcView.tick();
    apcLeds.flush(ledMap(apcView.page, apcView.ledContext()));
    const fpsText = `${fps.toFixed(0)} fps`;
    if (fpsText !== fpsLabel) {
      fpsLabel = fpsText;
      $('fps').textContent = fpsText;
    }
    if (!$('audio-file-row').hidden) syncTransport();
    syncVideoTransport();
    sceneBar.updateActive();
    syncOutputBtn();
    if (selectedLayer().mediaStatus !== $('layer-status').textContent) {
      setStatus($('layer-status'), selectedLayer().mediaStatus, selectedLayer().mediaError);
    }
    const t = recorder.elapsed;
    const recText = recorder.recording
      ? `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`
      : '';
    if (recText !== recLabel) {
      recLabel = recText;
      $('rec-time').textContent = recText;
    }

  const paintHud = hud.visible && (!isPerformMode || document.body.classList.contains('hud-perform') || outputWin.overlayOn);
  if (paintHud) {
    const sel = selectedLayer();
    if (hud.display === 'scan') {
      scanTick += 1;
      if (scanTick % 8 === 0) {
        const prevMat = quad.material;
        copyMaterial.uniforms.uTex.value = composeRt.texture;
        quad.material = copyMaterial;
        renderer.setRenderTarget(scanRt);
        renderer.render(quadScene, camera2d);
        scanLog.sample(renderer, scanRt);
        renderer.setRenderTarget(null);
        quad.material = prevMat;
      }
      hud.showScan(scanLog.tick(dt, { layers, audio, a, beat: beatClock, now }));
    } else if (hud.display === 'glsl') {
      const file = overlayShaderSource(sel);
      hud.showGlsl({
        id: `${file.name}:${sel.engine}`,
        title: file.name,
        source: file.source,
        values: {
          ...sel.liveUniforms(),
          uSubBass: a.sub || 0,
          uPunch: a.punch || 0,
          uMids: a.mid || 0,
          uBeatPulse: a.beatPulse || 0,
          uPeakFlash: a.peakFlash || 0,
          uSongEnergy: a.songEnergy || 0,
          uIsBreakdown: a.isBreakdown || 0,
          uDropPulse: a.dropPulse || 0,
        },
      });
    } else if (hud.display === 'formula') {
      hud.showLive(liveFormulaModel(layers, a, dt), 'formula');
    } else if (hud.display === 'matrix') {
      hud.showLive(liveStackModel(layers, a, dt, hud.glyph, audio.active), 'matrix');
    } else if (hud.display === 'audio') {
      hud.showAudio({ audio: a, fps });
    } else {
      const res = shared.uResolution.value;
      hud.update(
        {
          title: `LAYER ${sel.id} \u00b7 ${sel.mode.toUpperCase()}`,
          layers: layers.map((l) => {
            const mark = l.id === sel.id ? '>' : ' ';
            const flags = `${bus.mute[l.id] ? 'M' : ' '}${bus.solo[l.id] ? 'S' : ' '}`;
            return `${mark}${l.id}${flags} ${l.mode.padEnd(7)} op ${l.get('opacity').toFixed(2)}  ${BLEND_SHORT[l.get('blend')].padEnd(10)} ${l.mediaLabel}`;
          }),
          uniforms: { uMaster: params.get('master'), ...sel.liveUniforms() },
          fps,
          audio: a,
          midi: lastMidi,
          resolution: `${res.x}x${res.y}`,
          recording: recorder.recording ? $('rec-time').textContent : '',
          timeline: `${timeline.playing ? '\u25B6' : '\u275A\u275A'} ${$('tl-pos').textContent}  ${timeline.bpm} bpm`,
          clock: { pulse: beatClock.pulse, text: `${formatBpm(beatClock.bpm)} bpm  ${bpmSource}  beat ${beatClock.beatInBar + 1}/4` },
        },
        now,
      );
    }
    if (outputWin.overlayOn) pushOverlay(false);
    }
  }
  // Copy the finished WebGL frame after the HUD text has settled, so the recording
  // and the output window do not grab a line that is still scrolling into place.
  const hudFrame = hud.visible ? hud.recordOverlay() : null;
  if (recorder.recording) recorder.paint(renderer.domElement, hudFrame);
  outputWin.mirror(outputWin.overlayOn ? hudFrame : null);
  if (performHolding) paintPerformHold();
}

refreshLayerUi();
syncHudShader();

async function restoreCachedMedia() {
  await library.ready;
  refreshLayerUi();
  const name = localStorage.getItem('vj.audioFile');
  if (!name) return;
  const file = await library.getAudio(name);
  if (!file) return;
  showAudioMode('file');
  try {
    await audio.loadFile(file, { autoplay: false });
    audio.setLoop($('audio-loop').checked);
    setStatus($('audio-status'), file.name);
    syncTransport();
  } catch (err) {
    setStatus($('audio-status'), err.message, true);
  }
}
restoreCachedMedia();

// Focused: requestAnimationFrame, whose timestamp is performance.now().
// Blurred or hidden: a worker interval, because requestAnimationFrame stalls
// when this window loses focus and the output mirror would freeze.
// Only one clock runs. A leftover display callback must not schedule another frame.
let clockMode = '';
let nextPump = 0;
let fallbackTimer = 0;
let rafHandle = 0;
let framePump = null;
try {
  framePump = new Worker(new URL('./clock/framePump.js', import.meta.url));
  framePump.onmessage = () => {
    if (clockMode !== 'background') return;
    const now = performance.now();
    if (now < nextPump) return;
    nextPump = now + 14;
    frame(now);
  };
} catch {
  framePump = null;
}

function onDisplayFrame(stamp) {
  if (clockMode !== 'display') return;
  rafHandle = requestAnimationFrame(onDisplayFrame);
  frame(stamp);
}

function stopBackgroundClock() {
  framePump?.postMessage('stop');
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = 0;
  }
}

function stopDisplayClock() {
  if (!rafHandle) return;
  cancelAnimationFrame(rafHandle);
  rafHandle = 0;
}

function useDisplayClock() {
  if (clockMode === 'display') return;
  clockMode = 'display';
  stopBackgroundClock();
  frameStamp = 0;
  rafHandle = requestAnimationFrame(onDisplayFrame);
}

function useBackgroundClock() {
  if (clockMode === 'background') return;
  clockMode = 'background';
  stopDisplayClock();
  frameStamp = 0;
  nextPump = 0;
  if (framePump) framePump.postMessage('start');
  else if (!fallbackTimer) fallbackTimer = setInterval(() => frame(performance.now()), 1000 / 60);
}

function syncFrameClock() {
  if (document.hidden || !document.hasFocus()) useBackgroundClock();
  else useDisplayClock();
}

document.addEventListener('visibilitychange', syncFrameClock);
window.addEventListener('blur', useBackgroundClock);
window.addEventListener('focus', () => {
  if (!document.hidden) useDisplayClock();
});
syncFrameClock();

function bindHoverTips() {
  const tip = document.createElement('div');
  tip.id = 'hover-tip';
  tip.className = 'hover-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);

  const place = (event) => {
    const pad = 14;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    const box = tip.getBoundingClientRect();
    if (box.right > window.innerWidth - 8) x = event.clientX - box.width - pad;
    if (box.bottom > window.innerHeight - 8) y = event.clientY - box.height - pad;
    tip.style.left = `${Math.max(8, Math.round(x))}px`;
    tip.style.top = `${Math.max(8, Math.round(y))}px`;
  };

  const bind = (el) => {
    if (!(el instanceof Element) || el.dataset.tipBound) return;
    if (!el.hasAttribute('data-help') && !el.hasAttribute('title')) return;
    el.dataset.tipBound = '1';
    el.addEventListener('mouseenter', (event) => {
      const text = el.getAttribute('data-help') || el.getAttribute('title');
      if (!text) return;
      if (!el.hasAttribute('data-help') && el.hasAttribute('title')) {
        el.dataset.tipTitle = el.getAttribute('title');
        el.removeAttribute('title');
      }
      tip.textContent = text;
      tip.hidden = false;
      place(event);
    });
    el.addEventListener('mousemove', (event) => {
      if (!tip.hidden) place(event);
    });
    el.addEventListener('mouseleave', () => {
      if (el.dataset.tipTitle != null) {
        el.setAttribute('title', el.dataset.tipTitle);
        delete el.dataset.tipTitle;
      }
      tip.hidden = true;
    });
  };

  document.querySelectorAll('[data-help], [title]').forEach(bind);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) bind(record.target);
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        bind(node);
        node.querySelectorAll('[data-help], [title]').forEach(bind);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['title', 'data-help'],
  });
}
bindHoverTips();
