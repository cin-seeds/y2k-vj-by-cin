// Nature Blocks
// The picture is rebuilt as flat bricks in a small nature set, with a stud on each.

uniform float uBrickSize;
uniform float uBrickStud;
uniform float uBrickTint;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float size = clamp(uBrickSize + kick * 0.28, 0.0, 1.0);
  float cells = mix(40.0, 6.0, size);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 grid = vec2(cells * aspect, cells);
  vec2 local = fract(vUv * grid);
  vec2 center = (floor(vUv * grid) + 0.5) / grid;
  vec3 pix = src(center);
  float lum = luma(pix);

  vec3 soil = vec3(0.34, 0.20, 0.09);
  vec3 moss = vec3(0.15, 0.28, 0.11);
  vec3 leaf = vec3(0.16, 0.40, 0.13);
  vec3 grass = vec3(0.30, 0.52, 0.16);
  vec3 lime = vec3(0.64, 0.76, 0.22);
  vec3 swatch = soil;
  swatch = mix(swatch, moss, smoothstep(0.10, 0.26, lum));
  swatch = mix(swatch, leaf, smoothstep(0.26, 0.44, lum));
  swatch = mix(swatch, grass, smoothstep(0.44, 0.62, lum));
  swatch = mix(swatch, lime, smoothstep(0.62, 0.84, lum));

  vec3 brick = mix(pix, swatch, clamp(uBrickTint, 0.0, 1.0));
  float topLip = smoothstep(0.84, 1.0, local.y);
  float bottom = smoothstep(0.0, 0.16, local.y);
  brick *= mix(1.0, 1.22, topLip);
  brick *= mix(0.62, 1.0, bottom);
  float seam = step(0.045, local.x) * step(0.05, local.y);
  brick *= mix(0.5, 1.0, seam);

  vec2 stud = local - vec2(0.5, 0.64);
  float onStud = step(max(abs(stud.x), abs(stud.y) * 1.2), 0.15);
  float studTop = smoothstep(0.45, 0.85, local.y);
  vec3 studCol = brick * mix(0.78, 1.16, studTop) + vec3(0.04, 0.05, 0.01);
  brick = mix(brick, studCol, onStud * clamp(uBrickStud, 0.0, 1.0));

  gl_FragColor = vec4(brick, 1.0);
}
