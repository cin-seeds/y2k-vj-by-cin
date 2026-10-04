// MINIDV
// A late-90s camcorder viewfinder. Sharper than the tape shader: field comb,
// a REC mark that blinks on the beat, a burned-in date and timecode, optional
// night-shot green, and a 4:3 side crop. No tracking snow.

uniform float uInterlace;
uniform float uDatestamp;
uniform float uNightshot;
uniform float uCrop;

float pxBox(vec2 p, vec2 c, vec2 s) {
  vec2 d = abs(p - c);
  return step(d.x, s.x) * step(d.y, s.y);
}

float seven(vec2 p, float n) {
  float d = floor(mod(n, 10.0));
  float h = pxBox(p, vec2(0.5, 0.92), vec2(0.28, 0.07));
  float m = pxBox(p, vec2(0.5, 0.50), vec2(0.28, 0.07));
  float b = pxBox(p, vec2(0.5, 0.08), vec2(0.28, 0.07));
  float ul = pxBox(p, vec2(0.16, 0.71), vec2(0.07, 0.16));
  float ur = pxBox(p, vec2(0.84, 0.71), vec2(0.07, 0.16));
  float ll = pxBox(p, vec2(0.16, 0.29), vec2(0.07, 0.16));
  float lr = pxBox(p, vec2(0.84, 0.29), vec2(0.07, 0.16));
  if (d < 0.5) return max(max(max(h, b), max(ul, ur)), max(ll, lr));
  if (d < 1.5) return max(ur, lr);
  if (d < 2.5) return max(max(max(h, m), b), max(ur, ll));
  if (d < 3.5) return max(max(max(h, m), b), max(ur, lr));
  if (d < 4.5) return max(max(m, ul), max(ur, lr));
  if (d < 5.5) return max(max(max(h, m), b), max(ul, lr));
  if (d < 6.5) return max(max(max(h, m), b), max(ul, max(ll, lr)));
  if (d < 7.5) return max(h, max(ur, lr));
  if (d < 8.5) return max(max(max(h, m), b), max(max(ul, ur), max(ll, lr)));
  return max(max(max(h, m), b), max(ul, max(ur, lr)));
}

float putDigit(vec2 frag, vec2 origin, float n) {
  vec2 p = (frag - origin) / vec2(11.0, 16.0);
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return 0.0;
  return seven(p, n);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float inset = max(aspect - 4.0 / 3.0, 0.0) / max(aspect, 0.001) * 0.5 * clamp(uCrop, 0.0, 1.0);
  vec2 suv = vUv;
  suv.x = (suv.x - inset) / max(1.0 - 2.0 * inset, 0.001);
  float outside = clamp(step(suv.x, 0.0) + step(1.0, suv.x), 0.0, 1.0);

  float field = mod(floor(gl_FragCoord.y), 2.0);
  vec2 uv = clamp(suv, 0.0, 1.0);
  uv.x += (field - 0.5) * 0.0025 * uInterlace;
  vec3 col = src(uv);
  col *= 1.0 - field * uInterlace * 0.42;
  col *= 1.0 - outside;

  float y = luma(col);
  vec3 night = vec3(y * 0.18, y * 1.05, y * 0.22);
  col = mix(col, night, clamp(uNightshot, 0.0, 1.0));

  vec2 frag = gl_FragCoord.xy;
  float blink = 0.22 + 0.78 * step(0.42, uBeat);
  vec2 dotC = vec2(28.0, uResolution.y - 28.0);
  float rec = smoothstep(7.0, 5.2, length(frag - dotC)) * blink;
  float letters = 0.0;
  letters = max(letters, pxBox(frag, vec2(46.0, uResolution.y - 28.0), vec2(2.0, 7.0)));
  letters = max(letters, pxBox(frag, vec2(52.0, uResolution.y - 33.0), vec2(4.0, 2.0)));
  letters = max(letters, pxBox(frag, vec2(52.0, uResolution.y - 28.0), vec2(4.0, 2.0)));
  letters = max(letters, pxBox(frag, vec2(64.0, uResolution.y - 28.0), vec2(2.0, 7.0)));
  letters = max(letters, pxBox(frag, vec2(70.0, uResolution.y - 34.0), vec2(4.0, 1.6)));
  letters = max(letters, pxBox(frag, vec2(70.0, uResolution.y - 28.0), vec2(4.0, 1.6)));
  letters = max(letters, pxBox(frag, vec2(70.0, uResolution.y - 22.0), vec2(4.0, 1.6)));
  letters = max(letters, pxBox(frag, vec2(82.0, uResolution.y - 28.0), vec2(2.0, 7.0)));
  letters = max(letters, pxBox(frag, vec2(88.0, uResolution.y - 34.0), vec2(4.0, 1.6)));
  letters = max(letters, pxBox(frag, vec2(88.0, uResolution.y - 22.0), vec2(4.0, 1.6)));
  col = mix(col, vec3(0.95, 0.12, 0.1), clamp(rec + letters * blink, 0.0, 1.0));

  float stamp = 0.0;
  float secs = floor(mod(uTime, 60.0));
  float mins = floor(mod(uTime / 60.0, 60.0));
  stamp = max(stamp, putDigit(frag, vec2(18.0, 16.0), 1.0));
  stamp = max(stamp, putDigit(frag, vec2(32.0, 16.0), 0.0));
  stamp = max(stamp, putDigit(frag, vec2(52.0, 16.0), 0.0));
  stamp = max(stamp, putDigit(frag, vec2(66.0, 16.0), 3.0));
  stamp = max(stamp, putDigit(frag, vec2(86.0, 16.0), 9.0));
  stamp = max(stamp, putDigit(frag, vec2(100.0, 16.0), 9.0));
  stamp = max(stamp, putDigit(frag, vec2(126.0, 16.0), floor(mins / 10.0)));
  stamp = max(stamp, putDigit(frag, vec2(140.0, 16.0), mins));
  stamp = max(stamp, putDigit(frag, vec2(160.0, 16.0), floor(secs / 10.0)));
  stamp = max(stamp, putDigit(frag, vec2(174.0, 16.0), secs));
  float colon = pxBox(frag, vec2(154.0, 22.0), vec2(1.3, 1.3)) + pxBox(frag, vec2(154.0, 28.0), vec2(1.3, 1.3));
  stamp = max(stamp, colon * step(0.5, fract(uTime)));
  col = mix(col, vec3(0.95, 0.82, 0.35), stamp * clamp(uDatestamp, 0.0, 1.0));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
