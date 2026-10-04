// GLITCH MODE
// RGB tearing, block datamoshing (feedback smear along motion), and sync loss.

void main() {
  vec2 uv = vUv;
  vec2 px = 1.0 / uResolution;
  float t = uTime;
  float tick = floor(t * 12.0);

  float amt = clamp(uGlitch * (0.25 + uReactivity * (uBass * 0.9 + uKick * 0.9)), 0.0, 1.5);

  // --- sync loss: vertical roll / frame jumps ---------------------------
  float rollTrig = step(1.0 - 0.12 * amt, hash11(tick * 1.37));
  uv.y = fract(uv.y + rollTrig * (hash11(tick + 7.0) - 0.5) * 0.6
                    + amt * 0.03 * sin(t * 1.3) * uTreble);

  // --- hsync jitter on scanlines ---------------------------------------
  float line = floor(uv.y * uResolution.y * 0.5);
  uv.x += (hash12(vec2(line, floor(t * 60.0))) - 0.5) * 0.012 * amt * (0.5 + uTreble * uReactivity);

  // --- horizontal tearing bands ----------------------------------------
  float bands = 18.0 + floor(hash11(tick) * 30.0);
  float band = floor(uv.y * bands);
  float tear = step(1.0 - 0.3 * amt, hash12(vec2(band, tick)));
  uv.x += tear * (hash12(vec2(band, tick + 1.0)) - 0.5) * 0.35 * amt;

  // --- RGB split --------------------------------------------------------
  float split = 0.002 + 0.025 * amt * (0.4 + uMid * uReactivity);
  vec2 dir = vec2(cos(t * 0.7), sin(t * 1.1) * 0.3);
  vec3 col;
  col.r = src(uv + dir * split).r;
  col.g = src(uv).g;
  col.b = src(uv - dir * split).b;

  // --- datamosh: blocks that keep dragging the previous frame ----------
  float bs = mix(48.0, 12.0, clamp(amt, 0.0, 1.0));
  vec2 blk = floor(vUv * uResolution / bs);
  float blkTick = floor(t * mix(4.0, 20.0, uBass));
  float moshChance = 0.6 * amt * (0.3 + uBass * uReactivity + uKick);
  float mosh = step(1.0 - moshChance, hash12(blk + blkTick * 0.131));

  vec2 bc = (blk + 0.5) * bs * px;
  float l0 = luma(src(bc));
  float lx = luma(src(bc + vec2(bs * px.x, 0.0)));
  float ly = luma(src(bc + vec2(0.0, bs * px.y)));
  vec2 mv = vec2(lx - l0, ly - l0) * bs * px * 6.0
          + (vec2(hash12(blk + 1.0), hash12(blk + 2.0)) - 0.5) * px * bs * 0.5;
  vec3 prev = texture2D(uPrev, vUv - mv).rgb;
  col = mix(col, prev, mosh * (0.5 + 0.5 * uFeedback));

  // --- block corruption: channel swap + crush ---------------------------
  float corrupt = step(1.0 - 0.12 * amt, hash12(blk * 1.7 + tick));
  if (corrupt > 0.5) {
    col = floor(col.brg * 4.0) / 4.0;
  }

  // --- bit crush on beats ------------------------------------------------
  float levels = mix(256.0, 6.0, clamp(uKick * uReactivity * amt, 0.0, 1.0));
  col = floor(col * levels) / levels;

  // --- scanlines, noise, sync-loss bar ----------------------------------
  col *= 0.9 + 0.1 * sin(vUv.y * uResolution.y * PI);
  col += (hash12(vUv * uResolution + fract(t) * 100.0) - 0.5) * 0.15 * amt;
  float bar = smoothstep(0.03, 0.0, abs(vUv.y - fract(t * 0.37 + hash11(tick))));
  col += bar * rollTrig * 0.6;

  gl_FragColor = vec4(col, 1.0);
}
