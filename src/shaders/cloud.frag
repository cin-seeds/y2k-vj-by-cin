// Digital Clouds
// Bright parts of the picture clot into chunky puffs. Gaps stay the picture.

uniform float uCloudCover;
uniform float uCloudDrift;
uniform float uCloudBand;

void main() {
  vec3 picture = src(vUv);
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float bass = clamp(uBass * uReactivity, 0.0, 1.0);
  float cover = clamp(uCloudCover + bass * 0.42, 0.0, 1.0);
  float band = clamp(uCloudBand, 0.0, 1.0);
  float steps = mix(3.0, 7.0, band);
  float speed = clamp(uCloudDrift, 0.0, 1.0);
  float drift = uTime * mix(0.012, 0.11, speed) + kick * 0.26;

  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vUv * vec2(aspect, 1.0);
  float cells = mix(8.0, 18.0, band);
  vec2 chunk = floor(p * cells) / cells;
  vec2 wind = chunk + vec2(drift, drift * 0.38);

  float n = fbm(wind * 1.7);
  float n2 = fbm(wind * 3.3 + 6.2);
  float field = floor((n * 0.68 + n2 * 0.32) * steps) / steps;

  vec2 shove = vec2(n - 0.5, n2 - 0.5) * (0.035 + kick * 0.07);
  vec3 puffPix = src(vUv + shove);
  float lum = luma(puffPix);

  float brightGate = mix(0.9, 0.2, cover);
  float shapeGate = mix(0.82, 0.3, cover);
  float puff = step(brightGate, lum) * step(shapeGate, field);
  puff *= step(0.02, cover);

  vec3 cloud = floor(puffPix * steps + 0.001) / steps;
  cloud *= 0.78 + 0.4 * field;
  gl_FragColor = vec4(mix(picture, cloud, puff), 1.0);
}
