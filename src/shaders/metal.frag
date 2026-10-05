// Black Metallic Y2K
// Dark chrome on the video, a thin iridescent edge, and a glint on the kick.

vec3 iridescent(float t) {
  return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
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

  vec2 g = vec2(uGlitch * 0.007 * (1.0 + uKick * r * 2.0), 0.0);
  vec2 uv = vUv;
  vec3 base = vec3(src(uv + g).r, src(uv).g, src(uv - g).b);
  float lum = luma(base);

  // Dark chrome. The video stays in the shading, crushed toward black metal.
  float shade = smoothstep(0.02, 0.92, lum);
  vec3 metal = mix(vec3(0.015, 0.018, 0.026), vec3(0.62, 0.68, 0.76), pow(shade, 1.35));
  vec3 col = metal * (0.28 + 0.72 * base);
  float sheen = smoothstep(0.42, 0.62, lum) * (1.0 - smoothstep(0.62, 0.84, lum));
  col += sheen * vec3(0.55, 0.62, 0.72) * 0.45;

  // Thin iridescent edge. One texel wide, not a glow.
  vec2 o = 1.15 / uResolution;
  float edge = smoothstep(0.28, 0.48, sobel(uv, o));
  vec3 edgeCol = iridescent(lum * 2.0 + t * 0.12 + uv.y);
  col += edgeCol * edge * (0.55 + uGlitch * 0.65);

  // Kick glint: a narrow specular streak that only opens on the kick.
  float sweep = abs(fract(vUv.x * 0.85 + vUv.y * 0.45 - t * 0.08) - 0.5);
  float glint = smoothstep(0.018, 0.0, sweep) * smoothstep(0.2, 0.75, lum);
  col += glint * uKick * (0.65 + r) * vec3(1.0, 0.97, 0.92);

  // Feedback holds a darkened copy of the last frame.
  vec2 fuv = (vUv - 0.5) * (0.988 - uBass * r * 0.01) + 0.5;
  vec3 prev = texture2D(uPrev, fuv).rgb * vec3(0.72, 0.76, 0.84);
  col = mix(col, max(col, prev), uFeedback * 0.92);

  col *= 1.0 - 0.35 * pow(length(vUv - 0.5) * 1.25, 2.0);
  gl_FragColor = vec4(col, 1.0);
}
