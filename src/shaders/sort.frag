// Pixel Sort
// Bright pixels streak up the frame. A short length falls back to the picture.

uniform float uSortGate;
uniform float uSortLen;
uniform float uSortFall;

void main() {
  vec3 col = src(vUv);
  float len = clamp(uSortLen, 0.0, 1.0);
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float snare = clamp(uTransient * uReactivity, 0.0, 1.0);
  float span = min(0.85, len * 0.28 * (1.0 + kick * 1.6 + snare * 1.1));
  if (span * uResolution.y < 1.5) {
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  float gate = clamp(uSortGate, 0.0, 1.0);
  float fall = clamp(uSortFall, 0.0, 1.0);
  float found = 0.0;
  float carry = 0.0;
  vec3 pulled = col;
  for (int i = 0; i < 32; i++) {
    float along = float(i + 1) / 32.0;
    vec3 below = src(vec2(vUv.x, vUv.y - along * span));
    float hot = step(gate, luma(below));
    float take = hot * (1.0 - found);
    float fade = 1.0 - along;
    fade = mix(fade, fade * fade, fall);
    pulled = mix(pulled, below, take);
    carry = mix(carry, fade, take);
    found = max(found, hot);
  }
  gl_FragColor = vec4(mix(col, pulled, carry * found), 1.0);
}
