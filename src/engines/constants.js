export const ENGINE_FX = 'fx';
export const ENGINE_PARTICLES = 'particles';
export const ENGINE_HYDRA = 'hydra';

export const ENGINES = [ENGINE_FX, ENGINE_PARTICLES, ENGINE_HYDRA];

export const ENGINE_LABELS = {
  [ENGINE_FX]: 'Standard Video / Image FX',
  [ENGINE_PARTICLES]: 'Particle Vector Swarm',
  [ENGINE_HYDRA]: 'Hydra Feedback Synth',
};

/** What a particle layer samples for color and brightness. */
export const PARTICLE_SOURCES = [
  'Current Layer Video',
  'Layer A Buffer',
  'Layer B Buffer',
  'Procedural Noise Grid',
];

/** Grid that holds about `count` particles (5:4), clamped to 5,000–50,000. */
export function particleGrid(count) {
  const n = Math.max(5000, Math.min(50000, Math.round(Number(count) || 20000)));
  let w = Math.max(40, Math.round(Math.sqrt(n * 1.25)));
  let h = Math.max(40, Math.round(n / w));
  while (w * h > 50000) h -= 1;
  return { w, h, count: w * h };
}
