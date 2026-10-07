// Marquee
// One band of the picture crawls sideways and loops. The rest holds.

uniform float uMarqueeBand;
uniform float uMarqueeSize;
uniform float uMarqueeSpeed;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float speed = clamp(uMarqueeSpeed, 0.0, 1.0);
  float crawl = uTime * mix(0.0, 0.45, speed) + kick * 0.22;
  float center = clamp(uMarqueeBand, 0.0, 1.0);
  float halfH = mix(0.0, 0.22, clamp(uMarqueeSize, 0.0, 1.0));
  float inBand = step(abs(vUv.y - center), halfH) * step(0.001, halfH);
  vec2 uv = vUv;
  uv.x = mix(uv.x, fract(uv.x + crawl), inBand);
  gl_FragColor = vec4(src(uv), 1.0);
}
