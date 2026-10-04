// Soft circle. Color is the pixel the vertex already sampled.
uniform float uColorMode;
uniform float uSubBass;
uniform float uPunch;

varying vec3 vColor;
varying float vLum;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q);
  float a = smoothstep(0.5, 0.16, r);
  if (a < 0.04) discard;

  vec3 tint = mix(vec3(0.12, 0.55, 1.0), vec3(1.0, 0.2, 0.42), clamp(uPunch, 0.0, 1.0));
  vec3 reactive = mix(vColor, tint * (0.45 + vLum), 0.35 + 0.5 * clamp(uPunch, 0.0, 1.0));
  reactive += tint * uSubBass * 0.45;
  vec3 col = mix(vColor, reactive, step(0.5, uColorMode));
  gl_FragColor = vec4(col, a);
}
