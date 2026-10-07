// Ink
// The previous frame is stirred along a curl of the picture's brightness,
// then a little of the live picture is mixed back in.

uniform float uInkLife;
uniform float uInkStir;
uniform float uInkCurl;

void main() {
  vec3 live = src(vUv);
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float stir = clamp(uInkStir + kick * 0.55, 0.0, 1.0);
  float reach = mix(0.0, 0.014, stir);

  float e = 2.0 / max(uResolution.y, 1.0);
  float c = luma(live);
  float cx = luma(src(vUv + vec2(e, 0.0)));
  float cy = luma(src(vUv + vec2(0.0, e)));
  vec2 curl = vec2(cy - c, c - cx);

  float scale = mix(3.0, 12.0, clamp(uInkCurl, 0.0, 1.0));
  float n1 = noise(vUv * scale + uTime * 0.05);
  float n2 = noise(vUv * scale * 1.8 + 5.0 - uTime * 0.04);
  curl += (vec2(n1, n2) - 0.5) * 0.06;

  vec2 uv = clamp(vUv - curl * reach, 0.0, 1.0);
  vec3 prev = texture2D(uPrev, uv).rgb;
  float keep = mix(0.0, 0.965, clamp(uInkLife, 0.0, 1.0));
  gl_FragColor = vec4(mix(live, prev, keep), 1.0);
}
