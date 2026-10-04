varying vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMix;

void main() {
  vec3 a = texture2D(uA, vUv).rgb;
  vec3 b = texture2D(uB, vUv).rgb;
  gl_FragColor = vec4(mix(a, b, clamp(uMix, 0.0, 1.0)), 1.0);
}
