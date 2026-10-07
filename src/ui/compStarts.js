import { LAYERS, LAYER_DEFS, MODES, layerParam } from '../params.js';
import { KICK_DRIVEN } from '../audio/recipes.js';

// Opening values for these keys already include the per-layer overrides.
const OPEN_KEYS = new Set([
  'engine', 'mode', 'opacity', 'blend', 'blendInvert', 'scale', 'posX', 'posY',
  'reactivity', 'audioBind', 'beatSync',
]);

const GRADE_IDS = [
  'gradeHue', 'gradeSat', 'gradeContrast', 'crtBleed', 'crtScan', 'crtBarrel',
  'chroma', 'strobe', 'strobeSrc', 'strobePol', 'master',
];

const lookKey = (def) => def.group === 'look' || MODES.includes(def.group);

function commit(params, fn) {
  if (params.history) params.history.group(fn);
  else fn();
}

function writeLayer(params, layer, key, value) {
  params.set(layerParam(layer, key), value, { history: 'commit' });
}

export const START_STACKS = [
  {
    id: 'page',
    label: 'Page',
    A: { mode: 'home', opacity: 1, blend: 0, band: 1, reactivity: 0.7, beat: 0, sliders: { homeTile: 0.28, homeMix: 0.7, homeBevel: 0.6 } },
    B: { mode: 'marquee', opacity: 0.45, blend: 2, band: 3, reactivity: 0.5, sliders: { marqueeBand: 0.82, marqueeSize: 0.22, marqueeSpeed: 0.35 } },
    C: { mode: 'gif', opacity: 0.2, blend: 0, band: 3, reactivity: 0.8, sliders: { gifLoad: 0.4, gifGap: 0.6, gifEase: 0.35 } },
  },
  {
    id: 'download',
    label: 'Download',
    A: { mode: 'jpeg', opacity: 1, blend: 0, band: 3, reactivity: 0.9, beat: 0.2, sliders: { jpegBlock: 0.5, jpegSmear: 0.6, jpegCrush: 0.45 } },
    B: { mode: 'cd', opacity: 0.55, blend: 5, band: 1, reactivity: 1, sliders: { cdRing: 0.5, cdSeek: 0.35, cdRate: 0.3 } },
    C: { mode: 'sort', opacity: 0.35, blend: 2, band: 2, reactivity: 0.6, sliders: { sortGate: 0.6, sortLen: 0.35, sortFall: 0.5 } },
  },
  {
    id: 'chrome',
    label: 'Chrome',
    A: { mode: 'y2k', opacity: 1, blend: 0, band: 1, reactivity: 0.8, sliders: { glitch: 0.25, feedback: 0.35, edgeGlow: 1.4, clouds: 0.45, hueShift: 0.08 } },
    B: { mode: 'metal', opacity: 0.5, blend: 2, band: 1, reactivity: 1.1, beat: 0.15, sliders: { glitch: 0.4, feedback: 0.45 } },
    C: { mode: 'thermal', opacity: 0.25, blend: 1, band: 2, reactivity: 0.3, sliders: { heat: 1.15 } },
  },
  {
    id: 'garden',
    label: 'Garden',
    A: { mode: 'cloud', opacity: 1, blend: 0, band: 1, reactivity: 0.6, sliders: { cloudCover: 0.4, cloudDrift: 0.3, cloudBand: 0.6 } },
    B: { mode: 'brick', opacity: 0.4, blend: 1, band: 2, reactivity: 0.45, sliders: { brickSize: 0.38, brickStud: 0.7, brickTint: 0.85 } },
    C: { mode: 'clean', opacity: 0.2, blend: 2, band: 4, reactivity: 0, sliders: {} },
  },
  {
    id: 'stir',
    label: 'Stir',
    A: { mode: 'ink', opacity: 1, blend: 0, band: 1, reactivity: 0.85, sliders: { inkLife: 0.62, inkStir: 0.4, inkCurl: 0.35 } },
    B: { mode: 'fold', opacity: 0.4, blend: 2, band: 2, reactivity: 0.7, sliders: { foldDepth: 0.35, foldScale: 0.45, foldSheets: 0.55 } },
    C: { mode: 'glitch', opacity: 0, blend: 0, band: 3, reactivity: 0.9, sliders: { glitch: 0.35, feedback: 0.25 } },
  },
  {
    id: 'arcade',
    label: 'Arcade',
    A: { mode: 'chomp', opacity: 0.85, blend: 0, band: 1, reactivity: 1, beat: 0.4, sliders: { chompSize: 0.32, chompSpeed: 0.45, chompMouth: 0.75 } },
    B: { mode: 'flash', opacity: 0.4, blend: 2, band: 3, reactivity: 0.6, sliders: { blob: 0.5, outline: 0.65, flatColor: 0.4, tween: 0.25 } },
    C: { mode: 'dither', opacity: 0.3, blend: 7, band: 2, reactivity: 0.4, sliders: { pixelSize: 8, palette: 0, dither: 0.8, jitter: 0.15 } },
  },
  {
    id: 'warp',
    label: 'Warp',
    A: { mode: 'bend', opacity: 1, blend: 0, band: 1, reactivity: 1.2, beat: 0.25, sliders: { bendAmt: 0.55, bendCurve: 0.4, bendLean: 0.15 } },
    B: { mode: 'vhs', opacity: 0.45, blend: 2, band: 3, reactivity: 0.9, sliders: { tracking: 0.4, tapeJitter: 0.55, smear: 0.5, scanlines: 0.45 } },
    C: { mode: 'eater', opacity: 0.35, blend: 4, band: 1, reactivity: 0.8, sliders: { bite: 0.5, chew: 0.3, threshold: 0.45, leftovers: 0.35 } },
  },
];

