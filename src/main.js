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
import { bindPictureSend } from './output/PictureSend.js';
import { bindPictureSources, pictureSources, refreshPictureSources } from './input/PictureRecv.js';
import { bindRangeReadout } from './ui/NumericSlider.js';
import { beginDrag, endDragSoon } from './ui/dragPayload.js';
import { bindMediaPrep } from './media/mediaPrep.js';
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
import { SCREEN_EM_SHADE, SCREEN_MARK_SHADE, screenShadow } from './overlay/paintScreensaver.js';
import { ApcView } from './ui/ApcView.js';
import { ApcLeds, ledMap } from './midi/ApcMiniMk2.js';

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
  uMask0: { value: 0 },
  uMask1: { value: 0 },
  uMask2: { value: 0 },
  uFx0: { value: 0 },
  uFx1: { value: 0 },
  uFx2: { value: 0 },
  uFxAmt0: { value: 0 },
  uFxAmt1: { value: 0 },
  uFxAmt2: { value: 0 },
};
const stingMaterial = new THREE.ShaderMaterial({
  uniforms: sting,
  vertexShader,
  fragmentShader: stingFrag,
  depthTest: false,
  depthWrite: false,
});
const stingRt = new THREE.WebGLRenderTarget(1, 1, STACK_RT);
const stings = new StingRack($('logo-overlay'), { onChange: () => apcView?.refresh() });
document.querySelectorAll('#live-tools .sting-fire').forEach((btn) => {
  btn.addEventListener('click', () => stings.trigger(Number(btn.dataset.sting)));
});
function openProjectFold(id) {
  if (deskMode !== 'live') setDeskMode('live');
  document.body.classList.remove('panel-hidden');
  setLibraryOpen(true);
  const fold = $(id);
  if (fold) fold.open = true;
  fold?.querySelector('summary')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
$('brand-define')?.addEventListener('click', () => openProjectFold('logo-overlay'));
$('code-define')?.addEventListener('click', () => openProjectFold('code-overlay'));
$('screen-define')?.addEventListener('click', () => openProjectFold('screensaver'));
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
  sel.append(pictureSourceGroup(layer));
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

function pictureKindLabel() {
  if (pictureSources.localKind) return pictureSources.localKind;
  return /Mac|iPhone|iPad/i.test(navigator.userAgent) ? 'Syphon' : 'Spout';
}

function pictureSourceGroup(layer) {
  const group = document.createElement('optgroup');
  group.label = `NDI / ${pictureKindLabel()}`;
  const key = layer.mediaKey || '';
  const named = key.startsWith('ndi:') || key.startsWith('spout:');
  const currentName = named ? key.slice(key.indexOf(':') + 1) : '';
  const hold = (text) => {
    if (currentName) group.append(new Option(currentName, key));
    const opt = new Option(text, 'picture-none');
    opt.disabled = true;
    group.append(opt);
  };
  if (!isTauri()) {
    hold('Desktop app');
    return group;
  }
  if (!pictureSources.ready) {
    hold('Looking...');
    return group;
  }
  for (const name of pictureSources.ndi) group.append(new Option(name, `ndi:${name}`));
  for (const name of pictureSources.local) group.append(new Option(name, `spout:${name}`));
  if (currentName) {
    const listed = key.startsWith('ndi:')
      ? pictureSources.ndi.includes(currentName)
      : pictureSources.local.includes(currentName);
    if (!listed) group.append(new Option(`(gone) ${currentName}`, key));
  }
  if (!group.children.length) {
    const opt = new Option('No senders', 'picture-none');
    opt.disabled = true;
    group.append(opt);
  }
  return group;
}

function layerThumb(layer) {
  const key = layer.mediaKey || 'none';
  if (key === 'none') return '';
  const cut = key.indexOf(':');
  const name = cut >= 0 ? key.slice(cut + 1) : '';
  if (key.startsWith('file:') || key.startsWith('url:')) {
    const still = library.mediaItem(name)?.thumbnail;
    if (still) return still;
  }
  const video = layer.input?.video;
  if (!video || video.readyState < 2 || (video.videoWidth | 0) < 2) return '';
  const canvas = layerThumb.canvas || (layerThumb.canvas = Object.assign(document.createElement('canvas'), { width: 60, height: 34 }));
  const ctx = canvas.getContext('2d', { alpha: false });
  try {
    ctx.drawImage(video, 0, 0, 60, 34);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return '';
  }
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
  for (const l of layers) {
    panel.setStripMedia(l.id, l.mediaKey === 'none' ? '' : l.mediaLabel, layerThumb(l));
  }
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
      const itemData = {
        id: item?.id || name,
        name,
        source: 'clip',
        kind: item?.kind || 'video',
      };
      beginDrag(e, itemData);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        type: 'SCENE_OR_CLIP',
        id: itemData.id,
        name: itemData.name,
        data: itemData,
      }));
    });
    card.addEventListener('dragend', () => endDragSoon());
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
  if (v === 'picture-none') {
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
let pictureMenuDirty = false;
$('layer-media').addEventListener('focus', () => {
  library.refreshCameras().catch(() => {});
  refreshPictureSources().catch(() => {});
});
$('layer-media').addEventListener('blur', () => {
  if (!pictureMenuDirty) return;
  pictureMenuDirty = false;
  refreshMediaSelect();
});
$('layer-media-refresh').addEventListener('click', () => {
  library.refreshCameras().catch(() => {});
  refreshPictureSources().catch(() => {});
});
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

const SOURCE_LABEL = {
  wikimedia: 'Wikimedia',
  archive: 'Internet Archive',
};

function libraryName(clip) {
  let file = 'loop.mp4';
  try {
    const leaf = decodeURIComponent(new URL(clip.videoUrl).pathname.split('/').pop() || '');
    if (/\.(mp4|webm)$/i.test(leaf)) file = leaf;
  } catch { /* keep the fallback name */ }
  const ext = file.match(/\.(mp4|webm)$/i)?.[0].toLowerCase() || '.mp4';
  const stem = file.slice(0, -ext.length).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 48) || clip.id;
  const name = `${stem}${ext}`;
  const existing = library.mediaItem(name);
  if (!existing || existing.url === clip.videoUrl || (existing.file && !existing.url)) return name;
  return `${clip.source}-${clip.id}${ext}`;
}

const STOCK_DIR_KEY = 'vj.stockDir';
let toastTimer = 0;

