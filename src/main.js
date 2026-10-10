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

import { LAYERS, LAYER_DEFS, MODE_LABELS, SHADER_KEY_MODES, ParamStore, layerParam, neutralOf, fitModeIndex } from './params.js';
import { START_STACKS, applyStart, clearComposition } from './ui/compStarts.js';
import { seedPacks } from './audio/packs.js';
import { mountAudioPacks, refreshAudioPacks, tickAudioPacks } from './ui/audioPacks.js';
import { createParamHistory } from './history/ParamHistory.js';
import { ENGINE_FX, ENGINE_PARTICLES } from './engines/constants.js';
import { liveFormulaModel, liveStackModel } from './ui/liveCode.js';
import { ScanLog } from './ui/ScanLog.js';
import { Layer, activeShaderSource, overlayShaderSource, blankTexture } from './layers/Layer.js';
import { createTravel } from './layers/Travel.js';
import { MediaLibrary } from './media/MediaLibrary.js';
import { fetchVideoLoop } from './media/onlineFetch.js';
import { searchStockAudio } from './media/stockAudio.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { applyDocumentSink, applyMediaSink, setAudioSink } from './audio/outputSink.js';
import { ModMatrix, createModRow } from './audio/ModMatrix.js';
import { BeatClock } from './clock/BeatClock.js';
import { BpmEngine, estimateBufferTempo } from './clock/BpmEngine.js';
import { LayerBus } from './mixer/LayerBus.js';
import { LfoEngine } from './lfo/LfoEngine.js';
import { MidiManager } from './midi/MidiManager.js';
import { MacroRouter, sliderOptions } from './midi/Macros.js';
import { MOMENTARY, MomentaryPads } from './midi/Momentary.js';
import { Recorder } from './output/Recorder.js';
import { IS_TAURI, invoke } from './ipc.js';
import { OutputWindow, listScreens, POPUP_BLOCKED, isTauri } from './output/OutputWindow.js';
import { fittedBox } from './output/frameFit.js';
import { bindPictureSend } from './output/PictureSend.js';
import { bindPictureSources, pictureSources, refreshPictureSources } from './input/PictureRecv.js';
import { bindRangeReadout } from './ui/NumericSlider.js';
import { beginDrag, endDragSoon, readDrag } from './ui/dragPayload.js';
import { bindMediaPrep, dropVideoAudioPref, setDropVideoAudioPref } from './media/mediaPrep.js';
import {
  bindGlobalLibrary,
  brandTaggedNames,
  confirmDuplicateAdd,
  exportMediaTagsFor,
  hasMediaTag,
  mediaLibraryHasName,
  rememberMediaSource,
  setProjectMediaTags,
} from './media/GlobalLibrary.js';
import { dpiState, formatFactor, pixelsOf, setDpiAuto, setOutputPixels, setPreviewScale } from './ui/dpiScale.js';
import { OutputMap } from './output/OutputMap.js';
import { SceneManager } from './scenes/SceneManager.js';
import { SceneClipWarm } from './scenes/SceneClipWarm.js';
import { Timeline } from './scenes/Timeline.js';
import { ProjectState, coerceDocument, normalizeDesk } from './project/ProjectState.js';
import { Hud, HUD_PRESETS, HUD_BOX_DEFAULT, clampHudBox } from './ui/Hud.js';
import { Panel } from './ui/Panel.js';
import { Diagnostics, flashControl } from './ui/Diagnostics.js';
import { SceneBar } from './ui/SceneBar.js';
import { StingRack } from './overlay/StingRack.js';
import { SCREEN_EM_SHADE, SCREEN_MARK_SHADE, screenShadow, wrapScreenLines } from './overlay/paintScreensaver.js';
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
function paintHistory() {
  const undo = $('undo-btn');
  const redo = $('redo-btn');
  if (undo) undo.disabled = !params.history.canUndo;
  if (redo) redo.disabled = !params.history.canRedo;
}
params.history = createParamHistory((id, value) => params.set(id, value), { onChange: paintHistory });
$('undo-btn').addEventListener('click', () => params.history.undo());
$('redo-btn').addEventListener('click', () => params.history.redo());
const library = new MediaLibrary();
// Declared early so Live perf guards can read it during boot / library hydrate.
let deskMode = 'live';
let deskReturn = 'live';
// Default workspace is Live — don't path→blob thumb while the preview is coming up.
try {
  const ws = localStorage.getItem('vj.workspace') || 'live';
  deskMode = ws === 'prep' || ws === 'midi' ? ws : 'live';
  if (deskMode !== 'prep') library.setHeavyThumbWork(false);
} catch { library.setHeavyThumbWork(false); }
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
const travel = createTravel(params, layers);

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
panel.onLayout = () => persistProjectView();

$('shuffle-layer-fx')?.addEventListener('click', () => panel.shuffleSelectedLayer());
bus.onEdit = (kind, id, from, to) => {
  params.history?.edit(`bus:${kind}:${id}`, from, to, (v) => {
    bus.setFlag(kind, id, v);
  }, 'commit');
  persistProjectView();
};

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
const stings = new StingRack($('logo-overlay'), {
  onChange: () => {
    apcView?.refresh();
    paintLogoPick();
  },
  onAssign: (slot, file) => library.cacheBlob(slot.cacheKey, file, 'logo'),
  onPersist: () => persistDesk(),
  brandMedia: () => brandOverlayClips(),
  onPick: (name) => fileForBrandClip(name),
});
function paintLogoPick() {
  const pick = $('logo-slot-pick');
  const logoBtn = $('logos-trigger');
  if (!pick) return;
  const prev = ['0', '1', '2'].includes(pick.value) ? pick.value : '0';
  pick.hidden = false;
  pick.replaceChildren();
  for (let i = 0; i < 3; i += 1) pick.add(new Option(String(i + 1), String(i)));
  pick.value = prev;
  const index = Number(pick.value);
  const slot = stings.slots[index];
  const named = slot?.name ? `${slot.name}` : `Logo ${index + 1}`;
  if (logoBtn) logoBtn.title = slot?.ready ? `Play ${named}` : `Logo ${index + 1} is empty`;
}
function openLogoSettings() {
  const pick = $('logo-slot-pick');
  const index = pick && !pick.hidden ? Number(pick.value) : 0;
  openProjectFold('logo-overlay');
  const card = stings.slots[index]?.card;
  if (!card) return;
  window.setTimeout(() => {
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.classList.add('is-called');
    window.setTimeout(() => card.classList.remove('is-called'), 1400);
  }, 40);
}
$('logo-slot-pick')?.addEventListener('change', paintLogoPick);
document.querySelectorAll('.logo-triggers .sting-fire').forEach((btn) => {
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
const FOLD_HOLD_MS = 500;
function bindTapHold(el, { onTap, onHold, ms = FOLD_HOLD_MS }) {
  if (!el) return;
  let timer = 0;
  let holdFired = false;
  let swallowClick = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    holdFired = false;
    if (timer) window.clearTimeout(timer);
    try { el.setPointerCapture(e.pointerId); } catch { /* a synthetic press has no pointer to capture */ }
    timer = window.setTimeout(() => {
      timer = 0;
      holdFired = true;
      onHold();
    }, ms);
  });
  const stop = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
  };
  el.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    const tap = !holdFired;
    stop();
    holdFired = false;
    swallowClick = true;
    if (tap) onTap?.();
  });
  el.addEventListener('pointercancel', () => {
    stop();
    holdFired = false;
    swallowClick = true;
  });
  el.addEventListener('click', (e) => {
    if (swallowClick) {
      swallowClick = false;
      e.preventDefault();
      return;
    }
    onTap?.();
  });
}
bindTapHold($('code-trigger'), {
  onTap: () => setHudEnabled(!hudWant, { history: true }),
  onHold: () => openProjectFold('code-overlay'),
});
bindTapHold($('screen-trigger'), {
  onTap: () => {
    const prev = brandMarkOn;
    setBrandMark(!brandMarkOn);
    params.history?.edit('screenOn', prev, brandMarkOn, (v) => setBrandMark(v), 'commit');
  },
  onHold: () => openProjectFold('screensaver'),
});
bindTapHold($('logos-trigger'), {
  onTap: () => stings.trigger(Number($('logo-slot-pick')?.value || 0)),
  onHold: () => openLogoSettings(),
});
paintLogoPick();
const outputMap = new OutputMap({
  stage: $('map-stage'),
  svg: $('map-svg'),
  maskSelect: $('output-mask'),
  resetBtn: $('map-reset'),
  bezelInput: $('output-bezel'),
  bezelOut: $('output-bezel-out'),
  ledNote: $('map-led-note'),
  guideImg: $('map-guide'),
  guideFile: $('map-guide-file'),
  guidePick: $('map-guide-pick'),
  guideClear: $('map-guide-clear'),
  guideOpacity: $('map-guide-opacity'),
  guideOpacityOut: $('map-guide-opacity-out'),
  presetName: $('map-preset-name'),
  presetSave: $('map-preset-save'),
  presetList: $('map-preset-list'),
  presetEmpty: $('map-preset-empty'),
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
// Program monitor / output window always cover their host; per-layer framing is A/B/C.fitMode.

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
  document.querySelector('.midi-monitor-stage')?.style.setProperty('--preview-aspect', String(ratio));
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
    l.updateUvScale(l.mediaFit());
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

function setRenderScale(v) {
  const n = Number(v);
  renderScale = n === 0.5 || n === 0.75 || n === 1 ? n : 1;
  $('render-scale').value = String(renderScale);
  resize();
}

/** Apply an older project-wide Scale setting onto layers that have no saved Frame yet. */
function migrateLegacyFit(fit) {
  const name = fit === 'fit' || fit === 'original' ? fit : 'fill';
  if (name === 'fill') return;
  const idx = fitModeIndex(name);
  for (const L of LAYERS) {
    const id = layerParam(L, 'fitMode');
    if (Math.round(params.get(id)) !== 0) continue;
    params.set(id, idx);
  }
}

$('aspect').addEventListener('change', (e) => setAspect(e.target.value));
$('preview-format').addEventListener('change', (e) => setAspect(e.target.value));
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

function liveSceneClipKeys() {
  return layers.map((l) => l.mediaKey).filter((k) => k.startsWith('file:') || k.startsWith('url:'));
}

/** Live or Perform (midi desk): preview must stay smooth; Prep can do heavy media work. */
function isShowDesk() {
  return deskMode === 'live' || deskMode === 'midi';
}

/**
 * Mac WKWebView: tiny warm pool under Live. All platforms: pause Project Media
 * path→blob thumbs while the show desk is up (queue drains in Prep).
 */
function syncLivePerfGuards() {
  const show = isShowDesk();
  library.setHeavyThumbWork(!show);
  if (!sceneWarm) return;
  if (isMacDesktop() && show) {
    sceneWarm.setBudget({ maxKeys: 2, maxActive: 1, maxParked: 1 });
  } else if (isMacDesktop()) {
    sceneWarm.setBudget({ maxKeys: 6, maxActive: 1, maxParked: 2 });
  } else {
    sceneWarm.setBudget({ maxKeys: 18, maxActive: 2, maxParked: 6 });
  }
}

function syncSceneClipWarm() {
  syncLivePerfGuards();
  if (!sceneWarm || !scenes) return;
  sceneWarm.syncFromScenes(scenes.scenes, liveSceneClipKeys());
}

async function setLayerMedia(L, key, { mirror, history = false, prepared } = {}) {
  const layer = layerById[L];
  const prev = { key: layer.mediaKey, mirror: !!layer.mirror };
  const cameraLabel = key.startsWith('cam:') ? library.cameraLabel(key.slice(4)) : undefined;
  const pending = layer.setMedia(key, { library, cameraLabel, mirror, fitMode: layer.mediaFit(), prepared });
  refreshLayerUi();
  await pending;
  if (masterTransport.state !== 'playing' && syncMaster[L] && layer.input.kind === 'video') layer.input.pause();
  // Camera labels only appear after the first permission grant.
  if (key.startsWith('cam:') && !library.cameras.some((c) => c.label)) {
    await library.refreshCameras().catch(() => {});
  }
  refreshLayerUi();
  apcView?.refresh();
  syncSceneClipWarm();
  if (history) {
    const next = { key: layer.mediaKey, mirror: !!layer.mirror };
    params.history?.edit(`media:${L}`, prev, next, (m) => {
      setLayerMedia(L, m.key, { mirror: m.mirror });
    }, 'commit');
  }
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
  fileGroup.label = 'Project Media';
  for (const item of project.mediaPool) {
    if (item.kind === 'audio' || mediaKind(item.name) === 'audio' || isBrandVisual(item)) continue;
    fileGroup.append(new Option(item.name, clipKey(item.name)));
  }
  if (layer.missing && !project.mediaPool.some((item) => item.name === layer.missing)) {
    fileGroup.append(new Option(`(missing) ${layer.missing}`, `file:${layer.missing}`));
  }
  sel.append(fileGroup);
  if (![...sel.options].some((o) => o.value === layer.mediaKey)) {
    sel.add(new Option(mediaKeyLabel(layer.mediaKey), layer.mediaKey));
  }
  sel.value = layer.mediaKey;
  paintLayerMediaPicker();
}

function closeLayerMediaGallery() {
  const box = $('layer-media-gallery');
  if (!box) return;
  box.hidden = true;
  $('layer-media-open')?.setAttribute('aria-expanded', 'false');
}

function placeLayerMediaGallery() {
  const open = $('layer-media-open');
  const box = $('layer-media-gallery');
  if (!open || !box) return;
  const row = open.closest('.row');
  const r = (row || open).getBoundingClientRect();
  const width = Math.max(220, Math.round(r.width));
  const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
  box.style.left = `${Math.round(left)}px`;
  box.style.width = `${width}px`;
  box.style.top = `${Math.round(r.bottom + 4)}px`;
}

function chooseLayerMedia(value) {
  const sel = $('layer-media');
  if (!sel || ![...sel.options].some((opt) => opt.value === value)) return;
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
  closeLayerMediaGallery();
}

function paintLayerMediaPicker() {
  const sel = $('layer-media');
  const label = $('layer-media-label');
  const open = $('layer-media-open');
  if (!sel || !label || !open) return;
  const text = sel.selectedOptions[0]?.textContent || 'Test pattern';
  label.textContent = text;
  open.title = text;
  $('layer-media-none')?.classList.toggle('is-on', sel.value === 'none');
  const box = $('layer-media-gallery');
  const grid = $('layer-media-grid');
  const sources = $('layer-media-sources');
  if (!box || box.hidden || !grid || !sources) return;
  grid.innerHTML = '';
  const visuals = project.mediaPool.filter((item) => item?.name && item.kind !== 'audio' && mediaKind(item.name) !== 'audio' && !isBrandVisual(item));
  if (!visuals.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No clips in Project Media.';
    grid.append(empty);
  }
  for (const item of visuals) {
    const key = clipKey(item.name);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'layer-media-card';
    card.title = item.name;
    card.classList.toggle('is-on', sel.value === key || sel.value === `file:${item.name}` || sel.value === `url:${item.name}`);
    const img = document.createElement('img');
    img.alt = '';
    const still = library.mediaItem(item.name)?.thumbnail;
    if (still) img.src = still;
    else img.hidden = true;
    const name = document.createElement('span');
    name.textContent = String(item.name).replace(/\.[^.]+$/, '');
    card.append(img, name);
    card.addEventListener('click', () => chooseLayerMedia(key));
    grid.append(card);
  }
  sources.innerHTML = '';
  sources.hidden = true;
}

function openLayerMediaGallery() {
  const box = $('layer-media-gallery');
  if (!box) return;
  if (!box.hidden) {
    closeLayerMediaGallery();
    return;
  }
  box.hidden = false;
  $('layer-media-open')?.setAttribute('aria-expanded', 'true');
  placeLayerMediaGallery();
  paintLayerMediaPicker();
  library.refreshCameras().catch(() => {});
  refreshPictureSources().catch(() => {});
}

const LINUX_PICTURE_NOTE = 'Spout and Syphon are not on this system.';

function isLinuxSystem() {
  const platform = navigator.platform || '';
  if (/^Linux/i.test(platform)) return true;
  const ua = navigator.userAgent || '';
  return /Linux/i.test(ua) && !/Android/i.test(ua);
}

function pictureKindLabel() {
  if (isLinuxSystem()) return '';
  if (pictureSources.localKind) return pictureSources.localKind;
  return /Mac|iPhone|iPad/i.test(navigator.userAgent) ? 'Syphon' : 'Spout';
}

function pictureSourceGroup(layer) {
  const group = document.createElement('optgroup');
  const kind = pictureKindLabel();
  group.label = kind ? `NDI / ${kind}` : 'NDI';
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
  } else if (!pictureSources.ready) {
    hold('Looking...');
  } else {
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
  }
  if (isLinuxSystem()) {
    const note = new Option(LINUX_PICTURE_NOTE, 'picture-platform');
    note.disabled = true;
    group.append(note);
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

function assignMediaToLayer(mediaId, layerId, { history = true } = {}) {
  const name = String(mediaId).replace(/^(?:file|url):/, '');
  if (!project.mediaPool.some((item) => item.name === name)) return Promise.resolve();
  return setLayerMedia(layerId, clipKey(name), { history });
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
  const pool = project.mediaPool;
  let brandLabel = false;
  for (const entry of pool) {
    const brand = isBrandVisual(entry);
    if (brand && !brandLabel) {
      brandLabel = true;
      const label = document.createElement('p');
      label.className = 'hint media-brand-label';
      label.textContent = 'Brand';
      list.append(label);
    }
    const name = entry.name;
    const item = library.mediaItem(name);
    const used = layers.filter((l) => l.mediaKey === `file:${name}` || l.mediaKey === `url:${name}`).map((l) => l.id);
    const card = document.createElement('article');
    card.className = 'media-card';
    card.draggable = true;
    card.dataset.name = name;
    card.classList.toggle('on', used.length > 0);
    card.innerHTML = '<div class="media-thumb-wrap"><img class="media-thumb" alt="" /><div class="media-badges"></div><div class="media-actions"></div></div><span class="media-name"></span>';
    const audioFile = entry.kind === 'audio' || mediaKind(name) === 'audio';
    const thumb = card.querySelector('.media-thumb');
    thumb.alt = '';
    if (!audioFile && item?.thumbnail) {
      thumb.src = item.thumbnail;
      thumb.hidden = false;
    } else {
      thumb.removeAttribute('src');
      thumb.hidden = true;
    }
    if (audioFile) {
      card.classList.add('is-audio');
      const mark = document.createElement('i');
      mark.className = 'media-play';
      mark.textContent = '\u266A';
      mark.title = 'Audio';
      card.querySelector('.media-thumb-wrap').append(mark);
    } else if (item?.kind === 'video') {
      const play = document.createElement('i');
      play.className = 'media-play';
      play.title = 'Video loop';
      card.querySelector('.media-thumb-wrap').append(play);
    }
    card.querySelector('.media-name').textContent = name;
    card.querySelector('.media-name').title = name;
    if (mediaHydrated && !audioFile && !library.has(name)) {
      card.classList.add('is-missing');
      card.querySelector('.media-name').textContent = `(missing) ${name}`;
      card.querySelector('.media-name').title = openedProjectFile()
        ? `${name} is missing from this project folder`
        : `${name} is missing from the Media Library folder`;
    } else if (!audioFile && library.has(name) && !item?.thumbnail) {
      // Empty/loading wrap until #drainThumbs emits and we repaint with the still.
      card.classList.add('loading');
    }
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
    if (audioFile) {
      const use = document.createElement('button');
      use.type = 'button';
      use.textContent = 'Use';
      use.title = 'Play this file on the audio clock';
      use.addEventListener('click', (e) => {
        e.stopPropagation();
        useProjectAudio(entry).catch((err) => showToast(err?.message || 'Could not play that audio file', true));
      });
      actions.append(use);
    } else if (!brand) {
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
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'media-delete';
    del.textContent = '\u00d7';
    del.title = 'Remove from this project';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromBin(name);
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
        kind: item?.kind || entry.kind || (audioFile ? 'audio' : 'video'),
      };
      beginDrag(e, itemData);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        type: 'SCENE_OR_CLIP',
        id: itemData.id,
        name: itemData.name,
        data: itemData,
      }));
      card.classList.add('is-dragging');
      document.body.classList.add('dragging-media');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      document.body.classList.remove('dragging-media');
      clearMediaDropMarks();
      endDragSoon();
    });
    list.append(card);
  }

  // Files referenced by scenes or layers that aren't loaded this session.
  const wanted = new Set();
  for (const l of layers) if (l.missing) wanted.add(l.missing);
  for (const s of scenes.scenes) {
    for (const m of Object.values(s.media || {})) {
      const key = m?.key || '';
      if (key.startsWith('file:') || key.startsWith('url:')) wanted.add(key.slice(key.indexOf(':') + 1));
    }
  }
  const inProject = new Set(project.mediaPool.map((item) => item.name));
  const missing = [...wanted].filter((n) => !inProject.has(n) && !library.has(n));
  const gone = mediaHydrated
    ? project.mediaPool.filter((item) => item.name && item.kind !== 'audio' && mediaKind(item.name) !== 'audio' && !library.has(item.name)).map((item) => item.name)
    : [];
  const lines = [];
  if (gone.length) {
    lines.push(openedProjectFile()
      ? `Missing from this project folder: ${gone.join(', ')}`
      : `Missing file: ${gone.join(', ')}`);
  }
  if (missing.length) lines.push(`Scenes need these files. Send them from Media Manager: ${missing.join(', ')}`);
  $('media-missing').hidden = !lines.length;
  $('media-missing').textContent = lines.join(' ');
}

function clearMediaDropMarks() {
  for (const node of document.querySelectorAll('#media-list .drop-before, #media-list .drop-after')) {
    node.classList.remove('drop-before', 'drop-after');
  }
}

function mediaInsertIndex(list, clientX, clientY) {
  const cards = [...list.querySelectorAll('.media-card[data-name]')];
  if (!cards.length) return project.mediaPool.length;
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) continue;
    if (clientX < rect.left || clientX > rect.right) continue;
    return clientX < rect.left + rect.width / 2 ? i : i + 1;
  }
  let best = project.mediaPool.length;
  let bestDist = Infinity;
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = (clientX - cx) ** 2 + (clientY - cy) ** 2;
    if (dist >= bestDist) continue;
    bestDist = dist;
    best = clientX < cx ? i : i + 1;
  }
  return best;
}

function moveMediaPool(name, toIndex) {
  const pool = project.mediaPool.slice();
  const from = pool.findIndex((item) => item.name === name);
  if (from < 0) return false;
  const max = pool.length;
  const target = Math.min(max, Math.max(0, Math.round(Number(toIndex) || 0)));
  let insert = target;
  if (from < insert) insert -= 1;
  if (insert === from) return false;
  const [item] = pool.splice(from, 1);
  pool.splice(insert, 0, item);
  project.setMediaPool(pool);
  refreshLibraryUi();
  return true;
}

function bindMediaReorder() {
  const list = $('media-list');
  if (!list || list.dataset.reorderBound) return;
  list.dataset.reorderBound = '1';
  let insertAt = -1;
  const mark = (index) => {
    insertAt = index;
    clearMediaDropMarks();
    const cards = [...list.querySelectorAll('.media-card[data-name]')];
    if (!cards.length) return;
    if (index >= cards.length) {
      cards[cards.length - 1].classList.add('drop-after');
      return;
    }
    cards[index].classList.add('drop-before');
  };
  list.addEventListener('dragover', (e) => {
    const payload = window.__vjDragPayload;
    if (payload?.data?.source !== 'clip') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    mark(mediaInsertIndex(list, e.clientX, e.clientY));
  });
  list.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && list.contains(e.relatedTarget)) return;
    clearMediaDropMarks();
    insertAt = -1;
  });
  list.addEventListener('drop', (e) => {
    const payload = readDrag(e);
    if (payload?.data?.source !== 'clip') return;
    e.preventDefault();
    e.stopPropagation();
    const at = insertAt >= 0 ? insertAt : mediaInsertIndex(list, e.clientX, e.clientY);
    clearMediaDropMarks();
    insertAt = -1;
    moveMediaPool(payload.name || payload.id, at);
  });
}
bindMediaReorder();

function addFiles(fileList, { bin = false } = {}) {
  const added = library.add(fileList);
  if (bin) {
    for (const name of added) addToBin({ name, path: '' });
  }
  return added;
}

let libraryUiRefreshTimer = 0;
function scheduleRefreshLibraryUi() {
  if (libraryUiRefreshTimer) return;
  // Live/Perform: coalesce more aggressively — thumb emits used to rebuild the list every ~60ms.
  const delay = isShowDesk() ? 400 : 60;
  libraryUiRefreshTimer = setTimeout(() => {
    libraryUiRefreshTimer = 0;
    refreshLibraryUi();
  }, delay);
}

library.onChange(() => {
  // A layer waiting on a missing file picks it up as soon as it's added.
  for (const l of layers) {
    if (l.missing && library.has(l.missing) && l.mediaStatus !== 'loading...') {
      assignMediaToLayer(l.missing, l.id, { history: false });
    }
  }
  // Project Media reads item.thumbnail — repaint after async #drainThumbs stills arrive.
  scheduleRefreshLibraryUi();
  refreshLayerUi();
  apcView?.refresh();
});

