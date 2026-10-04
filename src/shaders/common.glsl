// Shared header prepended to every fragment shader.

varying vec2 vUv;

// Input
uniform sampler2D uTex;
uniform sampler2D uPrev;     // previous effect frame (feedback / datamosh)
uniform vec2  uResolution;
uniform vec2  uTexRes;
uniform vec2  uUvScale;      // screen UV -> texture UV, about the center (fit / fill)
uniform float uFit;          // 1 = letterbox samples outside the texture, 0 = crop
uniform float uHasInput;
uniform float uMirror;
uniform float uTime;
uniform float uEntry;        // 0 at image trigger, 1 when the entry anim finishes
uniform float uEntryStyle;   // 0 cut, 1 linear fade, 2 zoom+dissolve, 3 glitch flash

// Audio (0..1, smoothed)
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uLevel;
uniform float uKick;         // kick flash: 1 on a bass onset, decays to 0. Beat Sync can raise it.
uniform float uSubBass;      // mel sub, 20–80 Hz
uniform float uPunch;        // mel low-mid, 80–500 Hz
uniform float uMids;         // mel high-mid, 500 Hz–2 kHz
uniform float uHigh;         // mel air, 2–20 kHz (same signal as uTreble)
uniform float uBeatPulse;    // spectral-flux onset, attacks fast and releases slowly
uniform float uPeakFlash;    // kick or snare transient
uniform float uSongEnergy;   // 3 s rolling loudness
uniform float uIsBreakdown;  // high while the track is quiet against that average
uniform float uDropPulse;    // 1 when energy surges out of a breakdown, then decays

// Tempo clock (shared by all layers)
uniform float uBeat;         // 1.0 on every quarter note, eases to 0 before the next
uniform float uBeatPhase;    // 0 -> 1 ramp across each beat
uniform float uTransient;    // snare / hat onset, decays quickly

// Parameters
uniform float uReactivity;
uniform float uGlitch;
uniform float uFeedback;
uniform float uPixelSize;
uniform float uPalette;
uniform float uColorDepth;
uniform float uDither;
uniform float uJitter;
uniform float uEdgeGlow;
uniform float uClouds;
uniform float uHueShift;

const float PI = 3.14159265;
const float TAU = 6.28318531;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Screen UV to texture UV. uUvScale < 1 crops (fill); uUvScale > 1 letterboxes (fit).
vec2 mapUV(vec2 uv) {
  uv = (uv - 0.5) * uUvScale + 0.5;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  return uv;
}

vec3 testPattern(vec2 uv) {
  vec2 p = uv * vec2(uResolution.x / uResolution.y, 1.0);
  float t = uTime * 0.2;
  vec3 c = 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.67) + fbm(p * 2.0 + t) + t));
  vec2 g = abs(fract(p * 8.0) - 0.5);
  c *= 0.6 + 0.4 * smoothstep(0.0, 0.05, min(g.x, g.y));
  float r = length((uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0));
  c += smoothstep(0.012, 0.0, abs(r - 0.25 - 0.08 * uBass)) * 0.9;
  return c;
}

// Sample the live input at a screen-space UV, with optional image-entry motion.
vec3 src(vec2 uv) {
  if (uHasInput < 0.5) return testPattern(uv);

  float e = clamp(uEntry, 0.0, 1.0);
  vec2 t = mapUV(uv);
  vec2 edge = step(vec2(0.0), t) * step(t, vec2(1.0));
  vec3 c;

  // Glitch Flash: RGB split and scan hits decay across the entry.
  // Zoom & Dissolve scale lives on the compositor so it isn't applied twice.
  if (uEntryStyle > 2.5 && e < 0.999) {
    float g = 1.0 - e;
    float off = g * (0.01 + 0.04 * hash11(uTime * 17.0));
    vec2 j = vec2(hash11(floor(uTime * 24.0)), hash11(floor(uTime * 19.0) + 3.0)) * 2.0 - 1.0;
    vec2 base = mapUV(uv + j * off * 0.35);
    float r = texture2D(uTex, clamp(base + vec2(off, 0.0), 0.0, 1.0)).r;
    float gc = texture2D(uTex, clamp(t, 0.0, 1.0)).g;
    float b = texture2D(uTex, clamp(base - vec2(off, 0.0), 0.0, 1.0)).b;
    c = vec3(r, gc, b);
    c += vec3(0.85, 0.9, 1.0) * g * g;
    float line = hash11(floor(uv.y * 110.0) + floor(uTime * 30.0));
    c *= 1.0 + g * step(0.62, line);
  } else {
    c = texture2D(uTex, clamp(t, 0.0, 1.0)).rgb;
  }

  return c * mix(1.0, edge.x * edge.y, uFit);
}
