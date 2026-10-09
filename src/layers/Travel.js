// Per-layer Travel autopilot. Random zooms and pans through scale / posX / posY,
// always filling the frame (scale >= 1, position clamped so the crop stays inside).

import { LAYERS, layerParam } from '../params.js';

const SCALE_MAX = 2.6;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Max |pos| so the transform crop stays inside the source at this scale. */
export function travelMaxShift(scale) {
  return 0.5 * Math.max(0, scale - 1);
}

export function clampTravelPose(pose) {
  const scale = clamp(Number(pose.scale) || 1, 1, SCALE_MAX);
  const max = travelMaxShift(scale);
  return {
    scale,
    posX: clamp(Number(pose.posX) || 0, -max, max),
    posY: clamp(Number(pose.posY) || 0, -max, max),
  };
}

function randomPose(rng = Math.random) {
  const scale = 1 + rng() * (SCALE_MAX - 1);
  const max = travelMaxShift(scale);
  return clampTravelPose({
    scale,
    posX: (rng() * 2 - 1) * max,
    posY: (rng() * 2 - 1) * max,
  });
}

function ease(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function lerpPose(a, b, t) {
  const u = ease(t);
  return clampTravelPose({
    scale: a.scale + (b.scale - a.scale) * u,
    posX: a.posX + (b.posX - a.posX) * u,
    posY: a.posY + (b.posY - a.posY) * u,
  });
}

function readPose(params, id) {
  return {
    scale: Number(params.get(layerParam(id, 'scale'))) || 1,
    posX: Number(params.get(layerParam(id, 'posX'))) || 0,
    posY: Number(params.get(layerParam(id, 'posY'))) || 0,
  };
}

function writePose(params, layers, id, pose, { clampInside = true } = {}) {
  const next = clampInside ? clampTravelPose(pose) : {
    scale: Number(pose.scale) || 1,
    posX: Number(pose.posX) || 0,
    posY: Number(pose.posY) || 0,
  };
  params.set(layerParam(id, 'scale'), next.scale);
  params.set(layerParam(id, 'posX'), next.posX);
  params.set(layerParam(id, 'posY'), next.posY);
  const layer = layers.find((item) => item.id === id);
  if (!layer) return next;
  layer.liveOverride.set('scale', next.scale);
  layer.liveOverride.set('posX', next.posX);
  layer.liveOverride.set('posY', next.posY);
  return next;
}

function speedNorm(speed) {
  return clamp((Number(speed) - 0.05) / (2 - 0.05), 0, 1);
}

/**
 * @param {import('../params.js').ParamStore} params
 * @param {{ id: string, liveOverride: Map }[]} layers
 */
export function createTravel(params, layers) {
  /** @type {Map<string, { from: object, to: object, base: object | null, t: number, hold: number, on: boolean }>} */
  const state = new Map();

  for (const id of LAYERS) {
    const pose = readPose(params, id);
    state.set(id, {
      from: pose,
      to: pose,
      base: null,
      t: 1,
      hold: 0,
      on: false,
    });
  }

  function arm(id, current) {
    const slot = state.get(id);
    slot.from = clampTravelPose(current);
    slot.to = randomPose();
    slot.t = 0;
    slot.hold = 0;
  }

  function tick(dt) {
    const step = dt > 0 ? dt : 0;
    for (const id of LAYERS) {
      const on = (params.get(layerParam(id, 'travel')) || 0) > 0.5;
      const slot = state.get(id);
      if (!on) {
        if (slot.on) {
          // Restore the pose from when Travel was turned on — not the last travel pose.
          if (slot.base) writePose(params, layers, id, slot.base, { clampInside: false });
          slot.base = null;
          slot.on = false;
        }
        continue;
      }

      const style = (params.get(layerParam(id, 'travelStyle')) || 0) > 0.5 ? 'fade' : 'cut';
      const n = speedNorm(params.get(layerParam(id, 'travelSpeed')));
      const fadeDur = 2.4 - n * 2.1;
      const holdDur = 2.8 - n * 2.5;

      if (!slot.on) {
        slot.on = true;
        slot.base = readPose(params, id);
        const current = clampTravelPose(slot.base);
        if (style === 'cut') {
          const pose = randomPose();
          slot.from = pose;
          slot.to = pose;
          slot.t = 1;
          slot.hold = holdDur;
          writePose(params, layers, id, pose);
        } else {
          arm(id, current);
          writePose(params, layers, id, current);
        }
        continue;
      }

      if (!(step > 0)) {
        writePose(params, layers, id, slot.t < 1 ? lerpPose(slot.from, slot.to, slot.t) : slot.to);
        continue;
      }

      if (style === 'cut') {
        slot.hold -= step;
        if (slot.hold <= 0) {
          const pose = randomPose();
          slot.from = pose;
          slot.to = pose;
          slot.t = 1;
          slot.hold = holdDur;
          writePose(params, layers, id, pose);
        } else {
          writePose(params, layers, id, slot.to);
        }
        continue;
      }

      if (slot.t < 1) {
        slot.t = Math.min(1, slot.t + step / Math.max(0.08, fadeDur));
        writePose(params, layers, id, lerpPose(slot.from, slot.to, slot.t));
        if (slot.t >= 1) slot.hold = holdDur;
        continue;
      }

      slot.hold -= step;
      writePose(params, layers, id, slot.to);
      if (slot.hold <= 0) arm(id, slot.to);
    }
  }

  return { tick };
}