function showToast(text, isError = false) {
  const el = $('app-toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 4200);
}

function paintStockDir(path) {
  const input = $('stock-dir');
  if (!input) return;
  input.value = path || '';
  input.title = path || 'Videos folder';
}

async function ensureStockDir() {
  let saved = '';
  try { saved = localStorage.getItem(STOCK_DIR_KEY)?.trim() || ''; } catch { saved = ''; }
  if (saved) {
    paintStockDir(saved);
    return saved;
  }
  if (!isTauri()) {
    paintStockDir('');
    return '';
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const dir = await invoke('default_stock_dir');
  try { localStorage.setItem(STOCK_DIR_KEY, dir); } catch { /* private mode */ }
  paintStockDir(dir);
  return dir;
}

async function fileFromStock(clip) {
  const filename = libraryName(clip);
  const type = /\.webm$/i.test(filename) ? 'video/webm' : 'video/mp4';
  let blob;
  if (isTauri()) {
    const saveDir = await ensureStockDir();
    const { convertFileSrc, invoke } = await import('@tauri-apps/api/core');
    const path = await invoke('download_video', { url: clip.videoUrl, filename, saveDir });
    const assetUrl = convertFileSrc(path);
    const res = await fetch(assetUrl);
    if (!res.ok) throw new Error('Download failed');
    blob = await res.blob();
  } else {
    const res = await fetch(clip.videoUrl);
    if (!res.ok) throw new Error('Download failed');
    blob = await res.blob();
  }
  return new File([blob], filename, { type: blob.type || type });
}

async function downloadClip(clip, card) {
  if (card.dataset.busy === '1') return;
  card.dataset.busy = '1';
  card.classList.add('downloading');
  card.classList.remove('failed');
  const source = card.querySelector('i');
  const previous = source.textContent;
  source.textContent = 'Downloading...';
  try {
    const file = await fileFromStock(clip);
    const added = library.add([file]);
    if (!added.length) throw new Error('Download failed');
    await assignMediaToLayer(added[0], panel.selected);
    source.textContent = 'In library';
    setOnlineStatus(`Saved ${added[0]} on layer ${panel.selected}.`);
    showToast(`Saved ${added[0]}`);
  } catch (err) {
    card.classList.add('failed');
    source.textContent = 'Download failed';
    setOnlineStatus(err?.message || 'Download failed', true);
    showToast('Download failed', true);
    window.setTimeout(() => {
      if (source.textContent === 'Download failed') source.textContent = previous;
      card.classList.remove('failed');
    }, 2400);
  } finally {
    card.dataset.busy = '0';
    card.classList.remove('downloading');
  }
}

function renderOnlineResults(clips) {
  const host = $('online-results');
  host.innerHTML = '';
  host.hidden = !clips.length;
  for (const clip of clips) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'online-hit';
    card.draggable = false;
    card.title = clip.title;
    const img = document.createElement('img');
    img.alt = '';
    if (clip.thumbnail) img.src = clip.thumbnail;
    else img.hidden = true;
    img.addEventListener('error', () => { img.hidden = true; });
    const title = document.createElement('b');
    title.textContent = clip.title;
    const source = document.createElement('i');
    source.textContent = SOURCE_LABEL[clip.source] || clip.source;
    card.append(img, title, source);
    card.addEventListener('click', () => { downloadClip(clip, card); });
    host.append(card);
  }
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
  setOnlineStatus('Searching stock video…');
  $('online-fetch').disabled = true;
  try {
    const clips = await fetchVideoLoop(source, prompt);
    renderOnlineResults(clips);
    setOnlineStatus(`${clips.length} clip${clips.length === 1 ? '' : 's'}.`);
  } catch (err) {
    renderOnlineResults([]);
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
  if (e.target?.closest?.('#tl-track, #media-prep')) return;
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
  apcView?.followLayer(id);
};

// ---------------------------------------------------------------- scenes + timeline
const project = new ProjectState();

const FOLD_LOCKS = ['acc-audio', 'acc-master', 'acc-output', 'code-overlay', 'logo-overlay', 'screensaver'];
const COMP_LOCKS = ['Color & Texture', 'Distortion & Glitch', 'Motion & Timing'];

function lockButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'section-lock';
  btn.dataset.lock = id;
  btn.textContent = 'Lock';
  btn.title = 'Lock this section. Its controls stay put and Shuffle skips it.';
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = { ...project.locks };
    if (next[id]) delete next[id];
    else next[id] = true;
    project.setLocks(next);
    applyLocks();
  });
  return btn;
}

function mountLockButtons() {
  for (const id of FOLD_LOCKS) {
    const summary = document.querySelector(`#${id} > summary`);
    if (!summary || summary.querySelector('.section-lock')) continue;
    summary.append(lockButton(id));
  }
  for (const name of COMP_LOCKS) {
    const block = document.querySelector(`#master-params .fx-block[data-group="${CSS.escape(name)}"]`);
    const title = block?.querySelector('.fx-toggle');
    if (!title || block.querySelector('.section-lock')) continue;
    title.after(lockButton(name));
  }
}

function applyLocks() {
  const locks = project.locks || {};
  for (const btn of document.querySelectorAll('.section-lock')) {
    const on = !!locks[btn.dataset.lock];
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  for (const id of FOLD_LOCKS) {
    const fold = document.getElementById(id);
    if (!fold) continue;
    fold.classList.toggle('locked', !!locks[id]);
    for (const child of fold.children) {
      if (child.tagName === 'SUMMARY') continue;
      child.inert = !!locks[id];
    }
  }
  for (const name of COMP_LOCKS) {
    const block = document.querySelector(`#master-params .fx-block[data-group="${CSS.escape(name)}"]`);
    if (!block) continue;
    const on = !!locks[name];
    block.classList.toggle('locked', on);
    const body = block.querySelector('.fx-body');
    if (body) body.inert = on;
    const shuffle = block.querySelector('button.shuffle');
    if (shuffle) shuffle.disabled = on;
  }
}

panel.isSectionLocked = (layer, group) => layer === 'master' && !!project.locks[group];
mountLockButtons();
applyLocks();

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
  onSaveError: (text) => showToast(text, true),
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
  setBpmMode('manual');
  if (timeline.playing) timeline.seek(Math.round(timeline.beat));
  if (!timeline.playing) {
    beatClock.beats = bpmEngine.beats;
    beatClock.setBpm(bpmEngine.bpm);
  }
  if (result.bpmChanged) timeline.set('bpm', bpmEngine.bpm);
  else syncTempoUi();
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
    if (bpmMode !== 'manual') setBpmMode('manual');
    bpmEngine.setBpm(timeline.bpm);
  }
  syncTempoUi();
});
syncTempoUi();

$('bpm-slider').addEventListener('input', (e) => {
  if (bpmMode === 'auto' || e.target.disabled) return;
  setTempo(Number(e.target.value));
});
$('bpm-slider').addEventListener('dblclick', () => {
  if (bpmMode === 'auto') return;
  setTempo(120);
});
$('bpm-value').addEventListener('pointerdown', () => {
  if (bpmMode === 'auto') setBpmMode('manual');
}, true);
$('bpm-tap').addEventListener('click', tapTempo);
$('bpm-double').addEventListener('click', () => {
  setBpmMode('manual');
  setTempo(bpmEngine.double());
});
$('bpm-half').addEventListener('click', () => {
  setBpmMode('manual');
  setTempo(bpmEngine.halve());
});
$('bpm-nudge-up').addEventListener('click', () => {
  setBpmMode('manual');
  setTempo(bpmEngine.nudge(1));
});
$('bpm-nudge-down').addEventListener('click', () => {
  setBpmMode('manual');
  setTempo(bpmEngine.nudge(-1));
});

let bpmMode = 'manual';
let bpmNoticeUntil = 0;
let bpmFlashUntil = 0;

function closeBpmEditor() {
  const readout = $('bpm-value');
  const editor = readout?.nextElementSibling;
  if (readout?.dataset.editing === '1' && editor?.classList.contains('inline-num')) {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
}

function showBpmNotice(text, ms) {
  $('bpm-mode').textContent = text;
  bpmNoticeUntil = performance.now() + ms;
}

function setBpmMode(src) {
  bpmMode = src === 'auto' ? 'auto' : 'manual';
  bpmEngine.setMode(bpmMode);
  if (bpmMode === 'auto') bpmEngine.beginAnalysis(performance.now() / 1000);
  const auto = bpmMode === 'auto';
  const btn = $('bpm-mode');
  bpmNoticeUntil = 0;
  btn.textContent = auto ? bpmEngine.analyzeLabel() : 'Auto: Read Live';
  btn.classList.toggle('on', auto);
  btn.setAttribute('aria-pressed', auto ? 'true' : 'false');
  btn.title = auto
    ? 'Listening for kicks. The tempo locks in when the beat is clear.'
    : 'Manual tempo. Click to read the live audio.';
  document.body.classList.toggle('bpm-auto', auto);
  $('bpm-slider').disabled = auto;
  const tlBpm = $('tl-bpm');
  if (tlBpm) tlBpm.disabled = auto;
  const readout = $('bpm-value')?.parentElement;
  readout?.classList.toggle('locked', !auto);
  readout?.classList.toggle('sync', auto);
  syncTempoUi();
  const number = $('bpm-value');
  if (number && number.dataset.editing !== '1') {
    if (auto) number.style.opacity = '0.5';
    else if (performance.now() >= bpmFlashUntil) {
      number.style.opacity = '';
      number.style.color = '';
    }
  }
}
$('bpm-mode').addEventListener('click', () => setBpmMode('auto'));

let masterSpeed = 1;
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
  try { localStorage.setItem('vj.uiMode', live ? 'live' : 'timeline'); } catch { /* ignore */ }
}

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
  if (btn) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on
      ? 'Hold to exit Perform Mode'
      : 'Lock the desk for a live set. Hold the button to exit.';
    btn.style.setProperty('--hold', '0');
  }
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
  $('perform-btn')?.style.setProperty('--hold', String(t));
}

