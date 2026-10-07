// Homepage
// A repeating wallpaper, and one video copy in a beveled frame.

uniform float uHomeTile;
uniform float uHomeMix;
uniform float uHomeBevel;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float tile = clamp(uHomeTile, 0.0, 1.0);
  float cell = mix(0.16, 0.72, tile);
  cell = min(1.25, cell * (1.0 + kick * 1.35));
  vec3 wall = src(fract(vUv / max(cell, 0.05)));

  vec2 margin = vec2(0.18, 0.15);
  vec2 q = abs(vUv - 0.5) - (vec2(0.5) - margin);
  float sd = max(q.x, q.y);
  float inside = step(sd, 0.0);
  vec2 photoUv = (vUv - margin) / max(vec2(1.0) - 2.0 * margin, vec2(0.001));
  vec3 photo = src(clamp(photoUv, 0.0, 1.0));

  float band = mix(0.012, 0.042, clamp(uHomeBevel, 0.0, 1.0));
  float onFrame = step(0.0, sd) * step(sd, band);
  float shade = clamp(0.38 + (vUv.y - vUv.x) * 0.9, 0.2, 0.86);
  vec3 frame = vec3(shade);

  vec3 page = mix(wall, frame, onFrame);
  page = mix(page, photo, inside);
  float show = clamp(uHomeMix, 0.0, 1.0);
  gl_FragColor = vec4(mix(wall, page, show), 1.0);
}
