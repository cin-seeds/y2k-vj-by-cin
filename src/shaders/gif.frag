// Interlaced GIF
// A coarse row pass first. Missing rows fill in as the load arrives.

uniform float uGifLoad;
uniform float uGifGap;
uniform float uGifEase;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float arrived = clamp(uGifLoad, 0.0, 1.0);
  arrived = mix(arrived, 1.0, kick);
  float t = pow(arrived, mix(1.0, 2.8, clamp(uGifEase, 0.0, 1.0)));
  float gap = mix(2.0, 16.0, clamp(uGifGap, 0.0, 1.0));
  float stride = max(1.0, floor(mix(gap, 1.0, t) + 0.5));
  float row = floor(vUv.y * uResolution.y);
  float held = floor(row / stride) * stride;
  vec2 uv = vec2(vUv.x, (held + 0.5) / max(uResolution.y, 1.0));
  gl_FragColor = vec4(src(uv), 1.0);
}
