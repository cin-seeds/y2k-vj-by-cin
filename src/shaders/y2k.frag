// Y2K / 2000s MODE
// Liquid-chrome warp, iridescent glowing edges, procedural sky clouds,
// zoom-feedback trails, and lens sparkles on the hi-hats.

vec3 iridescent(float t) {
  return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
}

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

float sobel(vec2 uv, vec2 o) {
  float tl = luma(src(uv + vec2(-o.x,  o.y)));
  float tc = luma(src(uv + vec2( 0.0,  o.y)));
  float tr = luma(src(uv + vec2( o.x,  o.y)));
  float ml = luma(src(uv + vec2(-o.x,  0.0)));
  float mr = luma(src(uv + vec2( o.x,  0.0)));
  float bl = luma(src(uv + vec2(-o.x, -o.y)));
  float bc = luma(src(uv + vec2( 0.0, -o.y)));
  float br = luma(src(uv + vec2( o.x, -o.y)));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -bl - 2.0 * bc - br + tl + 2.0 * tc + tr;
  return length(vec2(gx, gy));
}

void main() {
  float t = uTime;
  float r = uReactivity;
  float aspect = uResolution.x / uResolution.y;

  // Liquid chrome warp.
  vec2 uv = vUv + vec2(sin(vUv.y * 12.0 + t * 2.0), cos(vUv.x * 10.0 + t * 1.7))
                  * 0.003 * (1.0 + uMid * r * 3.0);

  // Chromatic fringe driven by glitch intensity.
  vec2 g = vec2(uGlitch * 0.008 * (1.0 + uKick * r * 2.0), 0.0);
  vec3 base = vec3(src(uv + g).r, src(uv).g, src(uv - g).b);
  float lum = luma(base);

  // Glowing edges.
  vec2 o = (1.0 + uTreble * r * 2.0) * 1.5 / uResolution;
  float edge = smoothstep(0.1, 0.6, sobel(uv, o));
  vec3 edgeCol = iridescent(lum * 1.5 + t * 0.1 + uHueShift + uv.y * 0.5);

  float halo = 0.0;
  float rad = 6.0 + uBass * r * 14.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    halo += max(luma(src(uv + vec2(cos(a), sin(a)) * rad / uResolution)) - 0.6, 0.0);
  }
  halo /= 8.0;

  // Procedural clouds.
  vec2 cp = vec2(vUv.x * aspect, vUv.y) * 2.5;
  float cl = fbm(cp + vec2(t * 0.05, t * 0.02) + fbm(cp * 0.7 - t * 0.03));
  cl = smoothstep(0.45, 0.85, cl + uBass * r * 0.08);
  vec3 sky = mix(vec3(0.35, 0.6, 1.0), vec3(0.85, 0.95, 1.0), vUv.y);
  vec3 cloudCol = mix(sky, vec3(1.0), cl);

  float cloudMask = uClouds * (1.0 - smoothstep(0.2, 0.8, lum));
  vec3 col = mix(base, cloudCol, cloudMask * (0.3 + 0.7 * cl)) + cl * uClouds * 0.12;

  // Cool chrome grade.
  col = mix(col, col * vec3(0.85, 0.95, 1.15) + 0.03, 0.6);

  col += edgeCol * edge * uEdgeGlow * (1.0 + uBass * r * 1.5);
  col += edgeCol * halo * uEdgeGlow * 2.0;

  // Zoom feedback trails.
  vec2 fuv = (vUv - 0.5) * (0.985 - uBass * r * 0.012) + 0.5;
  vec3 prev = hueRotate(texture2D(uPrev, fuv).rgb, 0.05 + uHueShift * 0.2);
  col = max(col, prev * uFeedback * 0.92);

  // Sparkles.
  vec2 sg = vUv * uResolution / 40.0;
  vec2 sid = floor(sg);
  vec2 sf = fract(sg) - 0.5;
  float sparkleOn = step(0.985 - uTreble * r * 0.04, hash12(sid + floor(t * 4.0)));
  float star = max(0.0, 1.0 - abs(sf.x * sf.y) * 400.0) * smoothstep(0.5, 0.0, length(sf));
  col += sparkleOn * star * (0.6 + uKick) * vec3(0.9, 0.95, 1.0);

  // Vignette + faint scanlines.
  col *= 1.0 - 0.25 * pow(length(vUv - 0.5) * 1.3, 2.0);
  col *= 0.96 + 0.04 * sin(vUv.y * uResolution.y * PI);

  gl_FragColor = vec4(col, 1.0);
}
