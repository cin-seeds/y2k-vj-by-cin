// Data Bend
// The top stays put. Each row slides farther sideways as it goes down.

uniform float uBendAmt;
uniform float uBendCurve;
uniform float uBendLean;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float amt = clamp(uBendAmt, 0.0, 1.0);
  float fromTop = 1.0 - vUv.y;
  float slide = pow(fromTop, mix(1.0, 2.6, clamp(uBendCurve, 0.0, 1.0)));
  float shove = amt * (1.0 + kick);
  float dir = mix(-1.0, 1.0, clamp(uBendLean, 0.0, 1.0));
  vec2 uv = vUv;
  uv.x += slide * shove * dir * 0.42;
  gl_FragColor = vec4(src(uv), 1.0);
}
