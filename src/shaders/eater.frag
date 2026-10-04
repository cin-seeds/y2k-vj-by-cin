// SIGNAL EATER
// Bass opens holes in the brighter parts. A kick pulls the sample toward a
// slow-moving point. A drop takes a larger bite than the kick. Eaten pixels
// darken and pick up a dull copy of the previous frame. Not a block mosh.

uniform float uBite;
uniform float uChew;
uniform float uThreshold;
uniform float uLeftovers;

void main() {
  vec2 mouth = vec2(
    0.5 + 0.22 * sin(uTime * 0.31),
    0.5 + 0.18 * cos(uTime * 0.23)
  );
  float pull = uChew * (0.25 + uKick * uReactivity * 0.85);
  vec2 uv = vUv + (mouth - vUv) * pull;

  vec3 col = src(uv);
  float bright = smoothstep(uThreshold, uThreshold + 0.22, luma(col));
  float bite = uBite * (0.2 + uBass * uReactivity * 0.9 + uKick * uReactivity * 0.35);
  bite += uBite * uDropPulse * uReactivity * 0.85;
  bite = clamp(bite, 0.0, 1.0);

  vec2 cell = floor(uv * vec2(56.0, 32.0));
  float n = hash12(cell + floor(uTime * (2.0 + uChew * 5.0)));
  float hole = step(1.0 - bite, n) * bright;

  vec3 prev = texture2D(uPrev, clamp(uv, 0.0, 1.0)).rgb * vec3(0.38, 0.34, 0.3);
  vec3 eaten = mix(col * 0.12, prev, clamp(uLeftovers, 0.0, 1.0));
  col = mix(col, eaten, hole);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
