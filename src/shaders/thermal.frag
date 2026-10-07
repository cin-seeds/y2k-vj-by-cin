// False-Color Thermal
// A grade of the layer video. Luminance maps through a thermal palette.

uniform float uHeat;

vec3 thermal(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.02, 0.00, 0.06), vec3(0.05, 0.06, 0.55), smoothstep(0.00, 0.18, t));
  c = mix(c, vec3(0.55, 0.00, 0.62), smoothstep(0.18, 0.38, t));
  c = mix(c, vec3(0.92, 0.08, 0.05), smoothstep(0.38, 0.58, t));
  c = mix(c, vec3(1.00, 0.72, 0.05), smoothstep(0.58, 0.78, t));
  c = mix(c, vec3(1.00, 0.98, 0.92), smoothstep(0.78, 1.00, t));
  return c;
}

void main() {
  float lum = luma(src(vUv));
  float gain = max(uHeat, 0.0);
  lum = (lum - 0.5) * gain + 0.5;

  // Kick, bass, and snare/hat routes already live on these uniforms.
  float r = uReactivity;
  lum += uKick * r * 0.16;
  lum += uBass * r * 0.05;
  lum += uTransient * r * 0.07;
  lum += uTreble * uTransient * r * 0.04;
  lum = clamp(lum, 0.0, 1.0);

  gl_FragColor = vec4(thermal(lum), 1.0);
}
