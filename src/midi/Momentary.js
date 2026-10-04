// Drum-pad overrides. A note press forces master uniforms; the release clears
// them. Nothing is written into the ParamStore, so the active scene stays put.

import { ENGINE_FX, ENGINE_PARTICLES, ENGINES } from '../engines/constants.js';
import { layerParam } from '../params.js';

export const MOMENTARY = [
  { id: 'strobe', label: 'Strobe/Flash' },
  { id: 'y2k', label: 'Y2K Crash' },
  { id: 'shatter', label: 'Particle Scatter' },
  { id: 'invert', label: 'Invert Colors' },
  { id: 'glitch', label: 'Max Glitch' },
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
    const y2k = this.held.has('y2k') && !shatter;
    const glitch = this.held.has('glitch') && !shatter && !y2k;
    comp.uFlash.value = strobe ? (Math.sin(now * 48) > 0 ? 1 : 0) : 0;
    comp.uInvert.value = invert ? 1 : 0;

    const kind = shatter ? 'shatter' : y2k ? 'y2k' : glitch ? 'glitch' : '';
    const entered = kind && kind !== this.kind;
    for (const layer of layers) {
      if (shatter) {
        layer.liveOverride.set('engine', ENGINES.indexOf(ENGINE_PARTICLES));
        layer.setEngine(ENGINE_PARTICLES);
      } else if (y2k) {
        layer.liveOverride.set('engine', ENGINES.indexOf(ENGINE_FX));
        layer.liveOverride.set('mode', 2);
        layer.setEngine(ENGINE_FX);
        if (entered) layer.onParam('mode', 2);
      } else if (glitch) {
        layer.liveOverride.set('mode', 0);
        layer.liveOverride.set('glitch', 1);
        layer.setUniform('glitch', 1);
        layer.setEngine(ENGINE_FX);
        if (entered) layer.onParam('mode', 0);
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
