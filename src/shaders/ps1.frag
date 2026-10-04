// PS1 / N64 CRT
// The picture is sampled on a 320x240 grid. Each 16-texel polygon shears its
// UVs (affine, no perspective) and the vertices snap by whole texels.
// The glass is a curved CRT: barrel distortion, scanlines, and an RGB phosphor mask.

uniform float uPsAffine;
uniform float uPsWobble;
uniform float uPsCrt;

vec2 barrel(vec2 uv, float k) {
  vec2 p = uv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  p.x *= aspect;
  p *= 1.0 + k * dot(p, p);
  p.x /= aspect;
  return p * 0.5 + 0.5;
}

// 320x240 sample with per-polygon affine shear and integer vertex snap.
vec2 consoleUV(vec2 uv) {
  vec2 low = vec2(320.0, 240.0);
  vec2 grid = uv * low;
  float tick = floor(uTime * 9.0);
  vec2 poly = floor(grid / 16.0);
  float hit = clamp((uBass + uKick) * uReactivity, 0.0, 1.5);

  vec2 snap = floor((vec2(
    hash12(poly + tick),
    hash12(poly.yx + tick + 3.0)
  ) - 0.5) * uPsWobble * (2.0 + hit * 3.0));
  grid += snap;

  vec2 local = fract(grid / 16.0);
  float shear = (hash12(poly + floor(uTime * 0.5)) - 0.5) * uPsAffine * (0.55 + hit * 0.4);
  local.x += (local.y - 0.5) * shear;
  local.y += (local.x - 0.5) * shear * 0.45;
  local = clamp(local, 0.0, 0.999);
  vec2 texel = floor(poly * 16.0 + local * 16.0);
  return (texel + 0.5) / low;
}

void main() {
  float crt = uPsCrt;
  float curve = crt * 0.22;

  // --- barrel, then the 320x240 affine sample ------------------------------
  vec2 uvG = barrel(vUv, curve);
  vec2 uvR = barrel(vUv, curve + 0.012 * crt);
  vec2 uvB = barrel(vUv, curve - 0.012 * crt);
  vec2 inside = step(vec2(0.0), uvG) * step(uvG, vec2(1.0));
  vec3 col = vec3(
    src(consoleUV(clamp(uvR, 0.0, 1.0))).r,
    src(consoleUV(clamp(uvG, 0.0, 1.0))).g,
    src(consoleUV(clamp(uvB, 0.0, 1.0))).b
  );
  col *= inside.x * inside.y;

  // --- scanlines locked to the 240-line framebuffer ------------------------
  float line = sin(gl_FragCoord.y * PI * 240.0 / max(uResolution.y, 1.0));
  float scan = mix(1.0, 0.62 + 0.38 * (0.5 + 0.5 * line), crt);

  // --- RGB phosphor triad ---------------------------------------------------
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 phosphor = vec3(0.22);
  phosphor = mix(phosphor, vec3(1.0, 0.18, 0.18), step(m, 0.5));
  phosphor = mix(phosphor, vec3(0.18, 1.0, 0.22), step(0.5, m) * step(m, 1.5));
  phosphor = mix(phosphor, vec3(0.25, 0.35, 1.0), step(1.5, m));
  phosphor = mix(vec3(1.0), phosphor, crt * 0.7);

  // --- vignette from the curved glass --------------------------------------
  vec2 vg = vUv * 2.0 - 1.0;
  float vig = smoothstep(1.25, 0.35, dot(vg, vg));
  vig = mix(1.0, vig, crt);

  col *= scan * phosphor * vig;
  gl_FragColor = vec4(col, 1.0);
}