$('perform-btn')?.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !isPerformMode) return;
  performHolding = true;
  performHoldStart = performance.now();
  paintPerformHold();
});
window.addEventListener('pointerup', () => {
  if (!performHolding) return;
  const elapsed = performance.now() - performHoldStart;
  performHolding = false;
  $('perform-btn')?.style.setProperty('--hold', '0');
  if (isPerformMode && elapsed >= PERFORM_HOLD_MS) {
    performSuppressClick = true;
    setPerformMode(false);
  }
});
window.addEventListener('pointercancel', () => {
  performHolding = false;
  $('perform-btn')?.style.setProperty('--hold', '0');
});
$('perform-btn')?.addEventListener('click', () => {
  if (performSuppressClick) {
    performSuppressClick = false;
    return;
  }
  if (!isPerformMode) setPerformMode(true);
});
function setLibraryOpen(open) {
  document.body.classList.toggle('sys-collapsed', !open);
  const box = $('view-library');
  if (box) box.checked = !!open;
  try { localStorage.setItem('vj.library', open ? '1' : '0'); } catch { /* ignore */ }
}
const PANEL_KEY = 'vj.panels';
const PANEL_TOGGLES = [
  ['view-timeline', 'hide-timeline'],
  ['view-inspector', 'hide-inspector'],
  ['view-layer-a', 'hide-layer-a'],
  ['view-layer-b', 'hide-layer-b'],
  ['view-layer-c', 'hide-layer-c'],
  ['view-composition', 'hide-composition'],
];
function bindPanelToggles() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}') || {}; } catch { /* ignore */ }
  const write = () => {
    const next = {};
    for (const [id] of PANEL_TOGGLES) next[id] = !!$(id)?.checked;
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  for (const [id, className] of PANEL_TOGGLES) {
    const box = $(id);
    if (!box) continue;
    const on = saved[id] !== false;
    box.checked = on;
    document.body.classList.toggle(className, !on);
    box.addEventListener('change', () => {
      document.body.classList.toggle(className, !box.checked);
      write();
    });
  }
  $('view-library')?.addEventListener('change', () => setLibraryOpen($('view-library').checked));
}
bindPanelToggles();

const SCREEN_TEXT = 'Y2K VJ//BY CÍN\nCUSTOM CODED FOR LATE FUTURE';
const SCREEN_FONTS = {
  desk: 'var(--font)',
  terminal: '"Courier New", "Lucida Console", monospace',
  fixedsys: 'Fixedsys, Terminal, "Courier New", monospace',
  mssans: 'Tahoma, "MS Sans Serif", sans-serif',
};
const SCREEN_COLORS = {
  white: '#f4ffff',
  cyan: '#7af7ff',
  magenta: '#ff8ae4',
  amber: '#ffbf47',
  green: '#7dffb0',
};
const SCREEN_CREDIT = 'OS CC BY-NC-SA // REPO ON GITHUB';

let brandMarkOn = false;
let brandLayout = null;
let brandScale = 100;
let screenText = SCREEN_TEXT;
let screenFont = 'desk';
let screenShade = 8;
let screenBg = 1;
let screenColor = 'white';

function escapeScreenLine(line) {
  return line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\/\//g, '<em>//</em>');
}

function paintScreenText(mark) {
  const lines = String(screenText).replace(/\r\n/g, '\n').split('\n');
  const body = lines.map((line) => {
    const shown = line.length ? escapeScreenLine(line) : '&nbsp;';
    return `<span class="brand-line">${shown}</span>`;
  }).join('');
  const html = `${body}<span class="brand-notice">OS CC BY-NC-SA // <a href="https://github.com/cin-seeds/y2k-vj-by-cin" target="_blank" rel="noopener noreferrer">REPO ON GITHUB</a></span>`;
  if (mark.dataset.screen === html) return;
  mark.innerHTML = html;
  mark.dataset.screen = html;
}

function refreshScreen() {
  brandLayout = null;
  placeBrandMark(performance.now());
}

function setBrandMark(on) {
  brandMarkOn = !!on;
  const box = $('screen-enable');
  if (box) box.checked = brandMarkOn;
  const state = document.querySelector('#live-tools .screen-state');
  if (state) state.textContent = brandMarkOn ? 'On' : 'Off';
  try { localStorage.setItem('vj.screenOn', brandMarkOn ? '1' : '0'); } catch { /* ignore */ }
  refreshScreen();
}

function setBrandScale(value) {
  const next = Math.min(220, Math.max(40, Math.round(Number(value) || 100)));
  brandScale = next;
  const slider = $('brand-size');
  if (slider && slider.value !== String(next)) slider.value = String(next);
  const out = $('brand-size-out');
  if (out) out.textContent = `${next}%`;
  try { localStorage.setItem('vj.brandSize', String(next)); } catch { /* ignore */ }
  refreshScreen();
}

function setScreenText(value) {
  screenText = String(value ?? '');
  const field = $('screen-text');
  if (field && field.value !== screenText) field.value = screenText;
  try { localStorage.setItem('vj.screenText', screenText); } catch { /* ignore */ }
  refreshScreen();
}

function setScreenFont(value) {
  screenFont = SCREEN_FONTS[value] ? value : 'desk';
  const field = $('screen-font');
  if (field) field.value = screenFont;
  try { localStorage.setItem('vj.screenFont', screenFont); } catch { /* ignore */ }
  refreshScreen();
}

function setScreenShade(value) {
  screenShade = Math.min(8, Math.max(0, Math.round(Number(value) || 0)));
  const slider = $('screen-shade');
  if (slider) slider.value = String(screenShade);
  const out = $('screen-shade-out');
  if (out) out.textContent = String(screenShade);
  try { localStorage.setItem('vj.screenShade', String(screenShade)); } catch { /* ignore */ }
  refreshScreen();
}

function setScreenBg(value) {
  screenBg = Math.min(1, Math.max(0, Number(value) || 0));
  const slider = $('screen-bg');
  if (slider) slider.value = String(screenBg);
  const out = $('screen-bg-out');
  if (out) out.textContent = screenBg.toFixed(2);
  try { localStorage.setItem('vj.screenBg', String(screenBg)); } catch { /* ignore */ }
  refreshScreen();
}

function setScreenColor(value) {
  screenColor = SCREEN_COLORS[value] ? value : 'white';
  const field = $('screen-color');
  if (field) field.value = screenColor;
  try { localStorage.setItem('vj.screenColor', screenColor); } catch { /* ignore */ }
  refreshScreen();
}

function layoutBrandMark(mark, wrapW, wrapH) {
  const key = [
    wrapW, wrapH, brandScale, screenShade, screenFont, screenColor,
    screenBg.toFixed(2), screenText,
  ].join('|');
  if (brandLayout?.key === key) return brandLayout;
  paintScreenText(mark);
  const base = Math.min(28, Math.max(16, wrapW / 32));
  const font = Math.max(8, Math.round(base * brandScale / 100));
  const showBox = screenBg > 0;
  mark.style.transform = '';
  mark.style.width = '';
  mark.style.whiteSpace = 'nowrap';
  mark.style.fontSize = `${font}px`;
  mark.style.fontFamily = SCREEN_FONTS[screenFont];
  mark.style.color = SCREEN_COLORS[screenColor];
  mark.style.textShadow = screenShadow(screenShade, SCREEN_MARK_SHADE);
  mark.style.setProperty('--screen-em-shadow', screenShadow(screenShade, SCREEN_EM_SHADE));
  mark.classList.toggle('plain', !showBox);
  mark.style.backgroundColor = showBox ? `rgba(0, 0, 0, ${screenBg})` : 'transparent';
  const padX = Math.max(10, Math.round(font * 0.7));
  const padTop = Math.max(6, Math.round(font * 0.36));
  const padBottom = Math.max(8, Math.round(font * 0.55));
  mark.style.padding = showBox ? `${padTop}px ${padX}px ${padBottom}px` : '0';
  if (mark.hidden) mark.hidden = false;
  let mw = mark.offsetWidth;
  let mh = mark.offsetHeight;
  const fitW = Math.max(1, wrapW - 16);
  const fitH = Math.max(1, wrapH - 16);
  if ((mw > fitW || mh > fitH) && mw > 0 && mh > 0) {
    const scale = Math.min(fitW / mw, fitH / mh);
    mark.style.transform = `scale(${scale})`;
    mw *= scale;
    mh *= scale;
  }
  brandLayout = { key, mw, mh };
  return brandLayout;
}

