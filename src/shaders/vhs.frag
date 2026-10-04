// VHS ANALOG
// Tracking snow, horizontal tape wiggle, NTSC chroma bleed, CRT scanlines.
// Tracking and jitter open up on high-treble hits (uTreble + uTransient).

uniform float uTracking;
uniform float uTapeJitter;
uniform float uSmear;
uniform float uScanlines;

void main() {
  vec2 uv = vUv;
  float t = uTime;
  float hit = clamp((uTreble + uTransient * 1.7) * uReactivity, 0.0, 1.6);
  float track = uTracking * (0.18 + hit);
  float wiggle = uTapeJitter * (0.22 + hit);

  // Tape wiggle: a slow bend plus per-scanline horizontal jitter.
  uv.x += sin(uv.y * 28.0 + t * 6.0) * 0.006 * wiggle;
  float line = floor(uv.y * uResolution.y * 0.5);
  uv.x += (hash12(vec2(line, floor(t * 24.0))) - 0.5) * 0.045 * wiggle;

  // Head-switch tear along the bottom of the frame.
  float head = smoothstep(0.06, 0.0, uv.y);
  uv.x += sin(t * 42.0) * 0.035 * wiggle * head;

  // Tracking band: a rolling strip of snow that kicks downward on transients.
  float bandY = fract(t * 0.17 + hit * 0.35);
  float band = 1.0 - smoothstep(0.0, 0.045 + hit * 0.04, abs(uv.y - bandY));
  float snow = hash12(floor(uv * uResolution) + fract(t) * 100.0);
  uv.x += (snow - 0.5) * 0.12 * track * band;

  vec3 col = src(uv);
  float y = luma(col);

  // NTSC bleed: luma stays put, chroma smears sideways.
  float bleed = (0.0015 + 0.012 * uSmear) * (0.45 + uMid * 0.8);
  vec3 side = src(uv + vec2(bleed, 0.0));
  vec3 side2 = src(uv - vec2(bleed * 0.45, 0.0));
  vec3 chroma = side - vec3(luma(side));
  col = vec3(y) + chroma * (1.15 + uSmear) * 0.85 + (side2 - col) * uSmear * 0.35;

  // Tracking noise mixed in over the band, plus a constant noise floor.
  col = mix(col, vec3(snow * 0.85), band * clamp(track, 0.0, 1.0) * 0.9);
  col += (snow - 0.5) * 0.08 * uTracking;

  // Scanline density: 1 = every pixel, 0 = wide soft gaps.
  float spacing = mix(5.5, 1.35, clamp(uScanlines, 0.0, 1.0));
  col *= 0.72 + 0.28 * sin(uv.y * uResolution.y * PI / spacing);

  // Slight luma crush and chroma shift, the way a worn deck looks.
  col = mix(col, col * vec3(1.05, 0.95, 0.9), 0.35);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
