// Drum-pad overrides. A note press forces master uniforms; the release clears
// them. Nothing is written into the ParamStore, so the active scene stays put.

import { ENGINE_FX, ENGINE_PARTICLES, ENGINES } from '../engines/constants.js';
import { MODES, layerParam } from '../params.js';

const MODE_Y2K = MODES.indexOf('y2k');
const MODE_GLITCH = MODES.indexOf('glitch');
const MODE_METAL = MODES.indexOf('metal');

export const MOMENTARY = [
  { id: 'y2k', label: 'Y2K Crash', short: 'Y2K' },
  { id: 'glitch', label: 'Max Glitch', short: 'Max Glitch' },
  { id: 'invert', label: 'Invert Colors', short: 'Invert' },
  { id: 'metal', label: 'Black Metallic Y2K', short: 'Dark Y2k' },
  { id: 'shatter', label: 'Particle Scatter', short: 'Particle' },
  { id: 'strobe', label: 'Strobe/Flash', short: 'Strobe' },
];

export class MomentaryPads {
  constructor() {
    this.held = new Set();
    this.onChange = () => {};
    this.forcing = false;
    this.kind = '';
  }

  set(id, down) {
    const before = this.held.has(id);
    if (down) this.held.add(id);
    else this.held.delete(id);
    if (before !== this.held.has(id)) this.onChange();
  }

  /** Apply after LFOs so a held pad wins for this frame, then restore on release. */
  apply(layers, comp, now) {
    const strobe = this.held.has('strobe');
    const invert = this.held.has('invert');
    const shatter = this.held.has('shatter');
    const metal = this.held.has('metal') && !shatter;
    const y2k = this.held.has('y2k') && !shatter && !metal;
    const glitch = this.held.has('glitch') && !shatter && !metal && !y2k;
    comp.uFlash.value = strobe ? (Math.sin(now * 48) > 0 ? 1 : 0) : 0;
    comp.uInvert.value = invert ? 1 : 0;

    const kind = shatter ? 'shatter' : metal ? 'metal' : y2k ? 'y2k' : glitch ? 'glitch' : '';
    const entered = kind && kind !== this.kind;
    const forceMode = (layer, mode) => {
      layer.liveOverride.set('engine', ENGINES.indexOf(ENGINE_FX));
      layer.liveOverride.set('mode', mode);
      layer.setEngine(ENGINE_FX);
      if (entered) layer.onParam('mode', mode);
    };
    for (const layer of layers) {
      if (shatter) {
        layer.liveOverride.set('engine', ENGINES.indexOf(ENGINE_PARTICLES));
        layer.setEngine(ENGINE_PARTICLES);
      } else if (metal) {
        forceMode(layer, MODE_METAL);
      } else if (y2k) {
        forceMode(layer, MODE_Y2K);
      } else if (glitch) {
        layer.liveOverride.set('mode', MODE_GLITCH);
        layer.liveOverride.set('glitch', 1);
        layer.setUniform('glitch', 1);
        layer.setEngine(ENGINE_FX);
        if (entered) layer.onParam('mode', MODE_GLITCH);
      }
    }
    if (this.kind && !kind) {
      for (const layer of layers) {
        layer.onParam('engine', layer.params.get(layerParam(layer.id, 'engine')));
        layer.onParam('mode', layer.params.get(layerParam(layer.id, 'mode')));
        layer.onParam('glitch', layer.params.get(layerParam(layer.id, 'glitch')));
      }
    }
    this.kind = kind;
    this.forcing = !!kind;
  }
}
