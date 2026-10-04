import { ENGINE_HYDRA, ENGINE_LABELS, ENGINE_PARTICLES } from '../engines/constants.js';
import { hydraDrive, particleDrive } from '../engines/drive.js';

const RAMP = ' .:-=+*#%@';
const MATRIX = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿ0123456789';

function model(id, title, source, values) {
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string') clean[k] = v;
    else clean[k] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  return { id, title, source, values: clean };
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v || 0));
}

/** Glyph row driven by the FFT so the chosen character set moves with the music. */
function glyphField(audio, glyph) {
  const bands = [audio.sub || 0, audio.punch || 0, audio.mid || 0, audio.treble || 0];
  if (glyph === 'matrix') {
    const tick = Math.floor(performance.now() / 40);
    return bands.map((level, band) => {
      const n = 10;
      let s = '';
      for (let i = 0; i < n; i++) {
        const on = i / n < clamp01(level) + 0.05;
        const idx = Math.abs((tick + band * 13 + i * 7) % MATRIX.length);
        s += on ? MATRIX[idx] : ' ';
      }
      return s;
    }).join(' ');
  }
  if (glyph === 'ramp') {
    return bands.map((level) => {
      const n = 12;
      let s = '';
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / n;
        s += t <= clamp01(level) ? RAMP[Math.min(RAMP.length - 1, Math.ceil(t * (RAMP.length - 1)))] : ' ';
      }
      return s;
    }).join(' ');
  }
  return `sub ${bands[0].toFixed(3)}  punch ${bands[1].toFixed(3)}  mid ${bands[2].toFixed(3)}  treb ${bands[3].toFixed(3)}`;
}

/** Formula text plus the uniform values the shader is executing this frame. */
export function liveCodeModel(layer, dt) {
  const u = layer.uniforms;
  const engine = layer.engine;
  if (engine === ENGINE_PARTICLES) {
    const sources = ['video', 'layerA', 'layerB', 'noise'];
    const src = sources[layer.particleSource] || 'video';
    const sample = src === 'noise' ? 'noise(homeUv)' : `texture(uParticleTexture, homeUv)`;
    return model(
      `particles:${layer.id}:${layer.particles.grid.count}:${src}:${layer.get('pColor')}`,
      `particleFlow.glsl   layer ${layer.id}   ${layer.particles.grid.count} pts   ${src}`,
      `rgb = ${sample};
lum = dot(rgb, vec3(0.299, 0.587, 0.114));
pos += curlNoise(pos * uNoiseScale) * uFlow * uDt;
pos += (pos - 0.5) * uPunch;
pos = mix(pos, homeUv, uSpring);
z = lum * uDepth * (1.0 + uSubBass + uPunch);
gl_PointSize = uPointSize;
count = uCount;`,
      {
        ...particleDrive(u, dt, { colorMode: layer.get('pColor') }),
        uCount: layer.particles.grid.count,
      },
    );
  }
  if (engine === ENGINE_HYDRA) {
    return model(
      `hydra:${layer.id}`,
      `hydra.glsl   layer ${layer.id}`,
      `vec2 p = rotate(uv - 0.5, uHydraRot) / uHydraScale;
p += sin(p.yx * 12.0 + uTime) * uHydraWarp;
rgb = mix(src(uv), blend(src(uv), hue(feedback(p), uHydraHue), uLayerBlend), uHydraBleed);
decay = uHDecay;`,
      hydraDrive(u, dt, layer.get('blend')),
    );
  }
  const values = {
    uGlitch: u.uGlitch?.value,
    uFeedback: u.uFeedback?.value,
    uReactivity: u.uReactivity?.value,
    uBass: u.uBass.value,
    uMid: u.uMid.value,
    uTreble: u.uTreble.value,
    uKick: u.uKick.value,
    uBeat: u.uBeat.value,
    uTime: u.uTime.value,
  };
  return model(
    `fx:${layer.id}:${layer.mode}`,
    `${layer.mode}.frag   layer ${layer.id}`,
    `rgb = ${layer.mode}(src(uv), uGlitch, uFeedback, uBass, uKick);`,
    values,
  );
}

/**
 * One overlay for the whole stack: each layer's live formula and uniforms,
 * then the FFT bands. Uniform names are suffixed with the layer id so A/B/C
 * can update independently.
 */
export function liveStackModel(layers, audio, dt, glyph = 'ascii', audioLive = false) {
  const values = {
    uSubBass: audio.sub || 0,
    uPunch: audio.punch || 0,
    uMids: audio.mid || 0,
    uTreble: audio.treble || 0,
    uPeakFlash: audio.peakFlash || 0,
    uSongEnergy: audio.songEnergy || 0,
    uDropPulse: audio.dropPulse || 0,
    uGlyphField: glyphField(audio, glyph),
  };
  const blocks = [
    `glyph  uGlyphField`,
  ];
  const ids = [glyph, audioLive ? 'live' : 'idle'];
  for (const layer of layers) {
    const part = liveCodeModel(layer, dt);
    ids.push(part.id);
    const tag = layer.id;
    const source = part.source.replace(/\b(u[A-Z]\w*)\b/g, `$1_${tag}`);
    for (const [k, v] of Object.entries(part.values)) values[`${k}_${tag}`] = v;
    const state = layer.engine === ENGINE_PARTICLES
      ? 'swarm'
      : layer.engine === ENGINE_HYDRA
        ? 'feedback'
        : layer.mode;
    values[`uOpacity_${tag}`] = layer.get('opacity');
    blocks.push(`// ${tag}  ${ENGINE_LABELS[layer.engine]}  ${state}\nopacity uOpacity_${tag}\n${source}`);
  }
  blocks.push(`// FFT  ${audioLive ? 'live' : 'idle'}
subBass uSubBass
punch   uPunch
mids    uMids
treble  uTreble`);
  return model(ids.join('|'), 'layers A  B  C', blocks.join('\n\n'), values);
}

/** Short equations only: the active formula for each layer, without the uniform dump. */
export function liveFormulaModel(layers, audio, dt) {
  const values = {
    uSubBass: audio.sub || 0,
    uPunch: audio.punch || 0,
    uMids: audio.mid || 0,
    uTreble: audio.treble || 0,
    uPeakFlash: audio.peakFlash || 0,
    uBeatPulse: audio.beatPulse || 0,
    uSongEnergy: audio.songEnergy || 0,
    uDropPulse: audio.dropPulse || 0,
  };
  const blocks = [];
  const ids = ['formula'];
  for (const layer of layers) {
    const part = liveCodeModel(layer, dt);
    ids.push(part.id);
    const tag = layer.id;
    const source = part.source.replace(/\b(u[A-Z]\w*)\b/g, `$1_${tag}`);
    for (const [k, v] of Object.entries(part.values)) {
      if (typeof v === 'number') values[`${k}_${tag}`] = v;
    }
    blocks.push(`// ${tag}  ${ENGINE_LABELS[layer.engine]}\n${source}`);
  }
  blocks.push(`// FFT\nsubBass uSubBass\npunch uPunch\nmids uMids\ntreble uTreble`);
  return model(ids.join('|'), 'compact formula', blocks.join('\n\n'), values);
}
