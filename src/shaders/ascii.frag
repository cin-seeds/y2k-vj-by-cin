// ASCII / POINTILLISM
// The frame is cut into cells. Luminance picks a glyph from a 10-step ramp,
// or the size of a jittered paint blob. Color is quantized per cell.

uniform float uAsciiSize;
uniform float uAsciiQuant;
uniform float uAsciiStyle;

// 10 glyphs, 7 rows, 5 bits each (bit 4 is the left pixel). Top row first.
// space . : - = + * # % @
const float GLYPH[70] = float[70](
  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,
  0.0,  0.0,  0.0,  0.0,  0.0,  4.0,  0.0,
  0.0,  4.0,  0.0,  0.0,  4.0,  0.0,  0.0,
  0.0,  0.0,  0.0, 31.0,  0.0,  0.0,  0.0,
  0.0,  0.0, 31.0,  0.0, 31.0,  0.0,  0.0,
  0.0,  4.0,  4.0, 31.0,  4.0,  4.0,  0.0,
  0.0, 21.0, 14.0,  4.0, 14.0, 21.0,  0.0,
 10.0, 10.0, 31.0, 10.0, 31.0, 10.0, 10.0,
 24.0, 25.0,  2.0,  4.0,  8.0, 19.0,  3.0,
 14.0, 17.0, 23.0, 21.0, 23.0, 16.0, 14.0
);

float glyphOn(int ch, int row, float x) {
  float mask = GLYPH[ch * 7 + row];
  float bit = floor(mod(mask / pow(2.0, 4.0 - x), 2.0));
  return step(0.5, bit);
}

vec3 quantize(vec3 c) {
  float n = max(uAsciiQuant, 2.0);
  return floor(clamp(c, 0.0, 1.0) * (n - 0.001)) / (n - 1.0);
}

void main() {
  float size = max(uAsciiSize, 2.0);
  vec2 frag = gl_FragCoord.xy;
  vec2 cell = floor(frag / size);
  vec2 f = fract(frag / size);
  vec2 cellUv = (cell + 0.5) * size / uResolution;
  vec3 sampleCol = quantize(src(cellUv));
  float lum = luma(src(cellUv));
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);

  vec3 col;
  if (uAsciiStyle < 0.5) {
    // --- ASCII terminal: brightness picks the character -------------------
    float boosted = clamp(lum + kick * 0.15, 0.0, 0.999);
    int ch = int(floor(boosted * 10.0));
    vec2 inset = (f - 0.12) / 0.76;
    float inside = step(0.0, inset.x) * step(inset.x, 1.0) * step(0.0, inset.y) * step(inset.y, 1.0);
    float gx = clamp(floor(inset.x * 5.0), 0.0, 4.0);
    int gy = int(clamp(floor((1.0 - inset.y) * 7.0), 0.0, 6.0));
    float on = glyphOn(ch, gy, gx) * inside;
    vec3 paper = vec3(0.015, 0.02, 0.012);
    col = mix(paper, sampleCol, on);
  } else {
    // --- painterly blobs: nearest jittered cell, radius from luminance ----
    float bestD = 8.0;
    vec2 bestId = cell;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 id = cell + vec2(float(i), float(j));
        vec2 jitter = vec2(hash12(id), hash12(id + 17.0)) - 0.5;
        vec2 center = id + 0.5 + jitter * 0.65;
        float d = length(frag / size - center);
        if (d < bestD) {
          bestD = d;
          bestId = id;
        }
      }
    }
    vec2 blobUv = (bestId + 0.5) * size / uResolution;
    vec3 paint = quantize(src(blobUv));
    float blobLum = luma(paint);
    float rad = mix(0.08, 0.85, blobLum) * (1.0 + kick * 0.12);
    float ink = smoothstep(rad, rad * 0.42, bestD);
    col = mix(vec3(0.03, 0.02, 0.025), paint, ink);
  }

  gl_FragColor = vec4(col, 1.0);
}
