// PIXEL ART / DITHER MODE
// Downsample to a pixel grid, wobble it like PS1 vertex snapping,
// then quantize with a 4x4 ordered (Bayer) dither into a retro palette.

const float BAYER[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0
);

const vec3 GAMEBOY[4] = vec3[4](
  vec3(0.059, 0.220, 0.059), vec3(0.188, 0.384, 0.188),
  vec3(0.545, 0.675, 0.059), vec3(0.608, 0.737, 0.059)
);

const vec3 CGA[4] = vec3[4](
  vec3(0.0), vec3(0.333, 1.0, 1.0), vec3(1.0, 0.333, 1.0), vec3(1.0)
);

const vec3 WIN95[16] = vec3[16](
  vec3(0.0),               vec3(0.5, 0.0, 0.0),   vec3(0.0, 0.5, 0.0),   vec3(0.5, 0.5, 0.0),
  vec3(0.0, 0.0, 0.5),     vec3(0.5, 0.0, 0.5),   vec3(0.0, 0.5, 0.5),   vec3(0.75),
  vec3(0.5),               vec3(1.0, 0.0, 0.0),   vec3(0.0, 1.0, 0.0),   vec3(1.0, 1.0, 0.0),
  vec3(0.0, 0.0, 1.0),     vec3(1.0, 0.0, 1.0),   vec3(0.0, 1.0, 1.0),   vec3(1.0)
);

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  return (BAYER[i.x + i.y * 4] + 0.5) / 16.0 - 0.5;
}

vec3 nearestCGA(vec3 c) {
  vec3 best = CGA[0];
  float bd = 1e9;
  for (int i = 0; i < 4; i++) {
    vec3 d = c - CGA[i];
    float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = CGA[i]; }
  }
  return best;
}

vec3 nearestWin95(vec3 c) {
  vec3 best = WIN95[0];
  float bd = 1e9;
  for (int i = 0; i < 16; i++) {
    vec3 d = c - WIN95[i];
    float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = WIN95[i]; }
  }
  return best;
}

void main() {
  vec2 frag = vUv * uResolution;

  // Pixel size pulses with the bass and jumps on beats.
  float ps = floor(max(1.0, uPixelSize * (1.0 + uReactivity * uBass * 0.75) + uKick * uReactivity * 4.0));
  vec2 cell = floor(frag / ps);

  // Glitch: shift whole rows of cells.
  float rowTick = floor(uTime * 10.0);
  float rowHit = step(1.0 - uGlitch * 0.3, hash12(vec2(cell.y, rowTick)));
  cell.x += floor((hash12(vec2(cell.y, rowTick + 3.0)) - 0.5) * 16.0 * uGlitch) * rowHit;

  // PS1-style wobble: sample position snaps around like unstable vertices.
  float wob = uJitter * (0.4 + uMid * uReactivity);
  vec2 jit = vec2(sin(cell.y * 0.7 + uTime * 3.0), cos(cell.x * 0.5 + uTime * 2.3)) * wob * ps * 0.6;
  vec2 sampleUv = ((cell + 0.5) * ps + floor(jit)) / uResolution;

  vec3 c = src(sampleUv);
  c = clamp((c - 0.5) * 1.15 + 0.5, 0.0, 1.0);   // punchier contrast

  float d = bayer4(cell) * uDither;
  int pal = int(uPalette + 0.5);

  if (pal == 0) {
    // PS1: 15-bit colour (32 levels/channel) with ordered dither.
    float lv = max(uColorDepth, 2.0) - 1.0;
    c = floor(c * lv + 0.5 + d) / lv;
  } else if (pal == 1) {
    float l = clamp(luma(c) + d * 0.33, 0.0, 0.999);
    c = GAMEBOY[int(l * 4.0)];
  } else if (pal == 2) {
    c = nearestCGA(c + d * 0.5);
  } else if (pal == 3) {
    c = nearestWin95(c + d * 0.4);
  } else {
    c = vec3(step(0.5, luma(c) + d * 0.9));
  }

  // Faint pixel grid on chunky pixels.
  vec2 f = fract(frag / ps);
  float grid = step(4.0, ps) * (1.0 - step(1.0 / ps, min(f.x, f.y)));
  c *= 1.0 - grid * 0.18;

  gl_FragColor = vec4(c, 1.0);
}
