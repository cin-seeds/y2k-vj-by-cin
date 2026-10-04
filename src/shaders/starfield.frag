// STARFIELD
// Cheap 90s space: stars streak outward, the live picture sits in a circular
// porthole, and a single-color floor grid fades underneath. No planets.

uniform float uWarp;
uniform float uPorthole;
uniform float uGrid;
uniform float uFlash;

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 c = vUv - 0.5;
  c.x *= aspect;
  float speed = uWarp * (0.45 + uBass * uReactivity * 1.35) + uKick * uReactivity * 0.35;
  float trail = 0.02 + speed * 0.16;
  vec3 sky = vec3(0.0);

  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    float ang = hash11(fi + 1.7) * TAU;
    float spread = 0.04 + hash11(fi + 4.0) * 0.9;
    float z = fract(hash11(fi * 3.1) - uTime * max(speed, 0.02) * (0.35 + hash11(fi + 8.0)));
    float zFar = fract(z + trail);
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 a = dir * spread / (0.08 + z);
    vec2 b = dir * spread / (0.08 + zFar);
    vec2 pa = c - b;
    vec2 ba = a - b;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    float dist = length(pa - ba * h);
    float star = smoothstep(0.0035, 0.0, dist) * (1.0 - z);
    sky += vec3(star);
  }

  sky += sky * uKick * uFlash * uReactivity * 2.4;

  vec2 gp = vec2(c.x, vUv.y - 0.08);
  if (gp.y < 0.0 && uGrid > 0.001) {
    float py = max(-gp.y, 0.02);
    vec2 gnd = vec2(gp.x / py, 0.35 / py + uTime * (0.15 + speed));
    vec2 cell = abs(fract(gnd * vec2(7.0, 3.0)) - 0.5);
    float line = 1.0 - smoothstep(0.0, 0.035, min(cell.x, cell.y));
    float fade = smoothstep(0.02, 0.42, py) * uGrid * 0.4;
    sky += vec3(0.2, 0.9, 0.55) * line * fade;
  }

  float rad = length(c);
  float hole = 0.05 + uPorthole * 0.32;
  float inside = 1.0 - smoothstep(hole - 0.008, hole, rad);
  float rim = (1.0 - smoothstep(0.0, 0.012, abs(rad - hole))) * step(0.02, uPorthole);
  vec3 pic = src(vUv);
  vec3 col = mix(sky, pic, inside);
  col = mix(col, vec3(0.75, 0.9, 1.0), rim * (1.0 - inside));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