function brandMarkVisible() {
  return brandMarkOn;
}

function placeBrandMark(nowMs) {
  const mark = $('brand-mark');
  if (!mark) return;
  if (!brandMarkVisible()) {
    if (!mark.hidden) mark.hidden = true;
    brandLayout = null;
    return;
  }
  const stage = $('stage');
  const wrap = $('preview-wrap');
  const sw = stage?.clientWidth || 0;
  const sh = stage?.clientHeight || 0;
  const wrapW = wrap?.offsetWidth || 0;
  const wrapH = wrap?.offsetHeight || 0;
  if (sw < 2 || sh < 2 || wrapW < 2 || wrapH < 2) {
    if (!mark.hidden) mark.hidden = true;
    brandLayout = null;
    return;
  }
  const box = layoutBrandMark(mark, Math.round(wrapW), Math.round(wrapH));
  if (mark.hidden) mark.hidden = false;
  const { mw, mh } = box;
  const originX = (sw - wrapW) / 2;
  const originY = (sh - wrapH) / 2;
  const spanX = Math.max(0, Math.min(wrapW * 0.62, wrapW - mw - 16));
  const spanY = Math.max(0, Math.min(wrapH * 0.28, wrapH - mh - 16));
  const speed = Math.max(20, wrapW * 0.04);
  const dist = (nowMs / 1000) * speed;
  const dx = spanX < 1 ? 0 : dist % (spanX * 2);
  const dy = spanY < 1 ? 0 : (dist * 0.62) % (spanY * 2);
  const x = originX + (wrapW - mw - spanX) / 2 + (dx <= spanX ? dx : spanX * 2 - dx);
  const y = originY + (wrapH - mh - spanY) / 2 + (dy <= spanY ? dy : spanY * 2 - dy);
  const left = `${x.toFixed(1)}px`;
  const top = `${y.toFixed(1)}px`;
  if (mark.style.left !== left) mark.style.left = left;
  if (mark.style.top !== top) mark.style.top = top;
}

$('screen-enable')?.addEventListener('change', () => setBrandMark($('screen-enable').checked));
$('brand-size')?.addEventListener('input', () => setBrandScale($('brand-size').value));
$('screen-text')?.addEventListener('input', () => setScreenText($('screen-text').value));
$('screen-font')?.addEventListener('change', () => setScreenFont($('screen-font').value));
$('screen-shade')?.addEventListener('input', () => setScreenShade($('screen-shade').value));
$('screen-bg')?.addEventListener('input', () => setScreenBg($('screen-bg').value));
$('screen-color')?.addEventListener('change', () => setScreenColor($('screen-color').value));
try {
  const savedOn = localStorage.getItem('vj.screenOn');
  setBrandMark(savedOn == null ? localStorage.getItem('vj.brandMark') === '1' : savedOn === '1');
} catch { /* ignore */ }
try {
  const savedText = localStorage.getItem('vj.screenText');
  if (savedText != null) setScreenText(savedText);
} catch { /* ignore */ }
try {
  const savedFont = localStorage.getItem('vj.screenFont');
  if (savedFont != null) setScreenFont(savedFont);
} catch { /* ignore */ }
try {
  const savedShade = localStorage.getItem('vj.screenShade');
  if (savedShade != null) setScreenShade(savedShade);
} catch { /* ignore */ }
try {
  const savedBg = localStorage.getItem('vj.screenBg');
  if (savedBg != null) setScreenBg(savedBg);
  else if (localStorage.getItem('vj.brandBack') === '0') setScreenBg(0);
} catch { /* ignore */ }
try {
  const savedColor = localStorage.getItem('vj.screenColor');
  if (savedColor != null) setScreenColor(savedColor);
} catch { /* ignore */ }
try {
  const savedSize = localStorage.getItem('vj.brandSize');
  if (savedSize != null) setBrandScale(savedSize);
} catch { /* ignore */ }
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
  if (deskMode !== 'live') setDeskMode('live');
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
  ['acc-master', false],
  ['acc-output', false],
  ['code-overlay', false],
  ['logo-overlay', false],
  ['screensaver', false],
];
function bindLibraryFolds() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LIBRARY_FOLD_KEY) || '{}'); } catch { /* ignore */ }
  if (!saved || typeof saved !== 'object') saved = {};
  let ready = false;
  const write = () => {
    if (!ready) return;
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
  ready = true;
}
bindLibraryFolds();
try {
  if (localStorage.getItem('vj.uiMode') === 'live') setUiMode('live');
} catch { /* ignore */ }

function triggerScene(id, fade = timeline.fadeSeconds) {
  if (typeof id === 'string' && !scenes.get(id)) return;
  if (fade > 0) snapshotHold();
  scenes.launch(id, fade);
  scheduleSceneThumb(id);
}

const programCanvas = $('program-monitor');
const programCtx = programCanvas?.getContext('2d', { alpha: false });
const sceneThumbCanvas = document.createElement('canvas');
sceneThumbCanvas.width = 160;
sceneThumbCanvas.height = 90;
const sceneThumbCtx = sceneThumbCanvas.getContext('2d', { alpha: false });
let programStampMs = 0;
let programDrawnMs = 0;
let sceneThumbId = '';
let sceneThumbDue = 0;

function paintProgramMonitor(nowMs) {
  if (!programCtx || !document.body.classList.contains('midi-mode')) return;
  if (nowMs - programStampMs < 1000 / 30) return;
  programStampMs = nowMs;
  const aspect = glCanvas.width / Math.max(1, glCanvas.height);
  const w = 320;
  const h = Math.max(1, Math.round(w / aspect));
  if (programCanvas.width !== w || programCanvas.height !== h) {
    programCanvas.width = w;
    programCanvas.height = h;
  }
  programCtx.drawImage(glCanvas, 0, 0, programCanvas.width, programCanvas.height);
  programDrawnMs = nowMs;
}

function scheduleSceneThumb(id) {
  if (!id) return;
  sceneThumbId = id;
  sceneThumbDue = performance.now() + 1000;
}

function captureSceneThumb(nowMs) {
  if (!sceneThumbId || nowMs < sceneThumbDue) return;
  const id = sceneThumbId;
  sceneThumbId = '';
  sceneThumbDue = 0;
  if (!sceneThumbCtx || glCanvas.width < 2 || glCanvas.height < 2) return;
  try {
    sceneThumbCtx.drawImage(glCanvas, 0, 0, sceneThumbCanvas.width, sceneThumbCanvas.height);
    const url = sceneThumbCanvas.toDataURL('image/jpeg', 0.72);
    if (url) scenes.setThumb(id, url);
  } catch { /* a tainted frame keeps the previous thumbnail */ }
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
    bpmMode,
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
    alert('That file is not a Y2K VJ project.');
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
  if (data.bpmMode || data.bpmSource) setBpmMode(data.bpmMode || data.bpmSource);
  project.setLocks(doc.locks);
  applyLocks();
  {
    const shown = showRecordOutput(doc.recordOutput);
    project.setRecordOutput({ code: shown.code, screen: shown.screen });
  }
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
  project.setLocks({});
  applyLocks();
  project.setRecordOutput({ code: !!$('hud-enable')?.checked, screen: false });
  showRecordOutput(project.recordOutput);
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
let audioOverrideStop = false;
try { audioOverrideStop = localStorage.getItem('vj.audioOverrideStop') === '1'; } catch { /* ignore */ }
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
  $('audio-override-stop').checked = audioOverrideStop;
  $('layer-sync').checked = syncMaster[selectedLayer().id] !== false;
  for (const l of layers) panel.setSyncState(l.id, syncMaster[l.id] !== false);
}

function clearMasterCanvas() {
  renderer.setRenderTarget(null);
  const ctx = renderer.getContext();
  ctx.clearColor(0, 0, 0, 1);
  ctx.clear(ctx.COLOR_BUFFER_BIT);
}

function timelineSeconds() {
  const bpm = Math.max(1, Number(timeline.bpm) || 120);
  return (Math.max(0, timeline.beat) * 60) / bpm;
}

function syncedVideos() {
  return layers.filter((l) => syncMaster[l.id] && l.input.kind === 'video');
}

