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
uniform float uMask0;
uniform float uMask1;
uniform float uMask2;
uniform float uFx0;
uniform float uFx1;
uniform float uFx2;
uniform float uFxAmt0;
uniform float uFxAmt1;
uniform float uFxAmt2;

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

vec4 logoFrame(vec4 s, float mask) {
  if (mask < 0.5) return s;
  return vec4(s.rgb, s.a * smoothstep(0.02, 0.12, max(s.r, max(s.g, s.b))));
}

vec3 hueShift(vec3 c, float a) {
  vec3 k = vec3(0.57735);
  float cs = cos(a);
  float sn = sin(a);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}

vec2 effectUv(vec2 p, float fx, float amt) {
  if (amt < 0.001) return p;
  int id = int(fx + 0.5);
  if (id == 1) {
    float slice = floor(p.y * 18.0);
    float n = fract(sin(slice * 91.73) * 43758.5453);
    p.x += (n - 0.5) * amt * 0.35;
  } else if (id == 3) {
    float cells = mix(160.0, 6.0, amt);
    p = floor(p * cells) / cells;
  }
  return p;
}

vec4 effectColor(vec4 s, float fx, float amt) {
  if (amt < 0.001) return s;
  int id = int(fx + 0.5);
  if (id == 2) return vec4(hueShift(s.rgb, amt * 6.2831853), s.a);
  if (id == 4) return vec4(mix(s.rgb, vec3(1.0), amt), s.a);
  return s;
}

vec4 treated(vec2 p, sampler2D tex, float mask, float fx, float amt) {
  vec2 q = effectUv(p, fx, amt);
  return effectColor(logoFrame(frameOf(q, texture2D(tex, clamp(q, 0.0, 1.0))), mask), fx, amt);
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
    c = applySting(c, treated(p, uSting0, uMask0, uFx0, uFxAmt0), uMix0, uMode0);
  }
  if (uMix1 > 0.001) {
    vec2 p = placed(vUv, uPlace1, uVid1);
    c = applySting(c, treated(p, uSting1, uMask1, uFx1, uFxAmt1), uMix1, uMode1);
  }
  if (uMix2 > 0.001) {
    vec2 p = placed(vUv, uPlace2, uVid2);
    c = applySting(c, treated(p, uSting2, uMask2, uFx2, uFxAmt2), uMix2, uMode2);
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
