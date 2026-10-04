// WINDOWS 98 CRASH
// 8x8 Bayer dither into a 256-color palette (8 red, 8 green, 4 blue),
// then a window-drag trail: the previous frame is stamped in staggered steps
// so moving picture leaves frozen copies, like a window redraw that never cleared.

uniform float uWinTrail;
uniform float uWinStagger;
uniform float uWinDither;

const float BAYER8[64] = float[64](
   0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
   3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

float bayer8(vec2 p) {
  ivec2 i = ivec2(mod(p, 8.0));
  return (BAYER8[i.x + i.y * 8] + 0.5) / 64.0 - 0.5;
}

// 8 x 8 x 4 = 256 colors. The dither is added in quanta so banding stays ordered.
vec3 crush256(vec3 c, vec2 frag, float dither) {
  vec3 steps = vec3(8.0, 8.0, 4.0);
  vec3 q = c * steps + bayer8(frag) * dither;
  q = floor(clamp(q, vec3(0.0), steps - 0.001)) / (steps - 1.0);
  return q;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float kick = clamp(uKick * uReactivity, 0.0, 1.0);

  // A stuck cursor hauling the same window down-right without clearing.
  vec2 dir = normalize(vec2(1.0, 0.42));
  float px = max(uWinStagger, 1.0) * (1.0 + kick * 0.85);
  vec2 margin = vec2(48.0, 36.0);
  vec2 winSize = max(uResolution - margin * 2.0, vec2(32.0));

  // Teal desktop. Older stamps are drawn first so the live window sits on top
  // and the frozen copies stick out along the drag, title bar and all.
  vec3 col = vec3(0.0, 0.502, 0.502);
  for (int i = 4; i >= 0; i--) {
    float fi = float(i);
    float show = fi < 0.5 ? 1.0 : uWinTrail;
    vec2 origin = margin * 0.35 + dir * px * fi;
    vec2 local = frag - origin;
    float inside = step(0.0, local.x) * step(local.x, winSize.x)
                 * step(0.0, local.y) * step(local.y, winSize.y);

    float border = 3.0;
    float titleH = 18.0;
    vec2 client = local - vec2(border, titleH);
    vec2 clientSize = max(winSize - vec2(border * 2.0, titleH + border), vec2(1.0));
    // Back windows hold the previous frame so a moving picture freezes in the trail.
    vec2 uv = clamp(client / clientSize, 0.0, 1.0);
    vec3 live = src(uv);
    vec3 frozen = texture2D(uPrev, uv).rgb;
    float lag = smoothstep(0.0, 4.0, fi) * uWinTrail;
    vec3 pic = crush256(mix(live, frozen, lag), local, uWinDither);

    float onBorder = max(step(local.x, border) + step(winSize.x - border, local.x),
                         step(local.y, border) + step(winSize.y - border, local.y));
    onBorder = clamp(onBorder, 0.0, 1.0);
    float onTitle = step(border, local.y) * step(local.y, titleH)
                  * step(border, local.x) * step(local.x, winSize.x - border);
    float close = step(winSize.x - 22.0, local.x) * step(local.x, winSize.x - 6.0)
                * step(4.0, local.y) * step(local.y, 15.0);

    vec3 face = mix(pic, vec3(0.78, 0.78, 0.80), onBorder);
    vec3 titleCol = mix(vec3(0.50, 0.50, 0.55), vec3(0.0, 0.0, 0.55), step(fi, 0.5));
    face = mix(face, titleCol, onTitle);
    face = mix(face, vec3(0.86, 0.86, 0.88), close);

    col = mix(col, face, inside * show);
  }

  // A kick flashes the desktop gray, the way a crashed redraw blanks a region.
  col = mix(col, vec3(0.75, 0.75, 0.78), kick * kick * 0.18);

  gl_FragColor = vec4(col, 1.0);
}