function masterPlay() {
  masterTransport.state = 'playing';
  const at = timelineSeconds();
  for (const l of syncedVideos()) {
    l.input.alignTo(at);
    l.input.play();
  }
  if (syncMaster.audio && !audioOverrideStop && audio.buffer && !audio.playing) audio.play(audio.currentTime);
  timeline.play();
  paintMasterTransport();
  syncTransport();
  syncVideoTransport();
}

function masterPause() {
  masterTransport.state = 'paused';
  for (const l of syncedVideos()) l.input.pause();
  if (syncMaster.audio && !audioOverrideStop && audio.buffer) audio.pause();
  timeline.pause();
  paintMasterTransport();
  syncTransport();
  syncVideoTransport();
}

function masterStop() {
  masterTransport.state = 'stopped';
  for (const l of syncedVideos()) l.input.stopToStart();
  if (syncMaster.audio && !audioOverrideStop && audio.buffer) audio.seekTime(0, false);
  timeline.stop();
  clearMasterCanvas();
  paintMasterTransport();
  syncTransport();
  syncVideoTransport();
}

function setAudioOverrideStop(on) {
  audioOverrideStop = !!on;
  try { localStorage.setItem('vj.audioOverrideStop', audioOverrideStop ? '1' : '0'); } catch { /* ignore */ }
  paintMasterTransport();
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
  if (on && audio.buffer && !audioOverrideStop) {
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
$('audio-override-stop').addEventListener('change', () => setAudioOverrideStop($('audio-override-stop').checked));
$('layer-sync').addEventListener('change', () => setLayerSync(selectedLayer().id, $('layer-sync').checked));
paintMasterTransport();

async function useAudioFile(file) {
  setStatus($('audio-status'), 'decoding...');
  showAudioMode('file');
  await audio.loadFile(file, { autoplay: masterTransport.state === 'playing' || !syncMaster.audio || audioOverrideStop });
  audio.setLoop($('audio-loop').checked);
  await library.cacheAudio(file);
  rememberAudioName(file.name);
  try { localStorage.setItem('vj.audioFile', file.name); } catch { /* ignore */ }
  setStatus($('audio-status'), file.name);
  syncTransport();
  await paintAudioRecent();
}

const AUDIO_RECENT_KEY = 'vj.audioRecent';

function readAudioRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(AUDIO_RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((name) => typeof name === 'string' && name) : [];
  } catch {
    return [];
  }
}

function rememberAudioName(name) {
  const next = [name, ...readAudioRecent().filter((item) => item !== name)];
  try { localStorage.setItem(AUDIO_RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

async function paintAudioRecent() {
  const list = $('audio-recent');
  if (!list) return;
  const current = audio.fileName || localStorage.getItem('vj.audioFile') || '';
  const names = [];
  for (const name of readAudioRecent()) {
    const file = await library.getAudio(name);
    if (file) names.push(name);
  }
  list.replaceChildren();
  for (const name of names) {
    const item = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.name = name;
    btn.textContent = name;
    btn.title = name;
    btn.classList.toggle('on', name === current);
    item.append(btn);
    list.append(item);
  }
  list.hidden = names.length === 0;
}

$('audio-recent')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn?.dataset.name) return;
  const file = await library.getAudio(btn.dataset.name);
  if (!file) {
    await paintAudioRecent();
    return;
  }
  try { await useAudioFile(file); }
  catch (err) { setStatus($('audio-status'), err.message, true); }
});

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
audio.onDeviceLost = () => {
  setStatus($('audio-status'), 'Audio input disconnected - pick the device again', true);
  syncTransport();
};
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
  syncMidiTags();
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
  syncMidiTags();
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
    localStorage.setItem('vj.midi.enabled', '1');
    midi.onChange();
  } catch (err) {
    setStatus($('midi-status'), err.message, true);
  }
});
if (localStorage.getItem('vj.midi.enabled') === '1') {
  midi.init()
    .then(() => midi.onChange())
    .catch((err) => setStatus($('midi-status'), err.message, true));
}
$('midi-learn').addEventListener('click', () => {
  midi.toggleLearn();
  if (midi.learnArmed && !midi.access) {
    midi.init().catch((err) => setStatus($('midi-status'), err.message, true));
  }
});
$('apc-preset').addEventListener('click', () => {
  const arm = async () => {
    setMidiMap('apc-mini-mk2');
    setDeskMode('midi');
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
  automask: 'vj.hudAutomask',
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
    automask: localStorage.getItem(HUD_STYLE_KEY.automask) === '1',
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
  $('hud-automask').checked = style.automask;
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
      automask: $('hud-automask').checked,
      leading: Number($('hud-leading').value),
    };
    localStorage.setItem(HUD_STYLE_KEY.glyph, next.glyph);
    localStorage.setItem(HUD_STYLE_KEY.color, next.color);
    localStorage.setItem(HUD_STYLE_KEY.size, String(next.size));
    localStorage.setItem(HUD_STYLE_KEY.mix, String(next.mix));
    localStorage.setItem(HUD_STYLE_KEY.bg, String(next.bg));
    localStorage.setItem(HUD_STYLE_KEY.automask, next.automask ? '1' : '0');
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
  $('hud-automask').addEventListener('change', persist);
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

const HUD_MOTIONS = ['cut', 'fade', 'zoom', 'slide'];
const HUD_MOTION_KEY = 'vj.hudMotion';
let hudWant = false;
const hudMotion = { motion: 'cut', sec: 0.4, reveal: 0, playing: false, dismissing: false };

function hudEase(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  return x * x * (3 - 2 * x);
}

function applyHudMotion() {
  const frame = $('hud-frame');
  if (!frame) return;
  const t = hudMotion.reveal;
  const ease = hudEase(t);
  const motion = hudMotion.motion;
  if (motion === 'zoom') {
    frame.style.opacity = t <= 0.001 ? '0' : '1';
    frame.style.transformOrigin = 'center center';
    frame.style.transform = `scale(${(0.1 + 0.9 * ease).toFixed(4)})`;
    return;
  }
  if (motion === 'slide') {
    const parentW = frame.parentElement?.clientWidth || 1;
    const left = hudBox.x * parentW;
    const width = frame.offsetWidth || parentW * hudBox.w;
    const dx = -(left + width) * (1 - ease);
    frame.style.opacity = t <= 0.001 ? '0' : '1';
    frame.style.transformOrigin = 'left center';
    frame.style.transform = `translateX(${dx.toFixed(2)}px)`;
    return;
  }
  if (motion === 'fade') {
    frame.style.opacity = String(ease);
    frame.style.transform = '';
    return;
  }
  frame.style.opacity = '';
  frame.style.transform = '';
}

function finishHudMotion() {
  hudMotion.playing = false;
  hudMotion.dismissing = false;
  hudMotion.reveal = 0;
  hud.visible = false;
  if (hud.el) hud.el.hidden = true;
  const frame = $('hud-frame');
  if (frame) {
    frame.hidden = true;
    frame.style.opacity = '';
    frame.style.transform = '';
  }
  pushOverlay(true);
}

function tickHudMotion(dt) {
  if (!hudMotion.playing) return;
  if (hudMotion.motion === 'cut') {
    if (hudMotion.dismissing) finishHudMotion();
    else {
      hudMotion.reveal = 1;
      applyHudMotion();
    }
    return;
  }
  const span = Math.min(2, Math.max(0.1, hudMotion.sec));
  const step = Math.min(0.1, Math.max(0, Number(dt) || 0));
  const dir = hudMotion.dismissing ? -1 : 1;
  hudMotion.reveal = Math.min(1, Math.max(0, hudMotion.reveal + dir * (step / span)));
  if (hudMotion.dismissing && hudMotion.reveal <= 0.001) {
    finishHudMotion();
    return;
  }
  applyHudMotion();
}

function bindHudMotion() {
  try {
    const raw = JSON.parse(localStorage.getItem(HUD_MOTION_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      if (HUD_MOTIONS.includes(raw.motion)) hudMotion.motion = raw.motion;
      const sec = Number(raw.sec);
      if (Number.isFinite(sec)) hudMotion.sec = Math.min(2, Math.max(0.1, sec));
    }
  } catch { /* ignore a bad save */ }
  const sel = $('hud-motion');
  const range = $('hud-motion-sec');
  const out = $('hud-motion-sec-out');
  if (sel) sel.value = hudMotion.motion;
  if (range) range.value = String(hudMotion.sec);
  if (out) out.textContent = hudMotion.sec.toFixed(2);
  const write = () => {
    try {
      localStorage.setItem(HUD_MOTION_KEY, JSON.stringify({ motion: hudMotion.motion, sec: hudMotion.sec }));
    } catch { /* ignore */ }
  };
  sel?.addEventListener('change', () => {
    hudMotion.motion = HUD_MOTIONS.includes(sel.value) ? sel.value : 'cut';
    write();
  });
  range?.addEventListener('input', () => {
    hudMotion.sec = Math.min(2, Math.max(0.1, Number(range.value) || 0.4));
    if (out) out.textContent = hudMotion.sec.toFixed(2);
    write();
  });
}

function setHudEnabled(on) {
  const next = !!on;
  hudWant = next;
  $('hud-enable').checked = next;
  const hudState = document.querySelector('#live-tools .hud-toggle .hud-state');
  if (hudState) hudState.textContent = next ? 'On' : 'Off';
  try { localStorage.setItem('vj.hud', next ? '1' : '0'); } catch { /* ignore */ }
  const frame = $('hud-frame');
  if (next) {
    const resume = hudMotion.playing && hudMotion.dismissing;
    hud.visible = true;
    if (hud.el) hud.el.hidden = false;
    hudMotion.dismissing = false;
    hudMotion.playing = true;
    if (!resume) hudMotion.reveal = hudMotion.motion === 'cut' ? 1 : 0;
    else if (hudMotion.motion === 'cut') hudMotion.reveal = 1;
    applyHudMotion();
    if (frame) frame.hidden = false;
    pushOverlay(true);
    return;
  }
  if (!hudMotion.playing) {
    hud.visible = false;
    if (hud.el) hud.el.hidden = true;
    if (frame) frame.hidden = true;
    pushOverlay(true);
    return;
  }
  hudMotion.dismissing = true;
  if (hudMotion.motion === 'cut') finishHudMotion();
  else pushOverlay(true);
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
bindHudMotion();
if (localStorage.getItem('vj.hud') === '1') setHudEnabled(true);
$('hud-enable').addEventListener('change', () => setHudEnabled($('hud-enable').checked));
setHudPerform(localStorage.getItem('vj.hudPerform') === '1');
$('hud-perform').addEventListener('change', () => setHudPerform($('hud-perform').checked));
$('hud-dpi').checked = dpiState.auto;
$('hud-dpi').addEventListener('change', () => {
  setDpiAuto($('hud-dpi').checked);
  syncDpi();
});

let deskMode = 'live';
let midiMap = 'apc-mini-mk2';

function applyMidiSurface() {
  const mini = midiMap === 'apc-mini-mk2' && deskMode === 'midi';
  $('apc-view').hidden = !mini;
  const note = $('midi-map-note');
  if (note) {
    note.hidden = midiMap === 'apc-mini-mk2';
    note.textContent = midiMap === 'apc40-mk2'
      ? 'APC40 mk2 is selected. Its controls go to MIDI Learn and the saved mappings.'
      : 'Custom / Generic. Every control goes to MIDI Learn and the saved mappings.';
  }
  if (mini) apcView?.refresh();
}

function setMidiMap(id) {
  midiMap = id === 'apc40-mk2' || id === 'custom' ? id : 'apc-mini-mk2';
  const select = $('midi-map');
  if (select && select.value !== midiMap) select.value = midiMap;
  try { localStorage.setItem('vj.midi.map', midiMap); } catch { /* ignore */ }
  applyMidiSurface();
}

apcView = new ApcView({
  root: $('apc-view'),
  params,
  scenes,
  bus,
  panel,
  launch: (id) => triggerScene(id),
  setHud: (on) => {
    setHudEnabled(on);
    apcView?.refresh();
  },
  getHud: () => ({ on: hudWant, size: Number($('hud-size').value) }),
  getClips: () => library.names,
  setClip: (layer, name) => setLayerMedia(layer, `file:${name}`),
  getMedia: () => currentMedia(),
  momentary,
  getPulse: () => beatClock.pulse,
  actions: {
    tap: tapTempo,
    autoBpm: () => setBpmMode('auto'),
    masterStop,
    setSpeed: setMasterSpeed,
    getSpeed: () => masterSpeed,
    setFade: (value) => timeline.set('fadeSec', value),
    getFade: () => timeline.fadeSec,
    setMacro: (index, value) => {
      macros.setValue(`CC 1:${54 + index}`, value);
      const macro = macros.macros[index];
      if (macro) macro.value = value;
    },
    getMacro: (index) => {
      const macro = macros.macros[index];
      return macro && macro.value != null ? macro.value : 0;
    },
    shuffleLayer: () => panel.shuffleSelectedLayer(),
    toggleCategory: (layer, name) => panel.blocks.get(`${layer}:${name}`)?.mute.click(),
    shuffleCategory: (layer, name) => panel.shuffleGroup(layer, name),
    categoryMuted: (layer, name) => panel.muted.has(`${layer}:${name}`),
    categories: () => [...panel.layerEl.querySelectorAll(':scope > .fx-block')]
      .filter((el) => el.dataset.layer === panel.selected && !el.hidden)
      .map((el) => el.dataset.group),
    setMode: (layer, mode) => params.set(layerParam(layer, 'mode'), mode),
    sting: (index) => stings.trigger(index),
    stingOn: (index) => stings.shown(index),
    logoName: (index) => stings.buttonName(index),
  },
});
midi.onHardware = (msg) => midiMap === 'apc-mini-mk2' && apcView.handleMidi(msg);
$('cue-mode-toggle')?.addEventListener('click', () => apcView.toggleCue());
$('midi-map')?.addEventListener('change', (e) => setMidiMap(e.target.value));

function syncMidiTags() {
  const place = (el, text) => {
    if (!el) return;
    let tag = el.querySelector(':scope > .midi-tag');
    if (!tag) {
      tag = document.createElement('i');
      tag.className = 'midi-tag';
      el.append(tag);
    }
    if (tag.textContent !== text) tag.textContent = text;
  };
  for (const [layer, fader, mute, solo] of [
    ['A', 'F1', '⇧TRK1', '⇧TRK4'],
    ['B', 'F2', '⇧TRK2', '⇧TRK5'],
    ['C', 'F3', '⇧TRK3', '⇧TRK6'],
  ]) {
    place(document.querySelector(`.strip[data-layer="${layer}"] .strip-mix-wrap`), fader);
    place(document.querySelector(`.strip[data-layer="${layer}"] .ms.mute`), mute);
    place(document.querySelector(`.strip[data-layer="${layer}"] .ms.solo`), solo);
  }
  place(document.querySelector('[data-midi="master"]'), 'F9');
  place(document.querySelector('label.master-speed'), 'F4');
  place(document.querySelector('label.fade-sec'), 'F5');
  place($('audio-master')?.closest('label'), 'F6');
  const cards = document.querySelectorAll('#macro-list .macro-head');
  place(cards[0], 'F7');
  place(cards[1], 'F8');
  document.querySelectorAll('#momentary-pads .moment-pad').forEach((pad, i) => place(pad, `TRK${i + 1}`));
  document.querySelectorAll('#live-tools .sting-fire').forEach((btn, i) => place(btn, `TRK${i + 6}`));
  place($('shuffle-layer-fx'), '⇧TRK7');
  place(document.querySelector('label.hud-toggle'), '⇧TRK8');
  place($('bpm-tap'), 'SCN7');
  place($('tl-tap'), 'SCN7');
  place($('bpm-mode'), '⇧SCN7');
  place($('master-stop'), '⇧SCN8');
}

function setMidiLabels(on, save = true) {
  document.body.classList.toggle('midi-labels', !!on);
  const box = $('midi-labels');
  if (box) box.checked = !!on;
  if (save) {
    try { localStorage.setItem('vj.midi.labels', on ? '1' : '0'); } catch { /* ignore */ }
  }
  syncMidiTags();
}
$('midi-labels')?.addEventListener('change', (e) => setMidiLabels(e.target.checked));
setMidiLabels(localStorage.getItem('vj.midi.labels') === '1', false);
{
  const storedMap = localStorage.getItem('vj.midi.map');
  setMidiMap(storedMap || (localStorage.getItem('vj.view') === 'apc' ? 'apc-mini-mk2' : 'apc-mini-mk2'));
}
$('hud-output').addEventListener('change', () => {
  setCodeRecord($('hud-output').checked);
  pushOverlay();
});
$('hud-record')?.addEventListener('click', () => {
  setCodeRecord(!codeRecordOn);
  pushOverlay();
});
$('screen-record')?.addEventListener('click', () => setScreenRecord(!screenRecordOn));

let codeRecordOn = false;
let screenRecordOn = false;

function paintRecordButton(id, on) {
  const btn = $(id);
  if (!btn) return;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const state = btn.querySelector('i');
  if (state) state.textContent = on ? 'On' : 'Off';
}

function setCodeRecord(on, save = true) {
  codeRecordOn = !!on;
  paintRecordButton('hud-record', codeRecordOn);
  const box = $('hud-output');
  if (box && box.checked !== codeRecordOn) box.checked = codeRecordOn;
  if (outputWin.overlayOn !== codeRecordOn) outputWin.setOverlayOn(codeRecordOn);
  if (save) project.setRecordOutput({ code: codeRecordOn, screen: screenRecordOn });
}

function setScreenRecord(on, save = true) {
  screenRecordOn = !!on;
  paintRecordButton('screen-record', screenRecordOn);
  if (save) project.setRecordOutput({ code: codeRecordOn, screen: screenRecordOn });
}

function showRecordOutput(raw = {}) {
  const code = typeof raw.code === 'boolean' ? raw.code : !!$('hud-enable')?.checked;
  const screen = typeof raw.screen === 'boolean' ? raw.screen : false;
  setCodeRecord(code, false);
  setScreenRecord(screen, false);
  return {
    code,
    screen,
    dirty: typeof raw.code !== 'boolean' || typeof raw.screen !== 'boolean',
  };
}

{
  const shown = showRecordOutput(project.recordOutput);
  if (shown.dirty) project.setRecordOutput({ code: shown.code, screen: shown.screen });
}

function screenFontFamily() {
  if (screenFont === 'desk') {
    const stack = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
    return stack || 'monospace';
  }
  return SCREEN_FONTS[screenFont] || 'monospace';
}

function screenRecordSpec(nowMs) {
  const lines = String(screenText).replace(/\r\n/g, '\n').split('\n').map((text) => ({ text }));
  lines.push({ text: SCREEN_CREDIT, credit: true });
  return {
    lines,
    fontFamily: screenFontFamily(),
    color: SCREEN_COLORS[screenColor] || SCREEN_COLORS.white,
    shade: screenShade,
    background: screenBg,
    scale: brandScale,
    nowMs,
  };
}
function logoIncluded() {
  return $('logo-output')?.checked !== false;
}
{
  const logoOut = $('logo-output');
  if (logoOut) {
    logoOut.checked = localStorage.getItem('vj.logoOutput') !== '0';
    logoOut.addEventListener('change', () => {
      try { localStorage.setItem('vj.logoOutput', logoOut.checked ? '1' : '0'); } catch { /* ignore */ }
    });
  }
}

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
$('output-advanced').addEventListener('click', () => {
  $('file-menu').hidden = true;
  $('file-menu-btn').setAttribute('aria-expanded', 'false');
  openOutputMap($('output-map-modal').hidden);
});
$('map-close').addEventListener('click', () => openOutputMap(false));
$('output-map-modal').addEventListener('click', (e) => {
  if (e.target === $('output-map-modal')) openOutputMap(false);
});
function openPrefs(open) {
  $('prefs-modal').hidden = !open;
  if (open) ensureStockDir().catch(() => {});
}
$('stock-dir-pick').addEventListener('click', async () => {
  if (!isTauri()) {
    showToast('Choose the folder in the desktop app.', true);
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'Stock Media Download Folder' });
  if (typeof picked !== 'string' || !picked) return;
  try { localStorage.setItem(STOCK_DIR_KEY, picked); } catch { /* private mode */ }
  paintStockDir(picked);
});
$('prefs-btn').addEventListener('click', () => {
  $('file-menu').hidden = true;
  $('file-menu-btn').setAttribute('aria-expanded', 'false');
  openPrefs($('prefs-modal').hidden);
});
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
  if (deskMode === 'prep') return;
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
  else if (k === 'h') setHudEnabled(!hudWant);
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
let ledHit = false;
let ledDown = false;
const place = { scale: 1, x: 0, y: 0, maskX: 1, maskY: 1, maskOn: false };
const BLEND_SHORT = ['normal', 'multiply', 'screen', 'dodge', 'difference', 'add', 'exclusion', 'overlay'];

let cleanPlate = null;
function copyCleanPlate() {
  if (!cleanPlate) {
    cleanPlate = document.createElement('canvas');
    cleanPlate.ctx = cleanPlate.getContext('2d', { alpha: false });
  }
  if (cleanPlate.width !== glCanvas.width || cleanPlate.height !== glCanvas.height) {
    cleanPlate.width = Math.max(2, glCanvas.width);
    cleanPlate.height = Math.max(2, glCanvas.height);
  }
  cleanPlate.ctx.drawImage(glCanvas, 0, 0);
  return cleanPlate;
}

function frame(stamp) {
  const nowMs = typeof stamp === 'number' && stamp > 0 ? stamp : performance.now();
  const dt = frameStamp > 0 ? Math.min((nowMs - frameStamp) / 1000, 0.1) : 0;
  frameStamp = nowMs;
  const now = nowMs / 1000;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  const visualOn = masterTransport.state === 'playing';
  timeline.update(visualOn ? dt : 0); // crosses a scene marker -> triggerScene()
  scenes.update(visualOn ? dt : 0);
  if (!bpmEngine.attached && audio.ctx && audio.graph) {
    audio.connectBpm(bpmEngine.attach(audio.ctx));
  }
  audio.syncPeak(bpmEngine);
  bpmEngine.update(dt, now);
  if (masterTransport.state === 'playing') {
    if (timeline.playing) {
      beatClock.sync(timeline.beat);
      bpmEngine.beats = timeline.beat;
    } else {
      beatClock.beats = bpmEngine.beats;
      beatClock.setBpm(bpmEngine.bpm);
    }
  }
  const heard = bpmEngine.consumeAnalysis();
  const tempoChanged = bpmEngine.consumeChange();
  if (heard === 'locked') {
    closeBpmEditor();
    timeline.set('bpm', bpmEngine.bpm);
    syncTempoUi();
    const readout = $('bpm-value');
    if (readout) {
      readout.textContent = formatBpm(bpmEngine.bpm);
      readout.style.opacity = '1';
      readout.style.color = '#3dffb0';
    }
    bpmFlashUntil = nowMs + 1000;
    setBpmMode('manual');
    showBpmNotice(`Locked: ${formatBpm(bpmEngine.bpm)}`, 2000);
  } else if (heard === 'timeout') {
    const readout = $('bpm-value');
    if (readout) {
      readout.style.opacity = '';
      readout.style.color = '';
    }
    setBpmMode('manual');
    showBpmNotice('No clear beat - try again', 2000);
  } else if (tempoChanged) {
    timeline.set('bpm', bpmEngine.bpm);
  }
  shared.uBeat.value = beatClock.pulse;
  shared.uBeatPhase.value = beatClock.phase;

  const a = audio.update(dt, now);
  const motionDt = visualOn ? dt * masterSpeed : 0;
  shaderTime += motionDt;
  shared.uTime.value = shaderTime;
  if (controls.enabled) controls.update();
  for (const l of layers) l.tickMedia(visualOn ? dt : 0, renderer, fitMode);

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
      l.render(renderer, renderCtx, visualOn ? dt : 0, layerById, place);
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

  stings.update(renderer, dt);
  tickHudMotion(dt);

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

  let bakedPlate = null;
  if (stings.live) {
    renderer.setRenderTarget(stingRt);
    renderer.render(quadScene, camera2d);
    if (recorder.recording || outputWin.open) {
      renderer.setRenderTarget(null);
      if (blackout && !picture) clearMasterCanvas();
      else renderer.render(quadScene, camera2d);
      bakedPlate = copyCleanPlate();
    }
    sting.uBase.value = stingRt.texture;
    sting.uAspect.value = stingRt.width / Math.max(1, stingRt.height);
    stings.bind(sting, a.kick || 0);
    quad.material = stingMaterial;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, camera2d);
  } else {
    renderer.setRenderTarget(null);
    if (blackout && !picture) clearMasterCanvas();
    else renderer.render(quadScene, camera2d);
  }

  paintProgramMonitor(nowMs);
  captureSceneThumb(nowMs);
  pictureSend.tick(nowMs, glCanvas);

  sceneBar.updatePlayhead();

  const led = $('beat-led');
  const nextOpacity = (0.4 + 0.6 * beatClock.pulse).toFixed(2);
  if (nextOpacity !== ledOpacity) {
    ledOpacity = nextOpacity;
    led.style.opacity = nextOpacity;
  }
  const nextHit = beatClock.pulse > 0.62;
  if (nextHit !== ledHit) {
    ledHit = nextHit;
    led.classList.toggle('hit', nextHit);
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
    const bpmBtn = $('bpm-mode');
    if (bpmEngine.analyzing) {
      const label = bpmEngine.analyzeLabel();
      if (bpmBtn.textContent !== label) bpmBtn.textContent = label;
    } else if (bpmNoticeUntil && nowMs >= bpmNoticeUntil) {
      bpmNoticeUntil = 0;
      if (bpmBtn.textContent !== 'Auto: Read Live') bpmBtn.textContent = 'Auto: Read Live';
    }
    if (bpmReadout && bpmReadout.dataset.editing !== '1') {
      const flashing = nowMs < bpmFlashUntil;
      const shown = bpmEngine.analyzing && bpmEngine.previewBpm != null ? bpmEngine.previewBpm : bpmEngine.bpm;
      const bpmText = formatBpm(shown);
      if (bpmReadout.textContent !== bpmText) bpmReadout.textContent = bpmText;
      bpmReadout.style.opacity = bpmEngine.analyzing ? '0.5' : flashing ? '1' : '';
      bpmReadout.style.color = flashing && !bpmEngine.analyzing ? '#3dffb0' : '';
      bpmReadout.parentElement.classList.toggle('locked', bpmMode !== 'auto');
      bpmReadout.parentElement.classList.toggle('sync', bpmMode === 'auto');
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
    placeBrandMark(nowMs);
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
          clock: { pulse: beatClock.pulse, text: `${formatBpm(beatClock.bpm)} bpm  ${bpmMode}  beat ${beatClock.beatInBar + 1}/4` },
        },
        now,
      );
    }
    if (outputWin.overlayOn) pushOverlay(false);
    }
  }
  // Copy the finished WebGL frame after the HUD text has settled, so the recording
  // and the output window do not grab a line that is still scrolling into place.
  const hudFrame = codeRecordOn && hud.visible ? hud.recordOverlay() : null;
  const frameSource = bakedPlate || renderer.domElement;
  const logos = logoIncluded() && stings.live ? stings.outputPose() : null;
  const screensaver = screenRecordOn ? screenRecordSpec(nowMs) : null;
  if (recorder.recording) recorder.paint(frameSource, hudFrame, logos, screensaver);
  outputWin.mirror(hudFrame, logos, frameSource, screensaver);
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
restoreCachedMedia().then(() => paintAudioRecent());

