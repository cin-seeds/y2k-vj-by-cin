// Fold
// The sample point runs through noise, and that noise through noise again.
// Several reads of this one frame meet in the pixel.

uniform float uFoldDepth;
uniform float uFoldScale;
uniform float uFoldSheets;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float bass = clamp(uBass * uReactivity, 0.0, 1.0);
  float depth = clamp(uFoldDepth + bass * 0.38, 0.0, 1.0);
  float reach = mix(0.0, 0.42, depth);
  float scale = mix(1.5, 8.5, clamp(uFoldScale + kick * 0.4, 0.0, 1.0));

  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vUv * vec2(aspect, 1.0) * scale;
  float n1 = noise(p);
  float n2 = noise(p + n1 * 1.8);
  float n3 = noise(p * 1.4 + vec2(n2, n1) * 1.5 + 2.7);
  vec2 warp = vec2(n2, n3) - 0.5;

  vec3 col = src(vUv + warp * reach);
  float sheets = clamp(uFoldSheets, 0.0, 1.0);
  col = mix(col, src(vUv + vec2(n3 - 0.5, n2 - 0.5) * reach * 0.75), sheets * 0.55);
  col = mix(col, src(vUv + vec2(n1 - 0.5, n2 - n3) * reach * 0.45), sheets * 0.4);
  gl_FragColor = vec4(col, 1.0);
}