$('layer-media').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (v === 'picture-none') {
    refreshMediaSelect();
    return;
  }
  if (v === 'cam:') {
    // No device list yet: open the default camera, which also unlocks device labels.
    await setLayerMedia(panel.selected, 'cam:', { history: true });
    await library.refreshCameras().catch(() => {});
    return;
  }
  setLayerMedia(panel.selected, v, { history: true });
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
$('layer-media-open')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openLayerMediaGallery();
});
$('layer-media-none')?.addEventListener('click', () => chooseLayerMedia('none'));
window.addEventListener('pointerdown', (e) => {
  const box = $('layer-media-gallery');
  if (!box || box.hidden) return;
  if (e.target.closest('#layer-media-gallery, #layer-media-open')) return;
  closeLayerMediaGallery();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLayerMediaGallery();
});
$('layer-media-refresh').addEventListener('click', () => {
  library.refreshCameras().catch(() => {});
  refreshPictureSources().catch(() => {});
});
$('layer-mirror').addEventListener('change', (e) => {
  const layer = selectedLayer();
  const prev = !!layer.mirror;
  layer.setMirror(e.target.checked);
  params.history?.edit(`mirror:${layer.id}`, prev, !!layer.mirror, (v) => {
    layerById[layer.id].setMirror(v);
    refreshLayerUi();
  }, 'commit');
});
let globalLibrary = null;
$('media-add').addEventListener('click', () => {
  setDeskMode('prep');
  globalLibrary?.refresh();
});
$('media-files').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  const audioFiles = files.filter((file) => file.type.startsWith('audio/') || /\.(mp3|wav|wave|ogg|oga|flac|aiff|aif|m4a)$/i.test(file.name || ''));
  const clips = files.filter((file) => !audioFiles.includes(file)).filter((file) => {
    if (!mediaLibraryHasName(file.name)) return true;
    return confirmDuplicateAdd(file.name);
  });
  if (audioFiles.length) globalLibrary?.ingest(audioFiles);
  library.add(clips);
  for (const file of clips) rememberMediaSource(file.name, 'user');
  e.target.value = '';
  globalLibrary?.refresh();
  globalLibrary?.open();
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
const RECORD_DIR_KEY = 'vj.recordDir';
const LIBRARY_DIR_KEY = 'vj.libraryDir';
const PROJECT_ROOT_KEY = 'vj.projectRoot';
const PROJECT_ROOT_ASKED = 'vj.projectRootAsked';
const PROJECT_ROOT_LABEL = 'vj.projectRootLabel';
const ROOT_HANDLE_DB = 'vj-folders';
const ROOT_HANDLE_STORE = 'handles';
const SOURCE_DIR_KEY = 'vj.sourceDir';
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
  input.title = path || 'Fetched media folder';
}

function paintRecordDir(path) {
  const input = $('record-dir');
  if (!input) return;
  input.value = path || '';
  input.title = path || 'Recordings folder';
}

function paintLibraryDir(path, chosen) {
  const input = $('media-library-dir');
  if (!input) return;
  input.value = path || '';
  input.title = chosen ? (path || 'Media Library folder') : (path ? `${path} (app media folder)` : 'App media folder');
}

function savedStockDir() {
  try { return localStorage.getItem(STOCK_DIR_KEY)?.trim() || ''; } catch { return ''; }
}

function savedRecordDir() {
  try { return localStorage.getItem(RECORD_DIR_KEY)?.trim() || ''; } catch { return ''; }
}

/** Active fetch/stock write path. Project Stock wins while a show is open — prefs stay untouched. */
async function ensureStockDir({ create = false } = {}) {
  const projectStock = await ensureNamedChild('Stock', { create });
  if (projectStock) return projectStock;
  const saved = savedStockDir();
  if (saved) {
    if (create && isTauri()) {
      await invoke('ensure_folder', { path: saved }).catch(() => {});
      await allowLibraryFolder(saved);
    }
    return saved;
  }
  if (!isTauri()) return '';
  const dir = await invoke('default_stock_dir');
  try { localStorage.setItem(STOCK_DIR_KEY, dir); } catch { /* private mode */ }
  return dir;
}

/** Active recordings write path. Project Recordings wins while a show is open — prefs stay untouched. */
async function ensureRecordDir({ create = false } = {}) {
  const projectRecordings = await ensureNamedChild('Recordings', { create });
  if (projectRecordings) return projectRecordings;
  const saved = savedRecordDir();
  if (saved) {
    if (create && isTauri()) {
      await invoke('ensure_folder', { path: saved }).catch(() => {});
      await allowLibraryFolder(saved);
    }
    return saved;
  }
  if (!isTauri()) return '';
  const dir = await invoke('default_recordings_dir');
  try { localStorage.setItem(RECORD_DIR_KEY, dir); } catch { /* private mode */ }
  return dir;
}

function savedLibraryDir() {
  try { return localStorage.getItem(LIBRARY_DIR_KEY)?.trim() || ''; } catch { return ''; }
}

/** Shared Media Manager library. Preference folder when set; else app global_media. */
async function mediaLibraryRoot({ create = false } = {}) {
  const saved = savedLibraryDir();
  if (saved) {
    if (create && isTauri()) {
      await invoke('ensure_folder', { path: saved }).catch(() => {});
      await allowLibraryFolder(saved);
    }
    return saved;
  }
  return ensureGlobalMediaRoot();
}

/** Paint Preferences folder fields from saved choices (never from a project override). */
async function refreshPrefFolderFields() {
  let stock = savedStockDir();
  if (!stock && isTauri()) {
    stock = await invoke('default_stock_dir').catch(() => '') || '';
    if (stock) {
      try { localStorage.setItem(STOCK_DIR_KEY, stock); } catch { /* private mode */ }
    }
  }
  paintStockDir(stock);

  let record = savedRecordDir();
  if (!record && isTauri()) {
    record = await invoke('default_recordings_dir').catch(() => '') || '';
    if (record) {
      try { localStorage.setItem(RECORD_DIR_KEY, record); } catch { /* private mode */ }
    }
  }
  paintRecordDir(record);

  await ensureLibraryDir();
  await ensureProjectRootDir().catch(() => {});
}

function paintProjectRoot(path, chosen) {
  const input = $('project-root-dir');
  if (!input) return;
  input.value = path || '';
  input.title = chosen ? (path || 'New projects folder') : (path ? `${path} (Documents)` : 'Documents');
}

function savedProjectRoot() {
  try { return localStorage.getItem(PROJECT_ROOT_KEY)?.trim() || ''; } catch { return ''; }
}

function savedProjectRootLabel() {
  try { return localStorage.getItem(PROJECT_ROOT_LABEL)?.trim() || ''; } catch { return ''; }
}

let projectRootHandle = null;

function openRootHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ROOT_HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ROOT_HANDLE_STORE)) {
        request.result.createObjectStore(ROOT_HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRootHandle(handle) {
  projectRootHandle = handle || null;
  try {
    const db = await openRootHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(ROOT_HANDLE_STORE);
      if (handle) store.put(handle, 'projectRoot');
      else store.delete('projectRoot');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* private mode or a browser that cannot store a folder */ }
}

async function loadRootHandle() {
  if (projectRootHandle) return projectRootHandle;
  try {
    const db = await openRootHandleDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE, 'readonly');
      const request = tx.objectStore(ROOT_HANDLE_STORE).get('projectRoot');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    projectRootHandle = handle || null;
    return projectRootHandle;
  } catch {
    return null;
  }
}

async function browserProjectRoot() {
  const handle = await loadRootHandle();
  if (!handle?.queryPermission) return null;
  let state = 'prompt';
  try { state = await handle.queryPermission({ mode: 'readwrite' }); } catch { return null; }
  if (state !== 'granted') {
    try { state = await handle.requestPermission({ mode: 'readwrite' }); } catch { return null; }
  }
  return state === 'granted' ? handle : null;
}

function cleanBrowserProjectName(name) {
  const folded = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  const base = folded.slice(0, 48).trim().replace(/\.+$/g, '');
  return base || 'Untitled';
}

async function writeBrowserProject(root, data) {
  const title = cleanBrowserProjectName(projectTitle());
  let leaf = `Y2K-VJ-${title}`;
  let stem = title;
  let n = 2;
  while (n < 100) {
    try {
      await root.getDirectoryHandle(leaf);
      leaf = `Y2K-VJ-${title}-${n}`;
      stem = `${title}-${n}`;
      n += 1;
    } catch (err) {
      if (err?.name === 'NotFoundError') break;
      throw err;
    }
  }
  if (n >= 100) throw new Error('That project name is already used.');
  const folder = await root.getDirectoryHandle(leaf, { create: true });
  for (const sub of ['Recordings', 'Stock', 'Source']) {
    await folder.getDirectoryHandle(sub, { create: true });
  }
  const file = await folder.getFileHandle(`${stem}.vjproj`, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

async function ensureProjectRoot() {
  const saved = savedProjectRoot();
  if (saved) return saved;
  if (!isTauri()) return '';
  try { return (await invoke('default_documents_dir')) || ''; } catch { return ''; }
}

async function ensureProjectRootDir() {
  const saved = savedProjectRoot();
  if (saved) {
    paintProjectRoot(saved, true);
    return saved;
  }
  const label = savedProjectRootLabel();
  if (label) {
    paintProjectRoot(label, true);
    return '';
  }
  const dir = await ensureProjectRoot();
  paintProjectRoot(dir, false);
  return dir;
}

function projectHome(projectPath) {
  return String(projectPath || '').replace(/[/\\][^/\\]+$/, '');
}

function projectChild(projectPath, name) {
  const home = projectHome(projectPath);
  if (!home) return '';
  const sep = String(projectPath).includes('\\') ? '\\' : '/';
  return `${home}${sep}${name}`;
}

function openedProjectFile() {
  return openProjectPath || currentProjectPath() || '';
}

function isNamedProjectFolder(projectPath) {
  const leaf = projectHome(projectPath).split(/[\\/]/).pop() || '';
  return /^Y2K-VJ-/i.test(leaf);
}

function currentSourceDir() {
  const path = openedProjectFile();
  if (path) return projectChild(path, 'Source');
  try { return localStorage.getItem(SOURCE_DIR_KEY)?.trim() || ''; } catch { return ''; }
}

async function adoptProjectFolders(projectPath) {
  if (!isTauri() || !projectPath || !projectHome(projectPath)) return;
  const stock = projectChild(projectPath, 'Stock');
  const recordings = projectChild(projectPath, 'Recordings');
  const source = projectChild(projectPath, 'Source');
  await invoke('ensure_folder', { path: stock }).catch(() => {});
  await invoke('ensure_folder', { path: recordings }).catch(() => {});
  await invoke('ensure_folder', { path: source }).catch(() => {});
  // Keep Preferences Fetched Media / Recordings choices; only track Source for this show.
  try { localStorage.setItem(SOURCE_DIR_KEY, source); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('vj-global-media'));
}

async function createNewProjectFile() {
  if (!isTauri()) return '';
  const root = await ensureProjectRoot();
  if (!root) return '';
  const path = await invoke('create_project_folder', { root, name: projectTitle() });
  if (!path) return '';
  rememberProjectPath(path);
  openProjectPath = path;
  await adoptProjectFolders(path);
  // Own tags on the stick from here on (Brand marks already in the session travel with Save).
  setProjectMediaTags(exportMediaTagsFor(brandTaggedNames()));
  return path;
}

async function ensureNamedChild(which, { create = false } = {}) {
  let path = currentProjectPath() || openProjectPath;
  if (isTauri() && create && !path) {
    try { path = await createNewProjectFile(); } catch { path = ''; }
  }
  if (!path || !projectHome(path)) return '';
  const child = projectChild(path, which);
  const dir = await invoke('ensure_folder', { path: child }).catch(() => child);
  return dir || child;
}

async function ensureSourceDir() {
  const dir = await ensureNamedChild('Source', { create: true });
  if (dir) {
    try { localStorage.setItem(SOURCE_DIR_KEY, dir); } catch { /* private mode */ }
  }
  return dir;
}

/**
 * Where new media / brand / show audio land while a project is open:
 * `<project>/Source/`. Without an open project, the Preferences Media Library folder
 * (or app global_media when unset).
 */
async function projectMediaWriteDir() {
  const path = openedProjectFile();
  if (isTauri() && path && projectHome(path)) {
    const child = projectChild(path, 'Source');
    const dir = await invoke('ensure_folder', { path: child }).catch(() => child);
    if (dir) {
      try { localStorage.setItem(SOURCE_DIR_KEY, dir); } catch { /* private mode */ }
      return dir;
    }
  }
  return mediaLibraryRoot({ create: true });
}

async function ensureLibraryDir() {
  const saved = savedLibraryDir();
  if (saved) {
    paintLibraryDir(saved, true);
    if (isTauri()) await allowLibraryFolder(saved);
    return saved;
  }
  const dir = await mediaLibraryRoot();
  paintLibraryDir(dir, false);
  return dir;
}

async function openSavedFolder(path, emptyNote) {
  if (!isTauri()) {
    showToast('Open the folder in the desktop app.', true);
    return;
  }
  const dir = String(path || '').trim();
  if (!dir) {
    showToast(emptyNote, true);
    return;
  }
  await invoke('open_folder', { path: dir });
}

async function writeBinaryFile(dir, filename, blob) {
  const total = blob.size;
  let written = '';
  for (let offset = 0; offset < total || offset === 0; offset += PROJECT_CHUNK) {
    const end = Math.min(total, offset + PROJECT_CHUNK);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    written = await invoke('write_binary_file', chunk, {
      headers: {
        'x-dir': encodeURIComponent(dir),
        'x-name': encodeURIComponent(filename),
        'x-append': offset > 0 ? '1' : '0',
      },
    });
    if (total === 0) break;
  }
  return written || '';
}

async function saveRecordingFile(blob, filename) {
  if (!isTauri()) return false;
  const dir = await ensureRecordDir({ create: true });
  if (!dir) return false;
  const path = await writeBinaryFile(dir, filename, blob);
  showToast(`Recording saved to ${path || dir}`);
  return true;
}

function stockErrorText(err, fallback) {
  if (typeof err === 'string' && err.trim()) return err.trim();
  const message = err?.message || String(err || '');
  return message.trim() || fallback;
}

async function fileFromStock(clip, onPhase) {
  const filename = libraryName(clip);
  const type = /\.webm$/i.test(filename) ? 'video/webm' : 'video/mp4';
  if (IS_TAURI) {
    const saveDir = await ensureStockDir({ create: true });
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const path = await invoke('download_video', { url: clip.videoUrl, filename, saveDir });
    onPhase?.('Transcoding...');
    const jobId = crypto.randomUUID();
    let unlisten = () => {};
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('media-prep', (event) => {
        const payload = event.payload;
        if (payload?.id !== jobId) return;
        if (typeof payload.percent === 'number') {
          onPhase?.(`Transcoding ${Math.round(payload.percent)}%`);
          return;
        }
        const clock = String(payload?.line || '').match(/time=(\d+:\d+:\d+)/);
        if (clock) onPhase?.(`Transcoding ${clock[1]}`);
      });
    } catch { /* the label stays on Transcoding */ }
    let output;
    try {
      output = await invoke('transcode_media', {
        jobId,
        inputPath: path,
        saveDir,
        keyint: clip.source === 'archive' ? 30 : 1,
        dropAudio: dropVideoAudioPref(),
      });
    } catch (err) {
      const error = new Error(stockErrorText(err, 'Transcode failed'));
      error.transcode = true;
      throw error;
    } finally {
      unlisten();
    }
    const assetUrl = convertFileSrc(output);
    const res = await fetch(assetUrl);
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const leaf = String(output).split(/[\\/]/).pop();
    if (!leaf) throw new Error('Download failed');
    return { file: new File([blob], leaf, { type: blob.type || 'video/mp4' }), path: output };
  }
  console.warn('transcode_media needs the desktop app; using the downloaded file as-is.');
  const res = await fetch(clip.videoUrl, { mode: 'cors', headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  return { file: new File([blob], filename, { type: blob.type || type }), path: '' };
}

function isWikimediaWebm(clip) {
  return clip?.source === 'wikimedia' && /\.webm(\?|#|$)/i.test(String(clip.videoUrl || ''));
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
    const saved = await fileFromStock(clip, (text) => { source.textContent = text; });
    const added = library.add([saved.file]);
    if (!added.length) throw new Error('Download failed');
    rememberMediaSource(added[0], 'fetch');
    addToBin({ name: added[0], path: saved.path || '' });
    window.dispatchEvent(new CustomEvent('vj-global-media'));
    source.textContent = 'In project';
    setOnlineStatus(`Added ${added[0]} to the project.`);
    showToast(`Added ${added[0]} to the project`);
  } catch (err) {
    card.classList.add('failed');
    const transcode = !!err?.transcode;
    const message = stockErrorText(err, transcode ? 'Transcode failed' : 'Download failed');
    source.textContent = transcode ? message : 'Download failed';
    source.title = message;
    card.title = message;
    setOnlineStatus(message, true);
    showToast(transcode ? message : 'Download failed', true);
    if (!transcode) {
      window.setTimeout(() => {
        if (source.textContent === 'Download failed') source.textContent = previous;
        card.classList.remove('failed');
      }, 2400);
    }
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
    const found = await fetchVideoLoop(source, prompt);
    const hidWebm = !isTauri() && found.some(isWikimediaWebm);
    const clips = hidWebm ? found.filter((clip) => !isWikimediaWebm(clip)) : found;
    renderOnlineResults(clips);
    const count = `${clips.length} clip${clips.length === 1 ? '' : 's'}.`;
    if (hidWebm && !clips.length) setOnlineStatus('Open the desktop app to use this clip.', true);
    else if (hidWebm) setOnlineStatus(`${count} Open the desktop app to use this clip.`);
    else setOnlineStatus(count);
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
  if (e.target?.closest?.('#tl-track, #media-prep, #global-library')) return;
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  const count = globalLibrary?.ingest([...e.dataTransfer.files], e) || 0;
  if (count) {
    setDeskMode('prep');
    globalLibrary?.refresh();
  }
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

function paintProjectName() {
  const input = $('project-name');
  if (!input) return;
  input.value = project.name || '';
}

function commitProjectName() {
  const input = $('project-name');
  if (!input) return;
  const next = input.value.replace(/\s+/g, ' ').trim().slice(0, 48);
  const prev = project.name || '';
  if (input.value !== next) input.value = next;
  if (next === prev) return;
  project.setName(next);
  params.history?.edit('projectName', prev, next, (name) => {
    project.setName(name);
    paintProjectName();
  }, 'commit');
}

{
  const input = $('project-name');
  if (input) {
    input.value = project.name || '';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = project.name || '';
        input.blur();
      }
    });
    input.addEventListener('blur', commitProjectName);
  }
}

let deskReady = false;
let deskWriting = false;
let viewApplying = false;
let viewTimer = 0;
let audioAssetPath = '';

const FOLD_LOCKS = ['acc-audio', 'acc-master', 'acc-output', 'code-overlay', 'logo-overlay', 'screensaver'];
const COMP_LOCKS = ['Color & Texture', 'Distortion & Glitch', 'Motion & Timing', 'Barrel'];

function lockButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'section-lock';
  btn.dataset.lock = id;
  btn.setAttribute('aria-label', 'Lock');
  btn.innerHTML = `
    <svg class="lock-open" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.25" y="7" width="11.5" height="7.25" rx="1.4"/>
      <path d="M5 7V4.75a3 3 0 0 1 5.8-.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>
    <svg class="lock-closed" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.25" y="7" width="11.5" height="7.25" rx="1.4"/>
      <path d="M5 7V4.75a3 3 0 0 1 6 0V7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`;
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

const BIN_SPLIT = 'vj.mediaBinSplit';
let mediaHydrated = false;
let openProjectPath = '';
const clipSourcePaths = new Map();

function mediaKind(name) {
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) return 'image';
  if (/\.(mp3|wav|wave|ogg|oga|flac|aiff|aif|m4a)$/i.test(name)) return 'audio';
  return 'video';
}

function isBrandVisual(entry) {
  const name = entry?.name;
  if (!name || !hasMediaTag(name, 'brand')) return false;
  return entry.kind !== 'audio' && mediaKind(name) !== 'audio';
}

/** Session paths for Brand Overlay Choose (tick can land before Add to Project). */
const brandAssetPaths = new Map();

function brandAssetPath(name) {
  return brandAssetPaths.get(name)
    || project.mediaPool.find((item) => item.name === name)?.path
    || clipSourcePaths.get(name)
    || globalLibrary?.pathOf?.(name)
    || '';
}

async function ensureBrandInLibrary(name, path = '') {
  const key = String(name || '');
  if (!key || mediaKind(key) === 'audio') return false;
  const resolved = (typeof path === 'string' && path) ? path : brandAssetPath(key);
  if (resolved) brandAssetPaths.set(key, resolved);
  if (library.has(key)) return true;
  if (resolved && isTauri() && absoluteMediaPath(resolved)) {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      library.addRemote({ name: key, url: convertFileSrc(resolved), path: resolved });
      return library.has(key);
    } catch {
      return false;
    }
  }
  return library.has(key);
}

/** Brand Overlay Choose list: brand-tagged clips, not only project.mediaPool. */
function brandOverlayClips() {
  const names = brandTaggedNames();
  const clips = [];
  for (const name of names) {
    if (mediaKind(name) === 'audio') continue;
    const path = brandAssetPath(name);
    if (path) brandAssetPaths.set(name, path);
    const media = library.mediaItem(name);
    const thumbnail = media?.thumbnail
      || (mediaKind(name) === 'image' ? (media?.url || '') : '')
      || '';
    clips.push({ name, thumbnail, path: path || '' });
  }
  clips.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return clips;
}

window.addEventListener('vj-media-tags', () => {
  refreshLibraryUi();
  refreshMediaSelect();
});

window.addEventListener('vj-brand-ready', async (event) => {
  const name = event.detail?.name;
  const path = typeof event.detail?.path === 'string' ? event.detail.path : '';
  if (!name || mediaKind(name) === 'audio') return;
  if (path) brandAssetPaths.set(name, path);
  await ensureBrandInLibrary(name, path || brandAssetPath(name));
  // Brand Overlay Choose reads tags + library; no project Save / Add to Project required.
  // Leave the gallery on its current filter — Brand tab is manual only.
});

window.addEventListener('vj-brand-clear', (event) => {
  const name = event.detail?.name;
  if (name) brandAssetPaths.delete(name);
});

async function fileForProjectClip(name) {
  const item = library.mediaItem(name);
  if (item?.file) return item.file;
  if (item?.url) {
    const res = await fetch(item.url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const type = blob.type || (mediaKind(name) === 'image' ? 'image/png' : 'video/mp4');
    return new File([blob], name, { type });
  }
  return library.getBlob(name);
}

async function fileForBrandClip(name) {
  let path = brandAssetPath(name);
  if (!path && globalLibrary?.resolvePath) {
    path = await globalLibrary.resolvePath(name);
    if (path) brandAssetPaths.set(name, path);
  }
  await ensureBrandInLibrary(name, path);
  let file = await fileForProjectClip(name);
  if (file) return file;
  path = brandAssetPath(name);
  if (!path || !isTauri() || !absoluteMediaPath(path)) return null;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const res = await fetch(convertFileSrc(path));
    if (!res.ok) return null;
    const blob = await res.blob();
    const type = blob.type || (mediaKind(name) === 'image' ? 'image/png' : 'video/mp4');
    const next = new File([blob], name, { type });
    if (!library.has(name)) library.add([next]);
    return next;
  } catch {
    return null;
  }
}

function addToBin(entry) {
  const name = entry?.name;
  if (!name) return false;
  if (project.mediaPool.some((item) => item.name === name)) return false;
  const rawPath = typeof entry.path === 'string' ? entry.path : '';
  if (rawPath && absoluteMediaPath(rawPath)) clipSourcePaths.set(name, rawPath);
  const path = poolPathFor(name, rawPath);
  project.setMediaPool(project.mediaPool.concat([{
    id: name,
    name,
    kind: entry.kind === 'image' || entry.kind === 'video' || entry.kind === 'audio' ? entry.kind : mediaKind(name),
    path,
  }]));
  if (mediaKind(name) !== 'audio' && rawPath && isTauri() && !library.has(name)) {
    const playable = absoluteMediaPath(rawPath) ? rawPath : '';
    if (playable) {
      import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
        library.addRemote({ name, url: convertFileSrc(playable), path: playable });
      });
    }
  }
  refreshLibraryUi();
  refreshMediaSelect();
  return true;
}

async function releaseClip(name) {
  for (const id of ['A', 'B', 'C']) {
    const key = layerById[id]?.mediaKey;
    if (key === `file:${name}` || key === `url:${name}`) {
      await setLayerMedia(id, 'none', { history: false });
    }
  }
  library.remove(name);
}

async function removeFromBin(name) {
  await releaseClip(name);
  project.setMediaPool(project.mediaPool.filter((item) => item.name !== name));
  refreshLibraryUi();
  refreshMediaSelect();
}

