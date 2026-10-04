// CODE OVERLAY
// Rebuilds the finished frame out of glyphs. Brightness decides how much ink
// a cell carries. The character itself comes from a density ramp, from the
// shader that is currently running, or from that shader indexed by the
// pixel's own colour. Cells can spread apart and float on a tilted plane.

uniform sampler2D uFx;
uniform float uBlendMode;
uniform float uMix;
uniform float uOpacity;
uniform sampler2D uGlyph;
uniform sampler2D uSource;
uniform vec2 uGlyphGrid;
uniform vec2 uSourceRes;
uniform float uSourceLen;
uniform float uCodeSize;
uniform float uCodeSpread;
uniform float uCodeFloat;
uniform float uCodeTilt;
uniform float uCodeSource;
uniform float uCodeColor;
uniform float uCodeInk;

float rampChar(float lum) {
  float x = clamp(pow(lum, 0.55), 0.0, 0.999) * 10.0;
  if (x < 1.0) return 32.0;  // space
  if (x < 2.0) return 46.0;  // .
  if (x < 3.0) return 58.0;  // :
  if (x < 4.0) return 45.0;  // -
  if (x < 5.0) return 61.0;  // =
  if (x < 6.0) return 43.0;  // +
  if (x < 7.0) return 42.0;  // *
  if (x < 8.0) return 35.0;  // #
  if (x < 9.0) return 37.0;  // %
  return 87.0;               // W
}

vec3 composite(vec2 uv) {
  vec3 dry = src(uv);
  vec3 fx = texture2D(uFx, clamp(uv, 0.0, 1.0)).rgb;
  vec3 blended = fx;
  int m = int(uBlendMode + 0.5);
  if (m == 1) blended = min(dry + fx, 1.0);
  else if (m == 2) blended = 1.0 - (1.0 - dry) * (1.0 - fx);
  else if (m == 3) blended = dry * fx;
  else if (m == 4) blended = abs(dry - fx);
  else if (m == 5) blended = mix(2.0 * dry * fx, 1.0 - 2.0 * (1.0 - dry) * (1.0 - fx), step(0.5, dry));
  return clamp(mix(dry, blended, uMix), 0.0, 1.0) * uOpacity;
}

float sourceChar(float index) {
  float len = max(uSourceLen, 1.0);
  float i = mod(floor(index), len);
  vec2 uv = (vec2(mod(i, uSourceRes.x), floor(i / uSourceRes.x)) + 0.5) / uSourceRes;
  return floor(texture2D(uSource, uv).r * 255.0 + 0.5);
}

// Screen UV -> UV on a plane that yaws and pitches. Stays inside the frame;
// the corners pinch instead of falling off into empty space.
vec2 planeUV(vec2 uv) {
  vec2 p = uv - 0.5;
  float yaw = sin(uTime * 0.21) * uCodeTilt;
  float pitch = cos(uTime * 0.17) * uCodeTilt * 0.7;
  p.x += p.y * yaw * 0.55;
  p.y += p.x * pitch * 0.28;
  float z = 1.0 + p.y * pitch;
  p.x /= max(z, 0.45);
  p *= mix(1.0, 0.82, uCodeTilt);
  return p + 0.5;
}

void main() {
  vec2 plane = clamp(planeUV(vUv), 0.0, 1.0);
  vec3 picture = composite(vUv);

  float pulse = 1.0 + uBass * uReactivity * 0.3 + uBeat * uReactivity * 0.45;
  float cellPx = max(6.0, uCodeSize * pulse);
  float gap = 1.0 + uCodeSpread * 2.4;
  vec2 pitchV = vec2(cellPx * gap);

  vec2 frag = vUv * uResolution;
  vec2 cell = floor(frag / pitchV);
  vec2 center = clamp((cell + 0.5) * pitchV / uResolution, 0.0, 1.0);
  float lum0 = luma(composite(clamp(plane + (center - vUv), 0.0, 1.0)).rgb);
  float bob = 0.5 + 0.5 * sin(uTime * 0.9 + cell.x * 0.37 + cell.y * 0.21);
  float depth = lum0 * uCodeFloat * (0.55 + 0.45 * bob + uBeat * uReactivity * 0.35);

  // Brighter cells drift toward the camera: out from center, and upward.
  vec2 shift = (center - 0.5) * depth * uResolution * 0.16;
  shift.y += depth * cellPx * 1.1;
  frag -= shift;
  cell = floor(frag / pitchV);
  vec2 local = fract(frag / pitchV);
  center = clamp(plane + ((cell + 0.5) * pitchV / uResolution - vUv), 0.0, 1.0);

  vec2 scatter = (vec2(hash12(cell + 3.1), hash12(cell + 8.7)) - 0.5) * uCodeSpread * 0.85;
  local -= scatter;

  vec3 pix = composite(center);
  float lum = luma(pix);
  vec2 texel = 2.0 / uResolution;
  float edge = length(vec2(
    luma(composite(clamp(center + vec2(texel.x, 0.0), 0.0, 1.0))) - lum,
    luma(composite(clamp(center + vec2(0.0, texel.y), 0.0, 1.0))) - lum
  ));

  float cols = max(floor(uResolution.x / pitchV.x), 1.0);
  float page = cell.x + cell.y * cols;
  float scroll = floor(uTime * (10.0 + uTreble * uReactivity * 36.0));
  float ch;
  if (uCodeSource < 0.5) {
    ch = rampChar(max(lum, edge));
  } else if (uCodeSource < 1.5) {
    ch = sourceChar(page + scroll);
  } else {
    // The pixel's own colour and edges pick which part of the live source is printed.
    float steer = lum * 36.0 + pix.r * 110.0 + pix.g * 64.0 + pix.b * 28.0 + edge * 48.0;
    ch = sourceChar(steer * 4.0 + scroll + page * 0.25);
  }
  if (ch < 32.0 || ch > 126.0) ch = 32.0;

  float gScale = mix(0.98, 0.4, uCodeSpread) / (1.0 + depth * 0.55);
  vec2 g = (local - 0.5) / gScale + 0.5;
  float glyph = 0.0;
  if (g.x > 0.02 && g.y > 0.02 && g.x < 0.98 && g.y < 0.98 && ch > 32.5) {
    float idx = ch - 32.0;
    vec2 slot = vec2(mod(idx, uGlyphGrid.x), floor(idx / uGlyphGrid.x));
    vec2 atlasG = mix(vec2(0.14), vec2(0.86), clamp(g, 0.0, 1.0));
    vec2 uv = (slot + vec2(atlasG.x, 1.0 - atlasG.y)) / uGlyphGrid;
    glyph = smoothstep(0.2, 0.55, texture2D(uGlyph, uv).r);
  }

  int cm = int(uCodeColor + 0.5);
  vec3 tint = pix;
  if (cm == 1) tint = vec3(0.45, 1.0, 0.62);
  else if (cm == 2) tint = vec3(1.0, 0.64, 0.22);
  else if (cm == 3) tint = vec3(0.25 + uBass * 0.9, 0.3 + uMid * 0.8, 0.45 + uTreble);
  else if (cm == 4) tint = mix(vec3(0.15, 0.28, 0.95), vec3(1.0, 0.86, 0.4), clamp(lum, 0.0, 1.0));
  tint *= 0.35 + 0.8 * lum;

  vec3 text = tint * glyph;
  vec3 col = mix(picture, picture * (1.0 - glyph) * (1.0 - uCodeInk) + text, uCodeInk);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