// Focused: requestAnimationFrame, whose timestamp is performance.now().
// Blurred or hidden: a worker interval, because requestAnimationFrame stalls
// when this window loses focus and the output mirror would freeze.
// Only one clock runs. A leftover display callback must not schedule another frame.
let clockMode = '';
let gpuLost = false;
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

function idleFrameClock() {
  clockMode = 'idle';
  stopDisplayClock();
  stopBackgroundClock();
}

function useDisplayClock() {
  if (deskMode === 'prep' || gpuLost) {
    idleFrameClock();
    return;
  }
  if (clockMode === 'display') return;
  clockMode = 'display';
  stopBackgroundClock();
  frameStamp = 0;
  rafHandle = requestAnimationFrame(onDisplayFrame);
}

function useBackgroundClock() {
  if (deskMode === 'prep' || gpuLost) {
    idleFrameClock();
    return;
  }
  if (clockMode === 'background') return;
  clockMode = 'background';
  stopDisplayClock();
  frameStamp = 0;
  nextPump = 0;
  if (framePump) framePump.postMessage('start');
  else if (!fallbackTimer) fallbackTimer = setInterval(() => frame(performance.now()), 1000 / 60);
}

function syncFrameClock() {
  if (deskMode === 'prep' || gpuLost) {
    idleFrameClock();
    return;
  }
  if (document.hidden || !document.hasFocus()) useBackgroundClock();
  else useDisplayClock();
}

