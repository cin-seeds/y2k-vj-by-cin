// Mixes the previous composite (uHold) into the new stack (uCurrent) while a
// scene transition is running. Style 0 = alpha, 1 = additive bleed, 2 = wipe.

varying vec2 vUv;

uniform sampler2D uCurrent;
uniform sampler2D uHold;
uniform float uXfade;
uniform float uStyle;
uniform float uTime;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 a = texture2D(uHold, vUv).rgb;
  vec3 b = texture2D(uCurrent, vUv).rgb;
  float k = clamp(uXfade, 0.0, 1.0);
  int style = int(uStyle + 0.5);
  vec3 c;

  if (style == 1) {
    // Additive bleed: the incoming scene piles on top of the outgoing one.
    c = a * (1.0 - k * 0.85) + b * k;
  } else if (style == 2) {
    float n = hash12(vec2(floor(vUv.y * 90.0), floor(uTime * 18.0)));
    float edge = k + (n - 0.5) * 0.12;
    float wipe = step(vUv.x, edge);
    float band = smoothstep(0.07, 0.0, abs(vUv.x - edge));
    vec2 split = vec2(0.012 * band, 0.0);
    vec3 tear;
    tear.r = texture2D(uCurrent, vUv + split).r;
    tear.g = b.g;
    tear.b = texture2D(uHold, vUv - split).b;
    c = mix(a, b, wipe);
    c = mix(c, tear, band);
  } else {
    c = mix(a, b, k);
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
