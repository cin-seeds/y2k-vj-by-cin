// Reads the same Base + LFO + Audio mix the picture uses, and reports when
// that mix leaves a slider's visual range or two sources fight over it.

import { ENGINE_HYDRA, ENGINE_PARTICLES } from '../engines/constants.js';
import { LFO_SHAPES } from '../lfo/LfoEngine.js';
import { MOD_ROUTES } from '../audio/ModMatrix.js';
import { KICK_DRIVEN, KICK_MODES, controlShown } from '../audio/recipes.js';
import { layerParam } from '../params.js';

const HUD_SIZE = {
  id: 'hud.size',
  friendlyLabel: 'Font Scale',
  label: 'Font Scale',
  min: 10,
  max: 48,
  layer: null,
};

const routeLabel = (id) => MOD_ROUTES.find((r) => r.id === id)?.label || id;

function scopeOf(def, id) {
  if (id === 'hud.size') return '[HUD]';
  if (def?.layer) return `[Layer ${def.layer}]`;
  return '[Composition]';
}

function nameOf(def) {
  return def?.friendlyLabel || def?.label || 'Parameter';
}

/**
 * @param {{ params: { defs: Map<string, object>, get: (id: string) => number }, lfo: { lanes: Map<string, object>, get: (id: string) => object|null }, mods: { lanes: Map<string, object>, get: (id: string) => { route: string, depth: number } }, bypassed?: (def: object) => boolean }} ctx
 */
export function diagnoseRouting(ctx) {
  const { params, lfo, mods } = ctx;
  const bypassed = ctx.bypassed || (() => false);
  const routes = [];
  const warnings = [];
  const ids = new Set([...lfo.lanes.keys(), ...mods.lanes.keys()]);

  for (const id of ids) {
    const def = id === 'hud.size' ? HUD_SIZE : params.defs.get(id);
    if (!def || def.options || !(def.max > def.min)) continue;
    const lane = lfo.get(id);
    const mod = mods.get(id);
    const lfoOn = !!(lane?.on && lane.amount > 0.001);
    const audioOn = !!(mod && mod.route !== 'none' && Math.abs(mod.depth) > 0.001);
    if (!lfoOn && !audioOn) continue;

    const drivers = [];
    if (lfoOn) drivers.push(`LFO (${LFO_SHAPES[lane.shape] || 'Sine'})`);
    if (audioOn) drivers.push(routeLabel(mod.route));
    const scope = scopeOf(def, id);
    const name = nameOf(def);
    routes.push({
      id,
      text: `${scope} ${name} <- Driven by ${drivers.join(' + ')}`,
    });

    const span = def.max - def.min;
    const swing = lfoOn ? lane.amount * span * 0.5 : 0;
    const audioPush = audioOn ? mod.depth * span : 0;
    const base = params.get(id);
    const low = base - swing + Math.min(0, audioPush);
    const high = base + swing + Math.max(0, audioPush);
    const eps = Math.max(span * 0.02, 1e-4);
    const over = Math.max(high - def.max, def.min - low, 0);
    const cause = audioOn && lfoOn
      ? `LFO and ${routeLabel(mod.route)}`
      : audioOn
        ? routeLabel(mod.route)
        : `LFO (${LFO_SHAPES[lane.shape] || 'Sine'})`;
    if (!bypassed(def) && over > eps) {
      warnings.push({
        id,
        level: over > span * 0.25 ? 'bad' : 'warn',
        layerId: def.layer || null,
        parameterTarget: id,
        text: `⚠️ ${scope} ${name} is clipping due to ${cause}. Reduce the base slider or the modulation depth.`,
      });
    }
    if (lfoOn && audioOn && lane.amount >= 0.45 && Math.abs(mod.depth) >= 0.45) {
      warnings.push({
        id: `${id}:fight`,
        level: 'warn',
        layerId: def.layer || null,
        parameterTarget: id,
        text: `⚠️ ${scope} ${name} has conflicting LFO and Audio triggers. Visuals may stutter.`,
      });
    }
  }

  routes.sort((a, b) => a.text.localeCompare(b.text));
  return { routes, warnings };
}

function names(layers) {
  return layers.map((l) => l.id).join(', ').replace(/, ([^,]+)$/, ' and $1');
}

/**
 * Heavy engine combinations that are likely to miss frames.
 * A layer only counts when it is actually drawing (opacity above zero).
 */
