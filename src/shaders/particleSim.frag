// Advect one particle per texel. xy = position in the pixel grid.
// Curl noise drifts them; a kick blows them off their pixel; uSpring pulls them home.

varying vec2 vUv;

uniform sampler2D uState;
uniform sampler2D uTex;
uniform vec2 uUvScale;
uniform float uFit;
uniform float uMirror;
uniform float uHasInput;
uniform float uSeed;
uniform float uTime;
uniform float uNoiseScale;
uniform float uFreq;
uniform float uFlow;
uniform float uBlow;
uniform float uSpring;
uniform float uDt;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec2 curlNoise(vec2 p) {
  float e = 0.18;
  float n1 = noise(p + vec2(0.0, e));
  float n2 = noise(p - vec2(0.0, e));
  float n3 = noise(p + vec2(e, 0.0));
  float n4 = noise(p - vec2(e, 0.0));
  return vec2(n1 - n2, n4 - n3);
}

vec2 mapUV(vec2 uv) {
  uv = (uv - 0.5) * uUvScale + 0.5;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  return uv;
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

float fieldLuma(vec2 uv) {
  if (uHasInput > 0.5) return luma(texture2D(uTex, clamp(mapUV(uv), 0.0, 1.0)).rgb);
  return 0.5 + 0.5 * sin(uv.x * 18.0 + uTime) * cos(uv.y * 14.0 - uTime * 0.7);
}

void main() {
  vec2 home = vUv;
  if (uSeed > 0.5) {
    gl_FragColor = vec4(home, 0.0, 1.0);
    return;
  }

  vec4 st = texture2D(uState, home);
  vec2 pos = st.a > 0.5 ? st.xy : home;

  vec2 field = curlNoise(pos * uNoiseScale + uTime * uFreq);
  float l0 = fieldLuma(pos);
  float lx = fieldLuma(pos + vec2(0.004, 0.0));
  float ly = fieldLuma(pos + vec2(0.0, 0.004));
  vec2 grad = vec2(lx - l0, ly - l0);

  vec2 vel = field * (2.4 * uFlow) + grad * 0.8;
  pos += vel * uDt;
  pos += (pos - 0.5) * uBlow;
  pos = mix(pos, home, clamp(uSpring, 0.0, 1.0));
  gl_FragColor = vec4(pos, fieldLuma(home), 1.0);
}
