// Recursive video synth. The previous frame is rotated, zoomed, and warped,
// then mixed back under the live source. Small per-frame values compound into a spiral.

uniform float uHydraRot;
uniform float uHydraScale;
uniform float uHydraBleed;
uniform float uHydraWarp;
uniform float uHydraHue;
uniform float uLayerBlend;

vec3 hueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735027);
  float cs = cos(a);
  float sn = sin(a);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}

vec3 blendMode(vec3 base, vec3 top, float mode) {
  int m = int(mode + 0.5);
  if (m == 1) return base * top;
  if (m == 2) return 1.0 - (1.0 - base) * (1.0 - top);
  if (m == 3) return min(base / max(1.0 - top, 1e-3), vec3(1.0));
  if (m == 4) return abs(base - top);
  return top;
}

vec2 mirrorRepeat(vec2 p) {
  return abs(mod(p, 2.0) - 1.0);
}

void main() {
  vec3 live = src(vUv);

  vec2 p = vUv - 0.5;
  float c = cos(uHydraRot);
  float s = sin(uHydraRot);
  p = mat2(c, -s, s, c) * p;
  p /= max(uHydraScale, 0.5);
  p += vec2(sin(p.y * 12.0 + uTime), cos(p.x * 12.0 - uTime)) * uHydraWarp;

  vec2 fuv = mirrorRepeat(p + 0.5);
  vec3 prev = hueShift(texture2D(uPrev, fuv).rgb, uHydraHue);
  float bleed = clamp(uHydraBleed, 0.0, 0.97);
  vec3 trailed = blendMode(live, prev, uLayerBlend);
  vec3 col = mix(live, trailed, bleed);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