async function hydrateProjectMedia() {
  await library.ensureCached(project.mediaPool.map((item) => item.name));
  if (!isTauri()) return;
  const projectPath = openProjectPath || currentProjectPath();
  if (projectPath) await allowLibraryFolder(projectHome(projectPath));
  // Prefer files beside the .vjproj. Global vault / IndexedDB are migration fallbacks only.
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  const sideRows = projectPath ? await projectSideRows(projectPath) : [];
  for (const item of project.mediaPool) {
    if (item.kind === 'audio' || mediaKind(item.name) === 'audio') continue;
    let path = '';
    if (item.path && !isLibraryReference(item.path)) {
      path = await resolveProjectMediaPath(item.path, projectPath);
    }
    if ((!path || !absoluteMediaPath(path)) && projectPath) {
      const side = matchMediaName(sideRows, item.name);
      if (side?.path) path = side.path;
    }
    if ((!path || !absoluteMediaPath(path)) && item.path && isLibraryReference(item.path)) {
      await ensureGlobalMediaRoot();
      path = await resolveProjectMediaPath(item.path, projectPath);
    }
    if (!path || !absoluteMediaPath(path)) continue;
    const ready = await mediaFileReady(path);
    if (!ready) continue;
    // Always re-point at the project file so a USB show wins over a same-named IndexedDB blob.
    library.addRemote({ name: item.name, url: convertFileSrc(path), path });
    const rel = besideStoredPath(projectPath, path);
    if (rel) brandAssetPaths.set(item.name, rel);
  }
}

library.ready.then(async () => {
  let split = false;
  try { split = localStorage.getItem(BIN_SPLIT) === '1'; } catch { split = false; }
  if (!split) {
    if (!project.mediaPool.length && library.names.length) {
      project.setMediaPool(library.names.map((name) => ({
        id: name,
        name,
        kind: mediaKind(name),
        path: '',
      })));
    }
    try { localStorage.setItem(BIN_SPLIT, '1'); } catch { /* private mode */ }
  }
  await hydrateProjectMedia();
  mediaHydrated = true;
  refreshLibraryUi();
  refreshMediaSelect();
  syncSceneClipWarm();
}).catch(() => {});

const sceneWarm = new SceneClipWarm({
  getFile: (name) => library.get(name),
  getRemote: (name) => library.mediaItem(name),
});
syncLivePerfGuards();

const scenes = new SceneManager({
  params,
  project,
  getMedia: currentMedia,
  applyMedia: (L, m) => setLayerMedia(L, m.key, {
    mirror: m.mirror,
    prepared: sceneWarm.take(m.key),
  }),
  getRouting: layerRouting,
  applyRouting: applySceneRouting,
  getMix: () => captureComposition(),
  applyMix: (mix) => recallComposition(mix, { history: false }),
  onSaveError: (text) => showToast(text, true),
});
const timeline = new Timeline(project);
scenes.onHistory = (before, after) => {
  params.history?.edit('scenes', before, after, (snap) => {
    params.history.silence(() => scenes.restoreHistory(snap));
  }, 'commit');
};

// ---------------------------------------------------------------- tempo clock
// The timeline's BPM is the single stored tempo; the clock follows it and,
// while the timeline plays, locks its beat to the playhead.
const beatClock = new BeatClock(timeline.bpm);
const bpmEngine = new BpmEngine(timeline.bpm);

function formatBpm(bpm) {
  return (Math.round(Number(bpm) * 10) / 10).toFixed(1);
}

