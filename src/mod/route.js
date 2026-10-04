// Final = Base + LFO_Signal * LFODepth + Audio_Signal * AudioDepth.
// Depth is sized from the parameter's nominal range. The result is not forced
// back inside that range, so a typed value past the default limits can stand.

const TAU = Math.PI * 2;

const hash11 = (p) => {
  const x = Math.sin(p * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

/** Bipolar wave, -1..1. */
export function lfoWave(shape, phase, cycle) {
  const p = phase - Math.floor(phase);
  if (shape === 1) return 1 - 4 * Math.abs(p - 0.5);
  if (shape === 2) return p * 2 - 1;
  if (shape === 3) return p < 0.5 ? 1 : -1;
  if (shape === 4) return hash11(cycle) * 2 - 1;
  return Math.sin(p * TAU);
}

function clampStep(def, value) {
  let v = value;
  if (!Number.isFinite(v)) return def.min;
  if (def.step) v = Math.round(v / def.step) * def.step;
  const cap = 1e6;
  return Math.min(cap, Math.max(-cap, v));
}

/**
 * Depth 0..1. Signal is -1..1, so depth 1 swings half the slider each way:
 * a full trip across the parameter (degrees, 0..1, whatever that slider is).
 */
export function lfoTerm(def, signal, amount) {
  return signal * amount * (def.max - def.min) * 0.5;
}

/** Audio signal is 0..1. Depth is signed -1..1. Depth 1 adds the whole slider span. */
export function audioTerm(def, signal, depth) {
  return signal * depth * (def.max - def.min);
}

export function finalValue(def, base, lfoSignal, lfoAmount, audioSignal, audioDepth) {
  return clampStep(
    def,
    base + lfoTerm(def, lfoSignal, lfoAmount) + audioTerm(def, audioSignal, audioDepth),
  );
}
