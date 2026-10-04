// These are the numbers the GPU actually uses, so the code HUD can print them.
// Slider bases are multiplied by the layer's audio so FFT motion stays live.

export function particleDrive(u, dt, extra = {}) {
  const sub = u.uSubBass?.value ?? 0;
  const punch = u.uPunch?.value ?? 0;
  const kick = u.uKick?.value ?? 0;
  const react = u.uReactivity?.value ?? 1;
  const turb = u.uPTurbulence?.value ?? 1;
  const speed = u.uPSpeed?.value ?? 1;
  const size = u.uPSize?.value ?? 8;
  const depth = u.uPDepth?.value ?? 0.85;
  const colorMode = extra.colorMode ?? 0;
  const subN = sub * react;
  const punchN = punch * react;
  const hit = Math.max(punchN, kick * react);
  return {
    uNoiseScale: (0.65 + turb * 1.7) * (1 + subN * 1.5 + hit * 2.4),
    uFreq: 0.1 + subN * 0.45 + hit * 1.1,
    uFlow: (0.08 + speed * 0.55) * (1 + subN * 2.6),
    uBlow: hit * (0.045 + speed * 0.07),
    uSpring: 1 - Math.exp(-(1.4 + (1 - Math.min(hit, 1)) * 4.2) * dt),
    uDt: dt,
    uPointSize: Math.max(1, Math.min(20, size)),
    uDepth: depth,
    uSubBass: subN,
    uPunch: punchN,
    uColorMode: colorMode,
    uPTurbulence: turb,
    uPSpeed: speed,
    uPSize: size,
    uPDepth: depth,
    uTime: u.uTime.value,
  };
}

export function hydraDrive(u, dt, blend = 0) {
  const bass = u.uBass.value;
  const treble = u.uTreble.value;
  const kick = u.uKick.value;
  const time = u.uTime.value;
  const decay = u.uHDecay?.value ?? 0.72;
  const rot = u.uHRot?.value ?? 0.4;
  const zoom = u.uHZoom?.value ?? 0.25;
  const hue = u.uHHue?.value ?? 0;
  return {
    uHydraRot: dt * (rot * 0.9 + bass * 1.1) + Math.sin(time * (1.5 + treble * 4.0)) * treble * 0.02,
    uHydraScale: 1 + zoom * 0.018 + bass * 0.008 + kick * 0.004,
    uHydraBleed: Math.min(0.97, decay * 0.92 + bass * 0.06),
    uHydraWarp: 0.01 + treble * 0.14,
    uHydraHue: hue * Math.PI * 2 + treble * 0.6,
    uLayerBlend: blend,
    uHDecay: decay,
    uHRot: rot,
    uHZoom: zoom,
    uHHue: hue,
    uBass: bass,
    uTreble: treble,
    uKick: kick,
    uTime: time,
  };
}
