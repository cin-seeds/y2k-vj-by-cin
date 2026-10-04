// Global one-shot stings. Drawn on top of the finished composition.
// These are not layer-stack blends: Additive, Alpha, and Invert/Key only.

varying vec2 vUv;

uniform sampler2D uBase;
uniform sampler2D uSting0;
uniform sampler2D uSting1;
uniform sampler2D uSting2;
uniform float uMix0;
uniform float uMix1;
uniform float uMix2;
uniform float uMode0;
uniform float uMode1;
uniform float uMode2;
uniform vec3 uPlace0;
uniform vec3 uPlace1;
uniform vec3 uPlace2;
uniform float uAspect;
uniform float uVid0;
uniform float uVid1;
uniform float uVid2;

vec2 placed(vec2 uv, vec3 place, float vidAspect) {
  float va = max(vidAspect, 0.001);
  float ca = max(uAspect, 0.001);
  vec2 size = vec2(min(1.0, va / ca), min(1.0, ca / va)) * max(place.x, 0.001);
  return (uv - 0.5 - place.yz) / size + 0.5;
}

vec4 frameOf(vec2 p, vec4 s) {
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return vec4(0.0);
  return s;
}

vec3 applySting(vec3 base, vec4 s, float amount, float mode) {
  float cover = clamp(s.a, 0.0, 1.0) * amount;
  int m = int(mode + 0.5);
  if (m == 0) return min(base + s.rgb * cover, vec3(1.0));
  if (m == 2) {
    float key = smoothstep(0.04, 0.22, max(max(s.r, s.g), s.b)) * amount;
    return mix(base, 1.0 - base, key);
  }
  return mix(base, s.rgb, cover);
}

void main() {
  vec3 c = texture2D(uBase, vUv).rgb;
  if (uMix0 > 0.001) {
    vec2 p = placed(vUv, uPlace0, uVid0);
    c = applySting(c, frameOf(p, texture2D(uSting0, clamp(p, 0.0, 1.0))), uMix0, uMode0);
  }
  if (uMix1 > 0.001) {
    vec2 p = placed(vUv, uPlace1, uVid1);
    c = applySting(c, frameOf(p, texture2D(uSting1, clamp(p, 0.0, 1.0))), uMix1, uMode1);
  }
  if (uMix2 > 0.001) {
    vec2 p = placed(vUv, uPlace2, uVid2);
    c = applySting(c, frameOf(p, texture2D(uSting2, clamp(p, 0.0, 1.0))), uMix2, uMode2);
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