function setTempo(bpm, { history = 'commit' } = {}) {
  const prev = timeline.bpm;
  const next = bpmEngine.setBpm(bpm);
  timeline.set('bpm', next, { history: false });
  if (history) params.history?.edit('bpm', prev, timeline.bpm, (v) => setTempo(v, { history: false }), history);
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
  if (result.bpmChanged) setTempo(bpmEngine.bpm);
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
timeline.onEdit = (before, after, field, kind) => {
  params.history.edit(`tl:${field}`, before, after, (data) => {
    params.history.silence(() => {
      timeline.load(data);
      bpmEngine.setBpm(timeline.bpm);
      syncTempoUi();
    });
  }, kind || 'commit');
};
timeline.historyCommit = () => params.history.commit();

$('bpm-slider').addEventListener('input', (e) => {
  if (bpmMode === 'auto' || e.target.disabled) return;
  setTempo(Number(e.target.value), { history: 'drag' });
});
$('bpm-slider').addEventListener('change', () => params.history?.commit());
$('bpm-slider').addEventListener('dblclick', () => {
  if (bpmMode === 'auto') return;
  setTempo(120);
  params.history?.coalesce('bpm');
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

function setBpmMode(src, { scanFile = false } = {}) {
  bpmMode = src === 'auto' ? 'auto' : 'manual';
  bpmEngine.setMode(bpmMode);
  if (bpmMode === 'auto') {
    bpmEngine.beginAnalysis(performance.now() / 1000);
    if (scanFile && audio.kind === 'file' && audio.buffer) {
      const read = estimateBufferTempo(audio.buffer, bpmEngine.bpm);
      if (read) bpmEngine.acceptTempo(read.bpm);
    }
  }
  const auto = bpmEngine.analyzing;
  const btn = $('bpm-mode');
  bpmNoticeUntil = 0;
  btn.textContent = auto ? bpmEngine.analyzeLabel() : 'Auto: Read Live';
  btn.classList.toggle('on', auto);
  btn.setAttribute('aria-pressed', auto ? 'true' : 'false');
  btn.title = auto
    ? 'Listening for a beat. The tempo locks in when the pulse is clear.'
    : 'Manual tempo. Click to read the loaded track, or the live audio.';
  document.body.classList.toggle('bpm-auto', auto);
  $('bpm-slider').disabled = auto;
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
$('bpm-mode').addEventListener('click', () => setBpmMode('auto', { scanFile: true }));

let masterSpeed = 1;
function setMasterSpeed(value, { history = false } = {}) {
  const prev = masterSpeed;
  const n = Number(value);
  masterSpeed = Math.min(4, Math.max(0, Number.isFinite(n) ? n : 1));
  const out = $('master-speed-out');
  if (out && out.dataset.editing !== '1') out.textContent = `${masterSpeed.toFixed(2)}x`;
  const slider = $('master-speed');
  if (slider && document.activeElement !== slider) slider.value = String(masterSpeed);
  if (history) params.history?.edit('speed', prev, masterSpeed, (v) => setMasterSpeed(v), history);
  persistProjectView();
}
$('master-speed')?.addEventListener('input', (e) => setMasterSpeed(e.target.value, { history: 'drag' }));
$('master-speed')?.addEventListener('change', () => params.history?.commit());
$('master-speed')?.addEventListener('dblclick', () => {
  setMasterSpeed(1, { history: 'commit' });
  params.history?.coalesce('speed');
});

function setUiMode(mode) {
  const live = mode === 'live';
  document.body.classList.toggle('live-mode', live);
  try { localStorage.setItem('vj.uiMode', live ? 'live' : 'timeline'); } catch { /* ignore */ }
  persistProjectView();
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
    if (!$('guide-modal').hidden) openGuide(false);
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
  persistProjectView(true);
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
    persistProjectView(true);
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
const SCREEN_TEXT_WAS = 'Y2K VJ//BY CÍN\nCUSTOM CODED FOR LATE\nFUTURE';
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
const SCREEN_HEART = '<3';
const SCREEN_QUERIES = [
  'WHAT WILL YOU BUILD FROM THE RUINS\nOF THE OLD INTERFACE?',
  'WHEN THE STATIC FINALLY\nCLEARED, WHAT DID YOU HEAR?',
  'IF THE SYSTEMS RESET TONIGHT,\nWHO DO WE BECOME AT DAWN?',
  'WHERE DOES THE LIGHT GO WHEN\nTHE SERVERS FINALLY SLEEP?',
  'WHAT GROWS IN THE SPACES\nBETWEEN THE WIRES NOW?',
  'DID WE INVENT A NEW FUTURE,\nOR JUST FINALLY REMEMBER IT?',
  'HOW DOES IT FEEL NOW THAT\nTHE BORDERS ARE JUST PIXELS?',
  'WHEN THE GLITCH BECAME THE\nMASTERPIECE, WHERE WERE YOU?',
  'WHAT RHYTHMS REMAIN NOW\nTHAT THE GRID HAS FALLEN?',
  'IF MEMORY IS JUST A SIGNAL,\nWHAT ARE WE BROADCASTING TOMORROW?',
  'WHO TENDED THE GARDEN WHILE\nTHE MACHINES WERE REBOOTING?',
  'NOW THAT THE BANDWIDTH IS INFINITE,\nWHAT DO YOU TRULY WANT TO SAY?',
];

let brandMarkOn = true;
let brandLayout = null;
let brandScale = 40;
let screenText = SCREEN_TEXT;
let screenFont = 'fixedsys';
let screenShade = 0;
let screenBg = 0.65;
let screenColor = 'white';
let screenBoxW = 0;
let screenBoxH = 0;
let screenPad = 12;
let screenRadius = 0;
let screenBorder = 2;

function escapeScreenLine(line) {
  return line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\/\//g, '<em>//</em>');
}

function screenMeasure(mark) {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'absolute';
  probe.style.whiteSpace = 'pre';
  probe.style.visibility = 'hidden';
  mark.append(probe);
  return {
    width(text) {
      probe.textContent = text;
      return probe.offsetWidth;
    },
    remove() { probe.remove(); },
  };
}

function screenLines() {
  const lines = String(screenText).replace(/\r\n/g, '\n').split('\n').map((text) => ({ text }));
  lines.push({ text: SCREEN_HEART, credit: true });
  return lines;
}

function paintScreenText(mark) {
  const measure = screenMeasure(mark);
  const lines = wrapScreenLines(screenLines(), measure.width).map((line) => line.text);
  measure.remove();
  const html = lines.map((line) => {
    const shown = line.length ? escapeScreenLine(line) : '&nbsp;';
    return `<span class="brand-line">${shown}</span>`;
  }).join('');
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
  const state = document.querySelector('#screen-trigger .screen-state');
  if (state) state.textContent = brandMarkOn ? 'On' : 'Off';
  const screenBtn = $('screen-trigger');
  if (screenBtn) {
    screenBtn.classList.toggle('on', brandMarkOn);
    screenBtn.setAttribute('aria-pressed', brandMarkOn ? 'true' : 'false');
  }
  try { localStorage.setItem('vj.screenOn', brandMarkOn ? '1' : '0'); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

const COMP_HOLD_MS = 500;
const COMP_IDS = ['gradeHue', 'gradeSat', 'gradeContrast', 'crtBleed', 'crtScan', 'chroma', 'strobe', 'strobeSrc', 'strobePol', 'master'];

function captureComposition() {
  const mix = {};
  for (const id of COMP_IDS) mix[id] = params.get(id);
  mix.speed = masterSpeed;
  mix.bpm = timeline.bpm;
  mix.code = !!hudWant;
  mix.screen = !!brandMarkOn;
  return mix;
}

function recallComposition(mix, { history = true } = {}) {
  if (!mix) return;
  const run = () => {
    for (const id of COMP_IDS) {
      if (mix[id] == null || !params.defs.has(id)) continue;
      params.set(id, mix[id], history ? { history: 'commit' } : {});
    }
    const speed = masterSpeed;
    setMasterSpeed(mix.speed);
    if (history) params.history?.edit('speed', speed, masterSpeed, (v) => setMasterSpeed(v), 'commit');
    const bpm = timeline.bpm;
    setTempo(mix.bpm, { history: false });
    if (history) params.history?.edit('bpm', bpm, timeline.bpm, (v) => setTempo(v, { history: false }), 'commit');
    if (!!mix.code !== !!hudWant) {
      const prev = hudWant;
      setHudEnabled(!!mix.code);
      if (history) params.history?.edit('hud', prev, hudWant, (v) => setHudEnabled(v), 'commit');
    }
    if (!!mix.screen !== !!brandMarkOn) {
      const prev = brandMarkOn;
      setBrandMark(!!mix.screen);
      if (history) params.history?.edit('screenOn', prev, brandMarkOn, (v) => setBrandMark(v), 'commit');
    }
  };
  if (history && params.history) params.history.group(run);
  else run();
}

function paintCompositions() {
  const slots = project.compositions || [null, null, null];
  document.querySelectorAll('#comp-slot-host .comp-slot').forEach((btn, i) => {
    const filled = !!slots[i];
    btn.classList.toggle('is-stored', filled);
    btn.setAttribute('aria-pressed', filled ? 'true' : 'false');
    btn.title = 'Click to activate | Long click to save | Right click to forget';
  });
}

function showStackMenu(select) {
  for (const opt of select.options) {
    if (!opt.value) {
      opt.textContent = 'None';
      continue;
    }
    opt.textContent = opt.dataset.label || opt.textContent;
  }
}

function paintStackFace(select) {
  const current = select.value;
  for (const opt of select.options) {
    if (!opt.value) {
      opt.textContent = 'Stacks';
      continue;
    }
    const label = opt.dataset.label || opt.textContent;
    opt.textContent = opt.value === current ? `Stacks: ${label}` : label;
  }
  const chosen = current ? select.selectedOptions[0]?.dataset.label : '';
  select.title = chosen
    ? `Stacks: ${chosen}. Write this stack onto the live layers. One undo step.`
    : 'Write a built-in stack onto the live layers. One undo step. Clips, mixes, BPM, Code, and the screensaver stay.';
}

function mountCompositions() {
  const starts = $('comp-starts');
  if (starts && !starts.dataset.bound) {
    starts.dataset.bound = '1';
    paintStackFace(starts);
    const openMenu = () => showStackMenu(starts);
    starts.addEventListener('pointerdown', openMenu);
    starts.addEventListener('focus', openMenu);
    starts.addEventListener('blur', () => paintStackFace(starts));
    starts.addEventListener('change', () => {
      const stack = START_STACKS.find((item) => item.id === starts.value);
      if (stack) applyStart(params, stack, {
        setSpeed: (speed) => setMasterSpeed(speed, { history: 'commit' }),
        mods,
        lfo,
        sync: () => panel.refreshAutomation(),
      });
      paintStackFace(starts);
    });
    $('comp-clear')?.addEventListener('click', () => {
      clearComposition(params, (speed) => setMasterSpeed(speed, { history: 'commit' }));
    });
  }
  const host = $('comp-slot-host');
  if (!host || host.querySelector('.comp-slot')) return;
  const row = host.querySelector('.comp-slots') || document.createElement('div');
  row.className = 'comp-slots';
  const shuffle = $('shuffle-layer-fx');
  ['C1', 'C2', 'C3'].forEach((label, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'comp-slot';
    btn.textContent = label;
    let pressed = false;
    let saved = false;
    let timer = 0;
    const clearHold = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      btn.classList.remove('is-holding');
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pressed = true;
      saved = false;
      clearHold();
      btn.classList.add('is-holding');
      try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic press */ }
      timer = window.setTimeout(() => {
        timer = 0;
        saved = true;
        btn.classList.remove('is-holding');
        const prev = structuredClone(project.compositions || [null, null, null]);
        const next = prev.slice();
        next[index] = captureComposition();
        project.setCompositions(next);
        paintCompositions();
        params.history?.edit('comps', prev, structuredClone(next), (list) => {
          project.setCompositions(list);
          paintCompositions();
        }, 'commit');
      }, COMP_HOLD_MS);
    });
    btn.addEventListener('pointerup', () => {
      if (!pressed) return;
      pressed = false;
      const held = saved;
      saved = false;
      clearHold();
      if (held) return;
      const mix = project.compositions?.[index];
      if (mix) recallComposition(mix);
    });
    btn.addEventListener('pointercancel', () => {
      pressed = false;
      saved = false;
      clearHold();
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      pressed = false;
      saved = false;
      clearHold();
      const prev = structuredClone(project.compositions || [null, null, null]);
      if (!prev[index]) return;
      const next = prev.slice();
      next[index] = null;
      project.setCompositions(next);
      paintCompositions();
      params.history?.edit('comps', prev, structuredClone(next), (list) => {
        project.setCompositions(list);
        paintCompositions();
      }, 'commit');
    });
    const tools = row.querySelector('.comp-tool-row');
    if (tools) row.insertBefore(btn, tools);
    else if (shuffle && shuffle.parentElement === row) row.insertBefore(btn, shuffle);
    else row.append(btn);
  });
  if (!row.parentElement) host.append(row);
  paintCompositions();
}
mountCompositions();

function launchPack(slot, packOverride) {
  const pack = packOverride || (project.packs || []).find((item) => item.assign === slot);
  if (!pack) return;
  params.history.group(() => {
    const speedBefore = masterSpeed;
    const before = params.snapshot();
    const mediaBefore = Object.fromEntries(LAYERS.map((id) => [id, mediaSnap(id)]));
    const sceneName = (pack.scene || '').trim();
    const scene = sceneName ? scenes.scenes.find((item) => item.name === sceneName) : null;
    if (scene) scenes.launch(scene.id, 0);
    const mid = params.snapshot();
    for (const id of Object.keys(mid)) {
      if (before[id] !== mid[id]) params.history.note(id, before[id], mid[id], 'commit');
    }
    if (masterSpeed !== speedBefore) {
      params.history.edit('speed', speedBefore, masterSpeed, (v) => setMasterSpeed(v), 'commit');
    }
    for (const id of LAYERS) {
      const now = mediaSnap(id);
      const prev = mediaBefore[id];
      if (now.key !== prev.key || now.mirror !== prev.mirror) {
        params.history.edit(`media:${id}`, prev, now, (m) => {
          setLayerMedia(id, m.key, { mirror: m.mirror });
        }, 'commit');
      }
    }
    applyStart(params, pack, {
      setSpeed: (speed) => setMasterSpeed(speed, { history: 'commit' }),
      mods,
      lfo,
      sync: () => panel.refreshAutomation(),
    });
    for (const id of LAYERS) {
      const clip = (pack[id]?.clip || '').trim();
      if (!clip) continue;
      const prev = mediaSnap(id);
      const key = clipKey(clip);
      if (prev.key === key) continue;
      const next = { key, mirror: prev.mirror };
      params.history.edit(`media:${id}`, prev, next, (m) => {
        setLayerMedia(id, m.key, { mirror: m.mirror });
      }, 'commit');
      setLayerMedia(id, key, { mirror: prev.mirror });
    }
  });
}

mountAudioPacks({
  project,
  params,
  launch: launchPack,
  sceneNames: () => scenes.scenes.map((scene) => scene.name).filter(Boolean),
  clipNames: () => (project.mediaPool || []).map((item) => item.name).filter(Boolean),
  desk: () => ({ params, mods, layers, audible: (id) => bus.audible(id) }),
});

function setBrandScale(value) {
  const next = Math.min(220, Math.max(40, Math.round(Number(value) || 100)));
  brandScale = next;
  const slider = $('brand-size');
  if (slider && slider.value !== String(next)) slider.value = String(next);
  const out = $('brand-size-out');
  if (out) out.textContent = `${next}%`;
  try { localStorage.setItem('vj.brandSize', String(next)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenText(value) {
  const stored = String(value ?? '').replace(/\r\n/g, '\n');
  screenText = stored === SCREEN_TEXT_WAS ? SCREEN_TEXT : stored;
  const field = $('screen-text');
  if (field && field.value !== screenText) field.value = screenText;
  try { localStorage.setItem('vj.screenText', screenText); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenFont(value) {
  screenFont = SCREEN_FONTS[value] ? value : 'desk';
  const field = $('screen-font');
  if (field) field.value = screenFont;
  try { localStorage.setItem('vj.screenFont', screenFont); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenShade(value) {
  screenShade = Math.min(8, Math.max(0, Math.round(Number(value) || 0)));
  const slider = $('screen-shade');
  if (slider) slider.value = String(screenShade);
  const out = $('screen-shade-out');
  if (out) out.textContent = String(screenShade);
  try { localStorage.setItem('vj.screenShade', String(screenShade)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenBg(value) {
  screenBg = Math.min(1, Math.max(0, Number(value) || 0));
  const slider = $('screen-bg');
  if (slider) slider.value = String(screenBg);
  const out = $('screen-bg-out');
  if (out) out.textContent = screenBg.toFixed(2);
  try { localStorage.setItem('vj.screenBg', String(screenBg)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function boxSizeLabel(value) {
  return value <= 0 ? 'Auto' : `${value}%`;
}

function radiusLabel(value) {
  if (value <= 0) return 'Sharp';
  if (value >= 100) return 'Pill';
  return String(value);
}

function setScreenBoxW(value) {
  screenBoxW = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  const slider = $('screen-box-w');
  if (slider && slider.value !== String(screenBoxW)) slider.value = String(screenBoxW);
  const out = $('screen-box-w-out');
  if (out) out.textContent = boxSizeLabel(screenBoxW);
  try { localStorage.setItem('vj.screenBoxW', String(screenBoxW)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenBoxH(value) {
  screenBoxH = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  const slider = $('screen-box-h');
  if (slider && slider.value !== String(screenBoxH)) slider.value = String(screenBoxH);
  const out = $('screen-box-h-out');
  if (out) out.textContent = boxSizeLabel(screenBoxH);
  try { localStorage.setItem('vj.screenBoxH', String(screenBoxH)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenPad(value) {
  screenPad = Math.min(64, Math.max(0, Math.round(Number(value) || 0)));
  const slider = $('screen-pad');
  if (slider && slider.value !== String(screenPad)) slider.value = String(screenPad);
  const out = $('screen-pad-out');
  if (out) out.textContent = String(screenPad);
  try { localStorage.setItem('vj.screenPad', String(screenPad)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenRadius(value) {
  screenRadius = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  const slider = $('screen-radius');
  if (slider && slider.value !== String(screenRadius)) slider.value = String(screenRadius);
  const out = $('screen-radius-out');
  if (out) out.textContent = radiusLabel(screenRadius);
  try { localStorage.setItem('vj.screenRadius', String(screenRadius)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenBorder(value) {
  screenBorder = Math.min(12, Math.max(0, Math.round(Number(value) || 0)));
  const slider = $('screen-border');
  if (slider && slider.value !== String(screenBorder)) slider.value = String(screenBorder);
  const out = $('screen-border-out');
  if (out) out.textContent = String(screenBorder);
  try { localStorage.setItem('vj.screenBorder', String(screenBorder)); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function setScreenColor(value) {
  screenColor = SCREEN_COLORS[value] ? value : 'white';
  const field = $('screen-color');
  if (field) field.value = screenColor;
  try { localStorage.setItem('vj.screenColor', screenColor); } catch { /* ignore */ }
  refreshScreen();
  persistDesk();
}

function layoutBrandMark(mark, wrapW, wrapH) {
  const key = [
    wrapW, wrapH, brandScale, screenShade, screenFont, screenColor,
    screenBg.toFixed(2), screenText,
    screenBoxW, screenBoxH, screenPad, screenRadius, screenBorder,
  ].join('|');
  if (brandLayout?.key === key) return brandLayout;
  const base = Math.min(28, Math.max(16, wrapW / 32));
  const font = Math.max(8, Math.round(base * brandScale / 100));
  const showBox = screenBg > 0;
  mark.style.transform = '';
  mark.style.width = '';
  mark.style.height = '';
  mark.style.whiteSpace = 'nowrap';
  mark.style.fontSize = `${font}px`;
  mark.style.fontFamily = SCREEN_FONTS[screenFont];
  mark.style.color = SCREEN_COLORS[screenColor];
  mark.style.textShadow = screenShadow(screenShade, SCREEN_MARK_SHADE);
  mark.style.setProperty('--screen-em-shadow', screenShadow(screenShade, SCREEN_EM_SHADE));
  mark.classList.toggle('plain', !showBox);
  mark.style.backgroundColor = showBox ? `rgba(0, 0, 0, ${screenBg})` : 'transparent';
  mark.style.padding = `${screenPad}px`;
  mark.style.borderWidth = showBox ? `${screenBorder}px` : '0';
  mark.style.borderRadius = screenRadius <= 0 ? '0' : `${screenRadius / 2}%`;
  if (mark.hidden) mark.hidden = false;
  paintScreenText(mark);
  if (screenBoxW > 0) {
    mark.style.width = `${Math.max(mark.offsetWidth, Math.round(wrapW * screenBoxW / 100))}px`;
  }
  if (screenBoxH > 0) {
    mark.style.height = `${Math.max(mark.offsetHeight, Math.round(wrapH * screenBoxH / 100))}px`;
  }
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
  const swingX = dx <= spanX ? dx : spanX * 2 - dx;
  const swingY = (dy <= spanY ? dy : spanY * 2 - dy) - spanY / 2;
  const x = originX + 8 + swingX;
  const y = originY + (wrapH - mh) / 2 + swingY;
  const left = `${x.toFixed(1)}px`;
  const top = `${y.toFixed(1)}px`;
  if (mark.style.left !== left) mark.style.left = left;
  if (mark.style.top !== top) mark.style.top = top;
}

$('screen-enable')?.addEventListener('change', () => {
  const prev = brandMarkOn;
  setBrandMark($('screen-enable').checked);
  params.history?.edit('screenOn', prev, brandMarkOn, (v) => setBrandMark(v), 'commit');
});
$('brand-size')?.addEventListener('input', () => {
  const prev = brandScale;
  setBrandScale($('brand-size').value);
  params.history?.edit('screenSize', prev, brandScale, (v) => setBrandScale(v), 'drag');
});
$('brand-size')?.addEventListener('change', () => params.history?.commit());
$('screen-text')?.addEventListener('input', () => {
  const prev = screenText;
  setScreenText($('screen-text').value);
  params.history?.edit('screenText', prev, screenText, (v) => setScreenText(v), 'drag');
});
$('screen-text')?.addEventListener('blur', () => params.history?.commit());
$('screen-query')?.addEventListener('click', () => {
  const prev = screenText;
  const pool = SCREEN_QUERIES.filter((line) => line !== prev.trim());
  const next = pool[Math.floor(Math.random() * pool.length)];
  setScreenText(next);
  params.history?.edit('screenText', prev, screenText, (v) => setScreenText(v), 'commit');
});
$('screen-font')?.addEventListener('change', () => {
  const prev = screenFont;
  setScreenFont($('screen-font').value);
  params.history?.edit('screenFont', prev, screenFont, (v) => setScreenFont(v), 'commit');
});
$('screen-shade')?.addEventListener('input', () => {
  const prev = screenShade;
  setScreenShade($('screen-shade').value);
  params.history?.edit('screenShade', prev, screenShade, (v) => setScreenShade(v), 'drag');
});
$('screen-shade')?.addEventListener('change', () => params.history?.commit());
$('screen-bg')?.addEventListener('input', () => {
  const prev = screenBg;
  setScreenBg($('screen-bg').value);
  params.history?.edit('screenBg', prev, screenBg, (v) => setScreenBg(v), 'drag');
});
$('screen-bg')?.addEventListener('change', () => params.history?.commit());
$('screen-box-w')?.addEventListener('input', () => {
  const prev = screenBoxW;
  setScreenBoxW($('screen-box-w').value);
  params.history?.edit('screenBoxW', prev, screenBoxW, (v) => setScreenBoxW(v), 'drag');
});
$('screen-box-w')?.addEventListener('change', () => params.history?.commit());
$('screen-box-h')?.addEventListener('input', () => {
  const prev = screenBoxH;
  setScreenBoxH($('screen-box-h').value);
  params.history?.edit('screenBoxH', prev, screenBoxH, (v) => setScreenBoxH(v), 'drag');
});
$('screen-box-h')?.addEventListener('change', () => params.history?.commit());
$('screen-pad')?.addEventListener('input', () => {
  const prev = screenPad;
  setScreenPad($('screen-pad').value);
  params.history?.edit('screenPad', prev, screenPad, (v) => setScreenPad(v), 'drag');
});
$('screen-pad')?.addEventListener('change', () => params.history?.commit());
$('screen-radius')?.addEventListener('input', () => {
  const prev = screenRadius;
  setScreenRadius($('screen-radius').value);
  params.history?.edit('screenRadius', prev, screenRadius, (v) => setScreenRadius(v), 'drag');
});
$('screen-radius')?.addEventListener('change', () => params.history?.commit());
$('screen-border')?.addEventListener('input', () => {
  const prev = screenBorder;
  setScreenBorder($('screen-border').value);
  params.history?.edit('screenBorder', prev, screenBorder, (v) => setScreenBorder(v), 'drag');
});
$('screen-border')?.addEventListener('change', () => params.history?.commit());
$('screen-color')?.addEventListener('change', () => {
  const prev = screenColor;
  setScreenColor($('screen-color').value);
  params.history?.edit('screenColor', prev, screenColor, (v) => setScreenColor(v), 'commit');
});
try {
  const savedOn = localStorage.getItem('vj.screenOn');
  const legacyOn = localStorage.getItem('vj.brandMark');
  setBrandMark(savedOn == null ? legacyOn !== '0' : savedOn === '1');
} catch { /* ignore */ }
try {
  const savedText = localStorage.getItem('vj.screenText');
  if (savedText != null) {
    const stored = savedText.replace(/\r\n/g, '\n');
    setScreenText(stored === SCREEN_TEXT_WAS ? SCREEN_TEXT : savedText);
  }
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
  const savedBoxW = localStorage.getItem('vj.screenBoxW');
  if (savedBoxW != null) setScreenBoxW(savedBoxW);
} catch { /* ignore */ }
try {
  const savedBoxH = localStorage.getItem('vj.screenBoxH');
  if (savedBoxH != null) setScreenBoxH(savedBoxH);
} catch { /* ignore */ }
try {
  const savedPad = localStorage.getItem('vj.screenPad');
  if (savedPad != null) setScreenPad(savedPad);
} catch { /* ignore */ }
try {
  const savedRadius = localStorage.getItem('vj.screenRadius');
  if (savedRadius != null) setScreenRadius(savedRadius);
} catch { /* ignore */ }
try {
  const savedBorder = localStorage.getItem('vj.screenBorder');
  if (savedBorder != null) setScreenBorder(savedBorder);
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
const LIBRARY_FOLD_KEY = 'vj.accLeft';
const LIBRARY_FOLDS = [
  ['acc-packs', false],
  ['diag-panel', false],
  ['acc-media', false],
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
    persistProjectView(true);
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

function mediaSnap(L) {
  const layer = layerById[L];
  return { key: layer.mediaKey, mirror: !!layer.mirror };
}

function lookSnap(paramIds) {
  const values = {};
  for (const id of paramIds) {
    if (params.defs.has(id)) values[id] = params.get(id);
  }
  return {
    params: values,
    media: Object.fromEntries(LAYERS.map((L) => [L, mediaSnap(L)])),
    routing: layerRouting(),
    mix: captureComposition(),
  };
}

function restoreLook(look) {
  scenes.transition = null;
  params.history?.silence(() => {
    for (const [id, v] of Object.entries(look?.params || {})) params.set(id, v);
    for (const L of LAYERS) {
      const m = look?.media?.[L];
      if (!m) continue;
      const cur = mediaSnap(L);
      if (cur.key !== m.key || cur.mirror !== !!m.mirror) setLayerMedia(L, m.key, { mirror: m.mirror });
    }
    applySceneRouting(look?.routing || {});
    if (look?.mix) recallComposition(look.mix, { history: false });
  });
  refreshLayerUi();
}

function triggerScene(id, fade = timeline.fadeSeconds, { history = false } = {}) {
  if (typeof id === 'string' && !scenes.get(id)) return;
  const source = typeof id === 'string' ? scenes.get(id) : id;
  const before = history && source && !params.history?.applying
    ? lookSnap(Object.keys(source.params || {}))
    : null;
  if (fade > 0) snapshotHold();
  // Prefer warm decoders collected while the scene sat on the pad strip.
  syncSceneClipWarm();
  scenes.launch(id, fade);
  if (before && source) {
    const after = {
      params: {},
      media: { ...before.media },
      routing: source.routing ? structuredClone(source.routing) : before.routing,
      mix: source.mix ? structuredClone(source.mix) : before.mix,
    };
    for (const [pid, v] of Object.entries(source.params || {})) {
      if (params.defs.has(pid)) after.params[pid] = v;
    }
    for (const L of LAYERS) {
      const target = source.media?.[L];
      if (target) after.media[L] = { key: target.key, mirror: !!target.mirror };
    }
    params.history.edit('scene', before, after, restoreLook, 'commit');
  }
  scheduleSceneThumb(typeof id === 'string' ? id : source?.id);
}

const sceneThumbCanvas = document.createElement('canvas');
sceneThumbCanvas.width = 160;
sceneThumbCanvas.height = 90;
const sceneThumbCtx = sceneThumbCanvas.getContext('2d', { alpha: false });
let sceneThumbId = '';
let sceneThumbDue = 0;

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
    if (project.mediaPool.some((item) => item.name === cue.mediaName)) assignMediaToLayer(cue.mediaName, cue.layerId || 'A', { history: false });
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

function captureDesk() {
  return normalizeDesk({
    logos: stings.snapshot(),
    code: {
      enabled: !!$('hud-enable')?.checked,
      motion: hudMotion.motion,
      sec: hudMotion.sec,
      glyph: $('hud-glyph')?.value,
      color: $('hud-color')?.value,
      size: Number($('hud-size')?.value),
      mix: Number($('hud-mix')?.value),
      bg: Number($('hud-bg')?.value),
      automask: !!$('hud-automask')?.checked,
      leading: Number($('hud-leading')?.value),
      mode: $('hud-mode')?.value,
      perform: !!$('hud-perform')?.checked,
      dpi: !!$('hud-dpi')?.checked,
      logoOutput: logoOutputOn,
      box: { ...hudBox },
    },
    screen: {
      on: brandMarkOn,
      text: screenText,
      font: screenFont,
      shade: screenShade,
      bg: screenBg,
      color: screenColor,
      size: brandScale,
      boxW: screenBoxW,
      boxH: screenBoxH,
      pad: screenPad,
      radius: screenRadius,
      border: screenBorder,
    },
    audio: {
      mode: audioMode,
      volume: audio.volume,
      muted: audio.muted,
      agc: audio.agc,
      loop: $('audio-loop')?.checked !== false,
      overrideStop: audioOverrideStop,
      attack: Number($('audio-attack')?.value),
      release: Number($('audio-release')?.value),
      file: audio.fileName || '',
      path: audioAssetPath || '',
    },
    outputSize: $('output-size')?.value || '',
    recAspect: $('rec-aspect')?.value || '',
    recFormat: $('rec-format')?.value || '',
    recAudio: route.recordings.audio !== false,
    syncMaster: { ...syncMaster },
  });
}

function persistDesk() {
  if (!deskReady || deskWriting) return;
  project.setDesk(captureDesk());
}

function applyCode(code) {
  if (!code) return;
  hudMotion.motion = code.motion;
  hudMotion.sec = code.sec;
  const motion = $('hud-motion');
  const motionSec = $('hud-motion-sec');
  const motionOut = $('hud-motion-sec-out');
  if (motion) motion.value = hudMotion.motion;
  if (motionSec) motionSec.value = String(hudMotion.sec);
  if (motionOut) motionOut.textContent = hudMotion.sec.toFixed(2);
  try {
    localStorage.setItem(HUD_MOTION_KEY, JSON.stringify({ motion: hudMotion.motion, sec: hudMotion.sec }));
  } catch { /* ignore */ }
  if ($('hud-glyph')) $('hud-glyph').value = code.glyph;
  if ($('hud-color')) $('hud-color').value = code.color;
  if ($('hud-size')) $('hud-size').value = String(Math.round(code.size));
  if ($('hud-mix')) $('hud-mix').value = String(code.mix);
  if ($('hud-bg')) $('hud-bg').value = String(code.bg);
  if ($('hud-leading')) $('hud-leading').value = String(code.leading);
  if ($('hud-automask')) $('hud-automask').checked = code.automask;
  if ($('hud-mode')) $('hud-mode').value = HUD_MODES.includes(code.mode) ? code.mode : 'scan';
  if ($('hud-size-out')) $('hud-size-out').textContent = String(Math.round(code.size));
  if ($('hud-leading-out')) $('hud-leading-out').textContent = code.leading.toFixed(2);
  if ($('hud-mix-out')) $('hud-mix-out').textContent = code.mix.toFixed(2);
  if ($('hud-bg-out')) $('hud-bg-out').textContent = code.bg.toFixed(2);
  hud.setDisplay($('hud-mode').value);
  hud.applyChrome({
    glyph: code.glyph,
    color: code.color,
    size: code.size,
    mix: code.mix,
    bg: code.bg,
    automask: code.automask,
    leading: code.leading,
  });
  syncPresetSelect();
  try {
    localStorage.setItem(HUD_STYLE_KEY.glyph, code.glyph);
    localStorage.setItem(HUD_STYLE_KEY.color, code.color);
    localStorage.setItem(HUD_STYLE_KEY.size, String(code.size));
    localStorage.setItem(HUD_STYLE_KEY.mix, String(code.mix));
    localStorage.setItem(HUD_STYLE_KEY.bg, String(code.bg));
    localStorage.setItem(HUD_STYLE_KEY.automask, code.automask ? '1' : '0');
    localStorage.setItem(HUD_STYLE_KEY.leading, String(code.leading));
    localStorage.setItem(HUD_STYLE_KEY.mode, $('hud-mode').value);
  } catch { /* ignore */ }
  applyHudBox(code.box || HUD_BOX_DEFAULT, false);
  try { localStorage.setItem('vj.hudBox', JSON.stringify(hudBox)); } catch { /* ignore */ }
  setHudPerform(code.perform);
  setDpiAuto(code.dpi);
  if ($('hud-dpi')) $('hud-dpi').checked = code.dpi;
  syncDpi();
  setHudEnabled(code.enabled);
}

function applyDesk(desk) {
  const next = normalizeDesk(desk);
  if (!next) return;
  deskWriting = true;
  try {
    stings.apply(next.logos);
    applyCode(next.code);
    setScreenText(next.screen.text);
    setScreenFont(next.screen.font);
    setScreenShade(next.screen.shade);
    setScreenBg(next.screen.bg);
    setScreenColor(next.screen.color);
    setBrandScale(next.screen.size);
    setScreenBoxW(next.screen.boxW);
    setScreenBoxH(next.screen.boxH);
    setScreenPad(next.screen.pad);
    setScreenRadius(next.screen.radius);
    setScreenBorder(next.screen.border);
    setBrandMark(next.screen.on);
    audioAssetPath = next.audio.path || '';
    showAudioMode(next.audio.mode);
    audio.volume = next.audio.volume;
    if ($('audio-volume')) $('audio-volume').value = String(audio.volume);
    if ($('audio-volume-out')) $('audio-volume-out').textContent = audio.volume.toFixed(2);
    try { localStorage.setItem('vj.audioVolume', String(audio.volume)); } catch { /* ignore */ }
    audio.muted = next.audio.muted;
    $('audio-mute')?.classList.toggle('on', audio.muted);
    if ($('audio-mute')) $('audio-mute').textContent = audio.muted ? 'Muted' : 'Mute';
    try { localStorage.setItem('vj.audioMute', audio.muted ? '1' : '0'); } catch { /* ignore */ }
    audio.agc = next.audio.agc;
    if ($('audio-agc')) $('audio-agc').checked = audio.agc;
    try { localStorage.setItem('vj.audioAgc', audio.agc ? '1' : '0'); } catch { /* ignore */ }
    if ($('audio-loop')) $('audio-loop').checked = next.audio.loop;
    audio.setLoop(next.audio.loop);
    try { localStorage.setItem('vj.audioLoop', next.audio.loop ? '1' : '0'); } catch { /* ignore */ }
    setAudioOverrideStop(next.audio.overrideStop);
    if ($('audio-attack')) {
      $('audio-attack').value = String(next.audio.attack);
      $('audio-attack').dispatchEvent(new Event('input', { bubbles: true }));
    }
    if ($('audio-release')) {
      $('audio-release').value = String(next.audio.release);
      $('audio-release').dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const key of ['audio', 'A', 'B', 'C']) syncMaster[key] = next.syncMaster[key];
    try { localStorage.setItem('vj.syncMaster', JSON.stringify(syncMaster)); } catch { /* ignore */ }
    paintMasterTransport();
    const size = $('output-size');
    if (size && next.outputSize && [...size.options].some((o) => o.value === next.outputSize)) {
      size.value = next.outputSize;
      const [w, h] = next.outputSize.split('x').map(Number);
      if (w > 8 && h > 8) setMasterOutput({ w, h });
      try { localStorage.setItem('vj.outputSize', size.value); } catch { /* ignore */ }
    }
    if ($('rec-aspect') && next.recAspect && (RECORD_FRAMES[next.recAspect] || next.recAspect === 'native')) {
      $('rec-aspect').value = next.recAspect;
      try { localStorage.setItem('vj.recAspect', next.recAspect); } catch { /* ignore */ }
    }
    if ($('rec-format') && next.recFormat && [...$('rec-format').options].some((o) => o.value === next.recFormat)) {
      $('rec-format').value = next.recFormat;
    }
  } finally {
    deskWriting = false;
  }
}

function resetProjectDesk() {
  applyDesk({
    logos: [null, null, null],
    code: {
      enabled: false,
      motion: 'cut',
      sec: 0.4,
      glyph: 'ascii',
      color: 'green',
      size: 16,
      mix: 0.92,
      bg: 0.62,
      automask: false,
      leading: 1.45,
      mode: 'scan',
      perform: false,
      dpi: true,
      logoOutput: true,
      box: { ...HUD_BOX_DEFAULT },
    },
    screen: {
      on: true,
      text: SCREEN_TEXT,
      font: 'fixedsys',
      shade: 0,
      bg: 0.65,
      color: 'white',
      size: 40,
      boxW: 0,
      boxH: 0,
      pad: 12,
      radius: 0,
      border: 2,
    },
    audio: {
      mode: 'device',
      volume: 0.8,
      muted: false,
      agc: true,
      loop: true,
      overrideStop: false,
      attack: 0.01,
      release: 0.15,
      file: '',
    },
    outputSize: '1920x1080',
    recAspect: '16:9',
    recFormat: '0',
    recAudio: true,
    syncMaster: { audio: true, A: true, B: true, C: true },
  });
}

async function restoreLogoFiles() {
  await library.ready;
  for (const slot of stings.slots) {
    if (!slot.cacheKey || slot.ready) continue;
    const file = await library.getBlob(slot.cacheKey);
    if (!file) {
      stings.markMissing(slot.index);
      continue;
    }
    stings.loadFile(slot.index, file);
  }
}

const HELLO_VIEWS = [
  ['view-timeline', 'hide-timeline', 'timeline'],
  ['view-inspector', 'hide-inspector', 'inspector'],
  ['view-layer-a', 'hide-layer-a', 'layerA'],
  ['view-layer-b', 'hide-layer-b', 'layerB'],
  ['view-layer-c', 'hide-layer-c', 'layerC'],
  ['view-composition', 'hide-composition', 'composition'],
];

function persistProjectView(immediate = false) {
  if (viewApplying || !deskReady) return;
  clearTimeout(viewTimer);
  const write = () => {
    if (viewApplying || !deskReady) return;
    project.setView(captureView());
  };
  if (immediate) write();
  else viewTimer = setTimeout(write, 240);
}

function captureView() {
  const cs = getComputedStyle($('app'));
  const read = (name) => {
    const n = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(n) ? n : null;
  };
  let folds = {};
  try { folds = JSON.parse(localStorage.getItem(LIBRARY_FOLD_KEY) || '{}'); } catch { folds = {}; }
  const layout = panel.layoutSnapshot();
  const hello = {};
  for (const [id, , key] of HELLO_VIEWS) hello[key] = !!$(id)?.checked;
  return {
    ...hello,
    library: !!$('view-library')?.checked,
    panes: {
      library: read('--library-w'),
      inspector: read('--inspector-w'),
      dock: read('--dock-h'),
    },
    previewSplit: topHeightPercent,
    timelineH: parseFloat(document.querySelector('.timeline-pane')?.style.height) || null,
    timelinePx: timelineBarPx,
    folds,
    fxFolds: layout.folds,
    catMute: layout.muted,
    workspace: deskMode,
    midiMap,
    midiLabels: !!$('midi-labels')?.checked,
    uiScale: Number($('ui-scale')?.value) || 100,
    bus: {
      mute: { A: !!bus.mute.A, B: !!bus.mute.B, C: !!bus.mute.C },
      solo: { A: !!bus.solo.A, B: !!bus.solo.B, C: !!bus.solo.C },
    },
    masterSpeed,
  };
}

function applyProjectView(view, { workspace = false } = {}) {
  if (!view) return;
  viewApplying = true;
  try {
    for (const [id, className, key] of HELLO_VIEWS) {
      const box = $(id);
      const on = view[key] !== false;
      if (box) box.checked = on;
      document.body.classList.toggle(className, !on);
    }
    setLibraryOpen(view.library !== false);
    const panes = view.panes || {};
    if (panes.library) $('app').style.setProperty('--library-w', `${panes.library}px`);
    if (panes.inspector) $('app').style.setProperty('--inspector-w', `${panes.inspector}px`);
    if (panes.dock) $('app').style.setProperty('--dock-h', `${panes.dock}px`);
    if (view.previewSplit != null) applyPreviewSplit(view.previewSplit, true);
    if (view.timelineH != null) applyTimelineSplit(view.timelineH, true);
    if (view.timelinePx != null) applyTimelineZoom(view.timelinePx, true);
    if (view.folds && typeof view.folds === 'object') {
      for (const [id] of LIBRARY_FOLDS) {
        const el = $(id);
        if (!el || typeof view.folds[id] !== 'boolean') continue;
        el.open = view.folds[id];
      }
    }
    panel.applyLayout({ folds: view.fxFolds || {}, muted: view.catMute || [] });
    if (view.uiScale != null) setUiScale(view.uiScale);
    if (view.midiMap) setMidiMap(view.midiMap);
    setMidiLabels(!!view.midiLabels);
    for (const id of LAYERS) {
      bus.setFlag('mute', id, !!view.bus?.mute?.[id]);
      bus.setFlag('solo', id, !!view.bus?.solo?.[id]);
    }
    panel.refreshBus();
    if (view.masterSpeed != null) setMasterSpeed(view.masterSpeed);
    if (workspace) setDeskMode(view.workspace || 'live');
  } finally {
    viewApplying = false;
  }
}

function defaultProjectView() {
  const view = captureView();
  view.timeline = true;
  view.library = true;
  view.inspector = true;
  view.layerA = true;
  view.layerB = true;
  view.layerC = true;
  view.composition = true;
  view.catMute = [];
  view.fxFolds = {};
  view.folds = Object.fromEntries(LIBRARY_FOLDS.map(([id, open]) => [id, open]));
  view.workspace = 'live';
  view.panes = { library: 240, inspector: 280, dock: 320 };
  view.previewSplit = 38;
  view.timelineH = 120;
  view.timelinePx = 28;
  view.bus = { mute: { A: false, B: false, C: false }, solo: { A: false, B: false, C: false } };
  view.masterSpeed = 1;
  return view;
}

function absoluteMediaPath(path) {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/');
}

function normMediaPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function libraryReference(name) {
  const leaf = String(name || '').split(/[\\/]/).pop();
  return leaf ? `library/${leaf}` : '';
}

function isLibraryReference(path) {
  return normMediaPath(path).startsWith('library/');
}

function projectBundlePath(path) {
  return /^[^/]+\.media\//.test(normMediaPath(path));
}

function safeRelative(path) {
  const rel = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || absoluteMediaPath(rel)) return '';
  if (rel.split('/').some((part) => !part || part === '.' || part === '..')) return '';
  return rel;
}

function joinLibraryPath(root, rel) {
  const clean = safeRelative(rel);
  const base = String(root || '').replace(/[\\/]+$/, '');
  if (!base || !clean) return '';
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base}${sep}${clean.replace(/\//g, sep)}`;
}

function relativeToLibrary(root, file) {
  if (!isInsideGlobalLibrary(file, root)) return '';
  const parts = String(file).replace(/\\/g, '/').split('/');
  const rootParts = String(root).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  if (parts.length <= rootParts.length) return '';
  return safeRelative(parts.slice(rootParts.length).join('/'));
}

function sameFolder(a, b) {
  return !!a && !!b && normMediaPath(a) === normMediaPath(b);
}

function keepLibraryReference(path, name) {
  const raw = String(path || '').replace(/\\/g, '/');
  const at = raw.toLowerCase().indexOf('library/');
  const rest = at >= 0 ? safeRelative(raw.slice(at + 'library/'.length)) : '';
  return rest ? `library/${rest}` : libraryReference(name || path);
}

function peeledProjectRelative(path) {
  const raw = String(path || '').replace(/\\/g, '/');
  const match = raw.match(/(?:^|\/)((?:Source|Stock|Recordings)\/.+)$/i);
  if (!match) return '';
  const rest = match[1];
  const slash = rest.indexOf('/');
  const head = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  const canon = /^stock$/i.test(head) ? 'Stock' : /^recordings$/i.test(head) ? 'Recordings' : 'Source';
  return safeRelative(`${canon}/${tail}`);
}

function relativeToProject(projectPath, file) {
  const home = projectHome(projectPath);
  if (!home || !file || !isInsideGlobalLibrary(file, home)) return '';
  const parts = String(file).replace(/\\/g, '/').split('/');
  const rootParts = home.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  if (parts.length <= rootParts.length) return '';
  return safeRelative(parts.slice(rootParts.length).join('/'));
}

function poolPathFor(name, rawPath) {
  if (!rawPath || !isTauri()) return rawPath || '';
  if (isLibraryReference(rawPath)) return keepLibraryReference(rawPath, name);
  const beside = openedProjectFile();
  if (beside) {
    const peeled = peeledProjectRelative(rawPath);
    if (peeled) return peeled;
    if (absoluteMediaPath(rawPath)) {
      const rel = relativeToProject(beside, rawPath);
      if (rel) return rel;
    }
  }
  const chosen = savedLibraryDir() || globalMediaRoot;
  if (absoluteMediaPath(rawPath) && chosen) {
    const rel = relativeToLibrary(chosen, rawPath);
    if (rel) return rel;
  }
  if (absoluteMediaPath(rawPath) && globalMediaRoot && isInsideGlobalLibrary(rawPath, globalMediaRoot)) {
    if (savedLibraryDir() && !sameFolder(savedLibraryDir(), globalMediaRoot)) return libraryReference(name);
    return relativeToLibrary(globalMediaRoot, rawPath) || libraryReference(name);
  }
  if (!absoluteMediaPath(rawPath)) return safeRelative(rawPath);
  return '';
}

async function allowLibraryFolder(path) {
  if (!path || !isTauri()) return false;
  try { return await invoke('allow_media_folder', { path }) === true; } catch { return false; }
}

async function mediaFileReady(path) {
  if (!path || !isTauri()) return false;
  try { return await invoke('media_file_ready', { path }) === true; } catch { return false; }
}

async function resolveProjectMediaPath(stored, projectPath = '') {
  const path = String(stored || '').trim();
  if (!path) return '';
  if (isLibraryReference(path)) {
    await ensureGlobalMediaRoot();
    return resolveLibraryPath(path);
  }
  const home = projectPath || openedProjectFile();
  if (home) {
    // Portable form first: Source|Stock|Recordings|<legacy .media> relative to the .vjproj.
    const rel = absoluteMediaPath(path) ? peeledProjectRelative(path) : safeRelative(path);
    if (rel && (projectBundlePath(rel) || /^(Source|Stock|Recordings)\//i.test(rel))) {
      return projectDirJoin(home, rel);
    }
    if (!absoluteMediaPath(path)) {
      const plain = safeRelative(path);
      if (plain && projectBundlePath(plain)) return projectDirJoin(home, plain);
    }
    if (absoluteMediaPath(path)) {
      const inside = relativeToProject(home, path);
      if (inside) return projectDirJoin(home, inside);
      // Migration fallback: keep using the absolute path when the copy never landed.
      return path;
    }
    return '';
  }
  if (absoluteMediaPath(path)) return path;
  if (projectBundlePath(path)) return projectPath ? projectDirJoin(projectPath, path) : '';
  const root = await mediaLibraryRoot();
  if (!root) return '';
  return joinLibraryPath(root, path);
}

function savedMediaPath(projectPath, stored, absoluteHint = '') {
  const path = String(stored || '').trim();
  if (isLibraryReference(path)) return keepLibraryReference(path, path);
  const peeled = peeledProjectRelative(path) || peeledProjectRelative(absoluteHint);
  if (peeled) return peeled;
  const home = projectPath || openedProjectFile();
  if (home) {
    const beside = relativeToProject(home, absoluteHint) || relativeToProject(home, path);
    if (beside) return beside;
  }
  if (path && !absoluteMediaPath(path)) {
    const rel = safeRelative(path);
    if (rel && !absoluteMediaPath(rel)) return rel;
  }
  return '';
}

async function libraryStoredPath(stored, name, projectPath, absoluteHint = '') {
  const path = String(stored || '').trim();
  if (isLibraryReference(path)) return keepLibraryReference(path, name);
  const kept = savedMediaPath(projectPath, path, absoluteHint);
  if (kept) return kept;
  const home = projectPath || openedProjectFile();
  if (home && (absoluteMediaPath(path) || absoluteMediaPath(absoluteHint))) return '';
  const root = await mediaLibraryRoot();
  const globalRoot = await ensureGlobalMediaRoot();
  let abs = '';
  if (absoluteMediaPath(path)) abs = path;
  else if (absoluteHint && absoluteMediaPath(absoluteHint)) abs = absoluteHint;
  else if (path && projectBundlePath(path) && projectPath) abs = projectDirJoin(projectPath, path);
  else if (path && root) abs = joinLibraryPath(root, path);
  if (abs && root && isInsideGlobalLibrary(abs, root)) {
    const rel = relativeToLibrary(root, abs);
    if (rel) return rel;
  }
  if (abs && globalRoot && isInsideGlobalLibrary(abs, globalRoot) && !sameFolder(root, globalRoot)) {
    return libraryReference(name || abs);
  }
  if (path && !absoluteMediaPath(path) && !projectBundlePath(path)) {
    const rel = safeRelative(path);
    if (rel) return rel;
  }
  return '';
}

let globalMediaRoot = '';

async function ensureGlobalMediaRoot() {
  if (globalMediaRoot || !IS_TAURI) return globalMediaRoot;
  try { globalMediaRoot = (await invoke('global_media_dir')) || ''; } catch { globalMediaRoot = ''; }
  return globalMediaRoot;
}

function resolveLibraryPath(path) {
  if (!isLibraryReference(path)) return path || '';
  if (!globalMediaRoot) return '';
  const leaf = String(path).replace(/\\/g, '/').slice('library/'.length);
  const sep = globalMediaRoot.includes('\\') ? '\\' : '/';
  return `${globalMediaRoot.replace(/[\\/]+$/, '')}${sep}${leaf}`;
}

function isInsideGlobalLibrary(path, root) {
  if (!path || !root || !absoluteMediaPath(path)) return false;
  const file = normMediaPath(path);
  const base = normMediaPath(root);
  return file === base || file.startsWith(`${base}/`);
}

function projectDirJoin(projectPath, rel) {
  const dir = projectPath.replace(/[/\\][^/\\]+$/, '');
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${String(rel).replace(/[\\/]/g, sep)}`;
}

const PROJECT_CHUNK = 8 * 1024 * 1024;

async function storeProjectAsset(projectPath, leaf, file, sourcePath) {
  if (!IS_TAURI) return '';
  const beside = savedMediaPath(projectPath, '', sourcePath);
  if (beside && /^(Source|Stock|Recordings)\//.test(beside)) return beside;
  if (sourcePath && absoluteMediaPath(sourcePath)) {
    try {
      return await invoke('copy_project_asset', { projectPath, sourcePath, leaf });
    } catch { /* the path may be stale; write the bytes we still have */ }
  }
  if (!file) return '';
  const ready = await invoke('project_asset_ready', { projectPath, leaf, size: file.size }).catch(() => null);
  if (ready) return ready;
  let rel = '';
  const total = file.size;
  for (let offset = 0; offset < total || offset === 0; offset += PROJECT_CHUNK) {
    const end = Math.min(total, offset + PROJECT_CHUNK);
    const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    rel = await invoke('write_project_asset', chunk, {
      headers: {
        'x-project': encodeURIComponent(projectPath),
        'x-leaf': encodeURIComponent(leaf),
        'x-append': offset > 0 ? '1' : '0',
      },
    });
    if (total === 0) break;
  }
  return rel || '';
}

/** True when a relative path points at media beside the .vjproj (portable). */
function isProjectRelativeMedia(path) {
  const rel = safeRelative(path);
  if (!rel || isLibraryReference(rel)) return false;
  return projectBundlePath(rel) || /^(Source|Stock|Recordings)\//i.test(rel);
}

async function absoluteForProjectCopy(name, stored, hint, vaultRows, libraryRoot, globalRoot) {
  if (absoluteMediaPath(hint)) return hint;
  if (absoluteMediaPath(stored)) return stored;
  if (isLibraryReference(stored) && globalRoot) {
    const abs = resolveLibraryPath(stored);
    if (abs) return abs;
  }
  const vault = matchMediaName(vaultRows, name);
  if (vault?.path && absoluteMediaPath(vault.path)) return vault.path;
  if (stored && !absoluteMediaPath(stored) && !isLibraryReference(stored) && libraryRoot) {
    const abs = joinLibraryPath(libraryRoot, stored);
    if (abs) return abs;
  }
  if (globalRoot) {
    const abs = joinLibraryPath(globalRoot, String(name).split(/[\\/]/).pop() || name);
    if (abs && await mediaFileReady(abs)) return abs;
  }
  return '';
}

async function ensureCopiedBeside(projectPath, name, {
  stored = '',
  hint = '',
  file = null,
  vaultRows = [],
  sideRows = [],
  libraryRoot = '',
  globalRoot = '',
} = {}) {
  const side = matchMediaName(sideRows, name);
  const sideRel = side?.path ? (besideStoredPath(projectPath, side.path) || savedMediaPath(projectPath, '', side.path)) : '';
  if (sideRel && isProjectRelativeMedia(sideRel)) {
    const abs = projectDirJoin(projectPath, sideRel);
    if (abs && await mediaFileReady(abs)) return sideRel;
  }
  if (stored && isProjectRelativeMedia(stored) && !isLibraryReference(stored)) {
    const abs = projectDirJoin(projectPath, stored);
    if (abs && await mediaFileReady(abs)) return safeRelative(stored);
  }
  const source = await absoluteForProjectCopy(name, stored, hint, vaultRows, libraryRoot, globalRoot);
  const blob = file || library.get(name);
  const rel = await storeProjectAsset(projectPath, name, blob, source);
  return rel && isProjectRelativeMedia(rel) ? rel : '';
}

async function bundleProjectAssets(data, projectPath) {
  if (!isTauri() || !projectPath) return data;
  await adoptProjectFolders(projectPath);
  const saved = JSON.parse(JSON.stringify(data));
  const missed = [];
  const globalRoot = await ensureGlobalMediaRoot();
  const libraryRoot = await mediaLibraryRoot();
  const sideRows = await projectSideRows(projectPath);
  let vaultRows = [];
  try {
    const rows = await invoke('list_global_media', { saveDir: '' });
    vaultRows = Array.isArray(rows) ? rows : [];
  } catch { /* copy from library bytes when the vault list is unavailable */ }
  const copyOpts = { vaultRows, sideRows, libraryRoot, globalRoot };

  // Brand Overlay assets travel with the stick even without Add to Project.
  const pool = Array.isArray(saved.mediaPool) ? saved.mediaPool.slice() : [];
  const have = new Set(pool.map((item) => item?.name).filter(Boolean));
  for (const name of brandTaggedNames()) {
    if (!name || mediaKind(name) === 'audio' || have.has(name)) continue;
    pool.push({
      id: name,
      name,
      kind: mediaKind(name) === 'image' ? 'image' : 'video',
      path: brandAssetPath(name) || '',
    });
    have.add(name);
  }
  saved.mediaPool = pool;

  for (const item of saved.mediaPool || []) {
    if (!item?.name) continue;
    const previous = typeof item.path === 'string' ? item.path : '';
    const hint = clipSourcePaths.get(item.name) || brandAssetPaths.get(item.name) || '';
    try {
      const rel = await ensureCopiedBeside(projectPath, item.name, {
        ...copyOpts,
        stored: previous,
        hint,
        file: library.get(item.name),
      });
      if (rel) {
        item.path = rel;
        brandAssetPaths.set(item.name, rel);
      } else {
        // Keep the previous path (absolute / library/ ok as migration fallback). Never blank to ''.
        item.path = previous;
        missed.push(item.name);
      }
    } catch (err) {
      item.path = previous;
      missed.push(item.name);
      console.warn('Could not store project media', item.name, err);
    }
  }

  const audioFileName = saved.desk?.audio?.file || '';
  if (saved.desk?.audio?.mode === 'file' && audioFileName) {
    const previous = saved.desk.audio.path || '';
    const audioHint = absoluteMediaPath(audioAssetPath) ? audioAssetPath : '';
    try {
      const audioFile = await library.getAudio(audioFileName);
      const rel = await ensureCopiedBeside(projectPath, audioFileName, {
        ...copyOpts,
        stored: previous,
        hint: audioHint,
        file: audioFile,
      });
      if (rel) {
        saved.desk.audio.path = rel;
        audioAssetPath = rel;
      } else {
        saved.desk.audio.path = previous;
        missed.push(audioFileName);
      }
    } catch (err) {
      saved.desk.audio.path = previous;
      missed.push(audioFileName);
      console.warn('Could not store the audio file', err);
    }
  }

  for (let i = 0; i < 3; i += 1) {
    const row = saved.desk?.logos?.[i];
    const slot = stings.slots[i];
    if (!row || !slot?.cacheKey) continue;
    const previous = row.path || '';
    const logoHint = absoluteMediaPath(slot.assetPath || '') ? slot.assetPath : '';
    try {
      const file = await library.getBlob(slot.cacheKey);
      const leaf = `logo-${i + 1}-${file?.name || row.name || 'logo'}`;
      const rel = await ensureCopiedBeside(projectPath, leaf, {
        ...copyOpts,
        stored: previous,
        hint: logoHint,
        file,
      });
      if (rel) {
        row.path = rel;
        slot.assetPath = rel;
      } else {
        row.path = previous;
        missed.push(row.name || `Logo ${i + 1}`);
      }
    } catch (err) {
      row.path = previous;
      missed.push(row.name || `Logo ${i + 1}`);
      console.warn('Could not store a logo', err);
    }
  }

  // Tags (including Brand) live in the .vjproj so another machine does not need localStorage.
  const tagNames = [
    ...pool.map((item) => item?.name),
    audioFileName,
    ...(saved.desk?.logos || []).map((row) => row?.name),
    ...brandTaggedNames(),
  ];
  saved.mediaTags = exportMediaTagsFor(tagNames);

  if (missed.length) {
    showToast(`Saved the project. Could not copy into the folder: ${missed.join(', ')}`, true);
  }
  return saved;
}

function wantedProjectNames() {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    const text = String(name || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    names.push(text);
  };
  for (const item of project.mediaPool) {
    if (!item?.name || item.kind === 'audio' || mediaKind(item.name) === 'audio') continue;
    add(item.name);
  }
  for (const name of brandTaggedNames()) {
    if (mediaKind(name) !== 'audio') add(name);
  }
  add(project.desk?.audio?.file);
  for (const slot of stings.slots) add(slot?.name);
  return names;
}

function matchMediaName(rows, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return (rows || []).find((row) => String(row?.name || '').trim().toLowerCase() === want) || null;
}

async function listFolderMedia(dir) {
  if (!dir || !isTauri()) return [];
  try {
    const rows = await invoke('list_dir_media', { dir });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function projectSideRows(projectPath) {
  const rows = [];
  for (const name of ['Source', 'Stock', 'Recordings']) {
    const dir = projectChild(projectPath, name);
    if (!(await allowLibraryFolder(dir))) continue;
    rows.push(...await listFolderMedia(dir));
  }
  return rows;
}

function storedPathForWantedName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return '';
  const poolItem = project.mediaPool.find((item) => String(item?.name || '').toLowerCase() === key);
  if (poolItem?.path) return poolItem.path;
  const audioName = project.desk?.audio?.file || '';
  if (audioName && audioName.toLowerCase() === key) return project.desk?.audio?.path || '';
  const logo = stings.slots.find((slot) => slot?.name && slot.name.toLowerCase() === key);
  if (logo?.assetPath) return logo.assetPath;
  return brandAssetPaths.get(name) || '';
}

async function connectFoundFile(name, filePath) {
  if (!name || !filePath) return;
  const ready = await mediaFileReady(filePath);
  if (!ready) return;
  const audioName = project.desk?.audio?.file || '';
  if (audioName && audioName.toLowerCase() === name.toLowerCase()) {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const res = await fetch(convertFileSrc(filePath));
    if (!res.ok) return;
    const blob = await res.blob();
    const stored = project.desk?.audio?.path || '';
    const beside = besideStoredPath(openedProjectFile(), filePath);
    audioAssetPath = stored && !absoluteMediaPath(stored) ? stored : (beside || '');
    await useAudioFile(new File([blob], name, { type: blob.type || 'audio/mpeg' }));
    return;
  }
  const logo = stings.slots.find((slot) => slot?.name && slot.name.toLowerCase() === name.toLowerCase());
  if (logo) {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const res = await fetch(convertFileSrc(filePath));
    if (!res.ok) return;
    const blob = await res.blob();
    const kept = logo.assetPath;
    const beside = besideStoredPath(openedProjectFile(), filePath);
    stings.loadFile(logo.index, new File([blob], name, { type: blob.type || 'image/png' }));
    logo.assetPath = kept && !absoluteMediaPath(kept) ? kept : (beside || '');
    return;
  }
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  library.addRemote({ name, url: convertFileSrc(filePath), path: filePath });
}

function besideStoredPath(projectPath, filePath) {
  return relativeToProject(projectPath, filePath) || peeledProjectRelative(filePath);
}

async function connectProjectFiles(projectPath) {
  if (!isTauri() || !projectPath || !projectHome(projectPath)) return;
  await allowLibraryFolder(projectHome(projectPath));
  const sideRows = await projectSideRows(projectPath);
  const found = new Map();
  const missing = [];
  for (const name of wantedProjectNames()) {
    // Resolve relative paths from the project folder first.
    const stored = storedPathForWantedName(name);
    let abs = '';
    if (stored) {
      abs = await resolveProjectMediaPath(stored, projectPath);
      if (abs && absoluteMediaPath(abs) && await mediaFileReady(abs)) {
        found.set(name.toLowerCase(), abs);
        await connectFoundFile(name, abs);
        continue;
      }
    }
    const hit = matchMediaName(sideRows, name);
    if (hit?.path && await mediaFileReady(hit.path)) {
      found.set(name.toLowerCase(), hit.path);
      await connectFoundFile(name, hit.path);
    } else missing.push(name);
  }
  let still = missing;
  if (still.length) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ title: 'Find a missing file', multiple: false });
      if (typeof picked === 'string' && picked) {
        const folder = picked.replace(/[/\\][^/\\]+$/, '');
        const rows = await listFolderMedia(folder);
        const left = [];
        for (const name of still) {
          const hit = matchMediaName(rows, name);
          const prepared = hit?.path ? await invoke('file_is_prepared', { path: hit.path }).catch(() => false) : false;
          if (hit?.path && prepared) {
            found.set(name.toLowerCase(), hit.path);
            await connectFoundFile(name, hit.path);
          }
          else left.push(name);
        }
        still = left;
      }
    } catch { /* the names stay missing */ }
  }
  // Mark missing in the UI only — never library.remove / wipe IndexedDB for absent clips.
  for (const name of still) {
    const audioName = project.desk?.audio?.file || '';
    if (audioName && audioName.toLowerCase() === name.toLowerCase()) {
      setStatus($('audio-status'), `${audioName} is missing from this project folder`, true);
      continue;
    }
    const logo = stings.slots.find((slot) => slot?.name && slot.name.toLowerCase() === name.toLowerCase());
    if (logo && !logo.ready) stings.markMissing(logo.index);
  }
  let poolChanged = false;
  const pool = project.mediaPool.map((item) => {
    const hit = found.get(String(item?.name || '').toLowerCase());
    const rel = hit ? besideStoredPath(projectPath, hit) : '';
    const stored = typeof item.path === 'string' ? item.path : '';
    if (rel && (!stored || absoluteMediaPath(stored) || isLibraryReference(stored))) {
      poolChanged = true;
      return { ...item, path: rel };
    }
    if (stored && absoluteMediaPath(stored)) {
      const peeled = peeledProjectRelative(stored) || relativeToProject(projectPath, stored);
      if (peeled) {
        poolChanged = true;
        return { ...item, path: peeled };
      }
      // Keep absolute / library paths as migration fallbacks; do not blank.
      return item;
    }
    return item;
  });
  if (poolChanged) project.setMediaPool(pool);
  refreshLibraryUi();
}

async function pointProjectAtFolder(projectPath) {
  if (!isTauri() || !projectPath) return;
  openProjectPath = projectPath;
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  await allowLibraryFolder(projectHome(projectPath));
  await hydrateProjectMedia();
  for (let i = 0; i < 3; i += 1) {
    const slot = stings.slots[i];
    const rel = slot?.assetPath || '';
    if (!slot || !rel || absoluteMediaPath(rel) || slot.ready) continue;
    try {
      const abs = await resolveProjectMediaPath(rel, projectPath);
      const ready = abs && absoluteMediaPath(abs) && await mediaFileReady(abs);
      if (!ready) {
        stings.markMissing(i);
        continue;
      }
      const res = await fetch(convertFileSrc(abs));
      if (!res.ok) {
        stings.markMissing(i);
        continue;
      }
      const blob = await res.blob();
      const name = slot.name || rel.split(/[/\\]/).pop() || `logo-${i + 1}`;
      stings.loadFile(i, new File([blob], name, { type: blob.type || 'video/mp4' }));
      slot.assetPath = rel;
    } catch {
      stings.markMissing(i);
    }
  }
  const audioRow = project.desk?.audio;
  if (audioRow?.mode === 'file' && audioRow.file) {
    let file = null;
    if (audioRow.path) {
      try {
        const abs = await resolveProjectMediaPath(audioRow.path, projectPath);
        const ready = abs && absoluteMediaPath(abs) && await mediaFileReady(abs);
        if (ready) {
          const res = await fetch(convertFileSrc(abs));
          if (res.ok) {
            const blob = await res.blob();
            file = new File([blob], audioRow.file, { type: blob.type || 'audio/mpeg' });
          }
        }
      } catch { /* the audio file stays missing */ }
    }
    if (!file) file = await library.getAudio(audioRow.file);
    if (file) {
      const stored = audioRow.path || '';
      audioAssetPath = stored && !absoluteMediaPath(stored)
        ? stored
        : (peeledProjectRelative(stored) || relativeToProject(projectPath, stored) || '');
      await useAudioFile(file);
    } else if (audioRow.path) {
      setStatus($('audio-status'), `${audioRow.file} is missing from this project folder`, true);
    }
  }
}

function projectSnapshot() {
  const data = projectFile();
  let path = '';
  try { path = localStorage.getItem('vj.lastProjectPath') || ''; } catch { path = ''; }
  const leaf = path.split(/[/\\]/).pop()?.replace(/\.(vjproj|json)$/i, '') || '';
  return {
    name: data.name || leaf || 'This project',
    path,
    document: JSON.stringify(data),
  };
}

function projectFile() {
  if (deskReady) {
    project.setDesk(captureDesk());
    project.setView(captureView());
  }
  const base = project.toJSON();
  const tagNames = [
    ...(base.mediaPool || []).map((item) => item?.name),
    base.desk?.audio?.file,
    ...(base.desk?.logos || []).map((row) => row?.name),
    ...brandTaggedNames(),
  ];
  return {
    ...base,
    mediaTags: exportMediaTagsFor(tagNames),
    live: { params: params.snapshot(), media: currentMedia() },
    output: { aspect: outputAspect, renderScale, uiMode: document.body.classList.contains('live-mode') ? 'live' : 'timeline' },
    outputMap: outputMap.toJSON(),
    bpmMode,
    midi: midi.mappings,
    macros: macros.toJSON(),
    lfo: lfo.toJSON(),
    modMatrix: mods.toJSON(),
  };
}

const LAST_PROJECT_KEY = 'vj.lastProjectPath';

function downloadProjectFile(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function rememberProjectPath(path) {
  try { localStorage.setItem(LAST_PROJECT_KEY, path); } catch { /* ignore */ }
}

function currentProjectPath() {
  try { return localStorage.getItem(LAST_PROJECT_KEY) || ''; } catch { return ''; }
}

function rememberSavedProject(path, bundled) {
  rememberProjectPath(path);
  openProjectPath = path;
  audioAssetPath = bundled.desk?.audio?.path || '';
  for (let i = 0; i < 3; i += 1) {
    const rel = bundled.desk?.logos?.[i]?.path || '';
    if (rel && stings.slots[i]) stings.slots[i].assetPath = rel;
  }
  if (bundled.desk) project.setDesk(captureDesk());
  if (Array.isArray(bundled.mediaPool)) project.setMediaPool(bundled.mediaPool);
  if (bundled.mediaTags && typeof bundled.mediaTags === 'object') {
    setProjectMediaTags(bundled.mediaTags);
    for (const item of bundled.mediaPool || []) {
      if (item?.name && item.path) brandAssetPaths.set(item.name, item.path);
    }
  }
}

function disarmProjectPath() {
  openProjectPath = '';
  try { localStorage.removeItem(LAST_PROJECT_KEY); } catch { /* ignore */ }
}

async function storeProjectFile(data, filename, { ask = true, title = 'Save Project' } = {}) {
  if (!isTauri()) {
    const root = await browserProjectRoot();
    if (root) {
      try {
        await writeBrowserProject(root, data);
        showToast(`Saved in ${root.name || 'the chosen folder'}.`);
        return true;
      } catch (err) {
        showToast(err?.message || 'Could not save in that folder.', true);
        return false;
      }
    }
    downloadProjectFile(data, filename);
    return true;
  }
  let path = ask ? '' : currentProjectPath();
  if (!path) {
    path = await createNewProjectFile();
    if (!path) return false;
  }
  const bundled = await bundleProjectAssets(data, path);
  await invoke('write_text_file', { path, contents: JSON.stringify(bundled, null, 2) });
  rememberSavedProject(path, bundled);
  return true;
}

function projectTitle() {
  const name = ($('project-name')?.value || project.name || '').replace(/\s+/g, ' ').trim();
  return name || 'Untitled project';
}

function projectFileName() {
  const raw = projectTitle().slice(0, 48);
  const safe = raw.replace(/[\\/:*?"<>|]+/g, ' ').replace(/[. ]+$/g, '').trim() || 'Untitled project';
  return /\.vjproj$/i.test(safe) ? safe : `${safe}.vjproj`;
}

function confirmCloseProject() {
  const modal = $('close-project');
  const question = $('close-project-q');
  const saveBtn = $('close-project-save');
  const dropBtn = $('close-project-discard');
  const cancelBtn = $('close-project-cancel');
  if (!modal || !question || !saveBtn || !dropBtn || !cancelBtn) return Promise.resolve('discard');
  question.textContent = `Do you want to save changes to ${projectTitle()} before closing?`;
  modal.hidden = false;
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.hidden = true;
      saveBtn.removeEventListener('click', onSave);
      dropBtn.removeEventListener('click', onDrop);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onSave = () => finish('save');
    const onDrop = () => finish('discard');
    const onCancel = () => finish('cancel');
    const onBackdrop = (event) => {
      if (event.target === modal) finish('cancel');
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish('cancel');
    };
    saveBtn.addEventListener('click', onSave);
    dropBtn.addEventListener('click', onDrop);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    saveBtn.focus();
  });
}

async function confirmLeaveProject() {
  const choice = await confirmCloseProject();
  if (choice === 'cancel') return false;
  if (choice === 'save') return saveProject();
  return true;
}

async function saveProject() {
  commitProjectName();
  const existing = currentProjectPath();
  try {
    const saved = await storeProjectFile(projectFile(), projectFileName(), { ask: !existing });
    if (saved && isTauri()) showToast(`Saved ${projectTitle()}`);
    return saved;
  } catch (err) {
    showToast(err?.message || String(err) || 'Could not save the project.', true);
    return false;
  }
}

async function saveNewProject() {
  commitProjectName();
  const data = projectFile();
  data.id = crypto.randomUUID?.() || `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  data.name = project.name || projectTitle();
  try {
    const saved = await storeProjectFile(data, projectFileName(), { ask: true, title: 'Save New Project' });
    if (saved && isTauri()) showToast(`Saved ${projectTitle()}`);
    return saved;
  } catch (err) {
    showToast(err?.message || String(err) || 'Could not save the project.', true);
    return false;
  }
}

async function reopenLastProject() {
  if (!isTauri()) return;
  let on = false;
  let path = '';
  try {
    on = localStorage.getItem('vj.reopenProject') === '1';
    path = localStorage.getItem(LAST_PROJECT_KEY) || '';
  } catch { /* start from the template */ }
  if (!(on && path)) return;
  let opened = false;
  try {
    const text = await invoke('read_text_file', { path });
    const leaf = path.split(/[/\\]/).pop() || 'project.vjproj';
    opened = await loadProject(new File([text], leaf, { type: 'application/json' }), path) === true;
  } catch {
    opened = false;
  }
  if (opened) return;
  disarmProjectPath();
  if (isMacDesktop()) newProject({ keepLastPath: true });
}

function clearShowBuffers() {
  for (const layer of layers) layer.clearBuffers(renderer);
}

async function loadProject(file, sourcePath = '') {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('That file is not valid JSON.');
    return false;
  }
  const looksLikeProject = data && (
    Array.isArray(data.scenes)
    || Array.isArray(data.timeline)
    || Array.isArray(data.mediaPool)
    || Array.isArray(data.timeline?.cues)
  );
  if (!looksLikeProject) {
    alert('That file is not a Y2K VJ project.');
    return false;
  }
  openProjectPath = sourcePath || '';
  project.setName(data.name);
  paintProjectName();
  // Project tags travel on the stick; do not depend on this machine's vj.mediaTags.
  setProjectMediaTags(data.mediaTags && typeof data.mediaTags === 'object' ? data.mediaTags : {});
  brandAssetPaths.clear();
  const doc = coerceDocument(data);
  const names = new Set(doc.mediaPool.map((item) => item.name));
  const grab = (media) => {
    for (const slot of Object.values(media || {})) {
      if (slot?.key?.startsWith('file:')) names.add(slot.key.slice(5));
    }
  };
  for (const scene of doc.scenes) grab(scene.media);
  grab(data.live?.media);
  for (const name of brandTaggedNames()) names.add(name);
  await library.ensureCached([...names]);
  const pool = doc.mediaPool.map((item) => ({ ...item }));
  const have = new Set(pool.map((item) => item.name));
  for (const name of names) {
    if (have.has(name)) continue;
    pool.push({ id: name, name, kind: mediaKind(name), path: '' });
    have.add(name);
  }
  for (const item of pool) {
    if (item?.name && item.path && !absoluteMediaPath(item.path) && !isLibraryReference(item.path)) {
      brandAssetPaths.set(item.name, item.path);
    }
  }
  project.setMediaPool(pool);
  await hydrateProjectMedia();
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
    setRenderScale(data.output.renderScale);
    if (data.output.uiMode) setUiMode(data.output.uiMode);
  }
  if (data.outputMap) outputMap.apply(data.outputMap);
  if (data.bpmMode || data.bpmSource) setBpmMode(data.bpmMode || data.bpmSource);
  if (doc.desk) {
    project.desk = doc.desk;
    applyDesk(doc.desk);
  }
  project.setLocks(doc.locks);
  applyLocks();
  if (!doc.desk) project.setDesk(captureDesk());
  if (doc.view) applyProjectView(doc.view, { workspace: true });
  await restoreLogoFiles();
  await pointProjectAtFolder(sourcePath);
  if (sourcePath) await adoptProjectFolders(sourcePath);
  if (sourcePath) await connectProjectFiles(sourcePath);
  {
    const shown = showRecordOutput(doc.recordOutput);
    project.setRecordOutput(shown);
    const routed = showRoutes(doc.recordings, doc.outputs);
    project.setRoutes({ recordings: routed.recordings, outputs: routed.outputs });
  }
  project.setCompositions(doc.compositions);
  paintCompositions();
  project.setPacks(doc.packs);
  refreshAudioPacks();
  if (data.live?.params) {
    for (const [id, v] of Object.entries(data.live.params)) {
      if (!params.defs.get(id)?.layer) params.set(id, v);
    }
    scenes.launch({ params: data.live.params, media: data.live.media || {}, routing: layerRouting() }, 0);
  }
  // Older projects stored one Scale for all layers under Recordings.
  if (data.output?.fit) migrateLegacyFit(data.output.fit);
  refreshLayerUi();
  refreshLibraryUi();
  sceneBar.setBank(0);
  panel.applyFoldDefaults();
  if (doc.view) project.setView(doc.view);
  params.history?.clear();
  return true;
}

function isMacDesktop() {
  return isTauri() && (/Mac/i.test(navigator.userAgent || '') || /Mac/i.test(navigator.platform || ''));
}

function newProject({ keepLastPath = false } = {}) {
  audioAssetPath = '';
  audio.clearFile();
  setProjectMediaTags(null);
  brandAssetPaths.clear();
  try {
    localStorage.removeItem('vj.audioFile');
    if (!keepLastPath) {
      localStorage.removeItem(LAST_PROJECT_KEY);
      openProjectPath = '';
    }
    localStorage.setItem(LIBRARY_FOLD_KEY, JSON.stringify(Object.fromEntries(LIBRARY_FOLDS)));
  } catch { /* ignore */ }
  setStatus($('audio-status'), '');
  paintGlanceAudio();
  paintAudioRecent();
  project.setName('');
  paintProjectName();
  project.setMediaPool([]);
  refreshLibraryUi();
  refreshMediaSelect();
  resetProjectDesk();
  project.setRecordOutput({
    logoRecord: true,
    logoOutput: true,
  });
  showRecordOutput(project.recordOutput);
  project.setRoutes({
    recordings: { audio: true, screensaver: false, codeOverlay: !!$('hud-enable')?.checked },
    outputs: { audio: true, screensaver: true, codeOverlay: !!$('hud-enable')?.checked },
  });
  showRoutes(project.recordings, project.outputs);
  project.setCompositions([null, null, null]);
  paintCompositions();
  project.setPacks(seedPacks());
  refreshAudioPacks();
  project.setDesk(captureDesk());
  project.setLocks({});
  applyLocks();
  timeline.stop();
  scenes.replaceAll([]);
  timeline.load({
    bpm: 120, bars: 16, loop: true, fadeBeats: 4, fadeSec: 1, fadeStyle: 0, cues: [],
  });
  setTempo(120, { history: false });
  mods.replace({});
  lfo.replace({});
  macros.replace([]);
  panel.refreshAutomation();
  for (const def of params.defs.values()) {
    params.set(def.id, def.defaultValue);
  }
  setAspect('16:9');
  for (const L of LAYERS) {
    bus.mute[L] = false;
    bus.solo[L] = false;
    if (layerById[L].mediaKey !== 'none') setLayerMedia(L, 'none');
  }
  panel.selectLayer('A');
  panel.refreshBus();
  clearShowBuffers();
  refreshLayerUi();
  sceneBar.setBank(0);
  applyProjectView(defaultProjectView(), { workspace: true });
  savePanes();
  project.setView(captureView());
  params.history?.clear();
}

const sceneBar = new SceneBar({
  scenes,
  timeline,
  midi,
  onLaunch: (id, fade) => triggerScene(id, fade ?? timeline.fadeSeconds, { history: true }),
  groupEdit: (fn) => params.history.group(fn),
  onSave: saveScene,
  onExport: saveProject,
  onSaveNew: saveNewProject,
  onImport: loadProject,
  onPickProject: async () => {
    if (!(await confirmLeaveProject())) return true;
    if (!isTauri()) return false;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        title: 'Load Project',
        filters: [{ name: 'Y2K VJ project', extensions: ['vjproj', 'json'] }],
      });
      if (typeof picked !== 'string' || !picked) return true;
      const text = await invoke('read_text_file', { path: picked });
      const leaf = picked.split(/[/\\]/).pop() || 'project.vjproj';
      const opened = await loadProject(new File([text], leaf, { type: 'application/json' }), picked);
      if (opened) rememberProjectPath(picked);
    } catch (err) {
      disarmProjectPath();
      showToast(err?.message || String(err) || 'Could not load the project.', true);
    }
    return true;
  },
  onNew: async () => {
    if (!(await confirmLeaveProject())) return;
    newProject();
  },
  onTap: tapTempo,
  clipLayer: () => (panel.selected === 'B' || panel.selected === 'C' ? panel.selected : 'A'),
  hasMedia: (name) => library.has(name),
  onDropFiles: (files) => addFiles(files, { bin: true }),
});
scenes.onChange(() => {
  refreshLibraryUi();
  sceneBar.updateActive();
  syncSceneClipWarm();
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
  persistDesk();
  paintGlanceAudio();
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
  paintGlanceAudio();
}

const AUDIO_OUTPUT_KEY = 'vj.audioOutput';
let audioOutputId = '';

function normalizeOutputId(id) {
  if (!id || id === 'default' || id === 'communications') return '';
  return id;
}

async function listAudioOutputs({ ask = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices();
  const outputsOf = (list) => list.filter((d) => {
    if (d.kind !== 'audiooutput') return false;
    return normalizeOutputId(d.deviceId) !== '';
  });
  let outputs = outputsOf(devices);
  const unnamed = !outputs.length || outputs.every((d) => !d.label);
  if (ask && unnamed) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      outputs = outputsOf(devices);
    } catch { /* names stay blank until the browser is allowed to listen */ }
  }
  return outputs;
}

async function setAudioOutput(deviceId) {
  audioOutputId = normalizeOutputId(deviceId);
  try { localStorage.setItem(AUDIO_OUTPUT_KEY, audioOutputId); } catch { /* ignore */ }
  const sel = $('audio-output');
  if (sel && [...sel.options].some((opt) => opt.value === audioOutputId) && sel.value !== audioOutputId) {
    sel.value = audioOutputId;
  }
  await setAudioSink(audioOutputId);
  await applyDocumentSink(document, audioOutputId);
  try { await applyDocumentSink(outputWin.win?.document, audioOutputId); } catch { /* popup closed */ }
}

async function refreshAudioOutputs({ ask = false } = {}) {
  const sel = $('audio-output');
  if (!sel) return;
  const outputs = await listAudioOutputs({ ask });
  const keep = outputs.some((d) => d.deviceId === audioOutputId);
  const next = keep ? audioOutputId : '';
  sel.replaceChildren(new Option('System Default', ''));
  outputs.forEach((device, index) => {
    sel.add(new Option(device.label || `Output ${index + 1}`, device.deviceId));
  });
  sel.value = next;
  await setAudioOutput(next);
}

try { audioOutputId = normalizeOutputId(localStorage.getItem(AUDIO_OUTPUT_KEY) || ''); } catch { /* ignore */ }
$('audio-output')?.addEventListener('change', () => {
  setAudioOutput($('audio-output').value).catch((err) => console.warn('Could not switch audio output', err));
});
navigator.mediaDevices?.addEventListener('devicechange', () => {
  refreshAudioOutputs().catch((err) => console.warn('Audio output list failed', err));
});
refreshAudioOutputs().catch((err) => console.warn('Audio output list failed', err));

function paintGlanceAudio() {
  const el = $('glance-audio');
  if (!el) return;
  const nameEl = el.querySelector('b');
  const timeEl = el.querySelector('i');
  let name = '';
  let time = '';
  let title = '';
  if (audioMode === 'file' && audio.fileName) {
    name = audio.fileName;
    time = $('audio-time')?.textContent || '';
    title = audio.fileName;
  } else if (audioMode === 'device') {
    const sel = $('audio-device');
    const chosen = sel?.value ? (sel.selectedOptions[0]?.textContent || '').trim() : '';
    if (chosen) {
      name = chosen;
      title = chosen;
    }
  }
  if (!name) {
    const mode = audioMode === 'file' ? 'Local File' : 'Live Hardware';
    name = `${mode} · ready to load`;
  }
  if (nameEl.textContent !== name) nameEl.textContent = name;
  const showTime = !!time;
  if (timeEl.hidden === showTime) timeEl.hidden = !showTime;
  if (showTime && timeEl.textContent !== time) timeEl.textContent = time;
  if ((el.getAttribute('title') || '') !== title) {
    if (title) el.title = title;
    else el.removeAttribute('title');
  }
}

function syncTransport() {
  const t = audio.transport;
  $('audio-play').disabled = !t.ready;
  $('audio-scrub').disabled = !t.ready;
  if (t.ready) {
    if (!scrubbing) $('audio-scrub').value = String(Math.round((t.currentTime / t.duration) * 1000));
    $('audio-time').textContent = `${fmtTime(t.currentTime)} / ${fmtTime(t.duration)}`;
    $('audio-play').textContent = t.paused ? 'Play' : 'Pause';
  }
  paintGlanceAudio();
}

const masterTransport = { state: 'playing' };

const XDJ_BUTTONS = [
  ['play', 'Play'],
  ['cue', 'Cue'],
  ['beat', 'Beat'],
  ['jog', 'Jog', true],
  ['tempo', 'Tempo', true],
  ['hotA', 'Hot Cue A'],
  ['hotB', 'Hot Cue B'],
  ['hotC', 'Hot Cue C'],
  ['loop', 'Loop'],
  ['slip', 'Slip'],
];
const XDJ_ASSIGN = [
  ['none', 'None'],
  ['strobe', 'Strobe'],
  ['glitch', 'Glitch'],
  ['code', 'Code Overlay'],
  ['logo1', 'Logo 1'],
  ['logo2', 'Logo 2'],
  ['logo3', 'Logo 3'],
];
const XDJ_KEY = 'vj.xdjAssign';

function blankXdjDeck() {
  const deck = {};
  for (const [id] of XDJ_BUTTONS) deck[id] = 'none';
  return deck;
}

function xdjAssignValue(value) {
  return XDJ_ASSIGN.some(([id]) => id === value) ? value : 'none';
}

function loadXdjAssign() {
  const decks = { 1: blankXdjDeck(), 2: blankXdjDeck(), 3: blankXdjDeck(), 4: blankXdjDeck() };
  let count = 2;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(XDJ_KEY) || 'null'); } catch { /* ignore */ }
  if (stored && stored.decks) {
    const next = Number(stored.count);
    if (next >= 1 && next <= 4) count = next;
    for (const n of [1, 2, 3, 4]) {
      const row = stored.decks[n] || stored.decks[String(n)];
      if (!row || typeof row !== 'object') continue;
      for (const [id] of XDJ_BUTTONS) decks[n][id] = xdjAssignValue(row[id]);
    }
    return { count, decks, fresh: false };
  }
  let pulse = 1;
  let glitch = 2;
  try {
    const saved = JSON.parse(localStorage.getItem('vj.prolinkMapping') || 'null');
    const nextPulse = parseInt(saved?.pulse, 10);
    const nextGlitch = parseInt(saved?.glitch, 10);
    if (nextPulse >= 1 && nextPulse <= 4) pulse = nextPulse;
    if (nextGlitch >= 1 && nextGlitch <= 4) glitch = nextGlitch;
  } catch { /* ignore */ }
  decks[pulse].beat = 'strobe';
  if (glitch !== pulse) decks[glitch].beat = 'glitch';
  return { count, decks, fresh: true };
}

const xdjAssign = loadXdjAssign();
let proLinkPulse = 0;
let proLinkGlitch = 0;
const proLinkSeen = { 1: 0, 2: 0, 3: 0, 4: 0 };
const xdjBeatFlash = {};

function saveXdjAssign() {
  const decks = {};
  for (const n of [1, 2, 3, 4]) decks[n] = xdjAssign.decks[n];
  try {
    localStorage.setItem(XDJ_KEY, JSON.stringify({ count: xdjAssign.count, decks }));
  } catch { /* ignore */ }
}

function triggerStrobePulse() {
  proLinkPulse = 1;
}

function triggerGlitch() {
  proLinkGlitch = 1;
}

function applyXdjCount() {
  document.querySelectorAll('#xdj-decks .xdj-deck').forEach((deck) => {
    deck.hidden = Number(deck.dataset.deck) > xdjAssign.count;
  });
}

function flashXdjBeat(deck) {
  const pad = document.querySelector(`#xdj-view .xdj-pad[data-xdj-deck="${deck}"][data-xdj-btn="beat"]`);
  if (!pad) return;
  pad.classList.add('hit');
  clearTimeout(xdjBeatFlash[deck]);
  xdjBeatFlash[deck] = setTimeout(() => pad.classList.remove('hit'), 180);
}

function runXdjBeat(deck) {
  const kind = xdjAssign.decks[deck]?.beat || 'none';
  if (kind === 'strobe') {
    triggerStrobePulse();
    if (masterTransport.state === 'playing' && !timeline.playing && !bpmEngine.analyzing) {
      bpmEngine.beats = Math.round(bpmEngine.beats);
      beatClock.snap();
    }
  } else if (kind === 'glitch') {
    triggerGlitch();
  }   else if (kind === 'code') {
    setHudEnabled(!hudWant, { history: true });
  } else if (kind === 'logo1') {
    stings.trigger(0);
  } else if (kind === 'logo2') {
    stings.trigger(1);
  } else if (kind === 'logo3') {
    stings.trigger(2);
  }
}

function mountXdj() {
  const root = $('xdj-decks');
  if (!root || root.childElementCount) return;
  const countSel = $('xdj-count');
  if (countSel) countSel.value = String(xdjAssign.count);
  for (let n = 1; n <= 4; n += 1) {
    const deck = document.createElement('section');
    deck.className = 'xdj-deck';
    deck.dataset.deck = String(n);
    const title = document.createElement('h3');
    title.textContent = `Deck ${n}`;
    const face = document.createElement('div');
    face.className = 'xdj-face';
    for (const [id, label, wide] of XDJ_BUTTONS) {
      const slot = document.createElement('div');
      slot.className = wide ? 'xdj-slot wide' : 'xdj-slot';
      const pad = document.createElement('button');
      pad.type = 'button';
      pad.className = 'apc-pad xdj-pad';
      pad.dataset.xdjDeck = String(n);
      pad.dataset.xdjBtn = id;
      const name = document.createElement('b');
      name.textContent = label;
      pad.append(name);
      const select = document.createElement('select');
      select.className = 'xdj-assign';
      select.title = `${label} on Deck ${n}`;
      select.dataset.xdjDeck = String(n);
      select.dataset.xdjBtn = id;
      for (const [value, text] of XDJ_ASSIGN) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
      }
      select.value = xdjAssign.decks[n][id];
      select.addEventListener('change', () => {
        xdjAssign.decks[n][id] = xdjAssignValue(select.value);
        select.value = xdjAssign.decks[n][id];
        saveXdjAssign();
      });
      slot.append(pad, select);
      face.append(slot);
    }
    deck.append(title, face);
    root.append(deck);
  }
  applyXdjCount();
  countSel?.addEventListener('change', () => {
    const count = parseInt(countSel.value, 10);
    if (count < 1 || count > 4) return;
    xdjAssign.count = count;
    applyXdjCount();
    saveXdjAssign();
  });
  if (xdjAssign.fresh) saveXdjAssign();
}

function initProDjLink() {
  if (!IS_TAURI) {
    console.warn('start_pro_dj_link needs the desktop app.');
    return;
  }
  import('@tauri-apps/api/event').then(async ({ listen }) => {
    await invoke('start_pro_dj_link');
    await listen('prolink-beat', (event) => {
      const deck = event.payload?.deck;
      if (deck < 1 || deck > 4 || !event.payload?.is_beat) return;
      const now = performance.now();
      if (now - proLinkSeen[deck] < 180) return;
      proLinkSeen[deck] = now;
      flashXdjBeat(deck);
      runXdjBeat(deck);
    });
  }).catch(() => {});
}

mountXdj();
initProDjLink();
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
  persistDesk();
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
  persistDesk();
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
  await audio.wake();
  setStatus($('audio-status'), 'decoding...');
  showAudioMode('file');
  await audio.loadFile(file, { autoplay: masterTransport.state === 'playing' || !syncMaster.audio || audioOverrideStop });
  audio.setLoop($('audio-loop').checked);
  await library.cacheAudio(file);
  rememberMediaSource(file.name, 'audio');
  globalLibrary?.refresh();
  rememberAudioName(file.name);
  try { localStorage.setItem('vj.audioFile', file.name); } catch { /* ignore */ }
  setStatus($('audio-status'), file.name);
  syncTransport();
  await paintAudioRecent();
  await paintAudioLibrary(file.name);
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
  const next = [name, ...readAudioRecent().filter((item) => item !== name)].slice(0, 3);
  try { localStorage.setItem(AUDIO_RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

async function paintAudioRecent() {
  const list = $('audio-recent');
  if (!list) return;
  const current = audio.fileName || localStorage.getItem('vj.audioFile') || '';
  const names = [];
  for (const name of readAudioRecent()) {
    if (names.length >= 3) break;
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
  audioAssetPath = '';
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
  paintGlanceAudio();
});
audio.onDeviceLost = () => {
  setStatus($('audio-status'), 'Audio input disconnected - pick the device again', true);
  syncTransport();
};
navigator.mediaDevices?.addEventListener('devicechange', () => {
  if (audioMode === 'device') refreshAudioDevices();
  library.refreshCameras().catch(() => {});
});

async function useProjectAudio(entry) {
  showAudioMode('file');
  let audioPath = await resolveProjectMediaPath(entry?.path || '', openProjectPath || currentProjectPath());
  if (audioPath && absoluteMediaPath(audioPath) && isTauri()) {
    const ready = await mediaFileReady(audioPath);
    if (!ready) throw new Error(openedProjectFile() ? 'That audio file is missing from this project folder.' : 'That audio file is missing from the Media Library folder.');
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const res = await fetch(convertFileSrc(audioPath));
    if (!res.ok) throw new Error('Could not read that audio file');
    const blob = await res.blob();
    const stored = await libraryStoredPath(entry?.path || '', entry?.name || '', openProjectPath || currentProjectPath(), audioPath);
    audioAssetPath = stored || '';
    await useAudioFile(new File([blob], entry.name, { type: blob.type || 'audio/wav' }));
    return;
  }
  const cached = await library.getAudio(entry?.name);
  if (!cached) throw new Error('That audio file is not in the library.');
  audioAssetPath = '';
  await useAudioFile(cached);
}

const AUDIO_ERR = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};
const stockPreviewUrls = new Set();

function logAudioElementError(player, url) {
  const code = player.error?.code;
  const name = AUDIO_ERR[code] || 'MEDIA_ERR_UNKNOWN';
  console.warn(`Audio preview failed (${name})`, url || player.currentSrc || '', player.error || '');
}

function releaseStockPreviews() {
  for (const node of $('stock-audio-results')?.querySelectorAll('audio') || []) node.pause();
  for (const url of stockPreviewUrls) URL.revokeObjectURL(url);
  stockPreviewUrls.clear();
}

async function pullAudioBlob(url, title) {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(String(res.status));
    return await res.blob();
  } catch (err) {
    if (!IS_TAURI) throw err;
    console.warn('Direct audio fetch was blocked; downloading through the desktop client.', err);
    const saveDir = await ensureStockDir({ create: true });
    const path = await invoke('download_audio', { url, filename: title || 'sample', saveDir });
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const res = await fetch(convertFileSrc(path));
    if (!res.ok) throw new Error('Download failed');
    return await res.blob();
  }
}

function openStockAudio(on) {
  const modal = $('stock-audio-modal');
  if (!modal) return;
  modal.hidden = !on;
  if (!on) {
    releaseStockPreviews();
    return;
  }
  $('stock-audio-prompt')?.focus();
}

function paintStockAudio(hits) {
  const list = $('stock-audio-results');
  releaseStockPreviews();
  list.replaceChildren();
  for (const hit of hits) {
    const row = document.createElement('li');
    row.className = 'stock-audio-row';
    const meta = document.createElement('div');
    meta.className = 'stock-audio-meta';
    const title = document.createElement('b');
    title.textContent = hit.title;
    title.title = hit.title;
    const time = document.createElement('span');
    time.textContent = [hit.duration, hit.source === 'archive' ? 'Internet Archive' : 'Wikimedia'].filter(Boolean).join(' · ');
    meta.append(title, time);
    const player = document.createElement('audio');
    player.preload = 'none';
    player.crossOrigin = 'anonymous';
    player.src = hit.url;
    applyMediaSink(player);
    const actions = document.createElement('div');
    actions.className = 'stock-audio-actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = 'Play';
    play.title = 'Preview this clip';
    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = 'Load to Deck / Stems';
    load.title = 'Download this clip and play it on the audio deck';
    const markPlaying = (on) => {
      play.textContent = on ? 'Pause' : 'Play';
      play.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    player.addEventListener('play', () => {
      for (const node of list.querySelectorAll('audio')) {
        if (node !== player) node.pause();
      }
      markPlaying(true);
    });
    player.addEventListener('pause', () => markPlaying(false));
    player.addEventListener('ended', () => markPlaying(false));
    player.addEventListener('error', () => {
      logAudioElementError(player, hit.url);
      if (player.dataset.fallback === '1') return;
      player.dataset.fallback = '1';
      pullAudioBlob(hit.url, hit.title).then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        stockPreviewUrls.add(objectUrl);
        player.src = objectUrl;
        if (play.dataset.want === '1') player.play().catch(() => markPlaying(false));
      }).catch((err) => {
        console.warn('Audio preview could not fall back to a downloaded copy', hit.url, err);
        markPlaying(false);
      });
    });
    play.addEventListener('click', () => {
      audio.wake().catch((err) => console.warn('Audio context did not resume', err));
      if (!player.paused) {
        play.dataset.want = '0';
        player.pause();
        return;
      }
      play.dataset.want = '1';
      player.play().catch((err) => {
        console.warn('Audio preview did not start', hit.url, err);
        markPlaying(false);
      });
    });
    load.addEventListener('click', () => {
      audio.wake().catch((err) => console.warn('Audio context did not resume', err));
      saveStockAudio(hit, load);
    });
    actions.append(play, load);
    row.append(meta, actions, player);
    list.append(row);
  }
}

async function saveStockAudio(hit, button) {
  if (button.disabled) return;
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = 'Downloading…';
  try {
    if (IS_TAURI) {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const saveDir = await ensureStockDir({ create: true });
      const path = await invoke('download_audio', { url: hit.url, filename: hit.title, saveDir });
      window.dispatchEvent(new CustomEvent('vj-global-media'));
      globalLibrary?.refresh();
      const res = await fetch(convertFileSrc(path));
      if (!res.ok) throw new Error('Saved, but the file could not be played');
      const blob = await res.blob();
      const leaf = String(path).split(/[\\/]/).pop() || `${hit.title}.wav`;
      audioAssetPath = path;
      await useAudioFile(new File([blob], leaf, { type: 'audio/wav' }));
      showToast(`Saved ${leaf} to Media Manager`);
    } else {
      console.warn('download_audio needs the desktop app; playing the file in this session.');
      const blob = await pullAudioBlob(hit.url, hit.title);
      const file = new File([blob], hit.title, { type: blob.type || 'audio/mpeg' });
      await useAudioFile(file);
      showToast('Playing in this session. The desktop app also saves it into Media Manager.');
    }
    button.textContent = 'Saved';
  } catch (err) {
    button.disabled = false;
    button.textContent = previous;
    showToast(err?.message || 'Could not download that audio file', true);
  }
}

async function runStockAudioSearch() {
  const prompt = $('stock-audio-prompt').value.trim();
  const status = $('stock-audio-status');
  if (!prompt) {
    status.textContent = 'Type what you want to hear.';
    return;
  }
  $('stock-audio-search').disabled = true;
  status.textContent = 'Searching stock audio…';
  $('stock-audio-results').replaceChildren();
  try {
    const hits = await searchStockAudio(prompt, $('stock-audio-source')?.value || 'all');
    paintStockAudio(hits);
    status.textContent = hits.length ? `${hits.length} clips` : 'Nothing matched that search.';
  } catch (err) {
    status.textContent = err?.message || 'Search failed';
  } finally {
    $('stock-audio-search').disabled = false;
  }
}

$('stock-audio-open')?.addEventListener('click', () => openStockAudio(true));
$('stock-audio-close')?.addEventListener('click', () => openStockAudio(false));
$('stock-audio-modal')?.addEventListener('click', (e) => {
  if (e.target === $('stock-audio-modal')) openStockAudio(false);
});
$('stock-audio-search')?.addEventListener('click', () => { runStockAudioSearch(); });
$('stock-audio-prompt')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runStockAudioSearch();
});
$('stock-audio-results')?.addEventListener('play', (e) => {
  for (const node of $('stock-audio-results').querySelectorAll('audio')) {
    if (node !== e.target) node.pause();
  }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('stock-audio-modal')?.hidden) return;
  openStockAudio(false);
  e.stopPropagation();
}, true);

let audioLibraryPaint = 0;

async function paintAudioLibrary(prefer) {
  const select = $('audio-library');
  if (!select) return;
  const ticket = ++audioLibraryPaint;
  const rows = globalLibrary ? await globalLibrary.libraryAudio() : [];
  if (ticket !== audioLibraryPaint) return;
  const current = prefer || select.value || audio.fileName || localStorage.getItem('vj.audioFile') || '';
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = rows.length ? 'Choose a library file' : 'Add audio in Media Manager';
  select.append(blank);
  for (const row of rows) {
    const opt = document.createElement('option');
    opt.value = row.name;
    opt.textContent = row.name;
    opt.dataset.path = row.path || '';
    select.append(opt);
  }
  select.value = rows.some((row) => row.name === current) ? current : '';
}

$('audio-library')?.addEventListener('change', async () => {
  const select = $('audio-library');
  const name = select?.value;
  if (!name) return;
  audioAssetPath = '';
  try {
    let file = await library.getAudio(name);
    const path = select.selectedOptions[0]?.dataset.path || '';
    if (!file && path && IS_TAURI) {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const res = await fetch(convertFileSrc(path));
      if (!res.ok) throw new Error('That library file could not be played');
      const blob = await res.blob();
      file = new File([blob], name, { type: blob.type || 'audio/mp4' });
    }
    if (!file) throw new Error('That file is not in Media Manager anymore');
    await useAudioFile(file);
  } catch (err) {
    setStatus($('audio-status'), err.message, true);
  }
});

window.addEventListener('vj-audio-ready', async (event) => {
  const detail = event.detail || {};
  if (detail.error) {
    if (detail.play) setStatus($('audio-status'), detail.error, true);
    return;
  }
  try {
    await paintAudioLibrary(detail.name);
  } catch (err) {
    console.warn('Library audio list did not refresh', err);
  }
  if (!detail.play) return;
  {
    const raw = detail.path || '';
    const beside = openedProjectFile() ? besideStoredPath(openedProjectFile(), raw) : '';
    audioAssetPath = beside || raw;
  }
  try {
    let file = detail.file || await library.getAudio(detail.name);
    if (!file && detail.path && IS_TAURI) {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const res = await fetch(convertFileSrc(detail.path));
      if (!res.ok) throw new Error('The lighter file could not be played');
      const blob = await res.blob();
      const leaf = detail.name || String(detail.path).split(/[\\/]/).pop() || 'audio.m4a';
      file = new File([blob], leaf, { type: blob.type || 'audio/mp4' });
    }
    if (!file) throw new Error('The lighter file could not be played');
    await useAudioFile(file);
  } catch (err) {
    setStatus($('audio-status'), err.message, true);
  }
});

window.addEventListener('vj-global-media', () => { paintAudioLibrary(); });

const drop = $('audio-drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  drop.classList.remove('over');
  const file = [...e.dataTransfer.files].find((f) => /\.(mp3|wav|wave|ogg|oga|flac|aiff|aif|m4a)$/i.test(f.name) || f.type.startsWith('audio/'));
  if (!file) {
    setStatus($('audio-status'), 'Drop an audio file.', true);
    return;
  }
  audioAssetPath = '';
  setStatus($('audio-status'), 'Adding to Media Manager…');
  globalLibrary?.ingest([file], e, { play: true });
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
  persistDesk();
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
  persistDesk();
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
  persistDesk();
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
    persistDesk();
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
  persistDesk();
});
$('audio-master').addEventListener('input', (e) => {
  params.set('audioGain', Number(e.target.value), { history: 'drag' });
  $('audio-master-out').textContent = Number(e.target.value).toFixed(2);
});
$('audio-master').addEventListener('change', () => params.history?.commit());
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
    const label = document.createElement('b');
    label.textContent = pad.short || pad.label;
    b.append(label);
    b.classList.toggle('held', momentary.held.has(pad.id));
    b.classList.toggle('mapped', !!map);
    b.title = map ? `${pad.label} · ${map}` : pad.label;
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
  triggerScene(sceneId, undefined, { history: true });
};
async function enableMidi({ remember = true } = {}) {
  await midi.init();
  if (remember) {
    try { localStorage.setItem('vj.midi.enabled', '1'); } catch { /* private mode */ }
  }
  midi.onChange();
  return midi;
}

const MIDI_FAIL = 'MIDI access failed — try again';

$('midi-enable').addEventListener('click', async () => {
  try {
    // Permission prompts only appear from a real click, not page load.
    await enableMidi();
  } catch {
    setStatus($('midi-status'), MIDI_FAIL, true);
  }
});
// Do not call requestMIDIAccess during page load — the prompt often never
// appears. If MIDI was on last session, wait for Enable MIDI (or Learn / APC).
if (localStorage.getItem('vj.midi.enabled') === '1' && !midi.access) {
  setStatus($('midi-status'), 'Click Enable MIDI to reconnect');
}
$('midi-learn').addEventListener('click', () => {
  midi.toggleLearn();
  if (midi.learnArmed && !midi.access) {
    enableMidi().catch(() => setStatus($('midi-status'), MIDI_FAIL, true));
  }
});
$('apc-preset').addEventListener('click', () => {
  const arm = async () => {
    setMidiMap('apc-mini-mk2');
    setDeskMode('midi');
    if (!midi.access) await enableMidi();
    apcLeds.reset();
    const found = midi.outputs.filter((p) => /apc|akai/i.test(p.name || ''));
    setStatus($('midi-status'), found.length
      ? `APC Mini MK2 · ${found.map((p) => p.name).join(', ')}`
      : 'APC Mini MK2 default map armed');
  };
  arm().catch(() => setStatus($('midi-status'), MIDI_FAIL, true));
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
    const withAudio = route.recordings.audio && audio.recordStream;
    recorder.start({
      format: formats[$('rec-format').value],
      audioStream: withAudio ? audio.recordStream : null,
      width,
      height,
      onFile: (blob, filename) => saveRecordingFile(blob, filename),
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
  persistDesk();
});
$('rec-format')?.addEventListener('change', () => persistDesk());
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

  let hudHist = { ...style };
  const persist = () => {
    const prev = hudHist;
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
    persistDesk();
    hudHist = next;
    params.history?.edit('hudStyle', prev, next, (saved) => {
      hudHist = saved;
      $('hud-glyph').value = saved.glyph;
      $('hud-color').value = saved.color;
      $('hud-size').value = String(saved.size);
      $('hud-leading').value = String(saved.leading);
      $('hud-mix').value = String(saved.mix);
      $('hud-bg').value = String(saved.bg);
      $('hud-automask').checked = !!saved.automask;
      localStorage.setItem(HUD_STYLE_KEY.glyph, saved.glyph);
      localStorage.setItem(HUD_STYLE_KEY.color, saved.color);
      localStorage.setItem(HUD_STYLE_KEY.size, String(saved.size));
      localStorage.setItem(HUD_STYLE_KEY.mix, String(saved.mix));
      localStorage.setItem(HUD_STYLE_KEY.bg, String(saved.bg));
      localStorage.setItem(HUD_STYLE_KEY.automask, saved.automask ? '1' : '0');
      localStorage.setItem(HUD_STYLE_KEY.leading, String(saved.leading));
      $('hud-size-out').textContent = String(Math.round(saved.size));
      $('hud-leading-out').textContent = Number(saved.leading).toFixed(2);
      $('hud-mix-out').textContent = Number(saved.mix).toFixed(2);
      $('hud-bg-out').textContent = Number(saved.bg).toFixed(2);
      hud.applyChrome(saved);
      pushOverlay(true);
      persistDesk();
    }, 'drag');
  };
  for (const id of ['hud-glyph', 'hud-color', 'hud-size', 'hud-leading', 'hud-mix', 'hud-bg']) {
    $(id).addEventListener('input', persist);
    $(id).addEventListener('change', () => params.history?.commit());
  }
  $('hud-automask').addEventListener('change', () => {
    persist();
    params.history?.commit();
  });
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
  const run = () => {
    $('hud-glyph').value = preset.glyph;
    $('hud-glyph').dispatchEvent(new Event('input', { bubbles: true }));
    setHudDisplay(preset.mode);
    try { localStorage.setItem('vj.hudPreset', id); } catch { /* ignore */ }
  };
  if (params.history) params.history.group(run);
  else run();
}

function setHudDisplay(mode) {
  const prev = hud.display;
  hud.setDisplay(mode);
  $('hud-mode').value = hud.display;
  localStorage.setItem(HUD_STYLE_KEY.mode, hud.display);
  pushOverlay(true);
  persistDesk();
  if (prev !== hud.display) {
    params.history?.edit('hudMode', prev, hud.display, (v) => setHudDisplay(v), 'commit');
  }
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
    persistDesk();
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

function setHudEnabled(on, { history = false } = {}) {
  const prev = hudWant;
  const next = !!on;
  hudWant = next;
  $('hud-enable').checked = next;
  const hudState = document.querySelector('#code-trigger .hud-state');
  if (hudState) hudState.textContent = next ? 'On' : 'Off';
  const codeBtn = $('code-trigger');
  if (codeBtn) {
    codeBtn.classList.toggle('on', next);
    codeBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  try { localStorage.setItem('vj.hud', next ? '1' : '0'); } catch { /* ignore */ }
  persistDesk();
  if (history && prev !== next) {
    params.history?.edit('hud', prev, next, (v) => setHudEnabled(v), 'commit');
  }
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
    persistDesk();
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
  persistDesk();
}
loadHudBox();
bindHudBox();
bindHudMotion();
if (localStorage.getItem('vj.hud') === '1') setHudEnabled(true);
$('hud-enable').addEventListener('change', () => setHudEnabled($('hud-enable').checked, { history: true }));
setHudPerform(localStorage.getItem('vj.hudPerform') === '1');
$('hud-perform').addEventListener('change', () => setHudPerform($('hud-perform').checked));
$('hud-dpi').checked = dpiState.auto;
$('hud-dpi').addEventListener('change', () => {
  setDpiAuto($('hud-dpi').checked);
  syncDpi();
  persistDesk();
});

let midiMap = 'apc-mini-mk2';

function applyMidiSurface() {
  const mini = midiMap === 'apc-mini-mk2' && deskMode === 'midi';
  const xdj = midiMap === 'xdj-700' && deskMode === 'midi';
  $('apc-view').hidden = !mini;
  const decks = $('xdj-view');
  if (decks) decks.hidden = !xdj;
  const note = $('midi-map-note');
  if (note) {
    if (midiMap === 'apc-mini-mk2') {
      note.hidden = true;
    } else if (midiMap === 'xdj-700') {
      note.hidden = false;
      note.textContent = 'Pioneer XDJ-700. A Pro DJ Link beat runs the assignment on that deck’s Beat pad.';
    } else {
      note.hidden = false;
      note.textContent = midiMap === 'apc40-mk2'
        ? 'APC40 mk2 is selected. Its controls go to MIDI Learn and the saved mappings.'
        : 'Custom / Generic. Every control goes to MIDI Learn and the saved mappings.';
    }
  }
  if (mini) apcView?.refresh();
}

function setMidiMap(id) {
  midiMap = id === 'apc40-mk2' || id === 'custom' || id === 'xdj-700' ? id : 'apc-mini-mk2';
  const select = $('midi-map');
  if (select && select.value !== midiMap) select.value = midiMap;
  try { localStorage.setItem('vj.midi.map', midiMap); } catch { /* ignore */ }
  applyMidiSurface();
  persistProjectView(true);
}

apcView = new ApcView({
  root: $('apc-view'),
  params,
  scenes,
  bus,
  panel,
  launch: (id) => triggerScene(id, undefined, { history: true }),
  groupEdit: (fn) => params.history.group(fn),
  openSceneMenu: (id, x, y) => sceneBar.openPadMenu(id, x, y),
  setHud: (on) => {
    setHudEnabled(on, { history: true });
    apcView?.refresh();
  },
  getHud: () => ({ on: hudWant, size: Number($('hud-size').value) }),
  getClips: () => project.mediaPool
    .filter((item) => item?.name && item.kind !== 'audio' && mediaKind(item.name) !== 'audio' && !isBrandVisual(item))
    .map((item) => item.name),
  setClip: (layer, name) => setLayerMedia(layer, `file:${name}`, { history: true }),
  getMedia: () => currentMedia(),
  momentary,
  getPulse: () => beatClock.pulse,
  actions: {
    tap: tapTempo,
    autoBpm: () => setBpmMode('auto', { scanFile: true }),
    masterStop,
    setSpeed: (value) => setMasterSpeed(value),
    getSpeed: () => masterSpeed,
    setFade: (value) => timeline.set('fadeSec', value, { history: false }),
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
    recallComp: (index) => {
      const mix = project.compositions?.[index];
      if (mix) recallComposition(mix);
    },
    clearComposition: () => clearComposition(params, (speed) => setMasterSpeed(speed, { history: 'commit' })),
    launchPack: (slot) => launchPack(slot),
    applyStack: (id) => {
      const stack = START_STACKS.find((item) => item.id === id);
      if (!stack) return;
      applyStart(params, stack, {
        setSpeed: (speed) => setMasterSpeed(speed, { history: 'commit' }),
        mods,
        lfo,
        sync: () => panel.refreshAutomation(),
      });
    },
    stacks: () => START_STACKS.map((stack) => ({ id: stack.id, name: stack.label })),
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
  const momentTrack = { strobe: 'TRK1', y2k: 'TRK2', shatter: 'TRK3', invert: 'TRK4', glitch: 'TRK5' };
  document.querySelectorAll('#momentary-pads .moment-pad').forEach((pad) => {
    const id = (pad.dataset.midi || '').replace(/^moment:/, '');
    if (momentTrack[id]) place(pad, momentTrack[id]);
  });
  document.querySelectorAll('.logo-triggers .sting-fire').forEach((btn, i) => place(btn, `TRK${i + 6}`));
  place($('shuffle-layer-fx'), '⇧TRK7');
  place($('code-trigger'), '⇧TRK8');
  place($('bpm-tap'), 'SCN7');
  place($('bpm-mode'), '⇧SCN7');
  place($('master-stop'), '⇧SCN8');
}

function setMidiLabels(on, save = true) {
  document.body.classList.toggle('midi-labels', !!on);
  const box = $('midi-labels');
  if (box) box.checked = !!on;
  if (save) {
    try { localStorage.setItem('vj.midi.labels', on ? '1' : '0'); } catch { /* ignore */ }
    persistProjectView(true);
  }
  syncMidiTags();
}
$('midi-labels')?.addEventListener('change', (e) => setMidiLabels(e.target.checked));
setMidiLabels(localStorage.getItem('vj.midi.labels') === '1', false);
{
  const storedMap = localStorage.getItem('vj.midi.map');
  setMidiMap(storedMap || (localStorage.getItem('vj.view') === 'apc' ? 'apc-mini-mk2' : 'apc-mini-mk2'));
}
$('logo-record').addEventListener('change', () => setLogoRecord($('logo-record').checked));
$('logo-output').addEventListener('change', () => setLogoOutput($('logo-output').checked));
for (const id of ['rec-audio', 'rec-screen', 'rec-code', 'out-audio', 'out-screen', 'out-code']) {
  $(id)?.addEventListener('change', onRouteChange);
}

const route = {
  recordings: { audio: true, screensaver: false, codeOverlay: false },
  outputs: { audio: true, screensaver: false, codeOverlay: false },
};
let logoRecordOn = true;
let logoOutputOn = true;

function logoFlags() {
  return { logoRecord: logoRecordOn, logoOutput: logoOutputOn };
}

function syncRecordBox(id, on) {
  const box = $(id);
  if (box && box.checked !== on) box.checked = on;
}

function readRouteBoxes() {
  return {
    recordings: {
      audio: !!$('rec-audio')?.checked,
      screensaver: !!$('rec-screen')?.checked,
      codeOverlay: !!$('rec-code')?.checked,
    },
    outputs: {
      audio: !!$('out-audio')?.checked,
      screensaver: !!$('out-screen')?.checked,
      codeOverlay: !!$('out-code')?.checked,
    },
  };
}

function onRouteChange() {
  setRoutes(readRouteBoxes());
  pushOverlay();
}

function setRoutes(next, save = true) {
  route.recordings = {
    audio: !!next.recordings?.audio,
    screensaver: !!next.recordings?.screensaver,
    codeOverlay: !!next.recordings?.codeOverlay,
  };
  route.outputs = {
    audio: !!next.outputs?.audio,
    screensaver: !!next.outputs?.screensaver,
    codeOverlay: !!next.outputs?.codeOverlay,
  };
  syncRecordBox('rec-audio', route.recordings.audio);
  syncRecordBox('rec-screen', route.recordings.screensaver);
  syncRecordBox('rec-code', route.recordings.codeOverlay);
  syncRecordBox('out-audio', route.outputs.audio);
  syncRecordBox('out-screen', route.outputs.screensaver);
  syncRecordBox('out-code', route.outputs.codeOverlay);
  if (outputWin.overlayOn !== route.outputs.codeOverlay) outputWin.setOverlayOn(route.outputs.codeOverlay);
  if (save) project.setRoutes(route);
}

function setLogoRecord(on, save = true) {
  logoRecordOn = !!on;
  syncRecordBox('logo-record', logoRecordOn);
  if (save) project.setRecordOutput(logoFlags());
}

function setLogoOutput(on, save = true) {
  logoOutputOn = !!on;
  syncRecordBox('logo-output', logoOutputOn);
  if (save) project.setRecordOutput(logoFlags());
}

function legacyLogoDefault() {
  const fromDesk = project.desk?.code?.logoOutput;
  if (typeof fromDesk === 'boolean') return fromDesk;
  try {
    if (localStorage.getItem('vj.logoOutput') === '0') return false;
  } catch { /* ignore */ }
  return true;
}

function showRecordOutput(raw = {}) {
  const logoDefault = legacyLogoDefault();
  const flags = {
    logoRecord: typeof raw.logoRecord === 'boolean' ? raw.logoRecord : logoDefault,
    logoOutput: typeof raw.logoOutput === 'boolean' ? raw.logoOutput : logoDefault,
  };
  setLogoRecord(flags.logoRecord, false);
  setLogoOutput(flags.logoOutput, false);
  const dirty = Object.keys(flags).some((key) => typeof raw[key] !== 'boolean');
  return { ...flags, dirty };
}

function showRoutes(recordings = {}, outputs = {}) {
  const codeDefault = !!$('hud-enable')?.checked;
  const next = {
    recordings: {
      audio: recordings.audio !== false,
      screensaver: !!recordings.screensaver,
      codeOverlay: typeof recordings.codeOverlay === 'boolean' ? recordings.codeOverlay : codeDefault,
    },
    outputs: {
      audio: outputs.audio !== false,
      screensaver: !!outputs.screensaver,
      codeOverlay: typeof outputs.codeOverlay === 'boolean' ? outputs.codeOverlay : codeDefault,
    },
  };
  setRoutes(next, false);
  const dirty = ['audio', 'screensaver', 'codeOverlay'].some((key) => (
    typeof recordings[key] !== 'boolean' || typeof outputs[key] !== 'boolean'
  ));
  return { ...next, dirty };
}

{
  const shown = showRecordOutput(project.recordOutput);
  if (shown.dirty) {
    const { dirty, ...flags } = shown;
    project.setRecordOutput(flags);
  }
  const routed = showRoutes(project.recordings, project.outputs);
  if (routed.dirty) {
    const { dirty, ...routes } = routed;
    project.setRoutes(routes);
  }
}

function screenFontFamily() {
  if (screenFont === 'desk') {
    const stack = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
    return stack || 'monospace';
  }
  return SCREEN_FONTS[screenFont] || 'monospace';
}

function screenRecordSpec(nowMs) {
  return {
    lines: screenLines(),
    fontFamily: screenFontFamily(),
    color: SCREEN_COLORS[screenColor] || SCREEN_COLORS.white,
    shade: screenShade,
    background: screenBg,
    scale: brandScale,
    boxWidth: screenBoxW,
    boxHeight: screenBoxH,
    pad: screenPad,
    radius: screenRadius,
    border: screenBorder,
    nowMs,
  };
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
  const spots = screens.map((item) => `${item.monitor?.position?.x ?? ''},${item.monitor?.position?.y ?? ''}`);
  const note = document.createElement('p');
  note.className = 'hint';
  if (screens.length < 2) {
    note.textContent = 'Only this display was found. Set the projector to Extend (Windows) or Extended (Mac).';
    menu.append(note);
  } else if (new Set(spots).size < screens.length) {
    note.textContent = 'These displays share one picture. Set the projector to Extend (Windows) or Extended (Mac), not Duplicate or Mirror.';
    menu.append(note);
  }
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
function openGuide(open) {
  $('guide-modal').hidden = !open;
}
function openPrefs(open) {
  $('prefs-modal').hidden = !open;
  if (open) {
    openGuide(false);
    refreshPrefFolderFields().catch(() => {});
    refreshAudioOutputs({ ask: true }).catch((err) => console.warn('Audio output list failed', err));
  }
}
$('stock-dir-pick').addEventListener('click', async () => {
  if (!isTauri()) {
    showToast('Choose the folder in the desktop app.', true);
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'Fetched Media Folder' });
  if (typeof picked !== 'string' || !picked) return;
  try { localStorage.setItem(STOCK_DIR_KEY, picked); } catch { /* private mode */ }
  paintStockDir(picked);
  await invoke('ensure_folder', { path: picked }).catch(() => {});
  await allowLibraryFolder(picked);
  window.dispatchEvent(new CustomEvent('vj-global-media'));
  showToast('Fetched Media folder updated');
});
$('stock-dir-open').addEventListener('click', async () => {
  try {
    const path = $('stock-dir')?.value || savedStockDir() || await ensureStockDir();
    await openSavedFolder(path, 'Choose the fetched media folder first.');
  } catch (err) {
    showToast(err?.message || 'Could not open that folder.', true);
  }
});
$('record-dir-pick').addEventListener('click', async () => {
  if (!isTauri()) {
    showToast('Choose the folder in the desktop app.', true);
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'Recordings Folder' });
  if (typeof picked !== 'string' || !picked) return;
  try { localStorage.setItem(RECORD_DIR_KEY, picked); } catch { /* private mode */ }
  paintRecordDir(picked);
  await invoke('ensure_folder', { path: picked }).catch(() => {});
  showToast('Recordings folder updated');
});
$('record-dir-open').addEventListener('click', async () => {
  try {
    const path = $('record-dir')?.value || savedRecordDir() || await ensureRecordDir();
    await openSavedFolder(path, 'Choose the recordings folder first.');
  } catch (err) {
    showToast(err?.message || 'Could not open that folder.', true);
  }
});
async function chooseProjectRootFolder() {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title: 'New Projects Folder' });
    if (typeof picked !== 'string' || !picked) return null;
    return { path: picked };
  }
  if (typeof window.showDirectoryPicker !== 'function') {
    showToast('This browser cannot browse for a folder.', true);
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'vj-new-projects' });
    return { name: handle.name || 'Chosen folder', handle };
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    showToast(err?.message || 'Could not browse for a folder.', true);
    return null;
  }
}

function rememberProjectRoot(kind, picked) {
  try {
    localStorage.setItem(PROJECT_ROOT_ASKED, '1');
    localStorage.setItem('vj.projectRootKind', kind);
    if (picked?.path) {
      localStorage.setItem(PROJECT_ROOT_KEY, picked.path);
      localStorage.removeItem(PROJECT_ROOT_LABEL);
    } else if (picked?.name) {
      localStorage.removeItem(PROJECT_ROOT_KEY);
      localStorage.setItem(PROJECT_ROOT_LABEL, picked.name);
    } else {
      localStorage.removeItem(PROJECT_ROOT_KEY);
      localStorage.removeItem(PROJECT_ROOT_LABEL);
    }
  } catch { /* private mode */ }
  saveRootHandle(picked?.handle || null);
}

$('project-root-pick').addEventListener('click', async () => {
  const picked = await chooseProjectRootFolder();
  if (!picked) return;
  rememberProjectRoot('custom', picked);
  paintProjectRoot(picked.path || picked.name || '', true);
});
$('project-root-open').addEventListener('click', async () => {
  try {
    const path = $('project-root-dir')?.value || await ensureProjectRootDir();
    await openSavedFolder(path, 'Choose where new projects are created first.');
  } catch (err) {
    showToast(err?.message || 'Could not open that folder.', true);
  }
});
$('media-library-pick').addEventListener('click', async () => {
  if (!isTauri()) {
    showToast('Choose the folder in the desktop app.', true);
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'Media Library Folder' });
  if (typeof picked !== 'string' || !picked) return;
  try { localStorage.setItem(LIBRARY_DIR_KEY, picked); } catch { /* private mode */ }
  paintLibraryDir(picked, true);
  await invoke('ensure_folder', { path: picked }).catch(() => {});
  await allowLibraryFolder(picked);
  window.dispatchEvent(new CustomEvent('vj-global-media'));
  showToast('Media Library folder updated');
});
$('media-library-open').addEventListener('click', async () => {
  try {
    const path = $('media-library-dir')?.value || savedLibraryDir() || await ensureLibraryDir();
    await openSavedFolder(path, 'Choose the Media Library folder first.');
  } catch (err) {
    showToast(err?.message || 'Could not open that folder.', true);
  }
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
$('guide-btn').addEventListener('click', () => {
  $('file-menu').hidden = true;
  $('file-menu-btn').setAttribute('aria-expanded', 'false');
  openPrefs(false);
  openGuide($('guide-modal').hidden);
});
$('guide-close').addEventListener('click', () => openGuide(false));
$('guide-modal').addEventListener('click', (e) => {
  if (e.target === $('guide-modal')) openGuide(false);
});

function setUiScale(percent) {
  const pct = Math.min(125, Math.max(75, Math.round(Number(percent) || 100)));
  $('app').style.setProperty('--ui-scale', String(pct / 100));
  $('ui-scale').value = String(pct);
  $('ui-scale-out').textContent = `${pct}%`;
  try { localStorage.setItem('vj.uiScale', String(pct)); } catch { /* ignore */ }
  persistProjectView();
}
$('ui-scale').addEventListener('input', (e) => setUiScale(e.target.value));

function openInMode() {
  try {
    const saved = localStorage.getItem('vj.openIn');
    if (saved === 'live' || saved === 'prep' || saved === 'midi') return saved;
  } catch { /* ignore */ }
  return 'live';
}

function paintMachinePrefs() {
  const openIn = $('open-in');
  if (openIn) openIn.value = openInMode();
  const reopen = $('reopen-project');
  if (reopen) {
    try { reopen.checked = localStorage.getItem('vj.reopenProject') === '1'; } catch { reopen.checked = false; }
  }
  const dropAudio = $('prep-drop-video-audio');
  if (dropAudio) dropAudio.checked = dropVideoAudioPref();
}

function setOpenIn(mode) {
  const next = mode === 'prep' || mode === 'midi' ? mode : 'live';
  try { localStorage.setItem('vj.openIn', next); } catch { /* ignore */ }
  paintMachinePrefs();
}

const THEME_KEY = 'vj_theme';

function savedTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.body.classList.toggle('dark-mode', dark);
  const box = $('dark-mode');
  if (box) box.checked = dark;
}

applyTheme(savedTheme());
$('dark-mode')?.addEventListener('change', (e) => {
  const theme = e.target.checked ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  applyTheme(theme);
});

$('open-in')?.addEventListener('change', (e) => setOpenIn(e.target.value));
$('reopen-project')?.addEventListener('change', (e) => {
  try { localStorage.setItem('vj.reopenProject', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
});
$('prep-drop-video-audio')?.addEventListener('change', (e) => {
  setDropVideoAudioPref(!!e.target.checked);
});
paintMachinePrefs();
try {
  const rawScale = localStorage.getItem('vj.uiScale');
  const savedScale = rawScale == null || rawScale === '' ? 105 : Number(rawScale);
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
  persistProjectView();
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
      const box = (pane === 'dock' ? document.querySelector('#master-bus') : document.querySelector(pane === 'library' ? '.library' : '.inspector')).getBoundingClientRect();
      origin = (pane === 'dock' ? box.height : box.width) / uiZoom();
    }
    el.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}
for (const id of ['split-library', 'split-inspector', 'split-dock']) bindSplit($(id));

let topHeightPercent = 38;
function clampPreviewSplit(percent) {
  return Math.min(80, Math.max(15, percent));
}
function applyPreviewSplit(percent, save = false) {
  topHeightPercent = clampPreviewSplit(percent);
  const center = document.querySelector('.center');
  const centerH = center.getBoundingClientRect().height || window.innerHeight;
  const target = (topHeightPercent / 100) * window.innerHeight;
  const px = Math.min(centerH * 0.8, Math.max(centerH * 0.15, target));
  center.style.setProperty('--preview-h', `${(px / centerH) * 100}%`);
  if (save) {
    try { localStorage.setItem('vj.previewSplit', String(topHeightPercent)); } catch { /* ignore */ }
    persistProjectView();
  }
}
function bindPreviewSplit(el) {
  if (!el) return;
  let pointer = 0;
  const onMove = (e) => {
    if (e.pointerId !== pointer) return;
    applyPreviewSplit((e.clientY / window.innerHeight) * 100);
  };
  const onUp = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = 0;
    el.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    applyPreviewSplit(topHeightPercent, true);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || isPerformMode) return;
    e.preventDefault();
    pointer = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic press */ }
    el.classList.add('dragging');
    applyPreviewSplit((e.clientY / window.innerHeight) * 100);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}
{
  const saved = localStorage.getItem('vj.previewSplit');
  const savedPercent = Number(saved);
  if (saved != null && Number.isFinite(savedPercent)) topHeightPercent = clampPreviewSplit(savedPercent);
  applyPreviewSplit(topHeightPercent);
  bindPreviewSplit($('split-preview'));
  window.addEventListener('resize', () => applyPreviewSplit(topHeightPercent));
}

const programCanvas = $('program-monitor');
const programCtx = programCanvas?.getContext('2d', { alpha: false });

function fitProgramMonitor() {
  if (!programCanvas) return;
  const w = Math.max(2, Math.round(programCanvas.clientWidth));
  const h = Math.max(2, Math.round(programCanvas.clientHeight));
  if (w < 2 || h < 2) return;
  if (programCanvas.width === w && programCanvas.height === h) return;
  programCanvas.width = w;
  programCanvas.height = h;
}

function paintProgramMonitor() {
  if (deskMode !== 'midi' || !programCtx || !programCanvas) return;
  if (programCanvas.width < 2 || glCanvas.width < 2) return;
  const w = programCanvas.width;
  const h = programCanvas.height;
  const sw = glCanvas.width;
  const sh = glCanvas.height;
  programCtx.fillStyle = '#000';
  programCtx.fillRect(0, 0, w, h);
  const box = fittedBox(sw, sh, w, h, 'fill');
  if (box) programCtx.drawImage(glCanvas, 0, 0, sw, sh, box.dx, box.dy, box.dw, box.dh);
}

if (programCanvas) new ResizeObserver(() => fitProgramMonitor()).observe(programCanvas);

let midiViewPercent = 36;
function clampMidiSplit(percent) {
  return Math.min(62, Math.max(16, percent));
}
function applyMidiSplit(percent, save = false) {
  midiViewPercent = clampMidiSplit(percent);
  const host = document.querySelector('.midi-perform');
  if (host) host.style.setProperty('--midi-view-h', `${midiViewPercent}%`);
  const bar = $('split-midi');
  if (bar) bar.setAttribute('aria-valuenow', String(Math.round(midiViewPercent)));
  if (save) {
    try { localStorage.setItem('vj.midiViewH', String(midiViewPercent)); } catch { /* ignore */ }
  }
  fitProgramMonitor();
}
function bindMidiSplit(el) {
  if (!el) return;
  let pointer = 0;
  const measure = (clientY) => {
    const host = document.querySelector('.midi-perform');
    const rect = host?.getBoundingClientRect();
    if (!rect || rect.height < 1) return midiViewPercent;
    return ((clientY - rect.top) / rect.height) * 100;
  };
  const onMove = (e) => {
    if (e.pointerId !== pointer) return;
    applyMidiSplit(measure(e.clientY));
  };
  const onUp = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = 0;
    el.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    applyMidiSplit(midiViewPercent, true);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    pointer = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic press */ }
    el.classList.add('dragging');
    applyMidiSplit(measure(e.clientY));
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  el.addEventListener('dblclick', () => applyMidiSplit(36, true));
}
{
  const savedRaw = localStorage.getItem('vj.midiViewH');
  const saved = Number(savedRaw);
  if (savedRaw != null && Number.isFinite(saved)) midiViewPercent = clampMidiSplit(saved);
  applyMidiSplit(midiViewPercent);
  bindMidiSplit($('split-midi'));
}

const TIMELINE_PANE_MIN = 44;
const TIMELINE_PANE_MAX = 420;
const TIMELINE_BAR_PX_MIN = 4;
const TIMELINE_BAR_PX_MAX = 160;
let timelineBarPx = 28;

function timelinePaneLimit() {
  const split = document.querySelector('.timeline-split');
  const splitH = split ? split.getBoundingClientRect().height : window.innerHeight;
  const divider = 18;
  return Math.min(TIMELINE_PANE_MAX, Math.max(TIMELINE_PANE_MIN, Math.round(splitH - divider)));
}

function timelineBarCount() {
  return Math.max(1, sceneBar?.timeline?.bars || Number($('tl-bars')?.value) || 16);
}

function applyTimelineSplit(height, save = false) {
  const pane = document.querySelector('.timeline-pane');
  if (!pane) return 0;
  const next = Math.round(Math.min(timelinePaneLimit(), Math.max(TIMELINE_PANE_MIN, height)));
  pane.style.height = `${next}px`;
  pane.style.maxHeight = 'none';
  pane.style.minHeight = `${TIMELINE_PANE_MIN}px`;
  if (save) {
    try { localStorage.setItem('vj.timelineH', String(next)); } catch { /* ignore */ }
    persistProjectView();
  }
  return next;
}

function applyTimelineZoom(px, save = false) {
  const scroll = $('tl-scroll');
  const track = $('tl-track');
  if (!scroll || !track) return;
  const next = Math.round(Math.min(TIMELINE_BAR_PX_MAX, Math.max(TIMELINE_BAR_PX_MIN, px)) * 10) / 10;
  const prevWidth = track.getBoundingClientRect().width || scroll.clientWidth || 1;
  const anchor = scroll.scrollLeft + scroll.clientWidth / 2;
  const fraction = anchor / prevWidth;
  timelineBarPx = next;
  const width = Math.max(scroll.clientWidth, Math.round(timelineBarCount() * next));
  track.style.width = `${width}px`;
  scroll.scrollLeft = Math.max(0, fraction * width - scroll.clientWidth / 2);
  sceneBar?.renderLabels();
  if (save) {
    try { localStorage.setItem('vj.timelinePx', String(next)); } catch { /* ignore */ }
    persistProjectView();
  }
}

function bindTimelineZoom(el) {
  if (!el) return;
  let pointer = 0;
  let startY = 0;
  let originH = 120;
  const onMove = (e) => {
    if (e.pointerId !== pointer) return;
    const dy = (e.clientY - startY) / uiZoom();
    applyTimelineSplit(originH + dy);
  };
  const onUp = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = 0;
    el.classList.remove('dragging');
    document.body.classList.remove('timeline-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    applyTimelineSplit(document.querySelector('.timeline-pane')?.getBoundingClientRect().height || originH, true);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || isPerformMode) return;
    e.preventDefault();
    pointer = e.pointerId;
    startY = e.clientY;
    originH = document.querySelector('.timeline-pane')?.getBoundingClientRect().height || 120;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic press */ }
    el.classList.add('dragging');
    document.body.classList.add('timeline-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}
{
  const savedH = Number(localStorage.getItem('vj.timelineH'));
  applyTimelineSplit(Number.isFinite(savedH) && savedH > 0 ? savedH : 120);
  const savedPx = Number(localStorage.getItem('vj.timelinePx'));
  const view = $('tl-scroll')?.clientWidth || 640;
  const fitted = view / Math.min(timelineBarCount(), 32);
  applyTimelineZoom(Number.isFinite(savedPx) && savedPx > 0 ? savedPx : fitted);
  bindTimelineZoom(document.querySelector('.timeline-resizable-divider'));
  $('tl-scroll')?.addEventListener('wheel', (e) => {
    if (isPerformMode) return;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
    applyTimelineZoom(timelineBarPx * factor, true);
  }, { passive: false });
  $('tl-bars')?.addEventListener('change', () => applyTimelineZoom(timelineBarPx));
  window.addEventListener('resize', () => {
    applyTimelineSplit(document.querySelector('.timeline-pane')?.getBoundingClientRect().height || 120);
    applyTimelineZoom(timelineBarPx);
  });
}

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const redo = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey);
  const undo = key === 'z' && !e.shiftKey;
  if (!redo && !undo) return;
  const el = e.target;
  if (el instanceof HTMLElement && (el.isContentEditable || el.closest('input, textarea'))) return;
  e.preventDefault();
  if (redo) params.history.redo();
  else params.history.undo();
});
function escapeBusy(event) {
  const el = event.target;
  if (el instanceof HTMLElement && (el.isContentEditable || el.closest('input, textarea, select'))) return true;
  for (const node of document.querySelectorAll('[role="dialog"], [role="menu"], #scene-menu, #layer-media-gallery, #pack-editor, .num-editor')) {
    if (!node.closest('[hidden]')) return true;
  }
  return false;
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const screen = $('screen-menu');
  const screenOpen = !!(screen && !screen.hidden);
  const mapOpen = !$('output-map-modal')?.hidden;
  const prefsOpen = !$('prefs-modal')?.hidden;
  const guideOpen = !$('guide-modal')?.hidden;
  if (screenOpen) screen.hidden = true;
  if (mapOpen) openOutputMap(false);
  if (prefsOpen) openPrefs(false);
  if (guideOpen) openGuide(false);
  if (screenOpen || mapOpen || prefsOpen || guideOpen || escapeBusy(e)) return;
  if (!outputWin.open) return;
  e.preventDefault();
  outputWin.close();
});
$('fs-btn').addEventListener('click', toggleFullscreen);

window.addEventListener('keydown', (e) => {
  if (deskMode === 'prep') return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target?.matches?.('input[type="text"], input[type="password"], input[type="number"], textarea')) return;
  const k = e.key.toLowerCase();

  if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    const slot = Number(e.code.slice(5)) - 1;
    // Slot index follows the saved-scene order (same as scene pads / APC grid).
    const scene = slot < sceneBar.bankSize ? scenes.at(slot) : null;
    if (scene) triggerScene(scene.id, undefined, { history: true });
  } else if (k === ' ') {
    if (e.target?.matches?.('button, select, input')) return;
    e.preventDefault();
    if (masterTransport.state === 'playing') masterPause();
    else masterPlay();
  } else if (/^[1-9]$/.test(k) && SHADER_KEY_MODES[Number(k) - 1] != null) {
    params.set(layerParam(panel.selected, 'mode'), SHADER_KEY_MODES[Number(k) - 1], { history: 'commit' });
  } else if (k === 'q' || k === 'w' || k === 'e') {
    panel.selectLayer(LAYERS['qwe'.indexOf(k)]);
  } else if (k === 't') tapTempo();
  else if (isPerformMode && (k === 'l' || k === 'h' || k === 'c' || k === 'p')) return;
  else if (k === 'l') setUiMode(document.body.classList.contains('live-mode') ? 'timeline' : 'live');
  else if (k === 'h') setHudEnabled(!hudWant, { history: true });
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
    timeline.set('bpm', bpmEngine.bpm, { history: false });
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
    timeline.set('bpm', bpmEngine.bpm, { history: false });
  }
  shared.uBeat.value = beatClock.pulse;
  shared.uBeatPhase.value = beatClock.phase;

  const a = audio.update(dt, now);
  const motionDt = visualOn ? dt * masterSpeed : 0;
  shaderTime += motionDt;
  shared.uTime.value = shaderTime;
  if (controls.enabled) controls.update();
  for (const l of layers) {
    l.input?.setVisualRate?.(visualOn ? masterSpeed : 0);
    l.tickMedia(motionDt, renderer);
  }

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
  // Travel owns scale / posX / posY after LFO so the autopilot wins while it is on.
  travel.tick(motionDt);
  momentary.apply(layers, grade, now);
  const glitchWas = proLinkGlitch;
  proLinkPulse = Math.max(0, proLinkPulse - dt * 8);
  proLinkGlitch = Math.max(0, proLinkGlitch - dt * 5.5);
  if (proLinkPulse > 0) grade.uFlash.value = Math.max(grade.uFlash.value, proLinkPulse);
  if (glitchWas > 0) {
    for (const layer of layers) {
      layer.setUniform('glitch', Math.max(layer.get('glitch'), proLinkGlitch));
    }
  }
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
    const masked = l.mediaFit() !== 'fill' && l.engine === ENGINE_FX && !l.is3D && l.uniforms.uHasInput.value > 0.5;
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

  paintProgramMonitor();
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
    tickAudioPacks(audio);
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

  const paintHud = hud.visible && (!isPerformMode || document.body.classList.contains('hud-perform') || route.outputs.codeOverlay || route.recordings.codeOverlay);
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
  const frameSource = bakedPlate || renderer.domElement;
  const hudRecord = route.recordings.codeOverlay && hud.visible ? hud.recordOverlay() : null;
  const hudOutput = route.outputs.codeOverlay && hud.visible ? hud.recordOverlay() : null;
  const logosRecord = logoRecordOn && stings.live ? stings.outputPose() : null;
  const logosOutput = logoOutputOn && stings.live ? stings.outputPose() : null;
  const screensaverRecord = route.recordings.screensaver ? screenRecordSpec(nowMs) : null;
  const screensaverOutput = route.outputs.screensaver ? screenRecordSpec(nowMs) : null;
  if (recorder.recording) recorder.paint(frameSource, hudRecord, logosRecord, screensaverRecord);
  outputWin.mirror(
    hudOutput,
    logosOutput,
    frameSource,
    screensaverOutput,
    route.outputs.audio ? audio.recordStream : null,
    'fill',
  );
  if (performHolding) paintPerformHold();
}

refreshLayerUi();
syncHudShader();

async function restoreCachedMedia() {
  await library.ready;
  refreshLayerUi();
  if (project.desk && (project.desk.audio?.mode !== 'file' || !project.desk.audio.file)) return;
  const name = project.desk?.audio?.file || localStorage.getItem('vj.audioFile');
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
  if (gpuLost) {
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
  if (gpuLost) {
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
  if (gpuLost) {
    idleFrameClock();
    return;
  }
  if (document.hidden || !document.hasFocus()) useBackgroundClock();
  else useDisplayClock();
}

function setDeskMode(mode) {
  const next = mode === 'prep' || mode === 'midi' ? mode : 'live';
  if (next === 'prep' && deskMode !== 'prep') deskReturn = deskMode === 'midi' ? 'midi' : 'live';
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
  // Prep keeps RAF / background pump / WebGL / master output running.
  syncFrameClock();
  syncSceneClipWarm();
  if (prep) globalLibrary?.refresh();
  applyMidiSurface();
  if (midiOn) fitProgramMonitor();
  apcView?.refresh();
  try { localStorage.setItem('vj.workspace', next); } catch { /* ignore */ }
  persistProjectView(true);
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
$('mode-prep').addEventListener('click', () => setDeskMode(deskMode === 'prep' ? deskReturn : 'prep'));
$('mode-midi').addEventListener('click', () => setDeskMode('midi'));
if (isLinuxSystem()) {
  const label = document.querySelector('label[for="output-size"]');
  if (label) label.textContent = 'NDI';
  const size = $('output-size');
  if (size) size.title = `NDI output frame size. ${LINUX_PICTURE_NOTE}`;
  const status = $('output-send-status');
  if (status && !document.getElementById('picture-platform-note')) {
    const note = document.createElement('p');
    note.id = 'picture-platform-note';
    note.className = 'hint';
    note.textContent = LINUX_PICTURE_NOTE;
    status.insertAdjacentElement('beforebegin', note);
  }
}
{
  const savedSize = localStorage.getItem('vj.outputSize');
  const size = $('output-size');
  if (size && savedSize && [...size.options].some((o) => o.value === savedSize)) size.value = savedSize;
  size?.addEventListener('change', () => {
    const [w, h] = size.value.split('x').map(Number);
    if (w > 8 && h > 8) setMasterOutput({ w, h });
    try { localStorage.setItem('vj.outputSize', size.value); } catch { /* ignore */ }
    persistDesk();
  });
}
{
  const openIn = openInMode();
  if (openIn !== 'live') setDeskMode(openIn);
}
bindMediaPrep({ library, ensureStockDir: projectMediaWriteDir, showToast });
globalLibrary = bindGlobalLibrary({
  library,
  showToast,
  sourceDir: async () => currentSourceDir(),
  libraryDir: async () => mediaLibraryRoot({ create: false }),
  fetchedDir: async () => savedStockDir(),
  projectMediaDirs: async () => {
    const path = openedProjectFile();
    if (!path) return [];
    const dirs = [];
    for (const name of ['Source', 'Stock', 'Recordings']) {
      const dir = projectChild(path, name);
      if (await allowLibraryFolder(dir)) dirs.push(dir);
    }
    return dirs;
  },
  // Open project → <project>/Source/. Else Preferences Media Library folder.
  prepareDir: projectMediaWriteDir,
  inBin: (name) => project.mediaPool.some((item) => item.name === name),
  projectSnapshot,
  onDeleted: async (name) => {
    await releaseClip(name);
    refreshLibraryUi();
    refreshMediaSelect();
  },
  onAdd: (entry, { quiet } = {}) => {
    const added = addToBin(entry);
    if (!quiet) {
      showToast(added ? `Added ${entry.name} to the project` : `${entry.name} is already in this project`);
      globalLibrary?.refresh();
    }
    return !!added;
  },
});
paintAudioLibrary();
if (project.desk) applyDesk(project.desk);
deskReady = true;
if (!project.desk) project.setDesk(captureDesk());
if (project.view) applyProjectView(project.view);
restoreCachedMedia().then(async () => {
  await reopenLastProject();
  paintAudioRecent();
  await restoreLogoFiles();
});

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