export function diagnoseLoad(layers, renderScale = 1) {
  const warnings = [];
  const live = layers.filter((l) => l.active);
  const kind = (l) => {
    if (l.is3D) return '3d';
    if (l.engine === ENGINE_PARTICLES) return 'particles';
    if (l.engine === ENGINE_HYDRA) return 'hydra';
    return 'fx';
  };
  const particles = live.filter((l) => kind(l) === 'particles');
  const hydra = live.filter((l) => kind(l) === 'hydra');
  const spatial = live.filter((l) => kind(l) === '3d');
  const heavy = particles.length + hydra.length + spatial.length;

  if (particles.length >= 3) {
    warnings.push({
      level: 'bad',
      layerId: particles[0].id,
      parameterTarget: layerParam(particles[0].id, 'pCount'),
      text: `⚠️ Layers ${names(particles)} are all running Particle Vector Swarms. Three swarms at once are likely to drop frames.`,
    });
  } else if (particles.length === 2) {
    const big = particles.filter((l) => l.get('pCount') >= 35000);
    if (big.length === 2) {
      warnings.push({
        level: 'warn',
        layerId: big[0].id,
        parameterTarget: layerParam(big[0].id, 'pCount'),
        text: `⚠️ Layers ${names(particles)} are running large particle swarms. That many points are likely to drop frames.`,
      });
    }
  }
  if (hydra.length >= 3) {
    warnings.push({
      level: 'bad',
      layerId: hydra[0].id,
      parameterTarget: layerParam(hydra[0].id, 'engine'),
      text: `⚠️ Layers ${names(hydra)} are all running Hydra feedback. The extra framebuffers are likely to drop frames.`,
    });
  }
  if (spatial.length >= 2) {
    warnings.push({
      level: 'warn',
      layerId: spatial[0].id,
      parameterTarget: layerParam(spatial[0].id, 'mode'),
      text: `⚠️ Layers ${names(spatial)} are both drawing 3D scenes. Two camera passes are likely to drop frames.`,
    });
  }
  if (renderScale >= 2 && heavy >= 1) {
    warnings.push({
      level: 'warn',
      layerId: null,
      parameterTarget: null,
      domId: 'render-scale',
      text: '⚠️ Render scale is 2x while a heavy engine is running. That combination is likely to drop frames.',
    });
  }
  return warnings;
}

/**
 * Soft routing tips. These do not raise the diagnostic badge.
 * Visible = opacity above zero and not muted/solo-hidden.
 */
export function diagnoseReadable(ctx) {
  const { params, mods, layers } = ctx;
  const audible = ctx.audible || (() => true);
  const tips = [];
  const visible = layers.filter((l) => l.active && audible(l.id));

  const allLoud = visible.filter((l) => (l.get('audioBind') | 0) === 0 && l.get('reactivity') >= 0.8);
  if (allLoud.length >= 2) {
    tips.push({
      layerId: allLoud[0].id,
      parameterTarget: layerParam(allLoud[0].id, 'audioBind'),
      text: `Layers ${names(allLoud)} all listen on All bands at high reactivity. Give each layer a different band.`,
    });
  }

  for (const l of visible) {
    if (!KICK_MODES.has(l.mode)) continue;
    if (l.get('beatSync') < 0.35) continue;
    tips.push({
      layerId: l.id,
      parameterTarget: layerParam(l.id, 'beatSync'),
      text: `Layer ${l.id} Beat Sync is stacked on a look that already follows the kick.`,
    });
  }

  for (const l of visible) {
    for (const key of KICK_DRIVEN) {
      const id = layerParam(l.id, key);
      const def = params.defs.get(id);
      if (!controlShown(l.engine, l.mode, def)) continue;
      const mod = mods.get(id);
      if (!mod || mod.route === 'none' || Math.abs(mod.depth) <= 0.001) continue;
      const label = def?.friendlyLabel || def?.label || key;
      tips.push({
        layerId: l.id,
        parameterTarget: id,
        text: `Layer ${l.id} ${label} has a matrix route on a slider the look already moves from bass/kick.`,
      });
    }
  }

  const strobe = params.get('strobe');
  const strobeSrc = params.get('strobeSrc') | 0;
  if (strobe > 0.15 && strobeSrc === 1) {
    const synced = visible.filter((l) => l.get('beatSync') > 0.2);
    if (synced.length) {
      tips.push({
        layerId: synced[0].id,
        parameterTarget: 'strobe',
        text: 'Strobe Amount on Beat Pulse stacks with layer Beat Sync.',
      });
    }
  }

  return tips;
}