function setDeskMode(mode) {
  const next = mode === 'prep' || mode === 'midi' ? mode : 'live';
  deskMode = next;
  const prep = next === 'prep';
  const midiOn = next === 'midi';
  document.body.classList.toggle('prep-mode', prep);
  document.body.classList.toggle('midi-mode', midiOn);
  $('media-prep').hidden = !prep;
  $('midi-desk').hidden = !midiOn;
  for (const [id, on] of [['mode-live', next === 'live'], ['mode-prep', prep], ['mode-midi', midiOn]]) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (prep || midiOn) {
    $('file-menu').hidden = true;
    $('file-menu-btn').setAttribute('aria-expanded', 'false');
    $('screen-menu').hidden = true;
  }
  if (prep) idleFrameClock();
  else syncFrameClock();
  applyMidiSurface();
  apcView?.refresh();
  try { localStorage.setItem('vj.workspace', next); } catch { /* ignore */ }
}

document.addEventListener('visibilitychange', syncFrameClock);
window.addEventListener('blur', useBackgroundClock);
window.addEventListener('focus', () => {
  if (!document.hidden) useDisplayClock();
});

function reloadAfterGpuLoss() {
  project.save();
  location.reload();
}

function showGpuLostBanner() {
  if ($('gpu-lost')) return;
  const banner = document.createElement('div');
  banner.id = 'gpu-lost';
  banner.className = 'gpu-lost';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = '<b>Picture lost - save and reload</b><button type="button" data-act="save">Save Project</button><button type="button" data-act="reload">Reload</button>';
  banner.querySelector('[data-act="save"]').addEventListener('click', () => saveProject());
  banner.querySelector('[data-act="reload"]').addEventListener('click', reloadAfterGpuLoss);
  document.body.append(banner);
}

glCanvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  gpuLost = true;
  idleFrameClock();
  showGpuLostBanner();
});
glCanvas.addEventListener('webglcontextrestored', reloadAfterGpuLoss);
const pictureSend = bindPictureSend({ isTauri });
bindPictureSources(() => {
  const sel = $('layer-media');
  if (sel && document.activeElement === sel) {
    pictureMenuDirty = true;
    return;
  }
  pictureMenuDirty = false;
  refreshMediaSelect();
}, () => {
  if (deskMode === 'prep') return false;
  if (document.activeElement === $('layer-media')) return true;
  return layers.some((l) => /^(ndi|spout):/.test(l.mediaKey || ''));
});
syncFrameClock();
$('mode-live').addEventListener('click', () => setDeskMode('live'));
$('mode-prep').addEventListener('click', () => setDeskMode('prep'));
$('mode-midi').addEventListener('click', () => setDeskMode('midi'));
{
  const savedSize = localStorage.getItem('vj.outputSize');
  const size = $('output-size');
  if (size && savedSize && [...size.options].some((o) => o.value === savedSize)) size.value = savedSize;
  size?.addEventListener('change', () => {
    const [w, h] = size.value.split('x').map(Number);
    if (w > 8 && h > 8) setMasterOutput({ w, h });
    try { localStorage.setItem('vj.outputSize', size.value); } catch { /* ignore */ }
  });
}
{
  const workspace = localStorage.getItem('vj.workspace')
    || (localStorage.getItem('vj.view') === 'apc' ? 'midi' : 'live');
  if (workspace === 'prep' || workspace === 'midi') setDeskMode(workspace);
}
bindMediaPrep({ library, ensureStockDir, showToast });

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
