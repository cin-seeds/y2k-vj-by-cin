// CD Seek
// Concentric rings on the picture, and a short sideways stutter.

uniform float uCdRing;
uniform float uCdSeek;
uniform float uCdRate;

void main() {
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);
  float seek = clamp(uCdSeek, 0.0, 1.0);
  float rate = clamp(uCdRate, 0.0, 1.0);
  float hops = mix(2.0, 12.0, rate) + kick * 9.0;
  float tick = floor(uTime * hops);
  float gate = step(0.58, hash11(tick * 1.7));
  float hop = hash11(tick + 4.0) - 0.5;
  float throw = seek * (0.3 + kick * 1.9);
  vec2 uv = vUv;
  uv.x += hop * gate * throw * 0.05;

  vec3 col = src(uv);
  vec2 p = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  float groove = sin(length(p) * 92.0 - uTime * 0.55);
  float line = smoothstep(0.4, 0.9, groove);
  float rings = clamp(uCdRing, 0.0, 1.0);
  col *= 1.0 - line * rings * 0.4;
  col += line * rings * vec3(0.62, 0.78, 0.86) * 0.07;
  gl_FragColor = vec4(col, 1.0);
}
