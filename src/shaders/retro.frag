// 90s RETRO GAMING
// Low-res snap, affine (perspective-incorrect) warp, treble-triggered vertex wobble,
// then 8x8 Bayer dither into 16-bit color (5 bits per channel).

uniform float uSnapSize;
uniform float uRetroDither;
uniform float uAffine;
uniform float uWobble;

const float BAYER8[64] = float[64](
   0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
   3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

float bayer8(vec2 p) {
  ivec2 i = ivec2(mod(p, 8.0));
  return (BAYER8[i.x + i.y * 8] + 0.5) / 64.0 - 0.5;
}

void main() {
  float hit = clamp((uTreble + uTransient * 1.5) * uReactivity, 0.0, 2.0);
  float px = max(uSnapSize, 1.0);
  vec2 frag = vUv * uResolution;

  // Unstable vertices: low-res blocks jump on treble transients.
  vec2 block = floor(frag / (px * 8.0));
  float tick = floor(uTime * 10.0);
  vec2 jit = vec2(hash12(block + tick), hash12(block.yx + tick + 4.0)) - 0.5;
  frag += jit * uWobble * (0.3 + hit) * px * 6.0;

  // Snap to the pixel grid before the warp, the way a low-res framebuffer does.
  vec2 cell = floor(frag / px);

  // Affine warp: each 8x8 "polygon" shears its UVs with no perspective divide.
  vec2 poly = floor(cell / 8.0);
  vec2 pf = fract(cell / 8.0);
  float shear = (hash12(poly + floor(uTime * 0.5)) - 0.5) * uAffine * (0.35 + hit);
  pf.x += (pf.y - 0.5) * shear;
  pf.x += (pf.x - 0.5) * pf.y * uAffine * 0.55;
  pf = clamp(pf, 0.0, 0.999);
  vec2 uv = (poly * 8.0 + pf * 8.0 + 0.5) * px / uResolution;

  vec3 c = src(uv);

  // 16-bit posterize (32 levels/channel) with an 8x8 ordered dither.
  float d = bayer8(cell) * uRetroDither;
  c = floor(clamp(c, 0.0, 1.0) * 31.0 + 0.5 + d) / 31.0;

  // Quantized edge between blocks, like unfiltered output.
  vec2 f = fract(frag / px);
  float grid = (1.0 - step(1.5 / px, min(f.x, f.y))) * step(3.0, px);
  c *= 1.0 - grid * 0.12;

  gl_FragColor = vec4(c, 1.0);
}