function writeOpacityRoute(params, mods, lfo, layer, route, sync) {
  if (!mods || !route) return;
  const key = route.key || 'opacity';
  if (key !== 'opacity' || KICK_DRIVEN.includes(key)) return;
  const id = layerParam(layer, 'opacity');
  const prev = {
    mod: structuredClone(mods.get(id)),
    lfo: lfo?.get(id) ? structuredClone(lfo.get(id)) : null,
  };
  mods.set(id, { route: route.route, depth: route.depth, gate: route.gate });
  if (lfo?.isOn(id)) lfo.set(id, { on: false });
  const next = {
    mod: structuredClone(mods.get(id)),
    lfo: lfo?.get(id) ? structuredClone(lfo.get(id)) : null,
  };
  params.history?.edit(`mod:${id}`, prev, next, (snap) => {
    mods.set(id, snap.mod);
    if (lfo) lfo.write(id, snap.lfo);
    sync?.();
  }, 'commit');
  sync?.();
}

export function applyStart(params, stack, { setSpeed, mods, lfo, sync } = {}) {
  commit(params, () => {
    for (const layer of LAYERS) {
      const spec = stack[layer];
      if (!spec) continue;
      const mode = MODES.indexOf(spec.mode);
      writeLayer(params, layer, 'engine', 0);
      if (mode >= 0) writeLayer(params, layer, 'mode', mode);
      if ('opacity' in spec) writeLayer(params, layer, 'opacity', spec.opacity);
      if ('blend' in spec) writeLayer(params, layer, 'blend', spec.blend);
      if ('band' in spec) writeLayer(params, layer, 'audioBind', spec.band);
      if ('reactivity' in spec) writeLayer(params, layer, 'reactivity', spec.reactivity);
      if ('beat' in spec) writeLayer(params, layer, 'beatSync', spec.beat);
      for (const [key, value] of Object.entries(spec.sliders || {})) writeLayer(params, layer, key, value);
      if (spec.opacityRoute) writeOpacityRoute(params, mods, lfo, layer, spec.opacityRoute, sync);
    }
    if (stack.grade) {
      for (const [id, value] of Object.entries(stack.grade)) {
        params.set(id, value, { history: 'commit' });
      }
    }
    if (stack.speed != null && setSpeed) setSpeed(stack.speed);
  });
}

export function clearComposition(params, setSpeed) {
  commit(params, () => {
    for (const layer of LAYERS) {
      for (const def of LAYER_DEFS) {
        const id = layerParam(layer, def.id);
        if (OPEN_KEYS.has(def.id)) {
          params.set(id, params.defs.get(id).defaultValue, { history: 'commit' });
        } else if (lookKey(def)) {
          params.set(id, def.value, { history: 'commit' });
        }
      }
    }
    for (const id of GRADE_IDS) {
      params.set(id, params.defs.get(id).defaultValue, { history: 'commit' });
    }
    setSpeed(1);
  });
}
