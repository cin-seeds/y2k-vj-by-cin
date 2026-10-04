// FLASH MX
// Early-2000s web graphic. The clip sits inside a morphing blob with flat
// color and a thick outline. The blob tweens slowly and nudges on the kick.

uniform float uBlob;
uniform float uOutline;
uniform float uFlatColor;
uniform float uTween;

void main() {
  vec2 p = vUv - 0.5;
  p.x *= uResolution.x / max(uResolution.y, 1.0);
  float kick = uKick * uReactivity;
  p -= vec2(sin(uTime * 0.7), cos(uTime * 0.53)) * kick * 0.06;

  float theta = atan(p.y, p.x);
  float spin = uTime * (0.18 + uTween * 0.7);
  float r = 0.12 + uBlob * 0.34;
  r += sin(theta * 3.0 + spin) * (0.02 + 0.07 * uTween);
  r += sin(theta * 5.0 - spin * 1.4) * 0.045 * uTween;
  float d = length(p) - r;

  float edge = 0.008 + uOutline * 0.045;
  float mask = 1.0 - smoothstep(-0.004, 0.008, d);
  float stroke = (1.0 - smoothstep(0.0, edge, abs(d))) * step(0.001, uOutline);

  vec3 pic = src(vUv);
  float levels = mix(18.0, 3.0, clamp(uFlatColor, 0.0, 1.0));
  pic = floor(pic * levels + 0.5) / levels;
  vec3 paper = vec3(0.93, 0.95, 0.97);
  vec3 col = mix(paper, pic, mask);
  col = mix(col, vec3(0.04, 0.02, 0.1), stroke);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
